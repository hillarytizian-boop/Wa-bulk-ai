#!/usr/bin/env node
// Create/migrate the schema and seed pricing defaults + the first admin.
// Safe to run repeatedly (idempotent). Use it once after pointing DATABASE_URL at Supabase.
//
//   npm run migrate
const config = require('../src/config');
const db = require('../src/db');
const { migrate, seedAdmin } = require('../src/server');

(async () => {
  console.log(`[migrate] target: ${db.dialect}${db.dialect === 'sqlite' ? ` (${config.dbPath})` : ''}`);
  await migrate();
  const settings = await db.all('SELECT key, value FROM settings ORDER BY key');
  console.log(`[migrate] settings: ${settings.map((s) => `${s.key}=${s.value}`).join(', ')}`);
  await seedAdmin({ log: console.log });
  const counts = await db.one('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM orders) AS orders');
  console.log(`[migrate] users=${counts.users} orders=${counts.orders}`);
  await db.close();
  process.exit(0);
})().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
