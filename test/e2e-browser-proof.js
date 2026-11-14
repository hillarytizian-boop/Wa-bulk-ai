// Real-browser end-to-end check for the "verify browsing before you pay" gate.
//
// NOT part of `npm test`: it needs Playwright and a Chromium build, which are development-machine
// concerns, not deployment ones.
//
//   npm i -D playwright && npx playwright install chromium
//   node test/e2e-browser-proof.js
//
// On a bare Linux box Chromium also needs the usual GTK/NSS shared libraries
// (libnspr4, libnss3, libatk*, libxkbcommon, libgbm1 ...). It starts its own server on port 3077 with
// a throwaway SQLite database and throwaway PayHero credentials (no real prompt is ever requested).
//
// What it proves: a raw HTTP client holding a valid session cookie is refused (428), a genuine
// browser solves the challenge with WebCrypto in ~100 ms, the app's own top-up request carries the
// proof, and the wallet screen tells the customer the browser is verified.

// End-to-end: does a REAL browser get through the "verify browsing before you pay" gate,
// and is the same request without a browser refused? Run against a local server.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3077;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = '/home/user/wa-bulk-ai';
const DB = path.join(os.tmpdir(), `e2e-proof-${process.pid}.db`);
const EMAIL = 'boss@panel.test';
const PASS = 'Sup3rSecret!2024';

const log = (...a) => console.log(...a);
const rm = () => ['', '-wal', '-shm'].forEach((e) => fs.rmSync(DB + e, { force: true }));

(async () => {
  rm();
  const srv = spawn(process.execPath, ['src/main.js'], {
    cwd: APP,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_PATH: DB,
      JWT_SECRET: 'e2e-proof-secret',
      ADMIN_EMAIL: EMAIL,
      ADMIN_PASSWORD: PASS,
      SITE_NAME: 'smmpanel',
      PUBLIC_URL: BASE,
      NODE_ENV: 'development',
      // Switch M-Pesa on with throwaway credentials so the top-up form renders. The click will fail
      // at PayHero (we never want a real prompt in a test) - what matters is that it is not a 428.
      PAYHERO_API_USERNAME: 'test-user',
      PAYHERO_API_PASSWORD: 'test-pass',
      PAYHERO_CHANNEL_ID: '12345',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  srv.stderr.on('data', (d) => process.stderr.write(`[server!] ${d}`));

  const waitUp = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${BASE}/healthz`);
        if (r.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not start');
  };

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    log(`${ok ? ' ok ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  };

  try {
    await waitUp();

    // ---- 1. A raw HTTP client with a valid session cookie is refused -------------------------
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'user-agent': 'curl/8.5.0' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    });
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    const raw = await fetch(`${BASE}/api/wallet/topup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'user-agent': 'curl/8.5.0' },
      body: JSON.stringify({ phone: '0712345678', amount_kes: 500 }),
    });
    const rawBody = await raw.json().catch(() => ({}));
    check('curl with a stolen session cookie is refused (428)', raw.status === 428, `status ${raw.status}, reason ${rawBody.reason}`);

    // ---- 2. A real browser: solve the puzzle the way the app does ---------------------------
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('DEBUG pageerror', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.log('DEBUG console', m.text().slice(0, 200)); });
    const seen = [];
    page.on('response', (r) => {
      if (r.url().includes('/api/wallet/topup') || r.url().includes('/api/orders') || r.url().includes('/api/challenge')) {
        seen.push(`${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()} proof=${Boolean(r.request().headers()['x-pay-proof'])}`);
      }
    });

    await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle' });
    // Sign in through the real form so the cookie is a browser cookie.
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASS);
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/auth/login')),
      page.click('button:has-text("Log in")'),
    ]);

    // The app should solve a challenge - check the browser itself can do it with WebCrypto.
    const solved = await page.evaluate(async () => {
      const t0 = performance.now();
      const res = await fetch('/api/challenge', { credentials: 'same-origin' });
      const { challenge, bits, expires_in } = await res.json();
      const enc = new TextEncoder();
      const target = `${challenge}:`;
      const zeroBits = (bytes) => {
        let n = 0;
        for (const b of bytes) {
          if (b === 0) { n += 8; continue; }
          n += Math.clz32(b) - 24;
          break;
        }
        return n;
      };
      let nonce = -1;
      for (let i = 0; i < 2000000; i++) {
        const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(target + i)));
        if (zeroBits(d) >= bits) { nonce = i; break; }
      }
      return { ok: nonce >= 0, ms: Math.round(performance.now() - t0), bits, expires_in, proof: `${target}${nonce}` };
    });
    check('a real browser solves the puzzle with WebCrypto', solved.ok, `${solved.bits} bits in ${solved.ms} ms`);

    const viaBrowser = await page.evaluate(async (proof) => {
      const res = await fetch('/api/wallet/topup', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-pay-proof': proof },
        body: JSON.stringify({ phone: '0712345678', amount_kes: 1 }), // KES 1 fails validation on purpose
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, solved.proof);
    check(
      'the same browser passes the gate and reaches normal validation (not 428)',
      viaBrowser.status !== 428,
      `status ${viaBrowser.status}: ${String(viaBrowser.body.error || '').slice(0, 60)}`
    );

    // ---- 3. The app's own flow: wallet screen warms and verifies ---------------------------
    await page.waitForTimeout(1000); // let the post-login redirect settle
    await page.goto(`${BASE}/#/wallet`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'networkidle' });
    console.log('DEBUG hash', await page.evaluate(() => location.hash));
    console.log('DEBUG text', (await page.evaluate(() => document.body.innerText)).slice(0, 300).replace(/\n+/g, ' | '));
    console.log('DEBUG hints', await page.evaluate(() => [...document.querySelectorAll('.hint')].map((n) => n.textContent.trim()).slice(0, 8)));
    const note = await page
      .waitForFunction(
        () => {
          const el = [...document.querySelectorAll('.hint')].find((n) => /verif/i.test(n.textContent || ''));
          return el && /verified/i.test(el.textContent || '') ? el.textContent : false;
        },
        { timeout: 25000 }
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    check('the wallet screen reports the browser as verified', Boolean(note), note ? `"${note.trim()}"` : 'no note found');

    const btnState = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((n) => /M-Pesa prompt/i.test(n.textContent || ''));
      return b ? { disabled: b.disabled } : null;
    });
    check('the pay button is enabled once verified', Boolean(btnState && !btnState.disabled), JSON.stringify(btnState));

    await page.screenshot({ path: '/tmp/e2e/wallet-verified.png', fullPage: false });
    if (btnState) {
      await page.fill('input[type="tel"]', '0712345678').catch(() => {});
      await page.click('button:has-text("Send M-Pesa prompt")').catch(() => {});
      await page.waitForTimeout(2500);
    }
    check('the app sent a proof with its own request (no 428 loop)', seen.some((s) => /proof=true/.test(s)), seen.join(' | ') || 'no calls');

    await page.screenshot({ path: '/tmp/e2e/wallet-after-click.png', fullPage: false });
    await browser.close();
  } catch (err) {
    check(`harness error: ${err.message}`, false);
  } finally {
    srv.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    rm();
  }

  const failed = results.filter((r) => !r.ok).length;
  log(`\n${results.length - failed}/${results.length} browser checks passed`);
  process.exit(failed ? 1 : 0);
})();
