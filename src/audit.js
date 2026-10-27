// Append-only audit trail for privileged actions (wallet adjustments, refunds, pricing changes).
const db = require('./db');

const now = () => Math.floor(Date.now() / 1000);

function record(req, action, { target = null, detail = null } = {}) {
  try {
    db.prepare('INSERT INTO audit_log (actor_id, action, target, detail, ip, created_at) VALUES (?,?,?,?,?,?)').run(
      req && req.user ? req.user.id : null,
      String(action).slice(0, 80),
      target == null ? null : String(target).slice(0, 80),
      detail == null ? null : String(detail).slice(0, 300),
      req ? String(req.ip || '').slice(0, 60) : null,
      now()
    );
  } catch (err) {
    console.error('[audit] failed to record:', err.message);
  }
}

const recent = (limit = 100) =>
  db.prepare('SELECT id, actor_id, action, target, detail, ip, created_at FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);

module.exports = { record, recent };
