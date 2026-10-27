// KES pricing.
//
//   customer price = (provider USD rate x (1 + markup) x KES_PER_USD) + FEE_KES
//
// The +FEE_KES applies to every price on the site: the per-1000 rate in the catalog, the
// dynamic order form and the order total. Order total for per-1000 services is
// (rate_kes + fee) x quantity / 1000; flat/package services are priced as rate_kes + fee per order.
//
// Rates are converted to integer KES cents once, then all order maths stays in integers.
const db = require('./db');
const config = require('./config');
const { toCents, ceilScaled } = require('./money');
const { isFlat } = require('./serviceTypes');

const DEFAULTS = {
  markup: String(config.pricing.markup),
  kes_per_usd: String(config.pricing.kesPerUsd),
  fee_kes: String(config.pricing.feeKes),
};

/** Insert default settings once, so the admin panel always has values to edit. */
function initSettings() {
  const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING');
  for (const [k, v] of Object.entries(DEFAULTS)) insert.run(k, v);
}

function readSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function getSettings() {
  const markup = readSetting('markup', config.pricing.markup);
  const kesPerUsd = readSetting('kes_per_usd', config.pricing.kesPerUsd);
  return {
    markup: markup >= 0 ? markup : config.pricing.markup,
    kesPerUsd: kesPerUsd > 0 ? kesPerUsd : config.pricing.kesPerUsd,
    feeKes: readSetting('fee_kes', config.pricing.feeKes),
    feeCents: toCents(readSetting('fee_kes', config.pricing.feeKes)),
  };
}

const writeSetting = (key, value) =>
  db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));

const setMarkup = (markup) => writeSetting('markup', markup);
const setKesPerUsd = (rate) => writeSetting('kes_per_usd', rate);
const setFeeKes = (fee) => writeSetting('fee_kes', fee);

/** Customer rate in KES cents per 1000 units, including the fixed fee. */
function rateCentsPer1000(providerRateUsd, settings = getSettings()) {
  const kes = Number(providerRateUsd) * (1 + settings.markup) * settings.kesPerUsd;
  return Math.round(kes * 100) + settings.feeCents;
}

/**
 * Customer rate shown in the catalog, in KES (per 1000 units, or per order for flat types).
 * This is the provider rate x (1 + markup) x KES_PER_USD, plus the fixed fee.
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
  getSettings,
  setMarkup,
  setKesPerUsd,
  setFeeKes,
  rateCentsPer1000,
  sellRateKes,
  priceCents,
  priceCentsFromCharged,
};
