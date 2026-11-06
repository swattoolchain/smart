// Product options without setup, and options apps with their own widgets (T112). When the owner lists no options
// for the test product, full checks find its required options, fill the first value of each and run the same
// checks as Product options (#76). Options drawn outside the product form (swatches, app fields) are filled too.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startMock, startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.ALLOW_LOCAL_TARGETS = '1';
process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-options-auto-'));
const { getBrowser, newContext } = await import('../src/engine/browser.js');
const { Recorder } = await import('../src/engine/checks.js');
const { findRequiredOptions, runAutoOptions, runPriceConfigs, AUTO_ID } = await import('../src/engine/configurator.js');

describe('Product options without setup: the check engine', { concurrency: 1 }, () => {
  after(async () => { (await getBrowser()).close(); });

  async function withPage(mock, fn) {
    const ctx = await newContext();
    const page = await ctx.newPage();
    try { return await fn(page); } finally { await ctx.close(); }
  }
  const auto = (mock, listed = []) => withPage(mock, async (page) => {
    const rec = new Recorder();
    await runAutoOptions({ page, rec, origin: mock.origin, product: 'cotton-kurta', listed });
    // When nothing was tried the page never left about:blank, so there is no cart to read.
    const left = page.url().startsWith('http') ? await page.evaluate(async () => (await (await fetch('/cart.js')).json()).item_count) : 0;
    return { c: rec.checks.find((x) => x.id === AUTO_ID), checks: rec.checks, left };
  });

  it('finds required options, including an app\'s swatches outside the form, and skips optional ones', { timeout: 120000 }, async (t) => {
    const mock = await startMock({ extra: 'optionsapp' });
    try {
      const found = await withPage(mock, async (page) => {
        await page.goto(`${mock.origin}/products/cotton-kurta`);
        return findRequiredOptions(page);
      });
      note(t, JSON.stringify(found));
      assert.deepEqual(found, [{ name: 'Embroidery colour', value: 'Gold', required: true }]);
      const saree = await startMock({ extra: 'options' });
      try {
        const f2 = await withPage(saree, async (page) => { await page.goto(`${saree.origin}/products/silk-saree`); return findRequiredOptions(page); });
        assert.deepEqual(f2, [{ name: 'Engraving', value: 'Tharam test', required: true }], 'a required text field in the form gets a sample text');
      } finally { saree.stop(); }
    } finally { mock.stop(); }
  });

  it('options that work pass: required really required, choice kept, cart = the price the page shows; cart emptied', { timeout: 120000 }, async (t) => {
    const mock = await startMock({ extra: 'optionsapp' });
    try {
      const { c, left } = await auto(mock);
      note(t, `${c.title}: ${c.status}: ${c.detail}`);
      assert.equal(c.status, 'pass', c.detail);
      assert.equal(c.title, 'Product options found on the page: Organic Cotton Kurta (Small)');
      assert.match(c.detail, /With Embroidery colour “Gold”, the cart keeps every choice and comes to ₹1,599, the price the product page shows/);
      assert.match(c.detail, /Add to cart waits for “Embroidery colour”/);
      assert.match(c.detail, /Checkout shows the same ₹1,599/);
      assert.deepEqual(c.evidence.choices, { 'Embroidery colour': 'Gold' });
      assert.equal(left, 0);
    } finally { mock.stop(); }
  });

  it('a lost choice is a critical failure; an upcharge bigger than the page shows is too', { timeout: 120000 }, async (t) => {
    const a = await startMock({ extra: 'optionsapp', breaks: 'props' });
    try {
      const { c } = await auto(a);
      note(t, `props lost: ${c.status}: ${c.detail}`);
      assert.equal(c.status, 'fail');
      assert.match(c.detail, /the cart lost the customer's choice for “Embroidery colour”/);
    } finally { a.stop(); }
    const b = await startMock({ extra: 'optionsapp', breaks: 'upcharge' });
    try {
      const { c } = await auto(b);
      note(t, `upcharge: ${c.status}: ${c.detail}`);
      assert.equal(c.status, 'fail');
      assert.match(c.detail, /the cart comes to ₹1,649, more than the ₹1,599 the product page shows/);
    } finally { b.stop(); }
  });

  it('nothing is reported for a page without required options, or a product the owner already lists', { timeout: 120000 }, async () => {
    const plain = await startMock();
    try { assert.equal((await auto(plain)).checks.length, 0); } finally { plain.stop(); }
    const opt = await startMock({ extra: 'optionsapp', breaks: 'optional' });
    try { assert.equal((await auto(opt)).checks.length, 0, 'no required options on the page'); } finally { opt.stop(); }
    const listed = await startMock({ extra: 'optionsapp' });
    try { assert.equal((await auto(listed, ['cotton-kurta'])).checks.length, 0); } finally { listed.stop(); }
  });

  it('owner-listed options are filled in an app widget outside the form: swatches and text fields', { timeout: 120000 }, async (t) => {
    const mock = await startMock({ extra: 'optionsapp' });
    try {
      const c = await withPage(mock, async (page) => {
        const rec = new Recorder();
        await runPriceConfigs({ page, rec, origin: mock.origin, configs: [{ product: 'cotton-kurta', variant: null, options: [{ name: 'Embroidery colour', value: 'Silver', required: true }, { name: 'Name on tag', value: 'Ravi', required: false }], price: 1499 }] });
        return rec.checks[0];
      });
      note(t, `${c.status}: ${c.detail}`);
      assert.equal(c.status, 'pass', c.detail);
      assert.deepEqual(c.evidence.choices, { 'Embroidery colour': 'Silver', 'Name on tag': 'Ravi' });
    } finally { mock.stop(); }
  });
});

describe('Product options without setup in the product', () => {
  let P, owner, storeId, browser;
  before(async () => {
    P = await startProduct({ mock: { extra: 'optionsapp', breaks: 'props' } });
    owner = await signup(P, 'optauto@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('a full check finds and tries the options with no setup; the report shows it', { timeout: 360000 }, async (t) => {
    const run = await runAndWait(owner, storeId, { kind: 'full' }, 330000);
    assert.equal(run.status, 'done', run.error || '');
    const c = run.result.checks.find((x) => x.id === AUTO_ID);
    assert.ok(c, 'checked without setup');
    assert.equal(c.status, 'fail', c.detail);
    note(t, c.detail);
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const pg = await ctx.newPage();
    const errors = [];
    pg.on('pageerror', (e) => errors.push(e.message));
    await pg.goto(`${P.base}/app#/s/${storeId}/runs/${run.id}`);
    const box = pg.locator('.chk.fail', { hasText: 'Product options found on the page' });
    await box.waitFor({ timeout: 20000 });
    await pg.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    await box.scrollIntoViewIfNeeded();
    assert.match(await box.innerText(), /lost the customer's choice/);
    await screenshot(t, pg, 'Report: product options found on the page, choice lost in the cart');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('journey checks do not try them (full checks only)', { timeout: 240000 }, async () => {
    const run = await runAndWait(owner, storeId, { kind: 'journeys' });
    assert.equal(run.status, 'done', run.error || '');
    assert.equal(run.result.checks.find((x) => x.id === AUTO_ID), undefined);
  });
});
