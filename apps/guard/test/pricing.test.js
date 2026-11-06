// Prices stay the same: the price on the product page is what the cart and checkout ask for,
// and the owner's own price rules (for example 3 × ₹1,299) hold in a real cart.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startMock, startProduct, signup, addStore, runAndWait, FOUNDER, ROOT } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.ALLOW_LOCAL_TARGETS = '1';
process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-pricing-'));
const { runScan } = await import('../src/engine/index.js');
const { getBrowser } = await import('../src/engine/browser.js');
const { amountsIn, cleanPriceRules } = await import('../src/engine/pricing.js');

const find = (r, id) => r.checks.find((c) => c.id === id);
const trail = (c) => (c?.evidence?.priceTrail?.steps || []).map((s) => `${s.label} ${s.money ?? '–'}`).join(' → ');

describe('Prices stay the same: reading prices', () => {
  it('reads prices the way shops write them', () => {
    assert.deepEqual(amountsIn('₹1,499.00').map((a) => a.minor), [149900]);
    assert.deepEqual(amountsIn('1.499,00 €').map((a) => a.minor), [149900]);
    assert.deepEqual(amountsIn('Rs. 1,499').map((a) => a.minor), [149900]);
    assert.deepEqual(amountsIn('$14.99').map((a) => a.minor), [1499]);
    assert.deepEqual(amountsIn('₹1,49,999.50').map((a) => a.minor), [14999950]);
    assert.deepEqual(amountsIn('Regular price ₹1,999 Sale price ₹1,499').map((a) => a.minor), [199900, 149900]);
  });

  it('price rules accept a product link or handle and refuse bad input', () => {
    assert.deepEqual(cleanPriceRules([{ product: 'https://shop.example/products/Cotton-Kurta?variant=1', quantity: '3', price: '1,299.50' }]), [{ product: 'cotton-kurta', variant: null, quantity: 3, price: 1299.5 }]);
    assert.deepEqual(cleanPriceRules([{ product: '', price: '' }]), [], 'empty rows are dropped');
    assert.throws(() => cleanPriceRules([{ product: 'kurta', quantity: 0, price: 10 }]), /Quantity/);
    assert.throws(() => cleanPriceRules([{ product: 'kurta', quantity: 1, price: '-5' }]), /price/);
    assert.throws(() => cleanPriceRules([{ product: 'kurta', quantity: 1, price: '10.999' }]), /price/);
    assert.throws(() => cleanPriceRules([{ product: '<script>', quantity: 1, price: 10 }]), /not a product/);
    assert.throws(() => cleanPriceRules(Array.from({ length: 11 }, () => ({ product: 'kurta', price: 1 }))), /Up to 10/);
  });
});

describe('Prices stay the same: the check engine', { concurrency: 1 }, () => {
  after(async () => { (await getBrowser()).close(); });
  const cases = [
    { name: 'a healthy store passes, with the price at every step', breaks: '', status: 'pass', steps: ['Product page ₹1,499', 'Cart ₹1,499', 'Checkout subtotal ₹1,499'] },
    { name: 'a cart that charges more than the product page is a critical failure', breaks: 'pricedrift', status: 'fail', steps: ['Product page ₹1,499', 'Cart ₹1,649', 'Checkout subtotal ₹1,649'] },
    { name: 'a checkout that charges more than the cart is a critical failure', breaks: 'checkoutprice', status: 'fail', steps: ['Product page ₹1,499', 'Cart ₹1,499', 'Checkout subtotal ₹1,699'] },
    { name: 'a cart that charges less with no discount is a warning', breaks: 'pricelow', status: 'warn', steps: ['Product page ₹1,499', 'Cart ₹1,399', 'Checkout subtotal ₹1,399'] },
    // A shipping-protection app adds a paid line: the checkout subtotal is compared with the whole cart, not the one item.
    { name: 'a paid line added by an app (shipping protection) is not a price problem', breaks: 'protection', status: 'pass', steps: ['Product page ₹1,499', 'Cart ₹1,499', 'Whole cart (2 items) ₹1,598', 'Checkout subtotal ₹1,598'], detail: /whole cart \(2 items\) ₹1,598/ },
    { name: 'with other lines in the cart, a checkout above the whole cart is still critical', breaks: 'protection,checkoutprice', status: 'fail', steps: ['Product page ₹1,499', 'Cart ₹1,499', 'Whole cart (2 items) ₹1,598', 'Checkout subtotal ₹1,798'], detail: /checkout subtotal asks for ₹1,798, but the cart with the same items comes to ₹1,598/ },
    // The page price can't be read: a difference against product data is a warning, never a critical alarm.
    { name: 'when the product page price cannot be read, a different cart price is only a warning', breaks: 'noprice,pricedrift', status: 'warn', severity: 'major', steps: ['Product price (from your product data) ₹1,499', 'Cart ₹1,649', 'Checkout subtotal ₹1,649'], detail: /could not read the price on the product page/ },
  ];
  for (const [i, c] of cases.entries()) {
    it(c.name, { timeout: 180000 }, async (t) => {
      const mock = await startMock({ breaks: c.breaks });
      try {
        const r = await runScan({ runId: `pricing-${i}-${Date.now()}`, origin: mock.origin, kind: 'journeys' });
        const p = find(r, 'fn.price');
        assert.ok(p, `no price check: ${r.checks.map((x) => x.id).join(' ')}`);
        note(t, `${p.status}: ${p.detail} | ${trail(p)}`);
        assert.equal(p.status, c.status, p.detail);
        assert.deepEqual(p.evidence.priceTrail.steps.map((s) => `${s.label} ${s.money}`), c.steps);
        if (c.detail) assert.match(p.detail, c.detail);
        if (c.severity) assert.equal(p.severity, c.severity);
        if (c.status === 'warn') assert.notEqual(r.verdict, 'critical', 'a warning never makes the store critical');
        if (c.status === 'fail') {
          assert.equal(p.severity, 'critical');
          assert.ok(p.evidence.screenshot, 'a screenshot of the step that charged more');
          assert.equal(r.verdict, 'critical');
        }
        if (c.status !== 'pass') assert.ok(p.fix);
      } finally { mock.stop(); }
    });
  }

  it('switching the group off skips the price check', { timeout: 180000 }, async () => {
    const mock = await startMock({ breaks: 'pricedrift' });
    try {
      const r = await runScan({ runId: `pricing-off-${Date.now()}`, origin: mock.origin, kind: 'journeys', disabled: ['pricing.journey'] });
      assert.equal(r.checks.filter((c) => c.id.startsWith('fn.price')).length, 0);
      assert.equal(find(r, 'fn.checkout')?.status, 'pass');
    } finally { mock.stop(); }
  });

  it('price rules: right price passes, wrong price fails, a missing product is reported', { timeout: 180000 }, async (t) => {
    const mock = await startMock();
    try {
      const priceRules = [
        { product: 'cotton-kurta', variant: 'Medium', quantity: 3, price: 1499 },
        { product: 'cotton-kurta', variant: null, quantity: 2, price: 1299 },
        { product: 'gone-product', variant: null, quantity: 1, price: 10 },
        { product: 'cotton-kurta', variant: 'XXL', quantity: 1, price: 1499 },
      ];
      const r = await runScan({ runId: `pricing-rules-${Date.now()}`, origin: mock.origin, kind: 'journeys', priceRules });
      const [a, b, c, d] = [1, 2, 3, 4].map((n) => find(r, `fn.price.rule-${n}`));
      for (const x of [a, b, c, d]) note(t, `${x.title}: ${x.status}: ${x.detail}${trail(x) ? ` | ${trail(x)}` : ''}`);
      assert.equal(a.status, 'pass');
      assert.match(a.title, /3 × Organic Cotton Kurta \(Medium\)/);
      assert.equal(b.status, 'fail');
      assert.equal(b.severity, 'critical');
      assert.match(b.detail, /You expect ₹2,598 for 2, but the cart charges ₹2,998/);
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /couldn't find the product “gone-product”/);
      assert.equal(d.status, 'warn');
      assert.match(d.detail, /no variant called “XXL”/);
      const left = await (await fetch(`${mock.origin}/cart.js`)).json();
      assert.equal(left.item_count, 0);
    } finally { mock.stop(); }
  });
});

describe('Prices stay the same: price rules in the product', () => {
  let P, owner, other, storeId, browser;
  before(async () => {
    P = await startProduct();
    owner = await signup(P, 'prices@shop.test');
    other = await signup(P, 'other@shop.test');
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

  it('the check is in the test suite, under Shopping journey, on every test', async () => {
    const g = (await owner.get('/api/catalog')).json.groups.find((x) => x.key === 'pricing.journey');
    assert.equal(g.area, 'Shopping journey');
    assert.equal(g.run, 'journeys');
  });

  it('the owner saves price rules; bad input is refused with a plain message', async (t) => {
    const r = await owner.patch(`/api/stores/${storeId}`, { config: { priceRules: [{ product: `${P.mock.origin}/products/cotton-kurta`, variant: 'Medium', quantity: 3, price: '1499' }, { product: 'cotton-kurta', quantity: 2, price: '1299' }] } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.store.config.priceRules.map((x) => `${x.quantity}×${x.product}@${x.price}`), ['3×cotton-kurta@1499', '2×cotton-kurta@1299']);
    const bad = await owner.patch(`/api/stores/${storeId}`, { config: { priceRules: [{ product: 'cotton-kurta', quantity: 1, price: 'free' }] } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /price each/);
    assert.equal((await owner.get(`/api/stores/${storeId}`)).json.store.config.priceRules.length, 2, 'refused input changes nothing');
    note(t, `saved 2 rules; "free" refused: ${bad.json.error}`);
  });

  it('other accounts cannot read or change the rules', async () => {
    assert.equal((await other.get(`/api/stores/${storeId}`)).status, 404);
    assert.equal((await other.patch(`/api/stores/${storeId}`, { config: { priceRules: [] } })).status, 404);
    assert.equal((await P.session().patch(`/api/stores/${storeId}`, { config: { priceRules: [] } })).status, 401);
    assert.ok(!JSON.stringify((await other.get('/api/stores')).json).includes('cotton-kurta'));
    assert.equal((await owner.get(`/api/stores/${storeId}`)).json.store.config.priceRules.length, 2);
  });

  it('a run checks the price trail and the rules, and the report shows them', { timeout: 300000 }, async (t) => {
    const run = await runAndWait(owner, storeId, { kind: 'journeys' });
    assert.equal(run.status, 'done', run.error || '');
    const checks = run.result.checks;
    const p = checks.find((c) => c.id === 'fn.price');
    assert.equal(p.status, 'pass', p.detail);
    assert.equal(checks.find((c) => c.id === 'fn.price.rule-1').status, 'pass');
    const wrong = checks.find((c) => c.id === 'fn.price.rule-2');
    assert.equal(wrong.status, 'fail');
    note(t, `${p.detail} | rule 2: ${wrong.detail}`);

    const pg = await page();
    await pg.goto(`${P.base}/app#/s/${storeId}/runs/${run.id}`);
    await pg.waitForSelector('.price-trail', { timeout: 20000 });
    await quiet(pg);
    const fail = pg.locator('.chk.fail', { hasText: 'Price rule: 2 × Organic Cotton Kurta' });
    await fail.scrollIntoViewIfNeeded();
    assert.match(await fail.locator('.price-trail').textContent(), /You expect₹2,598.*Cart₹2,998.*Higher/s);
    await screenshot(t, pg, 'Report: price rule with its price trail');
    await pg.click('details.passes summary');
    const ok = pg.locator('.chk.pass', { hasText: 'Price stays the same to checkout' });
    await ok.scrollIntoViewIfNeeded();
    assert.match(await ok.locator('.price-trail').textContent(), /Product page₹1,499.*Cart₹1,499.*Checkout subtotal₹1,499/s);
    await screenshot(t, pg, 'Report: price trail from product page to checkout');
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  });

  it('Test suite → Price rules shows the saved rules', async (t) => {
    const pg = await page();
    await pg.goto(`${P.base}/app#/s/${storeId}/suite/prices`);
    await pg.waitForSelector('#prules .price-rule', { timeout: 20000 });
    await quiet(pg);
    assert.equal(await pg.locator('#prules .price-rule').count(), 2);
    assert.equal(await pg.inputValue('#prules .price-rule >> nth=0 >> [name=variant]'), 'Medium');
    await pg.click('#addr');
    assert.equal(await pg.locator('#prules .price-rule').count(), 3);
    await screenshot(t, pg, 'Test suite: price rules');
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  });

  it('the plan limit on price rules is enforced on the server', async (t) => {
    // Founders can't sign up: the account is created on the server, as in the founder console tests.
    const made = spawnSync(process.execPath, ['scripts/create-user.js', FOUNDER, 'founder-test-password', 'Founder'], { cwd: ROOT, env: { ...process.env, DATA_DIR: P.dataDir }, encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const founder = P.session();
    assert.equal((await founder.post('/api/auth/login', { email: FOUNDER, password: 'founder-test-password' })).status, 200);
    const plan = (await owner.get('/api/stores')).json.license.plan;
    const key = plan?.key || plan;
    const set = await founder.patch(`/api/admin/plans/${key}`, { limits: { priceRules: 1 } });
    assert.equal(set.status, 200, set.text);
    const r = await owner.patch(`/api/stores/${storeId}`, { config: { priceRules: [{ product: 'a', price: 1 }, { product: 'b', price: 2 }] } });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /1 price rule per store/);
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { config: { priceRules: [{ product: 'a', price: 1 }] } })).status, 200);
    note(t, `plan "${key}" set to 1 rule: 2 rules refused (${r.json.error}); 1 rule saved`);
  });
});
