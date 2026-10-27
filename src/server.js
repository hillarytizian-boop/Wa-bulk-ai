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

function createApp() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // `upgrade-insecure-requests` breaks plain-HTTP local development, so only keep it over HTTPS.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: config.cookieSecure ? {} : { 'upgrade-insecure-requests': null },
      },
    })
  );
  app.use(compression());
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  app.use(
    '/api',
    rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests' } })
  );
  app.use('/api', auth.loadUser);
  app.use('/api/auth', auth.router);
  app.use('/api/wallet', require('./routes/wallet'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api', require('./routes/shop'));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '1h' : 0 }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err && err.expose && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[error]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

/** Create the first admin account if the database has no users yet. */
function seedAdmin() {
  const { email, password } = config.admin;
  if (!email || !password) return;
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  if (config.isProd && password === 'change-this-password') {
    console.error('[seed] Refusing to create an admin with the default password in production. Set ADMIN_PASSWORD.');
    return;
  }
  db.prepare('INSERT INTO users (email, password_hash, is_admin, created_at) VALUES (?,?,1,?)').run(
    email.toLowerCase(),
    bcrypt.hashSync(password, 10),
    Math.floor(Date.now() / 1000)
  );
  console.log(`[seed] Admin account created: ${email}`);
}

if (require.main === module) {
  pricing.initSettings();
  if (!config.smm.key) console.warn('[config] SMM_API_KEY is not set - the provider API will not work.');
  if (!/^https?:/.test(config.publicUrl)) console.warn('[config] PUBLIC_URL should be an absolute URL (M-Pesa callbacks use it).');
  seedAdmin();
  const app = createApp();
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`${config.siteName} running on http://localhost:${config.port}`);
    jobs.start();
  });
}

module.exports = { createApp, seedAdmin };
