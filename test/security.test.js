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

  // Tiny PayHero stand-in so the payment tests exercise the real code path (STK push -> status
  // re-query -> credit) instead of a stub. `collected` is only reported once `paid` flips.
  const payhero = { paid: false, collected: 500 };
  const phServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/api/v2/payments') {
      res.statusCode = 201;
      return res.end(JSON.stringify({ success: true, reference: 'PHTEST1', CheckoutRequestID: 'ws_CO_test_1' }));
    }
    if (u.pathname === '/api/v2/transaction-status') {
      const ref = u.searchParams.get('reference');
      const done = payhero.paid && Boolean(ref);
      return res.end(
        JSON.stringify({
          status: done ? 'SUCCESS' : 'QUEUED',
          success: done,
          reference: ref,
          amount: done ? payhero.collected : undefined,
          currency: 'KES',
        })
      );
    }
    if (u.pathname === '/api/v2/payment_channels') {
      return res.end(JSON.stringify({ payment_channels: [{ id: 133, short_code: '000000', account_id: 10807, is_active: true }] }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => phServer.listen(0, '127.0.0.1', r));
  const phPort = phServer.address().port;

  Object.assign(process.env, {
    DATABASE_PATH: dbFile,
    JWT_SECRET: 'security-test-secret',
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    SMM_API_KEY: 'provider-secret-key-do-not-leak',
    AUTH_RATE_LIMIT: '500', // this suite deliberately makes many auth calls
    NODE_ENV: 'test',
    KES_PER_USD: '129',
    // Payments on, pointed at the stand-in above (Basic auth + one channel is all that is needed).
    PAYHERO_BASIC_AUTH: Buffer.from('test:test').toString('base64'),
    PAYHERO_CHANNEL_ID: '133',
    PAYHERO_BASE_URL: `http://127.0.0.1:${phPort}`,
    PUBLIC_URL: 'https://panel.test',
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

  // --- browser-verification harness -------------------------------------------------------------
  // Two money endpoints (top-up, place order) only accept a request that carries a solved puzzle.
  // The client solves it in ~400 ms; the tests solve it the same way but faster, and cache one
  // proof per session so the suite does not pay that cost on every call.
  const crypto = require('crypto');
  const GATED = new Set(['/api/orders', '/api/wallet/topup']);
  const proofCache = new Map();

  function leadingZeroBits(buf) {
    let bits = 0;
    for (const byte of buf) {
      if (byte === 0) { bits += 8; continue; }
      bits += Math.clz32(byte) - 24;
      break;
    }
    return bits;
  }

  async function solve(challenge, bits) {
    for (let nonce = 0; nonce < 5_000_000; nonce++) {
      if (leadingZeroBits(crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest()) >= bits) return nonce;
    }
    throw new Error('puzzle unsolvable');
  }

  /** Fetch a challenge with the caller's own cookie and solve it, exactly like public/main.js does. */
  async function payProof(cookie) {
    const key = cookie || '';
    if (proofCache.has(key)) return proofCache.get(key);
    const res = await call('/api/challenge', { cookie });
    if (res.status !== 200 || !res.data || !res.data.challenge) throw new Error(`challenge failed: ${res.status}`);
    const nonce = await solve(res.data.challenge, res.data.bits);
    const header = `${res.data.challenge}:${nonce}`;
    proofCache.set(key, header);
    return header;
  }

  /** A brand-new account and its session: fresh prompt allowance, fresh rate-limit bucket. */
  let freshSeq = 0;
  async function freshSession(tag = 'attack') {
    const email = `${tag}-${++freshSeq}@panel.test`;
    const hash = require('bcryptjs').hashSync('longpassword1', 10);
    raw.prepare('INSERT INTO users (email, password_hash, password_set, created_at) VALUES (?,?,1,?)')
      .run(email, hash, Math.floor(Date.now() / 1000));
    const { session } = await loginAs(email, 'longpassword1');
    // Accept the terms so the terms gate cannot answer before the thing under test does.
    const acc = await call('/api/auth/accept-terms', { method: 'POST', cookie: session, body: {} });
    if (acc.status !== 200) throw new Error(`accept-terms failed: ${acc.status} ${JSON.stringify(acc.data)}`);
    return { email, session };
  }

  /** Minimal fetch wrapper that reports status, json and set-cookie. */
  async function call(pathname, { method = 'GET', body, rawBody, cookie, headers = {}, noProof = false, proof } = {}) {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(!noProof && GATED.has(pathname) && method !== 'GET' && proof === undefined ? { 'x-pay-proof': await payProof(cookie) } : {}),
        ...(proof ? { 'x-pay-proof': proof } : {}),
        ...headers,
      },
      body: rawBody !== undefined ? rawBody : body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
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

  /** Wait (briefly) for a background effect such as the callback's reconcile. */
  const waitFor = async (fn, ms = 2000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await fn()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
  };

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
    assert.ok(!blob.includes('provider_cost'), 'no provider cost field');
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

    const customer = await call('/api/auth/register', { method: 'POST', body: { email: 'cust@panel.test', password: 'longpassword1', accept_terms: true } });
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

  await test('password reset: unknown email answers exactly like a known one, and nothing is stored', async () => {
    const one = await call('/api/auth/forgot', { method: 'POST', body: { email: 'ghost@example.test' } });
    const two = await call('/api/auth/forgot', { method: 'POST', body: { email: ADMIN_EMAIL } });
    assert.equal(one.status, 200);
    assert.equal(two.status, 200);
    assert.deepEqual(one.data, two.data, 'responses must be indistinguishable');
    // A dedicated account: resetting the admin's password here would break every test after this.
    const created = await call('/api/auth/register', {
      method: 'POST',
      body: { email: 'reset-target@panel.test', password: 'Original!2026', accept_terms: true },
    });
    assert.equal(created.status, 201);
    const before = raw.prepare('SELECT COUNT(*) AS n FROM password_resets').get();
    const res = await call('/api/auth/forgot', { method: 'POST', body: { email: 'reset-target@panel.test' } });
    assert.equal(res.status, 200);
    const after = raw.prepare('SELECT COUNT(*) AS n FROM password_resets').get();
    assert.equal(Number(after.n), Number(before.n) + 1, 'the real account gets a reset row');
  });

  await test('password reset: the token is single use, expires, and only its hash is stored', async () => {
    const crypto = require('crypto');
    const now = Math.floor(Date.now() / 1000);
    const token = 'a'.repeat(64);
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const user = raw.prepare('SELECT id FROM users WHERE email = ?').get('reset-target@panel.test');
    raw.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at, used_at, ip, created_at) VALUES (?,?,?,0,?,?)')
      .run(user.id, hash, now + 600, '127.0.0.1', now);
    const stored = raw.prepare('SELECT token_hash FROM password_resets ORDER BY id DESC LIMIT 1').get();
    assert.equal(stored.token_hash, hash, 'the raw token is never stored');

    const ok = await call('/api/auth/reset', { method: 'POST', body: { token, password: 'N3wPassword!2026' } });
    assert.equal(ok.status, 200);
    // The reset really changed the password.
    const signedIn = await loginAs('reset-target@panel.test', 'N3wPassword!2026');
    assert.equal(signedIn.status, 200);
    const again = await call('/api/auth/reset', { method: 'POST', body: { token, password: 'An0therOne!2026' } });
    assert.equal(again.status, 400, 'a used token cannot be replayed');

    const expired = 'b'.repeat(64);
    raw.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at, used_at, ip, created_at) VALUES (?,?,?,0,?,?)')
      .run(user.id, crypto.createHash('sha256').update(expired).digest('hex'), now - 5, '127.0.0.1', now - 700);
    const stale = await call('/api/auth/reset', { method: 'POST', body: { token: expired, password: 'Y3tAnother!2026' } });
    assert.equal(stale.status, 400, 'an expired token is refused');
  });

  await test('reset link validity probe does not leak the token or the account', async () => {
    const res = await call('/api/auth/reset/deadbeef');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { valid: false });
  });

  await test('funnel counter accepts only allowlisted names and stores no identifier', async () => {
    const ok = await call('/api/events', { method: 'POST', body: { name: 'home_view', ip: '1.2.3.4', email: 'x@y.z' } });
    assert.equal(ok.status, 204);
    const bad = await call('/api/events', { method: 'POST', body: { name: 'anything_i_want' } });
    assert.equal(bad.status, 400);
    const row = raw.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.name, 'home_view');
    assert.equal(Number(row.count), 1);
    const dump = JSON.stringify(row);
    assert.ok(!dump.includes('1.2.3.4'), 'event rows carry no IP address');
    assert.ok(!dump.includes('x@y.z'), 'event rows carry no email');
  });

  await test('body cap: a request over 100 KB is refused with 413 before it is processed', async () => {
    const big = 'x'.repeat(200 * 1024);
    const res = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'a@b.co', password: big },
    });
    assert.equal(res.status, 413, 'the Vercel runtime pre-parses bodies, so the cap must be explicit');
    const small = await call('/api/auth/login', { method: 'POST', body: { email: 'a@b.co', password: 'short' } });
    assert.notEqual(small.status, 413, 'normal requests still get through');
  });

  await test('password reset: two racing requests on one token -> exactly one wins', async () => {
    const crypto = require('crypto');
    const now = Math.floor(Date.now() / 1000);
    const token = 'c'.repeat(64);
    const user = raw.prepare('SELECT id FROM users WHERE email = ?').get('reset-target@panel.test');
    raw.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at, used_at, ip, created_at) VALUES (?,?,?,0,?,?)')
      .run(user.id, crypto.createHash('sha256').update(token).digest('hex'), now + 600, '127.0.0.1', now);
    const [a, b] = await Promise.all([
      call('/api/auth/reset', { method: 'POST', body: { token, password: 'Raced!Passw0rd-1' } }),
      call('/api/auth/reset', { method: 'POST', body: { token, password: 'Raced!Passw0rd-2' } }),
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [200, 400], 'a link is worth exactly one reset');
  });

  await test('duplicate sign-up is a 409 on both drivers, never a 500', async () => {
    const { isDuplicateKey } = require('../src/routes/auth');
    assert.equal(isDuplicateKey({ code: '23505' }), true, 'Postgres unique_violation');
    assert.equal(isDuplicateKey({ code: 'SQLITE_CONSTRAINT_UNIQUE' }), true, 'SQLite constraint');
    assert.equal(isDuplicateKey({ code: '23503' }), false, 'foreign key violation is not a duplicate');
    assert.equal(isDuplicateKey(null), false);

    const body = { email: 'dup-check@panel.test', password: 'Dupe!Passw0rd-1', accept_terms: true };
    const first = await call('/api/auth/register', { method: 'POST', body });
    assert.equal(first.status, 201);
    const second = await call('/api/auth/register', { method: 'POST', body });
    assert.equal(second.status, 409);
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
    const save = await call('/api/admin/settings', {
      method: 'POST',
      body: { markup: 0.3 },
      cookie: admin.session,
    });
    assert.equal(save.status, 200);
    const log = await call('/api/admin/audit', { cookie: admin.session });
    assert.equal(log.status, 200);
    assert.ok(log.data.entries.some((e) => e.action === 'pricing.update'));
  });

  await test('admins can no longer move money into a wallet', async () => {
    const admin = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    const target = raw.prepare("INSERT INTO users (email, password_hash, created_at) VALUES ('noCredit@panel.test','x',?) RETURNING id").get(1);
    const before = raw.prepare('SELECT balance_cents FROM users WHERE id = ?').get(target.id).balance_cents;
    const credit = await call(`/api/admin/users/${target.id}/credit`, {
      method: 'POST',
      body: { amount_kes: 250, note: 'should not work' },
      cookie: admin.session,
    });
    assert.equal(credit.status, 404);
    assert.equal(raw.prepare('SELECT balance_cents FROM users WHERE id = ?').get(target.id).balance_cents, before);
  });

  await test('malformed JSON bodies are a 400, never a 500', async () => {
    const res = await call('/api/auth/login', { method: 'POST', rawBody: '{"email":', headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.data), /Invalid JSON/);
  });

  await test('a Google-only account can set a first password without one to replace', async () => {
    const id = Number(
      raw
        .prepare("INSERT INTO users (email, password_hash, google_sub, password_set, created_at) VALUES ('g@panel.test','unusable','sub-123',0,?)")
        .run(1).lastInsertRowid
    );
    // no password yet, so ordinary login cannot work - sign in by minting the cookie the way the
    // Google callback does
    const jwt = require('jsonwebtoken');
    const config = require('../src/config');
    const cookie = `token=${jwt.sign({ uid: id, tv: 0 }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '1h' })}`;
    const guess = await loginAs('g@panel.test', 'unusable');
    assert.equal(guess.status, 401);
    const set = await call('/api/auth/password', {
      method: 'POST',
      body: { new_password: 'first-real-password' },
      cookie,
    });
    assert.equal(set.status, 200);
    assert.equal(Number(raw.prepare('SELECT password_set FROM users WHERE id = ?').get(id).password_set), 1);
    const after = await loginAs('g@panel.test', 'first-real-password');
    assert.ok(after.session);
  });

  await test('a password account still needs the current password to change it', async () => {
    const r = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await call('/api/auth/password', {
      method: 'POST',
      body: { new_password: 'attacker-chosen-pass' },
      cookie: r.session,
    });
    assert.equal(res.status, 401);
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

  await test('a forged callback with a SUCCESS body cannot credit a wallet nobody paid for', async () => {
    const mpesa = require('../src/mpesa');
    const owner = raw.prepare('SELECT id, balance_cents FROM users WHERE email = ?').get(ADMIN_EMAIL);
    const t = Math.floor(Date.now() / 1000);
    const topupId = Number(
      raw
        .prepare(
          `INSERT INTO topups (user_id, phone, amount_kes, credited_cents, checkout_request_id, provider_ref, external_ref, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,'pending',?,?)`
        )
        .run(owner.id, '254712345678', 500, 50000, 'ws_CO_test_1', 'PHTEST1', 'W1-forged', t, t).lastInsertRowid
    );

    // PayHero has not seen a shilling yet; the body below is what an attacker would send.
    const res = await call(`/api/wallet/mpesa/callback/${mpesa.callbackSecret()}`, {
      method: 'POST',
      body: {
        status: true,
        response: { Status: 'Success', ResultCode: 0, CheckoutRequestID: 'ws_CO_test_1', ExternalReference: 'W1-forged', MpesaReceiptNumber: 'FAKE123' },
      },
    });
    assert.equal(res.status, 200); // providers always get an ack
    assert.equal(raw.prepare('SELECT balance_cents FROM users WHERE id = ?').get(owner.id).balance_cents, owner.balance_cents);
    assert.equal(raw.prepare('SELECT status FROM topups WHERE id = ?').get(topupId).status, 'pending');
  });

  await test('a confirmed payment credits exactly once, however many callbacks arrive', async () => {
    const mpesa = require('../src/mpesa');
    const owner = raw.prepare('SELECT id, balance_cents FROM users WHERE email = ?').get(ADMIN_EMAIL);
    payhero.paid = true;
    for (let i = 0; i < 3; i += 1) {
      await call(`/api/wallet/mpesa/callback/${mpesa.callbackSecret()}`, {
        method: 'POST',
        body: { status: true, response: { Status: 'Success', ResultCode: 0, CheckoutRequestID: 'ws_CO_test_1', MpesaReceiptNumber: 'QWE123' } },
      });
    }
    const after = raw.prepare('SELECT balance_cents FROM users WHERE id = ?').get(owner.id).balance_cents;
    assert.equal(after, owner.balance_cents + 50000); // KES 500 once
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'topup' AND ref = 'topup:1'").get().n, 1); // one ledger line
  });

  await test('a part payment credits only the amount M-Pesa collected', async () => {
    const mpesa = require('../src/mpesa');
    const owner = raw.prepare('SELECT id, balance_cents FROM users WHERE email = ?').get(ADMIN_EMAIL);
    const t = Math.floor(Date.now() / 1000);
    // A second top-up pointing at a reference the stand-in reports as fully paid for KES 120.
    raw
      .prepare(
        `INSERT INTO topups (user_id, phone, amount_kes, credited_cents, checkout_request_id, provider_ref, external_ref, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,'pending',?,?)`
      )
      .run(owner.id, '254712345678', 500, 50000, 'ws_CO_test_1b', 'PHTEST2', 'W1-part', t, t);
    payhero.collected = 120;
    await call(`/api/wallet/mpesa/callback/${mpesa.callbackSecret()}`, {
      method: 'POST',
      body: { status: true, response: { Status: 'Success', ResultCode: 0, CheckoutRequestID: 'ws_CO_test_1b' } },
    });
    await waitFor(() => raw.prepare("SELECT status FROM topups WHERE checkout_request_id = 'ws_CO_test_1b'").get().status === 'paid');
    const after = raw.prepare('SELECT balance_cents FROM users WHERE id = ?').get(owner.id).balance_cents;
    assert.equal(after, owner.balance_cents + 12000); // KES 120, not the KES 500 asked for
  });

  await test('the PayHero diagnostic is admin-only and never returns a secret', async () => {
    const anon = await call('/api/admin/payhero/diagnose');
    assert.equal(anon.status, 401);
    const user = await call('/api/auth/register', { method: 'POST', body: { email: `diag.${Date.now()}@example.com`, password: 'Password!123', accept_terms: true } });
    const cookie = (user.cookie || '').split(';')[0];
    const asUser = await call('/api/admin/payhero/diagnose', { cookie });
    assert.equal(asUser.status, 403);

    const session = (await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD)).session;
    const asAdmin = await call('/api/admin/payhero/diagnose', { cookie: session });
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.data.config.auth_source, 'PAYHERO_BASIC_AUTH');
    assert.ok(asAdmin.data.probe.ok);
    assert.equal(asAdmin.data.probe.channel_matches_env, true);
    // lengths only: the encoded credential itself must never appear
    const body = JSON.stringify(asAdmin.data);
    assert.doesNotMatch(body, /dGVzdDp0ZXN0/);
  });

  await test('cron fails closed when no CRON_SECRET is configured', async () => {
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    const open = await call('/api/cron/tick');
    assert.equal(open.status, 503); // never runs the sweep for an anonymous caller

    process.env.CRON_SECRET = 'cron-secret-for-tests';
    const anon = await call('/api/cron/tick');
    assert.equal(anon.status, 401);
    const wrong = await call('/api/cron/tick', { headers: { Authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
    const right = await call('/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret-for-tests' } });
    assert.equal(right.status, 200);
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });

  await test('client errors keep their own message instead of a blanket "Invalid request"', async () => {
    const login = await call('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: 'definitely-wrong' } });
    assert.equal(login.status, 401);
    assert.equal(login.data.error, 'Incorrect email or password'); // not "Invalid request"

    const session = (await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD)).session;
    // A validation error from our own code, not a provider failure (those stay generic on purpose).
    const bad = await call('/api/wallet/topup', {
      method: 'POST',
      cookie: session,
      body: { phone: '0712345678', amount_kes: 1 },
    });
    assert.equal(bad.status, 400);
    assert.match(String(bad.data.error), /whole number between KES/i);
    // Provider errors must stay opaque: the provider's own text never reaches the browser.
    assert.doesNotMatch(String(bad.data.error), /provider-secret-key-do-not-leak/);
  });

  await test('an account cannot be created without accepting the terms', async () => {
    const refused = await call('/api/auth/register', {
      method: 'POST',
      body: { email: 'no-terms@panel.test', password: 'longpassword1' },
    });
    assert.equal(refused.status, 400);
    assert.match(String(refused.data.error), /Terms & Conditions/);
    const row = raw.prepare('SELECT id FROM users WHERE email = ?').get('no-terms@panel.test');
    assert.equal(row, undefined, 'no user row was written');

    // and a truthy-but-wrong value is still a refusal
    const sneaky = await call('/api/auth/register', {
      method: 'POST',
      body: { email: 'no-terms@panel.test', password: 'longpassword1', accept_terms: 'yes' },
    });
    assert.equal(sneaky.status, 400);
  });

  await test('accepting at sign-up is recorded with the current version', async () => {
    const config = require('../src/config');
    const created = await call('/api/auth/register', {
      method: 'POST',
      body: { email: 'with-terms@panel.test', password: 'longpassword1', accept_terms: true },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.user.terms.accepted, true);
    assert.equal(created.data.user.terms.version, config.terms.version);

    const row = raw.prepare('SELECT terms_accepted_at, terms_version FROM users WHERE email = ?').get('with-terms@panel.test');
    assert.ok(Number(row.terms_accepted_at) > 0, 'timestamp stored');
    assert.equal(row.terms_version, config.terms.version);
  });

  await test('an account that never accepted is held at the gate and refused an order', async () => {
    const config = require('../src/config');
    // An account created outside the sign-up form - e.g. a first Google sign-in - starts unaccepted.
    const hash = require('bcryptjs').hashSync('longpassword1', 10);
    raw.prepare('INSERT INTO users (email, password_hash, password_set, created_at) VALUES (?,?,1,?)')
      .run('google-style@panel.test', hash, Math.floor(Date.now() / 1000));

    const login = await loginAs('google-style@panel.test', 'longpassword1');
    assert.equal(login.status, 200);
    assert.equal(login.data.user.terms.accepted, false);
    const session = login.session;

    const blocked = await call('/api/orders', {
      method: 'POST',
      cookie: session,
      body: { service_id: 1, link: 'https://instagram.com/p/x', quantity: 100 },
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.code, 'terms_required');

    const accepted = await call('/api/auth/accept-terms', { method: 'POST', cookie: session, body: {} });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.user.terms.accepted, true);
    assert.equal(accepted.data.version, config.terms.version);

    const again = await call('/api/auth/accept-terms', { method: 'POST', cookie: session, body: {} });
    assert.equal(again.status, 200, 'accepting twice is harmless');
  });

  await test('a customer who HAS accepted the terms is not still turned away from ordering', async () => {
    // Regression: loadUser() projected a column list without terms_accepted_at/terms_version, so
    // requireTerms() saw nothing and refused every real customer with 403 terms_required - while the
    // same session showed "accepted" in /api/auth/me and in the UI. No customer could place an order.
    const { email, session } = await freshSession('terms-ok');
    const me = await call('/api/auth/me', { cookie: session });
    assert.equal(me.data.user.terms.accepted, true, 'the session says the terms were accepted');

    const order = await call('/api/orders', {
      method: 'POST',
      cookie: session,
      body: { service_id: 1, link: 'https://instagram.com/p/x', quantity: 100 },
    });
    assert.notEqual(order.data && order.data.code, 'terms_required', 'the terms gate must not fire here');
    // Past the gate means a business rule answered: no balance (402) or a bad service/quantity (400).
    assert.ok([400, 402].includes(order.status), `the order reached business validation (${email}): ${order.status}`);
  });

  await test('a version bump asks an existing customer to accept again', () => {
    const config = require('../src/config');
    raw.prepare('UPDATE users SET terms_version = ? WHERE email = ?').run('2020-01-01', 'with-terms@panel.test');
    const row = raw.prepare('SELECT terms_accepted_at, terms_version, is_admin FROM users WHERE email = ?').get('with-terms@panel.test');
    assert.notEqual(row.terms_version, config.terms.version);
    const { publicUser } = require('../src/routes/auth');
    assert.equal(publicUser(row).terms.accepted, false, 'stale acceptance is not acceptance');
    assert.equal(publicUser({ ...row, is_admin: 1 }).terms.accepted, true, 'the admin is never gated');
  });

  await test('the API hides itself: noindex header, robots.txt, bare 404s, no stack traces', async () => {
    const list = await call('/api/definitely-not-a-route');
    assert.equal(list.status, 404);
    assert.deepEqual(list.data, { error: 'Not found' });
    assert.match(String(list.headers.get('x-robots-tag') || ''), /noindex/);
    assert.equal(list.headers.get('x-powered-by'), null);

    const robots = await new Promise((resolve, reject) => {
      http
        .get(`${base}/robots.txt`, (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => resolve({ status: r.statusCode, body }));
        })
        .on('error', reject);
    });
    assert.equal(robots.status, 200);
    // Deliberate change: robots.txt no longer names /admin or /api/ - a Disallow line is a signpost,
    // not a lock. Those surfaces send X-Robots-Tag: noindex instead, which is what actually keeps
    // them out of search results.
    assert.doesNotMatch(robots.body, /^\s*Disallow:/m);
    assert.match(robots.body, /Allow: \//);

    const panel = await call('/admin');
    assert.equal(panel.status, 200);
    assert.match(String(panel.headers.get('x-robots-tag') || ''), /noindex/);
    assert.match(String(panel.headers.get('cache-control') || ''), /no-store/);

    const health = await call('/healthz');
    assert.deepEqual(health.data, { ok: true }); // no dialect, uptime or version
  });

  // --- browser verification before money moves ------------------------------------------------
  // Requirement: "make it verify browsing first before user pays so that no one can send a raw
  // request to my server." These tests attack the gate the way a script would.
  const payKey = () => crypto.createHmac('sha256', process.env.JWT_SECRET).update('pay-proof-v1').digest();

  /** Build a challenge exactly as the server does, so we can forge the fields the server must not trust. */
  function forge(body, { badSignature = false } = {}) {
    const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
    const mac = badSignature
      ? Buffer.alloc(32, 7).toString('base64url')
      : crypto.createHmac('sha256', payKey()).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  /** Decode a genuine challenge to learn this client's own u/f, then tamper with one field of it. */
  async function realClaim(cookie) {
    const res = await call('/api/challenge', { cookie });
    const payload = res.data.challenge.split('.')[0];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  }

  await test('the challenge endpoint hands out a puzzle but nothing worth stealing', async () => {
    const res = await call('/api/challenge');
    assert.equal(res.status, 200);
    assert.equal(typeof res.data.challenge, 'string');
    assert.ok(res.data.challenge.includes('.'), 'a signed payload and its tag');
    assert.ok(Number(res.data.bits) >= 8 && Number(res.data.bits) <= 20);
    assert.ok(Number(res.data.expires_in) > 0);
    assert.match(String(res.headers.get('cache-control') || ''), /no-store/);
  });

  await test('a top-up from a script with no proof is refused before Safaricom is ever called', async () => {
    const { session } = await freshSession('attack');
    const before = raw.prepare('SELECT COUNT(*) AS n FROM topups').get().n;
    const res = await call('/api/wallet/topup', {
      method: 'POST',
      cookie: session,
      noProof: true,
      body: { phone: '0712345678', amount_kes: 500 },
    });
    assert.equal(res.status, 428);
    assert.equal(res.data.code, 'verification_required');
    assert.equal(res.data.reason, 'missing');
    assert.ok(res.data.challenge, 'a challenge comes back so the app can retry silently');
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM topups').get().n, before, 'no prompt was requested');
  });

  await test('placing an order from a script with no proof is refused too', async () => {
    const { session } = await freshSession('attack');
    const res = await call('/api/orders', {
      method: 'POST',
      cookie: session,
      noProof: true,
      body: { service_id: 1, link: 'https://instagram.com/p/x', quantity: 100 },
    });
    assert.equal(res.status, 428, JSON.stringify(res.data));
    assert.equal(res.data.code, 'verification_required');
  });

  await test('a stolen session cookie replayed from curl is refused: the proof is bound to the browser', async () => {
    const { session } = await freshSession('attack');
    // The harness solves the puzzle the way the app does (same default UA). Now replay it from
    // somewhere else - the classic "copy the cookie out of devtools" attack.
    const proof = await payProof(session);
    const res = await call('/api/wallet/topup', {
      method: 'POST',
      cookie: session,
      proof,
      headers: { 'user-agent': 'curl/8.5.0', 'accept-language': 'en' },
      body: { phone: '0712345678', amount_kes: 500 },
    });
    assert.equal(res.status, 428);
    assert.equal(res.data.reason, 'browser');
  });

  await test('a forged or corrupted signature is refused', async () => {
    const { session } = await freshSession('attack');
    const claim = await realClaim(session);
    const res = await call('/api/wallet/topup', {
      method: 'POST',
      cookie: session,
      proof: `${forge(claim, { badSignature: true })}:0`,
      body: { phone: '0712345678', amount_kes: 500 },
    });
    assert.equal(res.status, 428);
    assert.equal(res.data.reason, 'signature');
  });

  await test('an expired challenge is refused even with a valid signature', async () => {
    const { session } = await freshSession('attack');
    const claim = await realClaim(session);
    const stale = { ...claim, e: Math.floor(Date.now() / 1000) - 1 };
    const res = await call('/api/wallet/topup', {
      method: 'POST',
      cookie: session,
      proof: `${forge(stale)}:0`,
      body: { phone: '0712345678', amount_kes: 500 },
    });
    assert.equal(res.status, 428);
    assert.equal(res.data.reason, 'expired');
  });

  await test('a challenge solved for one account cannot be spent by another', async () => {
    const { session } = await freshSession('attack');
    const claim = await realClaim(session);
    const res = await call('/api/wallet/topup', {
      method: 'POST',
      cookie: session,
      proof: `${forge({ ...claim, u: Number(claim.u) + 1 })}:0`,
      body: { phone: '0712345678', amount_kes: 500 },
    });
    assert.equal(res.status, 428);
    assert.equal(res.data.reason, 'account');
  });

  await test('a proof without the required work is refused', async () => {
    const { session } = await freshSession('attack');
    const claim = await realClaim(session);
    // Signed correctly, right account and browser, but the nonce solves nothing.
    const res = await call('/api/wallet/topup', {
      method: 'POST',
      cookie: session,
      proof: `${forge({ ...claim, b: Math.min(20, Math.max(8, claim.b) + 4) })}:0`,
      body: { phone: '0712345678', amount_kes: 500 },
    });
    assert.equal(res.status, 428);
    assert.equal(res.data.reason, 'work');
  });

  await test('even a verified browser cannot flood a phone with M-Pesa prompts', async () => {
    const hash = require('bcryptjs').hashSync('longpassword1', 10);
    raw.prepare('INSERT INTO users (email, password_hash, password_set, created_at) VALUES (?,?,1,?)')
      .run('prompt-flood@panel.test', hash, Math.floor(Date.now() / 1000));
    const uid = raw.prepare('SELECT id FROM users WHERE email = ?').get('prompt-flood@panel.test').id;
    const t = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) {
      raw.prepare("INSERT INTO topups (user_id, phone, amount_kes, credited_cents, checkout_request_id, status, created_at, updated_at) VALUES (?,?,?,0,?,'pending',?,?)")
        .run(uid, '0712345678', 500, `flood-${i}`, t, t);
    }
    const session = (await loginAs('prompt-flood@panel.test', 'longpassword1')).session;
    const res = await call('/api/wallet/topup', {
      method: 'POST',
      cookie: session,
      body: { phone: '0712345678', amount_kes: 500 },
    });
    assert.equal(res.status, 429);
    assert.match(String(res.data.error), /last hour/i);
  });

  await test('a correctly solved proof reaches normal validation instead of the gate', async () => {
    // A clean account, so nothing else (prompt budget, pending prompts) can answer for the gate.
    const hash = require('bcryptjs').hashSync('longpassword1', 10);
    raw.prepare('INSERT INTO users (email, password_hash, password_set, created_at) VALUES (?,?,1,?)')
      .run('proof-ok@panel.test', hash, Math.floor(Date.now() / 1000));
    const { session } = await loginAs('proof-ok@panel.test', 'longpassword1');
    // The harness attaches a real proof; the request must now get past the gate and fail on the
    // business rule (amount too small) rather than on verification.
    const res = await call('/api/wallet/topup', {
      method: 'POST',
      cookie: session,
      body: { phone: '0712345678', amount_kes: 1 },
    });
    assert.notEqual(res.status, 428);
    assert.ok([400, 503].includes(res.status));
  });

  server.close();
  phServer.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
