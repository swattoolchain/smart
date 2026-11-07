/**
 * Prospect checker (go-to-market tool, not part of the product or the Shopify app).
 *
 * Takes public Shopify store addresses and runs a light, polite check on each, like one shopper on a phone:
 * home page, products.json (prices of zero), one product page with its Add to cart button, and, only where
 * the store's robots.txt allows it, adding that product to a cart and opening checkout to see where it goes.
 *
 * Hard limits (enforced here, not configurable past them):
 *   - at most one visit per page per store, no retries;
 *   - at most 2 stores at a time;
 *   - identifies itself as TharamBot with a link to https://tharam.store/bot;
 *   - respects robots.txt (rules for TharamBot, else for *), including Crawl-delay: honoured in full up to
 *     30 s; a store asking for longer is skipped, never visited faster than it asks;
 *   - never places orders and never types anything into any page;
 *   - keeps only findings (statuses, counts, timings, addresses), never page content;
 *   - public addresses only (no private or internal networks).
 */
import { chromium } from 'playwright';
import { config } from './config.js';
import { assertPublicTarget } from './engine/browser.js';

export const BOT = 'TharamBot';
export const USER_AGENT = `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 ${BOT}/1.0 (+https://tharam.store/bot)`;
export const MAX_CONCURRENCY = 2;
export const MAX_CRAWL_DELAY_MS = 30000; // longer Crawl-delay: the store is skipped
const PAGE_TIMEOUT = 30000;
const SLOW_PHONE_MS = 4000;
const CHECKOUT_HOSTS = ['checkout.shopify.com', 'shop.app'];

// ---------- robots.txt ----------
/** Parses robots.txt into the rules that apply to TharamBot (its own group, else the * group). */
export function parseRobots(text, agent = BOT) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') { if (val || key === 'allow') cur.rules.push({ allow: key === 'allow', path: val }); }
    else if (key === 'crawl-delay') { const n = Number(val); if (Number.isFinite(n) && n >= 0) cur.delay = n; }
  }
  const a = agent.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((x) => x !== '*' && a.includes(x)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  const delays = chosen.map((g) => g.delay).filter((d) => d != null);
  return { rules, delayMs: delays.length ? Math.max(...delays) * 1000 : 0 };
}

function ruleRegex(p) {
  const end = p.endsWith('$');
  const body = (end ? p.slice(0, -1) : p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + body + (end ? '$' : ''));
}
/** True when robots rules let TharamBot fetch this path (longest matching rule wins; Allow wins a tie). */
export function robotsAllows(robots, pathWithQuery) {
  let best = null;
  for (const r of robots.rules) {
    if (!r.path) continue;
    if (!ruleRegex(r.path).test(pathWithQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

// ---------- checkout address ----------
/** Whether checkout opened on the store's own address, its myshopify address, or Shopify's checkout. */
export function checkoutHostOk(host, { storeHost, shopDomain }) {
  const h = String(host || '').toLowerCase();
  const strip = (x) => String(x || '').toLowerCase().replace(/^www\./, '');
  if (!h) return false;
  if (strip(h) === strip(storeHost)) return true;
  if (shopDomain && h === String(shopDomain).toLowerCase()) return true;
  return CHECKOUT_HOSTS.includes(h);
}

// ---------- one store ----------
export function normalizeTarget(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('empty address');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) throw new Error('not a web address');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error('not a store address');
  if (!/^https?:$/.test(u.protocol)) throw new Error('not a web address');
  return u.origin;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Checks one store. Returns findings only. `browser` is a Playwright browser; `log` receives each request
 * the checker makes on purpose ({ kind: 'page'|'fetch', path }), for tests and audits.
 */
export async function checkStore(input, { browser, log = () => {}, now = () => new Date(), minGapMs = 500, robotsText } = {}) {
  const out = {
    store: String(input || '').trim(), checked_at: now().toISOString(), status: 'ok',
    home_ok: null, home_load_ms: null, phone_lcp_ms: null, products: null, zero_price_products: null, zero_price_example: '',
    product_page_ok: null, add_to_cart: 'not checked', checkout: 'not checked', checkout_host: '', skipped: [], findings: [], error: '',
  };
  let origin;
  try { origin = normalizeTarget(input); } catch (e) { return { ...out, status: 'invalid', error: e.message }; }
  out.store = origin;
  // Public stores only: never private or internal addresses (tests set ALLOW_LOCAL_TARGETS=1 for the mock store).
  try { await assertPublicTarget(origin); } catch (e) { return { ...out, status: 'invalid', error: e.message }; }
  const storeHost = new URL(origin).host;
  const visited = new Set();
  let robots = { rules: [], delayMs: 0 };
  let lastAt = 0;
  // One visit per page: a path is never requested twice, and every request waits for the crawl delay.
  const claim = async (kind, path) => {
    if (visited.has(path)) throw new Error(`already visited ${path}`);
    visited.add(path);
    const wait = lastAt + Math.max(robots.delayMs, minGapMs) - Date.now();
    if (lastAt && wait > 0) await sleep(wait);
    lastAt = Date.now();
    log({ kind, path });
  };
  const allowed = (path, label) => {
    if (robotsAllows(robots, path)) return true;
    out.skipped.push(`${label} (robots.txt)`);
    return false;
  };

  // robots.txt first. Missing (4xx) means no rules; an error from the store means we stay away.
  if (typeof robotsText === 'string') {
    // The caller already read robots.txt for this store (once is enough): use its rules.
    visited.add('/robots.txt');
    robots = parseRobots(robotsText);
  } else try {
    await claim('fetch', '/robots.txt');
    const r = await fetch(origin + '/robots.txt', { headers: { 'user-agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (r.status >= 500) return { ...out, status: 'skipped', error: `robots.txt answered ${r.status}`, skipped: ['whole store (robots.txt unavailable)'] };
    if (r.ok) robots = parseRobots(await r.text());
  } catch (e) {
    return { ...out, status: 'unreachable', error: `Could not reach the store (${e.cause?.code || e.message})` };
  }
  if (!robotsAllows(robots, '/')) return { ...out, status: 'skipped', skipped: ['whole store (robots.txt)'] };
  // A Crawl-delay longer than we wait between pages: stay away rather than visit faster than the store asks.
  if (robots.delayMs > MAX_CRAWL_DELAY_MS) return { ...out, status: 'skipped', error: `crawl delay too long (${Math.round(robots.delayMs / 1000)} s)`, skipped: ['whole store (robots.txt Crawl-delay)'] };

  const ctx = await browser.newContext({
    userAgent: USER_AGENT, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'en-US',
  });
  // The checker never types into a page or submits a form other than Add to cart; pop-up dialogs are closed.
  ctx.on('page', (p) => p.on('dialog', (d) => d.dismiss().catch(() => {})));
  const page = await ctx.newPage();
  try {
    // 1. Home page, on a phone.
    await claim('page', '/');
    const t0 = Date.now();
    const res = await page.goto(origin + '/', { waitUntil: 'load', timeout: PAGE_TIMEOUT }).catch((e) => ({ error: e }));
    if (res?.error || !res) { out.home_ok = false; out.status = 'unreachable'; out.error = 'The home page did not load'; out.findings.push('The home page did not load'); return out; }
    out.home_load_ms = Date.now() - t0;
    out.home_ok = res.status() < 400;
    if (!out.home_ok) { out.findings.push(`The home page answered with an error (${res.status()})`); out.status = 'error'; return out; }
    if (/\/password\/?$/.test(new URL(page.url()).pathname)) { out.status = 'locked'; out.findings.push('The store is password protected'); return out; }
    out.phone_lcp_ms = await page.evaluate(() => new Promise((resolve) => {
      let v = null;
      try { new PerformanceObserver((l) => { const e = l.getEntries().at(-1); if (e) v = Math.round(e.startTime); }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
      setTimeout(() => resolve(v), 300);
    })).catch(() => null);
    const shopDomain = await page.evaluate(() => (window.Shopify && window.Shopify.shop) || null).catch(() => null);
    const speed = out.phone_lcp_ms ?? out.home_load_ms;
    if (speed > SLOW_PHONE_MS) out.findings.push(`The home page is slow on phones (${(speed / 1000).toFixed(1)} s before the main content shows)`);

    // 2. products.json: prices of zero.
    let firstHandle = null;
    if (allowed('/products.json?limit=250', 'product list')) {
      await claim('fetch', '/products.json?limit=250');
      const pr = await fetch(origin + '/products.json?limit=250', { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(20000) }).catch(() => null);
      const data = pr && pr.ok ? await pr.json().catch(() => null) : null;
      if (!data || !Array.isArray(data.products)) {
        if (!shopDomain) { out.status = 'not_shopify'; out.findings.push('Not a Shopify store'); return out; }
        out.skipped.push('product list (not available)');
      } else {
        const list = data.products;
        out.products = list.length;
        const zero = list.filter((p) => (p.variants || []).some((v) => v.available !== false && Number(v.price) === 0));
        out.zero_price_products = zero.length;
        if (zero.length) {
          out.zero_price_example = `/products/${zero[0].handle}`;
          out.findings.push(`${zero.length} product${zero.length === 1 ? ' is' : 's are'} for sale at a price of zero`);
        }
        firstHandle = list.find((p) => (p.variants || []).some((v) => v.available !== false && Number(v.price) > 0))?.handle || null;
      }
    }

    // 3. One product page: does it load, and is Add to cart there and usable?
    if (firstHandle && allowed(`/products/${firstHandle}`, 'product page')) {
      const path = `/products/${firstHandle}`;
      await claim('page', path);
      const r = await page.goto(origin + path, { waitUntil: 'load', timeout: PAGE_TIMEOUT }).catch(() => null);
      out.product_page_ok = !!r && r.status() < 400;
      if (!out.product_page_ok) out.findings.push('A product page did not load');
    }
    if (out.product_page_ok) {
      const btn = page.locator('form[action*="/cart/add"] [type=submit], form[action*="/cart/add"] button[name=add], button[name=add]').first();
      const present = await btn.count().catch(() => 0);
      const enabled = present ? await btn.isEnabled().catch(() => false) : false;
      if (!present) { out.add_to_cart = 'missing'; out.findings.push('No Add to cart button on a product page'); }
      else if (!enabled) { out.add_to_cart = 'disabled'; out.findings.push('The Add to cart button is greyed out on an in-stock product'); }
      else if (!['/cart/add', '/cart/add.js', '/cart.js'].every((x) => robotsAllows(robots, x))) { out.add_to_cart = 'button present'; out.skipped.push('add to cart (robots.txt)'); }
      else {
        // 4. Add to cart (one click) and confirm with the cart (one request).
        await claim('page', '/cart/add (click)');
        await btn.click({ timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2500);
        await claim('fetch', '/cart.js');
        const count = await page.evaluate(async () => { try { const r = await fetch('/cart.js', { headers: { accept: 'application/json' } }); return (await r.json()).item_count; } catch { return null; } }).catch(() => null);
        out.add_to_cart = count > 0 ? 'works' : 'broken';
        if (!(count > 0)) out.findings.push('Add to cart does nothing: the cart stays empty');
      }
    }

    // 5. Checkout: where does it open? Nothing is typed and no order is placed.
    if (out.add_to_cart === 'works' && allowed('/checkout', 'checkout')) {
      await claim('page', '/checkout');
      const r = await page.goto(origin + '/checkout', { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT }).catch(() => null);
      const final = new URL(page.url());
      out.checkout_host = final.host;
      if (!r || r.status() >= 400) { out.checkout = 'error'; out.findings.push('Checkout did not open'); }
      else if (!checkoutHostOk(final.host, { storeHost, shopDomain })) { out.checkout = 'other website'; out.findings.push(`Checkout opens on another website (${final.host})`); }
      else if (!/\/checkouts?\b/.test(final.pathname)) { out.checkout = 'not reached'; out.findings.push('Checkout sends shoppers back instead of opening'); }
      else out.checkout = 'works';
    } else if (out.add_to_cart === 'works') out.checkout = 'not checked';
    return out;
  } catch (e) {
    out.status = 'error';
    out.error = String(e.message || e).slice(0, 200);
    return out;
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Checks a list of stores, at most two at a time. `onResult` is called as each store finishes. */
export async function checkStores(inputs, { concurrency = MAX_CONCURRENCY, onResult = () => {}, log, browser: given } = {}) {
  const limit = Math.max(1, Math.min(MAX_CONCURRENCY, Number(concurrency) || MAX_CONCURRENCY));
  const browser = given || await chromium.launch({ executablePath: config.chromePath || process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  const seen = new Set();
  const list = [];
  for (const raw of inputs) { let k; try { k = normalizeTarget(raw); } catch { k = String(raw); } if (!seen.has(k)) { seen.add(k); list.push(raw); } }
  const results = new Array(list.length);
  let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        results[i] = await checkStore(list[i], { browser, log: log ? (e) => log({ store: list[i], ...e }) : undefined });
        onResult(results[i]);
      }
    }));
  } finally { if (!given) await browser.close().catch(() => {}); }
  return results;
}

// ---------- CSV ----------
export const COLUMNS = ['store', 'checked_at', 'status', 'home_ok', 'home_load_ms', 'phone_lcp_ms', 'products', 'zero_price_products', 'zero_price_example',
  'product_page_ok', 'add_to_cart', 'checkout', 'checkout_host', 'findings', 'skipped', 'error'];
const cell = (v) => { const s = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (rows) => [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(','))].join('\n') + '\n';

/** Reads store addresses from CSV text: the column named url/store/domain/website, else the first column. */
export function readStoreList(text) {
  const rows = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '').trim()));
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.toLowerCase());
  const col = head.findIndex((h) => ['url', 'store', 'domain', 'website', 'store_url'].includes(h));
  const body = col >= 0 ? rows.slice(1) : rows;
  return body.map((r) => r[col >= 0 ? col : 0]).filter((x) => x && /[a-z0-9-]\.[a-z]/i.test(x) || /^https?:\/\//i.test(x || ''));
}
