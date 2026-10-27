const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const path = require('path');

const config = require('./config');
const db = require('./db');
const pricing = require('./pricing');
const jobs = require('./jobs');
const auth = require('./routes/auth');
const { csrfGuard, noStore } = require('./security');

function createApp() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
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

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

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

  app.use('/api', apiLimiter, noStore, auth.loadUser, csrfGuard);
  app.use('/api/auth', auth.router);
  app.use('/api/admin', adminLimiter, require('./routes/admin'));
  app.use('/api/wallet', require('./routes/wallet'));
  app.use('/api', require('./routes/shop'));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
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
function seedAdmin({ log = console.log } = {}) {
  const { email, password } = config.admin;
  if (!email || !password) return;
  if (config.isProd && password === 'change-this-password') {
    console.error('[seed] Refusing to use the example ADMIN_PASSWORD in production. Set a real one.');
    return;
  }
  const existing = db.prepare('SELECT id, is_admin FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    if (!existing.is_admin) console.warn(`[seed] ${email} exists but is not an admin; promote it manually if intended.`);
    return;
  }
  db.prepare('INSERT INTO users (email, password_hash, is_admin, created_at) VALUES (?,?,1,?)').run(
    email.toLowerCase(),
    bcrypt.hashSync(password, 10),
    Math.floor(Date.now() / 1000)
  );
  log(`[seed] Admin account created: ${email}`);
}

if (require.main === module) {
  pricing.initSettings();
  if (!config.smm.key) console.warn('[config] SMM_API_KEY is not set - the provider API will not work.');
  if (!/^https?:/.test(config.publicUrl)) console.warn('[config] PUBLIC_URL should be an absolute URL (M-Pesa callbacks use it).');
  if (config.isProd && !config.cookieSecure) console.warn('[config] COOKIE_SECURE should be true in production (HTTPS).');
  seedAdmin();
  const app = createApp();
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`${config.siteName} running on http://localhost:${config.port}`);
    jobs.start();
  });
}

module.exports = { createApp, seedAdmin };
