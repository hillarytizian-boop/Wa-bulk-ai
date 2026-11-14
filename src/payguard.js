// "Prove you were actually browsing before you pay."
//
// The money endpoints (starting an M-Pesa prompt, placing an order) are the only two places where a
// raw script can cost somebody something: an M-Pesa prompt is a real SMS to a real phone, and order
// placement spends a real balance. Everything else on this API is either read-only or worthless to
// automate.
//
// The rule implemented here: a payment request must carry a proof that only a browser that actually
// loaded the app can produce, in two parts.
//
//   1. Browsing state. The challenge is issued by GET /api/challenge, which a session can only reach
//      after signing in, and it is bound to the account and to the browser's User-Agent. A request
//      replayed from another machine, or made up from scratch, does not match.
//   2. Work. The challenge is a proof-of-work puzzle: find `nonce` so that
//      sha256(challenge + ':' + nonce) starts with N zero bits. A browser solves it once in the
//      background (a few hundred milliseconds); a farm has to pay that cost for every attempt, on
//      top of the per-account and per-IP prompt limits in routes/wallet.js.
//
// This is not a CAPTCHA and does not pretend to be unbeatable - a determined person with a headless
// browser passes it. It does mean that a curl one-liner, a scraped cookie, or a replay of a request
// captured in a proxy log cannot start an M-Pesa prompt, which is the actual complaint.
const crypto = require('crypto');
const config = require('./config');

const TTL_SEC = 600;
const BITS = Math.max(8, Math.min(20, Number(process.env.PAY_PROOF_BITS || 12)));
const MAX_SOLUTION = 1e9;

const key = () => crypto.createHmac('sha256', config.jwtSecret).update('pay-proof-v1').digest();
const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** Cheap fingerprint of the client, so a proof lifted from one browser is useless in another. */
const fingerprint = (req) =>
  crypto
    .createHash('sha256')
    .update(String(req.get('user-agent') || '') + '|' + String(req.get('accept-language') || ''))
    .digest('hex')
    .slice(0, 24);

const sign = (payload) => crypto.createHmac('sha256', key()).update(payload).digest();

/** Issue a challenge for this request. Bound to the account and the browser. */
function issue(req) {
  const body = {
    n: crypto.randomBytes(12).toString('hex'),
    u: req.user ? Number(req.user.id) : 0,
    f: fingerprint(req),
    b: BITS,
    e: Math.floor(Date.now() / 1000) + TTL_SEC,
  };
  const payload = b64(JSON.stringify(body));
  return { challenge: `${payload}.${b64(sign(payload))}`, bits: BITS, expires_in: TTL_SEC };
}

/** Leading zero bits of a buffer. */
function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/**
 * Check a proof. Returns {ok:true} or {ok:false, reason}.
 * `proof` is the raw header value: "<challenge>:<nonce>".
 */
function check(req, proof) {
  const raw = String(proof || '');
  const cut = raw.lastIndexOf(':');
  if (cut <= 0) return { ok: false, reason: 'missing' };
  const challenge = raw.slice(0, cut);
  const nonce = raw.slice(cut + 1);
  if (!/^\d{1,10}$/.test(nonce) || Number(nonce) > MAX_SOLUTION) return { ok: false, reason: 'nonce' };

  const [payload, mac] = challenge.split('.');
  if (!payload || !mac) return { ok: false, reason: 'shape' };
  const expected = sign(payload);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature' };
  }

  let body;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'payload' };
  }
  if (!body.e || body.e < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  if (Number(body.u) !== Number(req.user ? req.user.id : 0)) return { ok: false, reason: 'account' };
  if (String(body.f) !== fingerprint(req)) return { ok: false, reason: 'browser' };

  const digest = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
  if (leadingZeroBits(digest) < Number(body.b || BITS)) return { ok: false, reason: 'work' };
  return { ok: true };
}

/**
 * Middleware for the payment endpoints. On failure it answers 428 with a fresh challenge, so the
 * app can solve it and retry once without the customer ever seeing an error.
 */
function requireProof(req, res, next) {
  const verdict = check(req, req.get('x-pay-proof'));
  if (verdict.ok) return next();
  return res.status(428).json({
    error: 'Confirm you are using the app before paying.',
    code: 'verification_required',
    reason: verdict.reason,
    ...issue(req),
  });
}

module.exports = { issue, check, requireProof, leadingZeroBits, fingerprint, TTL_SEC, BITS };
