// KES pricing.
//
//   customer price = (provider USD rate x (1 + markup) x KES_PER_USD) + FEE_KES
//
// The +FEE_KES applies to every price on the site: the per-1000 rate in the catalog, the dynamic
// order form and the order total. Order total for per-1000 services is
// (rate_kes + fee) x quantity / 1000; flat/package services are priced as rate_kes + fee per order.
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
};

let cache = null; // { markup, kesPerUsd, feeKes, feeCents }
let loading = null;

function toSettings(values) {
  const markup = Number.isFinite(values.markup) && values.markup >= 0 ? values.markup : DEFAULTS.markup;
  const kesPerUsd = Number.isFinite(values.kes_per_usd) && values.kes_per_usd > 0 ? values.kes_per_usd : DEFAULTS.kes_per_usd;
  const feeKes = Number.isFinite(values.fee_kes) && values.fee_kes >= 0 ? values.fee_kes : DEFAULTS.fee_kes;
  return { markup, kesPerUsd, feeKes, feeCents: toCents(feeKes) };
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
  return cache;
}

/** Memoised initialisation for request handlers. */
function ensureSettings() {
  if (cache) return Promise.resolve(cache);
  if (!loading) loading = initSettings().finally(() => { loading = null; });
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

/** Customer rate in KES cents per 1000 units, including the fixed fee. */
function rateCentsPer1000(providerRateUsd, settings = getSettings()) {
  const kes = Number(providerRateUsd) * (1 + settings.markup) * settings.kesPerUsd;
  return Math.round(kes * 100) + settings.feeCents;
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
    return Math.max(1, Math.round(charged * (1 + settings.markup) * settings.kesPerUsd * 100) + settings.feeCents);
  }
  const per1000 = (charged * 1000) / qty;
  const rateCents = Math.round(per1000 * (1 + settings.markup) * settings.kesPerUsd * 100) + settings.feeCents;
  return Math.max(1, ceilScaled(rateCents, qty, 1000));
}

module.exports = {
  initSettings,
  ensureSettings,
  getSettings,
  setMarkup,
  setKesPerUsd,
  setFeeKes,
  rateCentsPer1000,
  sellRateKes,
  priceCents,
  priceCentsFromCharged,
};
