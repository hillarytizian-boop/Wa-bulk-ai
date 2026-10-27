// Background jobs: order polling, retrying uncertain submissions, M-Pesa reconciliation,
// catalog refresh. One timer each; a job never overlaps itself.
const orders = require('./orders');
const mpesa = require('./mpesa');
const catalog = require('./catalog');

const timers = [];

function every(name, ms, fn) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[jobs] ${name} failed:`, err.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, ms);
  timer.unref?.();
  timers.push(timer);
  setTimeout(tick, 3000).unref?.();
  return timer;
}

function start({ log = console.log } = {}) {
  every('orders:poll', 30 * 1000, async () => {
    const n = await orders.pollActive();
    if (n) log(`[jobs] polled ${n} order(s)`);
  });

  every('orders:recover', 60 * 1000, async () => {
    const n = await orders.recoverSubmitting();
    if (n) log(`[jobs] retried ${n} unconfirmed submission(s)`);
  });

  every('mpesa:reconcile', 45 * 1000, async () => {
    const n = await mpesa.reconcilePending();
    if (n) log(`[jobs] reconciled ${n} pending top-up(s)`);
  });

  every('catalog:refresh', 10 * 60 * 1000, async () => {
    await catalog.load(true);
  });

  log('[jobs] background jobs started');
}

function stop() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

module.exports = { start, stop };
