'use strict';
// 单条本地启动命令样例：npm run demo
// 在内存库中走完整业务流：资料审核 → 排品 → 脚本版本 → 审核权限 → 发布快照 →
// 撤品回执 → 回调幂等/乱序 → 已成交订单不受影响，并打印回执。
const { openDb } = require('./db');
const { createServices } = require('./services');
const { catalog } = require('./adapters');

const money = (c) => '¥' + (c / 100).toFixed(2);

function main() {
  const db = openDb(':memory:');
  const svc = createServices(db);
  const say = (t) => console.log('\n=== ' + t + ' ===');

  say('1. 商品资料审核通过后排品（未通过的会被门禁拦截）');
  ['P1001', 'P1002', 'P1007', 'P1008'].forEach((sku) => {
    svc.submitProductDoc(sku);
    svc.reviewProductDoc(sku, 'R01', 'approved', '资料齐全');
  });
  const room = svc.createRoom('演示直播间', 'U01');
  const ss = svc.createSession(room.id, '演示专场', '2026-10-01T20:00:00+08:00');
  const a = svc.addSlot(ss.id, { sku: 'P1001', talk_minutes: 15, stock_alert: 30, promo_version: 'v1' });
  const b = svc.addSlot(ss.id, { sku: 'P1007', talk_minutes: 20, stock_alert: 10, promo_version: 'v1' });
  console.log('排品 2 个：', a.sku, money(a.price_cents), '/', b.sku, money(b.price_cents));

  try {
    svc.addSlot(ss.id, { sku: 'P1001' });
  } catch (e) {
    console.log('挂链唯一拦截：', e.message);
  }

  say('2. 脚本修改生成版本，审核人不能自审');
  svc.saveScript(a.id, 'U01', '开场试色，满199减30。', '初稿');
  svc.saveScript(a.id, 'U01', '开场试色，满199减30，加赠卸妆水。', '补充赠品');
  const script = svc.getScript(a.id);
  console.log('当前草稿版本：v' + script.draft_version, '，历史版本：', script.versions.map((v) => 'v' + v.version).join(', '));
  try {
    svc.reviewScript(a.id, 'U01', 'approved');
  } catch (e) {
    console.log('审核权限拦截（主播不能审核）：', e.message);
  }
  svc.reviewScript(a.id, 'R01', 'approved', '通过');
  svc.saveScript(b.id, 'U02', '降噪耳机，限时直降40，绝不零延迟。', '初稿'); // 含违规词“零延迟”
  const scan = svc.scanScript('P1007', svc.getScript(b.id).draft);
  console.log('违规词扫描：', scan.clean ? '干净' : '命中 ' + scan.hits.join('、'));
  svc.saveScript(b.id, 'U02', '降噪耳机，限时直降40。', '删除违规词');
  svc.reviewScript(b.id, 'R02', 'approved', '通过');

  say('3. 发布前整场校验 + 发布回执（快照冻结）');
  const pub = svc.publishSession(ss.id, 'O01');
  console.log(pub.receipt.summary);
  console.log('快照版本：', pub.snapshot.slots.map((s) => `${s.sku}=脚本v${s.script.version}@${money(s.price_cents)}`).join(', '));
  svc.startSession(ss.id);

  say('4. 开播后改脚本：直播继续使用发布快照，草稿不覆盖');
  svc.saveScript(a.id, 'U01', '直播中临时改的话术……', '直播中修改');
  const snap = JSON.parse(db.prepare('SELECT published_snapshot FROM sessions WHERE id=?').get(ss.id).published_snapshot);
  console.log('快照仍是：v' + snap.slots[0].script.version, '→', snap.slots[0].script.content);

  say('5. 已成交订单 + 撤品回执');
  const order = svc.placeOrder(a.id);
  console.log('成交订单：', order.id, order.sku, money(order.price_cents), order.status);
  const pulled = svc.pullSlot(b.id, 'link_invalid', 'O01');
  console.log(pulled.receipt.summary, '| 已成交订单未改动数：', pulled.receipt.detail.closed_orders_untouched);

  say('6. 回调：幂等（重复不重复上下架）+ 乱序（旧事件忽略）');
  const online = { event_id: 'EVT-1', sku: 'P1001', type: 'listing', action: 'offline', ts: '2026-10-01T20:05:00+08:00' };
  console.log('首次：', JSON.stringify(svc.ingestCallback(online)));
  console.log('重复：', JSON.stringify(svc.ingestCallback(online)));
  const staleOnline = { event_id: 'EVT-2', sku: 'P1001', type: 'listing', action: 'online', ts: '2026-10-01T20:01:00+08:00' };
  console.log('乱序旧事件：', JSON.stringify(svc.ingestCallback(staleOnline)));
  console.log('商品当前 listing（仍应为 offline）：', catalog.get('P1001').listing);
  const after = db.prepare('SELECT status FROM orders WHERE id=?').get(order.id);
  console.log('订单状态（应仍为 placed）：', after.status);

  say('7. 全部回执（模拟审核中心已收件）');
  for (const r of svc.listReceipts()) {
    console.log(`- [${r.kind}] ${r.summary}  → audit-center://demo @ ${r.created_at}`);
  }
}

main();
