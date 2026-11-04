/**
 * Store discovery: learns what to test from the store's public Shopify endpoints
 * (products.json, collections.json) so merchants don't have to configure anything.
 */

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
