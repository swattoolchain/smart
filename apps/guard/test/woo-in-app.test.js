// WooCommerce stores in the app: add-store finds the store and its products, the test product picker lists
// them by slug, shopping tests are offered, and the website says so. Behind the 'woocommerce' switch.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, startWooMock, signup, addStore } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

describe('WooCommerce stores in the app', { concurrency: 1 }, () => {
  let P, woo, owner, other, browser;
  before(async () => {
    P = await startProduct();
    woo = await startWooMock();
    owner = await signup(P);
    other = await signup(P);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); woo?.stop(); await P?.stop(); });

  it('looking up a WooCommerce store says it is WooCommerce and lists the products that can be bought', async (t) => {
    const r = await owner.post('/api/discover', { url: woo.origin });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.isWoo, true);
    assert.equal(r.json.isShopify, false);
    assert.equal(r.json.platform.label, 'WooCommerce');
    assert.ok(r.json.productCount >= 2, 'products counted');
    const slugs = r.json.catalog.map((p) => p.handle);
    assert.ok(slugs.includes('copper-bottle') && slugs.includes('linen-shirt'));
    assert.ok(!slugs.includes('clay-pot'), 'sold-out products are not offered');
    assert.equal(r.json.catalog.find((p) => p.handle === 'linen-shirt').variants, 2);
    assert.equal(r.json.suggested, 'copper-bottle');
    note(t, `found: ${r.json.platform.label}, ${r.json.productCount} products, picker offers ${slugs.join(', ')}`);
  });

  it('refuses a lookup without an account and a bad address', async () => {
    const anon = P.session();
    assert.equal((await anon.post('/api/discover', { url: woo.origin })).status, 401);
    assert.equal((await owner.post('/api/discover', { url: 'not a store' })).status, 400);
  });

  it('a saved WooCommerce store lists its products for the picker, and only to its owner', async (t) => {
    const id = await addStore(P, owner, { url: woo.origin, name: 'Woo', platform: 'WooCommerce', runNow: false, config: { testProduct: 'linen-shirt' } });
    const r = await owner.post(`/api/stores/${id}/discover`);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.catalog.some((p) => p.handle === 'linen-shirt'));
    const store = (await owner.get('/api/stores')).json.stores.find((s) => s.id === id);
    assert.equal(store.platform, 'WooCommerce');
    assert.equal(store.config.testProduct, 'linen-shirt');
    assert.equal((await other.post(`/api/stores/${id}/discover`)).status, 404, 'another account cannot look at it');
    note(t, 'owner gets the product list; another account gets 404');
  });

  it('the shopping tests are offered for a WooCommerce store (the run plan does not say Shopify only)', async () => {
    const id = await addStore(P, owner, { url: woo.origin.replace('localhost', '127.0.0.1'), name: 'Woo 2', platform: 'WooCommerce', runNow: false });
    const cat = (await owner.get('/api/catalog')).json;
    assert.ok(cat.groups.some((g) => g.key.startsWith('journey.')));
    assert.ok(id);
  });

  it('add-store in the browser: "WooCommerce store found, N products", the picker, and shopping tests switched on', async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await ctx.addCookies(other.browserCookies()); // an account that has not added this store yet
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#/add`);
    await p.waitForSelector('#wurl');
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask').forEach((x) => x.remove()));
    await p.fill('#wurl', woo.origin + '/');
    await p.click('#w1 button[type=submit]');
    await p.waitForSelector('.found', { timeout: 60000 });
    const text = await p.textContent('.wiz-card');
    assert.match(text, /WooCommerce store found, \d+ products/);
    assert.doesNotMatch(text, /tests run on Shopify today/);
    const opts = await p.locator('#wtp option').allTextContents();
    assert.ok(opts.some((o) => /Copper Water Bottle/.test(o)), 'the picker lists WooCommerce products');
    assert.ok(opts.some((o) => /Linen Shirt \(2 variants\)/.test(o)));
    assert.ok(!opts.some((o) => /Clay Water Pot/.test(o)));
    assert.equal(await p.locator('input[name=g][value^="journey."]:not([disabled])').count() > 0, true, 'shopping test rows can be switched on');
    assert.equal(await p.locator('input[name=g][value^="journey."]:checked').count() > 0, true, 'and are on to start with');
    await screenshot(t, p, 'Add a store: WooCommerce store found', { fullPage: true });
    await p.selectOption('#wtp', 'linen-shirt');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('the Test product page loads WooCommerce products by name', async (t) => {
    const id = (await owner.get('/api/stores')).json.stores.find((s) => s.name === 'Woo').id;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    await p.goto(`${P.base}/app#/s/${id}/suite/product`);
    await p.waitForSelector('#load-products');
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask').forEach((x) => x.remove()));
    await p.click('#load-products');
    await p.waitForFunction(() => /Showing \d+ in-stock products/.test(document.querySelector('#tp-hint')?.textContent || ''), null, { timeout: 60000 });
    const opts = await p.locator('#tp option').allTextContents();
    assert.ok(opts.some((o) => /Copper Water Bottle/.test(o)));
    await screenshot(t, p, 'Test product: WooCommerce products');
    await ctx.close();
  });

  it('the website says shopping tests are available for WooCommerce', async () => {
    const page = await (await fetch(`${P.base}/platforms/woocommerce`)).text();
    assert.match(page, /Shopping tests for your WooCommerce store/);
    assert.doesNotMatch(page, /in early access/);
    const faq = await (await fetch(`${P.base}/`)).text();
    assert.match(faq, /Shopify and WooCommerce stores get shopping tests/);
  });
});

describe('WooCommerce stores in the app: switch off', () => {
  let P, woo, owner;
  before(async () => {
    P = await startProduct({ env: { FEATURES_DEFAULT: '', CSP_MODE: '' } });
    woo = await startWooMock();
    owner = await signup(P);
  });
  after(async () => { woo?.stop(); await P?.stop(); });

  it('while off, the app does not announce WooCommerce shopping tests and the website keeps its old words', async (t) => {
    const r = await owner.post('/api/discover', { url: woo.origin });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.isWoo, false, 'not announced while the switch is off');
    const page = await (await fetch(`${P.base}/platforms/woocommerce`)).text();
    assert.match(page, /early access/);
    assert.doesNotMatch(page, /Shopping tests for your WooCommerce store/);
    assert.ok(!(await owner.get('/api/me')).json.features.includes('woocommerce'));
    note(t, 'switch off: isWoo false, website unchanged');
  });
});
