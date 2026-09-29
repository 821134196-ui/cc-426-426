'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.LRL_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.LRL_DB || path.join(DATA_DIR, 'live.db');
const PHOTO_DIR = process.env.LRL_PHOTO_DIR || path.join(DATA_DIR, 'photos');

function openDb(dbPath = DB_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('host','reviewer','operator'))
  );

  -- 商品/主播/价格来自进程内演示适配器，这里只缓存审核资料
  CREATE TABLE IF NOT EXISTS products (
    sku TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image TEXT,
    category TEXT,
    banned_words TEXT,              -- 脚本中不允许出现的词（逗号分隔）
    doc_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(doc_status IN ('pending','approved','rejected')),
    doc_submitted_at TEXT,
    doc_reviewed_at TEXT,
    doc_reviewer_id TEXT,
    doc_note TEXT
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    title TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','published','live','ended')),
    published_snapshot TEXT,        -- 发布时整场快照 JSON
    published_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS slots (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    sku TEXT NOT NULL,
    talk_minutes INTEGER NOT NULL CHECK(talk_minutes > 0),
    stock_alert INTEGER NOT NULL CHECK(stock_alert >= 0),
    promo_version TEXT NOT NULL,
    price_cents INTEGER NOT NULL,        -- 排品时优惠价快照
    link_id TEXT,                  -- 关联挂链
    status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK(status IN ('scheduled','removed')),
    removed_reason TEXT,
    removed_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scripts (
    id TEXT PRIMARY KEY,
    slot_id TEXT NOT NULL UNIQUE REFERENCES slots(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL,
    draft TEXT NOT NULL DEFAULT '',
    draft_version INTEGER NOT NULL DEFAULT 0,
    published_version INTEGER,       -- 已发布版本号；null=从未发布
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS script_versions (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    change_note TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(script_id, version)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,        -- 审核的是哪个版本
    reviewer_id TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK(verdict IN ('approved','rejected')),
    comment TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(script_id, version, reviewer_id)
  );

  CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    sku TEXT NOT NULL,
    url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','invalid','unlinked')),
    created_at TEXT NOT NULL,
    UNIQUE(sku, url)
  );

  -- 已成交订单快照，回调不得改写
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    slot_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'placed'
        CHECK(status IN ('placed','cancelled','refunded')),
    created_at TEXT NOT NULL
  );

  -- 幂等回调账本：重复回调只登记一次，且不得影响订单
  CREATE TABLE IF NOT EXISTS callbacks (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    sku TEXT NOT NULL,
    action TEXT,                    -- 首次处理得到的动作
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL,
    duplicate_of TEXT
  );

  CREATE TABLE IF NOT EXISTS samples (
    id TEXT PRIMARY KEY,
    sku TEXT NOT NULL,
    slot_id TEXT,
    received_at TEXT NOT NULL,
    matches INTEGER NOT NULL CHECK(matches IN (0,1)),
    discrepancy TEXT,
    photo_path TEXT,
    registered_by TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    kind TEXT NOT NULL,             -- publish / pull / callback
    summary TEXT NOT NULL,
    detail TEXT NOT NULL,           -- JSON
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_slots_session ON slots(session_id, position);
  -- 位置唯一仅对在场排品生效，已撤品保留原位置不占位
  CREATE UNIQUE INDEX IF NOT EXISTS uq_slots_live_position
    ON slots(session_id, position) WHERE status = 'scheduled';
  CREATE INDEX IF NOT EXISTS idx_versions_script ON script_versions(script_id, version);
  CREATE INDEX IF NOT EXISTS idx_reviews_script ON reviews(script_id, version);
  `);
}

module.exports = { openDb, DATA_DIR, DB_PATH, PHOTO_DIR };
