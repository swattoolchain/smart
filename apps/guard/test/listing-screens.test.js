// Shopify App Store listing screenshots (1600x900), taken from the real embedded app on a mock store.
// Run with WRITE_LISTING=1 to also save them to docs/listing/ for uploading to the Partner Dashboard.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, shopifyOpen, shopifyToken, runAndWait, ROOT } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const OUT = path.join(ROOT, 'docs', 'listing');
const SHOP = 'kaveri-handlooms.myshopify.com';

describe('Shopify listing screenshots', () => {
  let P, shop, storeId, full, browser, page;
  before(async () => {
    P = await startProduct({ mock: { extra: 'placeholder' } });
    shop = await shopifyOpen(P, SHOP);
    storeId = shop.storeId;
    await shop.patch(`/api/stores/${storeId}`, { name: 'Kaveri Handlooms', config: { onboarded: true, toured: true, markets: ['IN', 'DE'], dailySales: 85000, currency: 'INR' } });
    full = await runAndWait(shop, storeId, { kind: 'full' }, 300000);
    await runAndWait(shop, storeId, { kind: 'journeys' });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    // 1280x720 at 1.25x = 1600x900 images, with the app filling the frame as on a laptop.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.25 });
    page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    await page.route('https://cdn.shopify.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.shopify={idToken:async()=>${JSON.stringify(shopifyToken(SHOP, { expIn: 900 }))}};` }));
    await page.goto(`${P.base}/shopify?shop=${SHOP}`);
    await page.waitForSelector('.kpis', { timeout: 30000 });
    if (process.env.WRITE_LISTING) fs.mkdirSync(OUT, { recursive: true });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  async function capture(t, hash, waitFor, file, label) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForSelector(waitFor, { timeout: 30000 });
    await page.waitForTimeout(900);
    await page.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    await screenshot(t, page, label);
    if (process.env.WRITE_LISTING) await page.screenshot({ path: path.join(OUT, file) });
  }

  it('the full check on the sample store finished', () => assert.equal(full.status, 'done', full.error || ''));

  it('1. Home: can customers buy right now', async (t) => {
    await capture(t, `#/s/${storeId}`, '.kpis', '01-home.png', 'Home');
    note(t, 'Status banner, daily numbers, what needs attention, quick actions');
  });
  it('2. A report, one tab at a time', async (t) => capture(t, `#/s/${storeId}/reports/${full.id}`, '.rtabs', '02-report.png', 'Report'));
  it('3. Products with problems', async (t) => capture(t, `#/s/${storeId}/catalog`, '.main-inner h1', '03-products.png', 'Products'));
  it('4. Safe to publish', async (t) => capture(t, `#/s/${storeId}/publish`, '.main-inner h1', '04-safe-to-publish.png', 'Safe to publish'));
  it('5. Run a check', async (t) => capture(t, `#/s/${storeId}/run`, '.main-inner h1', '05-run-checks.png', 'Run checks'));
  it('6. Alerts', async (t) => capture(t, `#/s/${storeId}/alerts`, '.main-inner h1', '06-alerts.png', 'Alerts'));

  it('no errors in the app while taking the screenshots', () => assert.deepEqual(page.errors, []));
});
