require('dotenv').config();
const crypto = require('crypto');
const path = require('path');

const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(String(v)));

const isProd = process.env.NODE_ENV === 'production';

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret === 'change-me') {
  if (isProd) throw new Error('JWT_SECRET must be set to a long random string in production.');
  jwtSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] JWT_SECRET not set - using a temporary secret (logins reset on restart).');
}

const mpesaEnv = (process.env.MPESA_ENV || 'sandbox').toLowerCase();
const port = num(process.env.PORT, 3000);

module.exports = {
  isProd,
  port,
  siteName: process.env.SITE_NAME || 'SMM Panel',
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  jwtSecret,
  dbPath: process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'store.db'),

  smm: {
    url: process.env.SMM_API_URL || 'https://smm.africa/api/v3',
    key: process.env.SMM_API_KEY || '',
    timeoutMs: num(process.env.SMM_TIMEOUT_MS, 60000),
    retryBaseMs: num(process.env.SMM_RETRY_BASE_MS, 2000),
    maxSubmitAttempts: num(process.env.SMM_MAX_ATTEMPTS, 8),
  },

  // Defaults only: the live values live in the `settings` table and are editable in the admin panel.
  pricing: {
    markup: num(process.env.DEFAULT_MARKUP, 0.3),
    kesPerUsd: num(process.env.KES_PER_USD, 129),
    feeKes: num(process.env.FEE_KES, 50),
  },

  minTopupKes: num(process.env.MIN_TOPUP_KES, 50),
  maxTopupKes: num(process.env.MAX_TOPUP_KES, 150000),

  admin: {
    email: process.env.ADMIN_EMAIL || '',
    password: process.env.ADMIN_PASSWORD || '',
  },

  mpesa: {
    enabled: Boolean(process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET && process.env.MPESA_PASSKEY),
    env: mpesaEnv,
    baseUrl:
      process.env.MPESA_BASE_URL ||
      (mpesaEnv === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke'),
    consumerKey: process.env.MPESA_CONSUMER_KEY || '',
    consumerSecret: process.env.MPESA_CONSUMER_SECRET || '',
    shortcode: process.env.MPESA_SHORTCODE || '174379',
    partyB: process.env.MPESA_PARTYB || process.env.MPESA_SHORTCODE || '174379',
    passkey: process.env.MPESA_PASSKEY || '',
    txnType: process.env.MPESA_TXN_TYPE || 'CustomerPayBillOnline',
  },
};
