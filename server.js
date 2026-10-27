// Vercel entrypoint.
//
// The platform detects a root `server.js`, so this file is always what gets wrapped as the
// function, no matter what else is in the tree. The Express app is required lazily and every
// failure path is converted into JSON with a stack, because an uncaught throw during a cold
// start surfaces to the browser as an opaque FUNCTION_INVOCATION_FAILED page with no details.
let app = null;
let loadError = null;

function load() {
  if (!app && !loadError) {
    try {
      app = require('./src/webapp');
    } catch (err) {
      loadError = err;
      console.error('[server] failed to load the app:', err);
    }
  }
  if (loadError) throw loadError;
  return app;
}

function bootFailure(res, err) {
  if (res.writableEnded) return;
  res.statusCode = 500;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({
    error: 'boot_failed',
    message: err && err.message,
    code: err && err.code,
    stack: String((err && err.stack) || '').split('\n').slice(0, 8),
  }));
}

async function handler(req, res) {
  try {
    return await load()(req, res);
  } catch (err) {
    console.error('[server] request failed:', err);
    return bootFailure(res, err);
  }
}

module.exports = handler;
module.exports.createApp = () => load();
