// Onboarding inside Shopify admin: four steps, the first check, the tour once, and the guide.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, shopifyOpen, shopifyToken } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

async function embedded(browser, P, shop) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  await p.route('https://cdn.shopify.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.shopify={idToken:async()=>${JSON.stringify(shopifyToken(shop, { expIn: 1200 }))}};` }));
  await p.goto(`${P.base}/shopify?shop=${shop}`);
  return p;
}
const waitRunDone = async (s, storeId) => {
  for (let i = 0; i < 240; i++) {
    const st = (await s.get('/api/stores')).json.stores.find((x) => x.id === storeId);
    if (!st.active_run_id) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('first check did not finish');
};

describe('Onboarding', () => {
  let P, browser;
  before(async () => {
    P = await startProduct();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('a new install walks through four steps, starts the first check, and sees the tour once', { timeout: 400000 }, async (t) => {
    const shop = 'onboard-me.myshopify.com';
    const p = await embedded(browser, P, shop);
    const api = P.session({ shop });

    // Step 1: welcome
    await p.waitForFunction(() => /welcome/.test(location.hash), null, { timeout: 30000 });
    await p.waitForSelector('#n');
    await screenshot(t, p, 'Step 1: welcome');
    await p.click('#n');

    // Step 2: your store (discovered from the storefront)
    await p.waitForSelector('#n:not([disabled])', { timeout: 60000 });
    await screenshot(t, p, 'Step 2: your store');
    await p.click('#n');

    // Step 3: alerts and schedule
    await p.waitForSelector('#af', { timeout: 20000 });
    await p.fill('#ae', 'owner@onboard.test');
    await p.fill('input[name=dailySales]', '50000');
    await screenshot(t, p, 'Step 3: alerts and schedule');
    await p.fill('#ae', 'not-an-email');
    await p.click('#n');
    assert.match(await p.textContent('#af-err'), /valid email/);
    await p.fill('#ae', 'owner@onboard.test');
    await p.click('#n');

    // Step 4: the first check
    await p.waitForSelector('.onb-plan', { timeout: 20000 });
    await screenshot(t, p, 'Step 4: your first check');
    await p.click('#n');
    await p.waitForFunction(() => /\/runs\/\d+/.test(location.hash), null, { timeout: 20000 });

    const store = (await api.get('/api/stores')).json.stores[0];
    assert.ok(store.config.onboarded, 'setup marked done');
    assert.equal(store.alert_email, 'owner@onboard.test');
    assert.equal(Number(store.config.dailySales), 50000);
    assert.ok(store.monitoring, 'monitoring on');
    note(t, `saved: onboarded, alerts to ${store.alert_email}, daily sales ${store.config.dailySales}, monitoring on`);

    // The tour, once, after the first results
    await waitRunDone(api, store.id);
    await p.evaluate((id) => { location.hash = `#/s/${id}`; }, store.id);
    await p.waitForSelector('.tour [data-t=next]', { timeout: 30000 });
    await screenshot(t, p, 'Tour: first step');
    let steps = 0;
    while (await p.locator('.tour [data-t=next]').count()) { await p.click('.tour [data-t=next]'); steps++; await p.waitForTimeout(150); if (steps > 10) break; }
    assert.ok(steps >= 4, `tour had ${steps} steps`);
    await p.waitForTimeout(500);
    assert.ok((await api.get('/api/stores')).json.stores[0].config.toured, 'tour marked seen');
    await p.reload();
    await p.waitForSelector('.kpis', { timeout: 30000 });
    await p.waitForTimeout(800);
    assert.equal(await p.locator('.tour').count(), 0, 'the tour does not come back');
    assert.deepEqual(p.errors, []);
  });

  it('opening the app before finishing setup returns to the setup steps', async () => {
    const shop = 'unfinished.myshopify.com';
    await shopifyOpen(P, shop);
    const p = await embedded(browser, P, shop);
    await p.waitForFunction(() => /welcome/.test(location.hash), null, { timeout: 30000 });
    await p.evaluate(() => { location.hash = location.hash.replace('/welcome', '/reports'); });
    await p.waitForTimeout(800);
    assert.match(await p.evaluate(() => location.hash), /welcome/, 'other pages wait until setup is done');
  });

  it('the guide explains daily use, and can restart setup or the tour', async (t) => {
    const shop = 'onboard-me.myshopify.com';
    const p = await embedded(browser, P, shop);
    await p.waitForSelector('.kpis', { timeout: 30000 });
    await p.evaluate(() => { location.hash = '#/guide'; });
    await p.waitForSelector('#replay', { timeout: 20000 });
    await screenshot(t, p, 'How to use Tharam', { fullPage: true });
    await p.click('#replay');
    await p.waitForSelector('.tour [data-t=next]', { timeout: 20000 });
    await p.click('.tour [data-t=skip]');
    await p.evaluate(() => { location.hash = '#/guide'; });
    await p.waitForSelector('#resetup');
    await p.click('#resetup');
    await p.waitForFunction(() => /welcome/.test(location.hash), null, { timeout: 20000 });
  });
});

describe('Onboarding a password-protected store', () => {
  let P, browser;
  before(async () => {
    P = await startProduct({ mock: { breaks: 'password' } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('asks for the storefront password, refuses a wrong one and accepts the right one', { timeout: 120000 }, async (t) => {
    const shop = 'locked-store.myshopify.com';
    const p = await embedded(browser, P, shop);
    await p.waitForSelector('#n', { timeout: 30000 });
    await p.click('#n');
    await p.waitForSelector('#pwf', { timeout: 60000 });
    assert.equal(await p.locator('#n[disabled]').count(), 1, 'cannot continue while the store is locked');
    await screenshot(t, p, 'Step 2: password-protected store');
    await p.fill('#pwf input', 'wrong-password');
    await p.click('#pwf button');
    await p.waitForFunction(() => document.querySelector('#pw-err')?.textContent.trim().length > 0, null, { timeout: 60000 });
    note(t, `wrong password: "${(await p.textContent('#pw-err')).trim()}"`);
    await p.fill('#pwf input', 'letmein');
    await p.click('#pwf button');
    await p.waitForSelector('#n:not([disabled])', { timeout: 60000 });
    await screenshot(t, p, 'Step 2: password accepted');
  });
});
