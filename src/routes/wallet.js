const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const mpesa = require('../mpesa');
const { HttpError, wrap } = require('../errors');
const { requireAuth } = require('./auth');
const payguard = require('../payguard');

const router = express.Router();
const now = () => Math.floor(Date.now() / 1000);
const iso = (t) => new Date(t * 1000).toISOString();

// Keyed by account, not by IP: the thing being protected is one person's phone, and a shared office
// or Safaricom NAT should not spend a neighbour's allowance. requireAuth runs first, so req.user is set.
const topupLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `u${req.user.id}` : String(req.ip || 'ip')),
  message: { error: 'Too many top-up attempts. Please wait a few minutes.' },
});

// An M-Pesa prompt is a real SMS to a real phone. Two hard caps on top of the soft limiter above,
// because the abuse case here is not "too many requests" but "somebody's phone gets buzzed".
const PROMPTS_PER_HOUR = Number(process.env.PROMPTS_PER_HOUR || 5);
const PROMPTS_PER_DAY = Number(process.env.PROMPTS_PER_DAY || 15);

async function promptBudget(userId) {
  const t = now();
  const hour = await db.one('SELECT COUNT(*) AS n FROM topups WHERE user_id = $1 AND created_at > $2', [
    userId,
    t - 3600,
  ]);
  const day = await db.one('SELECT COUNT(*) AS n FROM topups WHERE user_id = $1 AND created_at > $2', [
    userId,
    t - 86400,
  ]);
  return { hour: Number(hour.n), day: Number(day.n) };
}

router.get(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const bal = await db.one('SELECT balance_cents FROM users WHERE id = $1', [req.user.id]);
    const transactions = (
      await db.all(
        'SELECT id, amount_cents, type, note, created_at FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 50',
        [req.user.id]
      )
    ).map((t) => ({ ...t, amount_cents: Number(t.amount_cents), created_at: iso(t.created_at) }));
    const topups = (
      await db.all(
        'SELECT id, amount_kes, credited_cents, status, receipt, created_at FROM topups WHERE user_id = $1 ORDER BY id DESC LIMIT 10',
        [req.user.id]
      )
    ).map((t) => ({ ...t, credited_cents: Number(t.credited_cents), created_at: iso(t.created_at) }));
    res.json({ balance_cents: Number(bal.balance_cents), transactions, topups });
  })
);

router.post(
  '/topup',
  requireAuth,
  // Order matters: the browser proof runs before a single byte of the prompt is built, the input is
  // validated before it costs anything, and the prompt budget is checked before PayHero is called.
  // A raw request that skipped the app fails at the first gate. A script that passes it still runs
  // into the hourly/daily prompt allowance below - every prompt is a real SMS to a real phone.
  topupLimiter,
  payguard.requireProof,
  wrap(async (req, res) => {
    if (!mpesa.enabled) throw new HttpError(503, 'M-Pesa top-ups are not enabled. Please contact support.');

    const phone = mpesa.normalizePhone(req.body && req.body.phone);
    const amountKes = Number(req.body && req.body.amount_kes);
    if (!Number.isInteger(amountKes) || amountKes < config.minTopupKes || amountKes > config.maxTopupKes) {
      throw new HttpError(400, `Amount must be a whole number between KES ${config.minTopupKes} and KES ${config.maxTopupKes}`);
    }

    const used = await promptBudget(req.user.id);
    if (used.day >= PROMPTS_PER_DAY) {
      throw new HttpError(429, 'That is a lot of M-Pesa prompts today. Use the WhatsApp line if you are stuck.');
    }
    if (used.hour >= PROMPTS_PER_HOUR) {
      throw new HttpError(429, `You have asked for ${used.hour} M-Pesa prompts in the last hour. Wait a little, then try again.`);
    }

    const pending = await db.one(
      "SELECT COUNT(*) AS n FROM topups WHERE user_id = $1 AND status = 'pending' AND created_at > $2",
      [req.user.id, now() - 600]
    );
    if (Number(pending.n) >= 3) {
      throw new HttpError(
        429,
        `You have ${Number(pending.n)} M-Pesa prompt(s) waiting. Approve them on your phone, or wait up to 10 minutes and try again.`
      );
    }

    // Our own reference travels with the request and comes back in PayHero's callback, so a
    // payment can be matched even if the M-Pesa checkout id is missing from the payload.
    const externalRef = `W${req.user.id}-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const { checkoutRequestId, providerRef } = await mpesa.stkPush({ phone, amountKes, externalRef });

    const t = now();
    let r;
    try {
      r = await db.one(
        `INSERT INTO topups (user_id, phone, amount_kes, credited_cents, checkout_request_id, provider_ref, external_ref, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [req.user.id, phone, amountKes, amountKes * 100, checkoutRequestId, providerRef || null, externalRef, 'pending', t, t]
      );
    } catch (err) {
      // Duplicate checkout id means a retry of the same prompt: reuse the pending row instead of
      // charging the customer twice.
      const existing = await db.one("SELECT id FROM topups WHERE checkout_request_id = $1 AND user_id = $2", [
        checkoutRequestId,
        req.user.id,
      ]);
      if (!existing) throw err;
      return res.status(200).json({ topup_id: Number(existing.id), message: 'Check your phone and enter your M-Pesa PIN.' });
    }

    res.status(201).json({ topup_id: Number(r.id), message: 'Check your phone and enter your M-Pesa PIN.' });
  })
);

// PayHero posts the result here (Daraja-shaped bodies are still understood). The secret path
// segment keeps strangers out, and every payment is still confirmed with PayHero's status API
// before the wallet is credited - exactly once, no matter how many retries arrive.
router.post('/mpesa/callback/:secret', wrap(async (req, res) => {
  // Answer 200 straight away with a body both providers accept, so they stop retrying.
  res.json({ status: true, ResultCode: 0, ResultDesc: 'Accepted' });

  const given = Buffer.from(String(req.params.secret || ''));
  const expected = Buffer.from(mpesa.callbackSecret());
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    console.warn('[mpesa] callback rejected: bad secret');
    return;
  }

  const cb = mpesa.parseCallback(req.body);
  if (!cb.checkoutRequestId && !cb.externalRef) return;

  const t =
    (cb.externalRef && (await db.one('SELECT id FROM topups WHERE external_ref = $1', [cb.externalRef]))) ||
    (cb.checkoutRequestId && (await db.one('SELECT id FROM topups WHERE checkout_request_id = $1', [cb.checkoutRequestId])));
  if (!t) {
    console.warn('[mpesa] callback for an unknown payment:', cb.checkoutRequestId || cb.externalRef);
    return;
  }

  await mpesa.reconcileTopup(t.id, cb.receipt).catch((err) => {
    console.warn('[mpesa] callback reconcile failed:', err.message);
  });
}));

// Lets the wallet page show a top-up as paid without waiting for the poller.
router.get(
  '/topup/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = await db.one('SELECT * FROM topups WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!t) throw new HttpError(404, 'Top-up not found');
    if (t.status === 'pending') await mpesa.reconcileTopup(id);
    const fresh = await db.one('SELECT id, amount_kes, credited_cents, status, receipt FROM topups WHERE id = $1', [id]);
    res.json({ topup: { ...fresh, credited_cents: Number(fresh.credited_cents) } });
  })
);

module.exports = router;
