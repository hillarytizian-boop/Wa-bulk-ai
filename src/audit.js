// Audit trail for privileged actions. Runs in two modes:
//   * Vercel / serverless: `db` is async, so use `record()` with await (fire and forget) and
//     `recent()` with await.
//   * Local SQLite tests: same async API.
const db = require('./db');

const now = () => Math.floor(Date.now() / 1000);

/** In-process tail so the admin UI shows something immediately even if the write is queued. */
const ring = [];
const RING = 200;

async function record(req, action, { target = null, detail = null } = {}) {
  const entry = {
    actor_id: req && req.user ? req.user.id : null,
    action: String(action).slice(0, 80),
    target: target == null ? null : String(target).slice(0, 80),
    detail: detail == null ? null : String(detail).slice(0, 300),
    ip: req ? String(req.ip || '').slice(0, 60) : null,
    created_at: now(),
  };
  ring.unshift(entry);
  if (ring.length > RING) ring.pop();
  try {
    await db.run('INSERT INTO audit_log (actor_id, action, target, detail, ip, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [
      entry.actor_id,
      entry.action,
      entry.target,
      entry.detail,
      entry.ip,
      entry.created_at,
    ]);
  } catch (err) {
    console.error('[audit] failed to record:', err.message);
  }
  return entry;
}

async function recent(limit = 100) {
  const rows = await db.all(
    'SELECT id, actor_id, action, target, detail, ip, created_at FROM audit_log ORDER BY id DESC LIMIT $1',
    [limit]
  );
  const seen = new Set(rows.map((r) => `${r.action}|${r.target}|${r.created_at}|${r.detail}`));
  const pending = ring.filter((r) => !seen.has(`${r.action}|${r.target}|${r.created_at}|${r.detail}`));
  return [...pending, ...rows];
}

module.exports = { record, recent };
