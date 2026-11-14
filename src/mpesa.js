// M-Pesa wallet top-ups, collected through PayHero (https://docs.payhero.co.ke).
//
// Flow: the panel asks PayHero to send an STK prompt, stores a `topups` row, and only credits the
// wallet after the payment is confirmed - either by PayHero's callback (which triggers a verified
// status check) or by the reconciler in src/jobs.js when a callback never arrives.
//
// Money is credited in KES cents: amount_kes * 100. No FX conversion happens here.
const crypto = require('crypto');
const db = require('./db');
const mailer = require('./mailer');
const config = require('./config');
const { HttpError } = require('./errors');

const ph = config.payhero;
const now = () => Math.floor(Date.now() / 1000);

/** Normalize Kenyan numbers (07xx, 01xx, +2547xx, 2547xx) to 2547XXXXXXXX / 2541XXXXXXXX. */
function normalizePhone(input) {
  const digits = String(input || '').replace(/[^\d]/g, '');
  let p = digits;
  if (p.startsWith('0')) p = `254${p.slice(1)}`;
  else if (p.startsWith('7') || p.startsWith('1')) p = `254${p}`;
  if (!/^254[71]\d{8}$/.test(p)) throw new HttpError(400, 'Enter a valid Safaricom number, e.g. 0712345678');
  return p;
}

/** One HTTP call to PayHero, with Basic auth and a hard timeout. */
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${ph.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${ph.basicAuth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { ok: res.ok, status: res.status, data };
}

/** Callback path secret: unguessable, derived from the app secret so it survives restarts. */
function callbackSecret() {
  return crypto.createHmac('sha256', config.jwtSecret).update('mpesa-callback').digest('hex').slice(0, 32);
}

const callbackUrl = () => `${config.publicUrl}/api/wallet/mpesa/callback/${callbackSecret()}`;
const callbackPath = () => `/api/wallet/mpesa/callback/${callbackSecret()}`;

/**
 * Ask PayHero to send the STK prompt.
 * Returns the two references we need later: PayHero's own `reference` (used to poll the status)
 * and the M-Pesa `CheckoutRequestID` (what their callback reports back).
 */
async function stkPush({ phone, amountKes, externalRef }) {
  const amount = Math.round(Number(amountKes));
  if (!Number.isFinite(amount) || amount < 1) throw new HttpError(400, 'Enter a whole KES amount');
  if (!ph.channelId) throw new HttpError(503, 'Payments are not configured (no PayHero channel id).');

  const { ok, data } = await call('/api/v2/payments', {
    method: 'POST',
    body: {
      amount,
      phone_number: phone,
      channel_id: ph.channelId,
      provider: 'm-pesa',
      external_reference: String(externalRef).slice(0, 60),
      callback_url: callbackUrl(),
    },
  });

  if (!ok || !data || data.success === false || !(data.reference || data.CheckoutRequestID)) {
    console.warn('[payhero] STK push rejected:', JSON.stringify(data));
    throw new HttpError(502, 'Could not start the M-Pesa prompt. Please try again.');
  }

  const providerRef = data.reference ? String(data.reference) : null;
  // PayHero normally returns a CheckoutRequestID; if it does not, their reference is unique too.
  const checkoutRequestId = data.CheckoutRequestID ? String(data.CheckoutRequestID) : providerRef;
  return { checkoutRequestId, providerRef };
}

/**
 * Ask PayHero what happened to a payment.
 * Returns { status: 'paid'|'failed'|'pending', amountKes, currency, receipt }.
 *
 * The amount matters: the wallet is credited with what M-Pesa actually collected, never with the
 * number the customer typed, so a part-payment can never turn into a full top-up.
 */
async function queryStatus({ providerRef, checkoutRequestId }) {
  const reference = providerRef || checkoutRequestId;
  const unknown = { status: 'pending', amountKes: null, currency: null, receipt: null };
  if (!reference) return unknown;
  const { ok, data } = await call(`/api/v2/transaction-status?reference=${encodeURIComponent(reference)}`);
  if (!ok || !data) return unknown;
  const raw = String(data.status || '').toUpperCase();
  const amountRaw = data.amount !== undefined ? data.amount : data.transaction_amount;
  const amount = Number(amountRaw);
  const receipt = data.mpesa_receipt || data.MpesaReceiptNumber || data.provider_reference;
  return {
    status: raw === 'SUCCESS' ? 'paid' : raw === 'FAILED' ? 'failed' : 'pending', // anything else = QUEUED
    // Only a positive, finite figure counts; a missing amount keeps the requested one.
    amountKes: Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null,
    currency: data.currency ? String(data.currency).toUpperCase() : null,
    receipt: receipt ? String(receipt).slice(0, 40) : null,
  };
}

/**
 * Admin diagnostics: which credential path is actually in use, and what PayHero answers right now.
 * Lengths only - never the values - so the console can tell "env var missing" from "wrong password"
 * without ever shipping the secret to a browser.
 */
function diagnose() {
  const user = process.env.PAYHERO_API_USERNAME || '';
  const pass = process.env.PAYHERO_API_PASSWORD || '';
  const basic = process.env.PAYHERO_BASIC_AUTH || '';
  return {
    enabled: ph.enabled,
    base_url: ph.baseUrl,
    channel_id: ph.channelId || null,
    account_id: ph.accountId || null,
    auth_source: basic ? 'PAYHERO_BASIC_AUTH' : user && pass ? 'PAYHERO_API_USERNAME+PASSWORD' : 'none',
    username_len: user.length,
    password_len: pass.length,
    basic_len: (ph.basicAuth || '').length,
  };
}

/** One authenticated read against PayHero, with only the harmless parts of the reply. */
async function probe() {
  const { ok, status, data } = await call('/api/v2/payment_channels');
  const pick = (k) => (data && typeof data === 'object' && data[k] !== undefined ? String(data[k]).slice(0, 140) : null);
  const channel = data && Array.isArray(data.payment_channels) ? data.payment_channels[0] : null;
  return {
    ok,
    http_status: status,
    provider_message: pick('message') || pick('error') || pick('detail'),
    channel_seen: channel ? { id: channel.id, short_code: channel.short_code, account_id: channel.account_id, is_active: channel.is_active } : null,
    channel_matches_env: channel ? Number(channel.id) === Number(ph.channelId) : null,
  };
}

/** His wallet balance at PayHero (service wallet). Used by the admin console. */
async function providerBalance() {
  const { ok, data } = await call('/api/v2/wallets');
  if (!ok || !data) throw new Error('PayHero wallet lookup failed');
  return { balance: Number(data.available_balance || 0), currency: data.currency || 'KES' };
}

/**
 * Credit a paid top-up exactly once (guarded by the row lock + the topup status).
 * `paidKes` is what the provider says M-Pesa collected; the wallet never receives more than the
 * customer asked for, and a short payment credits only the amount that really moved.
 */
async function credit(topupId, receipt, paidKes) {
  return db.tx(async (t) => {
    const row = await t.one('SELECT * FROM topups WHERE id = $1 FOR UPDATE', [topupId]);
    if (!row || row.status !== 'pending') return false;
    const requested = Math.round(Number(row.amount_kes));
    let creditedKes = requested;
    if (Number.isFinite(paidKes) && paidKes > 0) {
      creditedKes = Math.min(requested, Math.round(paidKes));
      if (creditedKes < requested) {
        console.warn(`[payhero] topup ${topupId} was underpaid: collected KES ${paidKes} of ${requested}`);
      }
    }
    const credited = creditedKes * 100;
    await t.run("UPDATE topups SET status = 'paid', credited_cents = $1, receipt = $2, updated_at = $3 WHERE id = $4 AND status = 'pending'", [
      credited,
      receipt || null,
      now(),
      topupId,
    ]);
    await t.run('UPDATE users SET balance_cents = balance_cents + $1 WHERE id = $2', [credited, row.user_id]);
    await t.run('INSERT INTO transactions (user_id, amount_cents, type, ref, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [
      row.user_id,
      credited,
      'topup',
      `topup:${topupId}`,
      `M-Pesa KES ${creditedKes}${receipt ? ` (${receipt})` : ''}`,
      now(),
    ]);
    return { creditedKes, userId: row.user_id };
  });
}

/** Fire-and-forget receipt email after a credit. The money is already in the wallet. */
async function receiptEmail(userId, creditedKes) {
  try {
    const u = await db.one('SELECT email, balance_cents FROM users WHERE id = $1', [userId]);
    if (!u || !u.email) return;
    await mailer.paymentReceived(u.email, {
      amountKes: creditedKes,
      balanceKes: Math.round(Number(u.balance_cents) / 100).toLocaleString('en-KE'),
    });
  } catch (err) {
    console.warn('[mpesa] receipt email skipped:', err.message);
  }
}

/** Confirm one pending top-up with PayHero's status API, then credit it once. */
async function reconcileTopup(topupId, receipt) {
  const t = await db.one('SELECT * FROM topups WHERE id = $1', [topupId]);
  if (!t || t.status !== 'pending') return t && t.status;

  let result;
  try {
    result = await queryStatus({ providerRef: t.provider_ref, checkoutRequestId: t.checkout_request_id });
  } catch (err) {
    console.warn(`[payhero] status check failed for topup ${topupId}: ${err.message}`);
    result = { status: 'pending', amountKes: null, currency: null, receipt: null };
  }

  if (result.status === 'paid') {
    // A "SUCCESS" in another currency is not our money - hold the top-up for a human instead of
    // inventing a balance out of a mismatched payload.
    if (result.currency && result.currency !== 'KES') {
      console.warn(`[payhero] topup ${topupId} reports currency ${result.currency}; not crediting`);
      return 'pending';
    }
    const done = await credit(topupId, receipt || result.receipt, result.amountKes);
    if (done) receiptEmail(done.userId, done.creditedKes).catch(() => {});
    return 'paid';
  }
  // Give the customer 30 minutes to finish the prompt before writing the attempt off.
  if (result.status === 'failed' || now() - Number(t.created_at) > 30 * 60) {
    await db.run("UPDATE topups SET status = 'failed', updated_at = $1 WHERE id = $2 AND status = 'pending'", [now(), topupId]);
    return 'failed';
  }
  return 'pending';
}

/** Reconciliation for payments whose callback never arrived (cron / background job). */
async function reconcilePending(limit = 20) {
  const rows = await db.all("SELECT id FROM topups WHERE status = 'pending' AND created_at <= $1 ORDER BY id LIMIT $2", [
    now() - 20,
    limit,
  ]);
  for (const r of rows) await reconcileTopup(r.id);
  return rows.length;
}

/**
 * Read either callback shape and pull out the identifiers.
 * PayHero: { status: true, response: { CheckoutRequestID, ExternalReference, MpesaReceiptNumber, ... } }
 * Daraja:  { Body: { stkCallback: { CheckoutRequestID, CallbackMetadata: { Item: [...] } } } }
 * The receipt is informational only - nothing is credited from this body.
 */
function parseCallback(body) {
  const b = body || {};
  if (b.response && typeof b.response === 'object') {
    const r = b.response;
    return {
      provider: 'payhero',
      checkoutRequestId: r.CheckoutRequestID ? String(r.CheckoutRequestID) : null,
      externalRef: r.ExternalReference ? String(r.ExternalReference) : null,
      receipt: r.MpesaReceiptNumber ? String(r.MpesaReceiptNumber).slice(0, 40) : null,
      succeeded: String(r.Status || '').toLowerCase() === 'success' || Number(r.ResultCode) === 0,
    };
  }
  const cb = b.Body && b.Body.stkCallback;
  if (cb) {
    const items = cb.CallbackMetadata && cb.CallbackMetadata.Item;
    const hit = Array.isArray(items) ? items.find((i) => i.Name === 'MpesaReceiptNumber') : null;
    return {
      provider: 'daraja',
      checkoutRequestId: cb.CheckoutRequestID ? String(cb.CheckoutRequestID) : null,
      externalRef: null,
      receipt: hit && hit.Value ? String(hit.Value).slice(0, 40) : null,
      succeeded: Number(cb.ResultCode) === 0,
    };
  }
  return { provider: null, checkoutRequestId: null, externalRef: null, receipt: null, succeeded: false };
}

module.exports = {
  enabled: ph.enabled,
  provider: 'payhero',
  normalizePhone,
  callbackSecret,
  callbackPath,
  callbackUrl,
  stkPush,
  queryStatus,
  providerBalance,
  diagnose,
  probe,
  reconcileTopup,
  reconcilePending,
  parseCallback,
};
