// KES pricing.
//
//   customer price = provider cost in KES + max(FEE_KES, margin_pct x provider cost in KES)
//
// Two levers, in this order:
//   * FEE_KES is the floor: every order carries at least this much gross margin, so a KSh 5 order
//     never loses money to the M-Pesa and provider minimums.
//   * margin_pct (default 20%) takes over on larger orders, where a flat fee would be an
//     unprofitable ~2% of the ticket. Gross = max(fee, pct x cost).
// A legacy `markup` multiplier is still honoured (it multiplies the provider cost before the fee /
// percentage is applied) so an existing setting keeps working after a deploy.
//
// Order total for per-1000 services is (rate_kes + gross) x quantity / 1000; flat/package services
// are priced as rate_kes + gross per order.
//
// Settings live in the `settings` table and are cached in memory: reads are synchronous (pure
// integer maths over the cached values), writes refresh the cache. `ensureSettings()` must resolve
// once before the first read - the server awaits it as middleware.
const db = require('./db');
const config = require('./config');
const { toCents, ceilScaled } = require('./money');
const { isFlat } = require('./serviceTypes');

const DEFAULTS = {
  markup: config.pricing.markup,
  kes_per_usd: config.pricing.kesPerUsd,
  fee_kes: config.pricing.feeKes,
  // 20% of the provider cost is the target margin; FEE_KES is the floor per order.
  margin_pct: config.pricing.marginPct,
};

let cache = null; // { markup, kesPerUsd, feeKes, feeCents, marginPct }
let cacheAt = 0;
let loading = null;
// Settings are re-read once a minute, so a price change made in the admin console (or straight in
// the database) reaches every warm lambda without waiting for a redeploy.
const TTL_MS = 60 * 1000;

function toSettings(values) {
  const markup = Number.isFinite(values.markup) && values.markup >= 0 ? values.markup : DEFAULTS.markup;
  const kesPerUsd = Number.isFinite(values.kes_per_usd) && values.kes_per_usd > 0 ? values.kes_per_usd : DEFAULTS.kes_per_usd;
  const feeKes = Number.isFinite(values.fee_kes) && values.fee_kes >= 0 ? values.fee_kes : DEFAULTS.fee_kes;
  const marginPct =
    Number.isFinite(values.margin_pct) && values.margin_pct >= 0 && values.margin_pct <= 5
      ? values.margin_pct
      : DEFAULTS.margin_pct;
  return { markup, kesPerUsd, feeKes, feeCents: toCents(feeKes), marginPct };
}

/** Create any missing settings rows, then load them into the cache. Safe to call repeatedly. */
async function initSettings() {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    await db.run('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, String(value)]);
  }
  const rows = await db.all('SELECT key, value FROM settings');
  const map = {};
  for (const row of rows) {
    const n = Number(row.value);
    if (Number.isFinite(n)) map[row.key] = n;
  }
  cache = toSettings(map);
  cacheAt = Date.now();
  return cache;
}

/**
 * Initialisation for request handlers, with a one-minute TTL. A failed refresh never takes the
 * site down: the last good values keep serving and the error goes to the log.
 */
function ensureSettings() {
  if (cache && Date.now() - cacheAt < TTL_MS) return Promise.resolve(cache);
  if (!loading) {
    loading = initSettings()
      .catch((err) => {
        if (cache) {
          console.error('[pricing] settings refresh failed, keeping cached values:', err.message);
          cacheAt = Date.now(); // do not retry on every request while the database is unhappy
          return cache;
        }
        throw err;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** Synchronous read of the cached settings (falls back to env defaults before init). */
function getSettings() {
  return cache || toSettings(DEFAULTS);
}

async function writeSetting(key, value) {
  await db.run('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [
    key,
    String(value),
  ]);
  await initSettings();
}

const setMarkup = (markup) => writeSetting('markup', markup);
const setKesPerUsd = (rate) => writeSetting('kes_per_usd', rate);
const setFeeKes = (fee) => writeSetting('fee_kes', fee);
const setMarginPct = (pct) => writeSetting('margin_pct', pct);

/** Provider cost in KES cents, after the legacy markup multiplier. */
function costCents(providerRateUsd, settings = getSettings()) {
  const usd = Number(providerRateUsd) * (1 + settings.markup);
  if (!Number.isFinite(usd) || usd < 0) return 0;
  return Math.round(usd * settings.kesPerUsd * 100);
}

/** Gross margin in cents: the flat fee, or the percentage, whichever is larger. */
function grossCents(cost, settings = getSettings()) {
  const pct = Math.round(cost * (settings.marginPct || 0));
  return Math.max(settings.feeCents, pct);
}

/** Customer rate in KES cents per 1000 units, including the gross margin. */
function rateCentsPer1000(providerRateUsd, settings = getSettings()) {
  const cost = costCents(providerRateUsd, settings);
  return cost + grossCents(cost, settings);
}

/**
 * Customer rate shown in the catalog, in KES (per 1000 units, or per order for flat types):
 * provider rate x (1 + markup) x KES_PER_USD, plus the fixed fee.
 */
function sellRateKes(providerRateUsd, settings = getSettings()) {
  return rateCentsPer1000(providerRateUsd, settings) / 100;
}

/** Price in KES cents for an order. */
function priceCents(service, quantity, settings = getSettings()) {
  const rate = rateCentsPer1000(service.rate, settings);
  if (isFlat(service.type)) return Math.max(1, rate);
  const qty = Number(quantity) || 0;
  if (qty <= 0) return 0;
  return Math.max(1, ceilScaled(rate, qty, 1000));
}

/**
 * Re-price an order from the "charged" amount the provider actually billed (USD).
 * The provider is authoritative: charged x (1 + markup) x KES_PER_USD + fee.
 */
function priceCentsFromCharged(chargedUsd, { type, quantity }, settings = getSettings()) {
  const charged = Number(chargedUsd);
  if (!Number.isFinite(charged) || charged < 0) return null;
  const qty = Number(quantity) || 1;
  if (isFlat(type)) {
    const cost = costCents(charged, settings);
    return Math.max(1, cost + grossCents(cost, settings));
  }
  const per1000 = (charged * 1000) / qty;
  const rateCents = rateCentsPer1000(per1000, settings);
  return Math.max(1, ceilScaled(rateCents, qty, 1000));
}

module.exports = {
  initSettings,
  ensureSettings,
  getSettings,
  setMarkup,
  setKesPerUsd,
  setFeeKes,
  setMarginPct,
  costCents,
  grossCents,
  rateCentsPer1000,
  sellRateKes,
  priceCents,
  priceCentsFromCharged,
};
