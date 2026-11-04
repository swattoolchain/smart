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

export async function newContext({ mobile = false, tablet = false } = {}) {
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
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    ignoreHTTPSErrors: false,
  });
  // Remove the automation fingerprints that bot protection looks for first.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    if (!window.chrome) window.chrome = { runtime: {} };
  });
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
export async function gotoStore(page, url, { password, timeout = 30000 } = {}) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  if (/\/password(\?|$)/.test(new URL(page.url()).pathname + new URL(page.url()).search)) {
    if (!password) return { res, locked: true };
    const input = page.locator('input[type="password"]').first();
    await input.fill(password, { timeout: 5000 });
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      input.press('Enter'),
    ]);
    await page.waitForTimeout(1500);
    if (/\/password/.test(page.url())) return { res, locked: true, wrongPassword: true };
    const again = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    return { res: again, locked: false };
  }
  return { res, locked: false };
}

export async function settle(page, ms = 1200) {
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(ms);
}
