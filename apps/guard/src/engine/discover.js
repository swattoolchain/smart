/**
 * Store discovery: learns what to test from the store's public Shopify endpoints
 * (products.json, collections.json) so merchants don't have to configure anything.
 */
import { wooToRaw } from './products.js';

function pickProducts(products) {
  const withStock = products
    .map((p) => ({
      ...p,
      available: (p.variants || []).filter((v) => v.available !== false),
    }))
    .filter((p) => p.available.length > 0);
  // Prefer one product with several in-stock variants (exercises variant logic) plus simple ones.
  const multi = withStock.find((p) => p.available.length >= 2);
  const picks = [];
  if (multi) picks.push(multi);
  for (const p of withStock) {
    if (picks.length >= 3) break;
    if (!picks.includes(p)) picks.push(p);
  }
  return picks.map((p) => ({
    id: p.id,
    title: p.title,
    handle: p.handle,
    variants: p.available.map((v) => ({ id: v.id, title: v.title, price: v.price })),
    allVariants: (p.variants || []).length,
  }));
}

function dataQuality(products) {
  const issues = [];
  let zeroPrice = 0,
    noImage = 0,
    noDescription = 0,
    soldOut = 0;
  for (const p of products) {
    const variants = p.variants || [];
    if (variants.length && variants.every((v) => Number(v.price) === 0)) zeroPrice++;
    if (!p.images || p.images.length === 0) noImage++;
    if (!p.body_html || String(p.body_html).replace(/<[^>]*>/g, '').trim().length < 20) noDescription++;
    if (variants.length && variants.every((v) => v.available === false)) soldOut++;
  }
  return { sampled: products.length, zeroPrice, noImage, noDescription, soldOut, issues };
}

const PLATFORMS = [
  ['shopify', 'Shopify', /cdn\.shopify\.com|window\.Shopify|Shopify\.theme|myshopify\.com/i],
  ['woocommerce', 'WooCommerce', /woocommerce|wc-ajax|wp-content\/plugins\/woocommerce/i],
  ['magento', 'Magento / Adobe Commerce', /Magento_|mage\/cookies|\/static\/version\d+\/frontend/i],
  ['bigcommerce', 'BigCommerce', /cdn\d+\.bigcommerce\.com|BCData/i],
  ['wix', 'Wix', /static\.wixstatic\.com|wix-bolt/i],
  ['squarespace', 'Squarespace', /static1\.squarespace\.com|Static\.SQUARESPACE_CONTEXT/i],
  ['salesforce', 'Salesforce Commerce Cloud', /demandware\.static|dwanalytics/i],
  ['prestashop', 'PrestaShop', /prestashop/i],
  ['opencart', 'OpenCart', /catalog\/view\/theme|route=product/i],
];

export async function detectPlatform(request, origin) {
  try {
    const res = await request.get(origin + '/', { timeout: 20000 });
    const html = (await res.text()).slice(0, 400000);
    for (const [key, label, re] of PLATFORMS) if (re.test(html)) return { key, label };
  } catch {
    /* fall through */
  }
  return { key: 'custom', label: 'Custom or headless store' };
}

export async function discover(request, origin, { testProduct = null } = {}) {
  const out = {
    origin,
    platform: await detectPlatform(request, origin),
    isShopify: false,
    isWoo: false,
    woo: null,
    products: [],
    catalog: [],
    sampleSize: 0,
    collections: [],
    quality: null,
    notes: [],
  };

  try {
    const res = await request.get(`${origin}/products.json?limit=50`, { timeout: 20000 });
    if (res.ok()) {
      const json = await res.json().catch(() => null);
      if (json && Array.isArray(json.products)) {
        out.isShopify = true;
        out.sampleSize = json.products.length;
        out.products = pickProducts(json.products);
        out.catalog = json.products
          .filter((p) => (p.variants || []).some((v) => v.available !== false))
          .slice(0, 50)
          .map((p) => ({ title: p.title, handle: p.handle, variants: (p.variants || []).length }));
        out.quality = dataQuality(json.products);
      }
    } else {
      out.notes.push(`products.json returned HTTP ${res.status()}`);
    }
  } catch (e) {
    out.notes.push(`products.json failed: ${e.message}`);
  }

  try {
    const res = await request.get(`${origin}/collections.json?limit=10`, { timeout: 15000 });
    if (res.ok()) {
      const json = await res.json().catch(() => null);
      if (json && Array.isArray(json.collections)) {
        out.isShopify = true;
        out.collections = json.collections
          .filter((c) => c.products_count === undefined || c.products_count > 0)
          .slice(0, 3)
          .map((c) => ({ title: c.title, handle: c.handle }));
      }
    }
  } catch {
    /* collections are optional */
  }

  if (!out.isShopify) {
    try {
      const res = await request.get(`${origin}/cart.js`, { timeout: 15000 });
      const ct = res.headers()['content-type'] || '';
      if (res.ok() && ct.includes('json')) out.isShopify = true;
    } catch {
      /* ignore */
    }
  }
  if (out.isShopify) out.platform = { key: 'shopify', label: 'Shopify' };
  // WooCommerce: everything the journey needs comes from the store's public Store API (no keys, no plugin).
  if (!out.isShopify && (out.platform.key === 'woocommerce' || out.platform.key === 'custom')) await discoverWoo(request, origin, out, { testProduct });
  // A merchant-chosen test product goes first (fetched directly if it wasn't in the first page of products).
  if (out.isShopify && testProduct) {
    const idx = out.products.findIndex((p) => p.handle === testProduct);
    if (idx > 0) out.products.unshift(out.products.splice(idx, 1)[0]);
    if (idx === -1) {
      try {
        const r = await request.get(`${origin}/products/${encodeURIComponent(testProduct)}.js`, { timeout: 15000 });
        if (r.ok()) {
          const p = await r.json();
          const available = (p.variants || []).filter((v) => v.available !== false);
          if (available.length)
            out.products.unshift({ id: p.id, title: p.title, handle: p.handle, allVariants: p.variants.length,
              variants: available.map((v) => ({ id: v.id, title: v.title, price: (Number(v.price) / 100).toFixed(2) })) });
          else out.notes.push(`Chosen test product "${testProduct}" is sold out; used another product.`);
        } else out.notes.push(`Chosen test product "${testProduct}" was not found; used another product.`);
      } catch {
        out.notes.push(`Chosen test product "${testProduct}" could not be loaded; used another product.`);
      }
    }
  }
  return out;
}

/**
 * WooCommerce Store API (public, read-only for products; the same cart session as the storefront).
 * Pretty links serve it at /wp-json/…; stores on plain links only answer at /?rest_route=/….
 */
const WOO_BASES = ['/wp-json/wc/store/v1', '/?rest_route=/wc/store/v1'];

export function wooUrl(origin, base, route, query = {}) {
  const q = new URLSearchParams(query).toString();
  const url = origin + base + route;
  return q ? url + (url.includes('?') ? '&' : '?') + q : url;
}

/** Store API prices are strings in the currency's minor unit ("149900" with minor unit 2 is 1499.00). */
export function wooPrice(prices) {
  if (!prices || prices.price == null || prices.price === '') return null;
  const unit = Number(prices.currency_minor_unit ?? 2);
  return (Number(prices.price) / 10 ** unit).toFixed(unit);
}

function wooPick(products, testProduct) {
  const ok = products.filter((p) => p.is_in_stock !== false && p.is_purchasable !== false && p.permalink);
  // Simple products first: their Add to cart works without choosing options, so a failure is the store's, not ours.
  const simple = ok.filter((p) => p.type === 'simple' || (!p.has_options && !(p.variations || []).length));
  const rest = ok.filter((p) => !simple.includes(p));
  let picks = [...simple, ...rest];
  if (testProduct) {
    const chosen = picks.find((p) => p.slug === testProduct);
    if (chosen) picks = [chosen, ...picks.filter((p) => p !== chosen)];
  }
  return picks.slice(0, 3).map((p) => ({
    id: p.id,
    title: decodeEntities(p.name),
    handle: p.slug,
    url: p.permalink,
    type: p.type || 'simple',
    variants: (p.variations || []).length
      ? p.variations.map((v) => ({ id: v.id, title: (v.attributes || []).map((a) => a.value).filter(Boolean).join(' / ') || 'Option', price: wooPrice(p.prices) }))
      : [{ id: p.id, title: 'Default Title', price: wooPrice(p.prices) }],
    allVariants: Math.max(1, (p.variations || []).length),
  }));
}

function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&#0?39;|&#8217;/g, '’').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8211;/g, '–');
}

async function discoverWoo(request, origin, out, { testProduct } = {}) {
  for (const base of WOO_BASES) {
    let json = null;
    try {
      const res = await request.get(wooUrl(origin, base, '/products', { per_page: 50 }), { timeout: 20000, headers: { Accept: 'application/json' } });
      if (!res.ok()) continue;
      json = await res.json().catch(() => null);
    } catch {
      continue;
    }
    if (!Array.isArray(json) || (json.length && !json[0].prices)) continue;
    out.isWoo = true;
    out.platform = { key: 'woocommerce', label: 'WooCommerce' };
    out.woo = { base };
    out.sampleSize = json.length;
    out.products = wooPick(json, testProduct);
    out.quality = dataQuality(json.map(wooToRaw));
    out.catalog = json.filter((p) => p.is_in_stock !== false).slice(0, 50).map((p) => ({ title: decodeEntities(p.name), handle: p.slug, variants: Math.max(1, (p.variations || []).length) }));
    if (testProduct && out.products[0]?.handle !== testProduct) out.notes.push(`Chosen test product "${testProduct}" was not found or is sold out; used another product.`);
    try {
      const r = await request.get(wooUrl(origin, base, '/products/categories'), { timeout: 15000, headers: { Accept: 'application/json' } });
      const cats = r.ok() ? await r.json().catch(() => []) : [];
      if (Array.isArray(cats))
        out.collections = cats.filter((c) => c.permalink && (c.count === undefined || c.count > 0)).slice(0, 3).map((c) => ({ title: decodeEntities(c.name), handle: c.slug, url: c.permalink }));
    } catch {
      /* categories are optional */
    }
    return;
  }
  if (out.platform.key === 'woocommerce') out.notes.push('The WooCommerce Store API did not answer, so shopping tests could not run.');
}

/** A product's page: its own address on WooCommerce, /products/<handle> on Shopify. */
export function productUrl(origin, p) {
  return p.url || `${origin}/products/${p.handle}`;
}

/** Picks a realistic search word from a product title. */
export function searchTermFrom(products) {
  for (const p of products) {
    const words = String(p.title)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4 && !/^\d+$/.test(w))
      .sort((a, b) => b.length - a.length);
    if (words[0]) return words[0].toLowerCase();
  }
  return null;
}
