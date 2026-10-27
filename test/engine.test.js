// Money-critical tests: KES pricing (incl. the +KSh 50 fee), ordering, idempotent recovery,
// refunds, status sync and M-Pesa crediting. Runs against test/mock-provider.js: no network,
// no real money. Usage: npm test
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mockProvider = require('./mock-provider');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  FAIL ${name}\n       ${err.stack.split('\n').slice(0, 4).join('\n       ')}`);
  }
}

(async () => {
  const mock = await mockProvider.start(0);
  const dbFile = path.join(os.tmpdir(), `smm-engine-test-${process.pid}.db`);
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });

  Object.assign(process.env, {
    DATABASE_PATH: dbFile,
    SMM_API_URL: `http://127.0.0.1:${mock.port}/api/v3`,
    SMM_API_KEY: mockProvider.API_KEY,
    SMM_RETRY_BASE_MS: '5',
    DEFAULT_MARKUP: '0.3',
    KES_PER_USD: '100',
    FEE_KES: '50',
    MPESA_BASE_URL: `http://127.0.0.1:${mock.port}`,
    MPESA_CONSUMER_KEY: 'ck',
    MPESA_CONSUMER_SECRET: 'cs',
    MPESA_PASSKEY: 'pk',
    JWT_SECRET: 'test-secret',
  });

  const db = require('../src/db');
  const raw = db.raw; // better-sqlite3 handle, used only for test setup/assertions
  await db.initSchema();
  const catalog = require('../src/catalog');
  const pricing = require('../src/pricing');
  const orders = require('../src/orders');
  const mpesa = require('../src/mpesa');
  const { HttpError } = require('../src/errors');
  await pricing.initSettings();

  const now = () => Math.floor(Date.now() / 1000);
  const uid = Number(
    raw.prepare("INSERT INTO users (email, password_hash, created_at) VALUES ('a@b.co','x',?)").run(now()).lastInsertRowid
  );
  const balance = () => raw.prepare('SELECT balance_cents FROM users WHERE id = ?').get(uid).balance_cents;
  /** Give the test user a balance expressed in KES. */
  const setBalanceKes = (k) => raw.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(Math.round(k * 100), uid);
  const row = (id) => raw.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  const forcePoll = (id) => raw.prepare('UPDATE orders SET last_polled_at = 0 WHERE id = ?').run(id);
  const reject = async (p, status) => {
    await assert.rejects(p, (e) => e instanceof HttpError && (status ? e.status === status : true));
  };

  console.log('engine tests (KES)');

  // ---------------------------------------------------------------- pricing
  await test('pricing: KES = rateUSD x (1+markup) x KES/USD + 50', () => {
    const s = pricing.getSettings();
    assert.equal(s.markup, 0.3);
    assert.equal(s.kesPerUsd, 100);
    assert.equal(s.feeCents, 5000);
    // 0.90 USD/1000 -> 0.90 * 1.3 * 100 = 117 KES + 50 = 167 KES
    assert.equal(pricing.rateCentsPer1000(0.9), 16700);
    assert.equal(pricing.sellRateKes(0.9), 167);
    // The fee dominates cheap services: 0.05 USD/1000 -> 6.5 + 50 = 56.5 KES
    assert.equal(pricing.rateCentsPer1000(0.05), 5650);
  });

  await test('pricing: order totals use (rate + fee) x qty / 1000 and are flat for packages', () => {
    assert.equal(pricing.priceCents({ rate: 0.9, type: 'Default' }, 1000), 16700); // KSh 167
    assert.equal(pricing.priceCents({ rate: 0.9, type: 'Default' }, 250), 4175); // KSh 41.75
    assert.equal(pricing.priceCents({ rate: 5, type: 'Package' }, 1), 70000); // 5*1.3*100 = 650 KES + 50 = 700
    assert.equal(pricing.priceCents({ rate: 2, type: 'Custom Comments' }, 3), 93); // 310 * 3/1000
  });

  await test('catalog loads from the provider and never exposes provider rates', async () => {
    const c = await catalog.load();
    assert.equal(c.list.length, 4);
    const svc = await catalog.getService(1);
    assert.equal(svc.rate, 0.9); // internal only
  });

  // ---------------------------------------------------------------- ordering
  await test('rejects an order when the wallet is too low (no order row created)', async () => {
    await reject(orders.placeOrder(uid, { service: 1, link: 'https://instagram.com/x', quantity: 1000 }), 402);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
  });

  await test('validates quantity, link and required fields', async () => {
    setBalanceKes(10000);
    await reject(orders.placeOrder(uid, { service: 1, link: 'https://x.co/a', quantity: 10 }), 400); // below min 50
    await reject(orders.placeOrder(uid, { service: 1, link: 'https://x.co/a', quantity: 99999 }), 400); // above max
    await reject(orders.placeOrder(uid, { service: 1, quantity: 100 }), 400); // no link
    await reject(orders.placeOrder(uid, { service: 1, link: '  ', quantity: 100 }), 400);
    await reject(orders.placeOrder(uid, { service: 999, link: 'https://x.co/a', quantity: 100 }), 404);
    assert.equal(balance(), 1_000_000);
  });

  let mainOrder;
  await test('places an order: charges KES from the wallet, stores provider order id and USD cost', async () => {
    const o = await orders.placeOrder(uid, { service: 1, link: 'https://instagram.com/a', quantity: 1000 });
    mainOrder = o.id;
    assert.equal(o.status, 'queued');
    assert.equal(o.price_cents, 16700); // KSh 167
    assert.equal(o.provider_cost_usd_micros, 900_000); // $0.90
    assert.ok(o.provider_order_id);
    assert.equal(balance(), 1_000_000 - 16700);
  });

  await test('status sync: processing -> completed, no refund', async () => {
    forcePoll(mainOrder);
    await orders.pollActive();
    assert.equal(row(mainOrder).status, 'processing');
    assert.equal(row(mainOrder).remains, 500);
    forcePoll(mainOrder);
    await orders.pollActive();
    assert.equal(row(mainOrder).status, 'completed');
    assert.equal(row(mainOrder).settled, 1);
    assert.equal(balance(), 1_000_000 - 16700);
  });

  await test('refill works once, then is rate limited', async () => {
    const msg = await orders.requestRefill(uid, mainOrder);
    assert.match(msg, /accepted/i);
    await reject(orders.requestRefill(uid, mainOrder), 429);
  });

  await test('provider rejection = automatic full refund', async () => {
    const before = balance();
    await reject(orders.placeOrder(uid, { service: 1, link: 'https://x.co/REJECT', quantity: 100 }), 502);
    assert.equal(balance(), before);
    const failed = raw.prepare("SELECT * FROM orders WHERE status = 'failed'").get();
    assert.equal(failed.refunded_cents, failed.price_cents);
    assert.equal(failed.settled, 1);
  });

  await test('lost response (503 after the provider created it): one order, one charge, no refund', async () => {
    const before = balance();
    const providerBefore = mock.state.orders.length;
    const o = await orders.placeOrder(uid, { service: 1, link: 'https://x.co/FLAKY', quantity: 100 });
    assert.equal(o.status, 'submitting'); // outcome unknown -> pending, never auto-refunded
    assert.equal(balance(), before - 1670); // 100 units at 167 KES/1000 = KSh 16.70
    raw.prepare('UPDATE orders SET updated_at = 0 WHERE id = ?').run(o.id);
    await orders.recoverSubmitting();
    const after = row(o.id);
    assert.equal(after.status, 'queued');
    assert.equal(after.settled, 0);
    assert.equal(mock.state.orders.length, providerBefore + 1); // exactly ONE provider order
    assert.equal(balance(), before - 1670);
  });

  await test('partial order refunds the undelivered share exactly once', async () => {
    const o = await orders.placeOrder(uid, { service: 1, link: 'https://x.co/PARTIAL', quantity: 1000 });
    const afterPurchase = balance();
    forcePoll(o.id);
    await orders.pollActive();
    const r = row(o.id);
    assert.equal(r.status, 'partial');
    // 400 of 1000 undelivered -> refund ceil(16700 * 400 / 1000) = 6680 cents
    assert.equal(r.refunded_cents, 6680);
    assert.equal(balance(), afterPurchase + 6680);
    await orders.syncOrder(o.id); // terminal: must be a no-op
    assert.equal(balance(), afterPurchase + 6680);
  });

  await test('cancel request -> provider cancels -> full refund', async () => {
    const o = await orders.placeOrder(uid, { service: 1, link: 'https://x.co/CANCELME', quantity: 500 });
    const afterPurchase = balance();
    assert.match(await orders.requestCancel(uid, o.id), /accepted/i);
    forcePoll(o.id);
    await orders.pollActive();
    assert.equal(row(o.id).status, 'canceled');
    assert.equal(balance(), afterPurchase + o.price_cents);
  });

  await test('flat package and line-counted custom comments', async () => {
    const before = balance();
    const pkg = await orders.placeOrder(uid, { service: 2, link: 'https://youtube.com/watch?v=1' });
    assert.equal(pkg.price_cents, 70000); // 650 + 50
    const cm = await orders.placeOrder(uid, { service: 3, link: 'https://instagram.com/p/1', comments: 'nice\r\ngreat\n\nlove it' });
    assert.equal(cm.quantity, 3); // blank line ignored; quantity is NOT sent (the mock would 400)
    assert.equal(cm.price_cents, 93);
    assert.equal(balance(), before - 70000 - 93);
  });

  await test('admin markup change applies to new orders and is stored per order', async () => {
    await pricing.setMarkup(0.5);
    const o = await orders.placeOrder(uid, { service: 4, link: 'https://tiktok.com/v/1', quantity: 1000 });
    assert.equal(o.price_cents, 5750); // 0.05 * 1.5 * 100 = 7.5 KES + 50 = 57.5
    assert.equal(o.markup, 0.5);
    await pricing.setMarkup(0.3);
  });

  await test('KES/USD and fee are admin-editable and affect prices', async () => {
    await pricing.setKesPerUsd(120);
    await pricing.setFeeKes(20);
    // 0.90 * 1.3 * 120 = 140.4 + 20 = 160.4 KES per 1000
    assert.equal(pricing.rateCentsPer1000(0.9), 16040);
    await pricing.setKesPerUsd(100);
    await pricing.setFeeKes(50);
    assert.equal(pricing.rateCentsPer1000(0.9), 16700);
  });

  await test('provider "charged" reconciliation re-prices the order and adjusts the wallet', async () => {
    // The mock charges exactly what we quoted, so the price must stay identical (no drift).
    const before = balance();
    const o = await orders.placeOrder(uid, { service: 1, link: 'https://x.co/a', quantity: 1000 });
    assert.equal(o.price_cents, 16700);
    assert.equal(o.refunded_cents, 0);
    assert.equal(balance(), before - 16700);
  });

  // ---------------------------------------------------------------- M-Pesa
  await test('M-Pesa: phone normalization', () => {
    assert.equal(mpesa.normalizePhone('0712 345 678'), '254712345678');
    assert.equal(mpesa.normalizePhone('+254 112345678'), '254112345678');
    assert.equal(mpesa.normalizePhone('254712345678'), '254712345678');
    assert.throws(() => mpesa.normalizePhone('0812345678'), HttpError);
  });

  async function createTopup(amountKes) {
    const { checkoutRequestId } = await mpesa.stkPush({ phone: '254712345678', amountKes, reference: 'W1' });
    const t = now();
    const id = Number(
      raw
        .prepare(
          `INSERT INTO topups (user_id, phone, amount_kes, credited_cents, checkout_request_id, status, created_at, updated_at)
           VALUES (?,?,?,?,?,'pending',?,?)`
        )
        .run(uid, '254712345678', amountKes, amountKes * 100, checkoutRequestId, t, t).lastInsertRowid
    );
    return { id, checkoutRequestId };
  }

  await test('M-Pesa: pending -> paid credits KES exactly once, even when reconciled concurrently', async () => {
    const { id, checkoutRequestId } = await createTopup(500);
    const before = balance();
    assert.equal(await mpesa.reconcileTopup(id), 'pending'); // customer has not entered the PIN yet
    assert.equal(balance(), before);
    mock.state.mpesaResult[checkoutRequestId] = '0';
    const r = await Promise.all([mpesa.reconcileTopup(id, 'QWE123'), mpesa.reconcileTopup(id, 'QWE123')]);
    assert.ok(r.includes('paid'));
    assert.equal(balance(), before + 50000); // KES 500 credited once
    assert.equal(await mpesa.reconcileTopup(id), 'paid');
    assert.equal(balance(), before + 50000);
  });

  await test('M-Pesa: customer cancels the prompt -> topup fails, nothing credited', async () => {
    const { id, checkoutRequestId } = await createTopup(200);
    mock.state.mpesaResult[checkoutRequestId] = '1032';
    const before = balance();
    assert.equal(await mpesa.reconcileTopup(id), 'failed');
    assert.equal(balance(), before);
  });

  // ---------------------------------------------------------------- ledger
  await test('ledger: order/refund/adjustment entries add up to what customers paid', () => {
    const paid = raw.prepare('SELECT COALESCE(SUM(price_cents - refunded_cents),0) AS s FROM orders').get().s;
    const ledger = raw
      .prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE type IN ('order','refund','admin')")
      .get().s;
    assert.equal(-ledger, paid);
  });

  await test('unconfirmed order goes to "needs review" and is never auto-refunded', async () => {
    const config = require('../src/config');
    const goodUrl = config.smm.url;
    const before = balance();
    // Point the client at a closed port: every submission is ambiguous (outcome unknown).
    config.smm.url = 'http://127.0.0.1:1/api/v3';
    try {
      const o = await orders.placeOrder(uid, { service: 1, link: 'https://x.co/UNKNOWN', quantity: 100 });
      assert.equal(o.status, 'submitting');
      assert.equal(balance(), before - 1670); // charged once, still held: no refund for an unknown outcome
      raw.prepare("UPDATE orders SET attempts = 7, updated_at = 0 WHERE id = ?").run(o.id);
      await orders.recoverSubmitting();
      const fresh = row(o.id);
      assert.equal(fresh.status, 'needs_review');
      assert.equal(fresh.refunded_cents, 0); // never auto-refunded
    } finally {
      config.smm.url = goodUrl;
    }
  });

  for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
  mock.server.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
