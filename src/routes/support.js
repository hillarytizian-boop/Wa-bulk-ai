// Support tickets and per-customer favourite services.
//
// Tickets are a two-party thread: the customer opens one with a subject + first message, and
// either side can keep replying. `last_reply_by` lets the list show "waiting on us" vs
// "waiting on customer" without counting rows on every render.
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { HttpError, wrap } = require('../errors');
const { requireAuth } = require('./auth');

const router = express.Router();

const now = () => Math.floor(Date.now() / 1000);
const iso = (t) => new Date(Number(t) * 1000).toISOString();
const MAX_MESSAGE = 4000;
const MAX_SUBJECT = 120;

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

const presentTicket = (t) => ({
  id: Number(t.id),
  subject: t.subject,
  status: t.status,
  last_reply_by: t.last_reply_by,
  email: t.email || undefined,
  messages: t.messages == null ? undefined : Number(t.messages),
  created_at: iso(t.created_at),
  updated_at: iso(t.updated_at),
});

const presentMessage = (m) => ({
  id: Number(m.id),
  body: m.body,
  is_admin: Number(m.is_admin) === 1,
  created_at: iso(m.created_at),
});

function cleanBody(value, max, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new HttpError(400, `${label} is required`);
  if (text.length > max) throw new HttpError(400, `${label} is too long (max ${max} characters)`);
  return text;
}

// ------------------------------------------------------------------ favorites
router.get(
  '/favorites',
  requireAuth,
  wrap(async (req, res) => {
    const rows = await db.all('SELECT service_id FROM favorites WHERE user_id = $1 ORDER BY id DESC', [req.user.id]);
    res.json({ favorites: rows.map((r) => Number(r.service_id)) });
  })
);

router.post(
  '/favorites',
  requireAuth,
  writeLimiter,
  wrap(async (req, res) => {
    const serviceId = Number(req.body && req.body.service_id);
    if (!Number.isInteger(serviceId) || serviceId <= 0) throw new HttpError(400, 'service_id is required');
    const existing = await db.one('SELECT id FROM favorites WHERE user_id = $1 AND service_id = $2', [req.user.id, serviceId]);
    if (existing) {
      await db.run('DELETE FROM favorites WHERE user_id = $1 AND service_id = $2', [req.user.id, serviceId]);
      return res.json({ service_id: serviceId, favorite: false });
    }
    await db.run('INSERT INTO favorites (user_id, service_id, created_at) VALUES ($1,$2,$3)', [req.user.id, serviceId, now()]);
    res.json({ service_id: serviceId, favorite: true });
  })
);

// ------------------------------------------------------------------ tickets
/** Load a ticket the caller is allowed to see: their own, or any if they are an admin. */
async function loadTicket(req, id) {
  const ticketId = Number(id);
  if (!Number.isInteger(ticketId) || ticketId <= 0) throw new HttpError(404, 'Ticket not found');
  const ticket = await db.one('SELECT * FROM tickets WHERE id = $1', [ticketId]);
  if (!ticket) throw new HttpError(404, 'Ticket not found');
  const isOwner = Number(ticket.user_id) === Number(req.user.id);
  if (!isOwner && !req.user.is_admin) throw new HttpError(403, 'Not your ticket');
  return ticket;
}

router.get(
  '/tickets',
  requireAuth,
  wrap(async (req, res) => {
    const scope = String(req.query.scope || '').trim();
    const all = scope === 'all' && req.user.is_admin;
    const status = String(req.query.status || '').trim();
    const params = [];
    let sql = `SELECT t.*, u.email,
                      (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS messages
                 FROM tickets t JOIN users u ON u.id = t.user_id`;
    const where = [];
    if (!all) { params.push(req.user.id); where.push(`t.user_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`t.status = $${params.length}`); }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY t.updated_at DESC, t.id DESC LIMIT 100';
    const rows = await db.all(sql, params);
    res.json({ tickets: rows.map(presentTicket) });
  })
);

router.post(
  '/tickets',
  requireAuth,
  writeLimiter,
  wrap(async (req, res) => {
    const subject = cleanBody(req.body && req.body.subject, MAX_SUBJECT, 'Subject');
    const body = cleanBody(req.body && req.body.message, MAX_MESSAGE, 'Message');
    const ts = now();
    const ticket = await db.one(
      'INSERT INTO tickets (user_id, subject, status, last_reply_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5) RETURNING id',
      [req.user.id, subject, 'open', 'user', ts]
    );
    await db.run('INSERT INTO ticket_messages (ticket_id, user_id, is_admin, body, created_at) VALUES ($1,$2,$3,$4,$5)', [
      ticket.id, req.user.id, 0, body, ts,
    ]);
    res.status(201).json({ ticket: presentTicket({ ...ticket, subject, status: 'open', last_reply_by: 'user', created_at: ts, updated_at: ts, messages: 1 }) });
  })
);

router.get(
  '/tickets/:id',
  requireAuth,
  wrap(async (req, res) => {
    const ticket = await loadTicket(req, req.params.id);
    const messages = await db.all('SELECT * FROM ticket_messages WHERE ticket_id = $1 ORDER BY id ASC', [ticket.id]);
    res.json({ ticket: presentTicket(ticket), messages: messages.map(presentMessage) });
  })
);

router.post(
  '/tickets/:id/messages',
  requireAuth,
  writeLimiter,
  wrap(async (req, res) => {
    const ticket = await loadTicket(req, req.params.id);
    const body = cleanBody(req.body && req.body.body, MAX_MESSAGE, 'Message');
    const ts = now();
    const isAdmin = req.user.is_admin ? 1 : 0;
    await db.run('INSERT INTO ticket_messages (ticket_id, user_id, is_admin, body, created_at) VALUES ($1,$2,$3,$4,$5)', [
      ticket.id, req.user.id, isAdmin, body, ts,
    ]);
    await db.run('UPDATE tickets SET updated_at = $1, last_reply_by = $2, status = $3 WHERE id = $4', [
      ts, isAdmin ? 'admin' : 'user', 'open', ticket.id,
    ]);
    const messages = await db.all('SELECT * FROM ticket_messages WHERE ticket_id = $1 ORDER BY id ASC', [ticket.id]);
    res.status(201).json({ messages: messages.map(presentMessage) });
  })
);

router.post(
  '/tickets/:id/close',
  requireAuth,
  wrap(async (req, res) => {
    const ticket = await loadTicket(req, req.params.id);
    await db.run("UPDATE tickets SET status = 'closed', updated_at = $1 WHERE id = $2", [now(), ticket.id]);
    res.json({ ticket: presentTicket({ ...ticket, status: 'closed' }) });
  })
);

module.exports = router;
