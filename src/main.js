// Long-running server entry point: used by `npm start`, Docker and any VPS/PM2 deploy.
// Vercel never runs this file - it imports src/webapp.js, which must stay side-effect free.
const config = require('./config');
const db = require('./db');
const jobs = require('./jobs');
const app = require('./webapp');

async function main() {
  await app.migrate();
  if (!config.smm.key) console.warn('[config] SMM_API_KEY is not set - the provider API will not work.');
  if (!/^https?:/.test(config.publicUrl)) {
    console.warn('[config] PUBLIC_URL should be an absolute URL (M-Pesa callbacks use it).');
  }
  if (config.isProd && !config.cookieSecure) console.warn('[config] COOKIE_SECURE should be true in production (HTTPS).');
  await app.seedAdmin();
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`${config.siteName} running on http://localhost:${config.port} (db: ${db.dialect})`);
    jobs.start();
  });
}

main().catch((err) => {
  console.error('[startup]', err);
  process.exit(1);
});
