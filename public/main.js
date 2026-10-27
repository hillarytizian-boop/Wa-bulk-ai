/* SMM panel SPA (no build step). All texts - including provider-supplied service names and
   descriptions - are inserted with textContent / createTextNode, never innerHTML. */
(() => {
  'use strict';

  const state = { meta: null, user: null, services: null, timer: null, catalog: null };

  // ------------------------------------------------------------------ helpers
  const view = document.getElementById('view');

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
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
    try { data = await res.json(); } catch { /* empty / non-JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  function toast(msg, isError) {
    const t = h('div', { class: `toast${isError ? ' error' : ''}` }, msg);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), isError ? 6500 : 3500);
  }

  /** Integer KES cents -> "KSh 1,234.50" (mirrors src/money.js). */
  function kes(cents) {
    const n = Math.round(Number(cents) || 0);
    const neg = n < 0;
    const abs = Math.abs(n);
    const whole = Math.floor(abs / 100);
    const rem = abs % 100;
    return `${neg ? '-' : ''}KSh ${whole.toLocaleString('en-KE')}${rem ? `.${String(rem).padStart(2, '0')}` : ''}`;
  }

  const per1000 = (cents) => `${kes(cents)} / 1000`;
  const fmtDate = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const num = (n) => (n == null ? '-' : Number(n).toLocaleString());
  const badge = (s) => h('span', { class: `badge ${s}` }, String(s).replace(/_/g, ' '));

  const safeLink = (url, max = 36) =>
    /^https?:\/\//i.test(url)
      ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow' }, url.length > max ? `${url.slice(0, max)}…` : url)
      : h('span', null, url);

  const stopTimer = () => { if (state.timer) clearInterval(state.timer); state.timer = null; };
  const requireLogin = () => { if (state.user) return true; location.hash = '#/login'; return false; };

  // ------------------------------------------------------------------ chrome
  function renderChrome() {
    const route = currentRoute().name;
    document.title = state.meta ? state.meta.siteName : 'SMM Panel';
    document.getElementById('brand').textContent = state.meta ? state.meta.siteName : 'SMM Panel';
    document.getElementById('foot').textContent = `© ${new Date().getFullYear()} ${state.meta ? state.meta.siteName : ''} · Prices in Kenyan Shillings · Powered by M-Pesa`;

    const links = [['', 'New order'], ['services', 'Services']];
    if (state.user) links.push(['orders', 'My orders'], ['wallet', 'Wallet']);
    if (state.user && state.user.is_admin) links.push(['admin', 'Admin']);
    fill(document.getElementById('nav'), ...links.map(([r, label]) => h('a', { href: `#/${r}`, class: route === r ? 'active' : '' }, label)));

    fill(
      document.getElementById('right'),
      state.user
        ? [
            h('a', { class: 'chip', href: '#/wallet', title: 'Wallet balance' }, kes(state.user.balance_cents)),
            h('button', { class: 'btn ghost small', onclick: logout }, 'Log out'),
          ]
        : [h('a', { class: 'btn small', href: '#/login' }, 'Log in')]
    );
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    location.hash = '#/';
    route();
  }

  async function refreshUser() {
    const { user } = await api('/auth/me');
    state.user = user;
    renderChrome();
  }

  const setBalance = (cents) => {
    if (state.user) state.user.balance_cents = cents;
    renderChrome();
  };

  const pageHead = (title, sub) => [h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null];
  const errBox = (msg) => h('div', { class: 'card err' }, msg);

  // ------------------------------------------------------------------ catalog
  async function loadServices(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return api(`/services${qs ? `?${qs}` : ''}`);
  }

  async function servicesView(params = {}) {
    const page = Number(params.page) || 1;
    const q = params.q || '';
    const category = params.category || '';
    fill(view, ...pageHead('Services', 'Every price is in KES and includes the KSh 50 service fee.'), h('p', { class: 'muted' }, 'Loading…'));

    let data;
    try { data = await loadServices({ page, per_page: 20, q, category }); }
    catch (e) { return fill(view, ...pageHead('Services'), errBox(e.message)); }

    const search = h('input', { type: 'search', placeholder: 'Search services…', value: q, autocomplete: 'off' });
    const catSel = h('select', null,
      h('option', { value: '' }, 'All categories'),
      data.categories.map((c) => h('option', { value: c, selected: c === category }, c)));
    const go = () => (location.hash = `#/services?${new URLSearchParams({ q: search.value.trim(), category: catSel.value, page: 1 })}`);

    const rows = data.services.map((s) =>
      h('div', { class: 'svc' },
        h('div', { class: 'spread' },
          h('div', null,
            h('div', { class: 'name' }, s.name),
            h('div', { class: 'meta' }, `${s.category} · ${s.flat ? 'per order' : `min ${num(s.min)} – max ${num(s.max)}`}${s.refill ? ' · refill' : ''}${s.cancel ? ' · cancel' : ''}`)),
          h('div', { class: 'row' },
            h('span', { class: 'price' }, s.flat ? kes(s.rate_cents) : per1000(s.rate_cents)),
            h('a', { class: 'btn small', href: `#/?service=${s.id}` }, 'Order')))));

    const pager = h('div', { class: 'pagination' },
      h('button', { class: 'btn ghost small', disabled: data.pagination.page <= 1, onclick: () => (location.hash = `#/services?${new URLSearchParams({ q, category, page: page - 1 })}`) }, 'Previous'),
      h('span', { class: 'muted' }, `Page ${data.pagination.page} of ${data.pagination.pages} · ${data.pagination.total} services`),
      h('button', { class: 'btn ghost small', disabled: data.pagination.page >= data.pagination.pages, onclick: () => (location.hash = `#/services?${new URLSearchParams({ q, category, page: page + 1 })}`) }, 'Next'));

    fill(view,
      ...pageHead('Services', 'Every price is in KES and includes the KSh 50 service fee.'),
      h('div', { class: 'card' },
        h('div', { class: 'grid two' }, h('div', null, h('label', null, 'Search'), search), h('div', null, h('label', null, 'Category'), catSel)),
        h('button', { class: 'btn small', onclick: go, style: 'margin-top:12px' }, 'Apply')),
      h('div', { class: 'card' }, rows.length ? rows : h('p', { class: 'muted' }, 'No services match your search.'), pager));
  }

  // ------------------------------------------------------------------ order form
  async function orderView(params = {}) {
    stopTimer();
    fill(view, ...pageHead('New order', 'Pick a service, paste your link and pay from your wallet.'));
    let services;
    try { services = (await loadServices({ per_page: 200 })).services; }
    catch (e) { return fill(view, ...pageHead('New order'), errBox(e.message)); }

    const preId = Number(params.service) || null;
    const search = h('input', { type: 'search', placeholder: 'Search services…', autocomplete: 'off' });
    const svcSel = h('select', { 'aria-label': 'Service' });
    const formBox = h('div');
    const infoBox = h('div', { class: 'muted' }, 'Choose a service to see its details.');
    const hint = h('div', { class: 'hint' });

    fill(view,
      ...pageHead('New order', 'Pick a service, paste your link and pay from your wallet.'),
      h('div', { class: 'grid two' },
        h('div', { class: 'card' },
          h('h2', null, 'Order details'),
          h('label', null, 'Search'), search,
          h('label', null, 'Service'), svcSel, hint, formBox),
        h('div', { class: 'card' }, h('h2', null, 'Service info'), infoBox)));

    function renderOptions(selectedId) {
      const q = search.value.trim().toLowerCase();
      const list = services.filter((s) => !q || s.name.toLowerCase().includes(q) || String(s.id) === q);
      const shown = list.slice(0, 300);
      fill(svcSel,
        h('option', { value: '' }, list.length ? 'Select a service…' : 'No matching services'),
        shown.map((s) => h('option', { value: s.id }, `${s.name} — ${s.flat ? kes(s.rate_cents) : per1000(s.rate_cents)}`)));
      hint.textContent = list.length > shown.length ? `Showing ${shown.length} of ${list.length}. Refine your search.` : `${list.length} service(s)`;
      const target = selectedId || (preId && shown.some((s) => s.id === preId) ? preId : null);
      if (target) svcSel.value = String(target);
      if (target) showForm(services.find((s) => s.id === Number(target)));
    }

    function showForm(service) {
      if (!service) return;
      fill(formBox);
      const inputs = {};
      const def = state.meta.fields;
      const totalEl = h('div', { class: 'amt' }, '—');
      const quoteNote = h('div', { class: 'hint' });
      const btn = h('button', { class: 'btn block' }, `Place order · ${kes(0)}`);

      let lastQuote = 0;
      const qtyInput = () => inputs.quantity;

      function localTotal() {
        if (service.flat) return service.rate_cents;
        const q = Number(qtyInput() && qtyInput().value);
        if (!Number.isFinite(q) || q < 1) return 0;
        return Math.ceil((service.rate_cents * q) / 1000);
      }

      let timer = null;
      function refreshQuote() {
        const q = qtyInput() ? Number(qtyInput().value) : 0;
        const total = localTotal();
        totalEl.textContent = total ? kes(total) : '—';
        btn.textContent = `Place order${total ? ` · ${kes(total)}` : ''}`;
        btn.disabled = !total;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            const qs = new URLSearchParams({ service: service.id, quantity: q || 0 });
            const quote = await api(`/quote?${qs}`);
            lastQuote = quote.price_cents;
            if (quote.problem) { quoteNote.textContent = quote.problem; btn.disabled = true; }
            else { quoteNote.textContent = ''; totalEl.textContent = kes(quote.price_cents); btn.textContent = `Place order · ${kes(quote.price_cents)}`; btn.disabled = !quote.price_cents; }
          } catch { /* keep the local estimate */ }
        }, 250);
      }

      service.fields.forEach((field) => {
        const meta = def[field] || { label: field, multiline: false };
        if (field === 'quantity') {
          const qty = h('input', { type: 'number', inputmode: 'numeric', min: service.min || 1, max: service.max || undefined, value: service.min || 1 });
          inputs.quantity = qty;
          qty.addEventListener('input', refreshQuote);
          formBox.append(h('label', null, `Quantity (min ${num(service.min)}, max ${num(service.max)})`), qty);
          return;
        }
        const input = meta.multiline
          ? h('textarea', { placeholder: 'One per line' })
          : h('input', { type: field === 'link' || field === 'media' ? 'url' : 'text', autocomplete: 'off' });
        inputs[field] = input;
        formBox.append(h('label', null, meta.label), input);
      });

      formBox.append(h('div', { class: 'total' }, h('span', { class: 'muted' }, 'Total'), totalEl), quoteNote, btn);

      btn.addEventListener('click', async () => {
        if (!state.user) { toast('Please log in to place an order.', true); location.hash = '#/login'; return; }
        const body = { service: service.id };
        for (const [k, el] of Object.entries(inputs)) body[k] = el.value.trim();
        btn.disabled = true;
        try {
          const res = await api('/orders', { method: 'POST', body });
          setBalance(res.balance_cents);
          toast(`Order #${res.order.id} placed. Status: ${res.order.status}.`);
          location.hash = '#/orders';
        } catch (e) {
          toast(e.message, true);
          btn.disabled = false;
        }
      });

      if (qtyInput()) refreshQuote();
      else refreshQuote();

      fill(infoBox,
        h('div', { class: 'svc' },
          h('div', { class: 'name' }, service.name),
          h('div', { class: 'meta' }, `${service.category} · ${service.type}`),
          h('div', { class: 'price', style: 'margin-top:8px' }, service.flat ? `${kes(service.rate_cents)} per order` : `${kes(service.rate_cents)} per 1000`)),
        h('p', { class: 'hint' }, service.description || ''));
    }

    search.addEventListener('input', () => renderOptions());
    svcSel.addEventListener('change', () => showForm(services.find((s) => s.id === Number(svcSel.value))));
    renderOptions();
  }

  // ------------------------------------------------------------------ auth views
  function authView(mode) {
    const isLogin = mode === 'login';
    const email = h('input', { type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
    const password = h('input', { type: 'password', autocomplete: isLogin ? 'current-password' : 'new-password', placeholder: '••••••••' });
    const err = h('div', { class: 'errtext' });
    const btn = h('button', { class: 'btn block' }, isLogin ? 'Log in' : 'Create account');

    const submit = async () => {
      err.textContent = '';
      btn.disabled = true;
      try {
        const { user } = await api(`/auth/${isLogin ? 'login' : 'register'}`, { method: 'POST', body: { email: email.value.trim(), password: password.value } });
        state.user = user;
        renderChrome();
        toast(isLogin ? 'Welcome back!' : 'Account created.');
        location.hash = '#/';
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
      }
    };
    btn.addEventListener('click', submit);
    password.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    fill(view,
      ...pageHead(isLogin ? 'Log in' : 'Create an account', isLogin ? 'Access your wallet and orders.' : 'Pay with M-Pesa. Prices in KES.'),
      h('div', { class: 'card', style: 'max-width:440px' },
        h('label', null, 'Email'), email,
        h('label', null, 'Password'), password, err, btn,
        h('p', { class: 'hint' }, isLogin ? 'No account yet? ' : 'Already registered? ',
          h('a', { href: isLogin ? '#/register' : '#/login' }, isLogin ? 'Create one' : 'Log in'))));
  }

  // ------------------------------------------------------------------ orders
  async function ordersView() {
    if (!requireLogin()) return;
    stopTimer();
    fill(view, ...pageHead('My orders', 'Statuses update automatically.'), h('p', { class: 'muted' }, 'Loading…'));

    async function draw() {
      let data;
      try { data = await api('/orders'); } catch (e) { return fill(view, ...pageHead('My orders'), errBox(e.message)); }
      const rows = data.orders.map((o) =>
        h('tr', null,
          h('td', null, h('strong', null, `#${o.id}`), h('div', { class: 'meta' }, o.service_name), h('div', { class: 'meta' }, safeLink(o.link))),
          h('td', null, num(o.quantity)),
          h('td', { class: 'num' }, kes(o.price_cents), o.refunded_cents ? h('div', { class: 'meta' }, `refunded ${kes(o.refunded_cents)}`) : null),
          h('td', null, badge(o.status), o.remains != null ? h('div', { class: 'meta' }, `${num(o.remains)} remaining`) : null),
          h('td', null, h('div', { class: 'meta' }, fmtDate(o.created_at))),
          h('td', null, h('div', { class: 'row' },
            o.can_refill ? h('button', { class: 'btn ghost small', onclick: (ev) => act(ev, o.id, 'refill') }, 'Refill') : null,
            o.can_cancel ? h('button', { class: 'btn ghost small', onclick: (ev) => act(ev, o.id, 'cancel') }, 'Cancel') : null,
            o.status === 'submitting' ? h('button', { class: 'btn ghost small', onclick: (ev) => act(ev, o.id, 'refresh') }, 'Refresh') : null))));

      fill(view,
        ...pageHead('My orders', 'Statuses update automatically every 20 seconds.'),
        data.orders.length
          ? h('div', { class: 'card table-wrap' },
              h('table', null,
                h('thead', null, h('tr', null,
                  h('th', null, 'Order'), h('th', null, 'Qty'), h('th', { class: 'num' }, 'Price'),
                  h('th', null, 'Status'), h('th', null, 'Placed'), h('th', null, ''))),
                h('tbody', null, rows)))
          : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No orders yet.'), h('a', { class: 'btn', href: '#/' }, 'Place your first order')));
    }

    async function act(ev, id, kind) {
      ev.target.disabled = true;
      try {
        const res = await api(`/orders/${id}/${kind}`, { method: 'POST' });
        toast(res.message || 'Done.');
        await draw();
      } catch (e) { toast(e.message, true); ev.target.disabled = false; }
    }

    await draw();
    state.timer = setInterval(() => {
      if (currentRoute().name !== 'orders') return stopTimer();
      draw().catch(() => {});
    }, 20000);
  }

  // ------------------------------------------------------------------ wallet
  async function walletView() {
    if (!requireLogin()) return;
    stopTimer();
    fill(view, ...pageHead('Wallet', 'Top up with M-Pesa and pay for orders instantly.'));

    let data;
    try { data = await api('/wallet'); } catch (e) { return fill(view, ...pageHead('Wallet'), errBox(e.message)); }
    setBalance(data.balance_cents);

    const phone = h('input', { type: 'tel', placeholder: '0712 345 678', autocomplete: 'tel' });
    const amount = h('input', { type: 'number', min: state.meta.minTopupKes, max: state.meta.maxTopupKes, value: 500, inputmode: 'numeric' });
    const err = h('div', { class: 'errtext' });
    const orderBtn = h('button', { class: 'btn block' }, 'Send M-Pesa prompt');

    orderBtn.addEventListener('click', async () => {
      err.textContent = '';
      orderBtn.disabled = true;
      orderBtn.textContent = 'Sending prompt…';
      try {
        const res = await api('/wallet/topup', { method: 'POST', body: { phone: phone.value, amount_kes: Number(amount.value) } });
        toast(res.message || 'Check your phone.');
        watchTopup(res.topup_id);
      } catch (e) {
        err.textContent = e.message;
      } finally {
        orderBtn.disabled = false;
        orderBtn.textContent = 'Send M-Pesa prompt';
      }
    });

    let watcher = null;
    function watchTopup(id) {
      clearInterval(watcher);
      let tries = 0;
      watcher = setInterval(async () => {
        tries += 1;
        try {
          const { topup } = await api(`/wallet/topup/${id}`);
          if (topup.status !== 'pending') {
            clearInterval(watcher);
            toast(topup.status === 'paid' ? `Payment received: ${kes(topup.credited_cents)}` : 'Payment was not completed.', topup.status !== 'paid');
            if (topup.status === 'paid') walletView();
          } else if (tries > 20) clearInterval(watcher);
        } catch { clearInterval(watcher); }
      }, 3000);
      state.timer = watcher;
    }

    const txRows = data.transactions.map((t) =>
      h('tr', null,
        h('td', null, fmtDate(t.created_at)),
        h('td', null, t.type),
        h('td', { class: 'num', style: t.amount_cents < 0 ? 'color:#fca5a5' : 'color:#86efac' }, `${t.amount_cents > 0 ? '+' : ''}${kes(t.amount_cents)}`),
        h('td', null, t.note || '')));

    const topupRows = data.topups.map((t) =>
      h('tr', null, h('td', null, fmtDate(t.created_at)), h('td', { class: 'num' }, kes(t.credited_cents)), h('td', null, badge(t.status)), h('td', null, t.receipt || '—')));

    fill(view,
      ...pageHead('Wallet', 'Top up with M-Pesa and pay for orders instantly.'),
      h('div', { class: 'grid two' },
        h('div', { class: 'card' },
          h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Balance'), h('div', { class: 'v' }, kes(data.balance_cents))),
          h('h2', { style: 'margin-top:16px' }, 'Top up with M-Pesa'),
          state.meta.mpesaEnabled ? [
            h('label', null, 'M-Pesa phone number'), phone,
            h('label', null, 'Amount (KES)'), amount,
            h('div', { class: 'row', style: 'margin-top:10px' },
              [100, 250, 500, 1000, 2500].map((v) => h('button', { class: 'btn ghost small', onclick: () => { amount.value = v; } }, `KSh ${v}`))),
            err, orderBtn,
            h('p', { class: 'hint' }, 'You will receive an M-Pesa prompt. Your wallet is credited only after Safaricom confirms the payment.')]
          : h('p', { class: 'muted' }, 'M-Pesa is not configured yet. Ask the admin to credit your wallet.')),
        h('div', { class: 'card' },
          h('h2', null, 'Recent transactions'),
          data.transactions.length
            ? h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, txRows)))
            : h('p', { class: 'muted' }, 'No transactions yet.'))),
      data.topups.length
        ? h('div', { class: 'card' }, h('h2', null, 'M-Pesa top-ups'),
            h('div', { class: 'table-wrap' }, h('table', null,
              h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', { class: 'num' }, 'Amount'), h('th', null, 'Status'), h('th', null, 'Receipt'))),
              h('tbody', null, topupRows))))
        : null);
  }

  // ------------------------------------------------------------------ admin
  async function adminView() {
    if (!requireLogin()) return;
    if (!state.user.is_admin) return fill(view, ...pageHead('Admin'), errBox('Admin access required.'));
    stopTimer();
    fill(view, ...pageHead('Admin', 'Provider balance, revenue and profit in KES.'), h('p', { class: 'muted' }, 'Loading…'));

    let stats;
    try { stats = await api('/admin/stats'); } catch (e) { return fill(view, ...pageHead('Admin'), errBox(e.message)); }

    const markup = h('input', { type: 'number', step: '0.01', min: '0', value: stats.settings.markup });
    const rate = h('input', { type: 'number', step: '0.01', min: '0', value: stats.settings.kes_per_usd });
    const fee = h('input', { type: 'number', step: '1', min: '0', value: stats.settings.fee_kes });
    const settingsMsg = h('div', { class: 'hint' });
    const saveSettings = h('button', { class: 'btn block' }, 'Save settings');
    saveSettings.addEventListener('click', async () => {
      try {
        await api('/admin/settings', { method: 'POST', body: { markup: Number(markup.value), kes_per_usd: Number(rate.value), fee_kes: Number(fee.value) } });
        settingsMsg.textContent = 'Saved. New prices apply immediately.';
        toast('Settings saved');
      } catch (e) { settingsMsg.textContent = e.message; }
    });

    const provider = stats.provider_balance || {};
    const providerLine = provider.error
      ? `Unavailable: ${provider.error}`
      : `$${Number(provider.balance_usd || 0).toFixed(2)} · ${kes(provider.balance_cents || 0)}`;

    const overviewRows = [
      ['Customers', num(stats.users)],
      ['Customer wallet balances', kes(stats.customer_balances_cents)],
      ['Orders', num(stats.orders)],
      ['Pending M-Pesa payments', num(stats.pending_topups)],
      ['Needs review', num(stats.needs_review)],
    ].map(([k, v]) => h('tr', null, h('td', null, k), h('td', { class: 'num' }, v)));

    const overviewCard = h('div', { class: 'card' },
      h('h2', null, 'Overview'),
      h('table', null, h('tbody', null, overviewRows)));

    fill(view,
      ...pageHead('Admin', 'Provider balance, revenue and profit in KES.'),
      h('div', { class: 'grid stats' },
        h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Revenue'), h('div', { class: 'v' }, kes(stats.revenue_cents))),
        h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Provider cost'), h('div', { class: 'v' }, kes(stats.provider_cost_cents))),
        h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Profit'), h('div', { class: 'v' }, kes(stats.profit_cents))),
        h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Provider balance'), h('div', { class: 'v' }, providerLine))),
      h('div', { class: 'grid two' },
        h('div', { class: 'card' },
          h('h2', null, 'Pricing'),
          h('label', null, 'Markup (0.30 = +30%)'), markup,
          h('label', null, 'KES per USD'), rate,
          h('label', null, 'Fixed fee per price (KES)'), fee,
          saveSettings, settingsMsg,
          h('p', { class: 'hint' }, 'Customer price = provider rate × (1 + markup) × KES/USD + fee.')),
        overviewCard));

    // Needs review
    const reviewBox = h('div', { class: 'card' }, h('h2', null, 'Needs review'), h('p', { class: 'muted' }, 'Loading…'));
    const usersBox = h('div', { class: 'card' }, h('h2', null, 'Customers'), h('p', { class: 'muted' }, 'Loading…'));
    view.append(reviewBox, usersBox);

    try {
      const { orders: reviewOrders } = await api('/admin/orders?status=needs_review');
      const reviewRows = reviewOrders.map((o) => {
        const retry = h('button', { class: 'btn small' }, 'Retry');
        retry.addEventListener('click', (ev) => adminAction(ev, o.id, 'retry'));
        const refund = h('button', { class: 'btn danger small' }, 'Refund');
        refund.addEventListener('click', (ev) => adminAction(ev, o.id, 'refund'));
        return h('tr', null,
          h('td', null, `#${o.id}`, h('div', { class: 'meta' }, o.service_name)),
          h('td', null, o.email),
          h('td', { class: 'num' }, kes(o.price_cents)),
          h('td', null, o.error || ''),
          h('td', null, h('div', { class: 'row' }, retry, refund)));
      });
      fill(reviewBox,
        h('h2', null, 'Needs review'),
        h('p', { class: 'hint' }, 'Orders whose provider outcome is unknown. Retry reuses the same idempotency key; only refund after checking the provider dashboard.'),
        reviewOrders.length
          ? h('div', { class: 'table-wrap' }, h('table', null,
              h('thead', null, h('tr', null,
                h('th', null, 'Order'), h('th', null, 'Customer'), h('th', { class: 'num' }, 'Price'),
                h('th', null, 'Error'), h('th', null, ''))),
              h('tbody', null, reviewRows)))
          : h('p', { class: 'muted' }, 'Nothing waiting for review.'));
    } catch (e) { fill(reviewBox, h('h2', null, 'Needs review'), errBox(e.message)); }

    try {
      const { users } = await api('/admin/users');
      const userRows = users.map((u) => {
        const amt = h('input', { type: 'number', step: '1', placeholder: '+500 / -100' });
        const note = h('input', { type: 'text', placeholder: 'Reason' });
        const apply = h('button', { class: 'btn small' }, 'Apply');
        apply.addEventListener('click', async () => {
          apply.disabled = true;
          try {
            await api(`/admin/users/${u.id}/credit`, { method: 'POST', body: { amount_kes: Number(amt.value), note: note.value } });
            toast('Wallet adjusted');
            adminView();
          } catch (e) { toast(e.message, true); apply.disabled = false; }
        });
        return h('tr', null,
          h('td', null, u.email, u.is_admin ? h('span', { class: 'badge' }, 'admin') : null),
          h('td', { class: 'num' }, kes(u.balance_cents)),
          h('td', null, h('div', { class: 'row' }, amt, note, apply)));
      });
      fill(usersBox,
        h('h2', null, 'Customers'),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Email'), h('th', { class: 'num' }, 'Balance'), h('th', null, 'Adjust (KES)'))),
          h('tbody', null, userRows))));
    } catch (e) { fill(usersBox, h('h2', null, 'Customers'), errBox(e.message)); }

    async function adminAction(ev, id, kind) {
      ev.target.disabled = true;
      try {
        await api(`/admin/orders/${id}/${kind}`, { method: 'POST' });
        toast(kind === 'retry' ? 'Retry sent' : 'Refunded');
        adminView();
      } catch (e) { toast(e.message, true); ev.target.disabled = false; }
    }
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
    const { name, params } = currentRoute();
    renderChrome();
    window.scrollTo({ top: 0 });
    switch (name) {
      case '':
      case 'order':
        return orderView(params);
      case 'services':
        return servicesView(params);
      case 'login':
        return authView('login');
      case 'register':
        return authView('register');
      case 'orders':
        return ordersView();
      case 'wallet':
        return walletView();
      case 'admin':
        return adminView();
      default:
        return fill(view, ...pageHead('Not found'), h('p', { class: 'muted' }, 'That page does not exist. '), h('a', { class: 'btn', href: '#/' }, 'Go home'));
    }
  }

  window.addEventListener('hashchange', route);

  (async () => {
    try { state.meta = await api('/meta'); } catch { state.meta = { siteName: 'SMM Panel', mpesaEnabled: false, minTopupKes: 50, maxTopupKes: 150000, fields: {} }; }
    try { const { user } = await api('/auth/me'); state.user = user; } catch { /* logged out */ }
    renderChrome();
    route();
  })();
})();
