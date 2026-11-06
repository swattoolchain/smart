// Product options (T77): engraving, gift wrap and other upcharges. The owner lists the options a shopper fills and
// the price expected; every check fills them on the product page, adds to cart, and checks the cart keeps every
// choice (line item properties), the add-on lines and the total, required options, and the checkout subtotal.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startMock, startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.ALLOW_LOCAL_TARGETS = '1';
process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-options-'));
const { runScan } = await import('../src/engine/index.js');
const { getBrowser } = await import('../src/engine/browser.js');
const { parseOptions, cleanPriceConfigs, hasChoice } = await import('../src/engine/configurator.js');

const find = (r, id) => r.checks.find((c) => c.id === id);
const trail = (c) => (c?.evidence?.priceTrail?.steps || []).map((s) => `${s.label} ${s.money ?? '–'}${s.note ? ` (${s.note})` : ''}`).join(' → ');
const SAREE = { product: 'silk-saree', variant: null, options: [{ name: 'Engraving', value: 'Happy Diwali', required: true }, { name: 'Gift wrap', value: 'Yes', required: false }], price: 9098 };

describe('Product options: reading what the owner wrote', () => {
  it('reads options as name = value, with * for a required one', () => {
    assert.deepEqual(parseOptions('Engraving* = Happy Diwali; Gift wrap = Yes'), SAREE.options);
    assert.deepEqual(parseOptions('Size: Made to order\nGift note *: For Amma'), [{ name: 'Size', value: 'Made to order', required: false }, { name: 'Gift note', value: 'For Amma', required: true }]);
  });

  it('refuses options and prices that make no sense, with a plain message', () => {
    assert.throws(() => parseOptions(''), /Enter the options/);
    assert.throws(() => parseOptions('engraving'), /is not an option/);
    assert.throws(() => parseOptions('<b>x = 1'), /is not an option/);
    assert.throws(() => parseOptions('A = 1; a = 2'), /listed once/);
    assert.throws(() => parseOptions('a=1;b=1;c=1;d=1;e=1;f=1;g=1'), /Up to 6/);
    assert.throws(() => cleanPriceConfigs([{ product: 'silk-saree', options: 'Gift wrap = Yes', price: 'free' }]), /price you expect/);
    assert.throws(() => cleanPriceConfigs([{ product: '<x>', options: 'Gift wrap = Yes', price: 1 }]), /not a product/);
    assert.throws(() => cleanPriceConfigs(Array.from({ length: 6 }, () => ({ product: 'kurta', options: 'a = 1', price: 1 }))), /Up to 5 products/);
  });

  it('saves a product link or handle; saved options can be sent back as they are', () => {
    assert.deepEqual(cleanPriceConfigs([{ product: 'https://s.test/products/Silk-Saree', options: 'Engraving* = Happy Diwali; Gift wrap = Yes', price: '9,098' }]), [SAREE]);
    assert.deepEqual(cleanPriceConfigs([SAREE]), [SAREE]);
    assert.deepEqual(cleanPriceConfigs([{ product: '', options: '', price: '' }]), []);
  });

  it('matches a cart line choice by name, in any case, and "Yes (+₹99)" counts as Yes', () => {
    assert.ok(hasChoice({ engraving: 'Happy Diwali' }, { name: 'Engraving', value: 'happy diwali' }));
    assert.ok(hasChoice({ 'Gift wrap': 'Yes (+₹99)' }, { name: 'Gift wrap', value: 'Yes' }));
    assert.ok(hasChoice({ _Engraving: 'Happy Diwali' }, { name: 'Engraving', value: 'Happy Diwali' }));
    assert.ok(!hasChoice({ Engraving: '' }, { name: 'Engraving', value: 'Happy Diwali' }));
    assert.ok(!hasChoice(null, { name: 'Engraving', value: 'x' }));
  });
});

describe('Product options: the check engine', { concurrency: 1 }, () => {
  after(async () => { (await getBrowser()).close(); });
  const scan = (mock, priceConfigs) => runScan({ runId: `options-${Date.now()}-${Math.random()}`, origin: mock.origin, kind: 'journeys', priceConfigs });
  const cases = [
    { name: 'options that work pass: choices kept, add-on line in the cart, right total, required enforced', breaks: '', status: 'pass', detail: /keeps every choice and comes to ₹9,098.*Add-ons in the cart: Gift wrap ₹99.*Add to cart waits for “Engraving”.*Checkout shows the same ₹9,098/ },
    { name: 'an add-on that costs more than shown is a critical failure', breaks: 'upcharge', status: 'fail', severity: 'critical', detail: /With Engraving “Happy Diwali” and Gift wrap “Yes”: the cart comes to ₹9,148, more than the ₹9,098 you expect\.$/ },
    { name: 'choices that do not reach the cart line are a critical failure', breaks: 'props', status: 'fail', severity: 'critical', detail: /the cart lost the customer's choices for “Engraving” and “Gift wrap”/ },
    { name: 'a required option that is not required is a warning', breaks: 'optional', status: 'warn', severity: 'major', detail: /can add it to the cart without filling “Engraving”/ },
  ];
  for (const c of cases) {
    it(c.name, { timeout: 180000 }, async (t) => {
      const mock = await startMock({ extra: 'options', breaks: c.breaks });
      try {
        const x = find(await scan(mock, [SAREE]), 'fn.price.config-1');
        note(t, `${x.status}: ${x.detail} | ${trail(x)}`);
        assert.equal(x.status, c.status, x.detail);
        if (c.severity) assert.equal(x.severity, c.severity);
        assert.match(x.detail, c.detail);
        assert.equal(x.title, 'Product options: Handwoven Silk Saree');
        if (c.status !== 'pass') assert.ok(x.evidence.screenshot, 'a screenshot of the product page is kept');
        const left = await (await fetch(`${mock.origin}/cart.js`)).json();
        assert.equal(left.item_count, 0, 'the cart is emptied');
      } finally { mock.stop(); }
    });
  }

  it('an option that is not on the page, and a store without the upcharge, are reported plainly', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'options' });
    try {
      const r = await scan(mock, [{ ...SAREE, options: [...SAREE.options, { name: 'Monogram colour', value: 'Gold', required: false }] }, { ...SAREE, options: [{ name: 'Engraving', value: 'Hi', required: true }], price: 9098 }, { ...SAREE, product: 'gone-product' }]);
      const [a, b, c] = [1, 2, 3].map((n) => find(r, `fn.price.config-${n}`));
      for (const x of [a, b, c]) note(t, `${x.status}: ${x.detail}`);
      assert.equal(a.status, 'warn');
      assert.match(a.detail, /couldn't find “Monogram colour” on the product page/);
      assert.equal(b.status, 'warn');
      assert.match(b.detail, /comes to only ₹8,999, less than the ₹9,098 you expect \(the upcharge was not added\)/);
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /couldn't find the product “gone-product”/);
    } finally { mock.stop(); }
  });
});

describe('Product options in the product', () => {
  let P, owner, other, storeId, browser;
  before(async () => {
    P = await startProduct({ mock: { extra: 'options', breaks: 'upcharge' } });
    owner = await signup(P, 'options@shop.test');
    other = await signup(P, 'options-other@shop.test');
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

  it('the owner saves product options; bad input is refused with a plain message', async (t) => {
    const r = await owner.patch(`/api/stores/${storeId}`, { config: { priceConfigs: [{ product: `${P.mock.origin}/products/silk-saree`, options: 'Engraving* = Happy Diwali; Gift wrap = Yes', price: '9098' }] } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.store.config.priceConfigs, [SAREE]);
    const bad = await owner.patch(`/api/stores/${storeId}`, { config: { priceConfigs: [{ product: 'silk-saree', options: 'gift wrap', price: 1 }] } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /is not an option/);
    assert.equal((await owner.get(`/api/stores/${storeId}`)).json.store.config.priceConfigs.length, 1, 'refused input changes nothing');
    note(t, `saved; "gift wrap" refused: ${bad.json.error}`);
  });

  it('other accounts cannot read or change the options', async () => {
    assert.equal((await other.get(`/api/stores/${storeId}`)).status, 404);
    assert.equal((await other.patch(`/api/stores/${storeId}`, { config: { priceConfigs: [] } })).status, 404);
    assert.equal((await P.session().patch(`/api/stores/${storeId}`, { config: { priceConfigs: [] } })).status, 401);
    assert.equal((await owner.get(`/api/stores/${storeId}`)).json.store.config.priceConfigs.length, 1);
  });

  it('price rules and product options share the plan limit', async () => {
    const limit = (await owner.get('/api/stores')).json.license?.limits?.priceRules ?? 10;
    const rules = Array.from({ length: limit }, () => ({ product: 'cotton-kurta', quantity: 1, price: 1499 }));
    const r = await owner.patch(`/api/stores/${storeId}`, { config: { priceRules: rules } });
    assert.equal(r.status, 403, 'the saved product options count too');
    assert.match(r.json.error, /price rules? per store/);
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { config: { priceRules: rules.slice(1) } })).status, 200);
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { config: { priceRules: [] } })).status, 200);
  });

  it('a run checks the options and the report shows the price trail', { timeout: 300000 }, async (t) => {
    const run = await runAndWait(owner, storeId, { kind: 'journeys' });
    assert.equal(run.status, 'done', run.error || '');
    const c = run.result.checks.find((x) => x.id === 'fn.price.config-1');
    assert.equal(c.status, 'fail', c.detail);
    note(t, c.detail);
    const pg = await page();
    await pg.goto(`${P.base}/app#/s/${storeId}/runs/${run.id}`);
    await pg.waitForSelector('.price-trail', { timeout: 20000 });
    await quiet(pg);
    const box = pg.locator('.chk.fail', { hasText: 'Product options: Handwoven Silk Saree' });
    await box.scrollIntoViewIfNeeded();
    assert.match(await box.locator('.price-trail').textContent(), /You expect₹9,098.*Cart₹9,148.*Gift wrap ₹149.*Higher/s);
    await screenshot(t, pg, 'Report: an option upcharge that costs more than shown');
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  });

  it('Test suite → Price rules shows and saves product options', async (t) => {
    const pg = await page();
    await pg.goto(`${P.base}/app#/s/${storeId}/suite/prices`);
    await pg.waitForSelector('#pconfigs .config-rule', { timeout: 20000 });
    await quiet(pg);
    assert.equal(await pg.inputValue('#pconfigs .config-rule >> nth=0 >> [name=options]'), 'Engraving* = Happy Diwali; Gift wrap = Yes');
    await pg.click('#addc');
    await pg.fill('#pconfigs .config-rule >> nth=1 >> [name=product]', 'cotton-kurta');
    await pg.fill('#pconfigs .config-rule >> nth=1 >> [name=options]', 'Gift wrap = No');
    await pg.fill('#pconfigs .config-rule >> nth=1 >> [name=price]', '1499');
    await pg.locator('#pconfigs').scrollIntoViewIfNeeded();
    await screenshot(t, pg, 'Test suite: product options');
    await pg.click('.savebar button:has-text("Save changes")');
    await pg.waitForFunction(async (id) => {
      const r = await fetch(`/api/stores/${id}`); const j = await r.json(); return (j.store.config.priceConfigs || []).length === 2;
    }, storeId, { timeout: 10000 });
    const saved = (await owner.get(`/api/stores/${storeId}`)).json.store.config.priceConfigs;
    assert.deepEqual(saved[1], { product: 'cotton-kurta', variant: null, options: [{ name: 'Gift wrap', value: 'No', required: false }], price: 1499 });
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  });
});
