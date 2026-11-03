/**
 * A small fake Shopify storefront for testing Store Guard offline.
 * Mirrors Dawn-theme markup and Shopify's public endpoints.
 * Breakage switches (env MOCK_BREAK, comma separated): atc, search, checkout, noindex, links, jserror, password
 */
import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.MOCK_PORT || 4100);
const BREAK = new Set((process.env.MOCK_BREAK || '').split(',').filter(Boolean));
const carts = new Map();

const products = [
  { id: 1, title: 'Organic Cotton Kurta', handle: 'cotton-kurta', body_html: '<p>Soft breathable organic cotton kurta for everyday wear.</p>', images: [{ src: '/img/k.png' }], variants: [
    { id: 101, title: 'Small', price: '1499.00', available: true },
    { id: 102, title: 'Medium', price: '1499.00', available: true },
    { id: 103, title: 'Large', price: '1599.00', available: false } ] },
  { id: 2, title: 'Handwoven Silk Saree', handle: 'silk-saree', body_html: '<p>Traditional handwoven silk saree with zari border.</p>', images: [{ src: '/img/s.png' }], variants: [{ id: 201, title: 'Default Title', price: '8999.00', available: true }] },
  { id: 3, title: 'Brass Diya Set', handle: 'brass-diya', body_html: '', images: [], variants: [{ id: 301, title: 'Default Title', price: '0.00', available: true }] },
];
const byId = new Map(products.flatMap((p) => p.variants.map((v) => [v.id, { p, v }])));

function cartFor(req, res) {
  const m = /cart=([a-z0-9]+)/.exec(req.headers.cookie || '');
  let id = m && m[1];
  if (!id || !carts.has(id)) {
    id = Math.random().toString(36).slice(2, 12);
    carts.set(id, []);
    res.setHeader('Set-Cookie', `cart=${id}; Path=/`);
  }
  return carts.get(id);
}
function cartJson(items) {
  return {
    item_count: items.reduce((s, i) => s + i.quantity, 0),
    total_price: items.reduce((s, i) => s + i.quantity * Math.round(Number(i.price) * 100), 0),
    currency: 'INR',
    items,
  };
}
function layout(title, body, { noindex = false } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${BREAK.has('noindex') || noindex ? '<meta name="robots" content="noindex">' : ''}
<meta name="description" content="Handmade Indian clothing and decor from small artisans.">
<link rel="canonical" href="http://localhost:${PORT}/"><meta property="og:image" content="/img/og.png">
<script>window.Shopify={shop:'mock.myshopify.com'};</script>
${BREAK.has('jserror') ? '<script>setTimeout(function(){ undefinedAppFunction(); }, 10);</script>' : ''}
</head><body><header><a href="/">Mock Store</a> <nav><a href="/collections/all">Shop</a> <a href="/pages/about">About</a> <a href="/search">Search</a> ${BREAK.has('links') ? '<a href="/pages/old-sale">Sale</a> <a href="/collections/discontinued">Old</a>' : ''} <a href="/cart">Cart</a></nav></header>
<main id="MainContent">${body}</main><footer><a href="/policies/privacy-policy">Privacy</a> <a href="/policies/refund-policy">Refunds</a></footer></body></html>`;
}
function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function productCard(p) {
  return `<div class="card"><a href="/products/${p.handle}">${p.title}</a><span class="price">₹${p.variants[0].price}</span></div>`;
}
async function readBody(req) {
  let b = '';
  for await (const c of req) b += c;
  return b;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  if (BREAK.has('password') && !/unlocked=1/.test(req.headers.cookie || '') && !p.startsWith('/password')) {
    res.writeHead(302, { Location: '/password' });
    return res.end();
  }
  if (p === '/password') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (/password=letmein/.test(body)) {
        res.writeHead(302, { Location: '/', 'Set-Cookie': 'unlocked=1; Path=/' });
        return res.end();
      }
    }
    return send(res, 200, layout('Opening soon', '<form method="post" action="/password"><input type="password" name="password"><button>Enter</button></form>'));
  }
  if (p === '/products.json') return send(res, 200, { products }, 'application/json');
  if (p === '/collections.json') return send(res, 200, { collections: [{ title: 'Festive', handle: 'festive', products_count: 3 }] }, 'application/json');
  if (p === '/') return send(res, 200, layout('Mock Store – Handmade in India', `<h1>Handmade in India</h1><img src="/img/hero.png" width="800" height="400" alt="Artisans at work">${products.map(productCard).join('')}`));
  if (p.startsWith('/collections/')) {
    if (p === '/collections/discontinued') return send(res, 404, layout('Not found', '<h1>404</h1>'));
    return send(res, 200, layout('Festive collection', `<h1>Festive</h1>${products.map(productCard).join('')}`));
  }
  if (p === '/search') {
    const qq = (u.searchParams.get('q') || '').toLowerCase();
    const hits = BREAK.has('search') ? [] : products.filter((x) => x.title.toLowerCase().includes(qq));
    return send(res, 200, layout('Search', `<h1>Search</h1>${hits.map(productCard).join('') || '<p>No results</p>'}`));
  }
  if (p.startsWith('/products/')) {
    const prod = products.find((x) => x.handle === p.split('/')[2]);
    if (!prod) return send(res, 404, layout('Not found', '<h1>404</h1>'));
    const vid = Number(u.searchParams.get('variant')) || prod.variants[0].id;
    const v = prod.variants.find((x) => x.id === vid) || prod.variants[0];
    const breakAtc = BREAK.has('atc')
      ? `<script>document.addEventListener('submit',function(e){e.preventDefault();},true);</script>`
      : `<script>document.addEventListener('submit',function(e){var f=e.target;if(!f.action.includes('/cart/add'))return;e.preventDefault();fetch('/cart/add.js',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[{id:Number(f.id.value),quantity:1}]})}).then(function(){document.getElementById('cart-count').textContent='1';});});</script>`;
    return send(
      res,
      200,
      layout(
        `${prod.title} – Mock Store`,
        `<h1>${prod.title}</h1><div class="price">₹${v.price}</div>
<form method="post" action="/cart/add"><input type="hidden" name="id" value="${v.id}">
<select onchange="location.search='?variant='+this.value">${prod.variants.map((x) => `<option value="${x.id}" ${x.id === v.id ? 'selected' : ''}>${x.title}</option>`).join('')}</select>
<button type="submit" name="add" class="product-form__submit" ${v.available ? '' : 'disabled'}>${v.available ? 'Add to cart' : 'Sold out'}</button></form>
<span id="cart-count">0</span>${breakAtc}`
      )
    );
  }
  if (p === '/cart.js') return send(res, 200, cartJson(cartFor(req, res)), 'application/json');
  if (p === '/cart/add.js' && req.method === 'POST') {
    const items = cartFor(req, res);
    const body = JSON.parse((await readBody(req)) || '{}');
    for (const it of body.items || [{ id: body.id, quantity: body.quantity || 1 }]) {
      const hit = byId.get(Number(it.id));
      if (!hit || !hit.v.available) return send(res, 422, { status: 422, description: 'Sold out' }, 'application/json');
      items.push({ id: hit.v.id, title: hit.p.title, quantity: it.quantity || 1, price: hit.v.price, handle: hit.p.handle });
    }
    return send(res, 200, { items }, 'application/json');
  }
  if (p === '/cart/clear.js') {
    cartFor(req, res).length = 0;
    return send(res, 200, cartJson([]), 'application/json');
  }
  if (p === '/cart') {
    const items = cartFor(req, res);
    const btn = BREAK.has('checkout') ? '' : '<form action="/cart" method="post"><button type="submit" name="checkout">Check out</button></form>';
    if (req.method === 'POST') {
      res.writeHead(302, { Location: BREAK.has('checkout') ? '/cart' : '/checkouts/cn/abc123' });
      return res.end();
    }
    return send(res, 200, layout('Your cart', `<h1>Your cart</h1>${items.map((i) => `<a href="/products/${i.handle}">${i.title}</a> x${i.quantity}`).join('<br>')}${btn}`));
  }
  if (p === '/checkout') {
    res.writeHead(302, { Location: BREAK.has('checkout') ? '/cart' : '/checkouts/cn/abc123' });
    return res.end();
  }
  if (p.startsWith('/checkouts/')) return send(res, 200, layout('Checkout', '<h2>Contact</h2><input type="email" name="email" autocomplete="email"><h2>Delivery</h2>'));
  if (p.startsWith('/policies/')) {
    if (p.endsWith('terms-of-service') || p.endsWith('shipping-policy')) return send(res, 404, layout('Not found', '<h1>404</h1>'));
    return send(res, 200, layout('Policy', '<h1>Policy</h1>'));
  }
  if (p.startsWith('/img/')) {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    return send(res, 200, png, 'image/png');
  }
  if (p === '/pages/about') return send(res, 200, layout('About', '<h1>About us</h1>'));
  return send(res, 404, layout('Not found', '<h1>404</h1>'));
});

server.listen(PORT, () => console.log(`mock store on http://localhost:${PORT} break=[${[...BREAK]}]`));
export default server;
