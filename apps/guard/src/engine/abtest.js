/**
 * A/B test safety: when a store runs a price or theme test, every version a shopper can land in
 * must work. A/B tools measure which version sells more; this checks that each one can sell at all.
 *
 * 1. Finds common A/B and price-test tools on the storefront by their scripts and page globals.
 * 2. For each test version the owner listed (Test suite → A/B tests: the URL parameter or cookie
 *    from the tool's preview link), opens a fresh shopper session forced into that version and checks:
 *    product page loads with a price, Add to cart works, the cart charges the price shown on the page,
 *    and checkout opens on the store's own address. Nothing is bought; the cart is emptied.
 *
 * We never change the merchant's test settings: we only visit the store the way a preview link does.
 */
import { check, shortErr } from './checks.js';
import { newContext, gotoStore, settle } from './browser.js';
import { ATC_SELECTORS, CHECKOUT_SELECTORS, firstVisible, cartJs, clearCart, dismissOverlays } from './functional.js';

/** A/B and price-test tools we recognise. `src`: script address pattern; `globals`: names they set on window. */
export const AB_TOOLS = [
  { key: 'intelligems', name: 'Intelligems', src: /intelligems\.io/i, globals: ['igData', 'Intelligems'] },
  { key: 'shoplift', name: 'Shoplift', src: /shoplift\.ai|shoplift-/i, globals: ['shoplift'] },
  { key: 'vwo', name: 'VWO', src: /visualwebsiteoptimizer\.com|vwo\.com\/|vwo_/i, globals: ['_vwo_code', 'VWO'] },
  { key: 'optimizely', name: 'Optimizely', src: /cdn\.optimizely\.com|optimizely\.com\/js/i, globals: ['optimizely'] },
  { key: 'convert', name: 'Convert', src: /convertexperiments\.com/i, globals: ['convert', '_conv_q'] },
  { key: 'abtasty', name: 'AB Tasty', src: /abtasty\.com/i, globals: ['ABTasty'] },
  { key: 'neat', name: 'Neat A/B Testing', src: /neat-ab|neatab/i, globals: ['NeatABTesting'] },
];

/** Which tools a page's script addresses and window globals point to. */
export function matchTools(srcs = [], globals = []) {
  const g = new Set(globals);
  return AB_TOOLS.filter((t) => srcs.some((s) => t.src.test(s)) || t.globals.some((n) => g.has(n))).map((t) => t.name);
}

/** Looks at the page that is open now for A/B tools. */
export async function detectTools(page) {
  const seen = await page.evaluate((names) => ({
    srcs: [...document.scripts].map((s) => s.src).filter(Boolean),
    globals: names.filter((n) => typeof window[n] !== 'undefined'),
  }), AB_TOOLS.flatMap((t) => t.globals)).catch(() => ({ srcs: [], globals: [] }));
  return matchTools(seen.srcs, seen.globals);
}

const NAME = /^[^<>\n]{1,40}$/;
const PAIR = /^([\w.\-[\]]{1,60})=([\w.\-:%,|~]{0,200})$/;
/** Test suite → A/B tests: up to 4 versions, each a URL parameter or a cookie, as `name=value`. */
/** With `strict` (saving settings), a bad entry is refused with a plain message instead of being dropped. */
export function cleanVariants(list, { strict = false } = {}) {
  if (!Array.isArray(list)) { if (strict) throw new Error('A/B test versions must be a list.'); return []; }
  if (strict && list.length > 4) throw new Error('Add up to 4 test versions.');
  const out = [];
  for (const v of list) {
    if (!v || typeof v !== 'object') continue;
    const name = String(v.name || '').trim();
    const kind = v.kind === 'cookie' ? 'cookie' : 'param';
    const value = String(v.value || '').trim().replace(/^[?&]/, '');
    if (!NAME.test(name)) { if (strict) throw new Error('Give each test version a short name (up to 40 characters).'); continue; }
    if (!PAIR.test(value)) { if (strict) throw new Error(`“${name}”: enter the setting as name=value, for example ab_variant=b.`); continue; }
    if (out.some((x) => x.kind === kind && x.value === value)) continue;
    out.push({ name, kind, value });
    if (out.length >= 4) break;
  }
  return out;
}

/** Adds a test version's URL parameter to an address on the store. */
export function withParam(url, variant) {
  if (variant.kind !== 'param') return url;
  const u = new URL(url);
  const [k, v] = variant.value.split(/=(.*)/s);
  u.searchParams.set(k, v ?? '');
  return u.toString();
}

/** Checkout counts only on the store's own address, its myshopify address, or Shopify's checkout hosts. */
export function onOwnCheckout(url, origin) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  const own = new URL(origin).hostname.toLowerCase().replace(/^www\./, '');
  return host === own || host === `www.${own}` || host.endsWith('.myshopify.com') || host === 'checkout.shopify.com' || host === 'shop.app';
}

/** The first number in a price text, in the store's main units ("₹1,499.00" → 1499). */
export function priceFrom(text) {
  const m = /(\d{1,3}(?:[,\s.]\d{3})+|\d+)(?:[.,](\d{1,2}))?/.exec(String(text || '').replace(/ /g, ' '));
  if (!m) return null;
  return Number(m[1].replace(/[,\s.]/g, '')) + (m[2] ? Number(m[2]) / 10 ** m[2].length : 0);
}

/**
 * Test versions we can find and force on our own, per tool, using only each tool's documented
 * storefront mechanism (checked against the tool's docs on 2026-11-06):
 *
 * - Convert: the page exposes `window.convert.currentData.experiences`
 *   (`{ "<experienceId>": { variation: { id, name } } }`), the version this visitor got, and a visitor
 *   can be forced into a version with `?_conv_eforce=<experienceId>.<variationId>` (active experiences
 *   only; the experience's site area and audience rules still apply).
 *
 * Convert does not document a page-side list of every version, so we open a few fresh shopper sessions
 * and record which versions they land in; each version seen is then forced and shopped like a listed one.
 * Other tools (Optimizely, VWO, AB Tasty, Intelligems, Shoplift) keep using the versions the owner lists:
 * their docs either need an account to find version IDs or only offer a preview from inside the tool.
 */
export const AUTO_TOOLS = ['Convert'];
const AUTO_MAX = 4;
const ID = /^\d{1,20}$/;

/** Reads the Convert versions a visitor was put in from `window.convert.currentData.experiences`. */
export function convertSeen(experiences) {
  const out = [];
  if (!experiences || typeof experiences !== 'object') return out;
  for (const [exp, v] of Object.entries(experiences)) {
    const id = String(v?.variation?.id ?? '');
    if (!ID.test(exp) || !ID.test(id)) continue;
    const label = String(v?.variation?.name || `version ${id}`).replace(/[<>\n]/g, '').trim().slice(0, 28) || `version ${id}`;
    out.push({ exp, id, label });
  }
  return out;
}

/** The forcing setting for one Convert version, in the same shape as an owner-listed version. */
export const convertVariant = ({ exp, id, label }) => ({ name: `${label} (Convert)`.slice(0, 40), kind: 'param', value: `_conv_eforce=${exp}.${id}`, auto: 'Convert' });

/** Opens up to `tries` fresh shopper sessions on a product page and collects the Convert versions they get. */
export async function discoverConvert({ origin, info, password, tries = 6 }) {
  const product = info.products[0];
  const found = new Map();
  let sinceNew = 0;
  for (let i = 0; i < tries && found.size < AUTO_MAX && sinceNew < 3; i++) {
    const ctx = await newContext();
    try {
      const page = await ctx.newPage();
      if (password) await gotoStore(page, origin + '/', { password }).catch(() => {});
      await page.goto(product ? `${origin}/products/${product.handle}` : origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => window.convert && window.convert.currentData, null, { timeout: 5000 }).catch(() => {});
      const seen = convertSeen(await page.evaluate(() => (window.convert && window.convert.currentData && window.convert.currentData.experiences) || null).catch(() => null));
      let added = false;
      for (const v of seen) if (!found.has(`${v.exp}.${v.id}`) && found.size < AUTO_MAX) { found.set(`${v.exp}.${v.id}`, v); added = true; }
      sinceNew = added ? 0 : sinceNew + 1;
    } catch {
      sinceNew++;
    } finally {
      await ctx.close().catch(() => {});
    }
  }
  return [...found.values()].map(convertVariant);
}

async function oneVariant({ variant, origin, info, password, shot, n }) {
  const product = info.products[0];
  const pv = product.variants[0];
  const ctx = await newContext();
  ctx.setDefaultTimeout(20000);
  const problems = []; // { text, severity }
  const facts = [];
  let screenshot = null;
  const page = await ctx.newPage();
  try {
    if (variant.kind === 'cookie') {
      const [name, value] = variant.value.split(/=(.*)/s);
      await ctx.addCookies([{ name, value: value ?? '', url: origin + '/' }]);
    }
    if (password) await gotoStore(page, origin + '/', { password }).catch(() => {});
    // Product page
    const res = await page.goto(withParam(`${origin}/products/${product.handle}?variant=${pv.id}`, variant), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settle(page, 1000);
    await dismissOverlays(page);
    const status = res ? res.status() : 0;
    if (status >= 400 || status === 0) {
      problems.push({ severity: 'critical', text: `the product page didn't open (HTTP ${status})` });
      screenshot = await shot(page, `ab-${n}-pdp`);
      return { problems, facts, screenshot };
    }
    const priceText = await page.locator('[class*="price"], [data-price], .money').filter({ hasText: /\d/ }).first().textContent({ timeout: 3000 }).catch(() => null);
    const shown = priceFrom(priceText);
    if (shown == null) problems.push({ severity: 'major', text: 'no price was visible on the product page' });
    else facts.push(`page shows ${priceText.trim()}`);

    // Add to cart through the real button
    await clearCart(page);
    const btn = await firstVisible(page, ATC_SELECTORS);
    let added = false;
    if (btn && (await btn.el.isEnabled().catch(() => false))) {
      await btn.el.scrollIntoViewIfNeeded().catch(() => {});
      await btn.el.click({ timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 10 && !added; i++) {
        await page.waitForTimeout(700);
        added = ((await cartJs(page)).item_count || 0) > 0;
      }
    }
    if (!added) {
      problems.push({ severity: 'critical', text: btn ? 'Add to cart did nothing' : 'there was no Add to cart button' });
      screenshot = await shot(page, `ab-${n}-atc`);
      return { problems, facts, screenshot };
    }
    facts.push('Add to cart works');

    // The cart charges what the page showed
    const cart = await cartJs(page);
    const line = (cart.items || [])[0];
    // Shopify's cart gives prices as whole cents (numbers); a few setups send main-unit strings.
    const raw = line ? line.final_price ?? line.price : null;
    const chargedMain = raw == null ? null : typeof raw === 'number' ? raw / 100 : Number(raw);
    if (shown != null && chargedMain != null && !Number.isNaN(chargedMain) && Math.abs(shown - chargedMain) > 0.01) {
      problems.push({ severity: 'major', text: `the page shows ${priceText.trim()} but the cart charges ${chargedMain.toFixed(2)} ${cart.currency || ''}`.trim() });
      screenshot ||= await shot(page, `ab-${n}-price`);
    } else if (chargedMain != null) facts.push(`cart charges the same ${chargedMain.toFixed(2)} ${cart.currency || ''}`.trim());

    // Checkout opens on the store's own address (stops before payment)
    await page.goto(withParam(`${origin}/cart`, variant), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settle(page, 800);
    await dismissOverlays(page);
    const cbtn = await firstVisible(page, CHECKOUT_SELECTORS);
    if (cbtn) {
      await Promise.all([
        page.waitForURL(/checkout|checkouts/, { timeout: 25000 }).catch(() => {}),
        cbtn.el.click({ timeout: 8000 }).catch(() => {}),
      ]);
    }
    if (!/checkout|checkouts/.test(page.url())) await page.goto(withParam(`${origin}/checkout`, variant), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await settle(page, 1500);
    const url = page.url();
    const reached = /\/checkouts?\//.test(url) || /checkout\.shopify\.com|shop\.app\/checkout/.test(url);
    if (!reached) {
      problems.push({ severity: 'critical', text: 'checkout did not open' });
      screenshot ||= await shot(page, `ab-${n}-checkout`);
    } else if (!onOwnCheckout(url, origin)) {
      problems.push({ severity: 'critical', text: `checkout went to ${new URL(url).hostname}, not your store's own address` });
      screenshot ||= await shot(page, `ab-${n}-checkout`);
    } else facts.push('checkout opens on your store');
    return { problems, facts, screenshot };
  } catch (e) {
    problems.push({ severity: 'critical', text: `the test stopped: ${shortErr(e)}` });
    screenshot ||= await shot(page, `ab-${n}-error`).catch(() => null);
    return { problems, facts, screenshot };
  } finally {
    await page.goto(`${origin}/cart`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await clearCart(page);
    await ctx.close().catch(() => {});
  }
}

/** Runs on full checks of Shopify stores: tool detection, then one shopping journey per version. */
export async function runAbTests({ page, rec, origin, info, password, variants = [], shot, discover = { Convert: discoverConvert } }) {
  rec.step('Look for A/B tests');
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await settle(page, 800);
  let tools = await detectTools(page);
  if (info.products[0]) {
    await page.goto(`${origin}/products/${info.products[0].handle}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await settle(page, 600);
    tools = [...new Set([...tools, ...(await detectTools(page))])];
  }
  const listed = cleanVariants(variants);
  // Versions we can find ourselves, for tools whose forcing method is documented (see AUTO_TOOLS).
  const found = [];
  const foundBy = new Set();
  if (info.products[0]) {
    for (const tool of tools.filter((t) => discover[t])) {
      rec.step(`Find the ${tool} test versions`);
      const vs = await discover[tool]({ origin, info, password }).catch(() => []);
      if (vs.length) foundBy.add(tool);
      for (const v of vs) if (!listed.some((x) => x.value === v.value) && !found.some((x) => x.value === v.value)) found.push(v);
    }
  }
  const list = [...listed, ...found].slice(0, 8);
  // Tools whose versions we could not find on our own still need the owner's list.
  const manualTools = tools.filter((t) => !foundBy.has(t));
  const needList = manualTools.length > 0 && !listed.length;
  if (tools.length || list.length) {
    const parts = [];
    if (tools.length) parts.push(`We found ${tools.join(' and ')} on your store.`);
    else parts.push(`No A/B tool found on the pages we opened, but you listed ${listed.length} test version${listed.length === 1 ? '' : 's'}; we checked each one.`);
    if (found.length) parts.push(`We found ${found.length} ${found[0].auto} test version${found.length === 1 ? '' : 's'} on our own and checked ${found.length === 1 ? 'it' : 'each one'}.`);
    if (tools.length && listed.length) parts.push(`Checking the ${listed.length} test version${listed.length === 1 ? '' : 's'} you listed.`);
    if (needList) parts.push(`Shoppers in a ${manualTools.join(' or ')} test may see a different price or page than we checked.`);
    rec.add(check('ab.tools', 'functional', 'A/B tests on your store', needList ? 'warn' : 'pass', {
      severity: 'minor',
      detail: parts.join(' '),
      fix: needList ? `Open Test suite → A/B tests and add each ${manualTools.join(' or ')} version’s preview link setting (a URL parameter or cookie from your A/B app), so we can check every version shoppers can see.` : '',
    }));
  }
  if (!list.length || !info.products[0]) return { tools, variants: [] };
  const results = [];
  for (const [i, v] of list.entries()) {
    rec.step(`Shop as test version "${v.name}"`);
    const r = await oneVariant({ variant: v, origin, info, password, shot, n: i + 1 });
    const worst = r.problems.some((p) => p.severity === 'critical') ? 'critical' : r.problems.length ? 'major' : 'critical';
    rec.add(check(`ab.variant.${i + 1}`, 'functional', `Test version “${v.name}” can sell`, r.problems.length ? 'fail' : 'pass', {
      severity: worst,
      detail: r.problems.length
        ? `Shoppers who get version “${v.name}”: ${r.problems.map((p) => p.text).join('; ')}.`
        : `Version “${v.name}”: ${r.facts.join(', ')}.`,
      evidence: r.problems.length ? { screenshot: r.screenshot, variant: v.value, via: v.kind, found: v.auto || null } : null,
      fix: r.problems.length ? `Pause version “${v.name}” in your A/B app until it is fixed, or end the test. Then check the theme or price changes that version makes.` : '',
    }));
    results.push({ name: v.name, ok: !r.problems.length, auto: !!v.auto });
  }
  return { tools, variants: results };
}
