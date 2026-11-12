// Shared rate-limit counters.
//
// The old limiter kept its counts in a Map inside one process. On Vercel each lambda instance has
// its own memory, so N instances meant N times the budget - and a deploy reset every counter. These
// counters live in the database (SQLite locally, Postgres in production), so the budget is global.
//
// If the database is unavailable the counter degrades to process memory rather than throwing:
// a limiter outage must never take the panel down. Callers that need to fail closed (login) check
// `degraded` and decide for themselves.
const db = require('./db');

// A deployment can reach a database that predates the rate_limits table (production is migrated by
// hand, not on boot). Create missing tables once, then carry on - a limiter must not fail because
// of a missing index.
let schemaChecked = false;
async function ensureTable() {
  if (schemaChecked) return;
  schemaChecked = true;
  try {
    await db.initSchema();
  } catch (err) {
    console.warn('[throttle] could not ensure rate_limits table:', err.message);
  }
}

const now = () => Math.floor(Date.now() / 1000);
const memory = new Map();

function memBump(key, windowSec, t) {
  const entry = memory.get(key);
  if (!entry || t - entry.start >= windowSec) {
    memory.set(key, { count: 1, start: t });
    return { count: 1, retry_after: 0, degraded: true };
  }
  entry.count += 1;
  return { count: entry.count, retry_after: Math.max(1, windowSec - (t - entry.start)), degraded: true };
}

function sweep(t) {
  if (memory.size < 5000) return;
  for (const [k, v] of memory) if (t - v.start > 3600) memory.delete(k);
}

/** Count one hit against `key` in a `windowSec` window. Returns the new count. */
async function bump(key, windowSec) {
  const t = now();
  sweep(t);
  try {
    const row = await db.one('SELECT count, window_start FROM rate_limits WHERE key = $1', [key]);
    if (!row || t - Number(row.window_start) >= windowSec) {
      await db.run(
        'INSERT INTO rate_limits (key, count, window_start) VALUES ($1, 1, $2) ON CONFLICT (key) DO UPDATE SET count = 1, window_start = $2',
        [key, t]
      );
      // keep the table from growing without bound
      if (Math.random() < 0.02) await db.run('DELETE FROM rate_limits WHERE window_start < $1', [t - 86400]);
      return { count: 1, retry_after: 0, degraded: false };
    }
    const count = Number(row.count) + 1;
    await db.run('UPDATE rate_limits SET count = $1 WHERE key = $2', [count, key]);
    return { count, retry_after: Math.max(1, windowSec - (t - Number(row.window_start))), degraded: false };
  } catch (err) {
    if (/no such table|relation .* does not exist/i.test(String(err.message))) {
      await ensureTable();
      try {
        await db.run('INSERT INTO rate_limits (key, count, window_start) VALUES ($1, 1, $2) ON CONFLICT (key) DO UPDATE SET count = 1, window_start = $2', [key, t]);
        return { count: 1, retry_after: 0, degraded: false };
      } catch { /* fall through to memory */ }
    }
    return memBump(key, windowSec, t);
  }
}

/** Read the current count without counting a hit. */
async function peek(key, windowSec) {
  const t = now();
  try {
    const row = await db.one('SELECT count, window_start FROM rate_limits WHERE key = $1', [key]);
    if (!row || t - Number(row.window_start) >= windowSec) return { count: 0, retry_after: 0, degraded: false };
    return {
      count: Number(row.count),
      retry_after: Math.max(1, windowSec - (t - Number(row.window_start))),
      degraded: false,
    };
  } catch (err) {
    const entry = memory.get(key);
    if (!entry || t - entry.start >= windowSec) return { count: 0, retry_after: 0, degraded: true };
    return { count: entry.count, retry_after: Math.max(1, windowSec - (t - entry.start)), degraded: true };
  }
}

/** Forget a key (called when credentials are correct). */
async function clear(key) {
  memory.delete(key);
  try {
    await db.run('DELETE FROM rate_limits WHERE key = $1', [key]);
  } catch {
    /* best effort */
  }
}

module.exports = { bump, peek, clear };
