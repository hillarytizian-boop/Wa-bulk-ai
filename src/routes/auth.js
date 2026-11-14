const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const throttle = require('../throttle');
const mailer = require('../mailer');
const audit = require('../audit');
const { HttpError, wrap } = require('../errors');

const router = express.Router();
const COOKIE = 'token';
const now = () => Math.floor(Date.now() / 1000);
const DAY = 24 * 3600 * 1000;
// Constant-cost comparison for unknown emails so login timing does not reveal which accounts exist.
const ROUNDS = config.bcryptRounds;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', ROUNDS);

const BCRYPT_MAX_BYTES = 72; // bcrypt silently truncates beyond this

/** True for a unique-constraint violation on either driver (Postgres 23505, SQLite constraint). */
function isDuplicateKey(err) {
  if (!err) return false;
  if (String(err.code) === '23505') return true; // Postgres unique_violation
  if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) return true;
  return /duplicate key value violates unique constraint|unique constraint failed|UNIQUE constraint/i.test(
    String(err.message || '')
  );
}

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: config.cookieSecure,
  path: '/',
};

/** IP-level limiter for the credential endpoints. */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.authRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

/** Per-account throttle so one IP cannot hammer many accounts (and vice versa). */
const MAX_FAILURES = 6;
const FAILURE_WINDOW_SEC = 15 * 60;
const REGISTER_PER_HOUR = 8;

// Counters live in the database (see src/throttle.js) so a fresh lambda instance does not hand an
// attacker a fresh budget; the in-process Map that used to live here was per-instance only.
async function checkAccountThrottle(key) {
  const state = await throttle.peek(key, FAILURE_WINDOW_SEC);
  if (state.count >= MAX_FAILURES) {
    const mins = Math.max(1, Math.ceil(state.retry_after / 60));
    throw new HttpError(429, `Too many failed attempts for this account. Try again in ${mins} minute(s).`);
  }
}

async function noteFailure(key) {
  await throttle.bump(key, FAILURE_WINDOW_SEC);
}

const clearFailures = (key) => throttle.clear(key);

function setSession(res, user) {
  const token = jwt.sign({ uid: user.id, tv: user.token_version || 0 }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: `${config.sessionDays}d`,
  });
  res.cookie(COOKIE, token, { ...COOKIE_OPTS, maxAge: config.sessionDays * DAY });
}

/** Middleware: attach req.user when a valid, non-revoked session cookie is present. */
async function loadUser(req, _res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  if (token) {
    try {
      const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
      const user = await db.one(
        'SELECT id, email, is_admin, balance_cents, token_version, password_set, google_sub FROM users WHERE id = $1',
        [payload.uid]
      );
      // token_version lets us revoke every existing session (password change, logout everywhere).
      if (user && Number(payload.tv || 0) === Number(user.token_version || 0)) req.user = user;
    } catch {
      /* invalid or expired - treat as logged out */
    }
  }
  next();
}

const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please log in' }));
const requireAdmin = (req, res, next) =>
  req.user && req.user.is_admin ? next() : res.status(403).json({ error: 'Admin access required' });

const termsAccepted = (u) =>
  Boolean(Number(u.terms_accepted_at)) && String(u.terms_version || '') === config.terms.version;

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  is_admin: Boolean(u.is_admin),
  balance_cents: u.balance_cents,
  password_set: u.password_set === undefined ? true : Boolean(Number(u.password_set)),
  google: Boolean(u.google_sub),
  // The storefront gates ordering on this. An admin is never held at the gate.
  terms: {
    accepted: Boolean(u.is_admin) || termsAccepted(u),
    version: config.terms.version,
    required_version: config.terms.version,
  },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_BYTES) {
    throw new HttpError(400, 'Password is too long (max 72 bytes)');
  }
}

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

router.post(
  '/register',
  limiter,
  wrap(async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    const password = req.body && req.body.password;
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address');
    assertPassword(password);
    // Acceptance has to be explicit and is enforced here, not only in the browser: a client that
    // skips the checkbox must not get an account.
    if (req.body.accept_terms !== true) {
      throw new HttpError(400, 'You must accept the Terms & Conditions to create an account');
    }

    // Open registration is kept, but not unlimited: one IP cannot mint accounts in bulk.
    const signups = await throttle.bump(`register|${req.ip}`, 3600);
    if (signups.count > REGISTER_PER_HOUR) {
      throw new HttpError(429, 'Too many sign-ups from here. Please try again later.');
    }

    const hash = await bcrypt.hash(password, ROUNDS);
    let id;
    try {
      const inserted = await db.one(
        'INSERT INTO users (email, password_hash, password_set, terms_accepted_at, terms_version, created_at) VALUES ($1,$2,1,$3,$4,$5) RETURNING id',
        [email, hash, now(), config.terms.version, now()]
      );
      id = inserted.id;
    } catch (err) {
      // Postgres reports a unique violation as 23505; SQLite as SQLITE_CONSTRAINT. The old check
      // only knew the SQLite code, so on production a duplicate sign-up surfaced as a 500.
      if (isDuplicateKey(err)) {
        throw new HttpError(409, 'An account with that email already exists. Try logging in instead.');
      }
      throw err;
    }
    const user = await db.one('SELECT * FROM users WHERE id = $1', [id]);
    setSession(res, user);
    res.status(201).json({ user: publicUser(user) });
    // Welcome mail is best-effort and deliberately after the response: a mail failure must never
    // turn a successful sign-up into an error.
    mailer.welcome(email).catch(() => {});
  })
);

router.post(
  '/login',
  limiter,
  wrap(async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    const key = `login|${req.ip}|${email}`;
    await checkAccountThrottle(key);

    const row = await db.one('SELECT * FROM users WHERE email = $1', [email]);
    // Always run a hash comparison so response time does not reveal whether the email exists.
    const ok = await bcrypt.compare(password.slice(0, BCRYPT_MAX_BYTES), row ? row.password_hash : DUMMY_HASH);
    // Fail closed for accounts that have no password of their own (Google-only). password_set = 0
    // means the hash is a random placeholder, and a placeholder must never authenticate anyone.
    if (!row || !ok || !Number(row.password_set)) {
      await noteFailure(key);
      throw new HttpError(401, 'Incorrect email or password');
    }
    await clearFailures(key);

    // Re-hash anything written under the old, cheaper cost. Silent: the caller is already in.
    const cost = Number(String(row.password_hash).split('$')[2]);
    if (Number.isFinite(cost) && cost < ROUNDS) {
      try {
        const upgraded = await bcrypt.hash(password.slice(0, BCRYPT_MAX_BYTES), ROUNDS);
        await db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [upgraded, row.id]);
      } catch (err) {
        console.warn('[auth] password rehash skipped:', err.message);
      }
    }

    setSession(res, row);
    res.json({ user: publicUser(row) });
  })
);

// Changing the password bumps token_version, which signs out every other device.
router.post(
  '/password',
  requireAuth,
  wrap(async (req, res) => {
    const current = String((req.body && req.body.current_password) || '');
    const next = req.body && req.body.new_password;
    assertPassword(next);

    const row = await db.one('SELECT * FROM users WHERE id = $1', [req.user.id]);
    // A Google-only account has no password to confirm yet; an attached Google identity is proof
    // enough because the caller already holds that session.
    const firstPassword = !Number(row.password_set) && Boolean(row.google_sub);
    if (!firstPassword) {
      const ok = await bcrypt.compare(current.slice(0, BCRYPT_MAX_BYTES), row.password_hash);
      if (!ok) {
        await noteFailure(`login|${req.ip}|${row.email}`);
        throw new HttpError(401, 'Current password is incorrect');
      }
      if (await bcrypt.compare(next.slice(0, BCRYPT_MAX_BYTES), row.password_hash)) {
        throw new HttpError(400, 'Choose a password you have not used here before');
      }
    }

    const hash = await bcrypt.hash(next, ROUNDS);
    await db.run(
      'UPDATE users SET password_hash = $1, password_set = 1, token_version = token_version + 1 WHERE id = $2',
      [hash, row.id]
    );
    const fresh = await db.one('SELECT * FROM users WHERE id = $1', [row.id]);
    setSession(res, fresh); // keep the current device signed in
    res.json({ user: publicUser(fresh), message: 'Password updated. Other devices have been signed out.' });
  })
);

// ------------------------------------------------------------------ password reset
//
// Requesting a reset never reveals whether an address exists: the answer is always the same 200.
// Only a SHA-256 of the token is stored, the token is single-use, and a successful reset bumps
// token_version so every existing session dies with it.
const RESET_TTL_SEC = 30 * 60;
const RESET_PER_HOUR = 5;
const RESET_IP_PER_HOUR = 20;
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

router.post(
  '/forgot',
  limiter,
  wrap(async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    const generic = { ok: true, message: 'If that email has an account, a reset link is on its way.' };
    if (!EMAIL_RE.test(email) || email.length > 254) return res.json(generic);

    const perIp = await throttle.bump(`forgot-ip|${req.ip}`, 3600);
    if (perIp.count > RESET_IP_PER_HOUR) {
      throw new HttpError(429, 'Too many reset requests from here. Please try again later.');
    }

    const user = await db.one('SELECT id, email, password_set FROM users WHERE email = $1', [email]);
    if (!user) return res.json(generic);

    const perUser = await throttle.bump(`forgot|${user.id}`, 3600);
    if (perUser.count > RESET_PER_HOUR) return res.json(generic);

    const token = crypto.randomBytes(32).toString('hex');
    const t = now();
    // Invalidate older links: only the newest token for an account is worth keeping.
    await db.run('UPDATE password_resets SET used_at = $1 WHERE user_id = $2 AND used_at = 0', [t, user.id]);
    await db.run(
      'INSERT INTO password_resets (user_id, token_hash, expires_at, used_at, ip, created_at) VALUES ($1,$2,$3,0,$4,$5)',
      [user.id, sha256(token), t + RESET_TTL_SEC, String(req.ip || ''), t]
    );

    // Google-only accounts have no password to reset; point them at Google instead of a dead end.
    const sent = Number(user.password_set)
      ? await mailer.resetPassword(user.email, token)
      : { ok: false, skipped: 'google_only' };
    if (sent.ok) audit.record(req, 'auth.reset_requested', { target: user.id });
    return res.json(generic);
  })
);

// Token validity check so the reset screen can say "this link expired" before the user types.
router.get(
  '/reset/:token',
  wrap(async (req, res) => {
    const row = await db.one(
      'SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = $1',
      [sha256(req.params.token)]
    );
    const usable = Boolean(row) && !Number(row.used_at) && Number(row.expires_at) > now();
    res.json({ valid: usable });
  })
);

router.post(
  '/reset',
  limiter,
  wrap(async (req, res) => {
    const token = String((req.body && req.body.token) || '');
    const password = req.body && req.body.password;
    assertPassword(password);
    if (!token) throw new HttpError(400, 'That reset link is missing its token');

    const hash = await bcrypt.hash(password, ROUNDS);
    // Atomic single use: the UPDATE both validates and claims the token in one statement, so two
    // requests racing on the same link cannot both win. RETURNING gives the owner back only to the
    // request that actually changed the row.
    const claim = await db.one(
      `UPDATE password_resets SET used_at = $1
        WHERE token_hash = $2 AND used_at = 0 AND expires_at > $1
        RETURNING user_id`,
      [now(), sha256(token)]
    );
    if (!claim) {
      // Distinguish the three reasons only for the person who no longer has a usable link.
      const seen = await db.one('SELECT used_at FROM password_resets WHERE token_hash = $1', [sha256(token)]);
      throw new HttpError(
        400,
        seen && Number(seen.used_at)
          ? 'That reset link has already been used. Request a new one.'
          : 'That reset link has expired. Request a new one.'
      );
    }

    const user = await db.one('SELECT * FROM users WHERE id = $1', [claim.user_id]);
    if (!user) throw new HttpError(400, 'That account no longer exists');

    await db.run(
      'UPDATE users SET password_hash = $1, password_set = 1, token_version = token_version + 1 WHERE id = $2',
      [hash, user.id]
    );
    await clearFailures(`login|${req.ip}|${user.email}`);
    audit.record(req, 'auth.reset_completed', { target: user.id });
    const fresh = await db.one('SELECT * FROM users WHERE id = $1', [user.id]);
    setSession(res, fresh); // the person who reset the password is signed in here
    res.json({ user: publicUser(fresh), message: 'Password changed. You are signed in.' });
  })
);

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, COOKIE_OPTS);
  res.json({ ok: true });
});

router.post('/logout-all', requireAuth, wrap(async (req, res) => {
  await db.run('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [req.user.id]);
  res.clearCookie(COOKIE, COOKIE_OPTS);
  res.json({ ok: true, message: 'Signed out on all devices.' });
}));

router.get('/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

// Record acceptance of the current Terms & Conditions. Idempotent, and re-accepting after a
// version bump is the same call.
router.post(
  '/accept-terms',
  requireAuth,
  wrap(async (req, res) => {
    const accepted = Number(req.user.terms_accepted_at)
      && String(req.user.terms_version || '') === config.terms.version;
    if (!accepted) {
      await db.run('UPDATE users SET terms_accepted_at = $1, terms_version = $2 WHERE id = $3', [
        now(),
        config.terms.version,
        req.user.id,
      ]);
    }
    const fresh = await db.one('SELECT * FROM users WHERE id = $1', [req.user.id]);
    res.json({ user: publicUser(fresh), version: config.terms.version });
  })
);

// ---------------------------------------------------------------- Google sign-in
// OAuth 2.0 authorisation-code flow. Enabled only when GOOGLE_CLIENT_ID and
// GOOGLE_CLIENT_SECRET are set; until then the button is hidden and these routes 503.
const G_STATE_COOKIE = 'g_state';
const G_STATE_MS = 10 * 60 * 1000;

const googleReady = () => {
  if (!config.google.enabled) throw new HttpError(503, 'Google sign-in is not configured');
};

router.get(
  '/google',
  limiter,
  wrap(async (_req, res) => {
    googleReady();
    const state = crypto.randomBytes(24).toString('hex');
    // SameSite=Lax so the cookie survives the top-level redirect back from Google.
    res.cookie(G_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/api/auth',
      maxAge: G_STATE_MS,
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', config.google.clientId);
    url.searchParams.set('redirect_uri', config.google.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
    res.redirect(302, url.toString());
  })
);

router.get(
  '/google/callback',
  wrap(async (req, res) => {
    googleReady();
    const expected = req.cookies && req.cookies[G_STATE_COOKIE];
    const got = String(req.query.state || '');
    res.clearCookie(G_STATE_COOKIE, { path: '/api/auth' });
    if (!expected || !got || expected.length !== got.length) {
      return res.redirect(302, '/#/login?error=google_state');
    }
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got))) {
      return res.redirect(302, '/#/login?error=google_state');
    }
    if (req.query.error || !req.query.code) return res.redirect(302, '/#/login?error=google_denied');

    // Exchange the authorisation code for tokens (server-side only).
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code),
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: config.google.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) return res.redirect(302, '/#/login?error=google_exchange');
    const tokens = await tokenRes.json();

    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!infoRes.ok) return res.redirect(302, '/#/login?error=google_profile');
    const profile = await infoRes.json();

    const sub = String(profile.sub || '');
    const email = normalizeEmail(profile.email);
    // Only trust the address when Google says it is verified.
    if (!sub || !email || !EMAIL_RE.test(email) || profile.email_verified !== true) {
      return res.redirect(302, '/#/login?error=google_unverified');
    }

    let user = await db.one('SELECT * FROM users WHERE google_sub = $1', [sub]);
    if (!user) {
      const existing = await db.one('SELECT * FROM users WHERE email = $1', [email]);
      if (existing) {
        // Linking a Google identity to an existing account is an account-recovery moment, so it
        // also invalidates whatever password was there. Without this, anyone could pre-register
        // a stranger's email with a password of their own and keep access after the real owner
        // signs in with Google (classic pre-hijack).
        const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), ROUNDS);
        await db.run(
          `UPDATE users SET google_sub = $1,
                            password_hash = CASE WHEN password_set = 1 THEN $2 ELSE password_hash END,
                            password_set = 0,
                            token_version = token_version + 1
            WHERE id = $3 AND (google_sub IS NULL OR google_sub = $1)`,
          [sub, unusable, existing.id]
        );
        user = await db.one('SELECT * FROM users WHERE id = $1', [existing.id]);
      } else {
        // No usable password: sign-in happens through Google only.
        const placeholder = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), ROUNDS);
        const inserted = await db.one(
          'INSERT INTO users (email, password_hash, google_sub, password_set, created_at) VALUES ($1,$2,$3,0,$4) RETURNING id',
          [email, placeholder, sub, now()]
        );
        user = await db.one('SELECT * FROM users WHERE id = $1', [inserted.id]);
      }
    }

    setSession(res, user);
    res.redirect(302, '/#/');
  })
);

module.exports = { router, loadUser, requireAuth, requireAdmin, publicUser, COOKIE, COOKIE_OPTS, isDuplicateKey };
