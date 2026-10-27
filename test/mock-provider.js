// A local stand-in for the smm.africa API v3 (+ a tiny M-Pesa Daraja stub) so you can develop and test
// without spending money. Run it with `npm run mock`, then point the storefront at it:
//   SMM_API_URL=http://localhost:4010/api/v3  SMM_API_KEY=test-key
//
// Magic values in the order "link" trigger edge cases (used by test/engine.test.js):
//   REJECT    -> provider rejects the order (400)
//   FLAKY     -> provider creates the order but answers 503 the first 3 times (lost response)
//   PARTIAL   -> order finishes as "partial" with 40% remaining
//   CANCELME  -> order becomes "canceled" once a cancel request has been made
const http = require('http');

const API_KEY = 'test-key';

const SERVICES = [
  { service: 1, name: 'Instagram Followers [Refill 30D]', type: 'Default', rate: '0.90', min: '50', max: '10000', category: 'Instagram Followers', description: 'High quality followers.\nStart: 0-30 mins', refill: true, cancel: true, drop_rate: 'Low', start_time: '2 mins', speed: '1k/day', reliability: 'Good' },
  { service: 2, name: 'YouTube SEO Package', type: 'Package', rate: '5.00', min: '1', max: '1', category: 'YouTube Packages', description: 'One-off package.', refill: false, cancel: false, drop_rate: '', start_time: '1 hour', speed: '', reliability: '' },
  { service: 3, name: 'Instagram Custom Comments', type: 'Custom Comments', rate: '2.00', min: '1', max: '100', category: 'Instagram Comments', description: 'One comment per line.', refill: false, cancel: false, drop_rate: '', start_time: '10 mins', speed: '', reliability: '' },
  { service: 4, name: 'TikTok Views', type: 'Default', rate: '0.05', min: '100', max: '1000000', category: 'TikTok Views', description: 'Fast views.', refill: false, cancel: false, drop_rate: '', start_time: 'Instant', speed: '100k/day', reliability: 'Good' },
];

function createMock() {
  const state = {
    orders: [], // provider-side orders
    byKey: new Map(), // idempotency key -> { order, hits }
    mpesaResult: {}, // CheckoutRequestID -> '0' | '1032' (absent = still pending)
    stkPushes: [],
    nextOrder: 1000000,
    nextCheckout: 1,
  };

  const json = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  function handleApi(req, res, p) {
    if (req.headers.authorization !== `Bearer ${API_KEY}`) return json(res, 400, { error: 'Invalid API key' });
    const idem = req.headers['idempotency-key'] || p.idempotency_key;

    switch (p.action) {
      case 'balance':
        return json(res, 200, { balance: '100.84', currency: 'USD' });
      case 'services':
        return json(res, 200, SERVICES);
      case 'add': {
        if (idem && state.byKey.has(idem)) {
          const entry = state.byKey.get(idem);
          entry.hits += 1;
          if (entry.flaky && entry.hits <= 3) return json(res, 503, { error: 'Temporary failure' });
          return json(res, 200, entry.response, { 'X-Idempotent-Replay': 'true' });
        }
        const svc = SERVICES.find((s) => s.service === Number(p.service));
        if (!svc) return json(res, 400, { error: 'Service not found' });
        if (String(p.link || '').includes('REJECT')) return json(res, 400, { error: 'Link is invalid' });

        let qty;
        if (svc.type === 'Custom Comments') {
          if (p.quantity !== undefined) return json(res, 400, { error: 'quantity must not be sent for this service type' });
          if (!p.comments) return json(res, 400, { error: 'comments required' });
          qty = String(p.comments).split('\n').length;
        } else if (svc.type === 'Package') {
          qty = 1;
        } else {
          qty = Number(p.quantity);
          if (!Number.isInteger(qty) || qty < Number(svc.min) || qty > Number(svc.max)) return json(res, 400, { error: 'Incorrect quantity' });
        }
        if (!p.link) return json(res, 400, { error: 'link required' });

        const rate = Number(svc.rate);
        const charged = svc.type === 'Package' ? rate : (rate * qty) / 1000;
        const order = { id: state.nextOrder++, service: svc.service, link: p.link, qty, charged, statusCalls: 0, canceled: false };
        state.orders.push(order);
        const response = { order: order.id, charged, queued: true };
        const flaky = String(p.link).includes('FLAKY');
        if (idem) state.byKey.set(idem, { response, hits: 1, flaky });
        if (flaky) return json(res, 503, { error: 'Temporary failure' }); // order WAS created, reply lost
        return json(res, 200, response);
      }
      case 'status': {
        const o = state.orders.find((x) => String(x.id) === String(p.order));
        if (!o) return json(res, 400, { error: 'Order not found' });
        o.statusCalls += 1;
        const base = { order: o.id, start_count: 100, remains: 0, charge: o.charged };
        if (o.link.includes('PARTIAL')) return json(res, 200, { ...base, status: 'partial', remains: Math.round(o.qty * 0.4), charge: o.charged * 0.6 });
        if (o.link.includes('CANCELME') && o.canceled) return json(res, 200, { ...base, status: 'canceled', remains: o.qty, charge: 0 });
        if (o.statusCalls === 1) return json(res, 200, { ...base, status: 'processing', remains: Math.round(o.qty / 2) });
        return json(res, 200, { ...base, status: 'completed' });
      }
      case 'refill': {
        const o = state.orders.find((x) => String(x.id) === String(p.order));
        if (!o) return json(res, 400, { error: 'Order not found' });
        return json(res, 200, { order: o.id, success: 'Refill request accepted.' });
      }
      case 'cancel': {
        const o = state.orders.find((x) => String(x.id) === String(p.order));
        if (!o) return json(res, 400, { error: 'Order not found' });
        o.canceled = true;
        return json(res, 200, { order: o.id, success: 'Cancellation request accepted.' });
      }
      default:
        return json(res, 400, { error: 'Unknown action' });
    }
  }

  function handleMpesa(req, res, url, p) {
    if (url.startsWith('/oauth/v1/generate')) return json(res, 200, { access_token: 'mock-token', expires_in: '3599' });
    if (!String(req.headers.authorization || '').startsWith('Bearer mock-token')) return json(res, 401, { error: 'bad token' });
    if (url === '/mpesa/stkpush/v1/processrequest') {
      const id = `ws_CO_${state.nextCheckout++}`;
      state.stkPushes.push({ id, ...p });
      return json(res, 200, { MerchantRequestID: `m_${id}`, CheckoutRequestID: id, ResponseCode: '0', ResponseDescription: 'Success', CustomerMessage: 'Success' });
    }
    if (url === '/mpesa/stkpushquery/v1/query') {
      const r = state.mpesaResult[p.CheckoutRequestID];
      if (r === undefined) return json(res, 500, { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' });
      return json(res, 200, { ResponseCode: '0', ResultCode: r, ResultDesc: r === '0' ? 'The service request is processed successfully.' : 'Request cancelled by user' });
    }
    return json(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      if (req.method === 'POST' && req.url === '/api/v3') return handleApi(req, res, body);
      return handleMpesa(req, res, req.url, body);
    });
  });

  return { server, state };
}

function start(port = 0) {
  const mock = createMock();
  return new Promise((resolve) => {
    mock.server.listen(port, '127.0.0.1', () => resolve({ ...mock, port: mock.server.address().port }));
  });
}

module.exports = { start, API_KEY, SERVICES };

if (require.main === module) {
  start(Number(process.env.MOCK_PORT) || 4010).then(({ port }) => {
    console.log(`Mock smm.africa API listening on http://localhost:${port}/api/v3  (API key: ${API_KEY})`);
  });
}
