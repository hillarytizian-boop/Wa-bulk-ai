// Cross-cutting HTTP security: CSRF defence, JSON-only bodies, cache headers for the API.
const config = require('./config');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Daraja posts here from Safaricom's servers: no cookie, no Origin. It is protected by the
// secret path segment *and* by confirming every payment with the STK query API.
const isCallback = (req) => req.path.startsWith('/wallet/mpesa/callback') && req.baseUrl.startsWith('/api');

const safeHost = (url) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

/** Hosts that are allowed to send state-changing requests to this app. */
function allowedHosts(req) {
  const hosts = new Set();
  const add = (value) => {
    if (!value) return;
    const asHost = safeHost(value) || String(value).trim().toLowerCase();
    if (asHost) hosts.add(asHost);
  };
  add(req.get('host'));
  add(req.get('x-forwarded-host'));
  add(config.publicUrl);
  for (const entry of String(process.env.ALLOWED_ORIGINS || '').split(',')) add(entry.trim());
  return hosts;
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests:
 *  1. Browsers always send Origin on cross-site AND same-origin POSTs, so a host that is not
 *     ours is a cross-site attempt.
 *  2. Anything with a body must be application/json; simple HTML forms cannot do that, so
 *     form-based CSRF can never reach a handler.
 * Cookies are SameSite=Strict as well, so a browser would not even attach them cross-site.
 */
function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (isCallback(req)) return next();

  const origin = req.get('origin');
  if (origin) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return res.status(403).json({ error: 'Invalid request origin' });
    }
    const host = parsed.host.toLowerCase();
    let ok = allowedHosts(req).has(host);
    // Dev previews are served from a sandbox subdomain in an iframe; production never allows this.
    if (!ok && !config.isProd && /\.e2b\.app$/.test(parsed.hostname)) ok = true;
    if (!ok) return res.status(403).json({ error: 'Cross-site request blocked' });
  }

  const length = Number(req.get('content-length') || 0);
  if (length > 0 && !/^application\/json\b/i.test(req.get('content-type') || '')) {
    return res.status(415).json({ error: 'Expected application/json' });
  }
  next();
}

/** API responses must never be cached by shared proxies (they contain balances and orders). */
function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
}

module.exports = { csrfGuard, noStore, isCallback, allowedHosts };
