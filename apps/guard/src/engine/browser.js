import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { config } from '../config.js';

let browserPromise = null;

export async function getBrowser() {
  if (!browserPromise) {
    const opts = {
        headless: true,
        executablePath: config.chromePath,
        proxy: config.browserProxy ? { server: config.browserProxy } : undefined,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          '--no-first-run',
          '--disable-default-apps',
        ],
      };
    // Full Chromium in new headless mode looks like a normal browser to bot protection;
    // fall back to the default headless build if it isn't installed.
    browserPromise = (config.chromePath ? chromium.launch(opts) : chromium.launch({ ...opts, channel: 'chromium' }).catch(() => chromium.launch(opts)))
      .then((b) => {
        b.on('disconnected', () => (browserPromise = null));
        return b;
      })
      .catch((e) => {
        browserPromise = null;
        throw e;
      });
  }
  return browserPromise;
}

export async function newContext({ mobile = false, tablet = false, locale = 'en-US', timezoneId = 'Asia/Kolkata' } = {}) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: mobile
      ? config.userAgent.replace('Windows NT 10.0; Win64; x64', 'Linux; Android 14; Pixel 8') + ' Mobile'
      : tablet
        ? config.userAgent.replace('Windows NT 10.0; Win64; x64', 'Linux; Android 14; Pixel Tablet')
        : config.userAgent,
    viewport: mobile ? { width: 390, height: 844 } : tablet ? { width: 820, height: 1180 } : { width: 1366, height: 900 },
    deviceScaleFactor: 1,
    isMobile: mobile || tablet,
    hasTouch: mobile || tablet,
    locale,
    timezoneId,
    extraHTTPHeaders: { 'Accept-Language': locale === 'en-US' ? 'en-US,en;q=0.9' : `${locale},${locale.slice(0, 2)};q=0.9,en;q=0.8` },
    ignoreHTTPSErrors: false,
  });
  // Remove the automation fingerprints that bot protection looks for first.
  await ctx.addInitScript((langs) => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => langs });
    if (!window.chrome) window.chrome = { runtime: {} };
  }, [locale, locale.slice(0, 2)]);
  return ctx;
}

/** Waits for an automatic (JavaScript) challenge to clear before declaring the page blocked. */
export async function settleChallenge(page, res, waitMs = 12000) {
  let c = await detectChallenge(page, res);
  const until = Date.now() + waitMs;
  while (c.blocked && Date.now() < until) {
    await page.waitForTimeout(2000);
    c = await detectChallenge(page, null);
  }
  return c;
}

/**
 * Recognises bot-protection pages (Cloudflare, Shopify's verification, Akamai, PerimeterX, DataDome, Incapsula),
 * so a blocked test is reported as "blocked", never as "your store is broken".
 */
export async function detectChallenge(page, res) {
  try {
    const status = res ? res.status() : 0;
    const headers = res ? res.headers() : {};
    const url = page.url();
    const title = (await page.title().catch(() => '')) || '';
    const body = ((await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '')) || '').toLowerCase();
    const cf = !!headers['cf-ray'] || /cloudflare/i.test(headers.server || '');
    if (/just a moment|attention required|checking your browser|verify you are human/i.test(title) || /cf_chl_opt|cf-chl-widget|id="challenge-form"/.test(await page.content().catch(() => '')))
      return { blocked: true, vendor: 'Cloudflare' };
    if (/\/challenge|checkpoint/.test(new URL(url).pathname) || /your connection needs to be verified|verify your connection/.test(body))
      return { blocked: true, vendor: 'Shopify bot protection' };
    if (/access denied/i.test(title) && /reference #|akamai/.test(body)) return { blocked: true, vendor: 'Akamai' };
    if (/px-captcha|perimeterx|human verification/.test(body)) return { blocked: true, vendor: 'PerimeterX' };
    if (/datadome/.test(body) || headers['x-datadome']) return { blocked: true, vendor: 'DataDome' };
    if (/incapsula incident/.test(body)) return { blocked: true, vendor: 'Imperva' };
    if ((status === 403 || status === 429 || status === 503) && cf) return { blocked: true, vendor: 'Cloudflare' };
    return { blocked: false };
  } catch {
    return { blocked: false };
  }
}

/** Normalises a user-entered store address into an origin like https://shop.com */
export function normalizeStoreUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter your store URL');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('That does not look like a valid URL');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are supported');
  const host = u.hostname.toLowerCase();
  // Block obviously internal targets so the scanner cannot be pointed at private networks.
  const allowLocal = process.env.ALLOW_LOCAL_TARGETS === '1';
  if (
    !allowLocal &&
    (host === 'localhost' ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === '[::1]')
  ) {
    throw new Error('Internal addresses cannot be scanned');
  }
  if (!host.includes('.') && !allowLocal) throw new Error('Enter a full domain like yourstore.com');
  return `${u.protocol}//${u.host}`;
}

const PRIVATE_IP = /^(127\.|10\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)|^(::1|fc|fd|fe80)/i;

/** Rejects domains that resolve to private or loopback addresses (prevents scanning internal networks). */
export async function assertPublicTarget(origin) {
  if (process.env.ALLOW_LOCAL_TARGETS === '1') return;
  const { lookup } = await import('node:dns/promises');
  const host = new URL(origin).hostname;
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`We couldn't find ${host}. Check the address is correct.`);
  }
  if (addrs.some((a) => PRIVATE_IP.test(a.address))) throw new Error('This address points to a private network and cannot be scanned');
}

/** Opens a page and gets past a Shopify storefront password page when a password is provided. */
// Unlocked storefront sessions, shared by every browser in a run and reused by later runs, so a
// password-protected store sees one password login every few hours instead of several per test.
// Repeated password logins from a server are what trigger Shopify's bot protection.
const unlocked = new Map(); // origin -> { key, cookies, at }
const UNLOCK_TTL = 6 * 3600e3;
const pwKey = (password) => crypto.createHash('sha256').update(String(password)).digest('hex').slice(0, 16);
const onPasswordPage = (page) => { try { return /\/password(\?|$)/.test(new URL(page.url()).pathname + new URL(page.url()).search); } catch { return false; } };

/** Unlocks a password-protected Shopify storefront for this browser context. Returns 'ok', 'wrong' or 'blocked'. */
async function unlock(page, origin, password) {
  const ctx = page.context();
  // 1. A recent unlock for this store and password: reuse its cookies.
  const hit = unlocked.get(origin);
  if (hit && hit.key === pwKey(password) && Date.now() - hit.at < UNLOCK_TTL) {
    await ctx.addCookies(hit.cookies).catch(() => {});
    return 'reused';
  }
  // 2. Submit the password form directly, the way the page itself would.
  const r = await ctx.request.post(`${origin}/password`, {
    form: { form_type: 'storefront_password', utf8: '✓', password: String(password) }, maxRedirects: 0, timeout: 20000,
  }).catch(() => null);
  let cookies = (await ctx.cookies(origin)).filter((c) => /storefront_digest|_shopify|secure_customer_sig|cart/.test(c.name));
  if (!cookies.some((c) => c.name === 'storefront_digest')) {
    // 3. Fall back to typing it into the page, and let an automatic bot check finish if one appears.
    if (!onPasswordPage(page)) await page.goto(`${origin}/password`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const input = page.locator('input[type="password"]').first();
    if (await input.count().catch(() => 0)) {
      await input.fill(String(password), { timeout: 5000 }).catch(() => {});
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), input.press('Enter').catch(() => {})]);
      await page.waitForTimeout(1500);
    }
    const c = await settleChallenge(page, null, 15000);
    if (c.blocked) return 'blocked';
    cookies = (await ctx.cookies(origin)).filter((x) => /storefront_digest|_shopify|secure_customer_sig|cart/.test(x.name));
    if (!cookies.some((x) => x.name === 'storefront_digest')) return onPasswordPage(page) ? 'wrong' : 'blocked';
  }
  unlocked.set(origin, { key: pwKey(password), cookies: cookies.filter((c) => c.name === 'storefront_digest'), at: Date.now() });
  return 'ok';
}

export async function gotoStore(page, url, { password, timeout = 30000 } = {}) {
  const origin = new URL(url).origin;
  // Known password: unlock before the first visit, so the password page (and its bot checks) are skipped.
  const cached = password && unlocked.get(origin);
  if (cached && cached.key === pwKey(password) && Date.now() - cached.at < UNLOCK_TTL) await page.context().addCookies(cached.cookies).catch(() => {});
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  if (!onPasswordPage(page)) return { res, locked: false };
  if (!password) return { res, locked: true };
  unlocked.delete(origin); // the cached session (if any) no longer works
  const how = await unlock(page, origin, password);
  if (how === 'wrong') return { res, locked: true, wrongPassword: true };
  if (how === 'blocked') return { res, locked: true, blockedByChallenge: true };
  const again = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  if (onPasswordPage(page)) { unlocked.delete(origin); return { res: again, locked: true, wrongPassword: true }; }
  return { res: again, locked: false };
}

export async function settle(page, ms = 1200) {
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

/** Which Shopify theme the page is showing ({ id, name, role }), from the storefront's own Shopify.theme. */
export async function themeOf(page) {
  return page.evaluate(() => { const t = window.Shopify && window.Shopify.theme; return t ? { id: t.id, name: t.name, role: t.role } : null; }).catch(() => null);
}

/**
 * Opens a Shopify theme preview link in this page's browser context. Shopify keeps the draft theme for the
 * whole session, so every later visit in the context shows it. Share-preview links can redirect to the
 * .myshopify.com domain; the returned origin is where the preview session lives.
 */
export async function openPreview(page, previewUrl, { password } = {}) {
  await page.context().addInitScript(() => {
    const css = '#preview-bar-iframe,#PBarNextFrameWrapper,#PBarNextFrame,#preview-bar,.preview-bar{display:none!important}';
    const add = () => { if (document.head && !document.getElementById('tg-hide-pbar')) { const s = document.createElement('style'); s.id = 'tg-hide-pbar'; s.textContent = css; document.head.appendChild(s); } };
    add();
    document.addEventListener('DOMContentLoaded', add);
  });
  await gotoStore(page, previewUrl, { password });
  await settle(page, 600);
  return { origin: new URL(page.url()).origin, theme: await themeOf(page) };
}
