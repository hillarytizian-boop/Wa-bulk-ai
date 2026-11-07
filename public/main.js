/* HilaPanel SPA (no build step).
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
    flame: '<path d="M12 3.2c3.4 4.1 5.7 6.2 5.7 9.5A5.7 5.7 0 0 1 12 18.4a5.7 5.7 0 0 1-5.7-5.7c0-3.3 2.3-5.4 5.7-9.5z"/><path d="M12 18.4a2.8 2.8 0 0 0 2.8-2.8c0-1.7-1.2-2.7-2.8-4.8-1.6 2.1-2.8 3.1-2.8 4.8a2.8 2.8 0 0 0 2.8 2.8z"/>',
  };

  const GOOGLE_G = `<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
  </svg>`;

  const TRANSLATE_ICO = '<path d="M3.5 6.4h8.4M7.7 4.6v1.8M9.9 6.4c0 3.6-2.6 6.6-6.1 7.6"/><path d="M5.2 9.4c1.2 2.2 3 3.7 5.2 4.5"/><path d="M12.4 20.2 16.6 10l4.2 10.2M14 16.6h5.2"/>';

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty / non-JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
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
    drip: 'Drip campaigns', support: 'Support', ticket: 'Ticket', trending: 'Trending',
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
    const site = state.meta ? state.meta.siteName : 'HilaPanel';
    const baseRoute = route.split('/')[0];
    document.title = `${PAGE_TITLES[baseRoute] || 'Dashboard'} | ${site}`;
    document.getElementById('appTitle').textContent = `${PAGE_TITLES[baseRoute] || 'Dashboard'} | ${site}`;
    document.getElementById('appSub').textContent = location.host;

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
    if (state.user) links.push(['orders', 'Orders'], ['wallet', 'Wallet'], ['support', 'Support']);
    const kids = links.map(([r, label]) => h('a', { href: `#/${r}`, class: route === r ? 'active' : '' }, label));
    kids.push(state.user
      ? h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); closeMenu(); logout(); } }, 'Log out')
      : h('a', { href: '#/login', onclick: closeMenu }, 'Log in'));
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

  const setBalance = (cents) => {
    if (state.user) state.user.balance_cents = cents;
    renderChrome();
  };

  // ------------------------------------------------------------------ dashboard
  async function dashboardView() {
    stopTimer();
    const name = state.user ? String(state.user.email).split('@')[0] : null;
    const balanceSlot = h('div', null, h('div', { class: 'sk w55', style: 'height:30px' }));
    const pill = h('span', { class: 'refresh-pill' }, 'Refreshing…');
    const recentBox = h('div', null, skeletons());

    fill(view,
      h('h1', null, 'Dashboard'),
      h('p', { class: 'sub' }, name ? `Welcome back, ${name}. Here's your panel overview.` : 'Buy followers, likes and views — pay with M-Pesa.'),
      h('div', { class: 'row', style: 'gap:10px;margin-bottom:16px' },
        h('a', { class: 'btn', href: state.user ? '#/order' : '#/login' }, state.user ? 'New order' : 'Get started'),
        h('a', { class: 'btn ghost', href: '#/trending' }, 'What\'s trending')),
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-bottom:16px' }, pill),

      h('div', { class: 'card' },
        h('h2', null, 'Wallet balance'),
        balanceSlot,
        h('p', { class: 'muted', style: 'margin:10px 0 12px' }, 'Available to spend on orders.'),
        h('a', { class: 'btn ghost small', href: '#/wallet' }, 'Add funds →')),

      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'Orders'), h('a', { class: 'btn ghost small', href: '#/orders' }, 'View all')),
        recentBox));

    if (!state.user) {
      fill(balanceSlot, h('div', { class: 'v', style: 'font-size:2rem;font-weight:800' }, kes(0)));
      pill.textContent = 'Signed out';
      fill(recentBox, h('p', { class: 'muted' }, 'No orders yet.'));
      return;
    }

    try {
      const [{ user }, { orders }] = await Promise.all([api('/auth/me'), api('/orders')]);
      if (stale()) return;
      state.user = user;
      state.orders = orders;
      fill(balanceSlot, h('div', { style: 'font-size:2rem;font-weight:800;letter-spacing:-.02em' }, amt(user.balance_cents)));
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

  // ------------------------------------------------------------------ catalog
  const loadServices = (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return api(`/services${qs ? `?${qs}` : ''}`);
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
    const data = await api('/trending');
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
          style: `color:${p.color}`,
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
    h('span', {
      class: 'plat-ico',
      style: `color:${p.color};border-color:${p.color}55;background:${p.color}1f`,
    }, abbr(p.name)),
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
      tile({ key: 'trend', name: 'Trending', color: '#ff6b35', label: 'Hot right now' }, '#/trending'),
      state.favorites.size
        ? tile({ key: 'fav', name: 'Starred', color: '#f7b955', count: state.favorites.size }, '#/order?favorites=1')
        : null,
      data.platforms.map((p) => tile(p, `#/order?platform=${encodeURIComponent(p.key)}&sort=cheap`)),
      tile({ key: 'all', name: 'All services', color: '#3ee07b', count: data.pagination.total },
        '#/order?platform=all&sort=cheap'));

    loadTrending().then((trend) => {
      if (!trend || stale()) return;
      for (const p of trend.platforms) {
        const el = tiles.get(p.key);
        if (el && !el.querySelector('.plat-hot')) {
          el.prepend(h('span', { class: 'plat-hot', title: 'Trending on HilaPanel' }, svg(ICO.flame, 11)));
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
      ? { name: 'Starred services', color: '#f7b955', count: data.services.length }
      : data.platforms.find((p) => p.key === platform) || { name: 'All services', color: '#3ee07b', count: data.pagination.total };

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
        h('span', {
          class: 'plat-ico lg',
          style: `color:${plat.color};border-color:${plat.color}55;background:${plat.color}1f`,
        }, abbr(plat.name)),
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
    let service;
    try { service = (await api(`/services/${Number(params.service) || 0}`)).service; }
    catch (e) { return fill(view, pageHead('New order'), errBox(e.message)); }
    if (stale()) return;

    const back = params.platform ? `#/order?platform=${encodeURIComponent(params.platform)}&sort=cheap` : '#/order';
    const form   = h('div');
    const info   = h('div');
    const inputs = {};
    const def    = state.meta.fields;
    const totalEl = h('div', { class: 'v big' }, '—');
    const note   = h('div', { class: 'hint' });
    const btn    = h('button', { class: 'btn block' }, 'Place order');

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
      note, btn);

    btn.addEventListener('click', async () => {
      if (!state.user) { toast('Please log in to place an order.', true); location.hash = '#/login'; return; }
      const body = { service: service.id };
      for (const [k, el] of Object.entries(inputs)) body[k] = el.value.trim();
      btn.disabled = true;
      try {
        const res = await api('/orders', { method: 'POST', body });
        setBalance(res.balance_cents);
        toast(`Order #${res.order.id} placed.`);
        location.hash = '#/orders';
      } catch (e) { toast(e.message, true); btn.disabled = false; }
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

    fill(view,
      pageHead('Orders', 'View and manage your orders', h('a', { class: 'btn', href: '#/order' }, '+ New Order')),
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
    const summary = h('div', { style: 'font-size:1.5rem;font-weight:800' }, '—');
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
    const isLogin = mode === 'login';
    const email = h('input', { type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
    const password = h('input', { type: 'password', autocomplete: isLogin ? 'current-password' : 'new-password', placeholder: '••••••••' });
    const err = h('div', { class: 'errtext' }, AUTH_ERRORS[params.error] || '');
    const btn = h('button', { class: 'btn block' }, isLogin ? 'Log in' : 'Create account');

    const submit = async () => {
      err.textContent = '';
      btn.disabled = true;
      try {
        const { user } = await api(`/auth/${isLogin ? 'login' : 'register'}`, { method: 'POST', body: { email: email.value.trim(), password: password.value } });
        state.user = user;
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
        err, btn,
        h('p', { class: 'hint' }, isLogin ? 'No account yet? ' : 'Already registered? ',
          h('a', { href: isLogin ? '#/register' : '#/login' }, isLogin ? 'Create one' : 'Log in')),
        h('p', { class: 'hint' }, h('a', { href: '#/services' }, 'Browse prices without an account →')),
        state.meta && state.meta.googleEnabled
          ? null
          : h('p', { class: 'hint' }, 'Google sign-in appears once GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.')));
  }

  // ------------------------------------------------------------------ wallet
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

    btn.addEventListener('click', async () => {
      err.textContent = '';
      btn.disabled = true;
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
            if (topup.status === 'paid') walletView();
          } else if (n > 20) stopTimer();
        } catch { stopTimer(); }
      }, 3000);
    }

    fill(view,
      pageHead('Wallet', 'Top up with M-Pesa and pay for orders instantly.'),
      h('div', { class: 'card' },
        h('h2', null, 'Wallet balance'),
        h('div', { style: 'font-size:2rem;font-weight:800;letter-spacing:-.02em' }, amt(data.balance_cents)),
        h('p', { class: 'muted', style: 'margin:10px 0 0' }, 'Available to spend on orders.')),
      h('div', { class: 'card' },
        h('h2', null, 'Top up with M-Pesa'),
        state.meta.mpesaEnabled
          ? [h('label', null, 'M-Pesa phone number'), phone,
             h('label', null, 'Amount (KES)'), amount,
             h('div', { class: 'row', style: 'margin-top:12px' }, [100, 250, 500, 1000, 2500].map((v) => h('button', { class: 'btn ghost small', onclick: () => { amount.value = v; } }, `KSh ${v}`))),
             err, btn,
             h('p', { class: 'hint' }, 'You will receive an M-Pesa prompt. Your wallet is credited only after Safaricom confirms the payment.')]
          : h('p', { class: 'muted' }, 'Mobile money is not switched on yet. Top-ups will appear here as soon as the payment provider is connected.')),
      h('div', { class: 'card' },
        h('h2', null, 'Recent transactions'),
        data.transactions.length
          ? h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, data.transactions.map((t) => h('tr', null,
              h('td', null, fmtDate(t.created_at)), h('td', null, t.type),
              h('td', { class: 'num', style: t.amount_cents < 0 ? 'color:#ffb4b4' : 'color:#3ee07b' }, `${t.amount_cents > 0 ? '+' : ''}${amt(t.amount_cents)}`),
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

  async function supportView() {
    if (!requireLogin()) return;
    stopTimer();
    const listBox = h('div', null, skeletons(3));
    const subject = h('input', { type: 'text', maxlength: '120', placeholder: 'e.g. Order #1042 has not started' });
    const message = h('textarea', { placeholder: 'Include the order ID and the link you submitted.' });
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
      pageHead('Support', 'Open a ticket — replies appear here in the panel.'),
      h('div', { class: 'card' },
        h('h2', null, 'New ticket'),
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
          h('div', null, h('h1', { style: 'font-size:1.4rem' }, `#${t.id} ${t.subject}`), h('p', { class: 'sub' }, `Opened ${fmtDate(t.created_at)}`)),
          ticketBadge(t)));
      closeBtn.disabled = t.status !== 'open';
      fill(thread, data.messages.map((m) => h('div', {
        class: 'order-item',
        style: m.is_admin ? 'border-color:rgba(62,224,123,.35)' : '',
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
      case 'support': return supportView();
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
  document.addEventListener('click', (ev) => {
    if (popoverEl && !popoverEl.contains(ev.target)) closePopover();
    if (!menuEl().hidden && !menuEl().contains(ev.target) && ev.target.closest('#menuBtn') === null) closeMenu();
  });

  (async () => {
    try { state.meta = await api('/meta'); }
    catch {
      state.meta = {
        siteName: 'HilaPanel', mpesaEnabled: false, googleEnabled: false,
        minTopupKes: 50, maxTopupKes: 150000, kesPerUsd: 129, build: 'dev', fields: {},
      };
    }
    state.build = state.meta.build;
    try { const { user } = await api('/auth/me'); state.user = user; } catch { /* logged out */ }
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
