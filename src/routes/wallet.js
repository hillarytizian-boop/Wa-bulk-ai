const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const mpesa = require('../mpesa');
const { HttpError, wrap } = require('../errors');
const { requireAuth } = require('./auth');

const router = express.Router();
const now = () => Math.floor(Date.now() / 1000);
const iso = (t) => new Date(t * 1000).toISOString();

const topupLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many top-up attempts. Please wait a few minutes.' },
});

router.get('/', requireAuth, (req, res) => {
  const bal = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(req.user.id);
  const transactions = db
    .prepare('SELECT id, amount_cents, type, note, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50')
    .all(req.user.id)
    .map((t) => ({ ...t, created_at: iso(t.created_at) }));
  const topups = db
    .prepare('SELECT id, amount_kes, credited_cents, status, receipt, created_at FROM topups WHERE user_id = ? ORDER BY id DESC LIMIT 10')
    .all(req.user.id)
    .map((t) => ({ ...t, created_at: iso(t.created_at) }));
  res.json({ balance_cents: bal.balance_cents, transactions, topups });
});

router.post(
  '/topup',
  requireAuth,
  topupLimiter,
  wrap(async (req, res) => {
    if (!mpesa.enabled) throw new HttpError(503, 'M-Pesa top-ups are not enabled. Please contact support.');

    const phone = mpesa.normalizePhone(req.body && req.body.phone);
    const amountKes = Number(req.body && req.body.amount_kes);
    if (!Number.isInteger(amountKes) || amountKes < config.minTopupKes || amountKes > config.maxTopupKes) {
      throw new HttpError(400, `Amount must be a whole number between KES ${config.minTopupKes} and KES ${config.maxTopupKes}`);
    }
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM topups WHERE user_id = ? AND status = 'pending' AND created_at > ?")
      .get(req.user.id, now() - 600);
    if (pending.n >= 3) throw new HttpError(429, 'You already have pending payments. Wait for them to complete.');

    const { checkoutRequestId, merchantRequestId } = await mpesa.stkPush({
      phone,
      amountKes,
      reference: `W${req.user.id}`,
    });

    const t = now();
    const r = db
      .prepare(
        `INSERT INTO topups (user_id, phone, amount_kes, credited_cents, checkout_request_id, merchant_request_id, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(req.user.id, phone, amountKes, amountKes * 100, checkoutRequestId, merchantRequestId || null, 'pending', t, t);

    res.status(201).json({ topup_id: Number(r.lastInsertRowid), message: 'Check your phone and enter your M-Pesa PIN.' });
  })
);

// Daraja posts the result here. The secret path segment keeps strangers out, and every payment is
// still confirmed with Daraja's STK query API before the wallet is credited (exactly once).
router.post('/mpesa/callback/:secret', (req, res) => {
  // Always answer 200 so Daraja stops retrying, but only act on a constant-time secret match.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  const given = Buffer.from(String(req.params.secret || ''));
  const expected = Buffer.from(mpesa.callbackSecret());
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    console.warn('[mpesa] callback rejected: bad secret');
    return;
  }
  const cb = req.body && req.body.Body && req.body.Body.stkCallback;
  if (!cb || !cb.CheckoutRequestID) return;
  const t = db.prepare('SELECT id FROM topups WHERE checkout_request_id = ?').get(String(cb.CheckoutRequestID));
  if (!t) return;
  mpesa
    .reconcileTopup(t.id, mpesa.receiptFromCallback(cb))
    .catch((err) => console.warn('[mpesa] callback reconcile failed:', err.message));
});

// Lets the wallet page show a top-up as paid without waiting for the poller.
router.get(
  '/topup/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = db.prepare('SELECT * FROM topups WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!t) throw new HttpError(404, 'Top-up not found');
    if (t.status === 'pending') await mpesa.reconcileTopup(id);
    const fresh = db.prepare('SELECT id, amount_kes, credited_cents, status, receipt FROM topups WHERE id = ?').get(id);
    res.json({ topup: fresh });
  })
);

module.exports = router;
