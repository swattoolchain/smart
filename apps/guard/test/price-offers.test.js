// Automatic offers (T78): the owner lists the bundles, buy-X-get-Y, spend-and-save and free-gift offers they run.
// Each full check builds the cart that should get the offer and the cart just below it, then checks the cart and
// checkout. Works with Shopify automatic discounts, Functions or offer apps because it only reads the cart.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startMock, startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.ALLOW_LOCAL_TARGETS = '1';
process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-offers-'));
const { getBrowser, newContext } = await import('../src/engine/browser.js');
const { Recorder } = await import('../src/engine/checks.js');
const { parseOffer, cleanOffers, planCarts, judgeCart, cartDiscount, runOffers } = await import('../src/engine/offers.js');
const { groupOf } = await import('../src/engine/catalog.js');

const table = (c) => (c?.evidence?.offerTable?.rows || []).map((r) => `${r.cart}: should ${r.expect}, gave ${r.got ?? '–'} (${r.state})`).join(' | ');
const SPEND = { type: 'spend', products: ['cotton-kurta'], variant: 'Small', min: 5000, percent: 10 };
const BXGY = { type: 'bxgy', products: ['cotton-kurta'], variant: 'Large', buy: 2, get: 1, percent: 100 };
const BUNDLE = { type: 'bundle', products: ['cotton-kurta', 'silk-saree'], variant: 'Small', price: 9998 };
const GIFT = { type: 'gift', products: ['cotton-kurta', 'brass-diya'], variant: 'Medium', min: 3000 };

describe('Offers: reading what the owner wrote', () => {
  it('reads each kind of offer in the ways owners write it', () => {
    assert.deepEqual(parseOffer('spend', '5000 10%'), { min: 5000, percent: 10 });
    assert.deepEqual(parseOffer('spend', 'Spend ₹5,000 get 10% off'), { min: 5000, percent: 10 });
    assert.deepEqual(parseOffer('spend', '5000 500 off'), { min: 5000, amount: 500 });
    assert.deepEqual(parseOffer('bxgy', 'buy 2 get 1'), { buy: 2, get: 1, percent: 100 });
    assert.deepEqual(parseOffer('bxgy', '2+1'), { buy: 2, get: 1, percent: 100 });
    assert.deepEqual(parseOffer('bxgy', 'buy 1 get 1 50%'), { buy: 1, get: 1, percent: 50 });
    assert.deepEqual(parseOffer('bundle', '₹9,998'), { price: 9998 });
    assert.deepEqual(parseOffer('gift', 'spend 3000'), { min: 3000 });
  });

  it('refuses offers that make no sense, with a plain message', () => {
    assert.throws(() => parseOffer('spend', 'lots'), /Write a spend offer like/);
    assert.throws(() => parseOffer('spend', '5000 120%'), /between 0 and 100/);
    assert.throws(() => parseOffer('spend', '500 900 off'), /less than the amount to spend/);
    assert.throws(() => parseOffer('bxgy', 'buy 15 get 10'), /20 items or fewer/);
    assert.throws(() => parseOffer('bundle', 'cheap'), /price of the whole bundle/);
    assert.throws(() => parseOffer('gift', ''), /amount to spend for the free gift/);
  });

  it('saves product links or handles with the offer; checks the number of products; at most 5 offers', () => {
    assert.deepEqual(cleanOffers([{ type: 'bundle', products: 'https://s.test/products/Cotton-Kurta?variant=1, silk-saree', offer: '9998' }]), [{ type: 'bundle', products: ['cotton-kurta', 'silk-saree'], variant: null, price: 9998 }]);
    assert.deepEqual(cleanOffers([SPEND]), [SPEND], 'saved offers can be sent back as they are');
    assert.deepEqual(cleanOffers([{ type: 'spend', products: [], offer: '' }]), [], 'empty rows are dropped');
    assert.throws(() => cleanOffers([{ type: 'bundle', products: ['cotton-kurta'], offer: '999' }]), /2 to 4 products/);
    assert.throws(() => cleanOffers([{ type: 'gift', products: ['cotton-kurta'], offer: '3000' }]), /then the gift/);
    assert.throws(() => cleanOffers([{ type: 'magic', products: ['cotton-kurta'], offer: '1' }]), /Choose what kind of offer/);
    assert.throws(() => cleanOffers([{ type: 'spend', products: ['<b>'], offer: '5000 10%' }]), /not a product/);
    assert.throws(() => cleanOffers(Array.from({ length: 6 }, () => SPEND)), /Up to 5 offers/);
  });

  it('plans the cart that gets the offer and the one just below it', () => {
    const units = { 'cotton-kurta': 149900, 'silk-saree': 899900, 'brass-diya': 49900 };
    const s = planCarts(SPEND, units).carts;
    assert.deepEqual(s.map((c) => [c.role, c.lines[0].qty, c.expectOff]), [['gets', 4, 59960], ['below', 3, 0]]);
    const b = planCarts(BXGY, units).carts;
    assert.deepEqual(b.map((c) => [c.role, c.lines[0].qty, c.expectOff]), [['gets', 3, 149900], ['below', 2, 0]]);
    assert.deepEqual(planCarts({ ...BXGY, products: ['cotton-kurta', 'brass-diya'] }, units).carts.map((c) => c.lines.map((l) => l.qty)), [[2, 1], [1, 1]], 'a different product to get');
    assert.equal(planCarts(BUNDLE, units).carts[0].expectOff, 50000);
    assert.match(planCarts({ ...BUNDLE, price: 20000 }, units).problem, /not less than the products cost/);
    assert.deepEqual(planCarts(GIFT, units).carts.map((c) => c.lines.map((l) => `${l.qty} ${l.handle}`)), [['3 cotton-kurta', '1 brass-diya'], ['2 cotton-kurta', '1 brass-diya']]);
    assert.match(planCarts({ ...SPEND, min: 5000000 }, units).problem, /more than 99/);
  });

  it('judges each cart: missing, bigger, given too early, or right', () => {
    assert.equal(judgeCart('spend', { role: 'gets', expectOff: 59960, gotOff: 59960 }), 'ok');
    assert.equal(judgeCart('spend', { role: 'gets', expectOff: 59960, gotOff: 0 }), 'missing');
    assert.equal(judgeCart('spend', { role: 'gets', expectOff: 59960, gotOff: 90000 }), 'over');
    assert.equal(judgeCart('spend', { role: 'below', expectOff: 0, gotOff: 44970 }), 'leak');
    assert.equal(judgeCart('gift', { role: 'gets', giftCharged: 0 }), 'ok');
    assert.equal(judgeCart('gift', { role: 'gets', giftCharged: 49900 }), 'missing');
    assert.equal(judgeCart('gift', { role: 'below', giftCharged: 0 }), 'leak');
    assert.equal(judgeCart('bundle', { role: 'gets', refused: true }), 'refused');
    assert.equal(cartDiscount({ original_total_price: 1000, total_price: 900, items: [] }), 100);
    assert.equal(cartDiscount({ items: [{ original_line_price: 1000, final_line_price: 800 }], cart_level_discount_applications: [{ total_allocated_amount: 50 }] }), 250);
  });

  it('offers belong to the Discount codes group, which runs on full checks', () => {
    assert.equal(groupOf('fn.offer.1'), 'sale.discount');
  });
});

describe('Offers: the check engine', { concurrency: 1 }, () => {
  after(async () => { (await getBrowser()).close(); });

  // Runs the offers against a mock store in a fresh shopper session, and reads what is left in that cart.
  async function check(mock, offers) {
    const ctx = await newContext();
    const page = await ctx.newPage();
    try {
      const rec = new Recorder();
      await runOffers({ page, rec, origin: mock.origin, offers });
      const left = await page.evaluate(async () => (await fetch('/cart.js')).json());
      return { checks: rec.checks, left };
    } finally { await ctx.close(); }
  }

  it('offers that work pass, with the cart just below each threshold getting nothing; the cart is emptied', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'offers' });
    try {
      const { checks, left } = await check(mock, [SPEND, BXGY, BUNDLE, GIFT]);
      for (const c of checks) note(t, `${c.title}: ${c.status}: ${c.detail} | ${table(c)}`);
      assert.deepEqual(checks.map((c) => c.id), ['fn.offer.1', 'fn.offer.2', 'fn.offer.3', 'fn.offer.4']);
      assert.deepEqual(checks.map((c) => c.status), ['pass', 'pass', 'pass', 'pass'], checks.map((c) => c.detail).join(' / '));
      const [s, b, u, g] = checks;
      assert.equal(s.title, 'Offer: spend ₹5,000, get 10% off');
      assert.match(s.detail, /4 × Organic Cotton Kurta gets ₹599.60 off\. Just below it \(3 × Organic Cotton Kurta\), there is no discount/);
      assert.match(s.detail, /Checkout shows the same ₹5,996 subtotal as the cart/);
      assert.match(b.title, /Offer: buy 2 Organic Cotton Kurta \(Large\), get 1 free/);
      assert.match(b.detail, /3 × Organic Cotton Kurta gets ₹1,599 off/);
      assert.equal(u.title, 'Offer: Organic Cotton Kurta (Small) + Handwoven Silk Saree for ₹9,998');
      assert.equal(u.evidence.offerTable.rows[0].total, '₹9,998');
      assert.match(g.detail, /the Brass Diya Set is free in a cart of ₹4,497\. Just below it \(2 × Organic Cotton Kurta \+ 1 × Brass Diya Set\), there is no free gift/);
      assert.equal(left.item_count, 0, 'the cart is emptied');
    } finally { mock.stop(); }
  });

  it('an automatic discount that stopped working is a critical failure', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'offers', breaks: 'autodiscount,bxgy,gift' });
    try {
      const { checks } = await check(mock, [SPEND, BXGY, GIFT]);
      for (const c of checks) note(t, `${c.title}: ${c.status}: ${c.detail}`);
      assert.deepEqual(checks.map((c) => [c.status, c.severity]), [['fail', 'critical'], ['fail', 'critical'], ['fail', 'critical']]);
      assert.match(checks[0].detail, /Customers who qualify for this offer don't get it: 4 × Organic Cotton Kurta gets no discount, but the offer should take ₹599.60 off/);
      assert.match(checks[1].detail, /3 × Organic Cotton Kurta gets no discount, but the offer should take ₹1,599 off/);
      assert.match(checks[2].detail, /a cart of ₹4,497 still charges ₹499 for the Brass Diya Set/);
      assert.match(checks[0].fix, /Discounts/);
      assert.equal(checks[0].evidence.offerTable.rows[0].state, 'missing');
    } finally { mock.stop(); }
  });

  it('a discount given below the threshold is a warning', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'offers', breaks: 'autolow' });
    try {
      const [c] = (await check(mock, [SPEND])).checks;
      note(t, `${c.status}: ${c.detail} | ${table(c)}`);
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /3 × Organic Cotton Kurta already gets ₹449.70 off, though it is below what the offer needs \(₹5,000\)/);
      assert.deepEqual(c.evidence.offerTable.rows.map((r) => r.state), ['ok', 'leak']);
    } finally { mock.stop(); }
  });

  it('a broken bundle: a warning when another discount gives more, a failure when nothing is left', { timeout: 180000 }, async (t) => {
    const a = await startMock({ extra: 'offers', breaks: 'bundle' });
    try {
      const [c] = (await check(a, [BUNDLE])).checks;
      note(t, `bundle broken, spend offer still on: ${c.status}: ${c.detail}`);
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /gets ₹1,049.80 off, more than the ₹500 this offer should give/);
    } finally { a.stop(); }
    const b = await startMock({ extra: 'offers', breaks: 'bundle,autodiscount' });
    try {
      const [c] = (await check(b, [BUNDLE])).checks;
      note(t, `bundle broken, no other discount: ${c.status}: ${c.detail}`);
      assert.equal(c.status, 'fail');
      assert.match(c.detail, /1 × Organic Cotton Kurta \+ 1 × Handwoven Silk Saree gets no discount, but the offer should take ₹500 off/);
    } finally { b.stop(); }
  });

  it('a checkout that asks more than the cart is a critical failure; a missing product is reported', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'offers', breaks: 'checkoutprice' });
    try {
      const { checks } = await check(mock, [SPEND, { ...BUNDLE, products: ['cotton-kurta', 'gone-product'] }]);
      for (const c of checks) note(t, `${c.status}: ${c.detail}`);
      assert.equal(checks[0].status, 'fail');
      assert.match(checks[0].detail, /at checkout the subtotal is ₹6,196 while the cart showed ₹5,996/);
      assert.equal(checks[0].evidence.offerTable.checkout.higher, true);
      assert.equal(checks[1].status, 'warn');
      assert.match(checks[1].detail, /couldn't find “gone-product”/);
    } finally { mock.stop(); }
  });

  it('a store without the offer at all fails, so a forgotten discount is caught', { timeout: 180000 }, async (t) => {
    const mock = await startMock();
    try {
      const [c] = (await check(mock, [SPEND])).checks;
      note(t, `${c.status}: ${c.detail}`);
      assert.equal(c.status, 'fail');
    } finally { mock.stop(); }
  });
});

describe('Offers in the product', () => {
  let P, owner, other, storeId, browser;
  before(async () => {
    P = await startProduct({ mock: { extra: 'offers', breaks: 'autodiscount' } });
    owner = await signup(P, 'offers@shop.test');
    other = await signup(P, 'offers-other@shop.test');
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

  it('the owner saves offers; bad input is refused with a plain message', async (t) => {
    const r = await owner.patch(`/api/stores/${storeId}`, { config: { priceOffers: [{ type: 'spend', products: [`${P.mock.origin}/products/cotton-kurta`], variant: 'Small', offer: '5000 10%' }] } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.store.config.priceOffers, [SPEND]);
    const bad = await owner.patch(`/api/stores/${storeId}`, { config: { priceOffers: [{ type: 'bundle', products: ['cotton-kurta', 'silk-saree'], offer: 'cheap' }] } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /price of the whole bundle/);
    assert.equal((await owner.get(`/api/stores/${storeId}`)).json.store.config.priceOffers.length, 1, 'refused input changes nothing');
    note(t, `saved spend 5000 10%; "cheap" bundle refused: ${bad.json.error}`);
  });

  it('other accounts cannot read or change the offers', async () => {
    assert.equal((await other.get(`/api/stores/${storeId}`)).status, 404);
    assert.equal((await other.patch(`/api/stores/${storeId}`, { config: { priceOffers: [] } })).status, 404);
    assert.equal((await P.session().patch(`/api/stores/${storeId}`, { config: { priceOffers: [] } })).status, 401);
    assert.equal((await owner.get(`/api/stores/${storeId}`)).json.store.config.priceOffers.length, 1);
  });

  it('price rules and offers share the plan limit', async () => {
    const limit = (await owner.get('/api/stores')).json.license?.limits?.priceRules ?? 10;
    const rules = Array.from({ length: limit }, () => ({ product: 'cotton-kurta', quantity: 1, price: 1499 }));
    const r = await owner.patch(`/api/stores/${storeId}`, { config: { priceRules: rules } });
    assert.equal(r.status, 403, 'the saved offer counts too');
    assert.match(r.json.error, /price rules? per store/);
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { config: { priceRules: rules.slice(1) } })).status, 200);
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { config: { priceRules: [] } })).status, 200);
  });

  it('a full check tries the offer and the report shows the carts', { timeout: 360000 }, async (t) => {
    const run = await runAndWait(owner, storeId, { kind: 'full' }, 330000);
    assert.equal(run.status, 'done', run.error || '');
    const c = run.result.checks.find((x) => x.id === 'fn.offer.1');
    assert.ok(c, 'the offer was checked');
    assert.equal(c.status, 'fail', c.detail);
    note(t, c.detail);
    const pg = await page();
    await pg.goto(`${P.base}/app#/s/${storeId}/runs/${run.id}`);
    await pg.waitForSelector('.offer-table', { timeout: 20000 });
    await quiet(pg);
    const box = pg.locator('.chk.fail', { hasText: 'Offer: spend ₹5,000, get 10% off' });
    await box.scrollIntoViewIfNeeded();
    assert.match(await box.locator('.offer-table').textContent(), /4 × Organic Cotton Kurta.*₹599.60 off.*No discount.*Offer missing/s);
    await screenshot(t, pg, 'Report: a spend-and-save offer that stopped working');
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  });

  it('Test suite → Price rules shows and saves offers', async (t) => {
    const pg = await page();
    await pg.goto(`${P.base}/app#/s/${storeId}/suite/prices`);
    await pg.waitForSelector('#poffers .offer-rule', { timeout: 20000 });
    await quiet(pg);
    assert.equal(await pg.inputValue('#poffers .offer-rule >> nth=0 >> [name=offer]'), '5000 10%');
    await pg.click('#addo');
    await pg.selectOption('#poffers .offer-rule >> nth=1 >> [name=type]', 'bundle');
    assert.match(await pg.getAttribute('#poffers .offer-rule >> nth=1 >> [name=offer]', 'placeholder'), /Bundle price/);
    await pg.fill('#poffers .offer-rule >> nth=1 >> [name=products]', 'cotton-kurta, silk-saree');
    await pg.fill('#poffers .offer-rule >> nth=1 >> [name=offer]', '9998');
    await screenshot(t, pg, 'Test suite: offers');
    await pg.click('.savebar button:has-text("Save changes")');
    await pg.waitForFunction(async (id) => {
      const r = await fetch(`/api/stores/${id}`); const j = await r.json(); return (j.store.config.priceOffers || []).length === 2;
    }, storeId, { timeout: 10000 });
    const saved = (await owner.get(`/api/stores/${storeId}`)).json.store.config.priceOffers;
    assert.deepEqual(saved[1], { type: 'bundle', products: ['cotton-kurta', 'silk-saree'], variant: null, price: 9998 });
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  });
});
