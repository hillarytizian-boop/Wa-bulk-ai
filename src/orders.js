// Order engine: charge the wallet, submit to smm.africa with a stable idempotency key,
// poll status, and settle refunds exactly once.
//
// Every money mutation runs inside `db.tx()` and locks the rows it touches (`FOR UPDATE` on
// Postgres). On SQLite the adapter strips the lock and serialises transactions instead.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const smm = require('./smm');
const catalog = require('./catalog');
const pricing = require('./pricing');
const { HttpError } = require('./errors');
const { usdToMicros, microsToUsd, ceilScaled } = require('./money');
const { getTypeDef, countLines } = require('./serviceTypes');

const now = () => Math.floor(Date.now() / 1000);
const iso = (t) => new Date(t * 1000).toISOString();

const SUBMITTING = 'submitting';
const ACTIVE_STATUSES = ['queued', 'pending', 'processing'];
const FINAL = new Set(['completed', 'partial', 'refunded', 'canceled', 'failed']);
const NEEDS_REVIEW = 'needs_review';

const mapProviderStatus = (raw) => {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'in progress' || s === 'inprogress') return 'processing';
  if (s === 'canceled' || s === 'cancelled') return 'canceled';
  if (s === 'fail' || s === 'failed') return 'failed';
  if (['pending', 'queued', 'processing', 'completed', 'partial', 'refunded'].includes(s)) return s;
  return 'processing';
};

// ---------------------------------------------------------------- money moves
async function addBalance(t, userId, cents, type, ref, note) {
  await t.run('UPDATE users SET balance_cents = balance_cents + $1 WHERE id = $2', [cents, userId]);
  await t.run('INSERT INTO transactions (user_id, amount_cents, type, ref, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [
    userId,
    cents,
    type,
    ref,
    note,
    now(),
  ]);
}

/** Refund at most what is still unrefunded on an order. Must be called inside a transaction. */
async function refundOnceTx(t, orderId, amountCents, note) {
  const o = await t.one('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!o) return 0;
  const remaining = Number(o.price_cents) - Number(o.refunded_cents);
  const amount = Math.max(0, Math.min(Math.round(amountCents), remaining));
  if (amount <= 0) return 0;
  await t.run('UPDATE orders SET refunded_cents = refunded_cents + $1 WHERE id = $2', [amount, orderId]);
  await addBalance(t, o.user_id, amount, 'refund', `order:${orderId}`, note);
  return amount;
}

/** Definitive provider rejection: full refund, order closed. */
async function failOrder(orderId, reason) {
  return db.tx(async (t) => {
    const o = await t.one('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!o || Number(o.settled) === 1) return false;
    await t.run("UPDATE orders SET status = 'failed', settled = 1, error = $1, updated_at = $2 WHERE id = $3", [
      String(reason || 'Order failed').slice(0, 300),
      now(),
      orderId,
    ]);
    const amount = Number(o.price_cents) - Number(o.refunded_cents);
    if (amount > 0) {
      await t.run('UPDATE orders SET refunded_cents = refunded_cents + $1 WHERE id = $2', [amount, orderId]);
      await addBalance(t, o.user_id, amount, 'refund', `order:${orderId}`, 'Automatic refund: provider rejected the order');
    }
    return true;
  });
}

const getOrder = (id) => db.one('SELECT * FROM orders WHERE id = $1', [Number(id)]);

// ---------------------------------------------------------------- place order
/** Validate the customer's fields for a service type and build the provider payload. */
function buildDetails(service, input) {
  const def = getTypeDef(service.type);
  const details = {};
  let quantity = 1;

  for (const field of def.fields) {
    if (field === 'quantity') continue;
    const raw = input[field];
    let value = raw == null ? '' : String(raw).trim();
    if (!value) throw new HttpError(400, `Please fill in: ${field.replace(/_/g, ' ')}`);
    if (value.length > 5000) throw new HttpError(400, `${field} is too long`);
    // Normalise line lists so the provider counts exactly as many lines as we charge for.
    if (def.linesFrom === field) {
      value = value
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .join('\n');
    }
    details[field] = value;
  }

  if (def.linesFrom) {
    quantity = countLines(details[def.linesFrom]);
    if (quantity < 1) throw new HttpError(400, `Please provide at least one line in ${def.linesFrom}`);
  } else if (!def.flat) {
    quantity = Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) throw new HttpError(400, 'Enter a whole number quantity');
    if (service.min && quantity < service.min) throw new HttpError(400, `Minimum quantity for this service is ${service.min}`);
    if (service.max && quantity > service.max) throw new HttpError(400, `Maximum quantity for this service is ${service.max}`);
  }

  if (def.linesFrom && service.max && quantity > service.max) {
    throw new HttpError(400, `Maximum ${service.max} lines for this service`);
  }

  // The provider rejects "type" and does not want "quantity" for line-counted types.
  const payload = { service: service.id, ...details };
  if (!def.linesFrom && !def.flat) payload.quantity = quantity;
  return { details, quantity, payload };
}

async function placeOrder(userId, input) {
  const serviceId = Number(input && input.service);
  if (!Number.isInteger(serviceId) || serviceId <= 0) throw new HttpError(400, 'Choose a service');

  const service = await catalog.getService(serviceId);
  if (!service) throw new HttpError(404, 'Service not found');

  const { details, quantity, payload } = buildDetails(service, input);
  const settings = pricing.getSettings();
  const priceCents = pricing.priceCents(service, quantity, settings);
  if (priceCents < 1) throw new HttpError(400, 'This order is too small');

  // Charge and create the order atomically: no balance is held without an order row.
  const orderId = await db.tx(async (t) => {
    const user = await t.one('SELECT balance_cents FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!user) throw new HttpError(401, 'Please log in');
    if (Number(user.balance_cents) < priceCents) {
      throw new HttpError(402, 'Insufficient wallet balance. Top up your wallet to place this order.');
    }
    const t0 = now();
    const idem = `ord_${crypto.randomUUID()}`;
    const inserted = await t.one(
      `INSERT INTO orders (user_id, service_id, service_name, service_type, category, link, quantity, details,
         refill_allowed, cancel_allowed, price_cents, markup, kes_per_usd, fee_cents, status, idempotency_key,
         attempts, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0,$17,$18)
       RETURNING id`,
      [
        userId,
        service.id,
        service.name,
        service.type,
        service.category,
        details.link || '',
        quantity,
        JSON.stringify(payload),
        service.refill ? 1 : 0,
        service.cancel ? 1 : 0,
        priceCents,
        settings.markup,
        settings.kesPerUsd,
        settings.feeCents,
        SUBMITTING,
        idem,
        t0,
        t0,
      ]
    );
    const id = Number(inserted.id);
    await addBalance(t, userId, -priceCents, 'order', `order:${id}`, `Order #${id} - ${service.name}`);
    return id;
  });

  const result = await submitOrder(orderId);
  if (result.failed) throw new HttpError(502, result.message || 'The provider rejected this order. You have been refunded.');
  return getOrder(orderId);
}

// ---------------------------------------------------------------- submission
const orderSettings = (order) => ({ markup: order.markup, kesPerUsd: order.kes_per_usd, feeCents: Number(order.fee_cents) });

/** Re-price the order from the provider's authoritative "charged" amount. */
async function reconcileCharged(orderId, chargedUsd) {
  const costMicros = usdToMicros(chargedUsd);
  await db.tx(async (t) => {
    const o = await t.one('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!o) return;
    const actual = pricing.priceCentsFromCharged(
      chargedUsd,
      { type: o.service_type, quantity: o.quantity },
      orderSettings(o)
    );
    if (!actual || actual === Number(o.price_cents)) {
      await t.run('UPDATE orders SET provider_cost_usd_micros = $1 WHERE id = $2', [costMicros, orderId]);
      return;
    }
    const delta = actual - Number(o.price_cents); // >0: undercharged, <0: overcharged
    if (delta < 0) {
      await t.run('UPDATE orders SET price_cents = $1, provider_cost_usd_micros = $2 WHERE id = $3', [actual, costMicros, orderId]);
      await refundOnceTx(t, orderId, -delta, 'Price correction: provider charged less than quoted');
    } else {
      const user = await t.one('SELECT balance_cents FROM users WHERE id = $1 FOR UPDATE', [o.user_id]);
      if (user && Number(user.balance_cents) >= delta) {
        await t.run('UPDATE orders SET price_cents = $1, provider_cost_usd_micros = $2 WHERE id = $3', [actual, costMicros, orderId]);
        await addBalance(t, o.user_id, -delta, 'order', `order:${orderId}`, 'Price correction: provider charged more than quoted');
      } else {
        // Never leave the customer in debt: keep the quoted price and absorb the difference.
        await t.run('UPDATE orders SET provider_cost_usd_micros = $1 WHERE id = $2', [costMicros, orderId]);
      }
    }
  });
}

/**
 * Submit (or re-submit) an order using its stored idempotency key.
 * Returns { order } on success, { failed } on a definitive rejection, or { ambiguous } when the
 * outcome is unknown (retried later with the same key, never auto-refunded).
 */
async function submitOrder(orderId) {
  const order = await getOrder(orderId);
  if (!order || FINAL.has(order.status) || order.status === NEEDS_REVIEW) return { order };

  await db.run('UPDATE orders SET attempts = attempts + 1, updated_at = $1 WHERE id = $2', [now(), order.id]);

  try {
    const res = await smm.add(JSON.parse(order.details), order.idempotency_key);
    const providerOrderId = res && res.order != null ? String(res.order) : null;
    if (!providerOrderId) throw new smm.ProviderError('Provider did not return an order id', { ambiguous: true });
    const charged = res.charged != null ? Number(res.charged) : null;
    const rawStatus = res.status ? mapProviderStatus(res.status) : 'queued';

    await db.run(
      `UPDATE orders SET provider_order_id = $1, status_raw = $2, status = $3, error = NULL, updated_at = $4,
         last_polled_at = 0 WHERE id = $5`,
      [providerOrderId, res.status ? String(res.status) : null, rawStatus, now(), order.id]
    );

    if (charged != null && Number.isFinite(charged)) await reconcileCharged(order.id, charged);
    return { order: await getOrder(order.id) };
  } catch (err) {
    if (err instanceof smm.ProviderError && err.definitive) {
      await failOrder(order.id, err.message);
      return { failed: true, message: err.message, order: await getOrder(order.id) };
    }
    // Ambiguous: keep the order pending and retry with the same key. Never refund here.
    const fresh = await getOrder(order.id);
    const attempts = fresh ? Number(fresh.attempts) : 0;
    const review = attempts >= config.smm.maxSubmitAttempts;
    await db.run('UPDATE orders SET status = $1, error = $2, updated_at = $3 WHERE id = $4', [
      review ? NEEDS_REVIEW : SUBMITTING,
      `${err.message}${review ? ' (sent to admin review)' : ' (will retry)'}`.slice(0, 300),
      review ? now() : 0,
      order.id,
    ]);
    console.warn(`[orders] submit #${order.id} ambiguous: ${err.message}`);
    return { ambiguous: true, message: err.message, order: await getOrder(order.id) };
  }
}

/** Retry orders whose submission outcome is unknown. Same payload, same key. */
async function recoverSubmitting(limit = 20) {
  const rows = await db.all('SELECT id FROM orders WHERE status = $1 AND (updated_at = 0 OR updated_at <= $2) ORDER BY id LIMIT $3', [
    SUBMITTING,
    now() - 5,
    limit,
  ]);
  for (const r of rows) await submitOrder(r.id);
  return rows.length;
}

// ---------------------------------------------------------------- status sync
const pollIntervalFor = (order) => {
  const age = now() - Number(order.created_at);
  if (age < 10 * 60) return 30; // every 30s at first
  if (age < 60 * 60) return 120; // then every 2 minutes
  return 600; // then every 10 minutes
};

async function syncOrder(orderId) {
  const order = await getOrder(orderId);
  if (!order || !order.provider_order_id) return order;
  if (FINAL.has(order.status) || order.status === NEEDS_REVIEW) return order;

  let res;
  try {
    res = await smm.status(order.provider_order_id);
  } catch (err) {
    await db.run('UPDATE orders SET last_polled_at = $1, error = $2 WHERE id = $3', [
      now(),
      `Status check failed: ${err.message}`.slice(0, 300),
      order.id,
    ]);
    return getOrder(order.id);
  }

  const raw = res && (res.status != null ? res.status : res.Status);
  if (raw == null) return order;
  const status = mapProviderStatus(raw);
  const remains = res.remains != null && Number.isFinite(Number(res.remains)) ? Number(res.remains) : null;
  const startCount = res.start_count != null && Number.isFinite(Number(res.start_count)) ? Number(res.start_count) : null;

  await db.run(
    `UPDATE orders SET status = $1, status_raw = $2, remains = COALESCE($3, remains),
       start_count = COALESCE($4, start_count), last_polled_at = $5, updated_at = $5 WHERE id = $6`,
    [status, String(raw), remains, startCount, now(), order.id]
  );

  const fresh = await getOrder(order.id);
  if (status === 'completed') {
    await db.run('UPDATE orders SET settled = 1 WHERE id = $1', [fresh.id]);
  } else if (status === 'canceled' || status === 'refunded') {
    await settleFull(fresh.id, `Refund: order ${status} by provider`);
  } else if (status === 'failed') {
    await failOrder(fresh.id, 'Provider reported the order as failed');
  } else if (status === 'partial') {
    await settlePartial(fresh.id, remains, res);
  }
  return getOrder(order.id);
}

async function settleFull(orderId, note) {
  await db.tx(async (t) => {
    const fresh = await t.one('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!fresh) return;
    const amount = Number(fresh.price_cents) - Number(fresh.refunded_cents);
    if (amount > 0) await refundOnceTx(t, fresh.id, amount, note);
    await t.run('UPDATE orders SET settled = 1, updated_at = $1 WHERE id = $2', [now(), fresh.id]);
  });
}

/**
 * Partial delivery: refund the undelivered share exactly once.
 * Uses `remains` when the provider sends it, otherwise the ratio of the actual charge.
 */
async function settlePartial(orderId, remains, res) {
  await db.tx(async (t) => {
    const fresh = await t.one('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!fresh || Number(fresh.settled) === 1) return;
    const qty = Number(fresh.quantity) || 0;
    let undeliveredCents = 0;
    if (qty > 0 && remains != null && Number.isFinite(remains)) {
      const undelivered = Math.min(qty, Math.max(0, remains));
      undeliveredCents = ceilScaled(Number(fresh.price_cents), undelivered, qty);
    } else if (res && res.charge != null && fresh.provider_cost_usd_micros) {
      const chargedUsd = microsToUsd(Number(fresh.provider_cost_usd_micros));
      const ratio = chargedUsd > 0 ? Math.max(0, 1 - Number(res.charge) / chargedUsd) : 0;
      undeliveredCents = Math.round(Number(fresh.price_cents) * ratio);
    }
    await t.run('UPDATE orders SET settled = 1, updated_at = $1 WHERE id = $2', [now(), fresh.id]);
    if (undeliveredCents > 0) await refundOnceTx(t, fresh.id, undeliveredCents, 'Partial refund: undelivered share');
  });
}

/** Poll every order that is still running (called by the background job / cron). */
async function pollActive(limit = 40) {
  // Explicit IN-list keeps the SQL portable between Postgres and SQLite.
  const placeholders = ACTIVE_STATUSES.map((_, i) => `$${i + 1}`).join(',');
  const rows = await db.all(
    `SELECT * FROM orders WHERE status IN (${placeholders}) AND provider_order_id IS NOT NULL
     ORDER BY last_polled_at ASC LIMIT $${ACTIVE_STATUSES.length + 1}`,
    [...ACTIVE_STATUSES, limit]
  );
  const due = rows.filter((o) => now() - Number(o.last_polled_at) >= pollIntervalFor(o));
  for (const o of due) await syncOrder(o.id);
  return due.length;
}

/**
 * Lazy polling used by the customer-facing endpoints: serverless platforms have no long-running
 * timer, so a customer's active orders are refreshed whenever they look at them (rate limited by
 * last_polled_at, and capped per request).
 */
async function pollUserActive(userId, limit = 5) {
  const placeholders = ACTIVE_STATUSES.map((_, i) => `$${i + 2}`).join(',');
  const rows = await db.all(
    `SELECT * FROM orders WHERE user_id = $1 AND status IN (${placeholders}) AND provider_order_id IS NOT NULL
     ORDER BY last_polled_at ASC LIMIT $${ACTIVE_STATUSES.length + 2}`,
    [userId, ...ACTIVE_STATUSES, limit]
  );
  let n = 0;
  for (const o of rows) {
    if (now() - Number(o.last_polled_at) < pollIntervalFor(o)) continue;
    await syncOrder(o.id);
    n += 1;
  }
  return n;
}

// ---------------------------------------------------------------- refill/cancel
async function requestRefill(userId, orderId) {
  const o = await getOrder(orderId);
  if (!o || o.user_id !== userId) throw new HttpError(404, 'Order not found');
  if (!Number(o.refill_allowed)) throw new HttpError(400, 'This service does not support refills');
  if (!['completed', 'partial'].includes(o.status)) throw new HttpError(400, 'Only finished orders can be refilled');
  if (Number(o.last_refill_at) && now() - Number(o.last_refill_at) < 24 * 3600) {
    throw new HttpError(429, 'A refill was already requested for this order in the last 24 hours');
  }
  if (!o.provider_order_id) throw new HttpError(400, 'This order has no provider id yet');

  try {
    const res = await smm.refill(o.provider_order_id);
    await db.run('UPDATE orders SET last_refill_at = $1 WHERE id = $2', [now(), o.id]);
    return (res && res.success) || 'Refill request accepted.';
  } catch (err) {
    throw new HttpError(502, `Refill failed: ${err.message}`);
  }
}

async function requestCancel(userId, orderId) {
  const o = await getOrder(orderId);
  if (!o || o.user_id !== userId) throw new HttpError(404, 'Order not found');
  if (!Number(o.cancel_allowed)) throw new HttpError(400, 'This service does not support cancellation');
  if (FINAL.has(o.status)) throw new HttpError(400, 'This order is already finished');
  if (!o.provider_order_id) throw new HttpError(400, 'This order has no provider id yet');

  try {
    const res = await smm.cancel(o.provider_order_id);
    return (res && res.success) || 'Cancellation request accepted.';
  } catch (err) {
    throw new HttpError(502, `Cancel failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------- presentation
/** Customer-safe view: provider cost and provider ids are never included. */
function present(o) {
  return {
    id: o.id,
    service_id: o.service_id,
    service_name: o.service_name,
    category: o.category,
    quantity: o.quantity,
    link: o.link,
    status: o.status,
    start_count: o.start_count,
    remains: o.remains,
    price_cents: Number(o.price_cents),
    refunded_cents: Number(o.refunded_cents),
    refill_allowed: Boolean(Number(o.refill_allowed)),
    cancel_allowed: Boolean(Number(o.cancel_allowed)),
    can_refill: Boolean(Number(o.refill_allowed)) && ['completed', 'partial'].includes(o.status),
    can_cancel: Boolean(Number(o.cancel_allowed)) && !FINAL.has(o.status) && o.status !== NEEDS_REVIEW,
    error: o.status === NEEDS_REVIEW ? null : o.error || null,
    created_at: iso(o.created_at),
    updated_at: iso(o.updated_at),
  };
}

module.exports = {
  SUBMITTING,
  NEEDS_REVIEW,
  FINAL,
  placeOrder,
  submitOrder,
  recoverSubmitting,
  syncOrder,
  pollActive,
  pollUserActive,
  requestRefill,
  requestCancel,
  failOrder,
  settleFull,
  getOrder,
  present,
  buildDetails,
  mapProviderStatus,
};
