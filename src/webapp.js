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
      hsts: config.cookieSecure ? { maxAge: 63072000, includeSubDomains: true } : false,
    })
  );
  app.use(compression());
  // Vercel's runtime reads the request body itself before the function runs, so by the time this
  // app sees a malformed JSON body the stream may already be consumed and the real parse error
  // belongs to the platform, not to us. Either way, a body we cannot read is a client mistake:
  // answer 400 and never 500, and never re-read a stream the runtime already drained.
  const jsonParser = express.json({ limit: '100kb' });
  const isBodyError = (err) => {
    if (!err) return false;
    const t = String(err.type || '');
    return (
      err instanceof SyntaxError ||
      t === 'entity.parse.failed' ||
      t.startsWith('entity.') ||
      t.startsWith('request.') ||
      t.startsWith('body.') ||
      err.code === 'ERR_STREAM_ALREADY_FINISHED' ||
      // Vercel's own body handling throws a bare Error("Invalid JSON") - no type, no status, not a
      // SyntaxError - so the message is the only signal left to go on.
      /invalid json|unexpected end of json|json at position|unexpected token|malformed|stream is not readable|already finished|aborted/i.test(String(err.message || ''))
    );
  };
  app.use((req, res, next) => {
    if (req.body !== undefined) return next(); // runtime already parsed it
    if (req.readableEnded || (req._readableState && req._readableState.endEmitted)) {
      req.body = {}; // drained by the runtime; there is nothing left to parse
      return next();
    }
    jsonParser(req, res, (err) => {
      if (!err) return next();
      if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
      if (isBodyError(err)) return res.status(400).json({ error: 'Invalid JSON' });
      return next(err);
    });
  });

  app.use(cookieParser());

  app.get('/healthz', async (_req, res) => {
    try {
      await db.one('SELECT 1 AS ok');
      // Verdict only: the dialect, uptime and version are free reconnaissance for anyone probing.
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true });
    } catch (err) {
      // Uptime checks only need the verdict; echoing a driver error here would leak schema and
      // host details to anyone who asks.
      console.error('[healthz] database check failed:', err && (err.message || err));
      res.status(503).json({ ok: false });
    }
  });

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });
  // Optional extra wall in front of the console (ADMIN_ALLOWLIST). Off by default: every
  // /api/admin/* route already needs an admin session, so this only buys "the console is not even
  // reachable from the public internet". A blocked caller gets the same 404 as any unknown path,
  // which avoids confirming that a console exists.
  const adminAllowlist = (config.admin && config.admin.allowlist) || [];
  const inList = (ip) => {
    const addr = String(ip || '').replace(/^::ffff:/, '');
    return adminAllowlist.some((entry) => {
      if (!entry.includes('/')) return entry === addr;
      const [base, bitsRaw] = entry.split('/');
      const bits = Number(bitsRaw);
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(base) || !/^\d+\.\d+\.\d+\.\d+$/.test(addr) || !(bits >= 0 && bits <= 32)) return false;
      const toLong = (v) => v.split('.').reduce((acc, part) => (acc << 8 >>> 0) + Number(part), 0) >>> 0;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (toLong(addr) & mask) === (toLong(base) & mask);
    });
  };
  const adminGate = (req, res, next) => {
    if (!adminAllowlist.length) return next();
    if (inList(req.ip)) return next();
    return res.status(404).json({ error: 'Not found' });
  };

  const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many admin requests' },
  });

  // Catalogue scraping is the cheapest abuse to mount against a public service list, so it gets
  // its own (tighter) budget on top of the global one. 120 pages/min is still far more than a
  // shopper can click through.
  const catalogLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });

  // The API is not a document: no crawler should index it (public/robots.txt disallows the same
  // paths, this header covers proxies that ignore robots.txt).
  app.use('/api', (_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
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

  // Cron entry point: Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`.
  // FAIL CLOSED: with no secret configured this used to run the whole job sweep for anyone who
  // asked, which let a stranger drive provider polling and DB writes on demand.
  app.get('/api/cron/tick', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      console.error('[cron] CRON_SECRET is not configured - refusing to run the sweep');
      return res.status(503).json({ error: 'Cron is not configured' });
    }
    const header = String(req.get('authorization') || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.token || '');
    const crypto = require('crypto');
    const a = Buffer.from(token);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });
    const result = await jobs.tick({ log: console.log });
    res.json({ ok: true, ...result });
  });

  app.use('/api', apiLimiter, noStore, auth.loadUser, csrfGuard);
  app.use('/api/services', catalogLimiter);
  app.use('/api/auth', auth.router);
  app.use('/api/admin', adminGate, adminLimiter, require('./routes/admin'));
  app.use('/api/wallet', require('./routes/wallet'));
  app.use('/api', require('./routes/events').router);
  app.use('/api', require('./routes/support'));
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

  // The admin console is a separate page on purpose: nothing admin-related ships in the
  // customer SPA any more. All of its data still comes from /api/admin/*, which returns 401
  // without a session and 403 without is_admin.
  const rootDir = staticDir || path.join(__dirname, '..', 'public');
  app.get(['/admin', '/admin.html'], adminGate, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.sendFile(path.join(rootDir, 'admin.html'));
  });

  // Crawler-facing pages (one per search phrase) and the dynamic sitemap. Mounted before the
  // static handler so /sitemap.xml and /p/* are generated, not read off disk.
  app.use(require('./routes/pages').router);

  app.use(
    express.static(rootDir, {
      maxAge: config.isProd ? '1h' : 0,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    // Some runtimes surface body-parser failures as a bare SyntaxError without `type`.
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    if (err && /^(entity|request|body)\./.test(String(err.type || ''))) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    if (err && !err.status && /invalid json|unexpected token|json at position|unexpected end of json/i.test(String(err.message || ''))) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    if (err && Number(err.status) >= 400 && Number(err.status) < 500) {
      // Client mistakes are not incidents: say what was wrong, log nothing scary.
      // HttpError carries its text in `message` (with expose=true); without this fallback every
      // validation error - "Insufficient wallet balance", "Minimum quantity is 100" - reached the
      // customer as the useless "Invalid request".
      const message = err.publicMessage || (err.expose && err.message ? err.message : null) || 'Invalid request';
      return res.status(err.status).json({ error: message });
    }
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

// The module exports the configured Express app. Starting a listener, seeding the admin and
// running migrations live in src/main.js so that importing this file never has side effects
// (a serverless entrypoint imports it on every cold start, where listening is fatal).
const app = createApp();
app.createApp = createApp;
app.seedAdmin = seedAdmin;
app.migrate = migrate;

module.exports = app;
