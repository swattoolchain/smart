// A stand-in for Shopify's Admin API and Razorpay's API, for local end-to-end tests.
// Shopify:  POST /:shop/admin/oauth/access_token, POST /:shop/admin/api/:v/graphql.json
// Razorpay: POST /rzp/v1/orders, GET /rzp/v1/payments/:id
// Control:  POST /control {subscription, primaryDomain, payStatus, devStore, shopEmails: {email, contactEmail}, mainTheme, themeFiles, themeError}
//           themeFiles: { 'layout/theme.liquid': '<text>', 'assets/logo.png': null (binary) } for the live theme
import http from 'node:http';
import crypto from 'node:crypto';
const PORT = Number(process.env.FAKE_PORT || 4200);
const state = { subscription: null, primaryDomain: 'http://localhost:4100', orders: new Map(), payments: new Map(), tokenCalls: [], payStatus: 'captured', shopEmails: { email: 'owner@testshop.example', contactEmail: 'hello@testshop.example' },
  mainTheme: { id: 'gid://shopify/OnlineStoreTheme/111', name: 'Dawn' }, themeError: false,
  themeFiles: { 'layout/theme.liquid': '<!doctype html>\n<html>\n<head>\n{{ content_for_header }}\n</head>\n<body>\n{{ content_for_layout }}\n</body>\n</html>', 'sections/header.liquid': '<header>{{ shop.name }}</header>', 'assets/global.js': 'console.log(1);', 'config/settings_data.json': '{"current":{}}', 'assets/logo.png': null } };
const read = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const body = await read(req);
  if (u.pathname === '/control') { Object.assign(state, JSON.parse(body || '{}')); return json(res, 200, { ok: true, tokenCalls: state.tokenCalls }); }
  if (u.pathname === '/state') return json(res, 200, { tokenCalls: state.tokenCalls, orders: [...state.orders.values()] });
  let m;
  if ((m = /^\/([^/]+)\/admin\/oauth\/access_token$/.exec(u.pathname))) {
    const p = JSON.parse(body || '{}');
    state.tokenCalls.push({ shop: m[1], grant: p.grant_type, expiring: p.expiring });
    if (p.client_secret !== 'testsecret') return json(res, 401, { error: 'invalid_client' });
    return json(res, 200, { access_token: `shpat_${Math.random().toString(36).slice(2)}`, scope: 'read_themes,read_products,read_discounts', expires_in: 3600, refresh_token: `shprt_${Math.random().toString(36).slice(2)}`, refresh_token_expires_in: 7776000 });
  }
  if ((m = /^\/([^/]+)\/admin\/api\/[^/]+\/graphql\.json$/.exec(u.pathname))) {
    if (!/^shpat_/.test(req.headers['x-shopify-access-token'] || '')) return json(res, 401, { errors: 'Invalid API key or access token' });
    const qy = JSON.parse(body).query;
    if (qy.includes('shop {')) return json(res, 200, { data: { shop: { name: 'Test Shop', email: state.shopEmails.email, contactEmail: state.shopEmails.contactEmail, currencyCode: 'INR', myshopifyDomain: m[1], primaryDomain: { url: state.primaryDomain }, billingAddress: { countryCodeV2: 'DE' }, plan: { partnerDevelopment: !!state.devStore } } } });
    if (qy.includes('activeSubscriptions')) return json(res, 200, { data: { currentAppInstallation: { activeSubscriptions: state.subscription ? [state.subscription] : [] } } });
    // The live theme and its files (theme file fingerprints).
    if (/roles: \[MAIN\]|theme\(id:/.test(qy) && state.themeError) return json(res, 200, { errors: [{ message: 'Throttled' }] });
    if (qy.includes('roles: [MAIN]')) return json(res, 200, { data: { themes: { nodes: [{ ...state.mainTheme, updatedAt: new Date().toISOString() }] } } });
    if (qy.includes('theme(id:')) {
      const v = JSON.parse(body).variables || {};
      const all = Object.entries(state.themeFiles);
      const md5 = (c) => crypto.createHash('md5').update(c ?? '').digest('hex');
      if (qy.includes('filenames')) return json(res, 200, { data: { theme: { files: { nodes: all.filter(([n]) => (v.names || []).includes(n)).map(([n, c]) => ({ filename: n, size: (c ?? '').length, body: c == null ? { url: 'https://cdn.example/x' } : { content: c } })) } } } });
      // Pages of 2, to exercise paging.
      const start = v.after ? Number(v.after) : 0;
      const page = all.slice(start, start + 2);
      return json(res, 200, { data: { theme: { files: { nodes: page.map(([n, c]) => ({ filename: n, checksumMd5: md5(c ?? n), size: (c ?? n).length })), pageInfo: { hasNextPage: start + 2 < all.length, endCursor: String(start + 2) } } } } });
    }
    if (qy.includes('themes(')) return json(res, 200, { data: { themes: { nodes: [{ id: 'gid://shopify/OnlineStoreTheme/222', name: 'Dawn – Black Friday', role: 'UNPUBLISHED', updatedAt: new Date(Date.now() - 3600e3).toISOString() }] } } });
    if (qy.includes('codeDiscountNodes')) return json(res, 200, { data: { codeDiscountNodes: { nodes: [{ codeDiscount: { title: 'BF', codes: { nodes: [{ code: 'BF20' }] }, customerGets: { value: { percentage: 0.2 } } } }] } } });
    return json(res, 200, { data: {} });
  }
  if (u.pathname === '/rzp/v1/orders' && req.method === 'POST') {
    const p = JSON.parse(body); const id = `order_${Math.random().toString(36).slice(2, 12)}`;
    const o = { id, amount: p.amount, currency: p.currency, receipt: p.receipt, status: 'created' }; state.orders.set(id, o); return json(res, 200, o);
  }
  if ((m = /^\/rzp\/v1\/payments\/(.+)$/.exec(u.pathname))) {
    const p = state.payments.get(m[1]); return p ? json(res, 200, p) : json(res, 404, { error: { description: 'not found' } });
  }
  if (u.pathname === '/rzp/pay' && req.method === 'POST') {
    // Simulates the shopper paying an order in the Razorpay window.
    const { orderId, amount } = JSON.parse(body); const o = state.orders.get(orderId);
    const id = `pay_${Math.random().toString(36).slice(2, 12)}`;
    const p = { id, order_id: orderId, amount: amount ?? o.amount, currency: o.currency, status: state.payStatus }; state.payments.set(id, p); return json(res, 200, p);
  }
  json(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`fake services on ${PORT}`));
