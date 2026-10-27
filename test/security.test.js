// Security regression tests: password storage, session handling, CSRF, authz boundaries.
// Runs against a real HTTP server on an ephemeral port with a throwaway database.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  FAIL ${name}\n       ${err.stack.split('\n').slice(0, 4).join('\n       ')}`);
  }
}

(async () => {
  const dbFile = path.join(os.tmpdir(), `smm-security-test-${process.pid}.db`);
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });

  const ADMIN_EMAIL = 'boss@panel.test';
  const ADMIN_PASSWORD = 'Sup3rSecret!2024';
  Object.assign(process.env, {
    DATABASE_PATH: dbFile,
    JWT_SECRET: 'security-test-secret',
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    SMM_API_KEY: 'provider-secret-key-do-not-leak',
    AUTH_RATE_LIMIT: '500', // this suite deliberately makes many auth calls
    NODE_ENV: 'test',
    KES_PER_USD: '129',
  });

  const pricing = require('../src/pricing');
  const db = require('../src/db');
  const raw = db.raw;
  const { createApp, seedAdmin, migrate } = require('../src/webapp');
  await migrate();
  await seedAdmin({ log: () => {} });

  const app = createApp();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  /** Minimal fetch wrapper that reports status, json and set-cookie. */
  async function call(pathname, { method = 'GET', body, cookie, headers = {} } = {}) {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual',
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not json */
    }
    return { status: res.status, data, cookie: res.headers.get('set-cookie'), headers: res.headers };
  }

  const loginAs = async (email, password) => {
    const res = await call('/api/auth/login', { method: 'POST', body: { email, password } });
    const raw = res.cookie || '';
    return { ...res, session: raw.split(';')[0] };
  };

  console.log('security tests');

  await test('admin password is stored as a bcrypt hash, never in plaintext', () => {
    const row = raw.prepare('SELECT * FROM users WHERE email = ?').get(ADMIN_EMAIL);
    assert.ok(row, 'admin row exists');
    assert.equal(row.is_admin, 1);
    assert.match(row.password_hash, /^\$2[aby]\$/);
    assert.ok(!row.password_hash.includes(ADMIN_PASSWORD));
    const dump = JSON.stringify(raw.prepare('SELECT * FROM users').all());
    assert.ok(!dump.includes(ADMIN_PASSWORD), 'no table contains the plaintext password');
  });

  await test('session cookie is HttpOnly, SameSite=Strict and not readable by scripts', async () => {
    const res = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    assert.equal(res.status, 200);
    assert.match(res.cookie, /HttpOnly/i);
    assert.match(res.cookie, /SameSite=Strict/i);
    assert.doesNotMatch(res.cookie, /Secure/i); // COOKIE_SECURE=false in this test env
  });

  await test('wrong password is rejected without revealing whether the account exists', async () => {
    const wrong = await loginAs(ADMIN_EMAIL, 'not-the-password');
    const missing = await loginAs('nobody@panel.test', 'not-the-password');
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.equal(wrong.data.error, missing.data.error);
    assert.equal(wrong.cookie, null);
  });

  await test('repeated failures for one account are throttled (429)', async () => {
    const email = 'throttle@panel.test';
    raw.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?,'x',?)").run(email, 1);
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await loginAs(email, 'wrong-pass')).status;
    assert.equal(last, 429);
  });

  await test('API responses are not cacheable and carry security headers', async () => {
    const res = await call('/api/meta');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  await test('public API never exposes the provider key or provider USD rates', async () => {
    const meta = await call('/api/meta');
    const services = await call('/api/services');
    const blob = JSON.stringify(meta.data) + JSON.stringify(services.data);
    assert.ok(!blob.includes(process.env.SMM_API_KEY), 'provider key must never be returned');
    assert.ok(!/"rate"\s*:/.test(blob), 'no provider rate field');
    assert.ok(!blob.includes('kesPerUsd'), 'no internal FX setting');
  });

  await test('cross-site POSTs are blocked (CSRF origin check)', async () => {
    const res = await call('/api/auth/login', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.cookie, null);
  });

  await test('same-origin browser requests still work (preview/proxy Host handling)', async () => {
    const res = await call('/api/auth/login', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      headers: { Origin: 'https://3000-abc123.e2b.app' }, // dev preview iframe origin
    });
    assert.equal(res.status, 200);

    const sameHost = await call('/api/auth/login', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      headers: { Origin: base },
    });
    assert.equal(sameHost.status, 200);
  });

  await test('non-JSON bodies are rejected (no simple-form CSRF)', async () => {
    const res = await call('/api/auth/login', {
      method: 'POST',
      body: 'email=a&password=b',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
    });
    assert.equal(res.status, 415);
  });

  await test('authorization boundaries: anonymous 401, customer 403, admin 200', async () => {
    const anon = await call('/api/admin/stats');
    assert.equal(anon.status, 401);

    const customer = await call('/api/auth/register', { method: 'POST', body: { email: 'cust@panel.test', password: 'longpassword1' } });
    const customerCookie = (customer.cookie || '').split(';')[0];
    const forbidden = await call('/api/admin/stats', { cookie: customerCookie });
    assert.equal(forbidden.status, 403);

    const admin = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    const ok = await call('/api/admin/stats', { cookie: admin.session });
    assert.equal(ok.status, 200);
  });

  await test('password change signs out other sessions and keeps this device in', async () => {
    const first = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    const second = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);

    const changed = await call('/api/auth/password', {
      method: 'POST',
      body: { current_password: ADMIN_PASSWORD, new_password: 'EvenBetterPass!2025' },
      cookie: second.session,
    });
    assert.equal(changed.status, 200);
    const freshSession = (changed.cookie || '').split(';')[0];

    const stale = await call('/api/admin/stats', { cookie: first.session });
    assert.equal(stale.status, 401, 'old sessions are revoked');

    const current = await call('/api/admin/stats', { cookie: freshSession });
    assert.equal(current.status, 200, 'the device that changed it stays signed in');

    // restore for later tests
    raw.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(
      require('bcryptjs').hashSync(ADMIN_PASSWORD, 10),
      ADMIN_EMAIL
    );
  });

  await test('password change requires the current password and a >=8 char new one', async () => {
    const session = (await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD)).session;
    const bad = await call('/api/auth/password', {
      method: 'POST',
      body: { current_password: 'wrong', new_password: 'WhateverPass123' },
      cookie: session,
    });
    assert.equal(bad.status, 401);
    const short = await call('/api/auth/password', {
      method: 'POST',
      body: { current_password: ADMIN_PASSWORD, new_password: 'short' },
      cookie: session,
    });
    assert.equal(short.status, 400);
  });

  await test('tampered session cookies are rejected', async () => {
    const good = (await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD)).session;
    const tampered = good.slice(0, -4) + 'AAAA';
    const res = await call('/api/admin/stats', { cookie: tampered });
    assert.equal(res.status, 401);
  });

  await test('logout clears the cookie; logout-all revokes every session', async () => {
    const a = (await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD)).session;
    const b = (await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD)).session;
    const out = await call('/api/auth/logout', { method: 'POST', cookie: a });
    assert.equal(out.status, 200);
    assert.match(out.cookie, /token=;/);

    const all = await call('/api/auth/logout-all', { method: 'POST', cookie: b });
    assert.equal(all.status, 200);
    const after = await call('/api/admin/stats', { cookie: b });
    assert.equal(after.status, 401);
  });

  await test('admin actions are written to the audit log', async () => {
    const admin = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    const target = raw.prepare("INSERT INTO users (email, password_hash, created_at) VALUES ('audit@panel.test','x',?) RETURNING id").get(1);
    const credit = await call(`/api/admin/users/${target.id}/credit`, {
      method: 'POST',
      body: { amount_kes: 250, note: 'audit test' },
      cookie: admin.session,
    });
    assert.equal(credit.status, 200);
    const log = await call('/api/admin/audit', { cookie: admin.session });
    assert.equal(log.status, 200);
    assert.ok(log.data.entries.some((e) => e.action === 'wallet.adjust' && e.target === `user:${target.id}`));
  });

  await test('the M-Pesa callback ignores requests with a wrong secret', async () => {
    const topupsBefore = raw.prepare('SELECT COUNT(*) AS n FROM topups').get().n;
    const res = await call('/api/wallet/mpesa/callback/wrong-secret', {
      method: 'POST',
      body: { Body: { stkCallback: { CheckoutRequestID: 'nope', ResultCode: 0 } } },
    });
    assert.equal(res.status, 200); // always ack Daraja
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM topups').get().n, topupsBefore);
  });

  await test('wallet top-up validates the amount and requires login', async () => {
    const anon = await call('/api/wallet/topup', { method: 'POST', body: { phone: '0712345678', amount_kes: 500 } });
    assert.equal(anon.status, 401);

    const session = (await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD)).session;
    const tooSmall = await call('/api/wallet/topup', { method: 'POST', body: { phone: '0712345678', amount_kes: 1 }, cookie: session });
    assert.ok([400, 503].includes(tooSmall.status)); // 503 when M-Pesa is disabled
  });

  server.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
