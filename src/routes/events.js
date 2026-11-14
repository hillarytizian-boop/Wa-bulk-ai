// First-party funnel counting.
//
// The panel has no third-party analytics and the CSP would block one anyway, so the few numbers
// that matter (does anyone reach sign-up? does an order ever get placed?) are counted here as
// aggregate counters: one row per event name per UTC day, no identifier, no IP, no cookie.
const express = require('express');
const db = require('../db');
const throttle = require('../throttle');
const { HttpError, wrap } = require('../errors');

const router = express.Router();

/** Only these names are counted. Anything else is rejected so the table cannot be used as storage. */
const EVENTS = new Set([
  'home_view',
  'login_view',
  'register_view',
  'login_success',
  'register_success',
  'reset_requested',
  'order_form_view',
  'order_placed',
  'topup_started',
  'topup_paid',
  'shortfall_pay',
]);

const PER_IP_PER_HOUR = 300;

router.post(
  '/events',
  wrap(async (req, res) => {
    const name = String((req.body && req.body.name) || '');
    if (!EVENTS.has(name)) throw new HttpError(400, 'Unknown event');

    const bump = await throttle.bump(`events|${req.ip}`, 3600);
    if (bump.count > PER_IP_PER_HOUR) throw new HttpError(429, 'Too many events');

    const now = Math.floor(Date.now() / 1000);
    const day = now - (now % 86400);
    await db.run(
      `INSERT INTO events (key, name, day, count, updated_at) VALUES ($1,$2,$3,1,$4)
       ON CONFLICT (key) DO UPDATE SET count = events.count + 1, updated_at = excluded.updated_at`,
      [`${name}|${day}`, name, day, now]
    );
    res.status(204).end();
  })
);

/** Totals for the last `days` days, newest first. Used by the admin dashboard. */
async function summary(days = 7) {
  const now = Math.floor(Date.now() / 1000);
  const day = now - (now % 86400);
  const from = day - (days - 1) * 86400;
  const rows = await db.all(
    'SELECT name, day, count FROM events WHERE day >= $1 ORDER BY day DESC, name ASC',
    [from]
  );
  const totals = {};
  for (const row of rows) totals[row.name] = (totals[row.name] || 0) + Number(row.count);
  return { days, totals };
}

module.exports = { router, summary, EVENTS };
