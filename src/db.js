const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// All money columns are integer KES cents. provider_cost_usd_micros is integer micro-USD
// (the provider bills in USD; we never mix the two currencies in one column).
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  service_id INTEGER NOT NULL,
  service_name TEXT NOT NULL,
  service_type TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  quantity INTEGER,
  details TEXT NOT NULL DEFAULT '{}',
  refill_allowed INTEGER NOT NULL DEFAULT 0,
  cancel_allowed INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL,
  provider_cost_usd_micros INTEGER,
  markup REAL NOT NULL,
  kes_per_usd REAL NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  provider_order_id TEXT,
  status TEXT NOT NULL,
  status_raw TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  start_count INTEGER,
  remains INTEGER,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  settled INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  last_polled_at INTEGER NOT NULL DEFAULT 0,
  last_refill_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  type TEXT NOT NULL,
  ref TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, id DESC);

CREATE TABLE IF NOT EXISTS topups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  phone TEXT NOT NULL,
  amount_kes INTEGER NOT NULL,
  credited_cents INTEGER NOT NULL,
  checkout_request_id TEXT NOT NULL UNIQUE,
  merchant_request_id TEXT,
  status TEXT NOT NULL,
  receipt TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topups_status ON topups(status);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(id DESC);
`);

// Migrations for databases created by older versions (CREATE TABLE IF NOT EXISTS cannot add columns).
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
if (!hasColumn('users', 'token_version')) {
  db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
}

module.exports = db;
