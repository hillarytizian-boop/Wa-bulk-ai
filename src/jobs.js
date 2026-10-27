// Background maintenance.
//
// Two run modes:
//   * `start()`  - long-running hosts (Docker, VPS): timers inside the process.
//   * `tick()`   - serverless (Vercel): called by the cron endpoint and by customer requests, so
//                  the same work happens without a resident process.
const orders = require('./orders');
const mpesa = require('./mpesa');
const catalog = require('./catalog');

const timers = [];
let running = false;

/** Run every maintenance task once. Safe to call concurrently (guarded). */
async function tick({ log = () => {} } = {}) {
  if (running) return { skipped: true };
  running = true;
  const out = { polled: 0, recovered: 0, mpessa: 0 };
  try {
    out.recovered = await orders.recoverSubmitting();
    out.polled = await orders.pollActive();
    out.mpesa = await mpesa.reconcilePending();
    if (out.recovered) log(`[jobs] retried ${out.recovered} unconfirmed submission(s)`);
    if (out.polled) log(`[jobs] polled ${out.polled} order(s)`);
    if (out.mpesa) log(`[jobs] reconciled ${out.mpesa} pending top-up(s)`);
  } finally {
    running = false;
  }
  return out;
}

function every(name, ms, fn) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[jobs] ${name} failed:`, err.message);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(run, ms);
  timer.unref?.();
  timers.push(timer);
  setTimeout(run, 3000).unref?.();
  return timer;
}

/** Long-running mode: periodic timers (do not use on serverless). */
function start({ log = console.log } = {}) {
  every('orders:poll', 30 * 1000, () => orders.pollActive().then((n) => n && log(`[jobs] polled ${n} order(s)`)));
  every('orders:recover', 60 * 1000, () => orders.recoverSubmitting().then((n) => n && log(`[jobs] retried ${n} unconfirmed submission(s)`)));
  every('mpesa:reconcile', 45 * 1000, () => mpesa.reconcilePending().then((n) => n && log(`[jobs] reconciled ${n} pending top-up(s)`)));
  every('catalog:refresh', 10 * 60 * 1000, () => catalog.load(true));
  log('[jobs] background jobs started');
}

function stop() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

module.exports = { start, stop, tick };
