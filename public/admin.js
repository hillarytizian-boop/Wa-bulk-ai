/* HilaPanel admin console — a separate page, deliberately not part of the customer SPA.
 *
 * Everything here is gated by the API: /api/admin/* answers 401 without a session and 403
 * without is_admin, so the page markup being public gives nothing away. The page itself
 * refuses to render anything except a sign-in prompt until /api/auth/me confirms an admin. */
(() => {
  'use strict';

  const view = document.getElementById('adminView');
  const who = document.getElementById('adminWho');
  const signOut = document.getElementById('signOut');

  // ------------------------------------------------------------------ helpers
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.setAttribute('style', v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const fill = (el, ...kids) => {
    el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
    return el;
  };

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(msg, isError) {
    const t = h('div', { class: `toast${isError ? ' error' : ''}` }, msg);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), isError ? 6500 : 3800);
  }

  const kes = (cents) => {
    const n = Math.round(Number(cents) || 0);
    const abs = Math.abs(n);
    const rem = abs % 100;
    return `${n < 0 ? '-' : ''}KSh ${Math.floor(abs / 100).toLocaleString('en-KE')}${rem ? `.${String(rem).padStart(2, '0')}` : ''}`;
  };
  const num = (n) => (n == null ? '—' : Number(n).toLocaleString());
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const skeletons = (n = 3) => h('div', { class: 'card' },
    Array.from({ length: n }, (_, i) => h('div', { class: i ? 'sk w70' : 'sk w55' })));

  function table(head, rows, empty) {
    if (!rows.length) return h('p', { class: 'muted' }, empty || 'Nothing here yet.');
    return h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, head.map((c) => h('th', { class: c.num ? 'num' : null }, c.label)))),
      h('tbody', null, rows)));
  }

  // ------------------------------------------------------------------ gate
  async function boot() {
    fill(view, skeletons(2));
    let user = null;
    try { user = (await api('/auth/me')).user; }
    catch (err) {
      if (err.status === 401) return signedOut();
      return fill(view, h('div', { class: 'card err' }, err.message));
    }
    if (!user || !user.is_admin) return forbidden(user);
    who.textContent = `${user.email} · admin`;
    signOut.hidden = false;
    render();
  }

  function signedOut() {
    who.textContent = 'Not signed in';
    fill(view, h('div', { class: 'card' },
      h('h2', null, 'Admin sign-in required'),
      h('p', { class: 'muted' }, 'This page only opens for the admin account. Sign in, then you will be brought straight back here.'),
      h('a', { class: 'btn block', href: '/#/login?next=/admin' }, 'Sign in')));
  }

  function forbidden(user) {
    who.textContent = user ? `${user.email} · not an admin` : 'Not signed in';
    fill(view, h('div', { class: 'card' },
      h('h2', null, 'Admin access only'),
      h('p', { class: 'muted' }, 'This account does not have admin rights. If you think that is a mistake, contact the site owner.'),
      h('a', { class: 'btn ghost block', href: '/' }, 'Back to the panel')));
    audit401();
  }

  // A stray visit from a normal customer is worth a line in the audit log, but a failure to
  // log must never surface as an error to them.
  function audit401() {
    fetch('/api/auth/me', { credentials: 'same-origin' }).catch(() => {});
  }

  // ------------------------------------------------------------------ dashboard
  async function render() {
    fill(view, skeletons(3));
    let stats;
    try { stats = await api('/admin/stats'); }
    catch (err) {
      if (err.status === 403) return forbidden({});
      return fill(view, h('div', { class: 'card err' }, err.message));
    }

    const markup = h('input', { type: 'number', step: '0.01', min: '0', value: stats.settings.markup });
    const rate = h('input', { type: 'number', step: '0.01', min: '0', value: stats.settings.kes_per_usd });
    const fee = h('input', { type: 'number', step: '1', min: '0', value: stats.settings.fee_kes });
    const note = h('div', { class: 'hint' });
    const save = h('button', { class: 'btn block' }, 'Save settings');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await api('/admin/settings', {
          method: 'POST',
          body: { markup: Number(markup.value), kes_per_usd: Number(rate.value), fee_kes: Number(fee.value) },
        });
        note.textContent = 'Saved. New prices apply immediately.';
        toast('Settings saved');
        render();
      } catch (err) { note.textContent = err.message; save.disabled = false; }
    });

    // ---- PayHero callback URL (admin-only; the path segment is a derived secret)
    const callbackBox = h('div', null, skeletons(1));
    api('/admin/payhero')
      .then((p) => {
        const field = h('input', { type: 'text', readonly: true, value: p.callback_url });
        const copy = h('button', { class: 'btn ghost small' }, 'Copy');
        copy.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(p.callback_url); toast('Callback URL copied'); }
          catch { field.select(); toast('Press Ctrl/Cmd + C to copy'); }
        });
        fill(callbackBox,
          h('label', null, 'Callback URL'), field,
          h('div', { class: 'row', style: 'gap:8px;margin-top:8px' }, copy),
          h('p', { class: 'hint' },
            `PayHero enabled: ${p.enabled ? 'yes' : 'no'} · channel ${p.channel_id || '—'} · account ${p.account_id || '—'}. `,
            'The URL contains a secret path segment: treat it like a password and do not paste it in public.'));
      })
      .catch((err) => fill(callbackBox, h('p', { class: 'hint' }, err.message)));

    const provider = stats.provider_balance || {};
    const reviewBox = h('div', { class: 'card' }, h('h2', null, 'Needs review'), skeletons(2));
    const usersBox = h('div', { class: 'card' }, h('h2', null, 'Customers'), skeletons(2));
    const ticketsBox = h('div', { class: 'card' }, h('h2', null, 'Support tickets'), skeletons(2));
    const auditBox = h('div', { class: 'card' }, h('h2', null, 'Audit log'), skeletons(2));

    fill(view,
      h('div', { class: 'grid stats' },
        h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Revenue'), h('div', { class: 'v' }, kes(stats.revenue_cents))),
        h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Provider cost'), h('div', { class: 'v' }, kes(stats.provider_cost_cents))),
        h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Profit'), h('div', { class: 'v' }, kes(stats.profit_cents))),
        h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Provider balance'),
          h('div', { class: 'v' }, provider.error ? '—' : `$${Number(provider.balance_usd || 0).toFixed(2)}`))),
      h('div', { class: 'card' },
        h('h2', null, 'PayHero payment callback'),
        h('p', { class: 'hint' }, 'Paste this exact URL into PayHero if it ever asks where to send payment updates. Every STK push already carries it, so payments work without this.'),
        callbackBox),
      h('div', { class: 'card' },
        h('h2', null, 'Pricing'),
        h('label', null, 'Markup (0.30 = +30%)'), markup,
        h('label', null, 'KES per USD'), rate,
        h('label', null, 'Fixed fee per price (KES)'), fee,
        save, note,
        h('p', { class: 'hint' }, 'Customer price = provider rate × (1 + markup) × KES/USD + fee.')),
      h('div', { class: 'card' }, h('h2', null, 'Overview'),
        table([{ label: 'Metric' }, { label: 'Value', num: true }], [
          ['Customers', num(stats.users)],
          ['Customer balances', kes(stats.customer_balances_cents)],
          ['Orders', num(stats.orders)],
          ['Pending M-Pesa', num(stats.pending_topups)],
          ['Needs review', num(stats.needs_review)],
        ].map(([k, v]) => h('tr', null, h('td', null, k), h('td', { class: 'num' }, v))))),
      reviewBox, ticketsBox, usersBox, auditBox);

    // ---- orders awaiting a human decision
    try {
      const { orders } = await api('/admin/orders?status=needs_review');
      const act = (ev, id, kind) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        api(`/admin/orders/${id}/${kind}`, { method: 'POST' })
          .then(() => { toast(kind === 'retry' ? 'Retry sent' : 'Refunded'); render(); })
          .catch((err) => { toast(err.message, true); btn.disabled = false; });
      };
      fill(reviewBox,
        h('h2', null, 'Needs review'),
        h('p', { class: 'hint' }, 'Provider outcome unknown. Retry reuses the same idempotency key; only refund after checking the provider dashboard.'),
        table([{ label: 'Order' }, { label: 'Customer' }, { label: 'Price', num: true }, { label: 'Error' }, { label: '' }],
          orders.map((o) => h('tr', null,
            h('td', null, `#${o.id}`, h('div', { class: 'meta' }, o.service_name)),
            h('td', null, o.email),
            h('td', { class: 'num' }, kes(o.price_cents)),
            h('td', { class: 'meta' }, o.error || ''),
            h('td', null, h('div', { class: 'row' },
              h('button', { class: 'btn small', onclick: (ev) => act(ev, o.id, 'retry') }, 'Retry'),
              h('button', { class: 'btn danger small', onclick: (ev) => act(ev, o.id, 'refund') }, 'Refund'))))),
          'Nothing waiting for review.'));
    } catch (err) { fill(reviewBox, h('h2', null, 'Needs review'), h('div', { class: 'card err' }, err.message)); }

    // ---- support tickets
    try {
      const { tickets } = await api('/tickets?scope=all');
      fill(ticketsBox,
        h('h2', null, 'Support tickets'),
        table([{ label: 'Ticket' }, { label: 'Customer' }, { label: 'Status' }, { label: 'Updated' }, { label: '' }],
          tickets.map((t) => h('tr', null,
            h('td', null, `#${t.id}`, h('div', { class: 'meta' }, t.subject)),
            h('td', null, t.email || '—'),
            h('td', null, badge(t)),
            h('td', { class: 'meta' }, when(t.updated_at)),
            h('td', null, h('a', { class: 'btn ghost small', href: `/#/support/${t.id}` }, 'Open')))),
          'No tickets.'));
    } catch (err) { fill(ticketsBox, h('h2', null, 'Support tickets'), h('div', { class: 'card err' }, err.message)); }

    // ---- customers (read-only: admins can no longer move money)
    try {
      const { users } = await api('/admin/users');
      fill(usersBox,
        h('h2', null, 'Customers'),
        h('p', { class: 'hint' }, 'Balances are read-only here. Wallet credit is disabled for admins — top-ups only arrive through the payment provider.'),
        table([{ label: 'Email' }, { label: 'Balance', num: true }, { label: 'Joined' }],
          users.map((u) => h('tr', null,
            h('td', null, u.email, u.is_admin ? h('span', { class: 'badge' }, ' admin') : null),
            h('td', { class: 'num' }, kes(u.balance_cents)),
            h('td', { class: 'meta' }, when(u.created_at)))),
          'No customers yet.'));
    } catch (err) { fill(usersBox, h('h2', null, 'Customers'), h('div', { class: 'card err' }, err.message)); }

    // ---- audit trail
    try {
      const { entries } = await api('/admin/audit');
      fill(auditBox,
        h('h2', null, 'Audit log'),
        table([{ label: 'When' }, { label: 'Action' }, { label: 'Target' }, { label: 'Detail' }],
          entries.slice(0, 40).map((e) => h('tr', null,
            h('td', { class: 'meta' }, when(e.created_at)),
            h('td', null, e.action),
            h('td', { class: 'meta' }, e.target || '—'),
            h('td', { class: 'meta' }, e.detail || ''))),
          'No privileged actions recorded yet.'));
    } catch (err) { fill(auditBox, h('h2', null, 'Audit log'), h('div', { class: 'card err' }, err.message)); }
  }

  function badge(t) {
    if (t.status !== 'open') return h('span', { class: 'badge' }, 'closed');
    return t.last_reply_by === 'admin'
      ? h('span', { class: 'badge completed' }, 'answered')
      : h('span', { class: 'badge processing' }, 'open');
  }

  signOut.addEventListener('click', async () => {
    signOut.disabled = true;
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    location.replace('/');
  });

  boot();
})();
