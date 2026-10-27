const express = require('express');
const db = require('../db');
const smm = require('../smm');
const pricing = require('../pricing');
const orders = require('../orders');
const audit = require('../audit');
const { HttpError, wrap } = require('../errors');
const { toCents, microsToUsd } = require('../money');
const { requireAuth, requireAdmin } = require('./auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const now = () => Math.floor(Date.now() / 1000);
const iso = (t) => new Date(Number(t) * 1000).toISOString();
const costCents = (costMicros, kesPerUsd) => (costMicros == null ? 0 : Math.round(microsToUsd(Number(costMicros)) * kesPerUsd * 100));

router.get(
  '/stats',
  wrap(async (_req, res) => {
    const settings = pricing.getSettings();
    const users = await db.one('SELECT COUNT(*) AS n, COALESCE(SUM(balance_cents),0) AS bal FROM users');
    const o = await db.one(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(price_cents - refunded_cents),0) AS revenue,
              COALESCE(SUM(CASE WHEN provider_cost_usd_micros IS NOT NULL THEN provider_cost_usd_micros ELSE 0 END),0) AS cost_micros
       FROM orders WHERE status != 'failed'`
    );
    const revenueCents = Number(o.revenue);
    const cost = costCents(o.cost_micros, settings.kesPerUsd);
    const pendingTopups = Number((await db.one("SELECT COUNT(*) AS n FROM topups WHERE status = 'pending'")).n);
    const needsReview = Number((await db.one("SELECT COUNT(*) AS n FROM orders WHERE status = 'needs_review'")).n);

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
      users: Number(users.n),
      customer_balances_cents: Number(users.bal),
      orders: Number(o.n),
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
router.post(
  '/settings',
  wrap(async (req, res) => {
    const { markup, kes_per_usd, fee_kes } = req.body || {};
    if (markup !== undefined) {
      const m = Number(markup);
      if (!Number.isFinite(m) || m < 0 || m > 10) throw new HttpError(400, 'Markup must be between 0 and 10 (0.3 = +30%)');
      await pricing.setMarkup(m);
    }
    if (kes_per_usd !== undefined) {
      const r = Number(kes_per_usd);
      if (!Number.isFinite(r) || r <= 0 || r > 10000) throw new HttpError(400, 'KES per USD must be a positive number');
      await pricing.setKesPerUsd(r);
    }
    if (fee_kes !== undefined) {
      const f = Number(fee_kes);
      if (!Number.isFinite(f) || f < 0 || f > 100000) throw new HttpError(400, 'Fee must be between 0 and 100000 KES');
      await pricing.setFeeKes(f);
    }
    const s = pricing.getSettings();
    audit.record(req, 'pricing.update', { detail: `markup=${s.markup} kes_per_usd=${s.kesPerUsd} fee_kes=${s.feeKes}` });
    res.json({ settings: { markup: s.markup, kes_per_usd: s.kesPerUsd, fee_kes: s.feeKes } });
  })
);

router.get(
  '/users',
  wrap(async (_req, res) => {
    const rows = await db.all('SELECT id, email, is_admin, balance_cents, created_at FROM users ORDER BY id DESC LIMIT 200');
    res.json({
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        is_admin: Boolean(Number(u.is_admin)),
        balance_cents: Number(u.balance_cents),
        created_at: iso(u.created_at),
      })),
    });
  })
);

// Manual wallet adjustment (positive credit or negative correction), in KES.
router.post(
  '/users/:id/credit',
  wrap(async (req, res) => {
    const amountKes = Number(req.body && req.body.amount_kes);
    if (!Number.isFinite(amountKes) || amountKes === 0 || Math.abs(amountKes) > 1000000) {
      throw new HttpError(400, 'Enter a non-zero KES amount');
    }
    const note = String((req.body && req.body.note) || 'Admin adjustment').slice(0, 120);
    const cents = toCents(amountKes);
    const id = Number(req.params.id);

    await db.tx(async (t) => {
      const u = await t.one('SELECT balance_cents FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (!u) throw new HttpError(404, 'User not found');
      if (Number(u.balance_cents) + cents < 0) throw new HttpError(400, 'That would make the balance negative');
      await t.run('UPDATE users SET balance_cents = balance_cents + $1 WHERE id = $2', [cents, id]);
      await t.run('INSERT INTO transactions (user_id, amount_cents, type, ref, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [
        id,
        cents,
        'admin',
        null,
        note,
        now(),
      ]);
    });

    const u = await db.one('SELECT balance_cents FROM users WHERE id = $1', [id]);
    audit.record(req, 'wallet.adjust', { target: `user:${id}`, detail: `${amountKes} KES - ${note}` });
    res.json({ balance_cents: Number(u.balance_cents) });
  })
);

router.get(
  '/orders',
  wrap(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const rows = status
      ? await db.all(
          'SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = $1 ORDER BY o.id DESC LIMIT 100',
          [status]
        )
      : await db.all('SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 100');
    const settings = pricing.getSettings();
    res.json({
      orders: rows.map((o) => ({
        id: o.id,
        email: o.email,
        service_name: o.service_name,
        link: o.link,
        quantity: o.quantity,
        status: o.status,
        price_cents: Number(o.price_cents),
        refunded_cents: Number(o.refunded_cents),
        provider_cost_cents: costCents(o.provider_cost_usd_micros, o.kes_per_usd || settings.kesPerUsd),
        provider_order_id: o.provider_order_id,
        attempts: o.attempts,
        error: o.error,
        created_at: iso(o.created_at),
      })),
    });
  })
);

// Retry an unconfirmed order. Safe: it reuses the same idempotency key.
router.post(
  '/orders/:id/retry',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const o = await orders.getOrder(id);
    if (!o || !['needs_review', 'submitting'].includes(o.status)) throw new HttpError(400, 'Order is not awaiting review');
    await db.run("UPDATE orders SET status = 'submitting', attempts = 0, updated_at = 0 WHERE id = $1", [id]);
    const result = await orders.submitOrder(id);
    const fresh = await orders.getOrder(id);
    audit.record(req, 'order.retry', { target: `order:${id}`, detail: fresh.status });
    res.json({ status: fresh.status, error: result.failed ? result.message : fresh.error || null });
  })
);

// Refund an order an admin has verified was NOT created at the provider.
router.post(
  '/orders/:id/refund',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const o = await orders.getOrder(id);
    if (!o || !['needs_review', 'submitting'].includes(o.status)) {
      throw new HttpError(400, 'Only unconfirmed orders can be refunded here');
    }
    await orders.failOrder(id, 'Refunded by admin');
    audit.record(req, 'order.refund', { target: `order:${id}`, detail: `price_cents=${o.price_cents}` });
    res.json({ ok: true, order: orders.present(await orders.getOrder(id)) });
  })
);

// Read-only audit trail of privileged actions.
router.get(
  '/audit',
  wrap(async (_req, res) => {
    const entries = await audit.recent(100);
    res.json({ entries: entries.map((e) => ({ ...e, created_at: iso(e.created_at) })) });
  })
);

module.exports = router;
