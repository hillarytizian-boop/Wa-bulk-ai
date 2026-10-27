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
npm test        # 21 tests: pricing, ordering, idempotent recovery, refunds, M-Pesa, ledger
```

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

- Provider key lives only in server env vars; the browser only ever sees KES prices.
- Sessions: signed JWT in an **httpOnly** cookie (`secure` in production, `sameSite=lax`).
- Passwords: **bcrypt** (cost 10), constant-time-ish login (dummy hash comparison).
- **helmet** with CSP, **express-rate-limit** on the API, auth and top-up endpoints.
- All provider-supplied text (service names, descriptions) is inserted with `textContent` /
  `createTextNode` — never `innerHTML`.
- Money is integer cents; every balance change goes through a SQLite transaction and a
  `transactions` ledger row.

---

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
src/routes/           auth, shop, wallet, admin
public/               the website (no build step)
test/                 mock provider + engine tests
```
