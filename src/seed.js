'use strict';
// 首启种子：演示用户、商品资料审核状态、一个草稿场次（含待处理问题）、一个已开播场次（快照已冻结）。
const fs = require('node:fs');
const path = require('node:path');
const { USERS } = require('./adapters');
const { PHOTO_DIR } = require('./db');

// 1x1 珊瑚色 PNG，仅用于样品照片落盘演示
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function seed(db, svc, catalog) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;

  const ins = db.prepare('INSERT INTO users (id, name, role) VALUES (?,?,?)');
  for (const u of USERS) ins.run(u.id, u.name, u.role);

  // 商品资料审核：6 个通过，P1004 驳回（链接也失效），P1005 待审（缺货）
  const approved = ['P1001', 'P1002', 'P1003', 'P1006', 'P1007', 'P1008'];
  for (const sku of approved) {
    svc.submitProductDoc(sku);
    svc.reviewProductDoc(sku, 'R01', 'approved', '资质、检测报告齐全');
  }
  svc.submitProductDoc('P1004');
  svc.reviewProductDoc('P1004', 'R02', 'rejected', '备案信息缺失，驳回后重新提交');
  svc.submitProductDoc('P1005');

  const room = svc.createRoom('珊瑚晚场 2 号直播间', 'U01');

  // ---------- 草稿场次：留给界面操作（有违规词/缺脚本/样品不符等问题） ----------
  const draft = svc.createSession(room.id, '国庆上新·美妆家居专场', '2026-10-01T19:30:00+08:00');
  const s1 = svc.addSlot(draft.id, { sku: 'P1001', talk_minutes: 15, stock_alert: 30, promo_version: 'v1' });
  const s2 = svc.addSlot(draft.id, { sku: 'P1002', talk_minutes: 12, stock_alert: 20, promo_version: 'v1' });
  svc.addSlot(draft.id, { sku: 'P1003', talk_minutes: 10, stock_alert: 15, promo_version: 'none' });

  svc.saveScript(s1.id, 'U01', '开场先试色 #04 落日珊瑚，薄涂日常、厚涂气场，今天满199减30，库存320支拍完补不到。', '初稿');
  svc.reviewScript(s1.id, 'R01', 'approved', '卖点清晰，无违规词');
  // 故意留一个违规词，供“审核提示”演示
  svc.saveScript(s2.id, 'U01', '石墨黑保温杯，316 不锈钢内胆永不降温，冬天十二小时还烫嘴。', '初稿');
  svc.reviewScript(s2.id, 'R02', 'rejected', '出现违禁绝对化表述“永不降温”，请修改后重新提交');
  // P1003 没有脚本 → 发布前校验拦截

  // 样品：P1001 已核对一致；P1003 样品与详情不符
  svc.registerSample({ sku: 'P1001', slot_id: s1.id, matches: true, discrepancy: '', registered_by: 'O01' });
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  fs.writeFileSync(path.join(PHOTO_DIR, 'P1003_sample.png'), Buffer.from(TINY_PNG, 'base64'));
  db.prepare(`INSERT INTO samples (id, sku, slot_id, received_at, matches, discrepancy, photo_path, registered_by)
    VALUES (?,?,?,?,?,?,?,?)`).run('SMseed01', 'P1003', null, new Date().toISOString(), 0,
      '样品颜色比详情图偏黄一个色号，吊牌洗标齐全', path.join(PHOTO_DIR, 'P1003_sample.png'), 'O01');

  // ---------- 已开播场次：发布快照已冻结，直播中改脚本不影响快照 ----------
  const live = svc.createSession(room.id, '周三数码小专场', '2026-09-28T20:00:00+08:00');
  const l1 = svc.addSlot(live.id, { sku: 'P1007', talk_minutes: 20, stock_alert: 10, promo_version: 'v1' });
  const l2 = svc.addSlot(live.id, { sku: 'P1008', talk_minutes: 8, stock_alert: 40, promo_version: 'none' });
  svc.saveScript(l1.id, 'U02', '深海降噪蓝牙耳机，通勤地铁里实测降噪明显，今晚限时直降40。', '初稿');
  svc.reviewScript(l1.id, 'R01', 'approved', '通过');
  svc.saveScript(l2.id, 'U02', '每日坚果30包独立装，低卡拌酸奶都行，拍两盒更划算。', '初稿');
  svc.reviewScript(l2.id, 'R02', 'approved', '通过，注意不要说零糖');
  svc.registerSample({ sku: 'P1007', slot_id: l1.id, matches: true, registered_by: 'O01' });
  svc.registerSample({ sku: 'P1008', slot_id: l2.id, matches: true, registered_by: 'O01' });
  svc.publishSession(live.id, 'O01');
  svc.startSession(live.id);
  // 已成交一单；之后任何回调/撤品都不能动它
  svc.placeOrder(l1.id);
  // 直播中主播改脚本 → 草稿 v2，已发布快照仍是 v1
  svc.saveScript(l1.id, 'U02', '深海降噪蓝牙耳机，补充：充电盒续航30小时，今晚限时直降40，最后12台。', '直播中补充库存口播');
  // 临时撤品 P1008，生成撤品回执（l1 的订单不受影响）
  svc.pullSlot(l2.id, 'manual', 'O01');

  return true;
}

module.exports = { seed };
