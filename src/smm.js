// Client for the smm.africa API v3 (one POST endpoint, JSON in/out).
// The API key lives only in server env vars; it is never sent to the browser.
const config = require('./config');

class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, definitive?: boolean, ambiguous?: boolean, retryAfterMs?: number}} [opts]
   *  definitive: the provider clearly rejected the request (safe to refund the customer)
   *  ambiguous:  we cannot know whether the provider accepted it (never auto-refund)
   */
  constructor(message, { status = 0, definitive = false, ambiguous = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.definitive = definitive;
    this.ambiguous = ambiguous;
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * POST one action to the provider.
 * Retries reuse the exact same body and idempotency key, so a lost response can never
 * create a second provider order.
 */
async function request(params, { idempotencyKey, retries = 2, budgetMs = 0 } = {}) {
  if (!config.smm.key) throw new ProviderError('Provider API key is not configured', { status: 0 });

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${config.smm.key}` };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const body = JSON.stringify(params);

  // Wall-clock budget for the whole call, retries included. A serverless function is killed at its
  // platform limit (60s on Vercel); without this the request dies mid-flight, the browser reports
  // "Failed to fetch" and the customer cannot tell whether the order exists.
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : 0;
  const remaining = () => (deadline ? deadline - Date.now() : Infinity);

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (deadline && remaining() <= 500) {
      lastErr = lastErr || new ProviderError('Provider did not answer in time', { ambiguous: true });
      lastErr.ambiguous = true;
      lastErr.budgetExhausted = true;
      throw lastErr;
    }
    let res;
    try {
      res = await fetch(config.smm.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(Math.max(1000, Math.min(config.smm.timeoutMs, remaining() === Infinity ? config.smm.timeoutMs : remaining()))),
      });
    } catch (err) {
      // Timeout / network error: the provider may or may not have processed it.
      lastErr = new ProviderError(`Network error: ${err.message}`, { ambiguous: true });
      if (attempt < retries) await sleep(config.smm.retryBaseMs * 2 ** attempt + Math.random() * 250);
      continue;
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (RETRY_STATUS.has(res.status)) {
      const ra = Number(res.headers.get('retry-after'));
      const retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 0;
      lastErr = new ProviderError((data && data.error) || `Provider returned HTTP ${res.status}`, {
        status: res.status,
        ambiguous: true,
        retryAfterMs,
      });
      if (attempt < retries) await sleep((retryAfterMs || config.smm.retryBaseMs * 2 ** attempt) + Math.random() * 250);
      continue;
    }

    if (res.status === 409) {
      // Same idempotency key is still in flight: the order may exist. Never refund on this.
      throw new ProviderError((data && data.error) || 'Request still in progress', { status: 409, ambiguous: true });
    }

    if (!res.ok || (data && !Array.isArray(data) && data.error)) {
      const msg = (data && data.error) || `Provider returned HTTP ${res.status}`;
      throw new ProviderError(String(msg), { status: res.status || 400, definitive: true });
    }

    if (data === null) throw new ProviderError('Empty response from provider', { status: res.status, ambiguous: true });
    return data;
  }
  throw lastErr;
}

module.exports = {
  ProviderError,
  balance: () => request({ action: 'balance' }),
  services: () => request({ action: 'services' }),
  add: (payload, idempotencyKey, opts = {}) =>
    request({ action: 'add', ...payload, idempotency_key: idempotencyKey }, { idempotencyKey, ...opts }),
  // Read-only calls: never retried on our side (the poller runs again in 30s anyway) and given a
  // short budget, so a page that polls five orders cannot blow past the serverless time limit.
  status: (order, opts = {}) => request({ action: 'status', order }, { retries: 0, budgetMs: config.smm.pollBudgetMs, ...opts }),
  refill: (order, opts = {}) => request({ action: 'refill', order }, { budgetMs: config.smm.submitBudgetMs, ...opts }),
  cancel: (order, opts = {}) => request({ action: 'cancel', order }, { budgetMs: config.smm.submitBudgetMs, ...opts }),
};
