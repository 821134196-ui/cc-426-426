'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb } = require('../src/db');
const { createServices } = require('../src/services');
const { CatalogAdapter, ReceiptAdapter, USERS } = require('../src/adapters');

function harness() {
  const db = openDb(':memory:');
  const catalog = new CatalogAdapter();
  const receiptBox = new ReceiptAdapter();
  const photoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrl-photos-'));
  const svc = createServices(db, { catalog, receipts: receiptBox, users: USERS, photoDir });
  return { db, svc, catalog, receiptBox };
}

// 构造一个“排好 2 个品、脚本均过审”的草稿场次
function readySession(h, skus = ['P1001', 'P1007']) {
  for (const sku of skus) {
    h.svc.submitProductDoc(sku);
    h.svc.reviewProductDoc(sku, 'R01', 'approved', 'ok');
  }
  const room = h.svc.createRoom('测试直播间', 'U01');
  const ss = h.svc.createSession(room.id, '测试专场', '2026-10-01T20:00:00+08:00');
  const slots = skus.map((sku, i) =>
    h.svc.addSlot(ss.id, { sku, talk_minutes: 10, stock_alert: 5, promo_version: i === 0 ? 'v1' : 'v1' }));
  slots.forEach((sl, i) => {
    h.svc.saveScript(sl.id, i === 0 ? 'U01' : 'U02', `${sl.sku} 讲解话术`, '初稿');
    h.svc.reviewScript(sl.id, i === 0 ? 'R02' : 'R01', 'approved', '通过');
  });
  return { sessionId: ss.id, slots };
}

// ---------- 1. 版本快照 ----------
test('脚本修改生成版本；开播后继续使用发布快照，草稿不能覆盖', () => {
  const h = harness();
  const { sessionId, slots } = readySession(h);
  const [sl1] = slots;

  // 再改两次：v2、v3，其中 v2 被重新通过审核
  h.svc.saveScript(sl1.id, 'U01', '第二版话术', '补充卖点');
  h.svc.reviewScript(sl1.id, 'R02', 'approved', 'v2 可过');

  const check = h.svc.validateSession(sessionId);
  assert.ok(check.ok, '发布前校验应通过：' + JSON.stringify(check.issues));

  const pub = h.svc.publishSession(sessionId, 'O01');
  assert.equal(pub.snapshot.slots[0].script.version, 2);
  assert.equal(pub.snapshot.slots[0].script.content, '第二版话术');
  assert.equal(pub.snapshot.slots[0].price_cents, h.catalog.promoPrice('P1001', 'v1'));

  h.svc.startSession(sessionId);
  // 直播中改稿 → v3 草稿
  h.svc.saveScript(sl1.id, 'U01', '直播中临时改的第三版', '临时');

  const s = h.db.prepare('SELECT published_snapshot FROM sessions WHERE id=?').get(sessionId);
  const snap = JSON.parse(s.published_snapshot);
  assert.equal(snap.slots[0].script.version, 2, '快照版本必须停留在 v2');
  assert.equal(snap.slots[0].script.content, '第二版话术', '快照内容不能被草稿覆盖');

  const script = h.svc.getScript(sl1.id);
  assert.equal(script.draft_version, 3);
  assert.equal(script.published_version, 2);
});

test('已发布场次不能重复发布，草稿期外排品被冻结', () => {
  const h = harness();
  const { sessionId } = readySession(h);
  h.svc.publishSession(sessionId, 'O01');
  assert.throws(() => h.svc.publishSession(sessionId, 'O01'), /不能重复发布|session_locked/);
  assert.throws(() => h.svc.addSlot(sessionId, { sku: 'P1002' }), /冻结/);
});

// ---------- 2. 挂链唯一 ----------
test('挂链唯一：同一场次同一商品不能重复排品；失效链接拒绝排品', () => {
  const h = harness();
  ['P1001', 'P1002', 'P1004'].forEach((sku) => {
    h.svc.submitProductDoc(sku);
    h.svc.reviewProductDoc(sku, 'R01', 'approved', 'ok');
  });
  const room = h.svc.createRoom('R', 'U01');
  const ss = h.svc.createSession(room.id, 'T', '2026-10-01T20:00:00+08:00');
  h.svc.addSlot(ss.id, { sku: 'P1001' });
  assert.throws(() => h.svc.addSlot(ss.id, { sku: 'P1001' }), /挂链必须唯一|link_not_unique/);

  // P1004 挂链在适配器中就是 invalid
  assert.throws(() => h.svc.addSlot(ss.id, { sku: 'P1004' }), /挂链|link_invalid/);

  // 撤品后挂链标记 unlinked，可重新排（新链接行/状态恢复）
  const slot = h.svc.addSlot(ss.id, { sku: 'P1002' });
  h.svc.pullSlot(slot.id, 'manual', 'O01');
  // 撤品后原 slot 已 removed，同商品可重新排，唯一性约束只针对 scheduled
  const again = h.svc.addSlot(ss.id, { sku: 'P1002' });
  assert.ok(again.id);
  const check = h.svc.validateSession(ss.id);
  const dup = check.issues.filter((i) => i.reason === 'link_not_unique');
  assert.equal(dup.length, 0);
});

// ---------- 3. 价格校验 ----------
test('价格变更：排品快照价与当前优惠价不一致时校验/发布被拦截', () => {
  const h = harness();
  const { sessionId, slots } = readySession(h);
  const [sl1] = slots;
  const snapPrice = sl1.price_cents; // 排品时 v1 到手价

  // 目录价上调 10 元（1000 分），优惠到手价随之变化
  h.catalog.changePrice('P1001', h.catalog.get('P1001').price_cents + 1000);
  const newPrice = h.catalog.promoPrice('P1001', 'v1');
  assert.notEqual(newPrice, snapPrice);

  const check = h.svc.validateSession(sessionId);
  const priceIssue = check.issues.find((i) => i.sku === 'P1001' && i.reason === 'price_changed');
  assert.ok(priceIssue, '必须报告价格变更');
  assert.equal(priceIssue.from_cents, snapPrice);
  assert.equal(priceIssue.to_cents, newPrice);
  assert.throws(() => h.svc.publishSession(sessionId, 'O01'), (e) => e.code === 'publish_blocked');

  // 撤品后不再报该商品价格问题，并生成撤品回执
  const r = h.svc.pullSlot(sl1.id, 'price_changed', 'O01');
  assert.equal(r.receipt.kind, 'pull');
  const check2 = h.svc.validateSession(sessionId);
  assert.equal(check2.issues.filter((i) => i.sku === 'P1001').length, 0);
});

test('不存在的优惠版本不能排品', () => {
  const h = harness();
  const { sessionId } = readySession(h, ['P1001']);
  // 新场次避免冻结问题
  const room = h.svc.createRoom('R2', 'U01');
  const ss2 = h.svc.createSession(room.id, 'T2', '2026-10-02T20:00:00+08:00');
  assert.throws(() => h.svc.addSlot(ss2.id, { sku: 'P1001', promo_version: 'vX' }), /优惠版本|bad_promo/);
  void sessionId;
});

// ---------- 4. 回调乱序 / 幂等 ----------
test('回调：重复投递不重复上下架；乱序旧事件忽略；已成交订单不变', () => {
  const h = harness();
  const { slots } = readySession(h);
  const sl = slots[0]; // P1001
  const order = h.svc.placeOrder(sl.id);
  assert.equal(order.price_cents, sl.price_cents);

  const offline = { event_id: 'EVT-1', sku: 'P1001', type: 'listing', action: 'offline', ts: '2026-10-01T20:05:00+08:00' };
  const r1 = h.svc.ingestCallback(offline);
  assert.equal(r1.applied, true);
  assert.deepEqual(r1.changes, [{ field: 'listing', from: 'online', to: 'offline' }]);

  // 重复回调
  const r2 = h.svc.ingestCallback(offline);
  assert.equal(r2.duplicate, true);
  assert.equal(r2.original_action, 'offline');
  assert.equal(h.catalog.get('P1001').listing, 'offline');

  // 乱序：更早的 online 事件迟到，必须忽略
  const stale = { event_id: 'EVT-2', sku: 'P1001', type: 'listing', action: 'online', ts: '2026-10-01T20:01:00+08:00' };
  const r3 = h.svc.ingestCallback(stale);
  assert.equal(r3.stale, true);
  assert.equal(r3.applied, false);
  assert.equal(h.catalog.get('P1001').listing, 'offline', '乱序事件不得改变当前状态');

  // 更新的 online 事件正常生效（证明不是“一律忽略 online”）
  const newer = { event_id: 'EVT-3', sku: 'P1001', type: 'listing', action: 'online', ts: '2026-10-01T20:10:00+08:00' };
  const r4 = h.svc.ingestCallback(newer);
  assert.equal(r4.stale, false);
  assert.equal(h.catalog.get('P1001').listing, 'online');

  // 再重复一次 offline（EVT-1）依旧不动作，订单状态不变
  const r5 = h.svc.ingestCallback(offline);
  assert.equal(r5.duplicate, true);
  assert.equal(h.catalog.get('P1001').listing, 'online');

  const orderAfter = h.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  assert.equal(orderAfter.status, 'placed');
  assert.equal(orderAfter.price_cents, order.price_cents);

  // 幂等账本：EVT-1 只有一条主动作记录
  const ledgers = h.db.prepare("SELECT COUNT(*) AS n FROM callbacks WHERE event_id='EVT-1'").get().n;
  assert.equal(ledgers, 1);
});

test('缺货/链接失效回调后整场校验能发现问题，并产生回调回执', () => {
  const h = harness();
  const { sessionId, slots } = readySession(h);
  h.svc.ingestCallback({ event_id: 'E-S1', sku: 'P1001', type: 'stock', stock: 0, ts: '2026-10-01T20:00:00+08:00' });
  h.svc.ingestCallback({ event_id: 'E-L1', sku: 'P1007', type: 'link', status: 'invalid', ts: '2026-10-01T20:00:00+08:00' });
  const check = h.svc.validateSession(sessionId);
  assert.ok(check.issues.some((i) => i.reason === 'out_of_stock' && i.sku === 'P1001'));
  assert.ok(check.issues.some((i) => i.reason === 'link_invalid' && i.sku === 'P1007'));
  const cbReceipts = h.svc.listReceipts().filter((r) => r.kind === 'callback');
  assert.equal(cbReceipts.length, 2);
  assert.equal(h.receiptBox.outbox.length >= 2, true);
  void slots;
});

// ---------- 5. 审核权限 ----------
test('审核人不能审核自己编写的脚本；非审核人不能审核；新版本需重新审核', () => {
  const h = harness();
  h.svc.submitProductDoc('P1001');
  h.svc.reviewProductDoc('P1001', 'R01', 'approved', 'ok');
  const room = h.svc.createRoom('R', 'U01');
  const ss = h.svc.createSession(room.id, 'T', '2026-10-01T20:00:00+08:00');
  const sl = h.svc.addSlot(ss.id, { sku: 'P1001', promo_version: 'v1' });

  // 审核人 R01 自己写的稿
  h.svc.saveScript(sl.id, 'R01', '我自己写的话术', '初稿');
  assert.throws(() => h.svc.reviewScript(sl.id, 'R01', 'approved'), /自己编写的脚本|self_review_forbidden/);
  // 主播不能审核
  assert.throws(() => h.svc.reviewScript(sl.id, 'U01', 'approved'), /只有审核人|not_reviewer/);
  // 另一位审核人可以
  h.svc.reviewScript(sl.id, 'R02', 'approved', '通过');

  // 修改脚本产生新版本后，旧版本通过状态不能让新版本直接发布
  h.svc.saveScript(sl.id, 'R01', '我改了第二版', '改稿');
  const check = h.svc.validateSession(ss.id);
  assert.ok(check.issues.some((i) => i.reason === 'script_unapproved'), '新版本必须重新审核');

  // 违规词也会阻断
  h.svc.saveScript(sl.id, 'R01', '全网最低 绝对不沾杯', '加了违禁词');
  const scan = h.svc.scanScript('P1001', h.svc.getScript(sl.id).draft);
  assert.equal(scan.clean, false);
  assert.deepEqual(scan.hits.sort(), ['全网最低', '绝对不沾杯'].sort());
});

test('商品未通过资料审核不能加入排品（资料审核门禁）', () => {
  const h = harness();
  const room = h.svc.createRoom('R', 'U01');
  const ss = h.svc.createSession(room.id, 'T', '2026-10-01T20:00:00+08:00');
  assert.throws(() => h.svc.addSlot(ss.id, { sku: 'P1001' }), (e) => e.code === 'doc_not_approved');
  h.svc.submitProductDoc('P1001');
  h.svc.reviewProductDoc('P1001', 'R01', 'rejected', '资料不全');
  assert.throws(() => h.svc.addSlot(ss.id, { sku: 'P1001' }), (e) => e.code === 'doc_not_approved');
  h.svc.reviewProductDoc('P1001', 'R01', 'approved', '补全后通过');
  assert.ok(h.svc.addSlot(ss.id, { sku: 'P1001' }).id);
});

test('撤品不动已成交订单，撤品/发布均生成可查询回执', () => {
  const h = harness();
  const { sessionId, slots } = readySession(h);
  const [sl1] = slots;
  h.svc.publishSession(sessionId, 'O01');
  h.svc.startSession(sessionId);
  const order = h.svc.placeOrder(sl1.id);
  // 撤品的正是已有成交订单的商品：撤链生效，但订单原样保留
  const pulled = h.svc.pullSlot(sl1.id, 'manual', 'O01');
  assert.equal(pulled.receipt.detail.closed_orders_untouched, 1);
  const o = h.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  assert.equal(o.status, 'placed');
  assert.equal(o.price_cents, order.price_cents);
  const kinds = h.svc.listReceipts(sessionId).map((r) => r.kind);
  assert.ok(kinds.includes('publish'));
  assert.ok(kinds.includes('pull'));
});
