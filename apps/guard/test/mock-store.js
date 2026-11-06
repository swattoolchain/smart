/**
 * A small fake Shopify storefront for testing Store Guard offline.
 * Mirrors Dawn-theme markup and Shopify's public endpoints.
 * Breakage switches (env MOCK_BREAK, comma separated): atc, search, checkout, noindex, links, jserror, password,
 *   pricedrift (cart charges ₹150 more than the product page), pricelow (cart charges ₹100 less, no discount),
 *   checkoutprice (checkout subtotal ₹200 more than the cart), protection (a shipping-protection app adds a
 *   paid ₹99 line to every cart, like Route or Navidium), noprice (the product page shows no readable price),
 *   with MOCK_EXTRA=markets: fx (the cart in euro markets charges €3 more than the page), fxcheckout (checkout
 *   shows rupees in other countries), fxround (converted prices are not rounded to .99), fxfar (the UK price is
 *   60% above the converted price), fxblock (the cart refuses the product in the United States)
 */
import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.MOCK_PORT || 4100);
const BREAK = new Set((process.env.MOCK_BREAK || '').split(',').filter(Boolean));
// A draft theme opened with ?preview_theme_id=… (Shopify keeps it for the session via a cookie).
const DRAFT_BREAK = new Set([...BREAK, ...(process.env.MOCK_DRAFT_BREAK ?? 'theme,atc').split(',').filter(Boolean)]);
let B = BREAK; // the breakages for the request being handled
let DRAFT = false;
const carts = new Map();
let PW_POSTS = 0; // how many times the password form was submitted

const EXTRA = (process.env.MOCK_EXTRA || '');
const DE = EXTRA.includes('de');
const TRACK = EXTRA.includes('track');
// MOCK_EXTRA=markets: Shopify Markets. The country picker (POST /localization) switches the shopper to the US
// (USD), Germany, Austria or France (EUR) or the UK (GBP); other countries stay on India (INR, the store's own).
// Converted prices are rounded up to .99, like Shopify's price rounding.
const MARKETS = EXTRA.split(',').includes('markets');
const FX = { IN: ['INR', 1], US: ['USD', 0.012], DE: ['EUR', 0.011], AT: ['EUR', 0.011], FR: ['EUR', 0.011], GB: ['GBP', 0.0095] };
let CC = 'IN'; // the shopper's country for the request being handled
const curOf = () => FX[CC][0];
function conv(inrMinor) {
  const [cur, rate] = FX[CC];
  if (cur === 'INR') return inrMinor;
  let raw = inrMinor * rate * (CC === 'GB' && B.has('fxfar') ? 1.6 : 1);
  return B.has('fxround') ? Math.round(raw) : Math.ceil(raw / 100) * 100 - 1;
}
const fmt = (minor, cur = curOf()) => (cur === 'INR' ? '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : new Intl.NumberFormat('en', { style: 'currency', currency: cur }).format(minor / 100));
const products = [
  { id: 1, title: 'Organic Cotton Kurta', handle: 'cotton-kurta', body_html: '<p>Soft breathable organic cotton kurta for everyday wear.</p>', product_type: 'Kurta', vendor: 'Tharam', tags: 'cotton, festive', images: [{ src: '/img/k.png' }], variants: [
    { id: 101, title: 'Small', sku: 'KUR-S', price: EXTRA.includes('price') ? '699.00' : '1499.00', compare_at_price: EXTRA.includes('sale') ? '1299.00' : null, available: true },
    { id: 102, title: 'Medium', sku: 'KUR-M', price: '1499.00', available: true },
    { id: 103, title: 'Large', sku: 'KUR-L', price: '1599.00', available: true } ] },
  { id: 2, title: 'Handwoven Silk Saree', handle: 'silk-saree', product_type: 'Saree', vendor: 'Tharam', tags: 'silk', body_html: EXTRA.includes('placeholder') ? '<p>Lorem ipsum dolor sit amet, TBD description here.</p>' : '<p>Traditional handwoven silk saree with zari border and intricate detailing.</p>', images: [{ src: '/img/s.png' }], variants: [{ id: 201, title: 'Default Title', sku: 'SAR-1', price: '8999.00', available: true }] },
  { id: 3, title: 'Brass Diya Set', handle: 'brass-diya', product_type: 'Decor', vendor: 'Tharam', tags: 'brass', body_html: '', images: [], variants: [{ id: 301, title: 'Default Title', sku: 'KUR-S', price: '0.00', available: true }] },
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
// Discount codes, like Shopify's: BF20 takes 20% off; MIN5000 needs a cart of ₹5,000 or more; anything else is unknown.
// MOCK_BREAK=discount makes BF20 stop working (e.g. it expired or a discount app broke it).
const CODES = { BF20: { pct: 20, min: 0 }, MIN5000: { pct: 10, min: 500000 } };
function cartJson(items) {
  // In another market the cart charges in that currency (fx: €3 more than the page in euro markets).
  const unitOf = (i) => { const u = conv(Math.round(Number(i.price) * 100)); return u + (B.has('fx') && curOf() === 'EUR' ? 300 : 0); };
  const original = items.reduce((s, i) => s + i.quantity * unitOf(i), 0);
  const code = items.discount;
  const rule = code && !(B.has('discount') && code === 'BF20') ? CODES[code] : null;
  const applicable = !!rule && original >= rule.min;
  const off = applicable ? Math.round((original * rule.pct) / 100) : 0;
  return {
    item_count: items.reduce((s, i) => s + i.quantity, 0),
    original_total_price: original,
    total_discount: off,
    total_price: original - off,
    discount_codes: code ? [{ code, applicable }] : [],
    cart_level_discount_applications: off ? [{ type: 'discount_code', title: code, total_allocated_amount: off }] : [],
    items_subtotal_price: original,
    currency: curOf(),
    // Like Shopify's cart.js: prices in paise, one entry per line.
    items: items.map((i) => { const unit = unitOf(i); return { ...i, variant_id: i.id, price: unit, original_price: unit, final_price: unit, line_price: unit * i.quantity, original_line_price: unit * i.quantity, final_line_price: unit * i.quantity }; }),
  };
}
function layout(title, body, { noindex = false } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${B.has('noindex') || noindex ? '<meta name="robots" content="noindex">' : ''}
<meta name="description" content="Handmade Indian clothing and decor from small artisans.">
<link rel="canonical" href="http://localhost:${PORT}/"><meta property="og:image" content="/img/og.png">
<script>window.Shopify={shop:'mock.myshopify.com',${MARKETS ? `country:'${CC}',currency:{active:'${curOf()}',rate:'${FX[CC][1]}'},` : ''}theme:${DRAFT ? "{id:222,name:'Dawn – Diwali draft',role:'unpublished'}" : "{id:111,name:'Dawn',role:'main'}"}};</script>
${B.has('jserror') ? '<script>setTimeout(function(){ undefinedAppFunction(); }, 10);</script>' : ''}
${B.has('theme') ? '<style>body{background:#fff4d6} h1{color:#b3261e;font-size:48px}</style>' : ''}</head><body>${B.has('theme') ? '<div style="background:#b3261e;color:#fff;padding:18px;font:700 22px sans-serif">DIWALI SALE · 40% OFF</div>' : ''}<header><a href="/">Mock Store</a> <nav><a href="/collections/all">Shop</a> <a href="/pages/about">About</a> <a href="/search">Search</a> ${B.has('links') ? '<a href="/pages/old-sale">Sale</a> <a href="/collections/discontinued">Old</a>' : ''} <a href="/cart">Cart</a></nav></header>
<main id="MainContent">${body}</main>${DRAFT ? '<iframe id="preview-bar-iframe" style="position:fixed;bottom:0;left:0;width:100%;height:60px;border:0;background:#222"></iframe>' : ''}<footer><a href="/policies/privacy-policy">${DE ? 'Datenschutz' : 'Privacy'}</a> <a href="/policies/refund-policy">${DE ? 'Widerrufsbelehrung' : 'Refunds'}</a>${DE ? ' <a href="/pages/impressum">Impressum</a> <a href="/policies/terms-of-service">AGB</a> <a href="/pages/accessibility">Barrierefreiheit</a> <a href="https://ec.europa.eu/consumers/odr">OS-Plattform</a> <a class="withdraw" href="/pages/widerruf" style="font-weight:700">Vertrag widerrufen</a>' : ''}</footer>${TRACK ? '<script src="https://connect.facebook.net/en_US/fbevents.js" async></script>' : ''}</body></html>`;
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
  const previewId = u.searchParams.get('preview_theme_id');
  if (previewId) res.setHeader('Set-Cookie', `preview_theme=${previewId}; Path=/`);
  DRAFT = !!previewId || /preview_theme=\d+/.test(req.headers.cookie || '');
  CC = (MARKETS && /localization=([A-Z]{2})/.exec(req.headers.cookie || '')?.[1]) || 'IN';
  if (MARKETS && p === '/localization' && req.method === 'POST') {
    const f = new URLSearchParams(await readBody(req));
    const cc = String(f.get('country_code') || '').toUpperCase();
    // Countries without a market stay on the store's own (like Shopify, which falls back to the primary market).
    res.writeHead(302, { Location: f.get('return_to') || '/', ...(FX[cc] ? { 'Set-Cookie': `localization=${cc}; Path=/` } : {}) });
    return res.end();
  }
  B = DRAFT ? DRAFT_BREAK : BREAK;
  if (B.has('cloudflare')) {
    res.writeHead(403, { 'Content-Type': 'text/html', 'cf-ray': '8f00test-BOM', server: 'cloudflare' });
    return res.end('<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-form">Verify you are human</div><script>window._cf_chl_opt={}</script></body></html>');
  }
  if (p === '/__pwcount') return send(res, 200, { posts: PW_POSTS }, 'application/json');
  if (B.has('password') && !/storefront_digest=ok/.test(req.headers.cookie || '') && !p.startsWith('/password')) {
    res.writeHead(302, { Location: '/password' });
    return res.end();
  }
  if (p === '/password') {
    if (req.method === 'POST') {
      PW_POSTS++;
      const body = await readBody(req);
      if (/password=letmein/.test(body)) {
        res.writeHead(302, { Location: '/', 'Set-Cookie': 'storefront_digest=ok; Path=/; HttpOnly' });
        return res.end();
      }
    }
    return send(res, 200, layout('Opening soon', '<form method="post" action="/password"><input type="password" name="password"><button>Enter</button></form>'));
  }
  if (p === '/sitemap.xml') return send(res, 200, '<?xml version="1.0"?><urlset><sitemap><loc>http://localhost:'+PORT+'/sitemap_products_1.xml</loc></sitemap></urlset>', 'application/xml');
  if (p === '/sitemap_products_1.xml') return send(res, 200, '<?xml version="1.0"?><urlset>'+products.map(x=>'<url><loc>http://localhost:'+PORT+'/products/'+x.handle+'</loc></url>').join('')+'</urlset>', 'application/xml');
  if (p.startsWith('/collections/') && p.endsWith('/products.json')) return send(res, 200, { products: products.slice(0,2) }, 'application/json');
  if (p === '/products.json') return send(res, 200, { products }, 'application/json');
  if (p === '/collections.json') return send(res, 200, { collections: [{ title: 'Festive', handle: 'festive', products_count: 3 }] }, 'application/json');
  if (p === '/') return send(res, 200, layout('Mock Store – Handmade in India', `<h1>Handmade in India</h1><img src="/img/hero.png" width="800" height="400" alt="Artisans at work">${products.map(productCard).join('')}`));
  if (p.startsWith('/collections/')) {
    if (p === '/collections/discontinued') return send(res, 404, layout('Not found', '<h1>404</h1>'));
    return send(res, 200, layout('Festive collection', `<h1>Festive</h1>${products.map(productCard).join('')}`));
  }
  if (p === '/search') {
    const qq = (u.searchParams.get('q') || '').toLowerCase();
    const hits = B.has('search') ? [] : products.filter((x) => x.title.toLowerCase().includes(qq));
    return send(res, 200, layout('Search', `<h1>Search</h1>${hits.map(productCard).join('') || '<p>No results</p>'}`));
  }
  // Shopify's product JSON (prices in cents), used by themes and by our checks.
  { const m = /^\/products\/([\w-]+)\.js$/.exec(p); if (m) { const pr = products.find((x) => x.handle === m[1]); if (!pr) return send(res, 404, { status: 404 }, 'application/json');
    return send(res, 200, { id: pr.id, title: pr.title, handle: pr.handle, variants: pr.variants.map((v) => ({ id: v.id, title: v.title, available: v.available, price: conv(Math.round(Number(v.price) * 100)) })) }, 'application/json'); } }
  if (p.startsWith('/products/')) {
    const prod = products.find((x) => x.handle === p.split('/')[2]);
    if (!prod) return send(res, 404, layout('Not found', '<h1>404</h1>'));
    const vid = Number(u.searchParams.get('variant')) || prod.variants[0].id;
    const v = prod.variants.find((x) => x.id === vid) || prod.variants[0];
    const breakAtc = B.has('atc')
      ? `<script>document.addEventListener('submit',function(e){e.preventDefault();},true);</script>`
      : `<script>document.addEventListener('submit',function(e){var f=e.target;if(!f.action.includes('/cart/add'))return;e.preventDefault();fetch('/cart/add.js',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[{id:Number(f.id.value),quantity:1}]})}).then(function(){document.getElementById('cart-count').textContent='1';});});</script>`;
    return send(
      res,
      200,
      layout(
        `${prod.title} – Mock Store`,
        `<h1>${prod.title}</h1>${B.has('noprice') ? '' : `<div class="price">${MARKETS && CC !== 'IN' ? fmt(conv(Math.round(Number(v.price) * 100))) : `₹${v.price}`}</div>`}
<form method="post" action="/cart/add"><input type="hidden" name="id" value="${v.id}">
<select onchange="location.search='?variant='+this.value">${prod.variants.map((x) => `<option value="${x.id}" ${x.id === v.id ? 'selected' : ''}>${x.title}</option>`).join('')}</select>
<button type="submit" name="add" class="product-form__submit" ${v.available ? '' : 'disabled'}>${v.available ? 'Add to cart' : 'Sold out'}</button></form>${DE ? '<p class="tax-note">inkl. MwSt., zzgl. <a href="/policies/shipping-policy">Versandkosten</a></p>' : ''}
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
      if (!hit || !hit.v.available || (MARKETS && CC === 'US' && B.has('fxblock'))) return send(res, 422, { status: 422, description: 'Sold out' }, 'application/json');
      // pricedrift / pricelow: an app or cart script changes the price after the shopper saw it.
      const price = (Number(hit.v.price) + (B.has('pricedrift') ? 150 : B.has('pricelow') ? -100 : 0)).toFixed(2);
      items.push({ id: hit.v.id, title: hit.p.title, quantity: it.quantity || 1, price, handle: hit.p.handle });
    }
    // protection: an app adds its own paid line to every cart, once.
    if (B.has('protection') && !items.some((i) => i.id === 901)) items.push({ id: 901, title: 'Shipping protection', quantity: 1, price: '99.00', handle: 'shipping-protection' });
    return send(res, 200, { items }, 'application/json');
  }
  if (p === '/cart/update.js' && req.method === 'POST') {
    const items = cartFor(req, res);
    const body = JSON.parse((await readBody(req)) || '{}');
    if (body.discount !== undefined) items.discount = String(body.discount || '').toUpperCase() || undefined;
    return send(res, 200, cartJson(items), 'application/json');
  }
  if (p.startsWith('/discount/')) {
    cartFor(req, res).discount = decodeURIComponent(p.slice(10)).toUpperCase();
    res.writeHead(302, { Location: u.searchParams.get('redirect') || '/' });
    return res.end();
  }
  if (p === '/cart/clear.js') {
    cartFor(req, res).length = 0;
    delete cartFor(req, res).discount;
    return send(res, 200, cartJson([]), 'application/json');
  }
  if (p === '/cart') {
    const items = cartFor(req, res);
    const btn = B.has('checkout') ? '' : '<form action="/cart" method="post"><button type="submit" name="checkout">Check out</button></form>';
    if (req.method === 'POST') {
      res.writeHead(302, { Location: B.has('checkout') ? '/cart' : '/checkouts/cn/abc123' });
      return res.end();
    }
    return send(res, 200, layout('Your cart', `<h1>Your cart</h1>${items.map((i) => `<a href="/products/${i.handle}">${i.title}</a> x${i.quantity}`).join('<br>')}${btn}`));
  }
  if (p === '/checkout') {
    res.writeHead(302, { Location: B.has('checkout') ? '/cart' : '/checkouts/cn/abc123' });
    return res.end();
  }
  if (p.startsWith('/checkouts/')) {
    // Order summary like Shopify's checkout: lines and a subtotal, before any payment details.
    const c = cartJson(cartFor(req, res));
    const sub = c.items_subtotal_price + (B.has('checkoutprice') ? 20000 : 0);
    const inr = (m) => (B.has('fxcheckout') ? '₹' + (m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : fmt(m));
    return send(res, 200, layout('Checkout', `<h2>Contact</h2><input type="email" name="email" autocomplete="email"><h2>Delivery</h2>
<aside class="order-summary"><h2>Order summary</h2>${c.items.map((i) => `<div class="line"><span>${i.title} × ${i.quantity}</span> <span>${inr(i.final_line_price)}</span></div>`).join('')}
<div class="row"><span>Subtotal · ${c.item_count} ${c.item_count === 1 ? 'item' : 'items'}</span> <span>${inr(sub)}</span></div><div class="row"><span>Shipping</span> <span>Enter shipping address</span></div></aside>`));
  }
  if (p.startsWith('/policies/')) {
    if (!DE && (p.endsWith('terms-of-service') || p.endsWith('shipping-policy'))) return send(res, 404, layout('Not found', '<h1>404</h1>'));
    if (DE && p.endsWith('refund-policy')) return send(res, 200, layout('Widerrufsbelehrung', '<h1>Widerrufsbelehrung</h1><p>Sie haben das Recht, binnen 14 Tagen ohne Angabe von Gründen diesen Vertrag zu widerrufen.</p>'));
    return send(res, 200, layout('Policy', '<h1>Policy</h1>'));
  }
  if (p.startsWith('/img/')) {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    return send(res, 200, png, 'image/png');
  }
  if (DE && p === '/pages/impressum') return send(res, 200, layout('Impressum', '<h1>Impressum</h1><p>Kaveri Handlooms GmbH, Hauptstraße 1, 10115 Berlin. E-Mail: hallo@kaveri.example</p>'));
  if (p === '/pages/about') return send(res, 200, layout('About', '<h1>About us</h1>'));
  return send(res, 404, layout('Not found', '<h1>404</h1>'));
});

server.listen(PORT, () => console.log(`mock store on http://localhost:${PORT} break=[${[...BREAK]}]`));
export default server;
