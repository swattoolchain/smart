// WooCommerce stores: the full check reads every product through the Store API and runs the catalog checks.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWooMock, startProduct, signup, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.ALLOW_LOCAL_TARGETS = '1';
process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-woocat-'));
const { runScan } = await import('../src/engine/index.js');
const { getBrowser } = await import('../src/engine/browser.js');
const { loadSnapshot } = await import('../src/engine/catalog-check.js');
const { wooToRaw } = await import('../src/engine/products.js');

after(async () => { (await getBrowser()).close(); });

const SKIP = ['visual', 'law.de', 'law.cookies', 'access.law', 'law.us', 'ai.visual', 'speed', 'seo', 'a11y', 'links', 'policies', 'journey.search', 'journey.collection', 'journey.variant', 'journey.checkout'];
const byId = (r, id) => r.checks.find((c) => c.id === id);
const summary = (r) => r.checks.map((c) => `${c.id}:${c.status}`).join(' ');
let runN = 9000;
const full = (origin, storeId, extra = {}) => runScan({ runId: ++runN, origin, kind: 'full', storeId, disabled: SKIP, ...extra });

describe('WooCommerce: catalog checks', { concurrency: 1 }, () => {
  it('turns a Store API product into the same shape the Shopify rules use', () => {
    const raw = wooToRaw({ id: 5, name: 'Tea &amp; Cups', slug: 'tea', permalink: 'https://x.test/product/tea/', description: '<p>Nice</p>', sku: 'T1', on_sale: true, is_in_stock: false, images: [{ src: 'a' }], prices: { price: '9900', regular_price: '12900', sale_price: '9900', currency_code: 'INR', currency_minor_unit: 2 } });
    assert.equal(raw.title, 'Tea & Cups');
    assert.deepEqual([raw.variants[0].price, raw.variants[0].compare_at_price, raw.variants[0].available, raw.variants[0].sku], [99, 129, false, 'T1']);
    assert.equal(raw.url, 'https://x.test/product/tea/');
  });

  it('a healthy store: every product read, all catalog checks pass, snapshot saved', { timeout: 240000 }, async (t) => {
    const mock = await startWooMock();
    try {
      const r = await full(mock.origin, 701);
      for (const id of ['cat.pricing', 'cat.content', 'cat.media']) assert.equal(byId(r, id)?.status, 'pass', `${id}: ${summary(r)}`);
      assert.equal(byId(r, 'cat.counts')?.status, 'pass', byId(r, 'cat.counts')?.detail);
      assert.match(byId(r, 'cat.counts').detail, /3 products, 3 in the sitemap/);
      assert.equal(r.catalog.count, 3);
      assert.ok(!byId(r, 'nf.catalog'), 'the full check replaces the quick sample check');
      assert.equal(loadSnapshot(701, runN).products.length, 3);
      assert.equal(loadSnapshot(701, runN).products[0].url, `${mock.origin}/product/copper-bottle/`);
      note(t, `${byId(r, 'cat.counts').detail}`);
    } finally { mock.stop(); }
  });

  it('catches zero prices, fake discounts, placeholder text, missing images and duplicate SKUs', { timeout: 240000 }, async (t) => {
    const mock = await startWooMock({ extra: 'badcatalog' });
    try {
      const r = await full(mock.origin, 702);
      const pricing = byId(r, 'cat.pricing');
      assert.equal(pricing.status, 'fail', summary(r));
      assert.match(pricing.detail, /Free Sample Pack/);
      assert.match(pricing.fix, /WordPress admin/);
      assert.ok(r.catalog.issues.some((i) => i.handle === 'wool-throw' && /not a real discount/.test(i.message)), 'compare-at not above the price');
      assert.equal(byId(r, 'cat.content').status, 'warn');
      assert.ok(r.catalog.issues.some((i) => i.handle === 'brass-lamp' && /Lorem ipsum/.test(i.message)));
      assert.equal(byId(r, 'cat.media').status, 'warn');
      assert.ok(r.catalog.issues.some((i) => i.handle === 'cane-basket' && i.type === 'media'));
      assert.equal(byId(r, 'cat.data')?.status, 'warn');
      assert.ok(r.catalog.issues.some((i) => i.type === 'data' && /BOT-1/.test(i.message)));
      assert.ok(r.catalog.issues.every((i) => i.url?.startsWith(`${mock.origin}/product/`)), 'every issue links to the product page');
      note(t, `${r.catalog.issues.length} issues: ${pricing.detail}`);
    } finally { mock.stop(); }
  });

  it('reads every page of the Store API', { timeout: 240000 }, async (t) => {
    const mock = await startWooMock({ extra: 'badcatalog,cap2' });
    try {
      const r = await full(mock.origin, 703);
      assert.equal(r.catalog.count, 8, 'all 8 products over 4 pages of 2');
      assert.equal(r.catalog.truncated, false);
      note(t, `${r.catalog.count} products read in pages of 2`);
    } finally { mock.stop(); }
  });

  it('notices price changes and drops between two checks', { timeout: 240000 }, async (t) => {
    const mock = await startWooMock();
    try {
      await full(mock.origin, 704);
      await fetch(`${mock.origin}/__price/copper-bottle/50000`);
      const r = await full(mock.origin, 704);
      assert.match(byId(r, 'cat.pricing').detail, /dropped 67%/);
      assert.equal(byId(r, 'cat.pricing').status, 'warn');
      assert.equal(r.catalog.totals.price, 1);
      assert.match(byId(r, 'cat.changes').detail, /1 product changed: 1 price change/);
      note(t, byId(r, 'cat.pricing').detail);
    } finally { mock.stop(); }
  });

  it('warns when the product sitemap is missing products', { timeout: 240000 }, async (t) => {
    const mock = await startWooMock({ extra: 'badcatalog,sitemapgap' });
    try {
      const r = await full(mock.origin, 705);
      const c = byId(r, 'cat.counts');
      assert.equal(c.status, 'warn', c.detail);
      assert.match(c.detail, /5 products are in your store but missing from the sitemap/);
      note(t, c.detail);
    } finally { mock.stop(); }
  });

  it('a blocked Store API reads no catalog and blames nothing on the store', { timeout: 240000 }, async (t) => {
    const mock = await startWooMock({ breaks: 'storeapi' });
    try {
      const r = await full(mock.origin, 706);
      assert.ok(!r.checks.some((c) => c.id.startsWith('cat.')), summary(r));
      assert.ok(!r.checks.some((c) => c.status === 'fail' && c.id.startsWith('cat.')));
      note(t, 'no cat.* checks when the Store API is blocked');
    } finally { mock.stop(); }
  });
});

describe('WooCommerce: catalog in the app', { concurrency: 1 }, () => {
  it('the Catalog page lists Woo products and issues, linking to the product pages', { timeout: 360000 }, async (t) => {
    const P = await startProduct();
    const woo = await startWooMock({ extra: 'badcatalog' });
    const browser = await getBrowser();
    try {
      const owner = await signup(P);
      const r = await owner.post('/api/stores', { url: woo.origin, name: 'Mock Woo Store', runNow: false });
      const storeId = r.json.store?.id ?? r.json.id ?? r.json.storeId;
      const run = await runAndWait(owner, storeId, { kind: 'full' });
      assert.equal(run.status, 'done', run.error || '');
      const cat = await owner.get(`/api/stores/${storeId}/catalog`);
      assert.equal(cat.status, 200, JSON.stringify(cat.json).slice(0, 200));
      assert.equal(cat.json.products.length, 8);
      assert.ok(cat.json.products.every((p) => p.url?.startsWith(woo.origin + '/product/')));
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      await ctx.addCookies(owner.browserCookies());
      const p = await ctx.newPage();
      await p.goto(`${P.base}/app#/s/${storeId}/catalog/issues`);
      await p.waitForSelector('a.row', { timeout: 30000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      assert.match(await p.getAttribute('a.row', 'href'), /\/product\/[a-z-]+\/$/, 'issues open the WooCommerce product page');
      assert.match(await p.textContent('body'), /Free Sample Pack/);
      await screenshot(t, p, 'WooCommerce catalog issues', { fullPage: true });
      await p.goto(`${P.base}/app#/s/${storeId}/catalog/products`);
      await p.waitForSelector('tr.link', { timeout: 30000 });
      assert.match(await p.getAttribute('tr.link', 'data-href'), /\/product\/[a-z-]+\/$/, 'product rows open the WooCommerce product page');
      await screenshot(t, p, 'WooCommerce catalog products', { fullPage: true });
      await ctx.close();
    } finally { woo.stop(); await P.stop(); }
  });
});
