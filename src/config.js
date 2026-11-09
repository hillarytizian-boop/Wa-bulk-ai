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
  // Where customers reach a human. Digits only, international format for the wa.me link.
  support: {
    phone: process.env.SUPPORT_PHONE || '0184355332',
    whatsapp: (process.env.SUPPORT_WHATSAPP || '254184355332').replace(/\D/g, ''),
  },
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  // The Arena preview and most local setups render the site in an iframe. Production defaults to
  // refusing framing; set ALLOW_IFRAME=true only if you really embed the panel somewhere.
  allowIframe: bool(process.env.ALLOW_IFRAME, !isProd),
  sessionDays: num(process.env.SESSION_DAYS, 14),
  authRateLimit: num(process.env.AUTH_RATE_LIMIT, 20),
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

  // Google sign-in (OAuth 2.0 code flow). Disabled unless both values are set.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    get enabled() {
      return Boolean(this.clientId && this.clientSecret);
    },
    redirectUri: process.env.GOOGLE_REDIRECT_URI || `${(process.env.PUBLIC_URL || `http://localhost:${num(process.env.PORT, 3000)}`).replace(/\/$/, '')}/api/auth/google/callback`,
  },

  // M-Pesa collections run through PayHero (Basic auth API key + one payment channel).
  // MPESA_* is read as a fallback so an older deployment keeps booting.
  payhero: (() => {
    const username = process.env.PAYHERO_API_USERNAME || '';
    const password = process.env.PAYHERO_API_PASSWORD || '';
    const basicAuth =
      process.env.PAYHERO_BASIC_AUTH ||
      (username && password ? Buffer.from(`${username}:${password}`).toString('base64') : '');
    const channelId = num(process.env.PAYHERO_CHANNEL_ID, 0);
    return {
      enabled: Boolean(basicAuth && channelId),
      baseUrl: (process.env.PAYHERO_BASE_URL || 'https://backend.payhero.co.ke').replace(/\/$/, ''),
      basicAuth,
      channelId,
      accountId: num(process.env.PAYHERO_ACCOUNT_ID, 0),
      provider: 'm-pesa',
    };
  })(),
};
