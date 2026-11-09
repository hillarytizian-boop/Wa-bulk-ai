const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const platforms = require('../platforms');
const catalog = require('../catalog');
const pricing = require('../pricing');
const recommend = require('../recommend');
const orders = require('../orders');
const mpesa = require('../mpesa');
const { HttpError, wrap } = require('../errors');
const { getTypeDef, FIELD_META } = require('../serviceTypes');
const { requireAuth } = require('./auth');

const router = express.Router();

const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

router.get('/meta', (_req, res) => {
  res.json({
    siteName: config.siteName,
    currency: 'KES',
    mpesaEnabled: mpesa.enabled,
    googleEnabled: config.google.enabled,
    minTopupKes: config.minTopupKes,
    maxTopupKes: config.maxTopupKes,
    // display-only FX rate so the panel can show prices in USD as well as KES
    kesPerUsd: config.pricing.kesPerUsd,
    // changes on every deploy; the SPA polls /meta to offer "an app update is ready"
    build: process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || 'dev',
    fields: FIELD_META,
    // "text me on WhatsApp" - the number lives in config so it can change without a redeploy
    support: {
      phone: config.support.phone,
      whatsapp: config.support.whatsapp,
      whatsappUrl: config.support.whatsapp ? `https://wa.me/${config.support.whatsapp}` : null,
    },
  });
});

/** Public view of a service. Provider rates are NEVER included - only customer-facing KES prices. */
function presentService(s, settings) {
  const def = getTypeDef(s.type);
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    category: s.category,
    // KES per 1000 units (per order for flat types), including the fixed fee.
    rate_cents: pricing.rateCentsPer1000(s.rate, settings),
    flat: Boolean(def.flat),
    fields: def.fields,
    lines_from: def.linesFrom || null,
    min: s.min,
    max: s.max,
    refill: s.refill,
    cancel: s.cancel,
    start_time: s.startTime,
    speed: s.speed,
    drop_rate: s.dropRate,
    reliability: s.reliability,
  };
}

// Catalog: search + category filter + pagination.
router.get(
  '/services',
  wrap(async (req, res) => {
    let c;
    try {
      c = await catalog.load();
    } catch (err) {
      console.error('[services] catalog unavailable:', err.message);
      throw new HttpError(503, 'Services are temporarily unavailable. Please try again shortly.');
    }
    const settings = pricing.getSettings();
    const q = String(req.query.q || '').trim().toLowerCase();
    const category = String(req.query.category || '').trim();
    const platform = String(req.query.platform || '').trim().toLowerCase();
    const ids = String(req.query.ids || '').split(',').map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
    const sort = String(req.query.sort || 'default').trim().toLowerCase();

    // platform first (the provider has no platform field - see src/platforms.js), then category
    let pool = c.list;
    if (ids.length) pool = c.list.filter((s) => ids.includes(Number(s.id)));
    else if (platform && platform !== 'all') pool = pool.filter((s) => platforms.platformOf(s.category).key === platform);

    // categories are scoped to the chosen platform so the dropdown never offers an empty list
    const categories = [...new Set(pool.map((s) => s.category))].sort((a, b) => a.localeCompare(b));

    let list = pool;
    if (category && category !== 'All') list = list.filter((s) => s.category === category);
    if (q) list = list.filter((s) => s.name.toLowerCase().includes(q) || String(s.id) === q || s.category.toLowerCase().includes(q));

    if (sort === 'cheap' || sort === 'expensive') {
      const price = new Map(list.map((s) => [s.id, pricing.rateCentsPer1000(s.rate, settings)]));
      const dir = sort === 'cheap' ? 1 : -1;
      list = [...list].sort((a, b) => (price.get(a.id) - price.get(b.id)) * dir);
    } else if (sort === 'name') {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    }

    const perPage = Math.min(200, Math.max(1, Number(req.query.per_page) || 20));
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / perPage));
    const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
    const slice = list.slice((page - 1) * perPage, page * perPage);

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      services: slice.map((s) => presentService(s, settings)),
      platform: platform && platform !== 'all' ? platform : null,
      platforms: platforms.platformList(c.list),
      categories,
      sort,
      pagination: { page, per_page: perPage, total, pages },
    });
  })
);

// Paste-a-link advice. POST (not GET) so the customer's link never lands in a URL, an access
// log or a Referer header.
router.post(
  '/recommend',
  wrap(async (req, res) => {
    const link = String((req.body && req.body.link) || '').trim().slice(0, 500);
    const quantity = Number(req.body && req.body.quantity) || 0;
    const goal = String((req.body && req.body.goal) || '').toLowerCase().slice(0, 20);
    const sort = String((req.body && req.body.sort) || '').toLowerCase().slice(0, 10);
    let c;
    try {
      c = await catalog.load();
    } catch (err) {
      console.error('[recommend] catalog unavailable:', err.message);
      throw new HttpError(503, 'Services are temporarily unavailable. Please try again shortly.');
    }
    const out = recommend.recommend(link, c.list, pricing.getSettings(), { quantity, goal, sort, limit: 3 });
    res.set('Cache-Control', 'no-store');
    res.json(out);
  })
);

// Trending: what customers are actually buying, plus momentum per platform.
//
// Honest signals only - paid orders in the last 30 days (weighted x3) and how often a
// service has been starred. A brand-new panel has neither, so the list is topped up with
// the cheapest service on each platform rather than showing an empty screen.
router.get(
  '/trending',
  wrap(async (req, res) => {
    let c;
    try {
      c = await catalog.load();
    } catch (err) {
      console.error('[trending] catalog unavailable:', err.message);
      throw new HttpError(503, 'Services are temporarily unavailable. Please try again shortly.');
    }
    const settings = pricing.getSettings();
    const days = 30;
    const since = Math.floor(Date.now() / 1000) - days * 86400;

    const score = new Map();
    const orderCount = new Map();
    const add = (id, weight) => {
      const key = Number(id);
      if (!Number.isInteger(key) || key <= 0) return;
      score.set(key, (score.get(key) || 0) + weight);
    };

    try {
      const rows = await db.all(
        'SELECT service_id, COUNT(*) AS n FROM orders WHERE created_at > $1 GROUP BY service_id ORDER BY 2 DESC LIMIT 50',
        [since]
      );
      for (const r of rows) {
        const n = Number(r.n) || 0;
        orderCount.set(Number(r.service_id), n);
        add(r.service_id, n * 3);
      }
    } catch (err) {
      console.warn('[trending] orders unavailable:', err.message);
    }
    try {
      const rows = await db.all(
        'SELECT service_id, COUNT(*) AS n FROM favorites GROUP BY service_id ORDER BY 2 DESC LIMIT 50'
      );
      for (const r of rows) add(r.service_id, Number(r.n) || 0);
    } catch (err) {
      console.warn('[trending] favorites unavailable:', err.message);
    }

    const byId = new Map(c.list.map((s) => [Number(s.id), s]));
    const ranked = [...score.entries()]
      .filter(([id]) => byId.has(id))
      .sort((a, b) => b[1] - a[1]);
    const source = ranked.length ? 'activity' : 'popular';

    const picks = ranked.slice(0, 12).map(([id, sc]) => ({ service: byId.get(id), score: sc, real: true }));

    if (picks.length < 12) {
      // Top up with the cheapest offering on each platform, biggest platforms first.
      const taken = new Set(picks.map((p) => Number(p.service.id)));
      const cheapest = new Map();
      for (const s of c.list) {
        if (!s.rate || s.rate <= 0) continue;
        const key = platforms.platformOf(s.category).key;
        const prev = cheapest.get(key);
        if (!prev || s.rate < prev.rate) cheapest.set(key, s);
      }
      const order = platforms.platformList(c.list).map((p) => p.key);
      for (const key of order) {
        if (picks.length >= 12) break;
        const s = cheapest.get(key);
        if (!s || taken.has(Number(s.id))) continue;
        taken.add(Number(s.id));
        picks.push({ service: s, score: orderCount.get(Number(s.id)) || 0, real: false });
      }
    }

    // Platform momentum: aggregate the same score per platform, best three win a "hot" badge.
    const perPlatform = new Map();
    for (const [id, sc] of ranked) {
      const s = byId.get(id);
      if (!s) continue;
      const p = platforms.platformOf(s.category);
      if (!perPlatform.has(p.key)) perPlatform.set(p.key, { key: p.key, name: p.name, color: p.color, score: 0 });
      perPlatform.get(p.key).score += sc;
    }
    const hot = [...perPlatform.values()].sort((a, b) => b.score - a.score).slice(0, 3);

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      window_days: days,
      source,
      platforms: hot,
      services: picks.map(({ service, score: sc }) => {
        const p = platforms.platformOf(service.category);
        return {
          ...presentService(service, settings),
          platform: { key: p.key, name: p.name, color: p.color },
          orders_30d: orderCount.get(Number(service.id)) || 0,
          score: sc,
        };
      }),
    });
  })
);

router.get(
  '/services/:id',
  wrap(async (req, res) => {
    const s = await catalog.getService(req.params.id);
    if (!s) throw new HttpError(404, 'Service not found');
    res.json({ service: { ...presentService(s, pricing.getSettings()), description: s.description } });
  })
);

// Live quote for the order form (same integer maths as the server uses to charge).
router.get(
  '/quote',
  wrap(async (req, res) => {
    const s = await catalog.getService(req.query.service);
    if (!s) throw new HttpError(404, 'Service not found');
    const settings = pricing.getSettings();
    const def = getTypeDef(s.type);
    const rawQty = Number(req.query.quantity);
    const quantity = Number.isFinite(rawQty) && rawQty > 0 ? Math.floor(rawQty) : def.flat ? 1 : 0;
    let priceCents = pricing.priceCents(s, quantity, settings);
    let problem = null;
    if (!def.flat && quantity > 0) {
      if (s.min && quantity < s.min) problem = `Minimum quantity is ${s.min}`;
      else if (s.max && quantity > s.max) problem = `Maximum quantity is ${s.max}`;
    }
    if (problem) priceCents = 0;
    res.json({ price_cents: priceCents, rate_cents: pricing.rateCentsPer1000(s.rate, settings), problem });
  })
);

router.post(
  '/orders',
  requireAuth,
  orderLimiter,
  wrap(async (req, res) => {
    const order = await orders.placeOrder(req.user.id, req.body || {});
    const user = await db.one('SELECT balance_cents FROM users WHERE id = $1', [req.user.id]);
    res.status(201).json({ order: orders.present(order), balance_cents: user.balance_cents });
  })
);

router.get(
  '/orders',
  requireAuth,
  wrap(async (req, res) => {
    // Serverless deployments have no long-running timer, so a customer's active orders are polled
    // here (throttled by last_polled_at, capped per request). See src/jobs.js for the cron sweep.
    if (req.query.sync !== '0') await orders.pollUserActive(req.user.id, 5).catch((err) => console.warn('[orders] lazy poll:', err.message));
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = await db.all('SELECT * FROM orders WHERE user_id = $1 AND id < $2 ORDER BY id DESC LIMIT 50', [
      req.user.id,
      before,
    ]);
    res.json({ orders: rows.map(orders.present) });
  })
);

// Manual refresh, rate limited to once every 15s per order.
const lastRefresh = new Map();
router.post(
  '/orders/:id/refresh',
  requireAuth,
  orderLimiter,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const o = orders.getOrder(id);
    if (!o || o.user_id !== req.user.id) throw new HttpError(404, 'Order not found');
    const key = `${req.user.id}:${id}`;
    if (Date.now() - (lastRefresh.get(key) || 0) > 15000) {
      lastRefresh.set(key, Date.now());
      await orders.syncOrder(id);
    }
    res.json({ order: orders.present(orders.getOrder(id)) });
  })
);

router.post(
  '/orders/:id/refill',
  requireAuth,
  orderLimiter,
  wrap(async (req, res) => {
    res.json({ message: await orders.requestRefill(req.user.id, Number(req.params.id)) });
  })
);

router.post(
  '/orders/:id/cancel',
  requireAuth,
  orderLimiter,
  wrap(async (req, res) => {
    res.json({ message: await orders.requestCancel(req.user.id, Number(req.params.id)) });
  })
);

module.exports = router;
