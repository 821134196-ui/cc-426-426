'use strict';
// 进程内模拟适配器：商品目录 / 价格 / 主播 / 挂链状态 / 审核回执外发。
// 真实系统里这些会走电商平台 API，这里全部在内存中模拟，可随时改价、缺货、失效链接。

function svgImage(label, bg, fg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
  <rect width="320" height="320" rx="28" fill="${bg}"/>
  <circle cx="256" cy="64" r="46" fill="#FF6F5E" opacity="0.85"/>
  <circle cx="64" cy="262" r="70" fill="#FFFFFF" opacity="0.14"/>
  <text x="160" y="168" font-size="34" font-family="sans-serif" font-weight="700"
        fill="${fg}" text-anchor="middle">${label}</text>
</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

// 优惠版本：discount 基于当前目录价实时计算，目录改价后优惠到手价随之变化
// discount: null=同价（赠品/多件规则），{type:'percent',v}=按比例，{type:'minus',v}=立减（分）
const PROMOS = {
  P1001: [
    { version: 'none', label: '无优惠', discount: null },
    { version: 'v1', label: '满199减30', discount: { type: 'minus', v: 3000 } },
    { version: 'v2', label: '直播加赠卸妆水', discount: null },
  ],
  P1002: [
    { version: 'none', label: '无优惠', discount: null },
    { version: 'v1', label: '专场95折', discount: { type: 'percent', v: 0.95 } },
  ],
  P1003: [
    { version: 'none', label: '无优惠', discount: null },
    { version: 'v1', label: '两件减50', discount: { type: 'minus', v: 5000 } },
  ],
  P1004: [{ version: 'none', label: '无优惠', discount: null }],
  P1005: [
    { version: 'none', label: '无优惠', discount: null },
    { version: 'v1', label: '券后立减10元', discount: { type: 'minus', v: 1000 } },
  ],
  P1006: [{ version: 'none', label: '无优惠', discount: null }],
  P1007: [
    { version: 'none', label: '无优惠', discount: null },
    { version: 'v1', label: '限时直降40元', discount: { type: 'minus', v: 4000 } },
  ],
  P1008: [
    { version: 'none', label: '无优惠', discount: null },
    { version: 'v1', label: '第二件半价', discount: null },
  ],
};

const CATALOG = [
  {
    sku: 'P1001', name: '绒雾唇釉 #04 落日珊瑚', category: '美妆',
    image: svgImage('唇釉', '#2B2B30', '#F6F1E7'),
    stock: 320, link: { url: 'https://demo.shop/p/P1001', status: 'active' },
    banned_words: ['全网最低', '绝对不沾杯', '医用级'],
  },
  {
    sku: 'P1002', name: '石墨黑316保温杯 500ml', category: '家居',
    image: svgImage('保温杯', '#F6F1E7', '#2B2B30'),
    stock: 156, link: { url: 'https://demo.shop/p/P1002', status: 'active' },
    banned_words: ['永不降温', '医用316'],
  },
  {
    sku: 'P1003', name: '奶油白云朵针织衫', category: '服饰',
    image: svgImage('针织衫', '#EDE6D6', '#2B2B30'),
    stock: 88, link: { url: 'https://demo.shop/p/P1003', status: 'active' },
    banned_words: ['100%纯棉', '不起球'],
  },
  {
    sku: 'P1004', name: '三色大地眼影盘', category: '美妆',
    image: svgImage('眼影盘', '#2B2B30', '#F6F1E7'),
    stock: 240, link: { url: 'https://demo.shop/p/P1004', status: 'invalid' },
    banned_words: ['大牌平替', '孕妇可用'],
  },
  {
    sku: 'P1005', name: '口袋补光灯 Pro', category: '数码',
    image: svgImage('补光灯', '#F6F1E7', '#2B2B30'),
    stock: 0, link: { url: 'https://demo.shop/p/P1005', status: 'active' },
    banned_words: ['最亮', '专业演播室级'],
  },
  {
    sku: 'P1006', name: '真丝桑蚕丝发圈 三支装', category: '配饰',
    image: svgImage('发圈', '#EDE6D6', '#2B2B30'),
    stock: 410, link: { url: 'https://demo.shop/p/P1006', status: 'active' },
    banned_words: ['100%桑蚕丝'],
  },
  {
    sku: 'P1007', name: '深海降噪蓝牙耳机', category: '数码',
    image: svgImage('耳机', '#2B2B30', '#F6F1E7'),
    stock: 12, link: { url: 'https://demo.shop/p/P1007', status: 'active' },
    banned_words: ['零延迟', '最强降噪'],
  },
  {
    sku: 'P1008', name: '每日坚果低卡礼盒 30包', category: '食品',
    image: svgImage('坚果', '#F6F1E7', '#2B2B30'),
    stock: 200, link: { url: 'https://demo.shop/p/P1008', status: 'active' },
    banned_words: ['减肥', '零糖', '最佳'],
  },
];

const USERS = [
  { id: 'U01', name: '林晚（主播）', role: 'host' },
  { id: 'U02', name: '周越（主播）', role: 'host' },
  { id: 'R01', name: '审核·沈律', role: 'reviewer' },
  { id: 'R02', name: '审核·高岑', role: 'reviewer' },
  { id: 'O01', name: '场控·阿屿', role: 'operator' },
];

const BASE_PRICES = {
  P1001: 8900, P1002: 12900, P1003: 23900, P1004: 15900,
  P1005: 6900, P1006: 4900, P1007: 39900, P1008: 9900,
};

class CatalogAdapter {
  constructor() {
    this._items = new Map(CATALOG.map((p) => [p.sku, structuredClone(p)]));
    // 价格可独立调整，模拟“价格变更”事件；listing 模拟平台上下架状态
    for (const p of this._items.values()) {
      p.price_cents = BASE_PRICES[p.sku];
      p.list_price_cents = p.price_cents; // 初始目录价，仅展示
      p.listing = 'online';
    }
  }
  list() { return [...this._items.values()].map((p) => structuredClone(p)); }
  get(sku) { const p = this._items.get(sku); return p ? structuredClone(p) : null; }
  promos(sku) {
    const item = this.get(sku);
    const base = item ? item.price_cents : 0;
    return (PROMOS[sku] || [{ version: 'none', label: '无优惠', discount: null }]).map((p) => ({
      version: p.version, label: p.label,
      price_cents: this._applyDiscount(base, p.discount),
    }));
  }
  promoPrice(sku, version) {
    const item = this.get(sku);
    if (!item) return null;
    const hit = (PROMOS[sku] || []).find((x) => x.version === version);
    if (!hit) return null;
    return this._applyDiscount(item.price_cents, hit.discount);
  }
  _applyDiscount(base, discount) {
    if (!discount) return base;
    if (discount.type === 'percent') return Math.round(base * discount.v);
    if (discount.type === 'minus') return Math.max(0, base - discount.v);
    return base;
  }
  setStock(sku, stock) { this._must(sku).stock = stock; }
  changePrice(sku, priceCents) { this._must(sku).price_cents = priceCents; }
  setLinkStatus(sku, status) { this._must(sku).link.status = status; }
  setListing(sku, listing) { this._must(sku).listing = listing; }
  _must(sku) {
    const p = this._items.get(sku);
    if (!p) throw new Error(`未知商品 ${sku}`);
    return p;
  }
}

class ReceiptAdapter {
  // 进程内“外发”模拟：回执写入内存发件箱，真实环境替换为 IM/审核中心 webhook。
  constructor() { this.outbox = []; }
  send(receipt) {
    const envelope = { delivered_at: new Date().toISOString(), target: 'audit-center://demo', ...receipt };
    this.outbox.push(envelope);
    return { ok: true, delivered_at: envelope.delivered_at, target: envelope.target };
  }
}

const catalog = new CatalogAdapter();
const receipts = new ReceiptAdapter();

module.exports = { catalog, receipts, USERS, PROMOS, CatalogAdapter, ReceiptAdapter };
