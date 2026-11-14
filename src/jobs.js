// Background maintenance.
//
// Two run modes:
//   * `start()`  - long-running hosts (Docker, VPS): timers inside the process.
//   * `tick()`   - serverless (Vercel): called by the cron endpoint and by customer requests, so
//                  the same work happens without a resident process.
const orders = require('./orders');
const mpesa = require('./mpesa');
const catalog = require('./catalog');
const smm = require('./smm');
const db = require('./db');
const mailer = require('./mailer');

const timers = [];
let running = false;

// ---------------------------------------------------------------- provider balance watch
//
// The panel spends its own money at the supplier, so a flat supplier balance means every order
// fails at the vendor while the customer still has a balance. This checks the supplier balance and
// emails the owner before that happens: once when it drops under the threshold, then at most once
// per ALERT_REPEAT_SEC so a forgotten alert does not become spam.
const BALANCE_THRESHOLD_USD = Number(process.env.ALERT_BALANCE_USD || 5);
const ALERT_REPEAT_SEC = 12 * 3600;
const BALANCE_CHECK_SEC = 30 * 60;

async function settingNumber(key) {
  const row = await db.one('SELECT value FROM settings WHERE key = $1', [key]);
  const n = Number(row && row.value);
  return Number.isFinite(n) ? n : 0;
}

async function writeSettingNumber(key, value) {
  await db.run('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [
    key,
    String(value),
  ]);
}

/** @returns {Promise<{checked:boolean, balance_usd?:number, alerted?:boolean}>} */
async function providerBalanceWatch() {
  const now = Math.floor(Date.now() / 1000);
  const lastCheck = await settingNumber('provider_checked_at');
  if (now - lastCheck < BALANCE_CHECK_SEC) return { checked: false };

  let balance;
  try {
    const b = await smm.balance();
    balance = Number(b && (b.balance != null ? b.balance : b.USD));
  } catch (err) {
    console.warn('[jobs] provider balance check failed:', err.message);
    await writeSettingNumber('provider_checked_at', now); // do not hammer the API on failure
    return { checked: true, alerted: false };
  }
  await writeSettingNumber('provider_checked_at', now);
  if (!Number.isFinite(balance)) return { checked: true };

  const lastAlert = await settingNumber('provider_alert_at');
  if (balance < BALANCE_THRESHOLD_USD && now - lastAlert >= ALERT_REPEAT_SEC) {
    await writeSettingNumber('provider_alert_at', now);
    await mailer.adminAlert(`Supplier balance is down to $${balance.toFixed(2)}`, [
      `Orders will start failing at the supplier once the balance runs out.`,
      `Top up the supplier account now. Current balance: <b>$${balance.toFixed(2)}</b> (threshold $${BALANCE_THRESHOLD_USD}).`,
    ]);
    return { checked: true, balance_usd: balance, alerted: true };
  }
  return { checked: true, balance_usd: balance, alerted: false };
}

/** Run every maintenance task once. Safe to call concurrently (guarded). */
async function tick({ log = () => {} } = {}) {
  if (running) return { skipped: true };
  running = true;
  const out = { polled: 0, recovered: 0, mpessa: 0, provider: null };
  try {
    out.recovered = await orders.recoverSubmitting();
    out.polled = await orders.pollActive();
    out.mpesa = await mpesa.reconcilePending();
    out.provider = await providerBalanceWatch();
    if (out.recovered) log(`[jobs] retried ${out.recovered} unconfirmed submission(s)`);
    if (out.polled) log(`[jobs] polled ${out.polled} order(s)`);
    if (out.mpesa) log(`[jobs] reconciled ${out.mpesa} pending top-up(s)`);
    if (out.provider && out.provider.alerted) log('[jobs] supplier balance alert sent');
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
  every('provider:balance', BALANCE_CHECK_SEC * 1000, () => providerBalanceWatch());
  log('[jobs] background jobs started');
}

function stop() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

module.exports = { start, stop, tick, providerBalanceWatch };
