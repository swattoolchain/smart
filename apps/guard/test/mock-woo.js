/**
 * A small fake WooCommerce store (WordPress + WooCommerce markup and the public Store API) for testing
 * the WooCommerce journey offline.
 * Breakage switches (env MOCK_BREAK, comma separated):
 *   atc       the Add to cart button does nothing (a script swallows the click)
 *   checkout  the checkout page is broken (no form, HTTP 500)
 *   search    search finds nothing
 *   storeapi  the Store API is blocked (security plugin), so shopping tests can't run
 *   soldout   the cart refuses every product (like a stock or purchasability problem)
 *   cartapi   a security plugin blocks the Store API cart (reads and writes), while the product form's
 *             Add to cart and the cart page's remove links still work
 * GET /__carts: how many items are in carts across every session (tests check nothing is left behind).
 * Extras (env MOCK_EXTRA): plain  only plain permalinks (Store API at /?rest_route=…)
 *   badcatalog  extra products with catalog mistakes (zero price, placeholder text, no image, fake discount, duplicate SKU)
 *   cap2        the Store API returns at most 2 products per page (X-WP-TotalPages is sent)
 *   sitemapgap  the product sitemap lists fewer products than the shop has
 * GET /__price/<slug>/<minor units>: change a product's price while the store runs.
 */
import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.MOCK_PORT || 4200);
const B = new Set((process.env.MOCK_BREAK || '').split(',').filter(Boolean));
const EX = process.env.MOCK_EXTRA || '';
const PLAIN = EX.includes('plain');
const BADCAT = EX.includes('badcatalog');
const CAP = EX.includes('cap2') ? 2 : 100;
const GAP = EX.includes('sitemapgap');
const sessions = new Map();
const NONCE = 'n0nce42';

const products = [
  { id: 11, name: 'Copper Water Bottle', slug: 'copper-bottle', type: 'simple', price: 149900, stock: true, cat: 'kitchen' },
  { id: 12, name: 'Linen Shirt', slug: 'linen-shirt', type: 'variable', price: 249900, stock: true, cat: 'clothing', variations: [{ id: 121, attributes: [{ name: 'Size', value: 'small' }] }, { id: 122, attributes: [{ name: 'Size', value: 'large' }] }] },
  { id: 13, name: 'Clay Water Pot', slug: 'clay-pot', type: 'simple', price: 59900, stock: false, cat: 'kitchen' },
];
if (BADCAT) products.push(
  { id: 21, name: 'Free Sample Pack', slug: 'free-sample', type: 'simple', price: 0, stock: true, cat: 'kitchen', desc: '<p>A sample pack to try our range at home.</p>' },
  { id: 22, name: 'Brass Lamp', slug: 'brass-lamp', type: 'simple', price: 349900, stock: true, cat: 'kitchen', desc: '<p>Lorem ipsum dolor sit amet, consectetur adipiscing.</p>' },
  { id: 23, name: 'Cane Basket', slug: 'cane-basket', type: 'simple', price: 89900, stock: true, cat: 'kitchen', noImage: true, desc: '<p>Woven by hand from cane, with a sturdy handle.</p>' },
  { id: 24, name: 'Wool Throw', slug: 'wool-throw', type: 'simple', price: 199900, regular: 199900, onSale: true, stock: true, cat: 'clothing', desc: '<p>A warm wool throw for cold evenings by the fire.</p>' },
  { id: 25, name: 'Silk Scarf', slug: 'silk-scarf', type: 'simple', price: 129900, stock: true, cat: 'clothing', sku: 'BOT-1', desc: '<p>A light silk scarf in deep colours, hand finished.</p>' },
);
const cats = [{ id: 1, name: 'Kitchen', slug: 'kitchen' }, { id: 2, name: 'Clothing', slug: 'clothing' }];
for (const p of products) { p.desc ??= '<p>Handmade and packed with care. Ships in two days from our workshop.</p>'; p.sku ??= `SKU-${p.id}`; }
products.find((p) => p.id === 11).sku = 'BOT-1';
const byId = new Map(products.flatMap((p) => [[p.id, p], ...(p.variations || []).map((v) => [v.id, p])]));
const money = (minor) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

function session(req, res) {
  const m = /woocommerce_session=([a-z0-9]+)/.exec(req.headers.cookie || '');
  let id = m && m[1];
  if (!id || !sessions.has(id)) {
    id = Math.random().toString(36).slice(2, 12);
    sessions.set(id, []);
    res.setHeader('Set-Cookie', `woocommerce_session=${id}; Path=/`);
  }
  return sessions.get(id);
}

function add(cart, id, qty = 1) {
  const p = byId.get(Number(id));
  if (!p || !p.stock || B.has('soldout')) return false;
  const line = cart.find((l) => l.id === Number(id));
  if (line) line.quantity += qty;
  else cart.push({ key: `k${id}`, id: Number(id), name: p.name, quantity: qty, price: p.price, permalink: `/product/${p.slug}/` });
  return true;
}

function apiProduct(p, origin) {
  return {
    id: p.id, name: p.name, slug: p.slug, type: p.type, permalink: `${origin}/product/${p.slug}/`,
    description: p.desc, short_description: '', sku: p.sku, on_sale: !!p.onSale, tags: [],
    prices: { price: String(p.price), regular_price: String(p.regular ?? p.price), sale_price: String(p.price), currency_code: 'INR', currency_minor_unit: 2 },
    is_in_stock: p.stock, is_purchasable: true, has_options: p.type === 'variable',
    variations: p.variations || [], categories: [{ slug: p.cat }], images: p.noImage ? [] : [{ src: `${origin}/img/${p.slug}.png` }],
  };
}

function cartJson(cart) {
  const total = cart.reduce((s, l) => s + l.price * l.quantity, 0);
  return { items: cart, items_count: cart.reduce((s, l) => s + l.quantity, 0), totals: { total_price: String(total), currency_code: 'INR', currency_minor_unit: 2 } };
}

function page(title, body, { origin } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} – Mock Woo Store</title><meta name="description" content="A handmade goods shop for testing.">
<link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css">
<style>body{font-family:sans-serif;margin:0}header,main,footer{padding:16px 24px}header{background:#7f54b3;color:#fff}header a{color:#fff;margin-right:12px}ul.products{display:flex;gap:16px;list-style:none;padding:0}li.product{border:1px solid #ddd;padding:12px}button,.button{background:#7f54b3;color:#fff;border:0;padding:10px 16px;text-decoration:none;display:inline-block}</style>
</head><body class="woocommerce">
<header><a href="/">Mock Woo Store</a><a href="/shop/">Shop</a><a href="/cart/">Cart</a>
<form role="search" action="/" style="display:inline"><input name="s" aria-label="Search"><input type="hidden" name="post_type" value="product"></form></header>
<main><h1>${title}</h1>${body}</main>
<footer><a href="/privacy-policy/">Privacy</a> <a href="/refund_returns/">Refunds</a></footer></body></html>`;
}

function grid(list) {
  return `<ul class="products">${list.map((p) => `<li class="product"><a class="woocommerce-LoopProduct-link" href="/product/${p.slug}/"><h2>${p.name}</h2><span class="price"><span class="woocommerce-Price-amount amount">${money(p.price)}</span></span></a></li>`).join('')}</ul>`;
}

function pdp(p, notice = '') {
  const options = p.type === 'variable'
    ? `<table class="variations"><tr><th><label for="size">Size</label></th><td><select id="size" name="attribute_size"><option value="">Choose an option</option>${p.variations.map((v) => `<option value="${v.attributes[0].value}">${v.attributes[0].value}</option>`).join('')}</select></td></tr></table>
       <input type="hidden" name="variation_id" value="">
       <script>
         const vs = ${JSON.stringify(p.variations.map((v) => ({ id: v.id, value: v.attributes[0].value })))};
         const sel = document.getElementById('size'), btn = document.querySelector('.single_add_to_cart_button');
         const sync = () => { const v = vs.find((x) => x.value === sel.value); document.querySelector('[name=variation_id]').value = v ? v.id : ''; btn.disabled = !v; };
         sel.addEventListener('change', sync); sync();
       </script>`
    : '';
  const breakAtc = B.has('atc') ? `<script>document.querySelector('form.cart').addEventListener('submit', (e) => e.preventDefault());</script>` : '';
  return page(p.name, `${notice}<p class="price"><span class="woocommerce-Price-amount amount">${money(p.price)}</span></p>
    <p>Handmade and packed with care. Ships in 2 days.</p>
    ${p.stock ? `<form class="cart${p.type === 'variable' ? ' variations_form' : ''}" method="post" action="/product/${p.slug}/">
      <input type="number" name="quantity" value="1" aria-label="Quantity">
      <button type="submit" name="add-to-cart" value="${p.id}" class="single_add_to_cart_button button alt">Add to cart</button>
      ${options}
    </form>${breakAtc}` : '<p class="stock out-of-stock">Out of stock</p>'}`);
}

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => resolve(b)); });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const origin = `http://${req.headers.host}`;
  const cart = session(req, res);
  const html = (code, body) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); };
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', Nonce: NONCE }); res.end(JSON.stringify(body)); };

  // Store API, at /wp-json/wc/store/v1/… (pretty links) or /?rest_route=/wc/store/v1/… (plain links)
  let route = null;
  if (u.pathname.startsWith('/wp-json/wc/store/v1') && !PLAIN) route = u.pathname.slice('/wp-json/wc/store/v1'.length) || '/';
  else if (u.pathname === '/' && (u.searchParams.get('rest_route') || '').startsWith('/wc/store/v1')) route = u.searchParams.get('rest_route').slice('/wc/store/v1'.length) || '/';
  else if (u.pathname.startsWith('/wp-json/')) return json(404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' });
  if (route !== null) {
    if (B.has('storeapi') || (B.has('cartapi') && route.startsWith('/cart'))) return json(403, { code: 'rest_forbidden', message: 'Sorry, you are not allowed to do that.' });
    if (route === '/products' && req.method === 'GET') {
      const per = Math.min(CAP, Number(u.searchParams.get('per_page') || 10));
      const pg = Number(u.searchParams.get('page') || 1);
      res.writeHead(200, { 'Content-Type': 'application/json', Nonce: NONCE, 'X-WP-Total': String(products.length), 'X-WP-TotalPages': String(Math.ceil(products.length / per)) });
      return res.end(JSON.stringify(products.slice((pg - 1) * per, pg * per).map((p) => apiProduct(p, origin))));
    }
    if (route === '/products/categories') return json(200, cats.map((c) => ({ ...c, permalink: `${origin}/product-category/${c.slug}/`, count: products.filter((p) => p.cat === c.slug).length })));
    if (route === '/cart' && req.method === 'GET') return json(200, cartJson(cart));
    if (req.method !== 'GET' && req.headers.nonce !== NONCE) return json(401, { code: 'woocommerce_rest_missing_nonce', message: 'Missing the Nonce header.' });
    if (route === '/cart/add-item' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      return add(cart, b.id, b.quantity || 1) ? json(201, cartJson(cart)) : json(400, { code: 'woocommerce_rest_product_out_of_stock', message: 'You cannot add &quot;that product&quot; to the cart because the product is out of stock.' });
    }
    if (route === '/cart/items' && req.method === 'DELETE') { cart.length = 0; return json(200, []); }
    return json(404, { code: 'rest_no_route', message: 'No route.' });
  }

  const setPrice = /^\/__price\/([a-z-]+)\/(\d+)$/.exec(u.pathname);
  if (setPrice) { const p = products.find((x) => x.slug === setPrice[1]); if (p) p.price = Number(setPrice[2]); return json(200, { ok: !!p }); }
  if (u.pathname === '/wp-sitemap.xml') { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(`<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin}/wp-sitemap-posts-product-1.xml</loc></sitemap><sitemap><loc>${origin}/wp-sitemap-taxonomies-product_cat-1.xml</loc></sitemap></sitemapindex>`); }
  if (u.pathname === '/wp-sitemap-posts-product-1.xml') { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(`<?xml version="1.0"?><urlset>${products.slice(0, GAP ? 3 : undefined).map((p) => `<url><loc>${origin}/product/${p.slug}/</loc></url>`).join('')}</urlset>`); }
  if (u.pathname === '/__carts') return json(200, { items: [...sessions.values()].reduce((s, c) => s + c.reduce((a, l) => a + l.quantity, 0), 0) });
  if (u.pathname.startsWith('/img/')) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'); }
  if (u.pathname === '/' && u.searchParams.has('s')) {
    const q = u.searchParams.get('s').toLowerCase();
    const hits = B.has('search') ? [] : products.filter((p) => p.name.toLowerCase().includes(q));
    if (hits.length === 1) { res.writeHead(302, { Location: `/product/${hits[0].slug}/` }); return res.end(); }
    return html(200, page(`Search results for “${q}”`, hits.length ? grid(hits) : '<p class="woocommerce-info">No products were found matching your selection.</p>'));
  }
  if (u.pathname === '/') return html(200, page('Welcome', `<p>Handmade goods from small workshops.</p>${grid(products)}<p><a class="button" href="/shop/">Shop now</a></p>`));
  if (u.pathname === '/shop/') return html(200, page('Shop', grid(products)));
  const cat = /^\/product-category\/([a-z-]+)\/$/.exec(u.pathname);
  if (cat) return html(200, page(cats.find((c) => c.slug === cat[1])?.name || 'Category', grid(products.filter((p) => p.cat === cat[1]))));
  const prod = /^\/product\/([a-z-]+)\/$/.exec(u.pathname);
  if (prod) {
    const p = products.find((x) => x.slug === prod[1]);
    if (!p) return html(404, page('Page not found', '<p>Nothing here.</p>'));
    if (req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const id = form.get('variation_id') || form.get('add-to-cart');
      const ok = add(cart, id, Number(form.get('quantity') || 1));
      return html(200, pdp(p, ok ? `<div class="woocommerce-message">“${p.name}” has been added to your cart. <a href="/cart/">View cart</a></div>` : '<ul class="woocommerce-error"><li>Sorry, this product cannot be purchased.</li></ul>'));
    }
    return html(200, pdp(p));
  }
  if (u.pathname === '/cart/') {
    // WooCommerce's remove link: /cart/?remove_item=<key>&_wpnonce=<nonce>, then back to the cart.
    if (u.searchParams.has('remove_item')) {
      if (u.searchParams.get('_wpnonce') === NONCE) { const i = cart.findIndex((l) => l.key === u.searchParams.get('remove_item')); if (i >= 0) cart.splice(i, 1); }
      res.writeHead(302, { Location: '/cart/' }); return res.end();
    }
    if (!cart.length) return html(200, page('Cart', '<p class="cart-empty woocommerce-info">Your cart is currently empty.</p>'));
    const total = cart.reduce((s, l) => s + l.price * l.quantity, 0);
    return html(200, page('Cart', `<form class="woocommerce-cart-form"><table class="shop_table cart">${cart.map((l) => `<tr class="cart_item"><td class="product-remove"><a href="${origin}/cart/?remove_item=${l.key}&amp;_wpnonce=${NONCE}" class="remove" aria-label="Remove this item">×</a></td><td class="product-name"><a href="${origin}${l.permalink}">${l.name}</a></td><td>${l.quantity}</td><td>${money(l.price * l.quantity)}</td></tr>`).join('')}</table></form>
      <div class="cart_totals"><p>Total <strong>${money(total)}</strong></p><div class="wc-proceed-to-checkout"><a href="/checkout/" class="checkout-button button alt">Proceed to checkout</a></div></div>`));
  }
  if (u.pathname === '/checkout/') {
    if (!cart.length) { res.writeHead(302, { Location: '/cart/' }); return res.end(); }
    if (B.has('checkout')) return html(500, page('There has been a critical error on this website.', '<p>Learn more about troubleshooting WordPress.</p>'));
    return html(200, page('Checkout', `<form class="checkout woocommerce-checkout"><p><label for="billing_email">Email address</label><input type="email" id="billing_email" name="billing_email" autocomplete="email"></p><p><label for="billing_first_name">First name</label><input id="billing_first_name"></p><button type="button">Place order</button></form>`));
  }
  if (['/privacy-policy/', '/refund_returns/'].includes(u.pathname)) return html(200, page('Policy', '<p>Our policy.</p>'));
  if (u.pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /wp-admin/\n'); }
  return html(404, page('Page not found', '<p>Nothing here.</p>'));
});

server.listen(PORT, () => console.log(`mock woo store on http://localhost:${PORT} break=[${[...B]}]`));
export default server;
