// Vercel serverless entry point. The Express app is required lazily inside the handler so a
// cold-start failure surfaces as JSON with a stack trace instead of an opaque
// FUNCTION_INVOCATION_FAILED page.
let app = null;
let loadError = null;

module.exports = function handler(req, res) {
  if (!app && !loadError) {
    try {
      app = require('../src/app');
    } catch (err) {
      loadError = err;
      console.error('[api] failed to load the app:', err);
    }
  }
  if (loadError) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      error: 'boot_failed',
      message: loadError.message,
      code: loadError.code,
      stack: String(loadError.stack || '').split('\n').slice(0, 8),
    }));
    return;
  }
  return app(req, res);
};
