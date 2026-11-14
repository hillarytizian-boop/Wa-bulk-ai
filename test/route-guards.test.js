// Deny-by-default: every route in the app is enumerated at runtime and must either be on the
// explicit public list or refuse an anonymous caller. This is the regression guard that catches the
// next endpoint someone adds without an auth check - the failure mode the audit called out.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const mockProvider = require('./mock-provider');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  FAIL ${name}\n       ${err.stack.split('\n').slice(0, 5).join('\n       ')}`);
  }
}

/**
 * Routes that must work without a session, and why. Everything else must answer 401/403.
 * Adding a route here is a deliberate act: it says "this may be called by a stranger".
 */
const PUBLIC = new Map([
  ['GET /api/meta', 'brand, currency and payment switches for the storefront'],
  ['GET /api/services', 'public catalogue - retail KES prices only, no provider telemetry'],
  ['GET /api/services/:id', 'single service detail for the order form'],
  ['GET /api/quote', 'price calculator used before login'],
  ['GET /api/trending', 'public "hot right now" shelf'],
  ['POST /api/recommend', 'paste-a-link finder'],
  ['POST /api/events', 'aggregate funnel counter; allowlisted names only, no identifier stored'],
  ['GET /api/auth/me', 'answers {user:null} when there is no session'],
  ['POST /api/auth/login', 'sign-in'],
  ['POST /api/auth/register', 'sign-up'],
  ['POST /api/auth/logout', 'clears the cookie; harmless when already signed out'],
  ['POST /api/auth/forgot', 'password reset request; always answers 200 so it cannot be used to enumerate accounts'],
  ['POST /api/auth/reset', 'password reset completion; the emailed token is the credential'],
  ['GET /api/auth/reset/:token', 'validity probe so the reset screen can say "link expired"'],
  ['GET /api/auth/google', 'OAuth start'],
  ['GET /api/auth/google/callback', 'OAuth return'],
  ['GET /api/cron/tick', 'Vercel cron; gated by CRON_SECRET inside the handler'],
  ['POST /api/wallet/mpesa/callback/:secret', 'PayHero callback; gated by a derived secret in the path'],
]);

(async () => {
  const mock = await mockProvider.start(0);
  const dbFile = path.join(os.tmpdir(), `smm-guards-test-${process.pid}.db`);
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });

  Object.assign(process.env, {
    DATABASE_PATH: dbFile,
    JWT_SECRET: 'guards-test-secret',
    ADMIN_EMAIL: 'boss@panel.test',
    ADMIN_PASSWORD: 'Sup3rSecret!2024',
    SMM_API_URL: `http://127.0.0.1:${mock.port}/api/v3`,
    SMM_API_KEY: mockProvider.API_KEY,
    AUTH_RATE_LIMIT: '500',
    BCRYPT_ROUNDS: '10',
    NODE_ENV: 'test',
    CRON_SECRET: '',
  });

  const { createApp, seedAdmin, migrate } = require('../src/webapp');
  await migrate();
  await seedAdmin({ log: () => {} });
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(pathname, { method = 'GET', body, cookie, headers = {} } = {}) {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not json */
    }
    return { status: res.status, data, headers: res.headers, cookie: res.headers.get('set-cookie') };
  }

  /** Every route registered on the app, with mount prefixes resolved. */
  function collectRoutes() {
    const out = [];
    const mountOf = (layer) =>
      layer.regexp.source
        .replace(/^\^/, '')
        .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
        .replace(/\\\//g, '/')
        .replace(/\$$/, '');
    const walk = (stack, prefix) => {
      for (const layer of stack) {
        if (layer.route) {
          for (const method of Object.keys(layer.route.methods)) {
            if (method === '_all') continue;
            out.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`.replace(/\/$/, '') || `${method.toUpperCase()} ${prefix}`);
          }
        } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
          walk(layer.handle.stack, prefix + mountOf(layer));
        }
      }
    };
    walk(app._router.stack, '');
    return [...new Set(out.filter((r) => r.includes(' /api')))].sort();
  }

  const concrete = (route) =>
    route.replace(':secret', 'not-the-secret').replace(/:id/g, '1').replace(/:(\w+)/g, 'x');

  const routes = collectRoutes();

  console.log('route guards');

  await test('every /api route is either explicitly public or refuses an anonymous caller', async () => {
    const offenders = [];
    for (const route of routes) {
      const [method, template] = route.split(' ');
      const res = await call(concrete(template), {
        method,
        body: method === 'POST' ? {} : undefined,
      });
      const guarded = res.status === 401 || res.status === 403;
      if (!PUBLIC.has(route) && !guarded) {
        offenders.push(`${route} -> ${res.status} (reachable without a session and not on the public list)`);
      }
    }
    assert.deepEqual(offenders, [], `unguarded API routes:\n  ${offenders.join('\n  ')}`);
  });

  await test('the explicit public list matches real routes, so it cannot rot silently', () => {
    const missing = [...PUBLIC.keys()].filter((r) => !routes.includes(r));
    assert.deepEqual(missing, [], `public list mentions routes that no longer exist: ${missing.join(', ')}`);
  });

  await test('anonymous catalogue carries retail prices but no provider telemetry', async () => {
    const res = await call('/api/services?per_page=1');
    assert.equal(res.status, 200);
    const service = res.data.services[0];
    assert.ok(service, 'a service came back');
    assert.ok(typeof service.rate_cents === 'number', 'customers see a KES price');
    for (const leaked of ['reliability', 'drop_rate', 'provider_cost', 'provider_cost_usd_micros', 'cost_usd']) {
      assert.equal(service[leaked], undefined, `${leaked} must not be in the anonymous payload`);
    }
  });

  await test('an admin still sees the internal telemetry (so support can triage)', async () => {
    const login = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'boss@panel.test', password: 'Sup3rSecret!2024' },
    });
    assert.equal(login.status, 200);
    const session = String(login.cookie || '').split(';')[0];
    const res = await call('/api/services?per_page=1', { cookie: session });
    assert.equal(res.status, 200);
    assert.ok('reliability' in res.data.services[0], 'admin payload keeps reliability');
  });

  await test('the API never answers a foreign Origin with a wildcard CORS header', async () => {
    for (const route of ['/api/meta', '/api/services']) {
      const res = await call(route, { headers: { Origin: 'https://evil.example' } });
      const allow = res.headers.get('access-control-allow-origin');
      assert.equal(allow, null, `${route} must not send Access-Control-Allow-Origin (got ${allow})`);
    }
    // a cross-origin state-changing call is refused outright, not merely unreadable
    const post = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'boss@panel.test', password: 'Sup3rSecret!2024' },
      headers: { Origin: 'https://evil.example' },
    });
    assert.ok(post.status === 403 || post.status === 401, `cross-origin login answered ${post.status}`);
  });

  await test('API responses are marked noindex', async () => {
    const res = await call('/api/meta');
    assert.match(String(res.headers.get('x-robots-tag') || ''), /noindex/i);
  });

  await test('robots.txt no longer advertises the console or the API', () => {
    const txt = fs.readFileSync(path.join(__dirname, '..', 'public', 'robots.txt'), 'utf8');
    assert.ok(!/^\s*Disallow:/m.test(txt), 'no Disallow lines left to point scanners at /admin');
    assert.match(txt, /Allow: \//);
  });

  await test('failed logins are counted in the shared table and lock the account after 6', async () => {
    const db = require('../src/db');
    const before = await db.one("SELECT count(*) AS n FROM rate_limits WHERE key LIKE 'login|%'");
    for (let i = 0; i < 6; i += 1) {
      const res = await call('/api/auth/login', {
        method: 'POST',
        body: { email: 'boss@panel.test', password: `wrong-${i}` },
      });
      assert.equal(res.status, 401);
    }
    const locked = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'boss@panel.test', password: 'Sup3rSecret!2024' },
    });
    assert.equal(locked.status, 429, 'the correct password is refused while the account is locked');
    assert.match(String(locked.data.error), /too many failed attempts/i);

    const after = await db.one("SELECT count(*) AS n FROM rate_limits WHERE key LIKE 'login|%'");
    assert.ok(Number(after.n) > Number(before.n), 'a counter row was written to the database');

    // a correct login from elsewhere still works, and clears the counter for that key
    await new Promise((r) => setTimeout(r, 10));
    await db.run("DELETE FROM rate_limits WHERE key LIKE 'login|%'");
    const ok = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'boss@panel.test', password: 'Sup3rSecret!2024' },
    });
    assert.equal(ok.status, 200);
  });

  await test('the storefront is told which terms version is current', async () => {
    const config = require('../src/config');
    const res = await call('/api/meta');
    assert.equal(res.status, 200);
    assert.equal(res.data.termsVersion, config.terms.version);
    assert.ok(res.data.termsUpdated, 'the terms page needs a date to show');
  });

  await test('passwords are hashed with the configured bcrypt cost, defaulting to 12', () => {
    const config = require('../src/config');
    assert.equal(config.bcryptRounds, Number(process.env.BCRYPT_ROUNDS), 'this suite pins the cost');
    // the shipped default, in a process that has no BCRYPT_ROUNDS
    const out = execFileSync(
      process.execPath,
      ['-e', "process.stdout.write(String(require('./src/config').bcryptRounds))"],
      { cwd: path.join(__dirname, '..'), env: { ...process.env, BCRYPT_ROUNDS: '', NODE_ENV: 'test' } }
    ).toString();
    assert.equal(out.trim(), '12');
    const db = require('../src/db').raw;
    const row = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('boss@panel.test');
    const cost = Number(String(row.password_hash).split('$')[2]);
    assert.equal(cost, config.bcryptRounds, 'stored hash uses the configured cost');
  });

  server.close();
  mock.server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
