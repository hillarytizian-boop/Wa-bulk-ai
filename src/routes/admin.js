const express = require('express');
const db = require('../db');
const smm = require('../smm');
const pricing = require('../pricing');
const orders = require('../orders');
const { HttpError, wrap } = require('../errors');
const { toCents, microsToUsd } = require('../money');
const { requireAuth, requireAdmin } = require('./auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const now = () => Math.floor(Date.now() / 1000);
const iso = (t) => new Date(t * 1000).toISOString();
const costCents = (costMicros, kesPerUsd) => (costMicros == null ? 0 : Math.round(microsToUsd(costMicros) * kesPerUsd * 100));

router.get(
  '/stats',
  wrap(async (_req, res) => {
    const settings = pricing.getSettings();
    const users = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(balance_cents),0) AS bal FROM users').get();
    const o = db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(price_cents - refunded_cents),0) AS revenue,
                COALESCE(SUM(CASE WHEN provider_cost_usd_micros IS NOT NULL THEN provider_cost_usd_micros ELSE 0 END),0) AS cost_micros
         FROM orders WHERE status != 'failed'`
      )
      .get();
    const revenueCents = o.revenue;
    const cost = costCents(o.cost_micros, settings.kesPerUsd);
    const pendingTopups = db.prepare("SELECT COUNT(*) AS n FROM topups WHERE status = 'pending'").get().n;
    const needsReview = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'needs_review'").get().n;

    let provider = null;
    try {
      const b = await smm.balance();
      const usd = Number(b && (b.balance != null ? b.balance : b.USD));
      provider = {
        balance_usd: Number.isFinite(usd) ? usd : null,
        balance_cents: Number.isFinite(usd) ? Math.round(usd * settings.kesPerUsd * 100) : null,
        currency: (b && b.currency) || 'USD',
      };
    } catch (err) {
      provider = { error: err.message };
    }

    res.json({
      users: users.n,
      customer_balances_cents: users.bal,
      orders: o.n,
      revenue_cents: revenueCents,
      provider_cost_cents: cost,
      profit_cents: revenueCents - cost,
      needs_review: needsReview,
      pending_topups: pendingTopups,
      settings: { markup: settings.markup, kes_per_usd: settings.kesPerUsd, fee_kes: settings.feeKes },
      provider_balance: provider,
    });
  })
);

// Markup, KES/USD rate and the fixed fee are all admin-editable.
router.post('/settings', (req, res) => {
  const { markup, kes_per_usd, fee_kes } = req.body || {};
  if (markup !== undefined) {
    const m = Number(markup);
    if (!Number.isFinite(m) || m < 0 || m > 10) throw new HttpError(400, 'Markup must be between 0 and 10 (0.3 = +30%)');
    pricing.setMarkup(m);
  }
  if (kes_per_usd !== undefined) {
    const r = Number(kes_per_usd);
    if (!Number.isFinite(r) || r <= 0 || r > 10000) throw new HttpError(400, 'KES per USD must be a positive number');
    pricing.setKesPerUsd(r);
  }
  if (fee_kes !== undefined) {
    const f = Number(fee_kes);
    if (!Number.isFinite(f) || f < 0 || f > 100000) throw new HttpError(400, 'Fee must be between 0 and 100000 KES');
    pricing.setFeeKes(f);
  }
  const s = pricing.getSettings();
  res.json({ settings: { markup: s.markup, kes_per_usd: s.kesPerUsd, fee_kes: s.feeKes } });
});

router.get('/users', (_req, res) => {
  const rows = db.prepare('SELECT id, email, is_admin, balance_cents, created_at FROM users ORDER BY id DESC LIMIT 200').all();
  res.json({
    users: rows.map((u) => ({
      id: u.id,
      email: u.email,
      is_admin: Boolean(u.is_admin),
      balance_cents: u.balance_cents,
      created_at: iso(u.created_at),
    })),
  });
});

// Manual wallet adjustment (positive credit or negative correction), in KES.
router.post('/users/:id/credit', (req, res) => {
  const amountKes = Number(req.body && req.body.amount_kes);
  if (!Number.isFinite(amountKes) || amountKes === 0 || Math.abs(amountKes) > 1000000) {
    throw new HttpError(400, 'Enter a non-zero KES amount');
  }
  const note = String((req.body && req.body.note) || 'Admin adjustment').slice(0, 120);
  const cents = toCents(amountKes);
  const id = Number(req.params.id);
  db.transaction(() => {
    const u = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(id);
    if (!u) throw new HttpError(404, 'User not found');
    if (u.balance_cents + cents < 0) throw new HttpError(400, 'That would make the balance negative');
    db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?').run(cents, id);
    db.prepare('INSERT INTO transactions (user_id, amount_cents, type, ref, note, created_at) VALUES (?,?,?,?,?,?)').run(
      id,
      cents,
      'admin',
      null,
      note,
      now()
    );
  })();
  const u = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(id);
  res.json({ balance_cents: u.balance_cents });
});

router.get('/orders', (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const rows = status
    ? db.prepare('SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = ? ORDER BY o.id DESC LIMIT 100').all(status)
    : db.prepare('SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 100').all();
  const settings = pricing.getSettings();
  res.json({
    orders: rows.map((o) => ({
      id: o.id,
      email: o.email,
      service_name: o.service_name,
      link: o.link,
      quantity: o.quantity,
      status: o.status,
      price_cents: o.price_cents,
      refunded_cents: o.refunded_cents,
      provider_cost_cents: costCents(o.provider_cost_usd_micros, o.kes_per_usd || settings.kesPerUsd),
      provider_order_id: o.provider_order_id,
      attempts: o.attempts,
      error: o.error,
      created_at: iso(o.created_at),
    })),
  });
});

// Retry an unconfirmed order. Safe: it reuses the same idempotency key.
router.post(
  '/orders/:id/retry',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const o = orders.getOrder(id);
    if (!o || !['needs_review', 'submitting'].includes(o.status)) throw new HttpError(400, 'Order is not awaiting review');
    db.prepare("UPDATE orders SET status = 'submitting', attempts = 0, updated_at = 0 WHERE id = ?").run(id);
    const result = await orders.submitOrder(id);
    const fresh = orders.getOrder(id);
    res.json({ status: fresh.status, error: result.failed ? result.message : fresh.error || null });
  })
);

// Refund an order an admin has verified was NOT created at the provider.
router.post('/orders/:id/refund', (req, res) => {
  const id = Number(req.params.id);
  const o = orders.getOrder(id);
  if (!o || !['needs_review', 'submitting'].includes(o.status)) throw new HttpError(400, 'Only unconfirmed orders can be refunded here');
  orders.failOrder(id, 'Refunded by admin');
  res.json({ ok: true, order: orders.present(orders.getOrder(id)) });
});

module.exports = router;
