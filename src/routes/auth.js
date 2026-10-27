const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const { HttpError, wrap } = require('../errors');

const router = express.Router();
const COOKIE = 'token';
const now = () => Math.floor(Date.now() / 1000);
const DAY = 24 * 3600 * 1000;
// Constant-cost comparison for unknown emails so login timing does not reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const BCRYPT_MAX_BYTES = 72; // bcrypt silently truncates beyond this

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
const failures = new Map();
const MAX_FAILURES = 6;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

function checkAccountThrottle(key) {
  const entry = failures.get(key);
  if (!entry) return;
  if (Date.now() - entry.first > FAILURE_WINDOW_MS) {
    failures.delete(key);
    return;
  }
  if (entry.count >= MAX_FAILURES) {
    const mins = Math.max(1, Math.ceil((FAILURE_WINDOW_MS - (Date.now() - entry.first)) / 60000));
    throw new HttpError(429, `Too many failed attempts for this account. Try again in ${mins} minute(s).`);
  }
}

function noteFailure(key) {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.first > FAILURE_WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else entry.count += 1;
  if (failures.size > 5000) failures.clear(); // keep memory bounded
}

const clearFailures = (key) => failures.delete(key);

function setSession(res, user) {
  const token = jwt.sign({ uid: user.id, tv: user.token_version || 0 }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: `${config.sessionDays}d`,
  });
  res.cookie(COOKIE, token, { ...COOKIE_OPTS, maxAge: config.sessionDays * DAY });
}

/** Middleware: attach req.user when a valid, non-revoked session cookie is present. */
function loadUser(req, _res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  if (token) {
    try {
      const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
      const user = db
        .prepare('SELECT id, email, is_admin, balance_cents, token_version FROM users WHERE id = ?')
        .get(payload.uid);
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

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  is_admin: Boolean(u.is_admin),
  balance_cents: u.balance_cents,
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

    const hash = await bcrypt.hash(password, 10);
    let id;
    try {
      id = db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?,?,?)').run(email, hash, now())
        .lastInsertRowid;
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
        throw new HttpError(409, 'That email cannot be used. Try logging in instead.');
      }
      throw err;
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    setSession(res, user);
    res.status(201).json({ user: publicUser(user) });
  })
);

router.post(
  '/login',
  limiter,
  wrap(async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    const key = `${req.ip}|${email}`;
    checkAccountThrottle(key);

    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Always run a hash comparison so response time does not reveal whether the email exists.
    const ok = await bcrypt.compare(password.slice(0, BCRYPT_MAX_BYTES), row ? row.password_hash : DUMMY_HASH);
    if (!row || !ok) {
      noteFailure(key);
      throw new HttpError(401, 'Incorrect email or password');
    }
    clearFailures(key);
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

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const ok = await bcrypt.compare(current.slice(0, BCRYPT_MAX_BYTES), row.password_hash);
    if (!ok) {
      noteFailure(`${req.ip}|${row.email}`);
      throw new HttpError(401, 'Current password is incorrect');
    }
    if (await bcrypt.compare(next.slice(0, BCRYPT_MAX_BYTES), row.password_hash)) {
      throw new HttpError(400, 'Choose a password you have not used here before');
    }

    const hash = await bcrypt.hash(next, 10);
    db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hash, row.id);
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
    setSession(res, fresh); // keep the current device signed in
    res.json({ user: publicUser(fresh), message: 'Password updated. Other devices have been signed out.' });
  })
);

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, COOKIE_OPTS);
  res.json({ ok: true });
});

router.post('/logout-all', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user.id);
  res.clearCookie(COOKIE, COOKIE_OPTS);
  res.json({ ok: true, message: 'Signed out on all devices.' });
});

router.get('/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

module.exports = { router, loadUser, requireAuth, requireAdmin, publicUser, COOKIE, COOKIE_OPTS };
