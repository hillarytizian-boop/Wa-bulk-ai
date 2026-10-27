const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const db = require('./db');
const pricing = require('./pricing');
const jobs = require('./jobs');
const auth = require('./routes/auth');
const { csrfGuard, noStore } = require('./security');

const isServerless = Boolean(process.env.VERCEL);

function createApp() {
  const app = express();
  if (config.trustProxy || isServerless) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'self'"],
          'frame-ancestors': config.allowIframe ? ["'self'", 'https://*.e2b.app'] : ["'none'"],
          // Breaks plain-HTTP local development, so only keep it when serving over HTTPS.
          ...(config.cookieSecure ? {} : { 'upgrade-insecure-requests': null }),
        },
      },
      frameguard: config.allowIframe ? false : { action: 'deny' },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.cookieSecure ? { maxAge: 15552000, includeSubDomains: true } : false,
    })
  );
  app.use(compression());
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/healthz', async (_req, res) => {
    try {
      await db.one('SELECT 1 AS ok');
      res.json({ ok: true, db: db.dialect, uptime: Math.round(process.uptime()) });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
  });

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });
  const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many admin requests' },
  });

  // Load the editable pricing settings once per cold start (cheap no-op afterwards).
  app.use('/api', async (_req, _res, next) => {
    try {
      await pricing.ensureSettings();
      next();
    } catch (err) {
      next(err);
    }
  });

  // Cron entry point: Vercel Cron calls this (Authorization: Bearer $CRON_SECRET).
  app.get('/api/cron/tick', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const header = String(req.get('authorization') || '');
      const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.token || '');
      const crypto = require('crypto');
      const a = Buffer.from(token);
      const b = Buffer.from(secret);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });
    }
    const result = await jobs.tick({ log: console.log });
    res.json({ ok: true, ...result });
  });

  app.use('/api', apiLimiter, noStore, auth.loadUser, csrfGuard);
  app.use('/api/auth', auth.router);
  app.use('/api/admin', adminLimiter, require('./routes/admin'));
  app.use('/api/wallet', require('./routes/wallet'));
  app.use('/api', require('./routes/shop'));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Static site. Paths are checked in order so the same code works when run from the repo
  // (Docker/VPS), from the Vercel build root, and from inside a bundled serverless function
  // where the assets sit next to the function instead of one directory up.
  const staticDir = [
    path.join(__dirname, '..', 'public'),
    path.join(__dirname, 'public'),
    path.join(process.cwd(), 'public'),
  ].find((dir) => fs.existsSync(path.join(dir, 'index.html')));

  app.use(
    express.static(staticDir || path.join(__dirname, '..', 'public'), {
      maxAge: config.isProd ? '1h' : 0,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    if (err && err.expose && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[error]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

/**
 * Make sure the configured admin account exists. Never logs or stores the plaintext password.
 * Refuses the shipped example password in production.
 */
async function seedAdmin({ log = console.log } = {}) {
  const { email, password } = config.admin;
  if (!email || !password) return;
  if (config.isProd && password === 'change-this-password') {
    console.error('[seed] Refusing to use the example ADMIN_PASSWORD in production. Set a real one.');
    return;
  }
  const existing = await db.one('SELECT id, is_admin FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing) {
    if (!Number(existing.is_admin)) console.warn(`[seed] ${email} exists but is not an admin.`);
    return;
  }
  await db.run('INSERT INTO users (email, password_hash, is_admin, created_at) VALUES ($1,$2,1,$3)', [
    email.toLowerCase(),
    bcrypt.hashSync(password, 10),
    Math.floor(Date.now() / 1000),
  ]);
  log(`[seed] Admin account created: ${email}`);
}

/** Create tables if they are missing and seed defaults. Used by scripts/migrate.js. */
async function migrate() {
  await db.initSchema();
  await pricing.initSettings();
}

if (require.main === module && !isServerless) {
  (async () => {
    await migrate();
    if (!config.smm.key) console.warn('[config] SMM_API_KEY is not set - the provider API will not work.');
    if (!/^https?:/.test(config.publicUrl)) {
      console.warn('[config] PUBLIC_URL should be an absolute URL (M-Pesa callbacks use it).');
    }
    if (config.isProd && !config.cookieSecure) console.warn('[config] COOKIE_SECURE should be true in production (HTTPS).');
    await seedAdmin();
    const app = createApp();
    app.listen(config.port, '0.0.0.0', () => {
      console.log(`${config.siteName} running on http://localhost:${config.port} (db: ${db.dialect})`);
      jobs.start();
    });
  })().catch((err) => {
    console.error('[startup]', err);
    process.exit(1);
  });
}

module.exports = { createApp, seedAdmin, migrate };
