/**
 * Sale traffic readiness (roadmap 11). Opt-in only.
 *
 * A few shoppers (at most 5, a hard cap) shop at the same time: product page, add to cart, cart, checkout.
 * Each shopper goes through once and stops before entering any details; carts are emptied afterwards.
 * Their timings are compared with one shopper alone, so the owner learns whether the store slows down
 * or breaks when several people buy at once, the way a sale starts.
 *
 * This is never a load test: 5 shoppers is less than a small store sees on a normal evening, every shopper
 * makes one pass, and a store is tested at most once every 6 hours.
 */
import { newContext, gotoStore } from './browser.js';
import { check, shortErr } from './checks.js';

export const MAX_SHOPPERS = 5; // hard rule, not configurable
export const DEFAULT_SHOPPERS = 3;
export const MIN_GAP_HOURS = 6;
const STEPS = [
  { key: 'product', label: 'Product page' },
  { key: 'add', label: 'Add to cart' },
  { key: 'cart', label: 'Cart page' },
  { key: 'checkout', label: 'Opening checkout' },
];
// A step counts as slower when it takes at least twice as long as for one shopper and at least 1.5 s more.
const SLOW_RATIO = 2;
const SLOW_EXTRA_MS = 1500;

export const clampShoppers = (n) => Math.min(MAX_SHOPPERS, Math.max(2, Math.round(Number(n)) || DEFAULT_SHOPPERS));
const secs = (ms) => (ms < 100 ? '<0.1 s' : `${(ms / 1000).toFixed(1)} s`);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

/** One shopper's pass: product page, add to cart, cart page, checkout. Returns step times (ms) or the step that broke. */
async function shopOnce({ origin, password, product, variantId, timeout = 30000 }) {
  const ctx = await newContext();
  const page = await ctx.newPage();
  const times = {};
  try {
    if (password) {
      const g = await gotoStore(page, origin + '/', { password, timeout });
      if (g.locked) return { error: { step: 'product', message: 'The store is password protected and could not be opened.' } };
    }
    const timed = async (key, fn) => {
      const t0 = Date.now();
      try { await fn(); } catch (e) { throw Object.assign(new Error(shortErr(e)), { step: key }); }
      times[key] = Date.now() - t0;
    };
    await timed('product', async () => {
      const r = await page.goto(`${origin}/products/${product.handle}?variant=${variantId}`, { waitUntil: 'load', timeout });
      if (!r || r.status() >= 400) throw new Error(`the product page answered ${r ? r.status() : 'nothing'}`);
    });
    await timed('add', async () => {
      const r = await page.evaluate(async (id) => {
        const res = await fetch('/cart/add.js', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ items: [{ id, quantity: 1 }] }) });
        return { ok: res.ok, status: res.status };
      }, Number(variantId));
      if (!r.ok) throw new Error(`the cart refused the item (${r.status})`);
    });
    await timed('cart', async () => {
      const r = await page.goto(`${origin}/cart`, { waitUntil: 'load', timeout });
      if (!r || r.status() >= 400) throw new Error(`the cart page answered ${r ? r.status() : 'nothing'}`);
    });
    await timed('checkout', async () => {
      const r = await page.goto(`${origin}/checkout`, { waitUntil: 'load', timeout });
      if (!r || r.status() >= 400) throw new Error(`checkout answered ${r ? r.status() : 'nothing'}`);
      if (/\/cart(\?|$)/.test(new URL(page.url()).pathname)) throw new Error('checkout sent the shopper back to the cart');
    });
    return { times };
  } catch (e) {
    return { times, error: { step: e.step || 'product', message: shortErr(e) } };
  } finally {
    // Leave nothing behind: empty this shopper's cart, then close the window.
    await page.goto(`${origin}/cart`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.evaluate(() => fetch('/cart/clear.js', { method: 'POST', credentials: 'same-origin' })).catch(() => {});
    await ctx.close().catch(() => {});
  }
}

/**
 * Runs the sale traffic test and adds the check `perf.traffic`.
 * `lastAt`: when the store was last tested (ISO). The main server keeps it in the database and claims the slot
 * before the check starts (queue.js claimTrafficSlot); it is passed in when the test must wait, so every runner
 * honours the same 6-hour limit. Returns a summary for the run result, or null when it did not run.
 */
export async function runTraffic({ rec, origin, info, password, shoppers = DEFAULT_SHOPPERS, lastAt = null, now = Date.now() }) {
  const title = 'Store keeps up when several shoppers buy at once';
  const n = clampShoppers(shoppers);
  if (lastAt && now - new Date(lastAt).getTime() < MIN_GAP_HOURS * 3600e3) {
    rec.add(check('perf.traffic', 'performance', title, 'skip', { severity: 'minor', detail: `Tested ${new Date(lastAt).toUTCString().slice(5, 22)} UTC. To stay gentle with your store, this test runs at most once every ${MIN_GAP_HOURS} hours.` }));
    return { skipped: 'recent', last: lastAt };
  }
  const product = info.products?.[0];
  const variant = product?.variants?.find((v) => v.available !== false) || product?.variants?.[0];
  if (!product || !variant) {
    rec.add(check('perf.traffic', 'performance', title, 'skip', { severity: 'minor', detail: 'No product in stock was found to shop for.' }));
    return null;
  }

  rec.step('Sale traffic: one shopper alone');
  const alone = await shopOnce({ origin, password, product, variantId: variant.id });
  if (alone.error) {
    rec.add(check('perf.traffic', 'performance', title, 'skip', { severity: 'minor', detail: `One shopper alone could not finish (${alone.error.message}), so there was nothing to compare with. The shopping journey checks show what is wrong.` }));
    return { shoppers: n, alone, crowd: [] };
  }
  rec.step(`Sale traffic: ${n} shoppers at the same time`);
  const crowd = await Promise.all(Array.from({ length: n }, () => shopOnce({ origin, password, product, variantId: variant.id })));

  const steps = STEPS.map((s) => {
    const xs = crowd.map((c) => c.times[s.key]).filter((x) => x != null);
    return { ...s, alone: alone.times[s.key], median: median(xs), max: xs.length ? Math.max(...xs) : null };
  });
  const slow = steps.filter((s) => s.median != null && s.median >= s.alone * SLOW_RATIO && s.median - s.alone >= SLOW_EXTRA_MS);
  const broke = crowd.filter((c) => c.error);
  const stepLabel = (k) => STEPS.find((s) => s.key === k)?.label.toLowerCase() || k;

  let status = 'pass';
  const parts = [];
  if (broke.length) {
    status = 'fail';
    const where = [...new Set(broke.map((b) => stepLabel(b.error.step)))].join(' and ');
    parts.push(`${broke.length} of ${n} shoppers could not finish while others were shopping: it broke at ${where} (${broke[0].error.message}). Alone, a shopper got through.`);
  }
  if (slow.length) {
    if (status === 'pass') status = 'warn';
    parts.push(`Your store slowed down with ${n} shoppers at once: ${slow.map((s) => `${s.label.toLowerCase()} took ${secs(s.median)} instead of ${secs(s.alone)}`).join(', ')}.`);
  }
  const table = steps.map((s) => `${s.label}: ${secs(s.alone)} alone, ${s.median != null ? secs(s.median) : '–'} with ${n}`).join('; ');
  rec.add(check('perf.traffic', 'performance', title, status, {
    severity: 'major',
    detail: status === 'pass' ? `${n} shoppers bought at the same time without slowing your store down. ${table}.` : `${parts.join(' ')} ${table}.`,
    fix: status === 'pass' ? '' : 'Before the sale, look at what runs on product, cart and checkout pages: apps that check stock or prices on every visit, upsell and bundle apps, and custom cart code are the usual cause. Remove apps you no longer use and ask the app makers whether they handle busy moments. Shopify itself scales checkout; slowdowns before checkout usually come from apps or theme code.',
    evidence: { traffic: { shoppers: n, steps: steps.map(({ key, label, alone: a, median: m, max }) => ({ key, label, alone: a, median: m, max })), errors: broke.map((b) => b.error) } },
  }));
  return { shoppers: n, steps, errors: broke.map((b) => b.error), slow: slow.map((s) => s.key) };
}
