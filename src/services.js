'use strict';
// 核心业务服务：排品 / 撤品 / 脚本版本快照 / 审核门禁 / 挂链校验 / 样品 / 回调幂等 / 发布回执
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { catalog, receipts } = require('./adapters');
const { PHOTO_DIR } = require('./db');

const uid = (p) => p + crypto.randomUUID().slice(0, 8);
const now = () => new Date().toISOString();

const PULL_REASONS = {
  out_of_stock: '缺货',
  price_changed: '价格变更',
  link_invalid: '链接失效',
  sample_mismatch: '样品不符',
  banned_word: '违规词',
  manual: '临时撤品',
};

class DomainError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function createServices(db, deps = {}) {
  const cat = deps.catalog || catalog;
  const receiptAdapter = deps.receipts || receipts;
  const photoDir = deps.photoDir || PHOTO_DIR;

  // ---------- 小工具 ----------
  const getSession = (id) => {
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!s) throw new DomainError('session_not_found', `场次 ${id} 不存在`);
    return s;
  };
  const getSlot = (id) => {
    const sl = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    if (!sl) throw new DomainError('slot_not_found', `排品 ${id} 不存在`);
    return sl;
  };
  const scheduledSlots = (sessionId) =>
    db.prepare("SELECT * FROM slots WHERE session_id = ? AND status = 'scheduled' ORDER BY position").all(sessionId);

  function recordReceipt(sessionId, kind, summary, detail) {
    const row = {
      id: uid('RC'),
      session_id: sessionId || null,
      kind,
      summary,
      detail: JSON.stringify(detail),
      created_at: now(),
    };
    db.prepare('INSERT INTO receipts (id, session_id, kind, summary, detail, created_at) VALUES (?,?,?,?,?,?)')
      .run(row.id, row.session_id, row.kind, row.summary, row.detail, row.created_at);
    const sent = receiptAdapter.send({
      receipt_id: row.id, session_id: sessionId, kind, summary, detail, created_at: row.created_at,
    });
    return { ...row, detail, delivery: sent };
  }

  // ---------- 商品资料审核（排品前置门禁） ----------
  function syncProductRow(sku) {
    const p = cat.get(sku);
    if (!p) throw new DomainError('unknown_product', `未知商品 ${sku}`);
    const exist = db.prepare('SELECT sku FROM products WHERE sku = ?').get(sku);
    if (!exist) {
      db.prepare('INSERT INTO products (sku, name, image, category, banned_words) VALUES (?,?,?,?,?)')
        .run(sku, p.name, p.image, p.category, (p.banned_words || []).join(','));
    }
    return db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
  }

  function submitProductDoc(sku) {
    const row = syncProductRow(sku);
    if (row.doc_status === 'approved') return row;
    db.prepare("UPDATE products SET doc_status='pending', doc_submitted_at=? WHERE sku=?").run(now(), sku);
    return db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
  }

  function reviewProductDoc(sku, reviewerId, status, note = '') {
    if (!['approved', 'rejected'].includes(status)) throw new DomainError('bad_status', '资料审核结论必须是 approved/rejected');
    syncProductRow(sku);
    db.prepare('UPDATE products SET doc_status=?, doc_reviewed_at=?, doc_reviewer_id=?, doc_note=? WHERE sku=?')
      .run(status, now(), reviewerId, note, sku);
    return db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
  }

  // ---------- 直播间 / 场次 ----------
  function createRoom(name, hostId) {
    const id = uid('RM');
    db.prepare('INSERT INTO rooms (id, name, host_id, created_at) VALUES (?,?,?,?)').run(id, name, hostId, now());
    return db.prepare('SELECT * FROM rooms WHERE id=?').get(id);
  }

  function createSession(roomId, title, startsAt) {
    if (!db.prepare('SELECT id FROM rooms WHERE id=?').get(roomId)) throw new DomainError('room_not_found', '直播间不存在');
    const id = uid('SS');
    db.prepare('INSERT INTO sessions (id, room_id, title, starts_at, created_at) VALUES (?,?,?,?,?)')
      .run(id, roomId, title, startsAt, now());
    return getSession(id);
  }

  function startSession(id) {
    const s = getSession(id);
    if (s.status !== 'published') throw new DomainError('not_published', '只有已发布场次才能开播');
    db.prepare("UPDATE sessions SET status='live' WHERE id=?").run(id);
    return getSession(id);
  }
  function endSession(id) {
    const s = getSession(id);
    if (!['live', 'published'].includes(s.status)) throw new DomainError('bad_transition', '当前状态不能结束');
    db.prepare("UPDATE sessions SET status='ended' WHERE id=?").run(id);
    return getSession(id);
  }

  // ---------- 排品 ----------
  function addSlot(sessionId, input) {
    const s = getSession(sessionId);
    if (s.status !== 'draft') throw new DomainError('session_locked', '场次已发布/开播，排品冻结；如需调整请走撤品流程');
    const { sku, talk_minutes = 10, stock_alert = 20, promo_version = 'none' } = input;

    // 1) 资料审核门禁
    const prod = syncProductRow(sku);
    if (prod.doc_status !== 'approved') {
      throw new DomainError('doc_not_approved', `商品 ${sku} 尚未通过资料审核（当前：${prod.doc_status}），不能加入排品`);
    }
    // 2) 商品与优惠版本 / 价格校验
    const item = cat.get(sku);
    const promo = cat.promos(sku).find((x) => x.version === promo_version);
    if (!promo) throw new DomainError('bad_promo', `商品 ${sku} 不存在优惠版本 ${promo_version}`);
    const priceSnapshot = cat.promoPrice(sku, promo_version);
    // 3) 挂链：存在且有效
    if (!item.link || item.link.status !== 'active') {
      throw new DomainError('link_invalid', `商品 ${sku} 挂链${item.link ? '已失效' : '不存在'}，不能排品`);
    }
    // 4) 挂链唯一：同一场次同一商品/链接只能出现一次
    const dup = db.prepare("SELECT id FROM slots WHERE session_id=? AND sku=? AND status='scheduled'").get(sessionId, sku);
    if (dup) throw new DomainError('link_not_unique', `商品 ${sku} 的挂链在本场已存在，挂链必须唯一`);
    // 5) 缺货不能排
    if (item.stock <= 0) throw new DomainError('out_of_stock', `商品 ${sku} 当前缺货，不能排品`);

    let position = Number.isInteger(input.position) ? input.position : null;
    const rows = scheduledSlots(sessionId);
    if (position === null) position = rows.length ? rows[rows.length - 1].position + 1 : 1;
    if (position < 1) position = 1;
    // 插入位置后移
    db.prepare('UPDATE slots SET position = position + 1 WHERE session_id=? AND position>=? AND status=\'scheduled\'')
      .run(sessionId, position);

    const slotId = uid('SL');
    // 挂链落库（唯一键 sku+url 去重）
    let link = db.prepare('SELECT * FROM links WHERE sku=? AND url=?').get(sku, item.link.url);
    if (!link) {
      db.prepare('INSERT INTO links (id, sku, url, status, created_at) VALUES (?,?,?,?,?)')
        .run(uid('LK'), sku, item.link.url, item.link.status, now());
      link = db.prepare('SELECT * FROM links WHERE sku=? AND url=?').get(sku, item.link.url);
    }
    if (link.status === 'unlinked') {
      db.prepare("UPDATE links SET status='active' WHERE id=?").run(link.id);
      link = db.prepare('SELECT * FROM links WHERE id=?').get(link.id);
    }

    db.prepare(`INSERT INTO slots
      (id, session_id, position, sku, talk_minutes, stock_alert, promo_version, price_cents, link_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(slotId, sessionId, position, sku, talk_minutes, stock_alert, promo_version, priceSnapshot, link.id, now());

    return getSlot(slotId);
  }

  // ---------- 临时撤品（六种原因分别处理，不动订单） ----------
  function pullSlot(slotId, reason, operatorId = 'system') {
    if (!PULL_REASONS[reason]) throw new DomainError('bad_reason', `未知撤品原因：${reason}`);
    const slot = getSlot(slotId);
    if (slot.status === 'removed') throw new DomainError('already_removed', '该商品已撤品');
    const orders = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE slot_id=?').get(slotId).n;
    db.prepare("UPDATE slots SET status='removed', removed_reason=?, removed_at=? WHERE id=?")
      .run(reason, now(), slotId);
    db.prepare("UPDATE links SET status='unlinked' WHERE id=?").run(slot.link_id);

    const receipt = recordReceipt(slot.session_id, 'pull',
      `撤品回执：${slot.sku}（${PULL_REASONS[reason]}）`,
      { slot_id: slotId, sku: slot.sku, reason, reason_label: PULL_REASONS[reason],
        operator_id: operatorId, closed_orders_untouched: orders, pulled_at: now() });
    return { slot: getSlot(slotId), receipt };
  }

  // ---------- 讲解脚本：修改即生成版本 ----------
  function getScript(slotId) {
    let row = db.prepare('SELECT * FROM scripts WHERE slot_id=?').get(slotId);
    if (!row) return null;
    row.versions = db.prepare('SELECT version, change_note, created_at FROM script_versions WHERE script_id=? ORDER BY version').all(row.id);
    row.reviews = db.prepare('SELECT * FROM reviews WHERE script_id=? ORDER BY created_at').all(row.id);
    return row;
  }

  function saveScript(slotId, authorId, content, changeNote = '') {
    const slot = getSlot(slotId);
    let row = db.prepare('SELECT * FROM scripts WHERE slot_id=?').get(slotId);
    if (!row) {
      const id = uid('SC');
      db.prepare('INSERT INTO scripts (id, slot_id, author_id, draft, draft_version, updated_at) VALUES (?,?,?,?,?,?)')
        .run(id, slotId, authorId, '', 0, now());
      row = db.prepare('SELECT * FROM scripts WHERE id=?').get(id);
    } else if (row.author_id !== authorId) {
      throw new DomainError('not_author', `脚本由 ${row.author_id} 创建，其他主播只能批注，不能改写`);
    }
    if (row.draft === content && row.draft_version > 0) return getScript(slotId); // 无变化不产生新版本

    const version = row.draft_version + 1;
    const tx = db.prepare('INSERT INTO script_versions (id, script_id, version, content, change_note, created_at) VALUES (?,?,?,?,?,?)')
      .run(uid('SV'), row.id, version, content, changeNote, now());
    void tx;
    db.prepare('UPDATE scripts SET draft=?, draft_version=?, updated_at=? WHERE id=?')
      .run(content, version, now(), row.id);
    // 已发布/直播中的场次：发布快照不可变，新版本只是草稿，不能覆盖快照。
    // 前端依据 published_version < draft_version 提示“直播继续使用已发布快照”。
    return getScript(slotId);
  }

  // ---------- 脚本审核：不能审核自己编写的脚本 ----------
  function reviewScript(slotId, reviewerId, verdict, comment = '') {
    const slot = getSlot(slotId);
    const script = getScript(slotId);
    if (!script || script.draft_version === 0) throw new DomainError('no_script', '脚本还没有内容，无法审核');
    const reviewer = (deps.users || require('./adapters').USERS).find((u) => u.id === reviewerId);
    if (!reviewer || reviewer.role !== 'reviewer') throw new DomainError('not_reviewer', '只有审核人可以审核脚本');
    if (script.author_id === reviewerId) {
      throw new DomainError('self_review_forbidden', '审核人不能审核自己编写的脚本');
    }
    if (!['approved', 'rejected'].includes(verdict)) throw new DomainError('bad_verdict', '结论必须是 approved/rejected');
    const version = script.draft_version; // 始终审核当前最新版本
    try {
      db.prepare('INSERT INTO reviews (id, script_id, version, reviewer_id, verdict, comment, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(uid('RV'), script.id, version, reviewerId, verdict, comment, now());
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new DomainError('already_reviewed', '该版本你已审核过');
      throw e;
    }
    return getScript(slotId);
  }

  // ---------- 违规词扫描（审核提示来源） ----------
  function scanScript(sku, content) {
    const item = cat.get(sku);
    const words = item ? item.banned_words || [] : [];
    const hits = [];
    for (const w of words) if (content.includes(w)) hits.push(w);
    return { sku, hits, clean: hits.length === 0 };
  }

  // ---------- 样品登记（照片存本地目录） ----------
  function registerSample(input) {
    const { sku, slot_id = null, matches, discrepancy = '', photo = null, registered_by } = input;
    if (!cat.get(sku)) throw new DomainError('unknown_product', `未知商品 ${sku}`);
    let photoPath = null;
    if (photo && photo.data) {
      fs.mkdirSync(photoDir, { recursive: true });
      const ext = (photo.name && photo.name.includes('.') ? path.extname(photo.name) : '') || '.bin';
      const fname = `${sku}_${crypto.randomUUID().slice(0, 8)}${ext}`;
      photoPath = path.join(photoDir, fname);
      fs.writeFileSync(photoPath, Buffer.from(photo.data, 'base64'));
    }
    const id = uid('SM');
    db.prepare(`INSERT INTO samples (id, sku, slot_id, received_at, matches, discrepancy, photo_path, registered_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, sku, slot_id, now(), matches ? 1 : 0, discrepancy, photoPath, registered_by);
    return db.prepare('SELECT * FROM samples WHERE id=?').get(id);
  }
  function latestSample(sku) {
    return db.prepare('SELECT * FROM samples WHERE sku=? ORDER BY received_at DESC, rowid DESC LIMIT 1').get(sku);
  }

  // ---------- 整场校验：挂链 / 价格 / 库存 / 样品 / 脚本 ----------
  function validateSession(sessionId) {
    const s = getSession(sessionId);
    const slots = scheduledSlots(sessionId);
    const issues = [];
    const warnings = [];
    const seenUrls = new Set();

    for (const slot of slots) {
      const item = cat.get(slot.sku);
      const link = slot.link_id ? db.prepare('SELECT * FROM links WHERE id=?').get(slot.link_id) : null;

      if (!item) { issues.push({ slot_id: slot.id, sku: slot.sku, reason: 'unknown_product', label: '商品不存在' }); continue; }
      // 平台下架
      if (item.listing === 'offline') {
        issues.push({ slot_id: slot.id, sku: slot.sku, reason: 'listing_offline', label: '商品已被平台下架' });
      }
      // 挂链状态
      if (!link || item.link.status !== 'active' || link.status !== 'active' || link.url !== item.link.url) {
        issues.push({ slot_id: slot.id, sku: slot.sku, reason: 'link_invalid', label: '挂链失效', url: link?.url });
      } else if (seenUrls.has(link.url)) {
        issues.push({ slot_id: slot.id, sku: slot.sku, reason: 'link_not_unique', label: '挂链重复，不唯一', url: link.url });
      }
      if (link) seenUrls.add(link.url);
      // 价格校验：当前优惠到手价必须与排品时快照一致，否则视为价格变更
      const livePrice = cat.promoPrice(slot.sku, slot.promo_version);
      if (livePrice !== slot.price_cents) {
        issues.push({ slot_id: slot.id, sku: slot.sku, reason: 'price_changed',
          label: `价格变更：排品快照 ¥${(slot.price_cents / 100).toFixed(2)} → 当前 ¥${(livePrice / 100).toFixed(2)}`,
          from_cents: slot.price_cents, to_cents: livePrice });
      }
      // 缺货 / 库存提示
      if (item.stock <= 0) issues.push({ slot_id: slot.id, sku: slot.sku, reason: 'out_of_stock', label: '商品缺货' });
      else if (item.stock <= slot.stock_alert) warnings.push({ slot_id: slot.id, sku: slot.sku, reason: 'low_stock', label: `库存 ${item.stock}，已触及提示线 ${slot.stock_alert}` });
      // 样品不符
      const sample = latestSample(slot.sku);
      if (sample && sample.matches === 0) {
        issues.push({ slot_id: slot.id, sku: slot.sku, reason: 'sample_mismatch', label: '样品登记不符', discrepancy: sample.discrepancy });
      }
      // 脚本：存在、最新版本过审、非自审、无违规词
      const script = getScript(slot.id);
      if (!script || script.draft_version === 0) {
        issues.push({ slot_id: slot.id, sku: slot.sku, reason: 'script_missing', label: '讲解脚本缺失' });
        continue;
      }
      const scan = scanScript(slot.sku, script.draft);
      if (!scan.clean) issues.push({ slot_id: slot.id, sku: slot.sku, reason: 'banned_word', label: `脚本含违规词：${scan.hits.join('、')}`, hits: scan.hits });
      const review = db.prepare("SELECT * FROM reviews WHERE script_id=? AND version=? AND verdict='approved' ORDER BY created_at DESC LIMIT 1")
        .get(script.id, script.draft_version);
      if (!review) {
        issues.push({ slot_id: slot.id, sku: slot.sku, reason: 'script_unapproved', label: `脚本 v${script.draft_version} 尚未通过审核` });
      } else if (review.reviewer_id === script.author_id) {
        issues.push({ slot_id: slot.id, sku: slot.sku, reason: 'self_review', label: '脚本审核人就是作者，审核无效' });
      }
    }
    if (!slots.length) issues.push({ reason: 'empty_session', label: '场次没有任何排品' });
    return { ok: issues.length === 0, status: s.status, issues, warnings, slot_count: slots.length };
  }

  // ---------- 发布：校验整场挂链，冻结快照 ----------
  function publishSession(sessionId, operatorId = 'system') {
    const s = getSession(sessionId);
    if (s.status !== 'draft') throw new DomainError('session_locked', `场次状态为 ${s.status}，不能重复发布；开播后继续使用已发布快照`);
    const check = validateSession(sessionId);
    if (!check.ok) throw new DomainError('publish_blocked', '整场校验未通过，发布被拦截', check.issues);

    const slots = scheduledSlots(sessionId);
    const snapSlots = slots.map((slot) => {
      const item = cat.get(slot.sku);
      const link = db.prepare('SELECT * FROM links WHERE id=?').get(slot.link_id);
      const script = getScript(slot.id);
      const review = db.prepare("SELECT * FROM reviews WHERE script_id=? AND version=? AND verdict='approved' ORDER BY created_at DESC LIMIT 1")
        .get(script.id, script.draft_version);
      const ver = db.prepare('SELECT content FROM script_versions WHERE script_id=? AND version=?').get(script.id, script.draft_version);
      return {
        slot_id: slot.id, position: slot.position, sku: slot.sku, name: item.name, image: item.image,
        talk_minutes: slot.talk_minutes, stock_alert: slot.stock_alert,
        promo_version: slot.promo_version, promo_label: cat.promos(slot.sku).find((x) => x.version === slot.promo_version)?.label,
        price_cents: slot.price_cents, stock: item.stock, url: link.url,
        script: { version: script.draft_version, content: ver.content, author_id: script.author_id,
                  approved_by: review.reviewer_id, review_comment: review.comment },
      };
    });
    const snapshot = { session_id: sessionId, published_at: now(), operator_id: operatorId, slots: snapSlots };
    db.prepare('UPDATE sessions SET status=\'published\', published_snapshot=?, published_at=? WHERE id=?')
      .run(JSON.stringify(snapshot), snapshot.published_at, sessionId);
    // 记录每个脚本的已发布版本
    for (const sl of snapSlots) {
      db.prepare('UPDATE scripts SET published_version=? WHERE slot_id=?').run(sl.script.version, sl.slot_id);
    }
    const receipt = recordReceipt(sessionId, 'publish',
      `发布回执：${s.title}，共 ${snapSlots.length} 个商品，整场挂链校验通过`,
      { snapshot, warnings: check.warnings });
    return { session: getSession(sessionId), snapshot, warnings: check.warnings, receipt };
  }

  // ---------- 订单（回调不得改变已成交订单） ----------
  function placeOrder(slotId) {
    const slot = getSlot(slotId);
    const id = uid('OD');
    db.prepare('INSERT INTO orders (id, slot_id, sku, price_cents, created_at) VALUES (?,?,?,?,?)')
      .run(id, slotId, slot.sku, slot.price_cents, now());
    return db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  }

  // ---------- 外部回调：幂等 + 乱序忽略，绝不重复上下架/动订单 ----------
  // 事件形态：{event_id, sku, type: listing|stock|price|link, ts, action: online|offline, ...}
  function ingestCallback(evt) {
    if (!evt || !evt.event_id || !evt.sku || !evt.type) throw new DomainError('bad_callback', '回调缺少 event_id/sku/type');
    const existed = db.prepare('SELECT * FROM callbacks WHERE event_id=?').get(evt.event_id);
    if (existed) {
      // 重复回调：只登记，不重复处理
      db.prepare('INSERT OR IGNORE INTO callbacks (event_id, event_type, sku, action, payload, received_at, duplicate_of) VALUES (?,?,?,?,?,?,?)')
        .run(evt.event_id + '#dup' + crypto.randomUUID().slice(0, 4), evt.type, evt.sku, null,
             JSON.stringify(evt), now(), evt.event_id);
      return { duplicate: true, event_id: evt.event_id, original_action: existed.action };
    }

    // 同一 sku 同一类型只接受 ts 最新的事件；迟到的旧事件（乱序）忽略
    const lastApplied = db.prepare(`SELECT payload FROM callbacks WHERE sku=? AND event_type=? AND action IS NOT NULL
      ORDER BY json_extract(payload,'$.ts') DESC LIMIT 1`).get(evt.sku, evt.type);
    let stale = false;
    if (lastApplied && evt.ts) {
      const prevTs = JSON.parse(lastApplied.payload).ts;
      if (prevTs && new Date(evt.ts).getTime() < new Date(prevTs).getTime()) stale = true;
    }

    let action = null;
    const effect = { applied: false, stale, changes: [] };
    if (!stale) {
      if (evt.type === 'listing') {
        const before = cat.get(evt.sku).listing || 'online';
        if (evt.action === 'online' || evt.action === 'offline') {
          if (before !== evt.action) {
            cat.setListing(evt.sku, evt.action);
            effect.changes.push({ field: 'listing', from: before, to: evt.action });
          }
          action = evt.action;
          effect.applied = effect.changes.length > 0;
        }
      } else if (evt.type === 'stock') {
        const before = cat.get(evt.sku).stock;
        if (Number.isFinite(evt.stock)) {
          cat.setStock(evt.sku, evt.stock);
          effect.changes.push({ field: 'stock', from: before, to: evt.stock });
          action = `stock=${evt.stock}`;
          effect.applied = before !== evt.stock;
        }
      } else if (evt.type === 'price') {
        const before = cat.get(evt.sku).price_cents;
        if (Number.isFinite(evt.price_cents)) {
          cat.changePrice(evt.sku, evt.price_cents);
          effect.changes.push({ field: 'price_cents', from: before, to: evt.price_cents });
          action = `price=${evt.price_cents}`;
          effect.applied = before !== evt.price_cents;
        }
      } else if (evt.type === 'link') {
        const before = cat.get(evt.sku).link.status;
        if (['active', 'invalid'].includes(evt.status)) {
          cat.setLinkStatus(evt.sku, evt.status);
          effect.changes.push({ field: 'link', from: before, to: evt.status });
          action = `link=${evt.status}`;
          effect.applied = before !== evt.status;
        }
      } else {
        throw new DomainError('bad_callback', `未知回调类型 ${evt.type}`);
      }
    }

    db.prepare('INSERT INTO callbacks (event_id, event_type, sku, action, payload, received_at, duplicate_of) VALUES (?,?,?,?,?,?,?)')
      .run(evt.event_id, evt.type, evt.sku, stale ? null : action, JSON.stringify(evt), now(), null);

    // 已成交订单一律不动
    const orders = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE sku=?').get(evt.sku).n;
    effect.closed_orders_untouched = orders;

    let receipt = null;
    if (!stale && effect.applied) {
      const slot = db.prepare("SELECT session_id FROM slots WHERE sku=? AND status='scheduled' ORDER BY position LIMIT 1").get(evt.sku);
      receipt = recordReceipt(slot?.session_id || 'external', 'callback',
        `回调回执：${evt.sku} ${evt.type} ${action ?? ''}${stale ? '（乱序旧事件，忽略）' : ''}`.trim(),
        { event_id: evt.event_id, type: evt.type, sku: evt.sku, action, effect, ts: evt.ts || null });
    }
    return { duplicate: false, stale, ...effect, receipt };
  }

  return {
    DomainError, PULL_REASONS,
    syncProductRow, submitProductDoc, reviewProductDoc,
    createRoom, createSession, startSession, endSession,
    addSlot, pullSlot, scheduledSlots,
    getScript, saveScript, reviewScript, scanScript,
    registerSample, latestSample,
    validateSession, publishSession, placeOrder, ingestCallback,
    recordReceipt,
    listReceipts: (sessionId) => {
      const rows = sessionId
        ? db.prepare('SELECT * FROM receipts WHERE session_id=? ORDER BY created_at DESC').all(sessionId)
        : db.prepare('SELECT * FROM receipts ORDER BY created_at DESC').all();
      return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
    },
    sessionDetail(id) {
      const s = getSession(id);
      const slots = scheduledSlots(id).map((sl) => {
        const item = cat.get(sl.sku);
        const link = sl.link_id ? db.prepare('SELECT * FROM links WHERE id=?').get(sl.link_id) : null;
        const script = getScript(sl.id);
        const sample = latestSample(sl.sku);
        return { ...sl, product: item, link, script, sample,
                 scan: script?.draft ? scanScript(sl.sku, script.draft) : null };
      });
      const removed = db.prepare("SELECT * FROM slots WHERE session_id=? AND status='removed' ORDER BY removed_at DESC").all(id);
      return { ...s, slots, removed, check: validateSession(id) };
    },
  };
}

module.exports = { createServices, DomainError, PULL_REASONS };
