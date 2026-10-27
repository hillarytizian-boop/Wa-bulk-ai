const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const catalog = require('../catalog');
const pricing = require('../pricing');
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
    minTopupKes: config.minTopupKes,
    maxTopupKes: config.maxTopupKes,
    fields: FIELD_META,
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

    let list = c.list;
    if (category && category !== 'All') list = list.filter((s) => s.category === category);
    if (q) list = list.filter((s) => s.name.toLowerCase().includes(q) || String(s.id) === q || s.category.toLowerCase().includes(q));

    const perPage = Math.min(200, Math.max(1, Number(req.query.per_page) || 20));
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / perPage));
    const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
    const slice = list.slice((page - 1) * perPage, page * perPage);

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      services: slice.map((s) => presentService(s, settings)),
      categories: [...new Set(c.list.map((s) => s.category))].sort((a, b) => a.localeCompare(b)),
      pagination: { page, per_page: perPage, total, pages },
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
