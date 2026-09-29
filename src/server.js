'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { openDb, PHOTO_DIR } = require('./db');
const { createServices } = require('./services');
const { catalog, receipts, USERS } = require('./adapters');
const { seed } = require('./seed');

const PORT = Number(process.env.PORT || 5173);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const db = openDb();
const svc = createServices(db);
seed(db, svc, catalog);

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 8 * 1024 * 1024) reject(new Error('body too large')); });
  req.on('end', () => {
    if (!data) return resolve({});
    try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON')); }
  });
  req.on('error', reject);
});
const actor = (req, url) => req.headers['x-actor'] || url.searchParams.get('as') || 'O01';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json' };

function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function servePhoto(res, name) {
  const file = path.normalize(path.join(PHOTO_DIR, name));
  if (!file.startsWith(PHOTO_DIR)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'photo not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'image/png' });
    res.end(buf);
  });
}

async function handleApi(req, res, url) {
  const segs = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const as = actor(req, url);
  const wrap = (fn) => { try { fn(); } catch (e) { apiError(res, e); } };

  if (req.method === 'GET' && url.pathname === '/api/meta') {
    return json(res, 200, { users: USERS, actor: as, pull_reasons: svc.PULL_REASONS,
      outbox_count: receipts.outbox.length });
  }
  if (req.method === 'GET' && url.pathname === '/api/catalog') {
    return json(res, 200, catalog.list().map((p) => ({
      ...p, promos: catalog.promos(p.sku),
      doc: db.prepare('SELECT doc_status, doc_note FROM products WHERE sku=?').get(p.sku) || null,
    })));
  }
  if (req.method === 'GET' && url.pathname === '/api/rooms') {
    const rooms = db.prepare('SELECT * FROM rooms ORDER BY created_at').all();
    for (const r of rooms) {
      r.sessions = db.prepare('SELECT id, title, starts_at, status FROM sessions WHERE room_id=? ORDER BY starts_at').all(r.id);
    }
    return json(res, 200, rooms);
  }
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const b = await readBody(req);
    return wrap(() => json(res, 201, svc.createRoom(b.name, b.host_id || as)));
  }
  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    const b = await readBody(req);
    return wrap(() => json(res, 201, svc.createSession(b.room_id, b.title, b.starts_at)));
  }
  if (req.method === 'GET' && segs[1] === 'sessions' && segs[2] && !segs[3]) {
    return wrap(() => json(res, 200, svc.sessionDetail(segs[2])));
  }
  if (segs[1] === 'sessions' && segs[2]) {
    const id = segs[2];
    if (req.method === 'POST' && segs[3] === 'publish') return wrap(() => json(res, 200, svc.publishSession(id, as)));
    if (req.method === 'POST' && segs[3] === 'start') return wrap(() => json(res, 200, svc.startSession(id)));
    if (req.method === 'POST' && segs[3] === 'end') return wrap(() => json(res, 200, svc.endSession(id)));
    if (req.method === 'POST' && segs[3] === 'slots') {
      const b = await readBody(req);
      return wrap(() => json(res, 201, svc.addSlot(id, b)));
    }
    if (req.method === 'GET' && segs[3] === 'check') return wrap(() => json(res, 200, svc.validateSession(id)));
    if (req.method === 'GET' && segs[3] === 'receipts') {
      return json(res, 200, svc.listReceipts(id));
    }
  }
  if (segs[1] === 'slots' && segs[2]) {
    const slotId = segs[2];
    if (req.method === 'DELETE') {
      return wrap(() => json(res, 200, svc.pullSlot(slotId, url.searchParams.get('reason') || 'manual', as)));
    }
    if (req.method === 'GET' && segs[3] === 'script') return wrap(() => json(res, 200, svc.getScript(slotId)));
    if (req.method === 'POST' && segs[3] === 'script') {
      const b = await readBody(req);
      return wrap(() => json(res, 200, svc.saveScript(slotId, b.author_id || as, b.content, b.change_note || '')));
    }
    if (req.method === 'POST' && segs[3] === 'reviews') {
      const b = await readBody(req);
      return wrap(() => json(res, 201, svc.reviewScript(slotId, b.reviewer_id || as, b.verdict, b.comment || '')));
    }
    if (req.method === 'POST' && segs[3] === 'orders') return wrap(() => json(res, 201, svc.placeOrder(slotId)));
  }
  if (segs[1] === 'products' && segs[2]) {
    const sku = segs[2];
    if (req.method === 'POST' && segs[3] === 'submit') return wrap(() => json(res, 200, svc.submitProductDoc(sku)));
    if (req.method === 'POST' && segs[3] === 'review') {
      const b = await readBody(req);
      return wrap(() => json(res, 200, svc.reviewProductDoc(sku, b.reviewer_id || as, b.status, b.note || '')));
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/samples') {
    return json(res, 200, { rows: db.prepare('SELECT * FROM samples ORDER BY received_at DESC').all() });
  }
  if (req.method === 'POST' && url.pathname === '/api/samples') {
    const b = await readBody(req);
    b.registered_by = b.registered_by || as;
    return wrap(() => json(res, 201, svc.registerSample(b)));
  }
  if (req.method === 'GET' && url.pathname === '/api/receipts') return json(res, 200, svc.listReceipts());
  if (req.method === 'POST' && url.pathname === '/api/callbacks') {
    const b = await readBody(req);
    if (!b.event_id) b.event_id = 'EVT-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    return wrap(() => json(res, 200, svc.ingestCallback(b)));
  }
  // 演示用：直接改适配器状态（不等平台回调）
  if (req.method === 'POST' && segs[1] === 'sim') {
    const b = await readBody(req);
    if (segs[2] === 'price') { catalog.changePrice(b.sku, b.price_cents); return json(res, 200, { ok: true }); }
    if (segs[2] === 'stock') { catalog.setStock(b.sku, b.stock); return json(res, 200, { ok: true }); }
    if (segs[2] === 'link') { catalog.setLinkStatus(b.sku, b.status); return json(res, 200, { ok: true }); }
  }
  return json(res, 404, { error: 'no such api route', path: url.pathname });
}

function apiError(res, e) {
  const code = e.code || 'internal';
  const status = {
    doc_not_approved: 409, link_not_unique: 409, link_invalid: 409, out_of_stock: 409,
    price_changed: 409, session_locked: 409, already_removed: 409, already_reviewed: 409,
    self_review_forbidden: 403, not_reviewer: 403, not_author: 403,
    publish_blocked: 422,
  }[code] || (e.code ? 400 : 500);
  json(res, status, { error: code, message: e.message, details: e.details || null });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/photos/')) return servePhoto(res, url.pathname.slice('/photos/'.length));
    return serveStatic(req, res, url);
  } catch (e) {
    return apiError(res, e);
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`直播间排品系统已启动：http://localhost:${PORT}`);
    console.log(`数据文件：${process.env.LRL_DB || path.join(__dirname, '..', 'data', 'live.db')}`);
  });
}

module.exports = { server, db, svc };
