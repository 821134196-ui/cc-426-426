'use strict';
/* 珊瑚排品台前端：无框架，原生 JS */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  meta: null, catalog: [], rooms: [], room: null, session: null,
  selectedSlot: null, lastEvent: null,
};

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', 'X-Actor': actor() },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || res.statusText), { status: res.status, data });
  return data;
};
const actor = () => $('#actorSelect').value || 'O01';
const money = (c) => '¥' + (c / 100).toFixed(2);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const toast = (msg, kind = '') => {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
};

const STATUS_LABEL = { draft: '草稿', published: '已发布', live: '直播中', ended: '已结束' };

// ---------- 初始化 ----------
async function init() {
  state.meta = await api('/api/meta');
  fillActor();
  bindEvents();
  await Promise.all([loadRooms(), loadCatalog()]);
  renderRooms();
  renderCatalog();
  renderSamples();
  renderReceipts();
  // 默认选中第一个场次
  const firstSess = state.rooms.flatMap((r) => r.sessions).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
  if (firstSess) selectSession(firstSess.id);
  setInterval(() => { if (state.session && $('#tab-lineup').classList.contains('active')) loadSession(state.session.id, true); }, 15000);
}

function fillActor() {
  const opts = state.meta.users.map((u) => `<option value="${u.id}">${esc(u.name)}（${u.role}）</option>`).join('');
  $('#actorSelect').innerHTML = opts;
  $('#actorSelect').value = state.meta.actor;
  $('#reviewerSelect').innerHTML = state.meta.users.filter((u) => u.role === 'reviewer')
    .map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
}

function bindEvents() {
  $('#actorSelect').addEventListener('change', () => renderSession());
  $$('#tabs .tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#checkBtn').addEventListener('click', () => runCheck(true));
  $('#publishBtn').addEventListener('click', publishSession);
  $('#startBtn').addEventListener('click', async () => { await api(`/api/sessions/${state.session.id}/start`, { method: 'POST' }); toast('已开播，此后使用发布快照', 'ok'); await refreshAll(); });
  $('#endBtn').addEventListener('click', async () => { await api(`/api/sessions/${state.session.id}/end`, { method: 'POST' }); toast('场次已结束'); await refreshAll(); });

  $('#addSlotCard').addEventListener('click', openAddModal);
  $('#addCancel').addEventListener('click', () => $('#addModal').classList.add('hidden'));
  $('#addSku').addEventListener('change', fillPromoOptions);
  $('#addConfirm').addEventListener('click', confirmAddSlot);

  $('#saveScriptBtn').addEventListener('click', saveScript);
  $('#scriptArea').addEventListener('input', renderReviewTipsLive);
  $('#approveBtn').addEventListener('click', () => reviewScript('approved'));
  $('#rejectBtn').addEventListener('click', () => reviewScript('rejected'));
  $('#pullBtn').addEventListener('click', pullSelected);

  $('#sampleSubmit').addEventListener('click', submitSample);
  $('#reviewerSelect').addEventListener('change', renderReviewTipsLive);
  $$('.cb-dock .chip').forEach((c) => c.addEventListener('click', () => simulate(c.dataset.cb)));
}

const refreshAll = async () => { await loadRooms(); renderRooms(); await renderSamples(); await renderReceipts(); if (state.session) await loadSession(state.session.id); };

// ---------- Tab ----------
function switchTab(name) {
  $$('#tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'receipts') renderReceipts();
  if (name === 'samples') renderSamples();
  if (name === 'catalog') loadCatalog().then(renderCatalog);
}

// ---------- 数据加载 ----------
async function loadRooms() { state.rooms = await api('/api/rooms'); }
async function loadCatalog() { state.catalog = await api('/api/catalog'); }
async function loadSession(id, silent = false) {
  try {
    state.session = await api(`/api/sessions/${id}`);
    renderSession();
  } catch (e) {
    if (!silent) toast(e.message, 'bad');
  }
}
const selectSession = (id) => { state.selectedSlot = null; loadSession(id); };

// ---------- 房间/场次侧栏 ----------
function renderRooms() {
  $('#roomList').innerHTML = state.rooms.map((r) => `
    <div class="room-item ${state.room === r.id ? 'active' : ''}" data-room="${r.id}">
      <div class="r-name">${esc(r.name)}</div>
      <div class="r-sess">
        ${r.sessions.map((s) => `
          <div class="sess-pill ${state.session?.id === s.id ? 'active' : ''}" data-session="${s.id}">
            <span class="status-dot status-${s.status}"></span>${esc(s.title)} · ${STATUS_LABEL[s.status]}
          </div>`).join('') || '<div class="hint">暂无场次</div>'}
      </div>
    </div>`).join('');
  $$('#roomList [data-session]').forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation(); selectSession(el.dataset.session);
  }));
}

// ---------- 横向时间轴 ----------
function timelineClock(startsAt, minutesBefore) {
  const d = new Date(new Date(startsAt).getTime() + minutesBefore * 60000);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function renderSession() {
  renderRooms();
  const s = state.session;
  if (!s) return;
  $('#sessionTitle').textContent = s.title;
  $('#sessionMeta').innerHTML = `
    <span class="status-dot status-${s.status}"></span>${STATUS_LABEL[s.status]}
    <span>开播 ${fmtTime(s.starts_at)}</span>
    <span>排品 ${s.slots.length} 个 · 已撤 ${s.removed.length} 个</span>
    ${s.published_at ? `<span>发布于 ${fmtTime(s.published_at)}</span>` : ''}`;

  const draft = s.status === 'draft';
  $('#addSlotCard').classList.toggle('hidden', !draft);
  $('#startBtn').classList.toggle('hidden', s.status !== 'published');
  $('#endBtn').classList.toggle('hidden', !['published', 'live'].includes(s.status));
  const pb = $('#publishBtn');
  pb.disabled = !draft;
  pb.textContent = draft ? '发布场次' : (s.status === 'live' ? '直播中 · 快照已冻结' : '已发布 · 快照冻结');

  const issueBySlot = new Map();
  for (const it of s.check.issues) if (it.slot_id) {
    if (!issueBySlot.has(it.slot_id)) issueBySlot.set(it.slot_id, []);
    issueBySlot.get(it.slot_id).push(it);
  }
  const warnBySlot = new Map();
  for (const w of s.check.warnings) {
    if (!warnBySlot.has(w.slot_id)) warnBySlot.set(w.slot_id, []);
    warnBySlot.get(w.slot_id).push(w);
  }

  let acc = 0;
  $('#timeline').innerHTML = s.slots.map((sl) => {
    const p = sl.product;
    const start = timelineClock(s.starts_at, acc);
    acc += sl.talk_minutes;
    const issues = issueBySlot.get(sl.id) || [];
    const warns = warnBySlot.get(sl.id) || [];
    const stockCls = p.stock <= 0 ? 'stock-bad' : p.stock <= sl.stock_alert ? 'stock-low' : 'stock-ok';
    const linkCls = sl.link ? `link-${sl.link.status}` : 'link-invalid';
    const linkText = !sl.link ? '无挂链' : sl.link.status === 'active' ? '挂链有效' : sl.link.status === 'invalid' ? '链接失效' : '已撤链';
    const approvedV = sl.script?.reviews?.filter((r) => r.verdict === 'approved').map((r) => r.version) || [];
    const scriptOk = sl.script && approvedV.includes(sl.script.draft_version);
    const flags = [
      sl.script?.draft_version ? `<span class="flag ${scriptOk ? 'ok' : 'bad'}">脚本v${sl.script.draft_version}${scriptOk ? '·已审' : '·待审'}</span>` : '<span class="flag bad">无脚本</span>',
      `<span class="flag ${sl.sample ? (sl.sample.matches ? 'ok' : 'bad') : 'info'}">样品${sl.sample ? (sl.sample.matches ? '一致' : '不符') : '未登记'}</span>`,
      ...issues.filter((i) => ['price_changed', 'listing_offline'].includes(i.reason)).map((i) => `<span class="flag bad">${esc(i.label.split('：')[0])}</span>`),
      ...warns.map(() => `<span class="flag warn">库存预警</span>`),
    ].join('');
    const sel = state.selectedSlot?.id === sl.id ? 'selected' : '';
    return `
    <div class="tl-card ${sel}" data-slot="${sl.id}">
      <div class="tl-time"><span class="pos">#${sl.position}</span><span>${start} · ${sl.talk_minutes}分钟</span></div>
      <img class="tl-img" src="${p.image}" alt="">
      <div class="tl-body">
        <div class="tl-name">${esc(p.name)}</div>
        <div class="tl-price">${money(sl.price_cents)}
          <span class="old">${esc(sl.promo_version === 'none' ? '' : p.price_cents !== sl.price_cents ? money(p.price_cents) : '')}</span>
        </div>
        <div class="tl-facts">
          <div class="fact"><span class="ic">📦</span><span class="${stockCls}">库存 ${p.stock}（提示线 ${sl.stock_alert}）</span></div>
          <div class="fact"><span class="ic">🔗</span><span class="link-pill ${linkCls}">${linkText}</span></div>
          <div class="fact"><span class="ic">🎟️</span>${esc(sl.promo_version)} · ${esc((p.promos.find((x) => x.version === sl.promo_version) || {}).label || '')}</div>
        </div>
        <div class="tl-flags">${flags}</div>
      </div>
    </div>`;
  }).join('');
  $$('#timeline .tl-card').forEach((c) => c.addEventListener('click', () => {
    state.selectedSlot = s.slots.find((x) => x.id === c.dataset.slot);
    renderSession();
  }));

  $('#removedBar').innerHTML = s.removed.length
    ? `<span class="hint">已撤品：</span>` + s.removed.map((r) =>
      `<span class="removed-chip">${esc(r.sku)} <b>${esc(state.meta.pull_reasons[r.removed_reason] || r.removed_reason)}</b> · ${fmtTime(r.removed_at)}</span>`).join('') : '';

  renderEditor();
  renderCheckBanner(s.check, false);
  fillCallbackSkus();
}

// ---------- 整场校验横幅 ----------
function renderCheckBanner(check, manual) {
  const b = $('#checkBanner');
  if (!check) { b.classList.add('hidden'); return; }
  const frozen = check.status !== 'draft';
  if (check.ok) {
    b.className = 'banner ok';
    b.innerHTML = `✅ 整场挂链校验通过：${check.slot_count} 个商品挂链唯一有效、价格一致、脚本均已审核。` +
      (check.warnings.length ? `<br>⚠️ ${check.warnings.map((w) => esc(w.label)).join('；')}` : '');
  } else {
    b.className = frozen ? 'banner warn' : 'banner bad';
    b.innerHTML = (frozen
      ? `🔒 场次${STATUS_LABEL[check.status]}，直播继续使用发布快照；以下草稿态问题不影响已冻结快照（可走撤品流程）：<br>`
      : `🚫 ${check.issues.length} 项问题阻断发布：<br>`) +
      check.issues.map((i) => `· ${i.sku ? '【' + i.sku + '】' : ''}${esc(i.label)}`).join('<br>');
  }
  if (manual) b.classList.remove('hidden');
  else if (!check.ok) b.classList.remove('hidden'); else b.classList.add('hidden');
}
async function runCheck(manual) {
  const check = await api(`/api/sessions/${state.session.id}/check`);
  state.session.check = check;
  renderCheckBanner(check, manual);
  if (manual) toast(check.ok ? '整场校验通过' : `发现 ${check.issues.length} 个问题`, check.ok ? 'ok' : 'bad');
}

// ---------- 脚本编辑器 + 审核提示 ----------
function renderEditor() {
  const block = $('#editorBlock');
  const sl = state.selectedSlot;
  if (!sl) { block.style.opacity = '.55'; $('#scriptArea').value = ''; $('#reviewTips').className = 'review-tips muted'; $('#reviewTips').textContent = '点击时间轴上的商品卡，在此编辑讲解脚本。'; $('#versionHistory').innerHTML = ''; $('#reviewLog').innerHTML = ''; $('#scriptVersion').textContent = ''; $('#pullBtn').disabled = true; return; }
  block.style.opacity = '1';
  $('#pullBtn').disabled = false;
  const sc = sl.script;
  if (document.activeElement !== $('#scriptArea')) $('#scriptArea').value = sc?.draft || '';
  $('#scriptVersion').textContent = sc ? `草稿 v${sc.draft_version}${sc.published_version ? ` · 已发布 v${sc.published_version}` : ''}` : '尚未创建脚本';

  $('#versionHistory').innerHTML = (sc?.versions || []).slice().reverse().map((v) => {
    const cls = v.version === sc.published_version ? 'v-row published' : v.version === sc.draft_version ? 'v-row latest' : 'v-row';
    const tag = v.version === sc.published_version ? '✅ 发布快照' : v.version === sc.draft_version ? '📍 当前草稿' : '';
    return `<div class="${cls}"><span>v${v.version} · ${esc(v.change_note || '（无说明）')}</span><span class="hint">${tag} ${fmtTime(v.created_at)}</span></div>`;
  }).join('');

  $('#reviewLog').innerHTML = (sc?.reviews || []).slice().reverse().map((r) =>
    `<div class="rv-row ${r.verdict}"><b>${r.verdict === 'approved' ? '通过' : '驳回'}</b> v${r.version} · ${esc(r.reviewer_id)} · ${esc(r.comment || '')}<span class="hint"> ${fmtTime(r.created_at)}</span></div>`).join('')
    || '<div class="hint">暂无审核记录</div>';

  renderReviewTipsLive();
}

function renderReviewTipsLive() {
  const sl = state.selectedSlot;
  const box = $('#reviewTips');
  if (!sl) return;
  const sc = sl.script;
  const content = $('#scriptArea').value;
  const tips = [];
  const s = state.session;

  // 快照不可覆盖提示
  if (['live', 'ended'].includes(s.status) && sc?.published_version) {
    tips.push({ cls: 'warn', text: `🔒 场次已开始，直播继续使用发布快照 v${sc.published_version}；当前草稿 v${sc.draft_version}${content !== (sc.draft || '') ? '（编辑中）' : ''} 不会覆盖快照。` });
  }
  // 违规词（随输入实时扫描）
  const banned = sl.product.banned_words || [];
  const hits = banned.filter((w) => content.includes(w));
  tips.push(hits.length
    ? { cls: 'bad', text: '⛔ 命中违规词：' + hits.map(esc).join('、') + '。提交审核前必须删除。' }
    : { cls: 'ok', text: '✅ 未命中该商品的违规词库（' + banned.map(esc).join(' / ') + '）' });
  // 脚本审核状态
  if (!sc || sc.draft_version === 0) tips.push({ cls: 'warn', text: '📝 脚本还没有任何版本。' });
  else {
    const approved = (sc.reviews || []).some((r) => r.verdict === 'approved' && r.version === sc.draft_version);
    tips.push(approved
      ? { cls: 'ok', text: `✅ 当前草稿 v${sc.draft_version} 已通过审核。` }
      : { cls: 'bad', text: `🚫 当前草稿 v${sc.draft_version} 尚未通过审核，发布将被拦截。` });
  }
  // 自审拦截提示
  const authorId = sc?.author_id;
  const reviewerId = $('#reviewerSelect').value;
  const reviewer = state.meta.users.find((u) => u.id === reviewerId);
  if (authorId && reviewerId === authorId) tips.push({ cls: 'bad', text: '⛔ 审核人与脚本作者为同一人，不能审核自己编写的脚本。' });
  // 商品卡维度的问题
  const slotIssues = (s.check.issues || []).filter((i) => i.slot_id === sl.id);
  for (const i of slotIssues) {
    if (['link_invalid', 'link_not_unique', 'out_of_stock', 'price_changed', 'sample_mismatch', 'listing_offline'].includes(i.reason)) {
      tips.push({ cls: 'bad', text: '🚫 ' + esc(i.label) });
    }
  }
  const low = (s.check.warnings || []).find((w) => w.slot_id === sl.id);
  if (low) tips.push({ cls: 'warn', text: '⚠️ ' + esc(low.label) });

  box.className = 'review-tips';
  box.innerHTML = tips.map((t) => `<div class="tip ${t.cls}"><span class="ic"></span><span>${t.text}</span></div>`).join('');

  // 审核按钮：作者=审核人时禁用
  const self = authorId && reviewerId === authorId;
  $('#approveBtn').disabled = !sc || sc.draft_version === 0 || self || reviewer?.role !== 'reviewer';
  $('#rejectBtn').disabled = $('#approveBtn').disabled;
}
async function saveScript() {
  const sl = state.selectedSlot;
  if (!sl) return toast('请先选择商品卡', 'bad');
  const content = $('#scriptArea').value.trim();
  if (!content) return toast('脚本内容不能为空', 'bad');
  try {
    await api(`/api/slots/${sl.id}/script`, { method: 'POST', body: { author_id: sl.script?.author_id || actor(), content, change_note: $('#changeNote').value } });
    $('#changeNote').value = '';
    toast('已生成新版本', 'ok');
    await loadSession(state.session.id);
    state.selectedSlot = state.session.slots.find((x) => x.id === sl.id) || null;
    renderSession();
  } catch (e) { toast(e.message, 'bad'); }
}

async function reviewScript(verdict) {
  const sl = state.selectedSlot;
  const comment = verdict === 'rejected' ? prompt('驳回说明（可留空）', '请修改后重新提交') || '' : (prompt('审核意见（可留空）', '通过') || '');
  try {
    await api(`/api/slots/${sl.id}/reviews`, { method: 'POST', body: { reviewer_id: $('#reviewerSelect').value, verdict, comment } });
    toast(verdict === 'approved' ? '审核通过' : '已驳回', verdict === 'approved' ? 'ok' : 'bad');
    await loadSession(state.session.id);
    state.selectedSlot = state.session.slots.find((x) => x.id === sl.id) || null;
    renderSession();
  } catch (e) { toast(e.message, 'bad'); }
}

async function pullSelected() {
  const sl = state.selectedSlot;
  if (!sl) return;
  const reason = prompt('撤品原因：out_of_stock 缺货 / price_changed 价格变更 / link_invalid 链接失效 / sample_mismatch 样品不符 / banned_word 违规词 / manual 临时撤品', 'manual');
  if (!reason || !state.meta.pull_reasons[reason]) return toast('原因无效', 'bad');
  try {
    const r = await api(`/api/slots/${sl.id}?reason=${reason}`, { method: 'DELETE' });
    toast(`已撤品并生成回执：${r.receipt.summary}`, 'ok');
    state.selectedSlot = null;
    await refreshAll();
  } catch (e) { toast(e.message, 'bad'); }
}

// ---------- 发布 ----------
async function publishSession() {
  if (!state.session) return;
  try {
    const r = await api(`/api/sessions/${state.session.id}/publish`, { method: 'POST' });
    toast('发布成功，快照已冻结', 'ok');
    state.selectedSlot = null;
    await refreshAll();
    setTimeout(() => switchTab('receipts'), 400);
    console.log('发布回执', r.receipt);
  } catch (e) {
    if (e.status === 422 && e.data.details) {
      state.session.check = { ...state.session.check, ok: false, issues: e.data.details };
      renderCheckBanner(state.session.check, true);
    }
    toast(e.message, 'bad');
  }
}

// ---------- 加入排品弹层 ----------
function openAddModal() {
  if (!state.session) return;
  const eligible = state.catalog.filter((p) =>
    p.doc?.doc_status === 'approved' &&
    !state.session.slots.some((s) => s.sku === p.sku));
  $('#addSku').innerHTML = eligible.map((p) =>
    `<option value="${p.sku}">${p.sku} ${esc(p.name)} · ${money(p.price_cents)} · 库存${p.stock} · ${p.link.status === 'active' ? '挂链有效' : '挂链失效'}</option>`).join('')
    || '<option value="">没有可排商品（先过资料审核）</option>';
  fillPromoOptions();
  $('#addModal').classList.remove('hidden');
}
function fillPromoOptions() {
  const p = state.catalog.find((x) => x.sku === $('#addSku').value);
  $('#addPromo').innerHTML = p ? p.promos.map((x) => `<option value="${x.version}">${esc(x.label)} · 到手 ${money(x.price_cents)}</option>`).join('') : '';
}
async function confirmAddSlot() {
  try {
    const sl = await api(`/api/sessions/${state.session.id}/slots`, {
      method: 'POST',
      body: { sku: $('#addSku').value, talk_minutes: +$('#addMinutes').value, stock_alert: +$('#addStockAlert').value, promo_version: $('#addPromo').value },
    });
    $('#addModal').classList.add('hidden');
    toast('排品成功', 'ok');
    await loadSession(state.session.id);
    state.selectedSlot = state.session.slots.find((x) => x.id === sl.id) || null;
    renderSession();
  } catch (e) { toast(e.message, 'bad'); }
}

// ---------- 商品审核页 ----------
function renderCatalog() {
  $('#sampleSku').innerHTML = state.catalog.map((p) => `<option value="${p.sku}">${p.sku} ${esc(p.name)}</option>`).join('');
  $('#catalogGrid').innerHTML = state.catalog.map((p) => {
    const st = p.doc?.doc_status || 'pending';
    const pill = { approved: ['doc-approved', '资料已过审'], pending: ['doc-pending', '待审核'], rejected: ['doc-rejected', '已驳回'] }[st];
    return `
    <div class="prod-card" data-sku="${p.sku}">
      <img class="prod-img" src="${p.image}" alt="">
      <div class="prod-body">
        <div class="prod-name">${esc(p.name)}</div>
        <div class="prod-meta">
          <span>${p.sku} · ${esc(p.category)} · ${money(p.price_cents)} · 库存${p.stock}</span>
          <span class="doc-pill ${pill[0]}">${pill[1]}</span>
        </div>
        <div class="hint" style="margin-bottom:8px">挂链：${p.link.status === 'active' ? '有效' : '失效'} ｜ 违规词库：${esc((p.banned_words || []).join('、') || '无')}</div>
        ${p.doc?.doc_note ? `<div class="hint" style="margin-bottom:8px">审核备注：${esc(p.doc.doc_note)}</div>` : ''}
        <div class="prod-actions">
          <button class="btn ghost" data-act="submit">提交资料</button>
          <button class="btn approve" data-act="approved">通过</button>
          <button class="btn reject" data-act="rejected">驳回</button>
        </div>
      </div>
    </div>`;
  }).join('');
  $$('#catalogGrid [data-act]').forEach((b) => b.addEventListener('click', async () => {
    const sku = b.closest('.prod-card').dataset.sku;
    try {
      if (b.dataset.act === 'submit') await api(`/api/products/${sku}/submit`, { method: 'POST' });
      else {
        const note = prompt(b.dataset.act === 'approved' ? '通过备注' : '驳回原因', b.dataset.act === 'approved' ? '资质齐全' : '资料缺失') || '';
        await api(`/api/products/${sku}/review`, { method: 'POST', body: { reviewer_id: actor(), status: b.dataset.act, note } });
      }
      toast('操作成功', 'ok');
      await loadCatalog(); renderCatalog();
    } catch (e) { toast(e.message + '（可在右上角切换审核人身份）', 'bad'); }
  }));
}

// ---------- 样品 ----------
async function submitSample() {
  const sku = $('#sampleSku').value;
  const matches = +$$('input[name=sampleMatch]:checked')[0]?.value || 1;
  const discrepancy = $('#sampleNote').value;
  const file = $('#samplePhoto').files[0];
  const body = { sku, matches: !!matches, discrepancy };
  if (file) {
    body.photo = { name: file.name, data: await fileToBase64(file) };
  }
  try {
    await api('/api/samples', { method: 'POST', body });
    $('#sampleNote').value = '';
    toast('样品已登记，照片已保存到本地目录', 'ok');
    renderSamples();
    if (state.session) await loadSession(state.session.id);
  } catch (e) { toast(e.message, 'bad'); }
}
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
async function renderSamples() {
  const list = await api('/api/samples').catch(() => ({ rows: [] }));
  $('#sampleList').innerHTML = (list.rows || []).map((m) => `
    <div class="sample-card">
      ${m.photo_path ? `<img src="/photos/${encodeURIComponent(m.photo_path.split(/[\\/]/).pop())}" alt="">` : '<div class="no-photo">无照片</div>'}
      <div class="sample-body">
        <b>${m.sku}</b> · ${m.matches ? '<span style="color:var(--ok)">一致</span>' : '<span style="color:var(--bad)">不符</span>'}<br>
        <span class="hint">${fmtTime(m.received_at)} · ${esc(m.registered_by)}</span>
        ${m.discrepancy ? `<div>${esc(m.discrepancy)}</div>` : ''}
      </div>
    </div>`).join('') || '<div class="hint">暂无样品记录</div>';
}

// ---------- 回执 ----------
async function renderReceipts() {
  const rows = await api('/api/receipts');
  $('#receiptList').innerHTML = rows.map((r) => `
    <div class="receipt">
      <span class="kind kind-${r.kind}">${({ publish: '发布', pull: '撤品', callback: '回调' })[r.kind]}</span>
      <div>
        <div class="summary">${esc(r.summary)}</div>
        <div class="meta">${r.id} · ${fmtTime(r.created_at)} · 已投递 audit-center://demo</div>
      </div>
      <details><summary class="hint">回执内容</summary><pre>${esc(JSON.stringify(r.detail, null, 2))}</pre></details>
    </div>`).join('') || '<div class="hint">暂无回执</div>';
}

// ---------- 回调模拟器 ----------
function fillCallbackSkus() {
  const skus = (state.session?.slots || []).map((s) => s.sku);
  const all = new Set([...skus, ...state.catalog.map((p) => p.sku)]);
  $('#cbSku').innerHTML = [...all].map((s) => `<option value="${s}">${s}</option>`).join('');
}
async function simulate(kind) {
  const sku = $('#cbSku').value;
  const slot = state.session?.slots.find((s) => s.sku === sku);
  const ts = () => new Date().toISOString();
  try {
    if (kind === 'order') {
      if (!slot) return toast('该商品不在当前场次中', 'bad');
      const o = await api(`/api/slots/${slot.id}/orders`, { method: 'POST' });
      return toast(`成交一单 ${o.id}（快照价 ${money(o.price_cents)}），后续回调不会改动它`, 'ok');
    }
    let evt;
    const p = state.catalog.find((x) => x.sku === sku);
    if (kind === 'stock0') evt = { event_id: 'EVT-' + Date.now(), sku, type: 'stock', stock: 0, ts: ts() };
    if (kind === 'price') evt = { event_id: 'EVT-' + Date.now(), sku, type: 'price', price_cents: Math.round(p.price_cents * 1.1), ts: ts() };
    if (kind === 'link') evt = { event_id: 'EVT-' + Date.now(), sku, type: 'link', status: 'invalid', ts: ts() };
    if (kind === 'offline') evt = { event_id: 'EVT-' + Date.now(), sku, type: 'listing', action: 'offline', ts: ts() };
    if (kind === 'dup') {
      if (!state.lastEvent) return toast('先触发一次回调，再试重复投递', 'bad');
      evt = { ...state.lastEvent }; // 相同 event_id
    } else {
      state.lastEvent = evt;
    }
    const r = await api('/api/callbacks', { method: 'POST', body: evt });
    if (r.duplicate) toast('重复回调：已忽略，未重复上下架，订单不变', 'ok');
    else if (r.stale) toast('乱序旧事件：已忽略', 'ok');
    else toast(r.applied ? '回调已生效并生成回执' : '回调到达但状态无变化', r.applied ? 'ok' : '');
    await loadCatalog(); renderCatalog();
    if (state.session) await loadSession(state.session.id);
    renderReceipts();
  } catch (e) { toast(e.message, 'bad'); }
}

init().catch((e) => toast('初始化失败：' + e.message, 'bad'));
