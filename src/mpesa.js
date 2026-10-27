// M-Pesa (Safaricom Daraja) STK Push wallet top-ups.
// Money is credited in KES cents: amount_kes * 100. No FX conversion happens here.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const { HttpError } = require('./errors');

const m = config.mpesa;
const now = () => Math.floor(Date.now() / 1000);

let tokenCache = { token: null, exp: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const auth = Buffer.from(`${m.consumerKey}:${m.consumerSecret}`).toString('base64');
  const res = await fetch(`${m.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Daraja auth failed (HTTP ${res.status})`);
  const data = await res.json();
  tokenCache = { token: data.access_token, exp: Date.now() + (Number(data.expires_in || 3599) - 60) * 1000 };
  return tokenCache.token;
}

async function post(path, body) {
  const token = await getToken();
  const res = await fetch(`${m.baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error body */
  }
  return { ok: res.ok, status: res.status, data };
}

// Daraja timestamps are Nairobi time (UTC+3): YYYYMMDDHHmmss
function timestamp() {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

const password = (ts) => Buffer.from(`${m.shortcode}${m.passkey}${ts}`).toString('base64');

/** Normalize Kenyan numbers (07xx, 01xx, +2547xx, 2547xx) to 2547XXXXXXXX / 2541XXXXXXXX. */
function normalizePhone(input) {
  const digits = String(input || '').replace(/[^\d]/g, '');
  let p = digits;
  if (p.startsWith('0')) p = `254${p.slice(1)}`;
  else if (p.startsWith('7') || p.startsWith('1')) p = `254${p}`;
  if (!/^254[71]\d{8}$/.test(p)) throw new HttpError(400, 'Enter a valid Safaricom number, e.g. 0712345678');
  return p;
}

function callbackSecret() {
  return crypto.createHmac('sha256', config.jwtSecret).update('mpesa-callback').digest('hex').slice(0, 32);
}

const callbackUrl = () => `${config.publicUrl}/api/wallet/mpesa/callback/${callbackSecret()}`;

async function stkPush({ phone, amountKes, reference }) {
  const ts = timestamp();
  const { ok, data } = await post('/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: m.shortcode,
    Password: password(ts),
    Timestamp: ts,
    TransactionType: m.txnType,
    Amount: amountKes,
    PartyA: phone,
    PartyB: m.partyB,
    PhoneNumber: phone,
    CallBackURL: callbackUrl(),
    AccountReference: String(reference).slice(0, 12),
    TransactionDesc: 'Wallet top-up',
  });
  if (!ok || !data || String(data.ResponseCode) !== '0') {
    console.warn('[mpesa] STK push rejected:', JSON.stringify(data));
    throw new HttpError(502, 'Could not start the M-Pesa prompt. Please try again.');
  }
  return { checkoutRequestId: data.CheckoutRequestID, merchantRequestId: data.MerchantRequestID };
}

/** Ask Daraja what happened. Returns 'paid' | 'failed' | 'pending'. */
async function queryStatus(checkoutRequestId) {
  const ts = timestamp();
  const { ok, data } = await post('/mpesa/stkpushquery/v1/query', {
    BusinessShortCode: m.shortcode,
    Password: password(ts),
    Timestamp: ts,
    CheckoutRequestID: checkoutRequestId,
  });
  // While the customer is still entering the PIN, Daraja replies with an error body and no ResultCode.
  if (!ok || !data || data.ResultCode === undefined) return 'pending';
  return String(data.ResultCode) === '0' ? 'paid' : 'failed';
}

/** Credit a paid top-up exactly once (guarded by the row lock + the topup status). */
async function credit(topupId, receipt) {
  return db.tx(async (t) => {
    const row = await t.one('SELECT * FROM topups WHERE id = $1 FOR UPDATE', [topupId]);
    if (!row || row.status !== 'pending') return false;
    await t.run("UPDATE topups SET status = 'paid', receipt = $1, updated_at = $2 WHERE id = $3 AND status = 'pending'", [
      receipt || null,
      now(),
      topupId,
    ]);
    await t.run('UPDATE users SET balance_cents = balance_cents + $1 WHERE id = $2', [row.credited_cents, row.user_id]);
    await t.run('INSERT INTO transactions (user_id, amount_cents, type, ref, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [
      row.user_id,
      Number(row.credited_cents),
      'topup',
      `topup:${topupId}`,
      `M-Pesa KES ${row.amount_kes}${receipt ? ` (${receipt})` : ''}`,
      now(),
    ]);
    return true;
  });
}

/** Confirm one pending top-up with Daraja's query API, then credit it once. */
async function reconcileTopup(topupId, receipt) {
  const t = await db.one('SELECT * FROM topups WHERE id = $1', [topupId]);
  if (!t || t.status !== 'pending') return t && t.status;

  let result;
  try {
    result = await queryStatus(t.checkout_request_id);
  } catch (err) {
    console.warn(`[mpesa] query failed for topup ${topupId}: ${err.message}`);
    result = 'pending';
  }

  if (result === 'paid') {
    await credit(topupId, receipt);
    return 'paid';
  }
  if (result === 'failed' || now() - Number(t.created_at) > 30 * 60) {
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

/** Pull the receipt number out of a Daraja callback body (best effort, never trusted for crediting). */
function receiptFromCallback(cb) {
  const items = cb && cb.CallbackMetadata && cb.CallbackMetadata.Item;
  if (!Array.isArray(items)) return null;
  const hit = items.find((i) => i.Name === 'MpesaReceiptNumber');
  return hit && hit.Value ? String(hit.Value).slice(0, 40) : null;
}

module.exports = {
  enabled: m.enabled,
  normalizePhone,
  callbackSecret,
  stkPush,
  queryStatus,
  reconcileTopup,
  reconcilePending,
  receiptFromCallback,
};
