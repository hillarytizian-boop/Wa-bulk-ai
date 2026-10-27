# SMM Panel (Kenya) — KES reseller storefront on the smm.africa API v3

A production-ready social-media marketing (SMM) reseller site priced in **Kenyan Shillings**.
Customers sign up, top up a wallet with **M-Pesa STK Push**, and buy followers, likes, views and
more. Every order is fulfilled through the [smm.africa](https://smm.africa/api-docs) **API v3**
using your API key, which never leaves the server.

- **Backend:** Node.js + Express + SQLite (`better-sqlite3`)
- **Frontend:** plain HTML/CSS/JS (`public/`), no build step, mobile-first dark theme
- **Money:** integer **KES cents** everywhere. Provider costs are tracked separately as integer
  micro-USD, so the two currencies never get mixed.
- **Payments:** M-Pesa (Safaricom Daraja) STK Push, credited only after confirmation

---

## Pricing model

```
customer price = (provider USD rate × (1 + markup) × KES_PER_USD) + FEE_KES
```

- `markup` (default **0.30**), `KES_PER_USD` (default **129**) and `FEE_KES` (default **50**) are
  **admin-editable** in the Admin panel and applied immediately to new prices and quotes.
- The **+KSh 50 service fee applies to every price on the site**: the rate shown in the services
  catalog, the order form, the live total and the order itself.
- Per-1000 services: `total = (rate_kes + 50) × quantity / 1000`
- Flat/package services: `total = rate_kes + 50` per order
- **Provider rates are never sent to the browser.** The API only exposes KES prices.
- After every submission the order is reconciled against the provider's `charged` value; if the
  provider billed a different amount the customer's price is corrected and the wallet is adjusted
  (refund if cheaper, extra debit if dearer and affordable — the customer is never left in debt).

Example: provider rate `$0.90 / 1000`, markup 30 %, KES/USD 129 →
`0.90 × 1.3 × 129 = 150.93` → **KSh 200.93 per 1000** (incl. the KSh 50 fee). An order for 1000
units costs **KSh 200.93**.

---

## Quick start

```bash
npm install
cp .env.example .env      # then edit it
npm start                 # http://localhost:3000
```

Minimum `.env`:

| Variable | What to put |
|---|---|
| `SMM_API_KEY` | Your key from the smm.africa **Account** page |
| `JWT_SECRET` | Long random string: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | First admin, created when the database has no users |
| `DEFAULT_MARKUP` / `KES_PER_USD` / `FEE_KES` | Pricing defaults (editable later in Admin) |
| `PUBLIC_URL` | Absolute public URL (used for the M-Pesa callback) |

Log in as the admin and open **Admin** for provider balance, revenue, provider cost, profit,
pricing settings, customers (manual wallet adjustments) and the **needs review** queue.

---

## Develop without spending money

A local stand-in for both smm.africa and Daraja ships with the repo:

```bash
npm run mock                                   # fake smm.africa + M-Pesa on :4010
SMM_API_URL=http://localhost:4010/api/v3 SMM_API_KEY=test-key \
MPESA_CONSUMER_KEY=ck MPESA_CONSUMER_SECRET=cs MPESA_PASSKEY=pk \
MPESA_BASE_URL=http://localhost:4010 npm start
```

Magic values in the order "link" trigger edge cases: `REJECT` (provider 400), `FLAKY` (provider
creates the order but the response is lost), `PARTIAL` (40 % undelivered), `CANCELME` (cancellable).

```bash
npm test
```

- `test/engine.test.js` — **21 tests**: KES pricing + fee, ordering, idempotent recovery, refunds,
  M-Pesa crediting, ledger reconciliation.
- `test/security.test.js` — **17 tests**: bcrypt-only password storage, HttpOnly/SameSite=Strict
  cookies, account-enumeration resistance, per-account login throttling, CSRF origin + JSON-body
  enforcement, authz boundaries (anon 401 / customer 403 / admin 200), session revocation on
  password change and logout-all, tampered-cookie rejection, provider key never exposed, audit log,
  M-Pesa callback secret, top-up validation.

The test suite needs the compiled `better-sqlite3` native module (`npm install`).

---

## How the money flows

1. **Catalog** — `services` is fetched from the provider and cached for **10 minutes**; the cache is
   also refreshed by a background job. Search, category filter and pagination are server-side.
2. **Ordering** — the wallet is *charged first*, then the order is submitted with a **unique
   `idempotency_key`** (generated once and stored on the order row).
   - Definitive provider rejection (400/402/423) → **automatic full refund**, order `failed`.
   - Timeout / 429 / 5xx / 409 → the outcome is **unknown**. The order stays `submitting` and is
     retried **with the same body and the same key**, so a lost response can never create a second
     order. After 8 attempts it moves to **Admin → Needs review** and is **never auto-refunded**.
   - `Retry-After` from the provider is honoured when retrying.
   - Payloads are type-aware: `Default` → link + quantity; `Package` → link only;
     `Custom Comments` → link + comments (quantity = number of lines, **not sent**); mentions,
     polls, SEO and web traffic send their own fields. `type` is never sent.
3. **Status sync** — active orders are polled in the background: every **30 s** while the order is
   young, then every 2 minutes, then every 10. `completed` settles; `canceled`/`refunded` refund in
   full; `partial` refunds the undelivered share — each **exactly once**.
4. **Refill / cancel** — buttons appear only when the service advertises support (`refill`/`cancel`
   from the provider catalog). Refills are limited to one per order per 24 h.
5. **M-Pesa** — STK Push → Daraja callback → **confirm with the STK query API** → credit the wallet
   **exactly once** (guarded by the top-up status inside a database transaction). A background job
   reconciles payments whose callback never arrives. `pending` payments expire after 30 minutes.
6. **Admin** — revenue, provider cost and profit in KES, provider balance, markup/KES-rate/fee
   settings, wallet adjustments, and Retry/Refund for needs-review orders.

---

## M-Pesa (Daraja) setup

1. Create an app at <https://developer.safaricom.co.ke> and note the Consumer Key/Secret.
2. Fill `MPESA_*` in `.env`. Use `MPESA_ENV=production` when live; `MPESA_TXN_TYPE=CustomerBuyGoodsOnline`
   for a Till, `CustomerPayBillOnline` for a Paybill. Set `MPESA_PARTYB` if it differs from the shortcode.
3. Set `PUBLIC_URL` to your public **HTTPS** address. Daraja calls
   `PUBLIC_URL/api/wallet/mpesa/callback/<secret>` (the secret is derived from `JWT_SECRET`).
4. Leave `MPESA_CONSUMER_KEY` empty to disable M-Pesa; you can still credit wallets from Admin.

> The M-Pesa code is tested against a mock of Daraja only. Run a sandbox payment before going live.

---

## Deploying

A long-running Node process with a SQLite file — use a host with a **persistent disk** (VPS,
Railway, Render, Fly.io, Docker). Not suitable for serverless functions.

```bash
docker compose up -d --build      # data lives in the "panel-data" volume
```

Or build directly:

```bash
docker build -t smm-panel .
docker run -d -p 3000:3000 --env-file .env -v panel-data:/data smm-panel
```

Production checklist:

- `NODE_ENV=production`, `COOKIE_SECURE=true` (HTTPS), a real `JWT_SECRET` and admin password.
- Behind a reverse proxy/CDN? Set `TRUST_PROXY=true` so rate limiting sees real client IPs.
- Back up `data/*.db` regularly — it holds wallets, orders and top-ups.
- Keep `.env` out of git (already ignored) and rotate the smm.africa key if it ever leaks.
- Health check: `GET /healthz`.

---

## Security notes

| Area | What the code does |
|---|---|
| Provider key | Lives only in server env vars. No route ever returns it; the API exposes KES prices only (`test/security.test.js` asserts this). |
| Admin password | From `.env` (gitignored) or `npm run admin:password`; bcrypt cost 10–12; never logged; rotating it bumps `token_version` and signs out every session. |
| Sessions | Signed JWT (HS256, algorithms pinned) in an **httpOnly**, **SameSite=Strict**, `Secure`-in-production cookie; server-side revocation via `users.token_version`. |
| Passwords | bcrypt, 8–72 bytes (bcrypt truncation limit enforced), login compares a dummy hash for unknown emails so timing does not reveal accounts. |
| Brute force | IP limiter on `/api/auth/*` (20 / 15 min), plus a per-account failure throttle (6 failures / 15 min) so spraying one account or many accounts from one IP is bounded. Admin routes have their own limiter. |
| CSRF | `SameSite=Strict` cookies + Origin allow-list + JSON-only bodies for state-changing requests (`src/security.js`). Simple HTML-form CSRF is impossible. |
| XSS | All provider/customer text goes through `textContent`/`createTextNode`; strict CSP (`default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `script-src-attr 'none'`). |
| Clickjacking | `frame-ancestors 'none'` + `X-Frame-Options: DENY` in production (`ALLOW_IFRAME=true` only for dev previews). |
| Transport | `helmet` (nosniff, no-referrer, HSTS when `COOKIE_SECURE=true`), `x-powered-by` off, API responses `Cache-Control: no-store`. |
| M-Pesa callback | Secret path compared in constant time; a callback never credits — every payment is confirmed through the STK **query** API, credited exactly once inside a transaction. |
| Authorization | Every order/refill/cancel/top-up route checks ownership; admin routes require `is_admin`; wallet balance can never go negative. |
| Audit | Privileged actions (wallet adjustments, refunds, retries, pricing changes) are appended to `audit_log` with actor, IP and time, readable at `GET /api/admin/audit` and shown in Admin. |
| Money | Integer KES cents; every balance change runs in a SQLite transaction with a ledger row. |
| Deploy | `.env` gitignored (secrets never in git history), JSON body limit 100 kb, rate limits everywhere, `/healthz` for uptime checks. |

Still recommended for a live launch: put the site behind HTTPS (set `COOKIE_SECURE=true`,
`TRUST_PROXY=true`), add email verification/password reset, and back up the SQLite file.

## Known limits / next steps

- No email verification or password reset yet (add an email provider such as Resend/Brevo).
- Single process + SQLite: comfortable for thousands of orders/day; move to Postgres if you need
  multiple app servers.
- Only `Default`, `Package` and `Custom Comments` types are exercised by the tests; the other type
  payloads follow the provider docs but should be smoke-tested against your real account.
- Check smm.africa's terms for reselling and publish your own refund/terms pages before launch.

---

## Project layout

```
src/server.js         app, admin seeding, health check
src/config.js         env configuration (with production guards)
src/db.js             SQLite schema (integer KES cents)
src/money.js          integer money helpers + KES formatting
src/pricing.js        markup / KES-per-USD / fee -> customer prices
src/serviceTypes.js   per-type fields and flat/line-counted rules
src/smm.js            smm.africa client (retries, idempotency, Retry-After)
src/catalog.js        10-minute services cache
src/orders.js         order engine: charge, submit, poll, refund, reconcile
src/mpesa.js          Daraja STK Push, query, credit-once reconciliation
src/jobs.js           background pollers
src/security.js       CSRF/origin checks, no-store headers
src/audit.js          audit log for privileged actions
src/routes/           auth, shop, wallet, admin
scripts/              admin password rotation
public/               the website (no build step)
test/                 mock provider, engine tests, security tests
```
