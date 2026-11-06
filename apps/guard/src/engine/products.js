import { plural } from './checks.js';
/**
 * Catalog checksum mode: fingerprints every product so any two checks can be compared,
 * and validates product data the way a careful merchandiser would.
 */
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

export function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim();
}

function normalize(p) {
  const text = stripHtml(p.body_html);
  const variants = (p.variants || []).map((v) => ({
    id: v.id,
    title: v.title,
    sku: v.sku || '',
    price: v.price != null ? Number(v.price) : null,
    compareAt: v.compare_at_price != null && v.compare_at_price !== '' ? Number(v.compare_at_price) : null,
    available: v.available !== false,
  }));
  const prices = variants.map((v) => v.price).filter((x) => x != null);
  const n = {
    id: p.id,
    handle: p.handle,
    url: p.url || null,
    title: String(p.title || ''),
    vendor: p.vendor || '',
    type: p.product_type || '',
    tags: (Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',')).map((t) => t.trim()).filter(Boolean).sort(),
    text,
    rawHtml: String(p.body_html || '').slice(0, 20000),
    textHash: sha(text),
    images: (p.images || []).length,
    image: p.images?.[0]?.src || null,
    variants,
    minPrice: prices.length ? Math.min(...prices) : null,
    maxPrice: prices.length ? Math.max(...prices) : null,
    available: variants.some((v) => v.available),
  };
  n.checksum = sha(JSON.stringify([n.title, n.vendor, n.type, n.tags, n.textHash, n.images, n.variants]));
  return n;
}

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#0?39;|&#8217;/g, '’').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8211;/g, '–');

/** A WooCommerce Store API product, shaped like a Shopify products.json entry so the same rules apply. */
export function wooToRaw(p) {
  const pr = p.prices || {};
  const unit = Number(pr.currency_minor_unit ?? 2);
  const money = (v) => (v == null || v === '' ? null : (Number(v) / 10 ** unit));
  const range = pr.price_range;
  const price = range?.min_amount != null ? money(range.min_amount) : money(pr.price);
  const regular = money(pr.regular_price);
  const onSale = p.on_sale === true || (pr.sale_price != null && pr.sale_price !== '' && pr.sale_price !== pr.regular_price);
  const html = [p.description, p.short_description].filter(Boolean).join('\n');
  return {
    id: p.id,
    handle: p.slug,
    url: p.permalink || null,
    title: decode(p.name),
    body_html: html,
    vendor: (p.brands || [])[0]?.name || '',
    product_type: (p.categories || [])[0]?.name || '',
    tags: (p.tags || []).map((t) => t.name || t.slug || ''),
    images: p.images || [],
    currency: pr.currency_code || null,
    variants: [{ id: p.id, title: 'Default Title', sku: p.sku || '', price, compare_at_price: onSale && regular != null ? regular : null, available: p.is_in_stock !== false }],
  };
}

/** Reads every product through the public WooCommerce Store API, page by page. */
export async function fetchWooCatalog(request, origin, base = '/wp-json/wc/store/v1', { maxPages = 8, perPage = 100 } = {}) {
  const products = [];
  let truncated = false;
  let currency = null;
  for (let page = 1; page <= maxPages; page++) {
    const url = origin + base + '/products' + (base.includes('?') ? '&' : '?') + `per_page=${perPage}&page=${page}`;
    const res = await request.get(url, { timeout: 25000, headers: { Accept: 'application/json' } }).catch(() => null);
    if (!res || !res.ok()) break;
    const list = await res.json().catch(() => null);
    if (!Array.isArray(list) || !list.length) break;
    for (const p of list) { const raw = wooToRaw(p); currency ||= raw.currency; products.push(normalize(raw)); }
    const totalPages = Number(res.headers()['x-wp-totalpages'] || 0);
    const last = totalPages ? page >= totalPages : list.length < perPage;
    if (last) break;
    if (page === maxPages) truncated = true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return { takenAt: new Date().toISOString(), count: products.length, truncated, currency, platform: 'woocommerce', products };
}

/** Reads the whole public catalog (up to maxPages × 250 products). */
export async function fetchCatalog(request, origin, { maxPages = 8 } = {}) {
  const products = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const res = await request.get(`${origin}/products.json?limit=250&page=${page}`, { timeout: 25000 }).catch(() => null);
    if (!res || !res.ok()) break;
    const json = await res.json().catch(() => null);
    const list = json?.products || [];
    products.push(...list.map(normalize));
    if (list.length < 250) break;
    if (page === maxPages) truncated = true;
    await new Promise((r) => setTimeout(r, 400)); // be gentle with the store
  }
  // The store's currency, so prices read the way the merchant sees them (cart.js always reports it).
  let currency = null;
  const cart = await request.get(`${origin}/cart.js`, { timeout: 15000 }).catch(() => null);
  if (cart?.ok()) currency = (await cart.json().catch(() => null))?.currency || null;
  return { takenAt: new Date().toISOString(), count: products.length, truncated, currency, products };
}

const PLACEHOLDER = [
  [/lorem ipsum|dolor sit amet/i, 'Lorem ipsum placeholder text'],
  [/\{\{.*?\}\}|\{%.*?%\}/, 'Template code ({{ }} or {% %}) showing as text'],
  [/\b(undefined|NaN|\[object Object\])\b/, 'Programming value (undefined, NaN) showing as text'],
  [/\b(TBD|TODO|FIXME|XXX|coming soon description|insert (text|description) here|description goes here)\b/i, 'Unfinished placeholder (TBD, TODO)'],
  [/&(nbsp|amp|quot|#\d+);/, 'HTML code (like &nbsp;) showing as text'],
  [/<\/?(div|span|p|br|strong)\b/i, 'Raw HTML tags showing as text'],
];

/** Validations a careful merchandiser would make, on one snapshot (plus the previous one for price jumps). */
export function formatMoney(n, currency) {
  if (n == null) return '–';
  if (!currency) return String(n);
  try { return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n); } catch { return `${n} ${currency}`; }
}

export function validateCatalog(snap, prev = null) {
  const m = (n) => formatMoney(n, snap.currency);
  const issues = [];
  const add = (p, type, severity, message, extra = {}) => issues.push({ handle: p.handle, url: p.url || null, title: p.title, type, severity, message, ...extra });
  const prevBy = new Map((prev?.products || []).map((p) => [p.id, p]));
  const textCount = new Map();
  for (const p of snap.products) if (p.text.length > 40) textCount.set(p.textHash, (textCount.get(p.textHash) || 0) + 1);
  const skuOwners = new Map();
  for (const p of snap.products) for (const v of p.variants) if (v.sku) skuOwners.set(v.sku, (skuOwners.get(v.sku) || new Set()).add(p.handle));

  for (const p of snap.products) {
    // Pricing
    for (const v of p.variants) {
      const label = p.variants.length > 1 ? ` for “${v.title}”` : '';
      if (v.price == null || v.price === 0) add(p, 'pricing', 'critical', `Priced at zero${label}. Customers could order it for free.`, { variant: v.title });
      if (v.compareAt != null && v.price != null && v.compareAt > 0 && v.compareAt <= v.price)
        add(p, 'pricing', 'major', `Compare-at price ${m(v.compareAt)} is not higher than the price ${m(v.price)}${label}, so the “sale” is not a real discount.`, { variant: v.title });
      const old = prevBy.get(p.id)?.variants.find((x) => x.id === v.id);
      if (old?.price && v.price != null && v.price > 0) {
        const change = (v.price - old.price) / old.price;
        if (change <= -0.5) add(p, 'pricing', 'major', `Price${label} dropped ${Math.round(-change * 100)}% since the last check, from ${m(old.price)} to ${m(v.price)}. Check this isn't a mistake.`, { variant: v.title });
        if (change >= 1) add(p, 'pricing', 'minor', `Price${label} more than doubled since the last check, from ${m(old.price)} to ${m(v.price)}.`, { variant: v.title });
      }
    }
    // Content
    const hay = `${p.title}\n${p.text}`;
    for (const [re, label] of PLACEHOLDER) {
      const m = hay.match(re);
      if (m) add(p, 'content', 'major', `${label}: “${m[0].slice(0, 60)}”.`, { snippet: m[0].slice(0, 80) });
    }
    if (p.text.length < 25) add(p, 'content', 'minor', p.text.length ? 'Description is very short.' : 'Description is empty.');
    if (p.text.length > 40 && textCount.get(p.textHash) > 1) add(p, 'content', 'minor', `Same description as ${plural(textCount.get(p.textHash) - 1, 'other product')}. Duplicate text hurts SEO.`);
    const rep = hay.match(/\b(\w{2,})[ \t]+\1\b/i); // same line only: a title ending in “Set” followed by a description starting “Set of…” is fine
    if (rep && !/^(\d+|ha|bye|no|so|very|knock)$/i.test(rep[1])) add(p, 'content', 'minor', `Repeated word: “${rep[0]}”.`, { snippet: rep[0] });
    if (/[a-z][.,;:!?][A-Za-z]{3,}/.test(p.text.replace(/https?:\S+|\b\d+\.\d+\b|\w+\.(com|in|co|net|org)\b/g, ''))) add(p, 'content', 'minor', 'Missing space after punctuation somewhere in the description.');
    if (p.title.length > 12 && p.title === p.title.toUpperCase() && /[A-Z]/.test(p.title)) add(p, 'content', 'minor', 'Title is in ALL CAPS, which reads as shouting in search results.');
    if (p.title.length > 150) add(p, 'content', 'minor', `Title is ${p.title.length} characters; long titles get cut off in search results.`);
    if (/\s{2,}|^\s|\s$/.test(p.title)) add(p, 'content', 'minor', 'Title has extra spaces.');
    // Media and stock
    if (!p.images) add(p, 'media', 'major', 'No product images.');
    const old = prevBy.get(p.id);
    if (old && p.images < old.images) add(p, 'media', 'minor', `${plural(old.images - p.images, 'image')} removed since the last check.`);
    if (old && old.available && !p.available) add(p, 'stock', 'minor', 'Went out of stock since the last check.');
    // Data
    for (const v of p.variants) if (v.sku && skuOwners.get(v.sku)?.size > 1) { add(p, 'data', 'minor', `SKU “${v.sku}” is also used by another product. Duplicate SKUs confuse inventory and fulfilment.`, { snippet: v.sku }); break; }
  }
  const order = { critical: 0, major: 1, minor: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** What changed between two snapshots. */
export function diffCatalog(cur, prev) {
  if (!prev) return null;
  const P = new Map(prev.products.map((p) => [p.id, p]));
  const C = new Map(cur.products.map((p) => [p.id, p]));
  const changes = [];
  for (const p of cur.products) {
    const o = P.get(p.id);
    if (!o) { changes.push({ kind: 'added', handle: p.handle, url: p.url || null, title: p.title, detail: `New product, ${p.minPrice != null ? `from ${p.minPrice}` : 'no price'}` }); continue; }
    if (o.checksum === p.checksum) continue;
    const c = { kind: 'changed', handle: p.handle, url: p.url || null, title: p.title, fields: [] };
    if (o.title !== p.title) c.fields.push({ field: 'title', label: 'Title', before: o.title, after: p.title });
    for (const v of p.variants) {
      const ov = o.variants.find((x) => x.id === v.id);
      const vl = p.variants.length > 1 ? ` · ${v.title}` : '';
      if (!ov) { c.fields.push({ field: 'variant', label: `Variant added${vl}`, before: null, after: v.price }); continue; }
      if (ov.price !== v.price) c.fields.push({ field: 'price', label: `Price${vl}`, before: ov.price, after: v.price, pct: ov.price ? Math.round(((v.price - ov.price) / ov.price) * 1000) / 10 : null });
      if (ov.compareAt !== v.compareAt) c.fields.push({ field: 'sale', label: `Compare-at price${vl}`, before: ov.compareAt, after: v.compareAt, note: !ov.compareAt && v.compareAt ? 'Sale started' : ov.compareAt && !v.compareAt ? 'Sale ended' : null });
      if (ov.available !== v.available) c.fields.push({ field: 'stock', label: `Stock${vl}`, before: ov.available ? 'In stock' : 'Sold out', after: v.available ? 'In stock' : 'Sold out' });
    }
    for (const ov of o.variants) if (!p.variants.some((x) => x.id === ov.id)) c.fields.push({ field: 'variant', label: `Variant removed · ${ov.title}`, before: ov.price, after: null });
    if (o.images !== p.images) c.fields.push({ field: 'images', label: 'Images', before: o.images, after: p.images });
    if (o.textHash !== p.textHash) c.fields.push({ field: 'description', label: 'Description', before: o.text, after: p.text, diff: textDiff(o.text, p.text) });
    if (o.tags.join(',') !== p.tags.join(',')) c.fields.push({ field: 'tags', label: 'Tags', before: o.tags.join(', '), after: p.tags.join(', ') });
    if (o.type !== p.type) c.fields.push({ field: 'type', label: 'Product type', before: o.type, after: p.type });
    if (c.fields.length) changes.push(c);
  }
  for (const o of prev.products) if (!C.has(o.id)) changes.push({ kind: 'removed', handle: o.handle, title: o.title, detail: 'No longer in the online store (deleted, unpublished or hidden)' });
  const count = (f) => changes.filter((c) => c.fields?.some((x) => x.field === f)).length;
  return {
    changes,
    totals: {
      added: changes.filter((c) => c.kind === 'added').length,
      removed: changes.filter((c) => c.kind === 'removed').length,
      changed: changes.filter((c) => c.kind === 'changed').length,
      price: count('price'), sale: count('sale'), stock: count('stock'), description: count('description'), images: count('images'), title: count('title'),
    },
  };
}

/** Sentence-level difference, good enough to show what was added or removed in a description. */
function textDiff(a, b) {
  const split = (t) => t.split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter(Boolean);
  const A = split(a), B = split(b);
  const sa = new Set(A), sb = new Set(B);
  return { removed: A.filter((x) => !sb.has(x)).slice(0, 8), added: B.filter((x) => !sa.has(x)).slice(0, 8) };
}
