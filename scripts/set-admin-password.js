#!/usr/bin/env node
// Set or rotate the admin password without ever writing it to a file in the repo.
//
//   npm run admin:password                      # prompts (input hidden)
//   npm run admin:password -- "NewPass123"      # inline (ends up in shell history - prefer the prompt)
//   npm run admin:password -- --email you@ke.co
//
// Works against DATABASE_URL (Supabase/Postgres) or the local SQLite file. Existing sessions are
// signed out because token_version is bumped. The password is never printed or logged.
const path = require('path');
const readline = require('readline');
const bcrypt = require('bcryptjs');

const config = require('../src/config');
const db = require('../src/db');

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (str) => {
      if (str.includes(question)) write(str);
      else if (str === '\r\n' || str === '\n') write(str);
      // otherwise swallow keystrokes so the password is not echoed
    };
    rl.question(question, (answer) => {
      rl._writeToOutput = write;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

(async () => {
  const args = process.argv.slice(2);
  let email = config.admin.email;
  let password = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email') email = args[++i];
    else if (!args[i].startsWith('--')) password = args[i];
  }

  if (!email) email = (await askHidden('Admin email: ')).trim();
  if (!email) {
    console.error('No admin email. Set ADMIN_EMAIL in .env or pass --email you@example.com');
    process.exit(1);
  }
  if (!password) {
    password = await askHidden(`New password for ${email} (hidden): `);
    const again = await askHidden('Repeat password: ');
    if (password !== again) {
      console.error('Passwords do not match.');
      process.exit(1);
    }
  }

  if (typeof password !== 'string' || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  if (Buffer.byteLength(password, 'utf8') > 72) {
    console.error('Password is too long (bcrypt max is 72 bytes).');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  const existing = await db.one('SELECT id, is_admin FROM users WHERE email = $1', [email.toLowerCase()]);

  if (existing) {
    await db.run('UPDATE users SET password_hash = $1, is_admin = 1, token_version = token_version + 1 WHERE id = $2', [
      hash,
      existing.id,
    ]);
    console.log(`Password updated for ${email}. All existing sessions were signed out.`);
  } else {
    await db.run('INSERT INTO users (email, password_hash, is_admin, created_at) VALUES ($1,$2,1,$3)', [
      email.toLowerCase(),
      hash,
      Math.floor(Date.now() / 1000),
    ]);
    console.log(`Admin account created: ${email}`);
  }

  console.log(`Database: ${db.dialect}${db.dialect === 'sqlite' ? ` (${path.resolve(config.dbPath)})` : ' (DATABASE_URL)'}`);
  console.log('The password itself was not logged or written anywhere.');
  await db.close();
  process.exit(0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
