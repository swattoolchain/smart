// WooCommerce stores: the shopping journey runs through the storefront and the public Store API.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startWooMock, startProduct, signup, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.ALLOW_LOCAL_TARGETS = '1';
process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-woo-'));
const { runScan } = await import('../src/engine/index.js');
const { getBrowser, newContext } = await import('../src/engine/browser.js');
const { discover } = await import('../src/engine/discover.js');

const byId = (r, id) => r.checks.find((c) => c.id === id);
const summary = (r) => r.checks.map((c) => `${c.id}:${c.status}`).join(' ');
let n = 0;
async function scan(opts = {}, scanOpts = {}) {
  const mock = await startWooMock(opts);
  try {
    return await runScan({ runId: `woo-${++n}-${Date.now()}`, origin: mock.origin, kind: 'journeys', ...scanOpts });
  } finally { mock.stop(); }
}

describe('WooCommerce: discovery', { concurrency: 1 }, () => {
  after(async () => { (await getBrowser()).close(); });

  it('finds products and categories through the Store API, simple in-stock products first', async (t) => {
    const mock = await startWooMock();
    const ctx = await newContext();
    try {
      const info = await discover(ctx.request, mock.origin);
      assert.equal(info.isWoo, true);
      assert.equal(info.isShopify, false);
      assert.equal(info.platform.key, 'woocommerce');
      assert.equal(info.products[0].handle, 'copper-bottle', 'the simple product goes first');
      assert.ok(!info.products.some((p) => p.handle === 'clay-pot'), 'sold-out products are never picked');
      assert.equal(info.products[0].variants[0].price, '1499.00', 'Store API minor units become a normal price');
      assert.equal(info.products[0].url, `${mock.origin}/product/copper-bottle/`);
      assert.deepEqual(info.collections.map((c) => c.handle), ['kitchen', 'clothing']);
      note(t, `products: ${info.products.map((p) => `${p.handle} (${p.type})`).join(', ')}; categories: ${info.collections.map((c) => c.title).join(', ')}`);
    } finally { await ctx.close(); mock.stop(); }
  });

  it('works on stores with plain permalinks (Store API at ?rest_route=)', async (t) => {
    const mock = await startWooMock({ extra: 'plain' });
    const ctx = await newContext();
    try {
      const info = await discover(ctx.request, mock.origin);
      assert.equal(info.isWoo, true);
      assert.equal(info.woo.base, '/?rest_route=/wc/store/v1');
      assert.ok(info.products.length >= 2);
      note(t, `Store API found at ${info.woo.base}`);
    } finally { await ctx.close(); mock.stop(); }
  });

  it('a chosen test product goes first', async () => {
    const mock = await startWooMock();
    const ctx = await newContext();
    try {
      const info = await discover(ctx.request, mock.origin, { testProduct: 'linen-shirt' });
      assert.equal(info.products[0].handle, 'linen-shirt');
      assert.deepEqual(info.products[0].variants.map((v) => v.id), [121, 122]);
    } finally { await ctx.close(); mock.stop(); }
  });
});

describe('WooCommerce: shopping journey', { concurrency: 1 }, () => {
  after(async () => { (await getBrowser()).close(); });

  it('a healthy store passes: shop page, search, product, Add to cart, cart and checkout', { timeout: 180000 }, async (t) => {
    const r = await scan();
    for (const id of ['fn.home', 'fn.collection', 'fn.search', 'fn.pdp', 'fn.atc', 'fn.cart', 'fn.checkout']) assert.equal(byId(r, id)?.status, 'pass', `${id}: ${summary(r)}`);
    assert.ok(!byId(r, 'fn.platform'), 'no "shopping tests not available" note');
    assert.equal(r.isWoo, true);
    assert.equal(r.platform.key, 'woocommerce');
    assert.notEqual(r.verdict, 'critical');
    assert.match(byId(r, 'fn.cart').detail, /1499\.00 INR/);
    note(t, `verdict ${r.verdict}, score ${r.score}; ${byId(r, 'fn.checkout').detail}`);
  });

  it('a product with options: the first option is chosen and it goes in the cart', { timeout: 180000 }, async (t) => {
    const r = await scan({}, { testProduct: 'linen-shirt' });
    assert.equal(byId(r, 'fn.atc')?.status, 'pass', summary(r));
    assert.match(byId(r, 'fn.atc').detail, /Linen Shirt.*first option/);
    assert.equal(byId(r, 'fn.checkout')?.status, 'pass', summary(r));
    note(t, byId(r, 'fn.atc').detail);
  });

  it('a broken Add to cart button is caught, and the cart is shown to still work', { timeout: 180000 }, async (t) => {
    const r = await scan({ breaks: 'atc' });
    const atc = byId(r, 'fn.atc');
    assert.equal(atc?.status, 'fail', summary(r));
    assert.match(atc.detail, /did not add anything, but WooCommerce's cart accepts the item/);
    assert.match(atc.fix, /plugin/);
    assert.ok(atc.evidence?.screenshot, 'screenshot attached');
    assert.equal(r.verdict, 'critical');
    note(t, atc.detail);
  });

  it('a cart that refuses the product is caught with WooCommerce’s own reason', { timeout: 180000 }, async (t) => {
    const r = await scan({ breaks: 'soldout' });
    const atc = byId(r, 'fn.atc');
    assert.equal(atc?.status, 'fail', summary(r));
    assert.match(atc.detail, /could not be added to the cart: You cannot add "that product" to the cart because the product is out of stock\.$/);
    assert.ok(!byId(r, 'fn.checkout'), 'checkout is not tested without an item in the cart');
    note(t, atc.detail);
  });

  it('a broken checkout is caught', { timeout: 180000 }, async (t) => {
    const r = await scan({ breaks: 'checkout' });
    assert.equal(byId(r, 'fn.atc')?.status, 'pass', summary(r));
    assert.equal(byId(r, 'fn.checkout')?.status, 'fail', summary(r));
    assert.match(byId(r, 'fn.checkout').detail, /HTTP 500/);
    note(t, byId(r, 'fn.checkout').detail);
  });

  it('broken search is caught', { timeout: 180000 }, async (t) => {
    const r = await scan({ breaks: 'search' });
    assert.equal(byId(r, 'fn.search')?.status, 'fail', summary(r));
    note(t, byId(r, 'fn.search').detail);
  });

  it('a blocked Store API says so plainly instead of failing the store', { timeout: 180000 }, async (t) => {
    const r = await scan({ breaks: 'storeapi' });
    const p = byId(r, 'fn.platform');
    assert.equal(p?.status, 'skip', summary(r));
    assert.match(p.detail, /WooCommerce Store API/);
    assert.match(p.fix, /wp-json\/wc\/store/);
    assert.ok(!r.checks.some((c) => c.status === 'fail' && c.id.startsWith('fn.')), 'no journey failures blamed on the store');
    note(t, p.detail);
  });

  const leftInCarts = async (mock) => (await (await fetch(`${mock.origin}/__carts`)).json()).items;

  it('the journey leaves the cart empty', { timeout: 180000 }, async (t) => {
    const mock = await startWooMock();
    try {
      await runScan({ runId: `woo-cart-${Date.now()}`, origin: mock.origin, kind: 'journeys' });
      // Every session the scan used was emptied: the mock counts items in every cart session it holds.
      assert.equal(await leftInCarts(mock), 0);
      note(t, 'No items left in any cart session after the check');
    } finally { mock.stop(); }
  });

  it('the cart is emptied even when the Store API cart is blocked and Add to cart could not be confirmed', { timeout: 180000 }, async (t) => {
    // A security plugin blocks the Store API cart: the click adds the item, but the check can't read the cart.
    const mock = await startWooMock({ breaks: 'cartapi' });
    try {
      const r = await runScan({ runId: `woo-cartapi-${Date.now()}`, origin: mock.origin, kind: 'journeys' });
      assert.notEqual(byId(r, 'fn.atc')?.status, 'pass', 'the add was not confirmed');
      assert.equal(await leftInCarts(mock), 0, "nothing left in the store's cart: removed with the cart page's own links");
      note(t, `fn.atc ${byId(r, 'fn.atc')?.status}; items left in carts after the check: 0 (emptied through the cart page)`);
    } finally { mock.stop(); }
  });
});

describe('WooCommerce: in the product', () => {
  let P, woo, owner, storeId, run, browser;
  before(async () => {
    P = await startProduct();
    woo = await startWooMock();
    owner = await signup(P, 'woo-owner@shop.test');
    const r = await owner.post('/api/stores', { url: woo.origin, name: 'Mock Woo Store', alertEmail: owner.email, runNow: false });
    assert.equal(r.status, 200, r.text);
    storeId = r.json.store?.id ?? r.json.id ?? r.json.storeId;
    run = await runAndWait(owner, storeId, { kind: 'journeys' });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); woo?.stop(); await P?.stop(); });

  it('a WooCommerce store added to a website account gets the full shopping journey', async (t) => {
    assert.equal(run.status, 'done', run.error || '');
    const g = await owner.get(`/api/runs/${run.id}`);
    const checks = g.json.result?.checks || g.json.checks || [];
    const ids = checks.filter((c) => c.status === 'pass').map((c) => c.id);
    for (const id of ['fn.atc', 'fn.checkout']) assert.ok(ids.includes(id), `${id} passed: ${checks.map((c) => `${c.id}:${c.status}`).join(' ')}`);
    note(t, `run ${run.id}: ${ids.join(', ')}`);
  });

  it('the report shows the WooCommerce journey', async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    await p.goto(`${P.base}/app#/s/${storeId}/reports/${run.id}`);
    await p.waitForSelector('.rtabs button', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    const text = await p.textContent('body');
    assert.match(text, /Add to cart works/);
    assert.match(text, /Checkout opens/);
    await screenshot(t, p, 'WooCommerce store report', { fullPage: true });
    await ctx.close();
  });
});
