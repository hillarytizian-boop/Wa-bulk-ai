// Data layer with two drivers behind one async API:
//   * Postgres (Supabase) when DATABASE_URL is set - required in production / on Vercel.
//   * SQLite (better-sqlite3) otherwise - local development and the test suite.
//
// All SQL in the app is written for Postgres ($1, $2 placeholders, "FOR UPDATE"); the SQLite
// adapter rewrites placeholders and drops "FOR UPDATE" (SQLite serialises writers anyway).
//
// Money columns are integer KES cents (BIGINT). Boolean-ish flags are SMALLINT 0/1 so both
// drivers return identical values. Timestamps are integer epoch seconds.
const config = require('./config');

// --------------------------------------------------------------------------- schema
// One source of truth, rendered per dialect (so the two can never drift).
const SCHEMA = [
  {
    name: 'users',
    columns: [
      ['id', 'id'],
      ['email', 'text', { notNull: true, unique: true }],
      ['password_hash', 'text', { notNull: true }],
      ['balance_cents', 'bigint', { notNull: true, default: 0 }],
      ['is_admin', 'flag', { notNull: true, default: 0 }],
      ['token_version', 'int', { notNull: true, default: 0 }],
      ['created_at', 'int', { notNull: true }],
    ],
  },
  {
    name: 'orders',
    columns: [
      ['id', 'id'],
      ['user_id', 'int', { notNull: true, references: 'users(id)' }],
      ['service_id', 'int', { notNull: true }],
      ['service_name', 'text', { notNull: true }],
      ['service_type', 'text', { notNull: true }],
      ['category', 'text', { notNull: true, default: '' }],
      ['link', 'text', { notNull: true, default: '' }],
      ['quantity', 'int'],
      ['details', 'text', { notNull: true, default: '{}' }],
      ['refill_allowed', 'flag', { notNull: true, default: 0 }],
      ['cancel_allowed', 'flag', { notNull: true, default: 0 }],
      ['price_cents', 'bigint', { notNull: true }],
      ['provider_cost_usd_micros', 'bigint'],
      ['markup', 'real', { notNull: true }],
      ['kes_per_usd', 'real', { notNull: true }],
      ['fee_cents', 'bigint', { notNull: true, default: 0 }],
      ['provider_order_id', 'text'],
      ['status', 'text', { notNull: true }],
      ['status_raw', 'text'],
      ['idempotency_key', 'text', { notNull: true, unique: true }],
      ['start_count', 'int'],
      ['remains', 'int'],
      ['error', 'text'],
      ['attempts', 'int', { notNull: true, default: 0 }],
      ['settled', 'flag', { notNull: true, default: 0 }],
      ['refunded_cents', 'bigint', { notNull: true, default: 0 }],
      ['last_polled_at', 'int', { notNull: true, default: 0 }],
      ['last_refill_at', 'int', { notNull: true, default: 0 }],
      ['created_at', 'int', { notNull: true }],
      ['updated_at', 'int', { notNull: true }],
    ],
    indexes: [['idx_orders_user', 'user_id, id DESC'], ['idx_orders_status', 'status'], ['idx_orders_poll', 'status, last_polled_at']],
  },
  {
    name: 'transactions',
    columns: [
      ['id', 'id'],
      ['user_id', 'int', { notNull: true, references: 'users(id)' }],
      ['amount_cents', 'bigint', { notNull: true }],
      ['type', 'text', { notNull: true }],
      ['ref', 'text'],
      ['note', 'text'],
      ['created_at', 'int', { notNull: true }],
    ],
    indexes: [['idx_tx_user', 'user_id, id DESC']],
  },
  {
    name: 'topups',
    columns: [
      ['id', 'id'],
      ['user_id', 'int', { notNull: true, references: 'users(id)' }],
      ['phone', 'text', { notNull: true }],
      ['amount_kes', 'int', { notNull: true }],
      ['credited_cents', 'bigint', { notNull: true }],
      ['checkout_request_id', 'text', { notNull: true, unique: true }],
      ['merchant_request_id', 'text'],
      ['status', 'text', { notNull: true }],
      ['receipt', 'text'],
      ['created_at', 'int', { notNull: true }],
      ['updated_at', 'int', { notNull: true }],
    ],
    indexes: [['idx_topups_status', 'status']],
  },
  {
    name: 'settings',
    columns: [
      ['key', 'text', { notNull: true, primaryKey: true }],
      ['value', 'text', { notNull: true }],
    ],
  },
  {
    name: 'audit_log',
    columns: [
      ['id', 'id'],
      ['actor_id', 'int'],
      ['action', 'text', { notNull: true }],
      ['target', 'text'],
      ['detail', 'text'],
      ['ip', 'text'],
      ['created_at', 'int', { notNull: true }],
    ],
    indexes: [['idx_audit_created', 'id DESC']],
  },
];

const TYPES = {
  postgres: { id: 'BIGSERIAL PRIMARY KEY', bigint: 'BIGINT', int: 'INTEGER', text: 'TEXT', real: 'DOUBLE PRECISION', flag: 'SMALLINT' },
  sqlite: { id: 'INTEGER PRIMARY KEY AUTOINCREMENT', bigint: 'INTEGER', int: 'INTEGER', text: 'TEXT', real: 'REAL', flag: 'INTEGER' },
};

const quoteDefault = (value) => (typeof value === 'number' ? String(value) : `'${String(value).replace(/'/g, "''")}'`);

function renderSchema(dialect) {
  const t = TYPES[dialect];
  const out = [];
  for (const table of SCHEMA) {
    const cols = table.columns.map(([name, type, opts = {}]) => {
      const parts = [name, t[type]];
      if (opts.notNull) parts.push('NOT NULL');
      if (opts.default !== undefined) parts.push(`DEFAULT ${quoteDefault(opts.default)}`);
      if (opts.unique) parts.push('UNIQUE');
      if (opts.primaryKey && type !== 'id') parts.push('PRIMARY KEY');
      if (opts.references) parts.push(`REFERENCES ${opts.references}`);
      return parts.join(' ');
    });
    out.push(`CREATE TABLE IF NOT EXISTS ${table.name} (\n  ${cols.join(',\n  ')}\n);`);
    for (const [idxName, cols2] of table.indexes || []) {
      out.push(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${table.name} (${cols2});`);
    }
  }
  return out.join('\n');
}

// --------------------------------------------------------------------------- drivers
function makeSqlite(config) {
  const fs = require('fs');
  const path = require('path');
  const Database = require('better-sqlite3');

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // `$1` -> `?` and strip Postgres-only row locking. Postgres allows the same placeholder to be
  // used more than once ($5 ... $5), SQLite does not, so the parameter list is re-ordered to match
  // the order the placeholders actually appear in the statement.
  const prepare = (text) => {
    const order = [];
    const sql = String(text)
      .replace(/::\s*\w+/g, '')
      .replace(/\s+FOR\s+UPDATE(\s+OF\s+[\w.]+)?(\s+SKIP\s+LOCKED)?/gi, '')
      .replace(/\$(\d+)/g, (_m, n) => {
        order.push(Number(n) - 1);
        return '?';
      });
    return { sql, order };
  };

  const bind = (params, order) => (order.length ? order.map((i) => params[i]) : params);

  const exec = (text, params = []) => {
    const { sql, order } = prepare(text);
    const args = bind(params, order);
    const stmt = db.prepare(sql);
    const isRead = /^\s*(select|with|pragma)/i.test(sql) || /\breturning\b/i.test(sql);
    if (isRead) {
      const rows = stmt.all(...args);
      return { rows, rowCount: rows.length };
    }
    const info = stmt.run(...args);
    return { rows: [], rowCount: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
  };

  // better-sqlite3 transactions are synchronous, so async callbacks are serialised through a
  // single mutex: only one transaction runs at a time in-process (fine for dev and tests).
  let chain = Promise.resolve();
  const tx = (fn) => {
    const run = async () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn({ query: async (s, p) => exec(s, p), one: async (s, p) => exec(s, p).rows[0] || null, all: async (s, p) => exec(s, p).rows, run: async (s, p) => exec(s, p) });
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw err;
      }
    };
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  };

  return {
    dialect: 'sqlite',
    query: async (text, params = []) => exec(text, params),
    one: async (text, params = []) => exec(text, params).rows[0] || null,
    all: async (text, params = []) => exec(text, params).rows,
    run: async (text, params = []) => exec(text, params),
    tx,
    initSchema: async () => {
      db.exec(renderSchema('sqlite'));
    },
    close: async () => db.close(),
    raw: db,
  };
}

function makePostgres(databaseUrl) {
  const { Pool, types } = require('pg');
  // BIGINT/BIGSERIAL arrive as strings by default; all our bigints are money cents (< 2^53).
  types.setTypeParser(20, (value) => (value == null ? null : Number(value)));
  types.setTypeParser(1700, (value) => (value == null ? null : Number(value))); // NUMERIC

  // Supabase exposes several pooler hosts per region and only one owns this project, so
  // DATABASE_FALLBACK_URLS may list alternatives. The first candidate that answers SELECT 1 wins
  // (resolved once per cold start).
  const candidates = [databaseUrl, ...String(process.env.DATABASE_FALLBACK_URLS || '').split(',')]
    .map((u) => (u || '').trim())
    .filter(Boolean);

  const newPool = (url) => {
    const p = new Pool({
      connectionString: url,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
      // pgbouncer (transaction pooler) does not support named prepared statements
      statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 20000),
    });
    p.on('error', (err) => console.error('[db] idle client error:', err.message));
    return p;
  };

  let pool = null;
  let resolving = null;
  const ensurePool = () => {
    if (pool) return Promise.resolve(pool);
    if (resolving) return resolving;
    resolving = (async () => {
      let lastErr;
      for (const url of candidates) {
        const candidate = newPool(url);
        try {
          const client = await candidate.connect();
          await client.query('SELECT 1');
          client.release();
          pool = candidate;
          console.log(`[db] connected via ${url.replace(/:[^:@/]+@/, ':***@')}`);
          return pool;
        } catch (err) {
          lastErr = err;
          console.warn(`[db] candidate failed (${url.replace(/:[^:@/]+@/, ':***@')}): ${err.message}`);
          await candidate.end().catch(() => {});
        }
      }
      resolving = null;
      throw lastErr || new Error('No DATABASE_URL candidate could connect');
    })();
    return resolving;
  };

  // A tiny wrapper that behaves like a client but resolves the pool first.
  const lazyClient = {
    query: async (text, params = []) => (await ensurePool()).query(text, params),
    connect: async () => (await ensurePool()).connect(),
  };

  const bind = (client) => ({
    query: async (text, params = []) => client.query(text, params),
    one: async (text, params = []) => (await client.query(text, params)).rows[0] || null,
    all: async (text, params = []) => (await client.query(text, params)).rows,
    run: async (text, params = []) => client.query(text, params),
  });

  const tx = async (fn) => {
    const client = await (await ensurePool()).connect();
    try {
      await client.query('BEGIN');
      const result = await fn(bind(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection already broken */
      }
      throw err;
    } finally {
      client.release();
    }
  };

  const api = bind(lazyClient);
  return {
    dialect: 'postgres',
    ...api,
    tx,
    initSchema: async () => {
      await lazyClient.query(renderSchema('postgres'));
    },
    resolve: () => ensurePool(),
    close: async () => {
      if (pool) await pool.end();
    },
  };
}

// --------------------------------------------------------------------------- singleton
let instance = null;

function getDb() {
  if (instance) return instance;
  instance = process.env.DATABASE_URL ? makePostgres(process.env.DATABASE_URL) : makeSqlite(config);
  return instance;
}

// Lazy proxy: requiring this module must not open a connection (serverless cold starts, CLI
// helpers such as scripts/migrate.js and the schema renderer all import it).
const lazy = new Proxy(
  {
    getDb,
    SCHEMA,
    renderSchema,
    get dialect() {
      return getDb().dialect;
    },
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      const value = getDb()[prop];
      return typeof value === 'function' ? value.bind(getDb()) : value;
    },
  }
);

module.exports = lazy;
