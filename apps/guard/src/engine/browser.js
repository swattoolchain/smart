import { chromium } from 'playwright';
import { config } from '../config.js';

let browserPromise = null;

export async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        executablePath: config.chromePath,
        args: [
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          '--no-first-run',
          '--disable-default-apps',
        ],
      })
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

export async function newContext({ mobile = false } = {}) {
  const browser = await getBrowser();
  return browser.newContext({
    userAgent: mobile
      ? config.userAgent.replace('Windows NT 10.0; Win64; x64', 'Linux; Android 14; Pixel 8') + ' Mobile'
      : config.userAgent,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'en-US',
    ignoreHTTPSErrors: false,
  });
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
