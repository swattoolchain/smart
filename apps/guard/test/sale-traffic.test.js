// Sale traffic readiness (roadmap 11): opt-in, a few shoppers (never more than 5) at once through product,
// cart and checkout, compared with one shopper alone; slowdowns and breakage reported; never a load test.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startMock, startProduct, signup, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.ALLOW_LOCAL_TARGETS = '1';
const { runTraffic, clampShoppers, MAX_SHOPPERS } = await import('../src/engine/traffic.js');
const { Recorder } = await import('../src/engine/checks.js');
const { getBrowser } = await import('../src/engine/browser.js');
const { GROUPS, effectiveDisabled, normalizeConfig } = await import('../src/engine/catalog.js');

const info = { products: [{ title: 'Organic Cotton Kurta', handle: 'cotton-kurta', variants: [{ id: 101, title: 'Small' }] }] };
let storeSeq = 1;
async function traffic(mock, opts = {}) {
  const rec = new Recorder();
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-traffic-'));
  const out = await runTraffic({ rec, origin: mock.origin, info, storeId: opts.storeId || storeSeq++, dataDir, shoppers: opts.shoppers ?? 3, now: opts.now });
  const carts = (await (await fetch(`${mock.origin}/__carts`)).json()).carts;
  return { out, check: rec.checks.find((c) => c.id === 'perf.traffic'), carts, dataDir };
}

describe('Sale traffic readiness: the test itself', { concurrency: 1 }, () => {
  after(async () => { (await getBrowser()).close(); });

  it('never more than 5 shoppers, and opt-in only', (t) => {
    assert.equal(MAX_SHOPPERS, 5);
    assert.equal(clampShoppers(50), 5);
    assert.equal(clampShoppers(1), 2);
    assert.equal(clampShoppers('x'), 3);
    assert.equal(normalizeConfig({ saleTrafficShoppers: 9 }).saleTrafficShoppers, undefined, '9 shoppers refused');
    assert.equal(normalizeConfig({ saleTrafficShoppers: 5 }).saleTrafficShoppers, 5);
    assert.equal(normalizeConfig({ saleTraffic: 'on' }).saleTraffic, undefined, 'only true/false');
    const g = GROUPS.find((x) => x.key === 'sale.traffic');
    assert.ok(g?.optIn);
    assert.ok(effectiveDisabled({}).includes('sale.traffic'), 'off unless switched on');
    assert.ok(!effectiveDisabled({ saleTraffic: true }).includes('sale.traffic'));
    note(t, 'cap 5 (50 -> 5), minimum 2, setting 9 refused; group off until the store opts in');
  });

  it('a store that keeps up passes, and every cart is emptied', { timeout: 120000 }, async (t) => {
    const mock = await startMock();
    try {
      const { out, check, carts } = await traffic(mock, { shoppers: 3 });
      assert.equal(check.status, 'pass', check.detail);
      assert.equal(out.shoppers, 3);
      assert.deepEqual(out.steps.map((s) => s.key), ['product', 'add', 'cart', 'checkout']);
      assert.ok(out.steps.every((s) => s.alone != null && s.median != null));
      assert.ok(carts.every((n) => n === 0), `carts left empty: ${carts}`);
      assert.match(check.detail, /3 shoppers bought at the same time without slowing your store down/);
      note(t, check.detail);
    } finally { mock.stop(); }
  });

  it('a store that slows down with several shoppers gets a warning with the numbers', { timeout: 120000 }, async (t) => {
    const mock = await startMock({ extra: 'slowcrowd' });
    try {
      const { out, check } = await traffic(mock, { shoppers: 3 });
      assert.equal(check.status, 'warn', check.detail);
      assert.equal(check.category, 'performance');
      assert.ok(out.slow.includes('product'), `slow steps: ${out.slow}`);
      assert.match(check.detail, /Your store slowed down with 3 shoppers at once: product page took \d+\.\d s instead of \d+\.\d s/);
      assert.match(check.fix, /apps/);
      note(t, check.detail);
    } finally { mock.stop(); }
  });

  it('shoppers that break while others shop make the check fail', { timeout: 120000 }, async (t) => {
    const mock = await startMock({ extra: 'crowdfail' });
    try {
      const { out, check, carts } = await traffic(mock, { shoppers: 4 });
      assert.equal(check.status, 'fail', check.detail);
      assert.ok(out.errors.length >= 1, `errors: ${out.errors.length}`);
      assert.ok(out.errors.every((e) => e.step === 'add'));
      assert.match(check.detail, /of 4 shoppers could not finish while others were shopping: it broke at add to cart/);
      assert.ok(carts.every((n) => n === 0));
      note(t, check.detail);
    } finally { mock.stop(); }
  });

  it('runs at most once every 6 hours per store', { timeout: 120000 }, async (t) => {
    const mock = await startMock();
    try {
      const first = await traffic(mock, { storeId: 77 });
      assert.equal(first.check.status, 'pass');
      const again = await traffic(mock, { storeId: 77, dataDir: first.dataDir, now: Date.now() + 5 * 3600e3 });
      assert.equal(again.check.status, 'skip');
      assert.match(again.check.detail, /at most once every 6 hours/);
      assert.equal(again.out.skipped, 'recent');
      const later = await traffic(mock, { storeId: 77, dataDir: first.dataDir, now: Date.now() + 6.1 * 3600e3 });
      assert.equal(later.check.status, 'pass');
      note(t, `5 h later: skipped (${again.check.detail}); 6.1 h later: ran again`);
    } finally { mock.stop(); }
  });
});

describe('Sale traffic readiness in the product', { concurrency: 1 }, () => {
  let P, owner, storeId, browser, run;
  before(async () => {
    P = await startProduct({ mock: { extra: 'slowcrowd' } });
    owner = await signup(P, 'traffic@shop.test');
    const r = await owner.post('/api/stores', { url: P.mock.origin, name: 'Mock Store', alertEmail: owner.email, runNow: false });
    storeId = r.json.store?.id ?? r.json.id ?? r.json.storeId;
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('does not run until the owner switches it on, even when picked for a run', { timeout: 300000 }, async (t) => {
    const s = (await owner.get('/api/stores')).json.stores.find((x) => x.id === storeId);
    assert.equal(s.config.saleTraffic, false);
    const r = await runAndWait(owner, storeId, { kind: 'full', groups: ['sale.traffic'] });
    assert.equal(r.status, 'done', r.error || '');
    assert.equal(r.result.checks.find((c) => c.id === 'perf.traffic'), undefined);
    assert.equal(r.result.traffic, null);
    note(t, 'picked in a run without opting in: no shoppers sent');
  });

  it('switched on, a full check reports the slowdown', { timeout: 300000 }, async (t) => {
    let r = await owner.patch(`/api/stores/${storeId}`, { config: { saleTraffic: true, saleTrafficShoppers: 4 } });
    assert.equal(r.status, 200, r.text);
    const other = await signup(P, 'traffic-other@shop.test');
    assert.notEqual((await other.patch(`/api/stores/${storeId}`, { config: { saleTraffic: false } })).status, 200, 'other accounts refused');
    run = await runAndWait(owner, storeId, { kind: 'full', groups: ['sale.traffic'] });
    assert.equal(run.status, 'done', run.error || '');
    const c = run.result.checks.find((x) => x.id === 'perf.traffic');
    assert.ok(c, run.result.checks.map((x) => x.id).join(','));
    assert.equal(c.status, 'warn', c.detail);
    assert.equal(run.result.traffic.shoppers, 4);
    assert.equal(c.evidence.traffic.steps.length, 4);
    note(t, c.detail);
  });

  it('the report shows one shopper vs several, and Store settings has the switch', { timeout: 90000 }, async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#/s/${storeId}/runs/${run.id}`);
    await p.waitForSelector('.traffic-table', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    const rows = await p.locator('.traffic-table tbody tr').allTextContents();
    assert.equal(rows.length, 4);
    assert.match(await p.locator('.traffic-table thead').textContent(), /4 at once/);
    await p.locator('.traffic-table').first().scrollIntoViewIfNeeded();
    await screenshot(t, p, 'Report: sale traffic, one shopper vs four at once');
    await p.goto(`${P.base}/app#/s/${storeId}/settings`);
    await p.waitForSelector('#st', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    assert.equal(await p.isChecked('#st'), true);
    assert.equal(await p.inputValue('#stn'), '4');
    assert.deepEqual(await p.locator('#stn option').allTextContents(), ['2', '3', '4', '5'], 'no more than 5 can be chosen');
    await p.locator('#st').scrollIntoViewIfNeeded();
    await screenshot(t, p, 'Store settings: sale traffic test');
    assert.deepEqual(errors, []);
    note(t, rows.join(' | '));
    await ctx.close();
  });
});
