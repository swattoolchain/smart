// Prices by country (T79): each full check switches the storefront to every country the store sells in, with the
// country picker like a shopper, and checks currency and price on the product page, in the cart and at checkout,
// the owner's rounding rule and the distance from the converted price. Storefront only: no new Shopify scopes.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startMock, startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.ALLOW_LOCAL_TARGETS = '1';
process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-markets-'));
const { getBrowser, newContext } = await import('../src/engine/browser.js');
const { Recorder } = await import('../src/engine/checks.js');
const { cleanMarketPrices, followsRounding, judgeMarket, runMarketPrices } = await import('../src/engine/market-prices.js');

const RULES = { enabled: true, product: null, variant: 'Small', rounding: '99', tolerance: 10 };
const table = (c) => (c?.evidence?.marketTable?.rows || []).map((r) => `${r.country} ${r.currency || ''}: page ${r.page ?? '–'}, cart ${r.cart ?? '–'}, checkout ${r.checkout ?? '–'} (${r.state}${r.notes ? `: ${r.notes}` : ''})`).join(' | ');

describe('Prices by country: settings and rules', () => {
  it('saves the settings; a product link becomes its handle; bad input is refused plainly', () => {
    assert.deepEqual(cleanMarketPrices({ enabled: true, product: 'https://s.test/products/Cotton-Kurta', rounding: '99', tolerance: '15' }), { enabled: true, product: 'cotton-kurta', variant: null, rounding: '99', tolerance: 15 });
    assert.deepEqual(cleanMarketPrices({ enabled: true }), { enabled: true, product: null, variant: null, rounding: 'none', tolerance: 10 }, 'defaults: test product, any rounding, 10%');
    assert.equal(cleanMarketPrices({ enabled: false, product: '<b>' }).enabled, false, 'switching off never fails on old input');
    assert.equal(cleanMarketPrices(null), null);
    assert.throws(() => cleanMarketPrices({ enabled: true, product: '<b>' }), /is not a product/);
    assert.throws(() => cleanMarketPrices({ enabled: true, rounding: '42' }), /how your prices are rounded/);
    assert.throws(() => cleanMarketPrices({ enabled: true, tolerance: 80 }), /from 0 to 50%/);
  });

  it('checks rounding like .99, .95 and whole amounts', () => {
    assert.equal(followsRounding(1799, '99'), true);
    assert.equal(followsRounding(1649, '99'), false);
    assert.equal(followsRounding(1695, '95'), true);
    assert.equal(followsRounding(1700, '00'), true);
    assert.equal(followsRounding(1649, 'none'), true);
  });

  it('judges one country: currency changes, higher amounts, rounding, distance and buying', () => {
    const base = { minor: 149900, currency: 'INR' };
    const ok = { currency: 'EUR', rate: 0.011, base, page: { minor: 1699, trusted: true }, cart: { minor: 1699, currency: 'EUR' }, checkout: { minor: 1699, currencyOk: true } };
    const opts = { rounding: '99', tolerance: 10, shopCurrency: 'INR' };
    assert.deepEqual(judgeMarket(ok, opts), []);
    assert.deepEqual(judgeMarket({ ...ok, cart: { minor: 1799, currency: 'EUR' } }, opts).map((p) => [p.level, p.key]), [['fail', 'amount']]);
    assert.deepEqual(judgeMarket({ ...ok, cart: { minor: 1699, currency: 'INR' } }, opts).map((p) => p.key), ['currency']);
    assert.deepEqual(judgeMarket({ ...ok, checkout: { minor: 1699, currencyOk: false } }, opts).map((p) => p.key), ['currency']);
    assert.deepEqual(judgeMarket({ ...ok, page: { minor: 1649, trusted: true }, cart: { minor: 1649, currency: 'EUR' }, checkout: null }, opts).map((p) => p.key), ['rounding']);
    assert.match(judgeMarket({ ...ok, page: { minor: 2699, trusted: true }, cart: { minor: 2699, currency: 'EUR' }, checkout: null }, opts)[0].text, /€26.99 is 64% more than your ₹1,499 converted \(about €16.49\)/);
    assert.deepEqual(judgeMarket({ ...ok, cart: null, checkout: null, refused: true }, opts).map((p) => p.key), ['buy']);
    assert.deepEqual(judgeMarket({ ...ok, currency: 'INR', page: { minor: 149949, trusted: true }, cart: { minor: 149949, currency: 'INR' }, checkout: null }, opts), [], 'no rounding rule for the store\'s own currency');
  });
});

describe('Prices by country: the check engine', { concurrency: 1 }, () => {
  after(async () => { (await getBrowser()).close(); });

  async function run(mock, markets, settings = RULES) {
    const ctx = await newContext();
    const page = await ctx.newPage();
    try {
      const rec = new Recorder();
      await runMarketPrices({ page, rec, origin: mock.origin, markets, settings, product: 'cotton-kurta' });
      const after = await page.evaluate(async () => ({ country: window.Shopify?.country, cart: (await (await fetch('/cart.js')).json()).item_count }));
      return { c: rec.checks[0], after };
    } finally { await ctx.close(); }
  }

  it('a store with the same price and currency all the way passes, and is switched back to its own country', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'markets' });
    try {
      const { c, after } = await run(mock, ['US', 'DE', 'UK', 'IN']);
      note(t, `${c.status}: ${c.detail} | ${table(c)}`);
      assert.equal(c.id, 'fn.price.markets');
      assert.equal(c.status, 'pass', c.detail);
      assert.match(c.detail, /“Organic Cotton Kurta” \(Small\) has the same price from product page to checkout in US \(\$17.99\), DE \(€16.99\), GB \(UK\) \(£14.99\), IN \(₹1,499\)/);
      const de = c.evidence.marketTable.rows.find((r) => r.country === 'DE');
      assert.deepEqual([de.currency, de.page, de.cart, de.checkout, de.converted], ['EUR', '€16.99', '€16.99', '€16.99', '€16.49']);
      assert.equal(after.country, 'IN', 'the store is back on its own country');
      assert.equal(after.cart, 0, 'the cart is emptied');
    } finally { mock.stop(); }
  });

  it('a cart that charges more in one currency is a critical failure naming the country', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'markets', breaks: 'fx' });
    try {
      const { c } = await run(mock, ['US', 'DE']);
      note(t, `${c.status}: ${c.detail} | ${table(c)}`);
      assert.equal(c.status, 'fail');
      assert.equal(c.severity, 'critical');
      assert.match(c.detail, /DE: the product page shows €16.99 but the cart asks for €19.99/);
      assert.doesNotMatch(c.detail, /US:/, 'the country that works is not blamed');
    } finally { mock.stop(); }
  });

  it('a checkout in the wrong currency is a failure', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'markets', breaks: 'fxcheckout' });
    try {
      const { c } = await run(mock, ['DE']);
      note(t, `${c.status}: ${c.detail}`);
      assert.equal(c.status, 'fail');
      assert.match(c.detail, /DE: checkout does not show prices in EUR/);
    } finally { mock.stop(); }
  });

  it('prices off the rounding rule or far from the converted price are warnings', { timeout: 180000 }, async (t) => {
    const a = await startMock({ extra: 'markets', breaks: 'fxround' });
    try {
      const { c } = await run(a, ['DE']);
      note(t, `rounding: ${c.status}: ${c.detail}`);
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /DE: €16.49 does not end in .99/);
    } finally { a.stop(); }
    const b = await startMock({ extra: 'markets', breaks: 'fxfar' });
    try {
      const { c } = await run(b, ['UK']);
      note(t, `far: ${c.status}: ${c.detail}`);
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /GB \(UK\): £22.99 is 61% more than your ₹1,499 converted \(about £14.24\)/);
    } finally { b.stop(); }
  });

  it('a country where the product can\'t be bought fails; a country the store does not sell in is reported, not failed', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'markets', breaks: 'fxblock' });
    try {
      const { c } = await run(mock, ['US', 'SG']);
      note(t, `${c.status}: ${c.detail} | ${table(c)}`);
      assert.equal(c.status, 'fail');
      assert.match(c.detail, /US: the product can't be added to the cart/);
      assert.match(c.detail, /could not switch your store to SG/);
      assert.equal(c.evidence.marketTable.rows.find((r) => r.country === 'SG').state, 'switch');
    } finally { mock.stop(); }
  });

  it('a store with one price everywhere (no country picker) is a gentle note', { timeout: 180000 }, async (t) => {
    const mock = await startMock();
    try {
      const { c } = await run(mock, ['US']);
      note(t, `${c.status}: ${c.detail}`);
      // Without window.Shopify.country, a successful form post counts as switched: the store answers in INR.
      assert.ok(['pass', 'warn'].includes(c.status), c.detail);
    } finally { mock.stop(); }
  });
});

describe('Prices by country in the product', () => {
  let P, owner, other, storeId, browser;
  before(async () => {
    P = await startProduct({ mock: { extra: 'markets', breaks: 'fx' } });
    owner = await signup(P, 'markets@shop.test');
    other = await signup(P, 'markets-other@shop.test');
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

  it('the owner saves the settings; bad input is refused; other accounts cannot change them', async (t) => {
    const r = await owner.patch(`/api/stores/${storeId}`, { config: { markets: ['US', 'DE'], marketPrices: { enabled: true, product: '', variant: 'Small', rounding: '99', tolerance: '10' } } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.store.config.marketPrices, RULES);
    const bad = await owner.patch(`/api/stores/${storeId}`, { config: { marketPrices: { enabled: true, tolerance: 99 } } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /from 0 to 50%/);
    assert.equal((await other.patch(`/api/stores/${storeId}`, { config: { marketPrices: { enabled: false } } })).status, 404);
    assert.equal((await P.session().patch(`/api/stores/${storeId}`, { config: { marketPrices: { enabled: false } } })).status, 401);
    assert.deepEqual((await owner.get(`/api/stores/${storeId}`)).json.store.config.marketPrices, RULES, 'refused input changes nothing');
    note(t, `saved US + DE, .99, 10%; tolerance 99 refused: ${bad.json.error}`);
  });

  it('a full check checks each country and the report shows the table', { timeout: 360000 }, async (t) => {
    const run = await runAndWait(owner, storeId, { kind: 'full' }, 330000);
    assert.equal(run.status, 'done', run.error || '');
    const c = run.result.checks.find((x) => x.id === 'fn.price.markets');
    assert.ok(c, 'prices by country were checked');
    assert.equal(c.status, 'fail', c.detail);
    note(t, c.detail);
    const pg = await page();
    await pg.goto(`${P.base}/app#/s/${storeId}/runs/${run.id}`);
    await pg.waitForSelector('.market-table', { timeout: 20000 });
    await quiet(pg);
    const box = pg.locator('.chk.fail', { hasText: 'Prices in each country' });
    await box.scrollIntoViewIfNeeded();
    assert.match(await box.locator('.market-table').textContent(), /DE.*EUR.*€16.99.*€19.99.*Problem/s);
    await screenshot(t, pg, 'Report: prices in each country');
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  });

  it('a journey check does not switch countries (full checks only)', { timeout: 240000 }, async () => {
    const run = await runAndWait(owner, storeId, { kind: 'journeys' });
    assert.equal(run.status, 'done', run.error || '');
    assert.equal(run.result.checks.find((x) => x.id === 'fn.price.markets'), undefined);
  });

  it('Test suite → Price rules shows and saves prices by country', async (t) => {
    const pg = await page();
    await pg.goto(`${P.base}/app#/s/${storeId}/suite/prices`);
    await pg.waitForSelector('#pmarkets', { timeout: 20000 });
    await quiet(pg);
    assert.equal(await pg.isChecked('#pmarkets [name=enabled]'), true);
    assert.equal(await pg.inputValue('#pmarkets [name=rounding]'), '99');
    assert.match(await pg.textContent('#mpt-h'), /United States, Germany/);
    await pg.selectOption('#pmarkets [name=rounding]', '95');
    await pg.fill('#pmarkets [name=tolerance]', '15');
    await screenshot(t, pg, 'Test suite: prices by country');
    await pg.click('.savebar button:has-text("Save changes")');
    await pg.waitForFunction(async (id) => {
      const r = await fetch(`/api/stores/${id}`); const j = await r.json(); return j.store.config.marketPrices?.rounding === '95';
    }, storeId, { timeout: 10000 });
    assert.deepEqual((await owner.get(`/api/stores/${storeId}`)).json.store.config.marketPrices, { ...RULES, rounding: '95', tolerance: 15 });
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  });
});
