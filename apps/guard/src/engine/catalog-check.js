import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { check, shortErr, plural } from './checks.js';
import { fetchCatalog, validateCatalog, diffCatalog } from './products.js';
import { aiEnabled, reviewCopy } from '../ai.js';
import { findTampering, tamperCheck } from './tamper.js';

const dirFor = (storeId) => path.join(config.dataDir, 'catalog', `store-${storeId}`);

export function loadSnapshot(storeId, runId) {
  const f = path.join(dirFor(storeId), `run-${runId}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
export function snapshotRuns(storeId) {
  const d = dirFor(storeId);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).map((f) => Number(/^run-(\d+)\.json$/.exec(f)?.[1])).filter(Boolean).sort((a, b) => b - a);
}
function previousSnapshot(storeId, runId) {
  const id = snapshotRuns(storeId).find((r) => r < runId);
  return id ? { runId: id, snap: loadSnapshot(storeId, id) } : null;
}

async function sitemapProductCount(request, origin) {
  try {
    const root = await request.get(`${origin}/sitemap.xml`, { timeout: 20000 });
    if (!root.ok()) return null;
    const xml = await root.text();
    const subs = [...xml.matchAll(/<loc>([^<]*sitemap_products[^<]*)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&')).slice(0, 10);
    let n = 0;
    for (const u of subs) {
      const r = await request.get(u, { timeout: 20000 });
      if (r.ok()) n += ((await r.text()).match(/<loc>[^<]*\/products\/[^<]*<\/loc>/g) || []).length;
    }
    return subs.length ? n : null;
  } catch {
    return null;
  }
}

async function emptyCollections(request, origin, collections) {
  const empty = [];
  for (const c of collections.slice(0, 8)) {
    const r = await request.get(`${origin}/collections/${c.handle}/products.json?limit=1`, { timeout: 15000 }).catch(() => null);
    if (!r || !r.ok()) continue;
    const j = await r.json().catch(() => null);
    if (j && Array.isArray(j.products) && j.products.length === 0) empty.push(c.title);
  }
  return empty;
}

/** Full-catalog checks for monitored stores: snapshot, change log, validations, counts and AI copy review. */
export async function runCatalog({ request, origin, storeId, runId, rec, info, on, shopifyCodes = null }) {
  const out = { count: 0 };
  try {
    const snap = await fetchCatalog(request, origin);
    if (!snap.count) return out;
    // The store's active Shopify discount codes (null when unknown), kept with the snapshot for tampering checks.
    snap.codes = Array.isArray(shopifyCodes) ? shopifyCodes.map((c) => ({ code: c.code, percent: c.percent ?? null })) : null;
    const prev = previousSnapshot(storeId, runId);
    fs.mkdirSync(dirFor(storeId), { recursive: true });
    fs.writeFileSync(path.join(dirFor(storeId), `run-${runId}.json`), JSON.stringify(snap));
    const issues = validateCatalog(snap, prev?.snap);
    const diff = diffCatalog(snap, prev?.snap);
    out.count = snap.count;
    out.currency = snap.currency;
    out.truncated = snap.truncated;
    out.comparedWith = prev?.runId || null;
    out.issues = issues.slice(0, 400);
    out.totals = diff?.totals || null;

    const by = (t) => issues.filter((i) => i.type === t);
    const first = (list) => list.slice(0, 3).map((i) => `“${i.title}”: ${i.message}`).join(' ');
    const pricing = by('pricing');
    const zeroPrice = pricing.some((i) => /zero/.test(i.message));
    rec.add(check('cat.pricing', 'trust', 'Prices and discounts are valid', zeroPrice ? 'fail' : pricing.length ? 'warn' : 'pass', {
      severity: 'major',
      detail: pricing.length ? `${plural(pricing.length, 'pricing issue')} across ${snap.count} products. ${first(pricing)}` : `All ${snap.count} products have valid prices and discounts.`,
      fix: pricing.length ? 'Open each product in Shopify admin → Products and correct the price or compare-at price. Zero prices and fake discounts are often bulk-edit or import mistakes.' : '',
    }));
    const content = by('content');
    rec.add(check('cat.content', 'trust', 'Product text is clean', content.some((i) => i.severity === 'major') ? 'warn' : 'pass', {
      severity: 'minor',
      detail: content.length ? `${plural(content.length, 'text issue')}: placeholders, duplicates, empty or short descriptions, formatting. ${first(content)}` : `Titles and descriptions of all ${snap.count} products look clean.`,
      fix: content.length ? 'Edit the product title or description in Shopify admin. Placeholder text usually comes from a theme demo or an import template.' : '',
    }));
    const media = by('media');
    rec.add(check('cat.media', 'trust', 'Products have images', media.some((i) => i.severity === 'major') ? 'warn' : 'pass', {
      severity: 'minor',
      detail: media.length ? `${plural(media.length, 'image issue')}. ${first(media)}` : `All ${snap.count} products have images.`,
      fix: media.length ? 'Add product images in Shopify admin → Products → Media.' : '',
    }));
    const data = by('data');
    if (data.length) rec.add(check('cat.data', 'trust', 'SKUs are unique', 'warn', { severity: 'minor', detail: `${plural(data.length, 'product')} share SKUs with others. ${first(data)}`, fix: 'Give every variant its own SKU so inventory and fulfilment apps track it correctly.' }));

    // Counts: catalog vs sitemap vs collections.
    const inSitemap = await sitemapProductCount(request, origin);
    const empty = await emptyCollections(request, origin, info.collections || []);
    out.sitemapCount = inSitemap;
    const gap = inSitemap != null && !snap.truncated ? snap.count - inSitemap : 0;
    const countProblems = [];
    if (inSitemap != null && !snap.truncated && Math.abs(gap) > Math.max(2, snap.count * 0.05))
      countProblems.push(gap > 0 ? `${plural(gap, 'product')} ${gap === 1 ? 'is' : 'are'} in your store but missing from the sitemap Google reads (${snap.count} vs ${inSitemap}).` : `Your sitemap lists ${plural(-gap, 'more product')} than the store shows (${inSitemap} vs ${snap.count}); some sitemap links may lead nowhere.`);
    if (empty.length) countProblems.push(`Collection${empty.length > 1 ? 's' : ''} with no products: ${empty.join(', ')}.`);
    rec.add(check('cat.counts', 'trust', 'Product counts add up', countProblems.length ? 'warn' : 'pass', {
      severity: 'minor',
      detail: countProblems.length ? countProblems.join(' ') : `${snap.count} products${inSitemap != null ? `, ${inSitemap} in the sitemap` : ''}${info.collections?.length ? '; checked collections all show products' : ''}.`,
      fix: countProblems.length ? 'Check product availability on the Online Store sales channel and collection conditions. Sitemaps refresh automatically after products are published.' : '',
    }));

    if (diff) {
      const t = diff.totals;
      const parts = [t.price && `${plural(t.price, 'price change')}`, t.sale && `${plural(t.sale, 'sale change')}`, t.stock && `${plural(t.stock, 'stock change')}`, t.description && `${plural(t.description, 'description edit')}`, t.images && `${plural(t.images, 'image change')}`, t.title && `${plural(t.title, 'title change')}`, t.added && `${plural(t.added, 'product')} added`, t.removed && `${t.removed} removed`].filter(Boolean);
      rec.add(check('cat.changes', 'trust', 'Catalog changes since the last check', 'pass', {
        severity: 'minor',
        detail: parts.length ? `${plural(diff.changes.length, 'product')} changed: ${parts.join(', ')}.` : 'Nothing in the catalog changed.',
      }));
    }

    if (on('security.tamper')) {
      const t = findTampering(snap, prev?.snap);
      tamperCheck({ rec, result: t });
      out.tamper = t ? t.found.slice(0, 50) : null;
    }

    // AI copy review: only products that are new or whose text changed (checksum mode).
    if (on('ai.copy') && aiEnabled()) {
      const prevBy = new Map((prev?.snap?.products || []).map((p) => [p.id, p.textHash + p.title]));
      const changed = snap.products.filter((p) => prevBy.get(p.id) !== p.textHash + p.title);
      try {
        const { results, reviewed, skipped } = await reviewCopy(prev ? changed : snap.products);
        const found = [];
        for (const p of snap.products) for (const i of results.get(p.handle)?.issues || []) found.push({ handle: p.handle, title: p.title, type: 'copy', ...i });
        out.copy = { reviewed, skipped, issues: found.slice(0, 300) };
        rec.add(check('ai.copy', 'trust', 'Product copy reads correctly (AI review)', found.some((i) => i.severity === 'major') ? 'warn' : 'pass', {
          severity: 'minor',
          detail: found.length ? `${plural(found.length, 'spelling, grammar or consistency issue')}. ${found.slice(0, 3).map((i) => `“${i.title}”: ${i.issue}${i.fix ? ` (suggested: “${i.fix}”)` : ''}`).join(' ')}` : `Reviewed ${plural(reviewed, 'new or edited product')}; no copy issues found.`,
          fix: found.length ? 'Open the Catalog section for every issue with the suggested correction.' : '',
        }));
      } catch (e) {
        rec.add(check('ai.copy', 'trust', 'Product copy reads correctly (AI review)', 'skip', { severity: 'minor', detail: `AI review did not run: ${shortErr(e)}` }));
      }
    }
  } catch (e) {
    rec.add(check('cat.pricing', 'trust', 'Prices and discounts are valid', 'skip', { severity: 'minor', detail: `Catalog could not be read: ${shortErr(e)}` }));
  }
  return out;
}
