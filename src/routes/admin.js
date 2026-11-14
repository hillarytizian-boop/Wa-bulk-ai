const express = require('express');
const db = require('../db');
const smm = require('../smm');
const pricing = require('../pricing');
const orders = require('../orders');
const audit = require('../audit');
const mpesa = require('../mpesa');
const config = require('../config');
const { HttpError, wrap } = require('../errors');
const { microsToUsd } = require('../money');
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
    // Funnel counters for the last week: where visitors stop between opening the shop and paying.
    let funnel = null;
    try {
      funnel = (await require('./events').summary(7)).totals;
    } catch (err) {
      funnel = { error: err.message };
    }

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
      funnel,
      pending_topups: pendingTopups,
      settings: {
        markup: settings.markup,
        margin_pct: settings.marginPct,
        kes_per_usd: settings.kesPerUsd,
        fee_kes: settings.feeKes,
      },
      provider_balance: provider,
    });
  })
);

// Markup, KES/USD rate and the fixed fee are all admin-editable.
router.post(
  '/settings',
  wrap(async (req, res) => {
    const { markup, kes_per_usd, fee_kes, margin_pct } = req.body || {};
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
    if (margin_pct !== undefined) {
      const p = Number(margin_pct);
      if (!Number.isFinite(p) || p < 0 || p > 1) throw new HttpError(400, 'Margin must be between 0 and 1 (0.2 = 20%)');
      await pricing.setMarginPct(p);
    }
    const s = pricing.getSettings();
    audit.record(req, 'pricing.update', {
      detail: `markup=${s.markup} margin_pct=${s.marginPct} kes_per_usd=${s.kesPerUsd} fee_kes=${s.feeKes}`,
    });
    res.json({
      settings: { markup: s.markup, margin_pct: s.marginPct, kes_per_usd: s.kesPerUsd, fee_kes: s.feeKes },
    });
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

// Where PayHero posts payment updates. The path carries a secret segment derived from
// JWT_SECRET, so it must never ship in the customer bundle - only an authenticated admin can read
// it, and reading it is written to the audit log. PayHero also receives this URL inside every STK
// push request, so nothing here is required for payments to work: it exists so the number can be
// pasted into the PayHero dashboard if that is ever asked for.
router.get(
  '/payhero',
  wrap(async (req, res) => {
    audit.record(req, 'payhero.callback_view', { detail: 'callback url viewed' });
    res.set('Cache-Control', 'no-store');
    res.json({
      enabled: mpesa.enabled,
      callback_url: mpesa.callbackUrl(),
      callback_path: mpesa.callbackPath(),
      channel_id: config.payhero.channelId || null,
      account_id: config.payhero.accountId || null,
      note: 'Give this exact URL to PayHero. It answers 200 to every POST and only credits the wallet after re-checking the payment with PayHero.',
    });
  })
);

// Live check of the PayHero connection: which credential path is loaded and what PayHero answers.
// Lengths and status codes only - no secret ever leaves the server.
router.get(
  '/payhero/diagnose',
  wrap(async (req, res) => {
    audit.record(req, 'payhero.diagnose', { detail: 'connection probe' });
    let probe;
    try {
      probe = await mpesa.probe();
    } catch (err) {
      probe = { ok: false, error: err.message }; // network/timeout, not an auth verdict
    }
    res.set('Cache-Control', 'no-store');
    res.json({ config: mpesa.diagnose(), probe });
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
