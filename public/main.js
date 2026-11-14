/* smmpanel SPA (no build step).
   Layout cloned from the smm.africa panel: top bar with X / "Page | Brand" / kebab, a balance
   pill with a currency selector, an app-update banner, segmented tabs, transparent filter chips,
   order cards and a floating five-slot bottom bar (Home · Orders · New Order · Wallet · More).
   All dynamic text — including provider-supplied service names — goes in via textContent. */
(() => {
  'use strict';

  const state = {
    meta: null, user: null, orders: null, timer: null, route: '', build: null,
    currency: 'KES', updateDismissed: false, favorites: new Set(),
  };

  const view = document.getElementById('view');

  // Public page: readable without an account, and linked from every acceptance checkbox.
  function termsView() {
    stopTimer();
    fill(view,
      pageHead('Terms & Conditions', `Version ${(state.meta && state.meta.termsVersion) || '2026-11-07'} \u00b7 updated ${TERMS_UPDATED}`),
      h('div', { class: 'card' },
        TERMS.map((t) => h('div', { class: 'terms-block' }, h('h3', null, t.h), h('p', null, t.p))),
        h('p', { class: 'hint' }, 'By creating an account or ordering on smmpanel you accept these terms, including section 4: delivery depends on third-party vendors and delivered engagement can drop.')));

    if (state.user && !state.user.terms.accepted) {
      const accept = h('button', { class: 'btn block' }, 'I accept the Terms & Conditions');
      accept.addEventListener('click', async () => {
        accept.disabled = true;
        try {
          await acceptTerms();
        } catch (err) { toast(err.message, true); accept.disabled = false; }
      });
      view.append(h('div', { class: 'card' }, h('h2', null, 'One more step'),
        h('p', { class: 'muted' }, 'Accept the terms to keep ordering.'), accept));
    }
  }

  /** Record acceptance server-side, then let the customer carry on where they were. */
  async function acceptTerms() {
    const { user } = await api('/auth/accept-terms', { method: 'POST', body: { version: (state.meta && state.meta.termsVersion) || '' } });
    state.user = user;
    renderChrome();
    toast('Thanks - terms accepted.');
    const next = state.afterTerms || '#/';
    state.afterTerms = null;
    if (location.hash === next) route();
    else location.hash = next;
  }

  // ------------------------------------------------------------------ password reset
  // Two screens: ask for a link, then use it. The token comes back in the hash (#/reset?token=…)
  // so it never reaches a server log as part of a query string on the HTML request.
  function forgotView() {
    stopTimer();
    const email = h('input', { type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
    const note = h('div', { class: 'hint' });
    const btn = h('button', { class: 'btn block' }, 'Email me a reset link');

    const submit = async () => {
      note.textContent = '';
      btn.disabled = true;
      try {
        const res = await api('/auth/forgot', { method: 'POST', body: { email: email.value.trim() } });
        fill(note, res.message || 'If that email has an account, a reset link is on its way.');
        track('reset_requested');
      } catch (e) {
        note.textContent = e.message;
      } finally { btn.disabled = false; }
    };
    btn.addEventListener('click', submit);
    email.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    fill(view,
      pageHead('Reset your password', 'We email a link that works once and expires in 30 minutes.'),
      h('div', { class: 'card' },
        h('label', null, 'Email'), email, btn, note,
        h('p', { class: 'hint' }, 'Signed in with Google and never set a password? Use the Google button on the login screen instead.'),
        h('p', { class: 'hint' }, h('a', { href: '#/login' }, '← Back to log in'))));
  }

  function resetView(params = {}) {
    stopTimer();
    const token = String(params.token || '');
    const next = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'At least 8 characters' });
    const again = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Repeat the password' });
    const err = h('div', { class: 'errtext' });
    const btn = h('button', { class: 'btn block' }, 'Set new password');

    if (!token) {
      return fill(view, pageHead('New password'),
        errBox('That link is missing its token. Request a new reset email.'),
        h('a', { class: 'btn', href: '#/forgot' }, 'Request a new link'));
    }

    fill(view, pageHead('Choose a new password', 'This link works once.'),
      h('div', { class: 'card' },
        h('label', null, 'New password'), next,
        h('label', null, 'Repeat it'), again,
        err, btn,
        h('p', { class: 'hint' }, 'Setting a new password signs out every other device.')));

    // Say up front when the link is dead, instead of after the customer types a password.
    api(`/auth/reset/${encodeURIComponent(token)}`)
      .then((r) => {
        if (!r.valid) {
          err.textContent = 'That reset link has expired. Request a new one.';
          btn.disabled = true;
          view.append(h('a', { class: 'btn ghost', href: '#/forgot' }, 'Request a new link'));
        }
      })
      .catch(() => {});

    btn.addEventListener('click', async () => {
      err.textContent = '';
      if (next.value !== again.value) { err.textContent = 'The two passwords do not match.'; return; }
      btn.disabled = true;
      try {
        const { user, message } = await api('/auth/reset', { method: 'POST', body: { token, password: next.value } });
        state.user = user;
        toast(message || 'Password changed.');
        location.hash = '#/';
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
      }
    });
  }

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

  /** Inline SVG built from a constant string (never user input). */
  function svg(markup, size = 22, opts = {}) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('width', size);
    el.setAttribute('height', size);
    el.setAttribute('fill', opts.fill || 'none');
    el.setAttribute('stroke', opts.stroke || 'currentColor');
    el.setAttribute('stroke-width', opts.width || '1.9');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
    el.innerHTML = markup;
    return el;
  }

  const ICO = {
    home: '<path d="M3.4 10.4 12 3.4l8.6 7"/><path d="M5.6 9.6V20.4h12.8V9.6"/><path d="M9.9 20.4v-5.6h4.2v5.6"/>',
    orders: '<rect x="4.6" y="3.6" width="14.8" height="16.8" rx="2.6"/><path d="M8.6 9.2h6.8M8.6 12.8h6.8M8.6 16.4h4"/>',
    plus: '<path d="M12 5.4v13.2M5.4 12h13.2"/>',
    wallet: '<rect x="3.3" y="6.6" width="17.4" height="12.4" rx="3.4"/><path d="M3.3 10.6h17.4"/>',
    more: '<path d="M4 7.2h16M4 12h16M4 16.8h10"/>',
    filter: '<path d="M4 7h16M7 12h10M10 17h4"/>',
    search: '<circle cx="11" cy="11" r="6.4"/><path d="M15.8 15.8 20.5 20.5"/>',
    star: '<path d="m12 3.9 2.6 5.3 5.9.9-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 10.1l5.9-.9z"/>',
    chat: '<path d="M20.5 12c0 4-3.8 7.2-8.5 7.2-1 0-2-.15-2.9-.42L4.2 20.4l1.4-3.6A6.9 6.9 0 0 1 3.5 12c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 7.2z"/>',
    download: '<path d="M12 4.6v9.6M8.2 10.6 12 14.4l3.8-3.8M5.4 19h13.2"/>',
    whatsapp: '<path d="M20.2 11.7a8.2 8.2 0 0 1-12.2 7.2L3.8 20.2l1.4-4.1a8.2 8.2 0 1 1 15-4.4z"/><path d="M9.1 9.2c.2-.5.4-.5.7-.5h.5c.2 0 .4 0 .5.4l.7 1.6c0 .2 0 .3-.1.5l-.4.5c-.1.2-.2.3 0 .5.4.7 1.1 1.3 1.9 1.6.2.1.3.1.5-.1l.5-.6c.2-.2.3-.2.5-.1l1.5.7c.2.1.3.2.3.4 0 .5-.2 1.1-.6 1.4-.4.4-1 .5-1.6.4-1.6-.3-3.1-1.2-4.2-2.4-.9-1-1.5-2.2-1.6-3.3 0-.5.1-.9.4-1.1z" fill="currentColor" stroke="none"/>',
    key: '<circle cx="8.6" cy="12" r="4.4"/><path d="M12.4 9.2h7.2M17.2 9.2v3.4M20.4 12.6v2.6"/>',
    flame: '<path d="M12 3.2c3.4 4.1 5.7 6.2 5.7 9.5A5.7 5.7 0 0 1 12 18.4a5.7 5.7 0 0 1-5.7-5.7c0-3.3 2.3-5.4 5.7-9.5z"/><path d="M12 18.4a2.8 2.8 0 0 0 2.8-2.8c0-1.7-1.2-2.7-2.8-4.8-1.6 2.1-2.8 3.1-2.8 4.8a2.8 2.8 0 0 0 2.8 2.8z"/>',
  };

  const GOOGLE_G = `<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
  </svg>`;

  const TRANSLATE_ICO = '<path d="M3.5 6.4h8.4M7.7 4.6v1.8M9.9 6.4c0 3.6-2.6 6.6-6.1 7.6"/><path d="M5.2 9.4c1.2 2.2 3 3.7 5.2 4.5"/><path d="M12.4 20.2 16.6 10l4.2 10.2M14 16.6h5.2"/>';

  async function api(path, { method = 'GET', body } = {}, retried = false) {
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    if (method !== 'GET' && state.user && needsProof(path)) {
      // May take a few hundred milliseconds the first time; the screens warm it in the background.
      try { headers['x-pay-proof'] = await getPayProof(); } catch { /* the server will ask */ }
    }
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty / non-JSON */ }
    // 428 = the proof expired or was never solved. Solve a fresh one and retry exactly once.
    if (res.status === 428 && !retried && needsProof(path)) {
      resetPayProof();
      if (data && data.challenge) payProof.value = null;
      return api(path, { method, body }, true);
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ------------------------------------------------------------------ proof of browsing
  // The two endpoints that cost real money (an M-Pesa prompt, placing an order) ask for a puzzle
  // that this page solves in the background. It is bound to the signed-in account and to this
  // browser, so a request replayed from curl or from another machine is refused before any prompt
  // is built. Solved once, reused for ten minutes.
  const payProof = { value: null, expires: 0, solving: null };
  const zeroBits = (bytes) => {
    let bits = 0;
    for (const byte of bytes) {
      if (byte === 0) { bits += 8; continue; }
      bits += Math.clz32(byte) - 24;
      break;
    }
    return bits;
  };

  async function solvePayProof() {
    if (!(window.crypto && window.crypto.subtle)) {
      throw new Error('This browser cannot verify itself. Use a current browser over https.');
    }
    const { challenge, bits, expires_in } = await api('/challenge'); // never cached: it is per-session
    const enc = new TextEncoder();
    const target = `${challenge}:`;
    const giveUp = Date.now() + 20000; // never leave a customer staring at a spinner
    for (let nonce = 0; nonce < 5000000; nonce += 1) {
      if ((nonce & 1023) === 0 && Date.now() > giveUp) break;
      const digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', enc.encode(target + nonce)));
      if (zeroBits(digest) >= bits) {
        return { value: `${target}${nonce}`, expires: Date.now() + Math.max(60, (expires_in || 600) - 60) * 1000 };
      }
    }
    throw new Error('Could not verify this browser. Reload the page and try again.');
  }

  /** Resolve a usable proof, solving one if needed. Safe to call from anywhere. */
  function getPayProof() {
    if (payProof.value && Date.now() < payProof.expires) return Promise.resolve(payProof.value);
    if (!payProof.solving) {
      payProof.solving = solvePayProof()
        .then((p) => { payProof.value = p.value; payProof.expires = p.expires; return p.value; })
        .finally(() => { payProof.solving = null; });
    }
    return payProof.solving;
  }

  /** A proof is bound to the account, so signing in or out invalidates it. */
  function resetPayProof() { payProof.value = null; payProof.expires = 0; }

  /** True for the endpoints that must carry a proof. */
  const needsProof = (path) => path === '/wallet/topup' || path === '/orders';

  // ------------------------------------------------------------------ funnel counters
  // First-party only: one small POST per event, no cookies, no third-party script (the CSP would
  // block one anyway). Counts are aggregated per day server-side. Nothing here may ever break a
  // sale, so every failure is swallowed.
  const tracked = new Set();
  function track(name) {
    try {
      const key = `${name}|${new Date().toISOString().slice(0, 10)}`;
      if (tracked.has(key)) return; // at most once per event per tab per day
      tracked.add(key);
      fetch('/api/events', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }).catch(() => {});
    } catch { /* analytics is optional */ }
  }

  // ------------------------------------------------------------------ fast reads
  // Catalogue reads are the slow part of ordering, and they change slowly. Cache them in memory
  // (and across reloads in sessionStorage), collapse identical in-flight requests, and warm the
  // first screens while the browser is idle. Nothing user-specific or money-related is cached.
  const CACHE_TTL = 60 * 1000;
  const CACHE_MAX = 80;
  const readCache = new Map();   // path -> { at, data }
  const inflight = new Map();    // path -> Promise
  const svcById = new Map();     // service id -> row, so a card can open instantly
  const svcRefreshed = new Set(); // ids already re-checked against the server this session
  const svcAt = new Map();        // id -> when we last saw a fresh copy
  const SS = 'hila.readcache.v1';

  const cacheable = (path) => /^\/services(\?|$)/.test(path) || path === '/trending';

  /** Same query, same cache slot: drop empty values and sort the keys. */
  function normPath(path) {
    const i = path.indexOf('?');
    if (i < 0) return path;
    const params = new URLSearchParams(path.slice(i + 1));
    const entries = [...params.entries()].filter(([, v]) => v !== '' && v != null).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const qs = new URLSearchParams(entries).toString();
    return qs ? `${path.slice(0, i)}?${qs}` : path.slice(0, i);
  }

  function storeInSession() {
    try {
      const keep = {};
      for (const [k, v] of readCache) if (cacheable(k) && Date.now() - v.at < 5 * 60 * 1000) keep[k] = v;
      sessionStorage.setItem(SS, JSON.stringify(keep));
    } catch { /* quota or private mode - the memory cache still works */ }
  }

  function loadSessionCache() {
    try {
      const raw = sessionStorage.getItem(SS);
      if (!raw) return;
      for (const [k, v] of Object.entries(JSON.parse(raw))) {
        if (v && v.at && Date.now() - v.at < 5 * 60 * 1000) { readCache.set(k, v); rememberServices(v.data); }
      }
    } catch { /* ignore */ }
  }

  function rememberServices(data) {
    const at = Date.now();
    (data.services || []).forEach((s) => { svcById.set(Number(s.id), s); svcAt.set(Number(s.id), at); });
  }

  function cacheSet(path, data) {
    readCache.set(path, { at: Date.now(), data });
    if (readCache.size > CACHE_MAX) readCache.delete(readCache.keys().next().value);
    rememberServices(data);
    storeInSession();
  }

  /**
   * GET with a short cache. `refresh: true` ignores the cache but still updates it.
   * Concurrent callers for the same path share one request.
   */
  function apiGet(rawPath, { maxAge = CACHE_TTL, refresh = false } = {}) {
    const path = normPath(rawPath);
    if (!refresh) {
      const hit = readCache.get(path);
      if (hit && Date.now() - hit.at <= maxAge) {
        rememberServices(hit.data); // so a cached row can open its order form instantly
        return Promise.resolve(hit.data);
      }
      const pending = inflight.get(path);
      if (pending) return pending;
    }
    const p = api(path)
      .then((data) => { cacheSet(path, data); inflight.delete(path); return data; })
      .catch((err) => { inflight.delete(path); throw err; });
    inflight.set(path, p);
    return p;
  }

  const idle = (fn) => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 1200 }) : setTimeout(fn, 200));

  /** Warm the screens a customer is about to open. Cheap, silent, best-effort. */
  function prefetchCatalog() {
    idle(() => {
      apiGet('/services?page=1&per_page=20').catch(() => {});
      apiGet('/services?per_page=1').catch(() => {});       // platform tiles
      apiGet('/trending').catch(() => {});
    });
  }

  function prefetchService(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0 || svcById.has(n)) return;
    apiGet(`/services/${n}`, { maxAge: 5 * 60 * 1000 })
      .then((r) => { if (r && r.service) svcById.set(n, r.service); })
      .catch(() => {});
  }

  function toast(msg, isError) {
    const t = h('div', { class: `toast${isError ? ' error' : ''}` }, msg);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), isError ? 6500 : 3800);
  }

  /** KES amount from integer cents. */
  function kes(cents) {
    const n = Math.round(Number(cents) || 0);
    const abs = Math.abs(n);
    const whole = Math.floor(abs / 100);
    const rem = abs % 100;
    return `${n < 0 ? '-' : ''}KSh ${whole.toLocaleString('en-KE')}${rem ? `.${String(rem).padStart(2, '0')}` : ''}`;
  }

  /** Amount in the display currency the user picked in the header pill. */
  function amt(cents) {
    if (state.currency === 'USD') {
      const rate = (state.meta && state.meta.kesPerUsd) || 129;
      return `$${((Math.round(Number(cents) || 0) / 100) / rate).toFixed(2)}`;
    }
    return kes(cents);
  }

  const per1000 = (c) => `${amt(c)} / 1000`;
  const fmtDate = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const relDate = (iso) => {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return days < 30 ? `${days}d ago` : fmtDate(iso);
  };
  const num = (n) => (n == null ? '-' : Number(n).toLocaleString());
  const badge = (s) => h('span', { class: `badge ${s}` }, String(s).replace(/_/g, ' '));

  const safeLink = (url, max = 42) =>
    /^https?:\/\//i.test(url)
      ? h('a', { class: 'order-link', href: url, target: '_blank', rel: 'noopener noreferrer nofollow' }, url.length > max ? `${url.slice(0, max)}…` : url)
      : h('span', { class: 'order-link' }, url);

  const stopTimer = () => { if (state.timer) clearInterval(state.timer); state.timer = null; };
  const stale = () => state.route !== currentRoute().name.split('/')[0];
  // ------------------------------------------------------------------ terms & conditions
  // Same text feeds the public page (#/terms), the sign-up checkbox and the acceptance gate,
  // so there is exactly one wording to keep the server-side version in step with.
  const TERMS_UPDATED = '7 November 2026';
  const TERMS = [
    {
      h: '1. Who we are and what this is',
      p: 'smmpanel is a reseller of social-media marketing services: followers, likes, views, comments, subscribers and similar engagement. We do not run the accounts or platforms you order for, and we are not affiliated with, endorsed by or sponsored by Instagram, TikTok, YouTube, X, Facebook, Telegram, Spotify or any other platform named on the site.',
    },
    {
      h: '2. Your account',
      p: 'You need an account to order. Keep your password to yourself: anything ordered from your account is treated as ordered by you. One account per person or business. We may suspend an account that is used to defraud us, to abuse a provider, or to break these terms, and any remaining balance stays on the account pending review.',
    },
    {
      h: '3. Prices, fees and payment',
      p: 'All prices are in Kenyan Shillings (KES) and are shown before you confirm an order. Each order carries a fixed service fee, shown in the order summary. Prices are per 1,000 units unless the service says otherwise. Top-ups are collected by M-Pesa through our payment provider; your balance is credited only after M-Pesa confirms the payment, and a delayed confirmation can take a few minutes. Balances are for buying services, are not transferable between accounts, and cannot be cashed out.',
    },
    {
      h: '4. Delivery times are estimates, and services can drop',
      p: 'Delivery is carried out by third-party suppliers ("vendors"), not by us. Start times and speeds shown on a service are their estimates, not commitments, and delays happen. Engagement delivered by a vendor can also fall away after it is delivered: followers, likes, views and comments may drop days or weeks later, and how much drops, and whether it comes back, depends entirely on the vendor and on the platform\u2019s own moderation. We cannot guarantee that any specific number is retained, and we cannot promise a service will stay available or at the same price, because our vendors change their offers without notice. Where a service lists "Refill", the vendor will top the order back up within the stated refill window; where it does not, a drop after delivery is not covered.',
    },
    {
      h: '5. Refunds',
      p: 'If an order is not delivered at all, or is delivered only in part, tell us within 7 days through Support and we refund the missing part to your smmpanel balance. Once a service has been delivered in full it is finished, and a later drop is not a refund event unless the service offers a refill. We do not refund to M-Pesa; refunds are credited to your balance. Do not open a chargeback with your bank or M-Pesa instead of contacting us \u2014 we will suspend the account while it is disputed.',
    },
    {
      h: '6. What you may not order',
      p: 'Do not use the panel for anything illegal or deceptive: no content that infringes copyright, no harassment, no orders for accounts you do not own or manage, no fake engagement intended to mislead advertisers or voters, and no reselling of our services through another panel without our written permission. Orders that break this can be cancelled without refund, and the account can be closed.',
    },
    {
      h: '7. Availability and changes',
      p: 'The panel is provided as-is. We may add, change, pause or withdraw any service at any time, including when a vendor withdraws it, and we may change these terms. If we change them, the new version is dated and published at #/terms, and you will be asked to accept it the next time you sign in before you can order again.',
    },
    {
      h: '8. Liability',
      p: 'To the extent the law allows, our total liability for any order is limited to what you paid for that order. We are not liable for a platform removing content, restricting an account, or changing its rules or algorithms, and we are not liable for indirect losses such as lost sales or lost reach.',
    },
    {
      h: '9. Your data',
      p: 'We store your email address, your password (hashed, never in plain text), your orders, ticket messages and payment references from M-Pesa. We do not receive or store your M-Pesa PIN. The links you submit with an order are sent to the vendor that fulfils it, because that is the only way to deliver the order.',
    },
    {
      h: '10. Contact',
      p: 'Questions about these terms, an order or a refund go through Support in the app, or the WhatsApp line on the Help page. That is also the fastest route to a human.',
    },
  ];

  const requireLogin = () => { if (state.user) return true; location.hash = '#/login'; return false; };

  const GROUPS = {
    active: ['pending', 'queued', 'processing', 'submitting'],
    done: ['completed', 'partial'],
    attention: ['failed', 'canceled', 'refunded', 'needs_review'],
  };
  const groupOf = (s) => (GROUPS.active.includes(s) ? 'active' : GROUPS.done.includes(s) ? 'done' : 'attention');

  const PAGE_TITLES = {
    '': 'Dashboard', orders: 'Orders', order: 'New order', services: 'Services',
    login: 'Log in', register: 'Create account', wallet: 'Wallet', mass: 'Mass order',
    drip: 'Drip campaigns', support: 'Support', ticket: 'Ticket', trending: 'Trending', password: 'Password', help: 'Help',
    privacy: 'Privacy', forgot: 'Reset password', reset: 'New password',
  };

  const pageHead = (title, sub, action) => h('div', { class: 'page-head' },
    h('div', null, h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null), action || null);
  const errBox = (msg) => h('div', { class: 'card err' }, msg);
  const skeletons = (rows = 3) => h('div', null, Array.from({ length: rows }, (_, i) =>
    h('div', { class: i ? 'sk w70' : 'sk w55' })));
  const emptyState = (emoji, title, sub, action) =>
    h('div', { class: 'card empty' }, h('div', { class: 'big' }, emoji), h('h2', null, title),
      h('p', { class: 'muted' }, sub), action || null);

  // ------------------------------------------------------------------ chrome
  const menuEl = () => document.getElementById('nav');
  const closeMenu = () => { menuEl().hidden = true; document.getElementById('menuBtn').setAttribute('aria-expanded', 'false'); };
  const toggleMenu = () => {
    const m = menuEl();
    m.hidden = !m.hidden;
    document.getElementById('menuBtn').setAttribute('aria-expanded', String(!m.hidden));
  };

  let popoverEl = null;
  function closePopover() {
    if (popoverEl) { popoverEl.remove(); popoverEl = null; }
  }

  function openCurrencyMenu() {
    if (popoverEl) return closePopover();
    const opt = (code, label) => h('button', {
      class: state.currency === code ? 'on' : '',
      onclick: () => { state.currency = code; closePopover(); renderChrome(); route(); },
    }, h('span', null, `${code} — ${label}`), state.currency === code ? '✓' : '');
    popoverEl = h('div', { class: 'popover' },
      h('div', { class: 'pop-label' }, 'Display currency'),
      opt('KES', 'Kenyan Shilling'),
      opt('USD', `US Dollar (≈${(state.meta && state.meta.kesPerUsd) || 129}/USD)`),
      h('div', { class: 'sep' }),
      h('div', { class: 'pop-label' }, 'Language'),
      h('button', { onclick: () => { closePopover(); toast('English (Kenya) is the only language for now.'); } },
        h('span', null, 'English (KE)'), '✓'));
    document.querySelector('.app').append(popoverEl);
  }

  function renderChrome() {
    const route = currentRoute().name;
    const site = state.meta ? state.meta.siteName : 'smmpanel';
    const baseRoute = route.split('/')[0];
    document.title = `${PAGE_TITLES[baseRoute] || 'Dashboard'} | ${site}`;
    document.getElementById('appTitle').textContent = `${PAGE_TITLES[baseRoute] || 'Dashboard'} | ${site}`;
    // The domain is a placeholder until a real one is bought; the promise is not.
    document.getElementById('appSub').textContent = state.user
      ? `Pay with M-Pesa · Instant delivery`
      : 'Pay with M-Pesa · Prices in KSh';

    // balance strip: brand · [amount + KES v] · translate
    const amount = state.user ? (state.user.balance_cents / 100).toFixed(2) : '0.00';
    const chev = svg('<path d="M6 9l6 6 6-6"/>', 14, { width: '2.4' });
    fill(document.getElementById('balances'),
      h('span', { class: 'bal-brand' }, site),
      h('button', {
        class: 'bal-pill', 'aria-label': 'Wallet balance and currency',
        onclick: (ev) => { ev.stopPropagation(); openCurrencyMenu(); },
      },
        h('span', { class: 'bal-amount' }, amount),
        state.user
          ? h('span', {
              class: 'bal-add', role: 'button', title: 'Add funds',
              onclick: (ev) => { ev.stopPropagation(); closePopover(); location.hash = '#/wallet'; },
            }, '+')
          : h('span', { class: 'bal-add' }, '+'),
        h('span', { class: 'bal-div' }),
        h('span', { class: 'bal-cur' }, state.currency, chev.cloneNode(true))),
      h('button', { class: 'lang-btn', 'aria-label': 'Language and currency', onclick: (ev) => { ev.stopPropagation(); openCurrencyMenu(); } },
        svg(TRANSLATE_ICO, 21),
        chev.cloneNode(true)));

    // segmented tabs
    const tabs = document.getElementById('tabs');
    const showTabs = ['', 'orders', 'drip', 'mass'].includes(baseRoute);
    tabs.hidden = !showTabs;
    if (!showTabs) fill(tabs);
    if (showTabs) {
      const tab = (hash, label, active) => h('a', { href: hash, class: active ? 'active' : '' }, label);
      fill(tabs,
        tab('#/orders', 'Orders', route === 'orders' || route === ''),
        tab('#/drip', 'Drip campaigns', route === 'drip'),
        tab('#/mass', 'Mass order', route === 'mass'));
    }

    // overflow menu
    const links = [['', 'Dashboard'], ['order', 'New order'], ['trending', 'Trending'], ['services', 'Pricing'], ['mass', 'Mass order']];
    if (state.user) links.push(['orders', 'Orders'], ['wallet', 'Wallet'], ['support', 'Support'], ['help', 'Help / FAQ'], ['password', 'Password']);
    else links.push(['help', 'Help / FAQ']);
    links.push(['terms', 'Terms & Conditions'], ['privacy', 'Privacy']);
    const kids = links.map(([r, label]) => h('a', { href: `#/${r}`, class: route === r ? 'active' : '' }, label));
    // The support line sits in the menu itself, not buried behind a ticket form.
    kids.push(h('a', {
      href: whatsappHref(), class: 'wa-link', target: '_blank', rel: 'noopener noreferrer',
      onclick: closeMenu,
    }, svg(ICO.whatsapp, 18), `WhatsApp ${support().phone}`));
    kids.push(state.user
      ? h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); closeMenu(); logout(); } }, 'Log out')
      : h('a', { href: '#/login', onclick: closeMenu }, 'Log in'));
    // Maker's mark at the foot of the menu: who built and maintains this panel.
    kids.push(h('div', { class: 'menu-sig' },
      h('span', null, 'Developed by '),
      h('strong', null, 'HilaTech')));
    fill(menuEl(), ...kids);

    // floating bottom bar
    const pending = state.orders ? state.orders.filter((o) => groupOf(o.status) === 'active').length : 0;
    const item = (hash, label, ico, active, opts = {}) => h('a', {
      href: hash, class: `${active ? 'active' : ''}${opts.fab ? ' fab-item' : ''}`,
    },
      opts.fab
        ? h('span', { class: 'fab' }, svg(ico, 22, { width: '2.3' }))
        : h('span', { class: 'ico-wrap' }, svg(ico, 22)),
      h('span', null, label));

    const moreBtn = h('a', {
      href: '#',
      class: ['services', 'support', 'trending', 'mass', 'drip'].includes(baseRoute) ? 'active' : '',
    },
      h('span', { class: 'ico-wrap' }, svg(ICO.more, 22)),
      h('span', null, 'More'),
      pending ? h('span', { class: 'nav-badge' }, pending > 9 ? '9+' : String(pending)) : null);
    // stopPropagation matters: the document-level "click outside" handler would otherwise
    // close the sheet in the same tick, which made the More button look dead.
    moreBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closePopover();
      toggleMenu();
    });

    fill(document.getElementById('tabbar'),
      item('#/', 'Home', ICO.home, route === '' || route === 'order'),
      item('#/orders', 'Orders', ICO.orders, ['orders', 'drip', 'mass'].includes(route)),
      item('#/order', 'New Order', ICO.plus, false, { fab: true }),
      item('#/wallet', 'Wallet', ICO.wallet, route === 'wallet'),
      moreBtn);
  }

  function showUpdateBanner() {
    const el = document.getElementById('updateBanner');
    if (!state.updateDismissed) el.hidden = false;
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    resetPayProof(); // the puzzle is bound to the account that just left
    state.user = null;
    state.orders = null;
    location.hash = '#/';
    renderChrome();
    route();
  }

  async function loadFavorites() {
    if (!state.user) { state.favorites = new Set(); return; }
    try {
      const { favorites } = await api('/favorites');
      state.favorites = new Set(favorites.map(Number));
    } catch { /* offline */ }
  }

  // ------------------------------------------------------------------ support contact
  // One place for "text me on WhatsApp": the number comes from /api/meta (SUPPORT_WHATSAPP),
  // so it can change server-side without touching this file.
  const support = () => (state.meta && state.meta.support) || { phone: '0184355332', whatsapp: '254184355332' };

  function whatsappHref(text) {
    const s = support();
    const body = text || 'Hi, I need help with my smmpanel account.';
    return `https://wa.me/${s.whatsapp}?text=${encodeURIComponent(body)}`;
  }

  function whatsappCard(opts = {}) {
    const s = support();
    return h('div', { class: 'card wa-card' },
      h('div', { class: 'row', style: 'gap:12px;align-items:center' },
        h('span', { class: 'wa-ico' }, svg(ICO.whatsapp, 24)),
        h('div', { style: 'min-width:0' },
          h('div', { style: 'font-weight:700' }, opts.title || 'Chat with us on WhatsApp'),
          h('div', { class: 'muted', style: 'font-size:.86rem' }, opts.subtitle || `Fastest way to reach a human — ${s.phone}`))),
      h('div', { class: 'row', style: 'gap:8px;margin-top:12px' },
        h('a', { class: 'btn wa-btn', href: whatsappHref(opts.text), target: '_blank', rel: 'noopener noreferrer' }, svg(ICO.whatsapp, 18), 'Text ' + s.phone),
        s.phone ? h('a', { class: 'btn ghost', href: `tel:${s.phone}` }, 'Call') : null));
  }

  const setBalance = (cents) => {
    if (state.user) state.user.balance_cents = cents;
    renderChrome();
  };

  // ------------------------------------------------------------------ link finder
  // "Paste your link and we tell you the cheapest service that works." The inference and the
  // ranking both happen server-side (POST /api/recommend) so nothing here can be talked into
  // showing a provider rate: the endpoint only ever returns customer-facing KES.
  function linkFinder() {
    const input = h('input', {
      type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'https://instagram.com/yourprofile',
      'aria-label': 'Your link',
    });
    const btn = h('button', { class: 'btn' }, 'Find cheapest');
    const out = h('div', { class: 'finder-out' });
    const goalRow = h('div', { class: 'finder-goals' });
    let seq = 0;
    let timer = null;
    let goal = ''; // '' = let the server infer it from the link
    let sort = 'value'; // 'value' = score (price + guarantees), 'price' = cheapest first

    const chip = (label, tone) => h('span', { class: `chip ${tone || ''}` }, label);

    const priceLabel = (r) => (r.flat ? `${amt(r.per1000_cents)} / package` : `${amt(r.per1000_cents)} / 1000`);

    // Goal switcher: "auto" lets the URL decide, the rest are explicit.
    function renderGoals(data) {
      const goals = [{ key: '', label: 'Auto' }].concat(data.goals || []);
      fill(goalRow,
        goals.map((g) => h('button', {
          class: `chip-btn${goal === g.key ? ' active' : ''}${data.goal === g.key && g.key ? ' inferred' : ''}`,
          type: 'button',
          onclick: () => { goal = g.key; run(); },
        }, g.label)),
        h('span', { class: 'finder-sep' }),
        h('button', {
          class: `chip-btn${sort === 'value' ? ' active' : ''}`, type: 'button',
          onclick: () => { sort = 'value'; run(); },
        }, 'Best value'),
        h('button', {
          class: `chip-btn${sort === 'price' ? ' active' : ''}`, type: 'button',
          onclick: () => { sort = 'price'; run(); },
        }, 'Cheapest first'));
      goalRow.hidden = false;
    }

    function renderResult(data) {
      if (data.sort) sort = data.sort;
      renderGoals(data);
      const kids = [];
      if (data.platform) {
        kids.push(h('div', { class: 'finder-platform' },
          h('span', { class: 'plat-ico' }, abbr(data.platform.name)),
          h('div', { style: 'min-width:0' },
            h('div', { style: 'font-weight:700' }, data.platform.name),
            h('div', { class: 'muted', style: 'font-size:.8rem' },
              data.host ? `${data.host} · ${num(data.platform.count)} services` : `${num(data.platform.count)} services`))));
      }
      kids.push(h('p', { class: 'finder-note' }, data.note));

      if (data.services.length) {
        kids.push(h('div', { class: 'finder-list' }, data.services.map((r, i) => h('div', { class: `finder-row${i === 0 ? ' best' : ''}` },
          h('div', { class: 'finder-rank' }, i === 0 ? 'BEST' : String(i + 1)),
          h('div', { style: 'min-width:0;flex:1' },
            h('div', { class: 'finder-name' }, r.name),
            h('div', { class: 'finder-tags' },
              (r.reasons || []).map((x) => chip(x)),
              r.min ? chip(`min ${num(r.min)}`, 'dim') : null,
              r.max ? chip(`max ${num(r.max)}`, 'dim') : null)),
          h('div', { class: 'finder-side' },
            h('span', { class: 'price' }, priceLabel(r)),
            h('a', {
              class: 'btn small',
              href: `#/order?service=${r.id}&platform=${encodeURIComponent((data.platform && data.platform.key) || '')}`,
            }, 'Order'))))));
        kids.push(h('a', {
          class: 'btn ghost small', style: 'margin-top:10px',
          href: `#/order?platform=${encodeURIComponent(data.platform.key)}&sort=cheap`,
        }, `All cheap ${data.platform.name} services →`));
      } else if (data.alternatives.length) {
        // Could not tell the platform: let them pick instead of guessing wrong.
        kids.push(h('div', { class: 'finder-alts' }, data.alternatives.map((p) => h('a', {
          class: 'btn ghost small', href: `#/order?platform=${encodeURIComponent(p.key)}&sort=cheap`,
        }, p.name))));
      }
      fill(out, ...kids);
      out.hidden = false;
    }

    async function run() {
      const link = input.value.trim();
      if (!link) { input.focus(); return; }
      const mine = ++seq;
      out.hidden = false;
      fill(out, h('div', { class: 'finder-note' }, 'Checking the catalogue…'));
      btn.disabled = true;
      try {
        const data = await api('/recommend', { method: 'POST', body: { link, goal, sort } });
        if (mine !== seq) return;
        renderResult(data);
        // The result is about one platform; keep the catalogue warm for the natural next tap.
        if (data.platform) apiGet(`/services?platform=${data.platform.key}&sort=cheap&page=1&per_page=20`).catch(() => {});
      } catch (e) {
        if (mine !== seq) return;
        fill(out, errBox(e.message));
      } finally {
        if (mine === seq) btn.disabled = false;
      }
    }

    btn.addEventListener('click', run);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); run(); } });
    // Typing a link and waiting is the same intent as pasting one: answer without a second tap.
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const v = input.value.trim();
      if (v.length < 6 || !/[.\/]/.test(v)) return;
      timer = setTimeout(() => { if (document.body.contains(input)) run(); }, 700);
    });

    return h('div', { class: 'card finder' },
      h('div', { class: 'finder-head' },
        h('h2', null, 'Paste a link — get the cheapest service'),
        h('p', { class: 'muted', style: 'margin:2px 0 0;font-size:.85rem' },
          'We read the platform from your link, then rank its services by price, refill cover and start speed.')),
      h('div', { class: 'finder-bar' }, input, btn),
      goalRow,
      out);
  }

  // ------------------------------------------------------------------ dashboard
  async function dashboardView() {
    stopTimer();
    // Logged out: this is the storefront, not an empty dashboard. A visitor used to see a KSh 0
    // wallet, "Signed out" and "No orders yet", which reads like a broken account rather than a
    // shop they can buy from.
    if (!state.user) return landingView();

    const name = String(state.user.email).split('@')[0];
    const balanceSlot = h('div', null, h('div', { class: 'sk w55', style: 'height:30px' }));
    const pill = h('span', { class: 'refresh-pill' }, 'Refreshing…');
    const recentBox = h('div', null, skeletons());

    fill(view,
      h('h1', null, 'Dashboard'),
      h('p', { class: 'sub' }, `Welcome back, ${name}. Here's your panel overview.`),
      h('div', { class: 'row', style: 'gap:10px;margin-bottom:16px' },
        h('a', { class: 'btn', href: '#/order' }, 'New order'),
        h('a', { class: 'btn ghost', href: '#/trending' }, 'What\'s trending')),
      linkFinder(),

      h('div', { class: 'row', style: 'justify-content:flex-end;margin-bottom:16px' }, pill),

      h('div', { class: 'card' },
        h('h2', null, 'Wallet balance'),
        balanceSlot,
        h('p', { class: 'muted', style: 'margin:10px 0 12px' }, 'Available to spend on orders.'),
        h('a', { class: 'btn ghost small', href: '#/wallet' }, 'Add funds →')),

      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'Orders'), h('a', { class: 'btn ghost small', href: '#/orders' }, 'View all')),
        recentBox));

    try {
      const [{ user }, { orders }] = await Promise.all([api('/auth/me'), api('/orders')]);
      if (stale()) return;
      state.user = user;
      state.orders = orders;
      fill(balanceSlot, h('div', { style: 'font-size:1.35rem;font-weight:800;letter-spacing:-.01em' }, amt(user.balance_cents)));
      pill.textContent = 'Live';
      pill.className = 'refresh-pill ok';
      renderChrome();
      fill(recentBox, orders.length
        ? orders.slice(0, 3).map((o) => orderCard(o))
        : h('p', { class: 'muted' }, 'No orders yet.'));
    } catch (e) {
      fill(recentBox, errBox(e.message));
      pill.textContent = 'Offline';
      pill.className = 'refresh-pill err';
    }
  }

  // ------------------------------------------------------------------ storefront
  /** Public home page: what this is, a live price example, and how to pay. */
  async function landingView() {
    stopTimer();
    const prices = h('div', { class: 'card' }, h('h2', null, 'Real prices, straight from the catalogue'), skeletons(3));

    fill(view,
      h('h1', null, 'Followers, likes and views. Pay with M-Pesa.'),
      h('p', { class: 'sub' }, 'Engagement for Instagram, TikTok, YouTube and more. Prices in KSh, no card, delivery usually starts within minutes.'),
      h('div', { class: 'row', style: 'gap:10px;margin-bottom:16px' },
        h('a', { class: 'btn', href: '#/register' }, 'Create an account'),
        h('a', { class: 'btn ghost', href: '#/order?platform=all&sort=cheap' }, 'Browse prices')),
      linkFinder(),
      prices,
      h('div', { class: 'card' },
        h('h2', null, 'How it works'),
        h('ol', { class: 'trust' },
          h('li', null, 'Create an account with an email - no password sharing, ever.'),
          h('li', null, 'Add funds with M-Pesa: an STK prompt arrives on your phone, and the wallet is credited once Safaricom confirms.'),
          h('li', null, 'Paste a public link, choose the quantity, and the order starts.')),
        h('p', { class: 'hint' }, 'Delivery depends on third-party vendors and delivered engagement can drop — that is in the terms, in plain words.')),
      h('div', { class: 'card' },
        h('h2', null, 'Why people here use it'),
        h('ul', { class: 'trust' },
          h('li', null, 'M-Pesa only — no card details to hand over.'),
          h('li', null, 'Prices include the service fee; the total you see is the total you pay.'),
          h('li', null, 'No password is ever needed: orders take a public link or username.'),
          h('li', null, 'Free refill where the provider offers it, and undelivered amounts go back to your wallet.'),
          h('li', null, 'A real person on WhatsApp when an order misbehaves.'))),
      h('p', { class: 'hint' }, 'Already registered? ', h('a', { href: '#/login' }, 'Log in'), ' · ',
        h('a', { href: '#/terms' }, 'Terms'), ' · ', h('a', { href: '#/privacy' }, 'Privacy'), ' · ',
        h('a', { href: '#/help' }, 'Help')));

    track('home_view');
    try {
      const data = await loadServices({ sort: 'cheap', per_page: 5, page: 1 });
      if (stale()) return;
      fill(prices,
        h('h2', null, 'Real prices from the catalogue'),
        h('div', null, data.services.map((s) => h('div', { class: 'svc' },
          h('div', { style: 'min-width:0' },
            h('div', { class: 'name' }, s.name),
            h('div', { class: 'meta' }, s.category)),
          h('div', { class: 'svc-side' },
            h('span', { class: 'price' }, s.flat ? amt(s.rate_cents) : per1000(s.rate_cents)),
            h('a', { class: 'btn small', href: `#/order?service=${s.id}` }, 'Order'))))),
        h('p', { class: 'hint' }, 'Cheapest services in the whole catalogue. Every price already includes the service fee.'));
    } catch (e) {
      fill(prices, h('h2', null, 'Prices'),
        h('p', { class: 'muted' }, 'Live prices are slow to load right now. '),
        h('a', { class: 'btn ghost small', href: '#/order?platform=all&sort=cheap' }, 'Open the catalogue'));
    }
  }

  // ------------------------------------------------------------------ privacy
  // Written for a customer, not a lawyer: what is stored, why, and what is never done.
  const PRIVACY = [
    ['What we store', 'Your email address, a bcrypt hash of your password (never the password itself), your wallet balance and transaction history, the orders you place, and any support messages you send. If you sign in with Google we store the Google account id and nothing else from Google.'],
    ['Why we store it', 'To sign you in, to keep a correct balance, to send your orders to the delivery provider, and to answer you when something goes wrong. Nothing else.'],
    ['Who else sees it', 'Payments are processed by PayHero and Safaricom (M-Pesa), and orders are passed to the delivery provider, which receives the public link you submitted and the quantity. Support runs over WhatsApp, and email is sent through Resend. They see what is needed to do that job, and nothing more.'],
    ['What is never done here', 'No advertising networks, no third-party analytics script, no selling or renting of customer data, and no reading of your social accounts. Orders only ever need a public link or username, so we never ask for a password.'],
    ['Cookies', 'One cookie, and it is the session cookie that keeps you signed in. It is HttpOnly, SameSite=Strict and Secure in production. There is no tracking cookie and no consent banner because there is nothing to consent to.'],
    ['Counting visits', 'The panel counts a small number of things internally (home page viewed, order placed, top-up started) in aggregate per day. These are counts, not profiles: they carry no identifier, no IP address and no cookie.'],
    ['Children', 'You must be 18 or older to hold an account.'],
    ['Keeping and deleting', 'Transaction and order records are kept while the account exists because they are the money trail. Ask for your account to be deleted and it is removed along with its personal data; records we are required to keep for accounting are retained without the account.'],
    ['Questions', 'Open a support ticket in the panel or use the WhatsApp line. Deletion and data questions are handled by the account owner.'],
  ];

  function privacyView() {
    stopTimer();
    fill(view,
      pageHead('Privacy', 'What is stored, who sees it, and what is never done.'),
      h('div', { class: 'card' },
        PRIVACY.map(([h2, text]) => h('div', { class: 'terms-block' }, h('h3', null, h2), h('p', null, text))),
        h('p', { class: 'hint' }, 'This page describes current practice. The Terms & Conditions are the binding agreement.')),
      h('p', { class: 'hint' }, h('a', { href: '#/terms' }, 'Terms & Conditions'), ' · ',
        h('a', { href: '#/privacy' }, 'Privacy'), ' · ', h('a', { href: '#/help' }, 'Help')));
  }

  // ------------------------------------------------------------------ catalog
  const loadServices = (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiGet(`/services${qs ? `?${qs}` : ''}`);
  };

  const serviceRow = (s) => h('div', { class: 'svc' },
    h('div', { style: 'min-width:0' },
      h('div', { class: 'name' }, s.name),
      h('div', { class: 'meta' }, `${s.category} · ${s.flat ? 'per order' : `min ${num(s.min)} – max ${num(s.max)}`}${s.refill ? ' · refill' : ''}`)),
    h('div', { class: 'svc-side' },
      h('span', { class: 'price' }, s.flat ? amt(s.rate_cents) : per1000(s.rate_cents)),
      h('a', { class: 'btn small', href: `#/order?service=${s.id}` }, 'Order')));

  async function servicesView(params = {}) {
    stopTimer();
    const page = Number(params.page) || 1;
    const q = params.q || '';
    const category = params.category || '';
    fill(view, pageHead('Services', 'Every price is in your display currency and includes the service fee.'), h('div', { class: 'card' }, skeletons(4)));

    let data;
    try { data = await loadServices({ page, per_page: 20, q, category }); }
    catch (e) { return fill(view, pageHead('Services'), errBox(e.message)); }
    if (stale()) return;

    const search = h('input', { type: 'search', placeholder: 'Search services…', value: q, autocomplete: 'off' });
    const catSel = h('select', null,
      h('option', { value: '' }, 'All categories'),
      data.categories.map((c) => h('option', { value: c, selected: c === category }, c)));
    const go = () => (location.hash = `#/services?${new URLSearchParams({ q: search.value.trim(), category: catSel.value, page: 1 })}`);
    search.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    catSel.addEventListener('change', go);

    fill(view,
      pageHead('Services', 'Every price is in your display currency and includes the service fee.'),
      h('div', { class: 'searchrow' }, search, h('button', { class: 'sq', 'aria-label': 'Search', onclick: go }, svg(ICO.filter, 20))),
      h('label', null, 'Category'), catSel,
      h('div', { class: 'card' },
        data.services.length ? data.services.map(serviceRow) : h('p', { class: 'muted' }, 'No services match your search.'),
        h('div', { class: 'pagination' },
          h('button', { class: 'btn ghost small', disabled: data.pagination.page <= 1, onclick: () => (location.hash = `#/services?${new URLSearchParams({ q, category, page: page - 1 })}`) }, 'Previous'),
          h('span', { class: 'muted' }, `Page ${data.pagination.page} / ${data.pagination.pages} · ${num(data.pagination.total)}`),
          h('button', { class: 'btn ghost small', disabled: data.pagination.page >= data.pagination.pages, onclick: () => (location.hash = `#/services?${new URLSearchParams({ q, category, page: page + 1 })}`) }, 'Next'))));
  }

  const orderView = (params) => (params.service ? orderFormView(params)
    : (params.platform || params.favorites) ? orderBrowseView(params) : orderPlatformView());

  // ------------------------------------------------------------------ new order
  // Three steps, matching the smm.africa flow: pick a platform -> pick a category
  // (with a "cheapest" sort) -> fill in the order form.
  const SORTS = [
    ['cheap', 'Cheapest first'],
    ['expensive', 'Most expensive'],
    ['name', 'Name A–Z'],
    ['default', 'Provider order'],
  ];
  const sortWord = (s) => ({ cheap: 'cheapest first', expensive: 'most expensive first', name: 'name A–Z' }[s] || 'provider order');

  const abbr = (name) => {
    const w = String(name).replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    if (!w.length) return '•';
    return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[1][0]).toUpperCase();
  };

  const starBtn = (s) => h('button', {
    class: `star${state.favorites.has(s.id) ? ' on' : ''}`,
    'aria-label': state.favorites.has(s.id) ? 'Remove from starred' : 'Star this service',
    title: 'Star this service',
    onclick: async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const el = ev.currentTarget; // currentTarget is null once the handler awaits
      try {
        const r = await api('/favorites', { method: 'POST', body: { service_id: s.id } });
        if (r.favorite) state.favorites.add(s.id); else state.favorites.delete(s.id);
        el.classList.toggle('on', r.favorite);
        el.setAttribute('aria-label', r.favorite ? 'Remove from starred' : 'Star this service');
      } catch (e) { toast(e.message, true); }
    },
  }, svg(ICO.star, 18));

  // ---------------------------------------------------------------- trending
  // /api/trending scores real activity (orders x3 + stars, last 30 days) and tops the list
  // up with cheap picks so the screen is never empty. Cached for a minute client-side.
  let trendingCache = null;
  async function loadTrending(force) {
    if (!force && trendingCache && Date.now() - trendingCache.at < 60000) return trendingCache.data;
    const data = await apiGet('/trending', { refresh: Boolean(force) });
    trendingCache = { at: Date.now(), data };
    return data;
  }

  const trendingRow = (s, i) => h('div', { class: 'svc' },
    h('span', { class: 'rank' }, String(i + 1)),
    h('div', { style: 'min-width:0;flex:1' },
      h('div', { class: 'row', style: 'gap:8px;align-items:flex-start;flex-wrap:nowrap' },
        h('div', { class: 'name', style: 'flex:1' }, s.name),
        starBtn(s)),
      h('div', { class: 'meta' },
        `${s.platform ? `${s.platform.name} · ` : ''}${s.category} · ${s.flat ? 'per order' : `min ${num(s.min)} – max ${num(s.max)}`}`
        + (s.orders_30d ? ` · ${num(s.orders_30d)} sold` : ''))),
    h('div', { class: 'svc-side' },
      h('span', { class: 'price' }, s.flat ? amt(s.rate_cents) : per1000(s.rate_cents)),
      h('a', { class: 'btn small', href: `#/order?service=${s.id}` }, 'Order')));

  async function trendingView() {
    stopTimer();
    fill(view, pageHead('Trending', 'What other customers are buying right now.'),
      h('div', { class: 'card' }, skeletons(4)));
    let data;
    try { data = await loadTrending(); }
    catch (e) { return fill(view, pageHead('Trending'), errBox(e.message)); }
    if (stale()) return;

    fill(view,
      h('a', { class: 'backlink', href: '#/order' }, '← All platforms'),
      pageHead('Trending', data.source === 'activity'
        ? `Most ordered services in the last ${data.window_days} days, plus the ones people star most.`
        : 'Popular picks from the catalogue — the trend starts with your first order.'),
      data.platforms.length ? h('div', { class: 'tchips' },
        data.platforms.map((p) => h('a', {
          class: 'tchip',
          href: `#/order?platform=${encodeURIComponent(p.key)}&sort=cheap`,
        }, svg(ICO.flame, 14), h('span', null, p.name)))) : null,
      h('div', { class: 'card'},
        data.services.length ? data.services.map(trendingRow)
          : h('p', { class: 'muted' }, 'Nothing trending yet — check back soon.')),
      h('div', { class: 'row', style: 'gap:10px;margin-top:14px' },
        h('a', { class: 'btn ghost small', href: '#/order' }, 'Browse all platforms'),
        h('button', {
          class: 'btn ghost small',
          onclick: async (ev) => {
            const el = ev.currentTarget;
            el.disabled = true; el.textContent = 'Refreshing…';
            try { await loadTrending(true); trendingCache = null; location.hash = '#/trending'; route(); }
            catch (e) { toast(e.message, true); el.disabled = false; el.textContent = 'Refresh'; }
          },
        }, 'Refresh')));
  }

  const platTile = (p, href) => h('a', { class: 'plat', href },
    h('span', { class: 'plat-ico' }, abbr(p.name)),
    h('span', { class: 'plat-name' }, p.name),
    h('span', { class: 'plat-count' }, p.label || `${num(p.count)} services`));

  /** Step 1 - the platform grid. */
  async function orderPlatformView() {
    stopTimer();
    fill(view, pageHead('New order', 'Choose a platform first, then pick a category.'), h('div', { class: 'card' }, skeletons(3)));
    let data;
    try { data = await loadServices({ per_page: 1 }); }
    catch (e) { return fill(view, pageHead('New order'), errBox(e.message)); }
    if (stale()) return;

    const search = h('input', { type: 'search', placeholder: `Search all ${num(data.pagination.total)} services…`, autocomplete: 'off' });
    const submit = () => {
      const q = search.value.trim();
      location.hash = `#/order?${new URLSearchParams({ platform: 'all', q, sort: 'cheap', page: 1 })}`;
    };
    search.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });

    // Every tile is kept in a Map so the hot badges can be patched in when /trending
    // answers - the chooser must never wait on it, a cold catalog load takes seconds.
    const tiles = new Map();
    const tile = (p, href) => { const el = platTile(p, href); tiles.set(p.key, el); return el; };
    const grid = h('div', { class: 'plat-grid' },
      tile({ key: 'trend', name: 'Trending', label: 'Hot right now' }, '#/trending'),
      state.favorites.size
        ? tile({ key: 'fav', name: 'Starred', count: state.favorites.size }, '#/order?favorites=1')
        : null,
      data.platforms.map((p) => tile(p, `#/order?platform=${encodeURIComponent(p.key)}&sort=cheap`)),
      tile({ key: 'all', name: 'All services', count: data.pagination.total },
        '#/order?platform=all&sort=cheap'));

    loadTrending().then((trend) => {
      if (!trend || stale()) return;
      for (const p of trend.platforms) {
        const el = tiles.get(p.key);
        if (el && !el.querySelector('.plat-hot')) {
          el.prepend(h('span', { class: 'plat-hot', title: 'Trending on smmpanel' }, svg(ICO.flame, 11)));
        }
      }
    }).catch(() => { /* trending is decoration only */ });

    fill(view,
      pageHead('New order', 'Choose a platform first, then pick a category.'),
      h('div', { class: 'searchrow' }, search,
        h('button', { class: 'sq', 'aria-label': 'Search services', onclick: submit }, svg(ICO.search, 20))),
      h('label', { style: 'margin:18px 0 10px' }, 'Platform'),
      grid);
  }

  /** Step 2 - services for one platform, with the category list and the sort control. */
  async function orderBrowseView(params) {
    stopTimer();
    const platform = params.platform || 'all';
    const category = params.category || '';
    const sort = params.sort || 'cheap';
    const q = params.q || '';
    const page = Number(params.page) || 1;

    const link = (over = {}) => `#/order?${new URLSearchParams({
      platform, category, sort, q, page: 1, ...over,
    })}`;

    const starred = Boolean(params.favorites);
    fill(view, h('a', { class: 'backlink', href: '#/order' }, '← All platforms'), h('div', { class: 'card' }, skeletons(3)));
    let data;
    try {
      if (starred) {
        await loadFavorites();
        data = state.favorites.size
          ? await loadServices({ ids: [...state.favorites].join(','), per_page: 200 })
          : { services: [], categories: [], platforms: [], pagination: { page: 1, per_page: 200, total: 0, pages: 1 } };
      } else {
        data = await loadServices({ platform, category, sort, q, page, per_page: 20 });
      }
    } catch (e) { return fill(view, h('a', { class: 'backlink', href: '#/order' }, '← All platforms'), pageHead('New order'), errBox(e.message)); }
    if (stale()) return;

    const plat = starred
      ? { name: 'Starred services', count: data.services.length }
      : data.platforms.find((p) => p.key === platform) || { name: 'All services', count: data.pagination.total };

    const search = h('input', { type: 'search', placeholder: `Search ${plat.name} services…`, value: q, autocomplete: 'off' });
    search.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') location.hash = link({ q: search.value.trim() }); });

    const catSel = h('select', { 'aria-label': 'Category' },
      h('option', { value: '' }, `All categories (${num(data.categories.length)})`),
      data.categories.map((c) => h('option', { value: c, selected: c === category }, c)));
    catSel.addEventListener('change', () => { location.hash = link({ category: catSel.value }); });

    const sortSel = h('select', { 'aria-label': 'Sort by' },
      SORTS.map(([v, label]) => h('option', { value: v, selected: v === sort }, label)));
    sortSel.addEventListener('change', () => { location.hash = link({ sort: sortSel.value }); });

    const row = (s) => h('div', { class: 'svc' },
      h('div', { style: 'min-width:0;flex:1' },
        h('div', { class: 'row', style: 'gap:8px;align-items:flex-start;flex-wrap:nowrap' },
          h('div', { class: 'name', style: 'flex:1' }, s.name),
          starBtn(s)),
        h('div', { class: 'meta' },
          `${s.category} · ${s.flat ? 'per order' : `min ${num(s.min)} – max ${num(s.max)}`}${s.refill ? ' · refill' : ''}`)),
      h('div', { class: 'svc-side' },
        h('span', { class: 'price' }, s.flat ? amt(s.rate_cents) : per1000(s.rate_cents)),
        h('a', { class: 'btn small', href: `#/order?service=${s.id}&platform=${encodeURIComponent(platform)}` }, 'Select')));

    fill(view,
      h('a', { class: 'backlink', href: '#/order' }, '← All platforms'),
      h('div', { class: 'row', style: 'gap:12px;margin-bottom:14px' },
        h('span', { class: 'plat-ico lg' }, abbr(plat.name)),
        h('div', null,
          h('h1', { style: 'margin:0' }, plat.name),
          h('div', { class: 'muted', style: 'font-size:.85rem' }, `${num(data.pagination.total)} services`))),
      h('div', { class: 'searchrow' }, search,
        h('button', { class: 'sq', 'aria-label': 'Search', onclick: () => { location.hash = link({ q: search.value.trim() }); } }, svg(ICO.search, 20))),
      starred ? null : [h('label', null, 'Category'), catSel, h('label', null, 'Sort by'), sortSel],
      h('div', { class: 'countline' }, starred
        ? `${num(data.services.length)} starred service(s)`
        : `${num(data.pagination.total)} service(s) · ${sortWord(sort)}`),
      h('div', { class: 'card' },
        data.services.length ? data.services.map(row)
          : h('p', { class: 'muted' }, starred ? 'No starred services yet — tap the ☆ on any service to save it here.' : 'No services match those filters.'),
        h('div', { class: 'pagination' },
          h('button', { class: 'btn ghost small', disabled: page <= 1, onclick: () => { location.hash = link({ page: page - 1 }); } }, 'Previous'),
          h('span', { class: 'muted' }, `Page ${data.pagination.page} / ${data.pagination.pages}`),
          h('button', { class: 'btn ghost small', disabled: page >= data.pagination.pages, onclick: () => { location.hash = link({ page: page + 1 }); } }, 'Next'))));
  }

  /** Step 3 - the order form for one service. */
  async function orderFormView(params) {
    stopTimer();
    track('order_form_view');
    const sid = Number(params.service) || 0;
    // Paint from the list the customer just tapped when we already know the service, so the form
    // opens instantly; the authoritative price still comes from the quote endpoint below.
    let service = svcById.get(sid) || null;
    if (!service) {
      try { service = (await apiGet(`/services/${sid}`, { maxAge: 5 * 60 * 1000 })).service; }
      catch (e) { return fill(view, pageHead('New order'), errBox(e.message)); }
      svcById.set(sid, service);
    } else if (Date.now() - (svcAt.get(sid) || 0) > CACHE_TTL) {
      // The copy is older than the cache window: revalidate in the background and re-render once
      // if the price moved. A fresh copy opens the form with no request at all.
      apiGet(`/services/${sid}`, { maxAge: 5 * 60 * 1000, refresh: true })
        .then((r) => {
          if (!r || !r.service) return;
          svcById.set(sid, r.service);
          if (Number(r.service.rate_cents) !== Number(service.rate_cents) && state.route === 'order' && !svcRefreshed.has(sid)) {
            svcRefreshed.add(sid);
            route();
          }
        })
        .catch(() => {});
    }
    if (stale()) return;

    const back = params.platform ? `#/order?platform=${encodeURIComponent(params.platform)}&sort=cheap` : '#/order';
    const form   = h('div');
    const info   = h('div');
    const inputs = {};
    const def    = state.meta.fields;
    const totalEl = h('div', { class: 'v big' }, '—');
    const note   = h('div', { class: 'hint' });
    const btn    = h('button', { class: 'btn block' }, 'Place order');
    const shortfallHost = h('div');

    function localTotal() {
      if (service.flat) return service.rate_cents;
      const qty = Number(inputs.quantity && inputs.quantity.value);
      if (!Number.isFinite(qty) || qty < 1) return 0;
      return Math.ceil((service.rate_cents * qty) / 1000);
    }

    let t = null;
    function refreshQuote() {
      const qty = inputs.quantity ? Number(inputs.quantity.value) : 0;
      const total = localTotal();
      totalEl.textContent = total ? amt(total) : '—';
      btn.textContent = `Place order${total ? ` · ${amt(total)}` : ''}`;
      btn.disabled = !total;
      clearTimeout(t);
      t = setTimeout(async () => {
        try {
          const quote = await api(`/quote?${new URLSearchParams({ service: service.id, quantity: qty || 0 })}`);
          if (quote.problem) { note.textContent = quote.problem; btn.disabled = true; }
          else {
            note.textContent = '';
            totalEl.textContent = amt(quote.price_cents);
            btn.textContent = `Place order · ${amt(quote.price_cents)}`;
            btn.disabled = !quote.price_cents;
          }
        } catch { /* keep the local estimate */ }
      }, 250);
    }

    service.fields.forEach((field) => {
      const meta = def[field] || { label: field, multiline: false };
      if (field === 'quantity') {
        const qty = h('input', { type: 'number', inputmode: 'numeric', min: service.min || 1, max: service.max || undefined, value: service.min || 1 });
        inputs.quantity = qty;
        qty.addEventListener('input', refreshQuote);
        form.append(h('label', null, `Quantity (min ${num(service.min)}, max ${num(service.max)})`), qty);
        return;
      }
      const input = meta.multiline
        ? h('textarea', { placeholder: 'One per line' })
        : h('input', { type: field === 'link' || field === 'media' ? 'url' : 'text', autocomplete: 'off', placeholder: field === 'link' ? 'https://…' : '' });
      inputs[field] = input;
      form.append(h('label', null, meta.label), input);
    });

    form.append(h('div', { class: 'divider' }),
      h('div', null,
        h('div', { class: 'k', style: 'color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px' }, 'Total'),
        totalEl),
      note, btn, shortfallHost);

    btn.addEventListener('click', async () => {
      if (!state.user) { toast('Please log in to place an order.', true); location.hash = '#/login'; return; }
      const body = { service: service.id };
      for (const [k, el] of Object.entries(inputs)) body[k] = el.value.trim();
      btn.disabled = true;
      try {
        const res = await api('/orders', { method: 'POST', body });
        setBalance(res.balance_cents);
        track('order_placed');
        toast(`Order #${res.order.id} placed.`);
        location.hash = '#/orders';
      } catch (e) {
        btn.disabled = false;
        toast(e.message, true);
        // 402: the wallet is short. Offer to collect exactly the difference right here, so the
        // customer does not have to remember the amount, walk to the wallet and come back.
        if (e.status === 402) offerShortfall(shortfallHost, Math.max(0, localTotal() - (state.user.balance_cents || 0)));
      }
    });

    fill(info,
      h('div', { style: 'font-weight:700;color:var(--text)' }, service.name),
      h('div', { class: 'meta' }, `${service.category} · ${service.type}`),
      h('div', { style: 'margin-top:10px;font-weight:800' }, service.flat ? `${amt(service.rate_cents)} per order` : `${amt(service.rate_cents)} per 1000`),
      h('div', { class: 'meta', style: 'margin-top:6px' },
        `${service.min && service.max ? `min ${num(service.min)} · max ${num(service.max)}` : ''}${service.refill ? ' · refill available' : ''}${service.cancel ? ' · cancel available' : ''}`),
      service.description ? h('p', { class: 'hint' }, service.description) : null);

    fill(view,
      h('a', { class: 'backlink', href: back }, '← Back to services'),
      pageHead('Order', service.name),
      h('div', { class: 'card' }, h('h2', null, 'Order details'), form),
      h('div', { class: 'card' }, h('h2', null, 'Service info'), info));

    refreshQuote();
  }

  /**
   * "You are short KSh N" panel: collects the difference with M-Pesa, then retries the order the
   * customer was already trying to place. `minTopupKes` is respected - M-Pesa cannot collect less.
   */
  function offerShortfall(host, missingCents) {
    if (!host) return;
    const min = Number((state.meta && state.meta.minTopupKes) || 50);
    const need = Math.max(min, Math.ceil((missingCents || 0) / 100));
    if (!state.meta || !state.meta.mpesaEnabled) {
      fill(host, h('p', { class: 'hint' }, `Add ${amt(need * 100)} to your wallet first. `,
        h('a', { href: '#/wallet' }, 'Open the wallet →')));
      return;
    }
    const phone = h('input', { type: 'tel', autocomplete: 'tel', placeholder: '0712 345 678' });
    const status = h('div', { class: 'hint' });
    const go = h('button', { class: 'btn block' }, `Pay ${amt(need * 100)} with M-Pesa`);
    go.disabled = true;
    getPayProof().then(() => { go.disabled = false; }).catch(() => { go.disabled = false; });

    go.addEventListener('click', async () => {
      go.disabled = true;
      status.textContent = 'Sending the M-Pesa prompt…';
      track('shortfall_pay');
      try {
        const res = await payWithMpesa(phone.value, need, { onStatus: (m) => { status.textContent = m; } });
        if (res.status !== 'paid') {
          status.textContent = res.status === 'failed'
            ? 'The payment was not completed. Try again, or open the wallet.'
            : 'No confirmation yet. If you approved it, the balance appears in a moment.';
          go.disabled = false;
          return;
        }
        status.textContent = 'Paid. Placing your order…';
        toast(`Paid ${amt(need * 100)}.`);
        track('topup_paid');
        route(); // re-render the form with the new balance
      } catch (e) {
        status.textContent = e.message;
        go.disabled = false;
      }
    });

    fill(host, h('div', { class: 'shortfall' },
      h('h2', null, 'You are short on this order'),
      h('p', { class: 'hint' }, `Your wallet is short by ${amt(missingCents || 0)}. Add ${amt(need * 100)} with M-Pesa and the order can be placed straight away.`),
      h('label', null, 'M-Pesa phone number'), phone, go, status));
  }

  // ------------------------------------------------------------------ orders
  function orderCard(o, opts = {}) {
    const gen = opts.relative === false ? fmtDate : relDate;
    return h('div', { class: 'order-item' },
      h('div', { class: 'order-top' },
        h('div', { style: 'min-width:0' },
          h('div', { class: 'order-id' }, `#${o.id}`),
          h('div', { class: 'order-name' }, o.service_name)),
        badge(o.status)),
      h('div', { class: 'order-meta' },
        o.quantity ? h('span', null, `Qty ${num(o.quantity)}`) : null,
        h('span', null, amt(o.price_cents)),
        o.remains != null ? h('span', null, `${num(o.remains)} remaining`) : null,
        h('span', null, gen(o.created_at))),
      o.link ? h('div', { class: 'order-meta' }, safeLink(o.link)) : null,
      groupOf(o.status) === 'attention'
        ? h('div', { class: 'order-meta' },
            h('a', {
              class: 'wa-mini', target: '_blank', rel: 'noopener noreferrer',
              href: whatsappHref(`Hi, order #${o.id} (${o.service_name}) needs help. Link: ${o.link || '-'}`),
            }, svg(ICO.whatsapp, 14), 'Text us about #' + o.id),
            h('a', {
              class: 'wa-mini', style: 'margin-left:14px',
              href: `#/support?order=${o.id}&service=${encodeURIComponent(o.service_name || '')}`,
            }, 'Open a ticket'))
        : null,
      opts.actions ? h('div', { class: 'order-actions' },
        o.can_refill ? h('button', { class: 'btn ghost small', onclick: (ev) => opts.onAct(ev, o.id, 'refill') }, 'Refill') : null,
        o.can_cancel ? h('button', { class: 'btn ghost small', onclick: (ev) => opts.onAct(ev, o.id, 'cancel') }, 'Cancel') : null,
        h('a', { class: 'btn ghost small', href: `#/order?service=${o.service_id}` }, 'Reorder')) : null);
  }

  async function ordersView() {
    if (!requireLogin()) return;
    stopTimer();
    const active = (state.filters && state.filters.orders) || 'all';
    const listBox = h('div', null, skeletons(3));
    const countLine = h('div', { class: 'countline' }, '—');

    const search = h('input', { type: 'search', placeholder: 'Search order ID, service, or target link', autocomplete: 'off' });
    const viewSel = h('select', { 'aria-label': 'View' }, h('option', { value: 'full' }, 'Full view'), h('option', { value: 'compact' }, 'Compact'));
    const dateSel = h('select', { 'aria-label': 'Dates' }, h('option', { value: 'relative' }, 'Relative dates'), h('option', { value: 'exact' }, 'Exact dates'));

    const chipDefs = [
      ['all', 'All', () => true],
      ['active', 'In progress', (o) => groupOf(o.status) === 'active'],
      ['done', 'Completed', (o) => groupOf(o.status) === 'done'],
      ['attention', 'Needs attention', (o) => groupOf(o.status) === 'attention'],
    ];
    const chips = h('div', { class: 'filters' }, chipDefs.map(([key, label]) =>
      h('button', {
        class: `chip${active === key ? ' active' : ''}`,
        onclick: () => { state.filters = { ...(state.filters || {}), orders: key }; ordersView(); },
      }, h('span', null, label), h('span', { class: 'box' }))));

    async function act(ev, id, kind) {
      ev.target.disabled = true;
      try {
        const res = await api(`/orders/${id}/${kind}`, { method: 'POST' });
        toast(res.message || 'Done.');
        await draw();
      } catch (e) { toast(e.message, true); ev.target.disabled = false; }
    }

    async function draw() {
      let data;
      try { data = await api('/orders'); }
      catch (e) { return fill(listBox, errBox(e.message)); }
      if (stale()) return;
      state.orders = data.orders;
      renderChrome();
      const q = search.value.trim().toLowerCase();
      const pred = chipDefs.find(([k]) => k === active)[2];
      const inGroup = data.orders.filter(pred);
      const rows = inGroup.filter((o) => !q
        || String(o.id) === q || String(o.service_name).toLowerCase().includes(q) || String(o.link || '').toLowerCase().includes(q));
      const total = rows.reduce((sum, o) => sum + (o.price_cents || 0), 0);
      countLine.textContent = rows.length
        ? `${num(rows.length)} order${rows.length === 1 ? '' : 's'} · ${amt(total)}`
        : '—';
      fill(listBox, rows.length
        ? rows.map((o) => orderCard(o, { actions: viewSel.value !== 'compact', relative: dateSel.value === 'relative', onAct: act }))
        : emptyState('🧾', active === 'all' ? 'No orders yet' : 'Nothing here',
            active === 'all' ? 'Place your first order and it will appear here.' : 'No orders match this filter.',
            active === 'all' ? h('a', { class: 'btn', href: '#/order' }, 'New order') : null));
    }

    search.addEventListener('input', () => draw());
    viewSel.addEventListener('change', () => draw());
    dateSel.addEventListener('change', () => draw());

    // Manual sync for the orders the customer is actually watching. The 20 s poll below keeps the
    // list fresh; this is for "I just paid, why is it still pending" - it asks the provider now.
    const syncBtn = h('button', { class: 'btn ghost' }, 'Sync now');
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      const live = (state.orders || []).filter((o) => groupOf(o.status) === 'active').slice(0, 8);
      let moved = 0;
      const before = new Map((state.orders || []).map((o) => [o.id, o.status]));
      try {
        for (const o of live) {
          try {
            const { order } = await api(`/orders/${o.id}/refresh`, { method: 'POST' });
            if (order && before.get(order.id) !== order.status) moved += 1;
          } catch { /* one bad order must not stop the sweep */ }
        }
        await draw();
        toast(live.length
          ? (moved ? `${moved} order${moved === 1 ? '' : 's'} moved forward.` : 'Checked - nothing has changed yet.')
          : 'Nothing in progress to check.');
      } finally { syncBtn.disabled = false; }
    });

    fill(view,
      pageHead('Orders', 'View and manage your orders',
        h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' },
          syncBtn, h('a', { class: 'btn', href: '#/order' }, '+ New Order'))),
      chips,
      h('div', { class: 'divider', style: 'margin:6px 0 16px' }),
      h('label', { style: 'margin-top:0' }, 'Search'),
      h('div', { class: 'searchrow' }, search, h('button', { class: 'sq', 'aria-label': 'Filters' }, svg(ICO.filter, 20))),
      countLine,
      h('div', { class: 'row', style: 'margin-bottom:16px;gap:10px;flex-wrap:nowrap' },
        h('div', { style: 'flex:1' }, viewSel),
        h('div', { style: 'flex:1' }, dateSel),
        h('button', { class: 'sq', style: 'height:auto', 'aria-label': 'Export CSV', onclick: exportCsv }, svg(ICO.download, 20))),
      listBox);

    await draw();
    state.timer = setInterval(() => {
      if (currentRoute().name !== 'orders') return stopTimer();
      draw().catch(() => {});
    }, 20000);
  }

  function exportCsv() {
    const rows = state.orders || [];
    if (!rows.length) return toast('Nothing to export.', true);
    const head = 'id,service,quantity,price_kes,status,created_at\n';
    const body = rows.map((o) => [o.id, `"${String(o.service_name).replace(/"/g, '""')}"`, o.quantity ?? '', (o.price_cents / 100).toFixed(2), o.status, o.created_at].join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([head + body], { type: 'text/csv' }));
    const a = h('a', { href: url, download: 'orders.csv' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ------------------------------------------------------------------ mass order
  async function massView() {
    if (!requireLogin()) return;
    stopTimer();
    let services;
    try { services = (await loadServices({ per_page: 200 })).services; }
    catch (e) { return fill(view, pageHead('Mass order'), errBox(e.message)); }
    if (stale()) return;

    const search = h('input', { type: 'search', placeholder: 'Search services…', autocomplete: 'off' });
    const svcSel = h('select', { 'aria-label': 'Service' });
    const qty = h('input', { type: 'number', min: '1', value: '1000', inputmode: 'numeric' });
    const links = h('textarea', { placeholder: 'https://instagram.com/p/abc\nhttps://instagram.com/p/def' });
    const summary = h('div', { style: 'font-size:1.15rem;font-weight:800' }, '—');
    const results = h('div');
    const runBtn = h('button', { class: 'btn block' }, 'Place all orders');

    const current = () => services.find((s) => s.id === Number(svcSel.value));
    const list = () => links.value.split('\n').map((l) => l.trim()).filter(Boolean);

    function refresh() {
      const s = current();
      const n = list().length;
      if (!s || !n) { summary.textContent = '—'; return; }
      const q = s.flat ? 1 : Math.max(1, Number(qty.value) || 0);
      summary.textContent = `${amt(s.flat ? s.rate_cents * n : Math.ceil((s.rate_cents * q) / 1000) * n)} · ${n} order${n === 1 ? '' : 's'}`;
    }

    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      const found = services.filter((s) => !q || s.name.toLowerCase().includes(q) || String(s.id) === q).slice(0, 300);
      fill(svcSel, h('option', { value: '' }, found.length ? 'Select a service…' : 'No matching services'),
        found.map((s) => h('option', { value: s.id }, `${s.name} — ${s.flat ? amt(s.rate_cents) : per1000(s.rate_cents)}`)));
      refresh();
    });
    [svcSel, qty, links].forEach((el) => el.addEventListener('input', refresh));

    runBtn.addEventListener('click', async () => {
      const s = current();
      const items = list();
      if (!s) return toast('Choose a service first.', true);
      if (!items.length) return toast('Paste at least one link.', true);
      runBtn.disabled = true;
      const out = [];
      for (let i = 0; i < items.length; i += 1) {
        runBtn.textContent = `Placing ${i + 1} of ${items.length}…`;
        try {
          const body = { service: s.id, link: items[i] };
          if (s.fields.includes('quantity')) body.quantity = Math.max(1, Number(qty.value) || 1);
          const res = await api('/orders', { method: 'POST', body });
          setBalance(res.balance_cents);
          out.push({ ok: true, line: items[i], id: res.order.id });
        } catch (e) { out.push({ ok: false, line: items[i], error: e.message }); }
      }
      runBtn.disabled = false;
      runBtn.textContent = 'Place all orders';
      const okCount = out.filter((o) => o.ok).length;
      fill(results, h('div', { class: 'card' },
        h('h2', null, `${okCount} of ${out.length} placed`),
        h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, out.map((o) => h('tr', null,
          h('td', { class: 'meta' }, o.line),
          h('td', null, o.ok ? badge('queued') : badge('failed')),
          h('td', { class: 'meta' }, o.ok ? `#${o.id}` : o.error))))))));
      toast(`${okCount} order(s) placed.`);
    });

    fill(view,
      pageHead('Mass order', 'Paste one link per line — each line becomes its own order.'),
      h('div', { class: 'searchrow' }, search, h('button', { class: 'sq', 'aria-label': 'Filter' }, svg(ICO.filter, 20))),
      h('label', null, 'Service'), svcSel,
      h('label', null, 'Target links (one per line)'), links,
      h('label', null, 'Quantity per order'), qty,
      h('div', { class: 'card' },
        h('div', { class: 'k', style: 'color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px' }, 'Estimated total'),
        summary),
      runBtn, results);
    search.dispatchEvent(new Event('input'));
  }

  // ------------------------------------------------------------------ drip
  function dripView() {
    stopTimer();
    fill(view,
      pageHead('Drip campaigns', 'Schedule the same order to repeat on a timer.'),
      emptyState('⏳', 'Drip campaigns are not available yet',
        'Scheduling needs a background worker this deployment does not run. Use Mass order for one-off batches.',
        h('a', { class: 'btn', href: '#/mass' }, 'Open Mass order')));
  }

  // ------------------------------------------------------------------ auth (with Google)
  /** Shown under the auth forms: whoever is stuck cannot get to More → Support. */
  function authHelpLine() {
    const s = support();
    return h('p', { class: 'hint', style: 'text-align:center;margin-top:14px' },
      'Trouble signing in? ',
      h('a', { href: whatsappHref('Hi, I am having trouble signing in to smmpanel.'), target: '_blank', rel: 'noopener noreferrer' },
        'Text ' + s.phone + ' on WhatsApp'));
  }

  function googleButton() {
    const enabled = Boolean(state.meta && state.meta.googleEnabled);
    const btn = h('a', {
      class: 'btn-google',
      href: enabled ? '/api/auth/google' : '#',
      'aria-disabled': enabled ? null : 'true',
      rel: 'nofollow',
      onclick: (ev) => {
        if (!enabled) {
          ev.preventDefault();
          toast('Google sign-in is not configured yet — add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.', true);
        }
      },
    });
    btn.innerHTML = GOOGLE_G; // constant markup from this file
    btn.append(document.createTextNode('Continue with Google'));
    return btn;
  }

  const AUTH_ERRORS = {
    google_state: 'Sign-in expired or was tampered with. Please try again.',
    google_denied: 'Google sign-in was cancelled.',
    google_exchange: 'Google did not return a valid token. Try again.',
    google_profile: 'Could not read your Google profile. Try again.',
    google_unverified: 'That Google account has no verified email address.',
  };

  function authView(mode, params = {}) {
    stopTimer();
    track(mode === 'login' ? 'login_view' : 'register_view');
    const isLogin = mode === 'login';
    const email = h('input', { type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
    const password = h('input', { type: 'password', autocomplete: isLogin ? 'current-password' : 'new-password', placeholder: '••••••••' });
    const err = h('div', { class: 'errtext' }, AUTH_ERRORS[params.error] || '');
    const btn = h('button', { class: 'btn block' }, isLogin ? 'Log in' : 'Create account');

    const agree = h('input', { type: 'checkbox', id: 'agreeTerms', class: 'agree-box' });
    const agreeRow = h('label', { class: 'agree', for: 'agreeTerms' }, agree,
      h('span', null, 'I accept the ', h('a', { href: '#/terms', target: '_blank', rel: 'noopener' }, 'Terms & Conditions'),
        ', including that services are delivered by third-party vendors and can drop.'));

    const submit = async () => {
      err.textContent = '';
      if (!isLogin && !agree.checked) {
        err.textContent = 'Tick the box to accept the Terms & Conditions first.';
        return;
      }
      btn.disabled = true;
      try {
        const body = isLogin
          ? { email: email.value.trim(), password: password.value }
          : { email: email.value.trim(), password: password.value, accept_terms: true };
        const { user } = await api(`/auth/${isLogin ? 'login' : 'register'}`, { method: 'POST', body });
        track(isLogin ? 'login_success' : 'register_success');
        state.user = user;
        resetPayProof();                 // a fresh account means a fresh puzzle
        getPayProof().catch(() => {});   // solve it while the customer reads the next screen
        await loadFavorites();
        renderChrome();
        toast(isLogin ? 'Welcome back!' : 'Account created.');
        const next = params.next;
        // only ever an in-site absolute path, never a full URL (open-redirect guard)
        if (typeof next === 'string' && /^\/(?![\/\\])/.test(next)) location.assign(next);
        else location.hash = '#/';
      } catch (e) { err.textContent = e.message; btn.disabled = false; }
    };
    btn.addEventListener('click', submit);
    password.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    fill(view,
      pageHead(isLogin ? 'Log in' : 'Create an account', isLogin ? 'Access your wallet and orders.' : 'Pay with M-Pesa. Prices in KES.'),
      h('div', { class: 'card' },
        googleButton(),
        h('div', { class: 'or' }, 'or use your email'),
        h('label', null, 'Email'), email,
        h('label', null, 'Password'), password,
        isLogin ? null : agreeRow,
        err, btn,
        isLogin ? h('p', { class: 'hint' }, h('a', { href: '#/forgot' }, 'Forgot your password?')) : null,
        h('p', { class: 'hint' }, isLogin ? 'No account yet? ' : 'Already registered? ',
          h('a', { href: isLogin ? '#/register' : '#/login' }, isLogin ? 'Create one' : 'Log in')),
        h('p', { class: 'hint' }, h('a', { href: '#/services' }, 'Browse prices without an account →')),
        authHelpLine(),
        state.meta && state.meta.googleEnabled
          ? null
          : h('p', { class: 'hint' }, 'Google sign-in appears once GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.')));
  }

  // ------------------------------------------------------------------ help
  // Plain answers to the questions that otherwise turn into tickets, with the WhatsApp line
  // one tap away at the bottom.
  function helpView() {
    stopTimer();
    const items = [
      ['How do I pay?', `Top up your wallet from the Wallet tab. We use M-Pesa (STK push): enter the amount, approve the prompt on your phone, and the balance appears within seconds. Minimum ${num(state.meta ? state.meta.minTopupKes : 50)} KES.`],
      ['My order has not started. What now?', 'Most services start within minutes. If an order sits at Pending for more than an hour, open the order, tap refresh, then text us on WhatsApp with the order number — we chase the provider directly.'],
      ['What is "remains"?', 'It is how much of the ordered quantity the provider has not delivered yet. It counts down as the order progresses. When it reaches 0 the order is complete.'],
      ['Can I cancel or refill an order?', 'Only where the service supports it — the buttons appear on the order card when it does. Refills are free and restart delivery; cancellations return the unused portion to your wallet.'],
      ['The link I sent is wrong.', 'Orders cannot be edited once they reach the provider. If the order has not started, request a cancel; if it has, text us and we will tell you what is possible.'],
      ['Do prices include fees?', 'Yes. The KES price you see is what is charged to your wallet. There are no hidden add-ons at checkout.'],
      ['I paid but my wallet is empty.', 'M-Pesa normally settles in seconds. If it has been more than five minutes, open the Wallet tab, tap the pending top-up to re-check, then text us with the M-Pesa code.'],
      ['How do I change my password?', 'More → Password. Changing it signs out every other device. If you signed up with Google, set a password there to log in without Google too.'],
    ];
    fill(view,
      pageHead('Help', 'Quick answers. Anything else, text us on WhatsApp.'),
      h('div', { class: 'card' }, items.map(([q, a]) => h('details', { class: 'faq' }, h('summary', null, q), h('p', null, a)))),
      whatsappCard({ title: 'Still stuck?', subtitle: `Text ${support().phone} — a human replies, not a bot.` }));
  }

  // ------------------------------------------------------------------ wallet
  /**
   * Ask M-Pesa for one STK prompt and resolve when the top-up settles: `paid`, `failed` or
   * `timeout` (the customer did not finish the prompt). Used by the wallet screen and by the
   * "you are short KSh X" button on the order form, so nobody has to leave the order to top up.
   */
  function payWithMpesa(phone, amountKes, { onStatus } = {}) {
    return api('/wallet/topup', { method: 'POST', body: { phone, amount_kes: Number(amountKes) } })
      .then((res) => new Promise((resolve) => {
        if (onStatus) onStatus(res.message || 'Check your phone for the M-Pesa prompt.');
        let n = 0;
        const timer = setInterval(async () => {
          n += 1;
          try {
            const { topup } = await api(`/wallet/topup/${res.topup_id}`);
            if (topup.status === 'paid') {
              clearInterval(timer);
              resolve({ status: 'paid', topup });
            } else if (topup.status !== 'pending') {
              clearInterval(timer);
              resolve({ status: 'failed', topup });
            } else if (n >= 40) {
              clearInterval(timer);
              resolve({ status: 'timeout' });
            } else if (onStatus) {
              onStatus('Waiting for you to approve the M-Pesa prompt…');
            }
          } catch {
            clearInterval(timer);
            resolve({ status: 'timeout' });
          }
        }, 3000);
      }));
  }

  async function walletView() {
    if (!requireLogin()) return;
    stopTimer();
    let data;
    try { data = await api('/wallet'); }
    catch (e) { return fill(view, pageHead('Wallet'), errBox(e.message)); }
    if (stale()) return;
    setBalance(data.balance_cents);

    const phone = h('input', { type: 'tel', placeholder: '0712 345 678', autocomplete: 'tel' });
    const amount = h('input', { type: 'number', min: state.meta.minTopupKes, max: state.meta.maxTopupKes, value: 500, inputmode: 'numeric' });
    const err = h('div', { class: 'errtext' });
    const btn = h('button', { class: 'btn block' }, 'Send M-Pesa prompt');
    // The prompt endpoint refuses anything that did not come from a verified browser, so say so and
    // hold the button until the check is done (usually well before the customer types a number).
    const verifyNote = h('div', { class: 'hint' }, 'Verifying this browser…');
    btn.disabled = true;
    getPayProof()
      .then(() => { verifyNote.textContent = 'Browser verified. The prompt goes to your phone only.'; btn.disabled = false; })
      .catch((e) => {
        // Leave the button usable: the API answers with its own clear message if the check fails.
        verifyNote.textContent = e.message;
        btn.disabled = false;
      });

    btn.addEventListener('click', async () => {
      err.textContent = '';
      btn.disabled = true;
      track('topup_started');
      try {
        const res = await api('/wallet/topup', { method: 'POST', body: { phone: phone.value, amount_kes: Number(amount.value) } });
        toast(res.message || 'Check your phone.');
        watch(res.topup_id);
      } catch (e) { err.textContent = e.message; }
      finally { btn.disabled = false; }
    });

    function watch(id) {
      let n = 0;
      state.timer = setInterval(async () => {
        n += 1;
        try {
          const { topup } = await api(`/wallet/topup/${id}`);
          if (topup.status !== 'pending') {
            stopTimer();
            toast(topup.status === 'paid' ? `Payment received: ${amt(topup.credited_cents)}` : 'Payment was not completed.', topup.status !== 'paid');
            if (topup.status === 'paid') { track('topup_paid'); walletView(); }
          } else if (n > 20) stopTimer();
        } catch { stopTimer(); }
      }, 3000);
    }

    fill(view,
      pageHead('Wallet', 'Top up with M-Pesa and pay for orders instantly.'),
      h('div', { class: 'card' },
        h('h2', null, 'Wallet balance'),
        h('div', { style: 'font-size:1.35rem;font-weight:800;letter-spacing:-.01em' }, amt(data.balance_cents)),
        h('p', { class: 'muted', style: 'margin:10px 0 0' }, 'Available to spend on orders.')),
      h('div', { class: 'card' },
        h('h2', null, 'Top up with M-Pesa'),
        state.meta.mpesaEnabled
          ? [h('label', null, 'M-Pesa phone number'), phone,
             h('label', null, 'Amount (KES)'), amount,
             h('div', { class: 'row', style: 'margin-top:12px' }, [100, 250, 500, 1000, 2500].map((v) => h('button', { class: 'btn ghost small', onclick: () => { amount.value = v; } }, `KSh ${v}`))),
             err, btn, verifyNote,
             h('p', { class: 'hint' }, 'You will receive an M-Pesa prompt. Your wallet is credited only after Safaricom confirms the payment.')]
          : h('p', { class: 'muted' }, 'Mobile money is not switched on yet. Top-ups will appear here as soon as the payment provider is connected.')),
      h('div', { class: 'card' },
        h('h2', null, 'Recent transactions'),
        data.transactions.length
          ? h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, data.transactions.map((t) => h('tr', null,
              h('td', null, fmtDate(t.created_at)), h('td', null, t.type),
              h('td', { class: 'num' }, `${t.amount_cents > 0 ? '+' : ''}${amt(t.amount_cents)}`),
              h('td', { class: 'meta' }, t.note || ''))))))
          : h('p', { class: 'muted' }, 'No transactions yet.')),
      data.topups.length
        ? h('div', { class: 'card' }, h('h2', null, 'M-Pesa top-ups'),
            h('div', { class: 'table-wrap' }, h('table', null,
              h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', { class: 'num' }, 'Amount'), h('th', null, 'Status'), h('th', null, 'Receipt'))),
              h('tbody', null, data.topups.map((t) => h('tr', null,
                h('td', null, fmtDate(t.created_at)), h('td', { class: 'num' }, amt(t.credited_cents)), h('td', null, badge(t.status)), h('td', null, t.receipt || '—')))))))
        : null);
  }

  // ------------------------------------------------------------------ password
  // Changing the password bumps token_version server-side, so every other device is signed out
  // while this one stays logged in. A Google-only account sets its first password here.
  function passwordView() {
    if (!requireLogin()) return;
    stopTimer();
    const first = state.user.password_set === false;
    const current = h('input', { type: 'password', autocomplete: 'current-password', placeholder: '••••••••' });
    const next = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'At least 8 characters' });
    const again = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Repeat the new password' });
    const err = h('div', { class: 'errtext' });
    const btn = h('button', { class: 'btn block' }, first ? 'Set password' : 'Change password');

    const submit = async () => {
      err.textContent = '';
      if (next.value.length < 8) { err.textContent = 'Password must be at least 8 characters'; return; }
      if (next.value !== again.value) { err.textContent = 'The two passwords do not match'; return; }
      btn.disabled = true;
      try {
        const { user } = await api('/auth/password', {
          method: 'POST',
          body: { current_password: current.value, new_password: next.value },
        });
        state.user = user;
        toast(first ? 'Password set. You can now sign in with it.' : 'Password changed. Other devices were signed out.');
        location.hash = '#/';
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
      }
    };
    btn.addEventListener('click', submit);
    again.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    fill(view,
      pageHead(first ? 'Set a password' : 'Change password',
        first ? 'Your account signs in with Google. Add a password so you can log in without it.'
          : 'You will stay signed in here; every other device is signed out.'),
      h('div', { class: 'card' },
        first ? null : [h('label', null, 'Current password'), current],
        h('label', null, 'New password'), next,
        h('label', null, 'Repeat new password'), again,
        err, btn,
        h('p', { class: 'hint' }, 'Use at least 8 characters. This site never shows your password back to you.'),
        h('p', { class: 'hint' }, h('a', { href: '#/wallet' }, '← Back to wallet'))));
  }

  // ------------------------------------------------------------------ support
  function ticketBadge(t) {
    if (t.status !== 'open') return h('span', { class: 'badge' }, 'closed');
    return t.last_reply_by === 'admin'
      ? h('span', { class: 'badge completed' }, 'answered')
      : h('span', { class: 'badge processing' }, 'open');
  }

  const ticketRow = (t) => h('a', { class: 'order-item', href: `#/support/${t.id}`, style: 'display:block;color:inherit' },
    h('div', { class: 'order-top' },
      h('div', { class: 'order-id' }, `#${t.id} · ${t.subject}`),
      ticketBadge(t)),
    h('div', { class: 'order-meta' },
      h('span', null, `${num(t.messages)} message(s)`),
      h('span', null, relDate(t.updated_at)),
      t.email ? h('span', null, t.email) : null));

  async function supportView(params = {}) {
    if (!requireLogin()) return;
    stopTimer();
    // #/support?order=1042&service=Instagram%20followers opens a ticket already filled in, so a
    // customer never has to retype the order number we already know.
    const orderId = params.order ? String(params.order).replace(/\D/g, '') : '';
    const listBox = h('div', null, skeletons(3));
    const subject = h('input', {
      type: 'text', maxlength: '120', placeholder: 'e.g. Order #1042 has not started',
      value: orderId ? `Order #${orderId} needs help` : '',
    });
    const message = h('textarea', { placeholder: 'Include the order ID and the link you submitted.' });
    if (orderId) message.value = `Hello, this is about order #${orderId}` + (params.service ? ` (${params.service}).` : '.') + ' ';
    const err = h('div', { class: 'errtext' });
    const btn = h('button', { class: 'btn block' }, 'Open ticket');

    btn.addEventListener('click', async () => {
      err.textContent = '';
      if (!subject.value.trim() || !message.value.trim()) { err.textContent = 'Add a subject and a message.'; return; }
      btn.disabled = true;
      try {
        const { ticket } = await api('/tickets', { method: 'POST', body: { subject: subject.value.trim(), message: message.value.trim() } });
        toast(`Ticket #${ticket.id} opened.`);
        location.hash = `#/support/${ticket.id}`;
      } catch (e) { err.textContent = e.message; btn.disabled = false; }
    });

    fill(view,
      pageHead('Support', 'Text us on WhatsApp for anything urgent — tickets are for anything that needs a paper trail.'),
      whatsappCard({ subtitle: `Any problem, any time — text ${support().phone}. Include your order ID if you have one.` }),
      h('div', { class: 'card' },
        h('h2', null, 'Open a ticket'),
        h('label', null, 'Subject'), subject,
        h('label', null, 'Message'), message,
        err, btn),
      h('div', { class: 'card' }, h('h2', null, 'Your tickets'), listBox));

    try {
      const { tickets } = await api('/tickets');
      if (stale()) return;
      fill(listBox, tickets.length ? tickets.map(ticketRow) : h('p', { class: 'muted' }, 'No tickets yet.'));
    } catch (e) { fill(listBox, errBox(e.message)); }
  }

  async function ticketView(id) {
    if (!requireLogin()) return;
    stopTimer();
    const head = h('div');
    const thread = h('div', null, skeletons(3));
    const reply = h('textarea', { placeholder: 'Write a reply…' });
    const err = h('div', { class: 'errtext' });
    const send = h('button', { class: 'btn block' }, 'Send reply');
    const closeBtn = h('button', { class: 'btn ghost small' }, 'Close ticket');

    fill(view,
      h('a', { class: 'backlink', href: '#/support' }, '← All tickets'),
      head, thread,
      h('div', { class: 'card' }, h('h2', null, 'Reply'), reply, err, send, h('div', { style: 'margin-top:10px' }, closeBtn)));

    async function draw() {
      let data;
      try { data = await api(`/tickets/${id}`); }
      catch (e) { return fill(thread, errBox(e.message)); }
      if (stale()) return;
      const t = data.ticket;
      fill(head,
        h('div', { class: 'page-head' },
          h('div', null, h('h1', null, `#${t.id} ${t.subject}`), h('p', { class: 'sub' }, `Opened ${fmtDate(t.created_at)}`)),
          ticketBadge(t)));
      closeBtn.disabled = t.status !== 'open';
      fill(thread, data.messages.map((m) => h('div', {
        class: 'order-item',
        style: m.is_admin ? 'border-color:var(--text)' : '',
      },
        h('div', { class: 'order-top' },
          h('div', { class: 'order-id', style: 'font-size:.85rem' }, m.is_admin ? 'Support' : 'You'),
          h('span', { class: 'order-meta', style: 'margin:0' }, fmtDate(m.created_at))),
        h('div', { style: 'margin-top:8px;white-space:pre-wrap;line-height:1.5' }, m.body))));
    }

    send.addEventListener('click', async () => {
      err.textContent = '';
      if (!reply.value.trim()) { err.textContent = 'Write something first.'; return; }
      send.disabled = true;
      try {
        await api(`/tickets/${id}/messages`, { method: 'POST', body: { body: reply.value.trim() } });
        reply.value = '';
        await draw();
      } catch (e) { err.textContent = e.message; }
      finally { send.disabled = false; }
    });

    closeBtn.addEventListener('click', async () => {
      try { await api(`/tickets/${id}/close`, { method: 'POST' }); toast('Ticket closed.'); await draw(); }
      catch (e) { toast(e.message, true); }
    });

    await draw();
  }

  // ------------------------------------------------------------------ router
  /** The raw hash, including the '#', so a gate can send the customer back where they were. */
  const rawHash = () => (location.hash && location.hash.startsWith('#') ? location.hash : '#/');

  function currentRoute() {
    const raw = (location.hash || '#/').slice(1);
    const [pathPart, queryPart] = raw.split('?');
    const path = pathPart.replace(/^\/+|\/+$/g, '');
    return { name: path, params: Object.fromEntries(new URLSearchParams(queryPart || '')) };
  }

  async function route() {
    stopTimer();
    closeMenu();
    closePopover();
    const { name, params } = currentRoute();
    state.route = name;
    renderChrome();
    window.scrollTo({ top: 0 });
    fill(view);
    if (name === 'admin') { location.replace('/admin'); return; }

    // Acceptance gate. An account that has not accepted the current terms can still read the
    // terms, the help page and sign out - nothing else. state.afterTerms remembers where it was
    // heading so accepting drops the customer back there.
    const gateExempt = ['terms', 'privacy', 'help', 'login', 'register', 'forgot', 'reset'].includes(name);
    if (state.user && state.user.terms && !state.user.terms.accepted && !gateExempt) {
      state.afterTerms = rawHash() || '#/';
      return termsView();
    }
    // Warm the browser check on the two screens where money can move, so the click is instant.
    if (state.user && (name === 'wallet' || name === 'order')) getPayProof().catch(() => {});

    if (name.startsWith('support/')) {
      state.route = 'support';
      renderChrome();
      return ticketView(Number(name.split('/')[1]) || 0);
    }
    switch (name) {
      case '': return dashboardView();
      case 'order': return orderView(params);
      case 'services': return servicesView(params);
      case 'trending': return trendingView();
      case 'login': return authView('login', params);
      case 'register': return authView('register', params);
      case 'orders': return ordersView();
      case 'mass': return massView();
      case 'drip': return dripView();
      case 'support': return supportView(params);
      case 'password': return passwordView();
      case 'help': return helpView();
      case 'terms': return termsView();
      case 'privacy': return privacyView();
      case 'forgot': return forgotView();
      case 'reset': return resetView(params);
      case 'wallet': return walletView();
      default:
        return fill(view, pageHead('Not found'), h('p', { class: 'muted' }, 'That page does not exist.'),
          h('a', { class: 'btn', href: '#/' }, 'Go home'));
    }
  }

  window.addEventListener('hashchange', route);
  document.getElementById('menuBtn').addEventListener('click', (ev) => { ev.preventDefault(); toggleMenu(); });
  document.getElementById('closeBtn').addEventListener('click', () => {
    if (currentRoute().name) location.hash = '#/';
    else toast('Use your browser menu to close the app.');
  });
  document.getElementById('updateNow').addEventListener('click', () => location.reload());
  document.getElementById('updateLater').addEventListener('click', () => {
    state.updateDismissed = true;
    document.getElementById('updateBanner').hidden = true;
  });
  // A tap/hover on a service link is a reliable signal that the order form is next.
  const maybePrefetch = (ev) => {
    const a = ev.target && ev.target.closest && ev.target.closest('a[href*="#/order?service="]');
    if (!a) return;
    const m = /service=(\d+)/.exec(a.getAttribute('href') || '');
    if (m) prefetchService(m[1]);
  };
  document.addEventListener('pointerover', maybePrefetch, { passive: true });
  document.addEventListener('touchstart', maybePrefetch, { passive: true });
  document.addEventListener('focusin', maybePrefetch);

  document.addEventListener('click', (ev) => {
    if (popoverEl && !popoverEl.contains(ev.target)) closePopover();
    if (!menuEl().hidden && !menuEl().contains(ev.target) && ev.target.closest('#menuBtn') === null) closeMenu();
  });

  (async () => {
    try { state.meta = await api('/meta'); }
    catch {
      state.meta = {
        siteName: 'smmpanel', mpesaEnabled: false, googleEnabled: false,
        minTopupKes: 50, maxTopupKes: 150000, kesPerUsd: 129, build: 'dev', fields: {},
      };
    }
    state.build = state.meta.build;
    try { const { user } = await api('/auth/me'); state.user = user; } catch { /* logged out */ }
    loadSessionCache();
    prefetchCatalog();
    await loadFavorites();
    renderChrome();
    route();

    // "An app update is ready" when a new deployment reports a different build id
    setInterval(async () => {
      try {
        const m = await api('/meta');
        if (m.build && state.build && m.build !== state.build) showUpdateBanner();
      } catch { /* offline */ }
    }, 90000);
  })();
})();
