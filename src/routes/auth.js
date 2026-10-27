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
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

function setSession(res, userId) {
  const token = jwt.sign({ uid: userId }, config.jwtSecret, { expiresIn: '14d' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: 14 * 24 * 3600 * 1000,
  });
}

/** Middleware: attach req.user if a valid session cookie is present. */
function loadUser(req, _res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  if (token) {
    try {
      const { uid } = jwt.verify(token, config.jwtSecret);
      req.user = db.prepare('SELECT id, email, is_admin, balance_cents FROM users WHERE id = ?').get(uid);
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

router.post(
  '/register',
  limiter,
  wrap(async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address');
    if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Password must be 8-128 characters');

    const hash = await bcrypt.hash(password, 10);
    let id;
    try {
      id = db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?,?,?)').run(email, hash, now())
        .lastInsertRowid;
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, 'That email is already registered');
      throw err;
    }
    setSession(res, Number(id));
    const user = db.prepare('SELECT id, email, is_admin, balance_cents FROM users WHERE id = ?').get(id);
    res.status(201).json({ user: publicUser(user) });
  })
);

router.post(
  '/login',
  limiter,
  wrap(async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Always compare a hash so response time does not reveal whether the email exists.
    const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
    if (!row || !ok) throw new HttpError(401, 'Incorrect email or password');
    setSession(res, row.id);
    res.json({ user: publicUser(row) });
  })
);

router.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

module.exports = { router, loadUser, requireAuth, requireAdmin, publicUser };
