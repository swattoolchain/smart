// Quantity breaks shown on the product page (T111): without any setup, we read the break table a volume-discount
// app shows near Add to cart and check the cart charges what it promises at each quantity.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startMock, startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.ALLOW_LOCAL_TARGETS = '1';
process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-page-tiers-'));
const { runScan } = await import('../src/engine/index.js');
const { getBrowser } = await import('../src/engine/browser.js');
const { parseTierLines } = await import('../src/engine/page-tiers.js');

const find = (r, id) => r.checks.find((c) => c.id === id);
const table = (c) => (c?.evidence?.tierTable?.rows || []).map((r) => `${r.qty}: page ${r.expect}, cart ${r.charged ?? '–'} ${r.state}`).join(' | ');

describe('Quantity breaks on the product page: reading the table', () => {
  it('reads the ways apps write breaks: % off, price each, ranges, rows split into cells', () => {
    assert.deepEqual(parseTierLines(['Quantity Discount', 'Buy 5+ 10% off', 'Buy 10+ 20% off']), [{ min: 5, percent: 10 }, { min: 10, percent: 20 }]);
    assert.deepEqual(parseTierLines(['1 - 4 items ₹1,499 each', '5 - 9 items ₹1,349 each', '10+ items ₹1,199 each']), [{ min: 5, price: 1349 }, { min: 10, price: 1199 }]);
    assert.deepEqual(parseTierLines(['Buy 3 or more and save 15%']), [{ min: 3, percent: 15 }], 'one line counts when it says save/off');
    assert.deepEqual(parseTierLines(['6 pcs: 5% discount', '12 pcs: 12% discount']), [{ min: 6, percent: 5 }, { min: 12, percent: 12 }]);
  });

  it('ignores text that only looks like numbers', () => {
    assert.deepEqual(parseTierLines(['Pack of 6', 'New for 2026', 'Free shipping over ₹999']), []);
    assert.deepEqual(parseTierLines(['2 items ₹2,998']), [], 'a single line without save/off/each is not a table');
    assert.deepEqual(parseTierLines(['Buy 2 get 1 free']), [], 'buy X get Y is an offer, not a break table');
    assert.deepEqual(parseTierLines([]), []);
  });
});

describe('Quantity breaks on the product page: the check engine', { concurrency: 1 }, () => {
  after(async () => { (await getBrowser()).close(); });
  const scan = (mock, priceTiers = []) => runScan({ runId: `pt-${Date.now()}-${Math.random()}`, origin: mock.origin, kind: 'journeys', priceTiers });

  it('a page table the cart honours passes; the cart is emptied', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'tiers,tiertable' });
    try {
      const c = find(await scan(mock), 'fn.price.tiers-page');
      note(t, `${c.title}: ${c.status}: ${c.detail} | ${table(c)}`);
      assert.equal(c.status, 'pass', c.detail);
      assert.equal(c.title, 'Quantity breaks on the product page: Organic Cotton Kurta (Small)');
      assert.match(c.detail, /Your product page says 5\+ 10% off, 10\+ 20% off, and the cart charges that/);
      assert.equal(c.evidence.tierTable.source, 'page');
      const left = await (await fetch(`${mock.origin}/cart.js`)).json();
      assert.equal(left.item_count, 0);
    } finally { mock.stop(); }
  });

  it('a page that promises a discount the cart doesn\'t give is a warning naming the quantity', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'tiertable' });
    try {
      const c = find(await scan(mock), 'fn.price.tiers-page');
      note(t, `${c.status}: ${c.detail} | ${table(c)}`);
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /Your product page says 5\+ 10% off, 10\+ 20% off, but the cart doesn't match: at 5 the page says ₹1,349.10 each, the cart gives ₹1,499 each/);
      assert.match(c.detail, /pay more than the page promised/);
    } finally { mock.stop(); }
  });

  it('a break that stopped working in the cart, or an out-of-date table, is caught', { timeout: 180000 }, async (t) => {
    const a = await startMock({ extra: 'tiers,tiertable', breaks: 'tiers' });
    try {
      const c = find(await scan(a), 'fn.price.tiers-page');
      note(t, `cart break: ${c.status}: ${c.detail}`);
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /at 10 the page says ₹1,199.20 each, the cart gives ₹1,349.10 each/);
      assert.doesNotMatch(c.detail, /at 5 /);
    } finally { a.stop(); }
    const b = await startMock({ extra: 'tiers,tiertable', breaks: 'tierpage' });
    try {
      const c = find(await scan(b), 'fn.price.tiers-page');
      note(t, `old table: ${c.status}: ${c.detail}`);
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /10\+ 25% off/);
    } finally { b.stop(); }
  });

  it('no table on the page means nothing is reported; breaks the owner lists are not checked twice', { timeout: 180000 }, async () => {
    const a = await startMock({ extra: 'tiers' });
    try { assert.equal(find(await scan(a), 'fn.price.tiers-page'), undefined); } finally { a.stop(); }
    const b = await startMock({ extra: 'tiers,tiertable' });
    try {
      const r = await scan(b, [{ product: 'cotton-kurta', variant: null, tiers: [{ min: 5, percent: 10 }, { min: 10, percent: 20 }] }]);
      assert.equal(find(r, 'fn.price.tiers-page'), undefined);
      assert.equal(find(r, 'fn.price.tiers-1').status, 'pass');
    } finally { b.stop(); }
  });
});

describe('Quantity breaks on the product page in the product', () => {
  let P, owner, storeId, browser;
  before(async () => {
    P = await startProduct({ mock: { extra: 'tiertable' } });
    owner = await signup(P, 'pagetiers@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('a run reports it with no setup, and the report shows what the page says next to the cart', { timeout: 300000 }, async (t) => {
    const run = await runAndWait(owner, storeId, { kind: 'journeys' });
    assert.equal(run.status, 'done', run.error || '');
    const c = run.result.checks.find((x) => x.id === 'fn.price.tiers-page');
    assert.equal(c.status, 'warn', c.detail);
    note(t, c.detail);
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const pg = await ctx.newPage();
    const errors = [];
    pg.on('pageerror', (e) => errors.push(e.message));
    await pg.goto(`${P.base}/app#/s/${storeId}/runs/${run.id}`);
    await pg.waitForSelector('.tier-table', { timeout: 20000 });
    await pg.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    const box = pg.locator('.chk', { hasText: 'Quantity breaks on the product page' });
    await box.scrollIntoViewIfNeeded();
    assert.match(await box.locator('.tier-table').textContent(), /Page says.*5₹6,745.50.*₹7,495/s);
    await screenshot(t, pg, 'Report: the page promises a quantity discount the cart does not give');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});
