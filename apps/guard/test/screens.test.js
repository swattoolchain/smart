// The main screens in a real browser, with screenshots kept as evidence.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait, shopifyToken } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

describe('Screens', () => {
  let P, owner, storeId, run, browser;
  before(async () => {
    P = await startProduct();
    owner = await signup(P, 'screens@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    run = await runAndWait(owner, storeId, { kind: 'full' }, 300000);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  async function page(viewport = { width: 1360, height: 900 }) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.errors = errors;
    return p;
  }
  const quiet = (p) => p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));

  it('the full check finished', () => {
    assert.equal(run.status, 'done', run.error || '');
  });

  it('home shows whether customers can buy, the daily numbers, attention list and quick actions', async (t) => {
    const p = await page();
    await p.goto(`${P.base}/app#/s/${storeId}`);
    await p.waitForSelector('.kpis', { timeout: 20000 });
    await quiet(p);
    assert.match(await p.textContent('.panel.status h2'), /Customers/);
    assert.ok((await p.locator('.kpi').count()) >= 6, 'at least 6 number tiles');
    assert.equal(await p.locator('.qa').count(), 5, 'five quick actions');
    assert.ok(await p.locator('[data-tour=fix]').isVisible());
    await screenshot(t, p, 'Home dashboard', { fullPage: true });
    assert.deepEqual(p.errors, []);
    note(t, `${await p.locator('.kpi').count()} tiles, ${await p.locator('.act-feed li').count()} activity rows`);
  });

  it('the sale readiness quick action opens the run page with the sale checks chosen', async (t) => {
    const p = await page();
    await p.goto(`${P.base}/app#/s/${storeId}`);
    await p.waitForSelector('[data-preset=sale]');
    await quiet(p);
    await p.click('[data-preset=sale]');
    await p.waitForFunction(() => location.hash.endsWith('/run'));
    await p.waitForTimeout(800);
    assert.match(await p.textContent('body'), /SALE READINESS|Sale readiness/);
    await screenshot(t, p, 'Run page with sale readiness');
  });

  it('a report shows its sections as tabs, one at a time', async (t) => {
    const p = await page();
    await p.goto(`${P.base}/app#/s/${storeId}/reports/${run.id}`);
    await p.waitForSelector('.rtabs button', { timeout: 20000 });
    await quiet(p);
    const tabs = p.locator('.rtabs button');
    const n = await tabs.count();
    assert.ok(n >= 3, `expected several tabs, got ${n}`);
    await screenshot(t, p, 'Report, first tab');
    await tabs.nth(1).click();
    await p.waitForTimeout(300);
    assert.equal(await p.locator('.rtab-pane:not([hidden])').count(), 1, 'exactly one section visible');
    await screenshot(t, p, 'Report, second tab');
    note(t, `${n} tabs: ${(await tabs.allTextContents()).map((x) => x.trim()).join(', ')}`);
    assert.deepEqual(p.errors, []);
  });

  it('home works on a phone', async (t) => {
    const p = await page({ width: 390, height: 844 });
    await p.goto(`${P.base}/app#/s/${storeId}`);
    await p.waitForSelector('.kpis', { timeout: 20000 });
    await quiet(p);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `page scrolls sideways by ${overflow}px`);
    await screenshot(t, p, 'Home on a phone', { fullPage: true });
  });

  it('the sign-in page offers an emailed link', async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await p.goto(`${P.base}/app`);
    await p.click('text=Email me a sign-in link instead');
    await p.waitForSelector('#lnk');
    await p.fill('#email', 'nobody@nowhere.test');
    await p.click('#lnk button');
    await p.waitForSelector('text=Check your email');
    await screenshot(t, p, 'Sign-in link sent');
  });

  it('a new Shopify install opens on the onboarding welcome inside Shopify admin', async (t) => {
    const shop = 'screens-onboarding.myshopify.com';
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 } });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.route('https://cdn.shopify.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.shopify={idToken:async()=>${JSON.stringify(shopifyToken(shop, { expIn: 600 }))}};` }));
    await p.goto(`${P.base}/shopify?shop=${shop}`);
    await p.waitForFunction(() => /welcome/.test(location.hash), null, { timeout: 20000 });
    await p.waitForTimeout(800);
    await screenshot(t, p, 'Shopify onboarding, step 1', { fullPage: true });
    assert.deepEqual(errors, []);
  });

  it('a Shopify owner can turn on browser access from the Account page', async (t) => {
    const shop = 'screens-account.myshopify.com';
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 } });
    const p = await ctx.newPage();
    await p.route('https://cdn.shopify.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.shopify={idToken:async()=>${JSON.stringify(shopifyToken(shop, { expIn: 600 }))}};` }));
    await p.goto(`${P.base}/shopify/account?shop=${shop}`);
    await p.waitForSelector('#wa-form', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask').forEach((x) => x.remove()));
    await p.fill('#wa-form input', 'owner@screens.test');
    await p.click('#wa-form button');
    await p.waitForSelector('text=We sent a link');
    await screenshot(t, p, 'Browser access: confirmation sent');
  });
});
