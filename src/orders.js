// Order engine: charge the wallet, submit to smm.africa with a stable idempotency key,
// poll status, and settle refunds exactly once.
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

// Locally pending: we do not know yet whether the provider accepted it.
const SUBMITTING = 'submitting';
// Provider has it and it is not finished.
const ACTIVE = new Set([SUBMITTING, 'queued', 'pending', 'processing', 'in progress']);
// Finished - nothing more will happen.
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
const addBalance = (userId, cents, type, ref, note) => {
  db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?').run(cents, userId);
  db.prepare('INSERT INTO transactions (user_id, amount_cents, type, ref, note, created_at) VALUES (?,?,?,?,?,?)').run(
    userId,
    cents,
    type,
    ref,
    note,
    now()
  );
};

/** Refund at most what is still unrefunded on an order. Runs inside a transaction. */
function refundOnce(orderId, amountCents, note) {
  return db.transaction(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o) return 0;
    const remaining = o.price_cents - o.refunded_cents;
    const amount = Math.max(0, Math.min(Math.round(amountCents), remaining));
    if (amount <= 0) return 0;
    db.prepare('UPDATE orders SET refunded_cents = refunded_cents + ? WHERE id = ?').run(amount, orderId);
    addBalance(o.user_id, amount, 'refund', `order:${orderId}`, note);
    return amount;
  })();
}

/** Definitive provider rejection: full refund, order is closed. */
function failOrder(orderId, reason) {
  return db.transaction(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o || o.settled) return false;
    db.prepare("UPDATE orders SET status = 'failed', settled = 1, error = ?, updated_at = ? WHERE id = ?").run(
      String(reason || 'Order failed').slice(0, 300),
      now(),
      orderId
    );
    const amount = o.price_cents - o.refunded_cents;
    if (amount > 0) {
      db.prepare('UPDATE orders SET refunded_cents = refunded_cents + ? WHERE id = ?').run(amount, orderId);
      addBalance(o.user_id, amount, 'refund', `order:${orderId}`, 'Automatic refund: provider rejected the order');
    }
    return true;
  })();
}

const getOrder = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));

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

  const refillAllowed = service.refill ? 1 : 0;
  const cancelAllowed = service.cancel ? 1 : 0;

  // Charge and create the order atomically: no balance is held without an order row.
  const orderId = db.transaction(() => {
    const user = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(userId);
    if (!user) throw new HttpError(401, 'Please log in');
    if (user.balance_cents < priceCents) {
      throw new HttpError(402, 'Insufficient wallet balance. Top up your wallet to place this order.');
    }
    const t = now();
    const idem = `ord_${crypto.randomUUID()}`;
    const info = db
      .prepare(
        `INSERT INTO orders (user_id, service_id, service_name, service_type, category, link, quantity, details,
           refill_allowed, cancel_allowed, price_cents, markup, kes_per_usd, fee_cents, status, idempotency_key,
           attempts, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`
      )
      .run(
        userId,
        service.id,
        service.name,
        service.type,
        service.category,
        details.link || '',
        quantity,
        JSON.stringify(payload),
        refillAllowed,
        cancelAllowed,
        priceCents,
        settings.markup,
        settings.kesPerUsd,
        settings.feeCents,
        SUBMITTING,
        idem,
        t,
        t
      );
    const id = Number(info.lastInsertRowid);
    addBalance(userId, -priceCents, 'order', `order:${id}`, `Order #${id} - ${service.name}`);
    return id;
  })();

  const result = await submitOrder(orderId);
  if (result.failed) throw new HttpError(502, result.message || 'The provider rejected this order. You have been refunded.');
  return getOrder(orderId);
}

// ---------------------------------------------------------------- submission
function orderSettings(order) {
  return { markup: order.markup, kesPerUsd: order.kes_per_usd, feeCents: order.fee_cents };
}

/** Re-price the order from the provider's authoritative "charged" amount. */
function reconcileCharged(order, chargedUsd) {
  const costMicros = usdToMicros(chargedUsd);
  const actual = pricing.priceCentsFromCharged(
    chargedUsd,
    { type: order.service_type, quantity: order.quantity },
    orderSettings(order)
  );
  if (!actual || actual === order.price_cents) {
    db.prepare('UPDATE orders SET provider_cost_usd_micros = ? WHERE id = ?').run(costMicros, order.id);
    return;
  }
  const delta = actual - order.price_cents; // >0: undercharged, <0: overcharged
  db.transaction(() => {
    if (delta < 0) {
      db.prepare('UPDATE orders SET price_cents = ?, provider_cost_usd_micros = ? WHERE id = ?').run(actual, costMicros, order.id);
      refundOnce(order.id, -delta, 'Price correction: provider charged less than quoted');
    } else {
      const user = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(order.user_id);
      if (user && user.balance_cents >= delta) {
        db.prepare('UPDATE orders SET price_cents = ?, provider_cost_usd_micros = ? WHERE id = ?').run(actual, costMicros, order.id);
        addBalance(order.user_id, -delta, 'order', `order:${order.id}`, 'Price correction: provider charged more than quoted');
      } else {
        // Never leave the customer in debt: keep the quoted price and absorb the difference.
        db.prepare('UPDATE orders SET provider_cost_usd_micros = ? WHERE id = ?').run(costMicros, order.id);
      }
    }
  })();
}

/**
 * Submit (or re-submit) an order using its stored idempotency key.
 * Returns { order } on success, { failed } on a definitive rejection,
 * or { ambiguous } when the outcome is unknown (retried later, never auto-refunded).
 */
async function submitOrder(orderId) {
  const order = getOrder(orderId);
  if (!order || FINAL.has(order.status) || order.status === NEEDS_REVIEW) return { order };

  db.prepare('UPDATE orders SET attempts = attempts + 1, updated_at = ? WHERE id = ?').run(now(), order.id);

  try {
    const res = await smm.add(JSON.parse(order.details), order.idempotency_key);
    const providerOrderId = res && res.order != null ? String(res.order) : null;
    if (!providerOrderId) throw new smm.ProviderError('Provider did not return an order id', { ambiguous: true });
    const charged = res.charged != null ? Number(res.charged) : null;
    const rawStatus = res.status ? mapProviderStatus(res.status) : 'queued';

    db.prepare(
      `UPDATE orders SET provider_order_id = ?, status_raw = ?, status = ?, error = NULL, updated_at = ?,
         last_polled_at = 0 WHERE id = ?`
    ).run(providerOrderId, res.status ? String(res.status) : null, rawStatus, now(), order.id);

    if (charged != null && Number.isFinite(charged)) {
      reconcileCharged(getOrder(order.id), charged);
    }
    return { order: getOrder(order.id) };
  } catch (err) {
    if (err instanceof smm.ProviderError && err.definitive) {
      failOrder(order.id, err.message);
      return { failed: true, message: err.message, order: getOrder(order.id) };
    }
    // Ambiguous: keep the order pending and retry with the same key. Never refund here.
    const fresh = getOrder(order.id);
    const attempts = fresh ? fresh.attempts : 0;
    const review = attempts >= config.smm.maxSubmitAttempts;
    db.prepare('UPDATE orders SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(
      review ? NEEDS_REVIEW : SUBMITTING,
      `${err.message}${review ? ' (sent to admin review)' : ' (will retry)'}`.slice(0, 300),
      review ? now() : 0,
      order.id
    );
    console.warn(`[orders] submit #${order.id} ambiguous: ${err.message}`);
    return { ambiguous: true, message: err.message, order: getOrder(order.id) };
  }
}

/** Retry orders whose submission outcome is unknown. Same payload, same key. */
async function recoverSubmitting(limit = 20) {
  const rows = db
    .prepare(
      `SELECT id FROM orders WHERE status = ? AND (updated_at = 0 OR updated_at <= ?) ORDER BY id LIMIT ?`
    )
    .all(SUBMITTING, now() - 5, limit);
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await submitOrder(r.id);
  }
  return rows.length;
}

// ---------------------------------------------------------------- status sync
const pollIntervalFor = (order) => {
  const age = now() - order.created_at;
  if (age < 10 * 60) return 30; // every 30s at first
  if (age < 60 * 60) return 120; // then every 2 minutes
  return 600; // then every 10 minutes
};

async function syncOrder(orderId) {
  const order = getOrder(orderId);
  if (!order || !order.provider_order_id) return order;
  if (FINAL.has(order.status) || order.status === NEEDS_REVIEW) return order;

  let res;
  try {
    res = await smm.status(order.provider_order_id);
  } catch (err) {
    db.prepare('UPDATE orders SET last_polled_at = ?, error = ? WHERE id = ?').run(
      now(),
      `Status check failed: ${err.message}`.slice(0, 300),
      order.id
    );
    return getOrder(order.id);
  }

  const raw = res && (res.status != null ? res.status : res.Status);
  if (raw == null) return order;
  const status = mapProviderStatus(raw);
  const remains = res.remains != null && Number.isFinite(Number(res.remains)) ? Number(res.remains) : null;
  const startCount = res.start_count != null && Number.isFinite(Number(res.start_count)) ? Number(res.start_count) : null;

  db.prepare(
    `UPDATE orders SET status = ?, status_raw = ?, remains = COALESCE(?, remains),
       start_count = COALESCE(?, start_count), last_polled_at = ?, updated_at = ? WHERE id = ?`
  ).run(status, String(raw), remains, startCount, now(), now(), order.id);

  const fresh = getOrder(order.id);
  if (status === 'completed') {
    db.prepare('UPDATE orders SET settled = 1 WHERE id = ?').run(fresh.id);
  } else if (status === 'canceled' || status === 'refunded') {
    settleFull(fresh, `Refund: order ${status} by provider`);
  } else if (status === 'failed') {
    failOrder(fresh.id, 'Provider reported the order as failed');
  } else if (status === 'partial') {
    settlePartial(fresh, remains, res);
  }
  return getOrder(order.id);
}

function settleFull(order, note) {
  db.transaction(() => {
    const fresh = getOrder(order.id);
    if (!fresh) return;
    const amount = fresh.price_cents - fresh.refunded_cents;
    if (amount > 0) refundOnce(fresh.id, amount, note);
    db.prepare('UPDATE orders SET settled = 1, updated_at = ? WHERE id = ?').run(now(), fresh.id);
  })();
}

/**
 * Partial delivery: refund the undelivered share exactly once.
 * Uses `remains` when the provider sends it, otherwise the ratio of the actual charge.
 */
function settlePartial(order, remains, res) {
  db.transaction(() => {
    const fresh = getOrder(order.id);
    if (!fresh || fresh.settled) return;
    const qty = Number(fresh.quantity) || 0;
    let undeliveredCents = 0;
    if (qty > 0 && remains != null && Number.isFinite(remains)) {
      const undelivered = Math.min(qty, Math.max(0, remains));
      undeliveredCents = ceilScaled(fresh.price_cents, undelivered, qty);
    } else if (res && res.charge != null && fresh.provider_cost_usd_micros) {
      const chargedUsd = microsToUsd(fresh.provider_cost_usd_micros);
      const ratio = chargedUsd > 0 ? Math.max(0, 1 - Number(res.charge) / chargedUsd) : 0;
      undeliveredCents = Math.round(fresh.price_cents * ratio);
    }
    db.prepare('UPDATE orders SET settled = 1, updated_at = ? WHERE id = ?').run(now(), fresh.id);
    if (undeliveredCents > 0) refundOnce(fresh.id, undeliveredCents, 'Partial refund: undelivered share');
  })();
}

/** Poll every order that is still running (called by the background job). */
async function pollActive(limit = 40) {
  const rows = db
    .prepare(
      `SELECT * FROM orders WHERE status IN ('queued','pending','processing') AND provider_order_id IS NOT NULL
       ORDER BY last_polled_at ASC LIMIT ?`
    )
    .all(limit);
  const due = rows.filter((o) => now() - o.last_polled_at >= pollIntervalFor(o));
  for (const o of due) {
    // eslint-disable-next-line no-await-in-loop
    await syncOrder(o.id);
  }
  return due.length;
}

// ---------------------------------------------------------------- refill/cancel
async function requestRefill(userId, orderId) {
  const o = getOrder(orderId);
  if (!o || o.user_id !== userId) throw new HttpError(404, 'Order not found');
  if (!o.refill_allowed) throw new HttpError(400, 'This service does not support refills');
  if (!['completed', 'partial'].includes(o.status)) throw new HttpError(400, 'Only finished orders can be refilled');
  if (o.last_refill_at && now() - o.last_refill_at < 24 * 3600) {
    throw new HttpError(429, 'A refill was already requested for this order in the last 24 hours');
  }
  if (!o.provider_order_id) throw new HttpError(400, 'This order has no provider id yet');

  try {
    const res = await smm.refill(o.provider_order_id);
    db.prepare('UPDATE orders SET last_refill_at = ? WHERE id = ?').run(now(), o.id);
    return (res && res.success) || 'Refill request accepted.';
  } catch (err) {
    throw new HttpError(502, `Refill failed: ${err.message}`);
  }
}

async function requestCancel(userId, orderId) {
  const o = getOrder(orderId);
  if (!o || o.user_id !== userId) throw new HttpError(404, 'Order not found');
  if (!o.cancel_allowed) throw new HttpError(400, 'This service does not support cancellation');
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
    price_cents: o.price_cents,
    refunded_cents: o.refunded_cents,
    refill_allowed: Boolean(o.refill_allowed),
    cancel_allowed: Boolean(o.cancel_allowed),
    can_refill: Boolean(o.refill_allowed) && ['completed', 'partial'].includes(o.status),
    can_cancel: Boolean(o.cancel_allowed) && !FINAL.has(o.status) && o.status !== NEEDS_REVIEW,
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
  requestRefill,
  requestCancel,
  refundOnce,
  failOrder,
  settleFull,
  getOrder,
  present,
  buildDetails,
  mapProviderStatus,
};
