// Money is stored as integer KES cents (1 KES = 100 cents). No floats anywhere in the ledger.
// Provider rates are USD per 1000 units; provider cost is tracked separately as integer micro-USD.

const CENTS = 100;
const MICRO = 1_000_000;

const toCents = (kes) => Math.round(Number(kes) * CENTS);
const fromCents = (cents) => cents / CENTS;

/** Round up a fractional cent amount without floating point drift. */
const ceilCents = (cents) => Math.ceil(Number(cents) - 1e-9);

/** ceil(cents * numerator / denominator) in integer arithmetic where possible. */
function ceilScaled(cents, numerator, denominator) {
  const n = BigInt(cents) * BigInt(numerator);
  const d = BigInt(denominator);
  return Number((n + d - 1n) / d);
}

/** Format integer cents as "KSh 1,234.50" (trailing .00 dropped for round amounts). */
function fmtKes(cents) {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / CENTS);
  const rem = abs % CENTS;
  const body = `${whole.toLocaleString('en-KE')}${rem ? `.${String(rem).padStart(2, '0')}` : ''}`;
  return `${negative ? '-' : ''}KSh ${body}`;
}

/** KES amount (may be fractional) -> display string. */
const fmtKesAmount = (kes) => fmtKes(toCents(kes));

const usdToMicros = (usd) => Math.round(Number(usd) * MICRO);
const microsToUsd = (micros) => (micros == null ? null : micros / MICRO);

module.exports = { CENTS, MICRO, toCents, fromCents, ceilCents, ceilScaled, fmtKes, fmtKesAmount, usdToMicros, microsToUsd };
