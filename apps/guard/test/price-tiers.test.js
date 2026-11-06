// Quantity breaks (T76): the owner lists a product's volume pricing ("5+ 10%, 10+ 20%"), and every check puts
// the product in a fresh cart at each break and one below it, then checks the price each, the total and checkout.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startMock, startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.ALLOW_LOCAL_TARGETS = '1';
process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-tiers-'));
const { runScan } = await import('../src/engine/index.js');
const { getBrowser } = await import('../src/engine/browser.js');
const { parseTiers, cleanPriceTiers, tierQuantities, tierUnit, compareTiers } = await import('../src/engine/pricing.js');

const find = (r, id) => r.checks.find((c) => c.id === id);
const table = (c) => (c?.evidence?.tierTable?.rows || []).map((r) => `${r.qty}: expect ${r.expect}, cart ${r.charged ?? '–'} ${r.state}`).join(' | ');
const KURTA = [{ min: 5, percent: 10 }, { min: 10, percent: 20 }];

describe('Quantity breaks: reading what the owner wrote', () => {
  it('reads breaks as a percentage off or a price each, in any order', () => {
    assert.deepEqual(parseTiers('5+ 10%, 10+ 20%'), KURTA);
    assert.deepEqual(parseTiers('10+: 400; 5 + = ₹450'), [{ min: 5, price: 450 }, { min: 10, price: 400 }]);
    assert.deepEqual(parseTiers('3+ 15% off'), [{ min: 3, percent: 15 }]);
    assert.deepEqual(parseTiers('6+ 1,299.50'), [{ min: 6, price: 1299.5 }]);
  });

  it('refuses breaks that make no sense, with a plain message', () => {
    assert.throws(() => parseTiers(''), /Enter the quantity breaks/);
    assert.throws(() => parseTiers('lots'), /is not a quantity break/);
    assert.throws(() => parseTiers('1+ 10%'), /start at 2/);
    assert.throws(() => parseTiers('5+ 120%'), /between 0 and 100/);
    assert.throws(() => parseTiers('5+ 10%, 5+ 20%'), /only one break/);
    assert.throws(() => parseTiers('2+ 1%, 3+ 2%, 4+ 3%, 5+ 4%, 6+ 5%, 7+ 6%'), /Up to 5/);
  });

  it('saves a product link or handle with its breaks; at most 5 products', () => {
    assert.deepEqual(cleanPriceTiers([{ product: 'https://s.test/products/Cotton-Kurta?variant=1', tiers: '5+ 10%, 10+ 20%' }]), [{ product: 'cotton-kurta', variant: null, tiers: KURTA }]);
    assert.deepEqual(cleanPriceTiers([{ product: 'kurta', tiers: KURTA }])[0].tiers, KURTA, 'saved breaks can be sent back as they are');
    assert.deepEqual(cleanPriceTiers([{ product: '', tiers: '' }]), [], 'empty rows are dropped');
    assert.throws(() => cleanPriceTiers([{ product: '<b>', tiers: '5+ 10%' }]), /not a product/);
    assert.throws(() => cleanPriceTiers(Array.from({ length: 6 }, () => ({ product: 'kurta', tiers: '5+ 10%' }))), /Up to 5 products/);
  });

  it('tries each break and one below it, and works out the price each', () => {
    assert.deepEqual(tierQuantities(KURTA), [4, 5, 9, 10]);
    assert.deepEqual(tierQuantities([{ min: 2, price: 9 }]), [1, 2]);
    assert.equal(tierUnit(KURTA, 4, 149900), 149900);
    assert.equal(tierUnit(KURTA, 5, 149900), 134910);
    assert.equal(tierUnit(KURTA, 12, 149900), 119920);
    assert.equal(tierUnit([{ min: 5, price: 450 }], 7, 50000), 45000);
    const r = compareTiers(KURTA, 149900, [{ qty: 4, charged: 599600 }, { qty: 5, charged: 674551 }, { qty: 9, charged: 1100000 }, { qty: 10, charged: null }]);
    assert.deepEqual(r.rows.map((x) => x.state), ['ok', 'ok', 'under', 'refused'], 'a paisa of rounding per item is not a difference');
  });
});

describe('Quantity breaks: the check engine', { concurrency: 1 }, () => {
  after(async () => { (await getBrowser()).close(); });
  const scan = (mock, priceTiers) => runScan({ runId: `tiers-${Date.now()}-${Math.random()}`, origin: mock.origin, kind: 'journeys', priceTiers });

  it('breaks that work pass, with each quantity and the checkout in the table', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'tiers' });
    try {
      const r = await scan(mock, [{ product: 'cotton-kurta', variant: null, tiers: KURTA }]);
      const c = find(r, 'fn.price.tiers-1');
      note(t, `${c.title}: ${c.status}: ${c.detail} | ${table(c)}`);
      assert.equal(c.status, 'pass', c.detail);
      assert.match(c.title, /Quantity breaks: Organic Cotton Kurta \(Small\)/);
      assert.deepEqual(c.evidence.tierTable.rows.map((x) => `${x.qty}:${x.chargedEach}`), ['4:₹1,499', '5:₹1,349.10', '9:₹1,349.10', '10:₹1,199.20']);
      assert.match(c.detail, /Checkout shows the same ₹11,992 for 10/);
      assert.equal(c.evidence.tierTable.checkout.money, '₹11,992');
      const left = await (await fetch(`${mock.origin}/cart.js`)).json();
      assert.equal(left.item_count, 0, 'the cart is emptied');
    } finally { mock.stop(); }
  });

  it('a break that stopped working is a critical failure that names the quantity', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'tiers', breaks: 'tiers' });
    try {
      const r = await scan(mock, [{ product: 'cotton-kurta', variant: 'Small', tiers: KURTA }]);
      const c = find(r, 'fn.price.tiers-1');
      note(t, `${c.status}: ${c.detail} | ${table(c)}`);
      assert.equal(c.status, 'fail');
      assert.equal(c.severity, 'critical');
      assert.match(c.detail, /10 cost ₹13,491 \(₹1,349.10 each\), but your breaks say ₹11,992 \(₹1,199.20 each\)/);
      assert.doesNotMatch(c.detail, /\b5 cost/, 'the breaks that work are not blamed');
      assert.deepEqual(c.evidence.tierTable.rows.map((x) => x.state), ['ok', 'ok', 'ok', 'over']);
    } finally { mock.stop(); }
  });

  it('a checkout that asks more than the cart at the biggest break is a critical failure', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'tiers', breaks: 'checkoutprice' });
    try {
      const c = find(await scan(mock, [{ product: 'cotton-kurta', variant: null, tiers: KURTA }]), 'fn.price.tiers-1');
      note(t, `${c.status}: ${c.detail}`);
      assert.equal(c.status, 'fail');
      assert.match(c.detail, /at checkout, 10 come to ₹12,192 while the cart showed ₹11,992/);
      assert.equal(c.evidence.tierTable.checkout.higher, true);
    } finally { mock.stop(); }
  });

  it('a store with no volume discount at all fails at the first break', { timeout: 180000 }, async (t) => {
    const mock = await startMock();
    try {
      const c = find(await scan(mock, [{ product: 'cotton-kurta', variant: null, tiers: [{ min: 3, price: 1299 }] }]), 'fn.price.tiers-1');
      note(t, `${c.status}: ${c.detail}`);
      assert.equal(c.status, 'fail');
      assert.match(c.detail, /3 cost ₹4,497 \(₹1,499 each\), but your breaks say ₹3,897 \(₹1,299 each\)/);
    } finally { mock.stop(); }
  });

  it('a bigger discount than the owner meant is a warning; a missing product is reported', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'tiers' });
    try {
      const r = await scan(mock, [{ product: 'cotton-kurta', variant: null, tiers: [{ min: 5, percent: 5 }] }, { product: 'gone-product', variant: null, tiers: KURTA }]);
      const [a, b] = [find(r, 'fn.price.tiers-1'), find(r, 'fn.price.tiers-2')];
      note(t, `${a.status}: ${a.detail}`);
      note(t, `${b.status}: ${b.detail}`);
      assert.equal(a.status, 'warn');
      assert.match(a.detail, /charges less than your breaks: 5 cost ₹6,745.50/);
      assert.equal(b.status, 'warn');
      assert.match(b.detail, /couldn't find the product “gone-product”/);
    } finally { mock.stop(); }
  });
});

describe('Quantity breaks in the product', () => {
  let P, owner, other, storeId, browser;
  before(async () => {
    P = await startProduct({ mock: { extra: 'tiers', breaks: 'tiers' } });
    owner = await signup(P, 'tiers@shop.test');
    other = await signup(P, 'tiers-other@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  async function page() {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    p.errors = [];
    p.on('pageerror', (e) => p.errors.push(e.message));
    return p;
  }
  const quiet = (p) => p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));

  it('the owner saves quantity breaks; bad input is refused with a plain message', async (t) => {
    const r = await owner.patch(`/api/stores/${storeId}`, { config: { priceTiers: [{ product: `${P.mock.origin}/products/cotton-kurta`, tiers: '5+ 10%, 10+ 20%' }] } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.store.config.priceTiers, [{ product: 'cotton-kurta', variant: null, tiers: KURTA }]);
    const bad = await owner.patch(`/api/stores/${storeId}`, { config: { priceTiers: [{ product: 'cotton-kurta', tiers: 'cheap' }] } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /is not a quantity break/);
    assert.equal((await owner.get(`/api/stores/${storeId}`)).json.store.config.priceTiers.length, 1, 'refused input changes nothing');
    note(t, `saved 5+ 10%, 10+ 20%; "cheap" refused: ${bad.json.error}`);
  });

  it('other accounts cannot read or change the breaks', async () => {
    assert.equal((await other.get(`/api/stores/${storeId}`)).status, 404);
    assert.equal((await other.patch(`/api/stores/${storeId}`, { config: { priceTiers: [] } })).status, 404);
    assert.equal((await P.session().patch(`/api/stores/${storeId}`, { config: { priceTiers: [] } })).status, 401);
    assert.equal((await owner.get(`/api/stores/${storeId}`)).json.store.config.priceTiers.length, 1);
  });

  it('price rules and quantity breaks share the plan limit', async () => {
    const limit = (await owner.get('/api/stores')).json.license?.limits?.priceRules ?? 10;
    const rules = Array.from({ length: limit }, () => ({ product: 'cotton-kurta', quantity: 1, price: 1499 }));
    const r = await owner.patch(`/api/stores/${storeId}`, { config: { priceRules: rules } });
    assert.equal(r.status, 403, 'the saved quantity breaks count too');
    assert.match(r.json.error, /price rules? per store/);
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { config: { priceRules: rules.slice(1) } })).status, 200);
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { config: { priceRules: [] } })).status, 200);
  });

  it('a run checks the breaks and the report shows the table', { timeout: 300000 }, async (t) => {
    const run = await runAndWait(owner, storeId, { kind: 'journeys' });
    assert.equal(run.status, 'done', run.error || '');
    const c = run.result.checks.find((x) => x.id === 'fn.price.tiers-1');
    assert.equal(c.status, 'fail', c.detail);
    note(t, c.detail);
    const pg = await page();
    await pg.goto(`${P.base}/app#/s/${storeId}/runs/${run.id}`);
    await pg.waitForSelector('.tier-table', { timeout: 20000 });
    await quiet(pg);
    const box = pg.locator('.chk.fail', { hasText: 'Quantity breaks: Organic Cotton Kurta' });
    await box.scrollIntoViewIfNeeded();
    assert.match(await box.locator('.tier-table').textContent(), /10₹11,992.*₹13,491.*Higher/s);
    await screenshot(t, pg, 'Report: a quantity break that stopped working');
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  });

  it('Test suite → Price rules shows and saves the breaks', async (t) => {
    const pg = await page();
    await pg.goto(`${P.base}/app#/s/${storeId}/suite/prices`);
    await pg.waitForSelector('#ptiers .tier-rule', { timeout: 20000 });
    await quiet(pg);
    assert.equal(await pg.inputValue('#ptiers .tier-rule >> nth=0 >> [name=tiers]'), '5+ 10%, 10+ 20%');
    await pg.click('#addt');
    await pg.fill('#ptiers .tier-rule >> nth=1 >> [name=product]', 'silk-saree');
    await pg.fill('#ptiers .tier-rule >> nth=1 >> [name=tiers]', '2+ 8500');
    await screenshot(t, pg, 'Test suite: quantity breaks');
    await pg.click('.savebar button:has-text("Save changes")');
    await pg.waitForFunction(async (id) => {
      const r = await fetch(`/api/stores/${id}`); const j = await r.json(); return (j.store.config.priceTiers || []).length === 2;
    }, storeId, { timeout: 10000 });
    const saved = (await owner.get(`/api/stores/${storeId}`)).json.store.config.priceTiers;
    assert.deepEqual(saved[1], { product: 'silk-saree', variant: null, tiers: [{ min: 2, price: 8500 }] });
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  });
});
