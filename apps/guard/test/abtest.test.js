// A/B test safety (T99): A/B tools are found on the storefront, and every test version the owner lists
// is shopped once: page loads, Add to cart works, the cart charges the price shown, checkout opens on the store.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';
import { matchTools, cleanVariants, withParam, onOwnCheckout, priceFrom } from '../src/engine/abtest.js';

const VERSIONS = [
  { name: 'Control', kind: 'param', value: 'ab_variant=a' },
  { name: 'New buy button', kind: 'param', value: 'ab_variant=b' },
  { name: 'Lower price', kind: 'cookie', value: 'ab_variant=c' },
];
const GROUPS = ['journey.core', 'sale.abtest'];
const byId = (run, id) => run.result.checks.find((c) => c.id === id);

describe('A/B test safety', () => {
  it('recognises A/B tools and reads settings, prices and checkout addresses', (t) => {
    assert.deepEqual(matchTools(['https://cdn.intelligems.io/abc.js'], []), ['Intelligems']);
    assert.deepEqual(matchTools([], ['_vwo_code']), ['VWO']);
    assert.deepEqual(matchTools(['https://cdn.optimizely.com/js/123.js', 'https://cdn-4.convertexperiments.com/js/1.js'], []), ['Optimizely', 'Convert']);
    assert.deepEqual(matchTools(['https://cdn.shopify.com/s/files/theme.js'], ['Shopify']), []);
    assert.deepEqual(cleanVariants([{ name: 'B', kind: 'param', value: '?ab=b' }, { name: 'B again', kind: 'param', value: 'ab=b' }, { name: '<x>', value: 'a=1' }, { name: 'C', kind: 'cookie', value: 'x=1' }]),
      [{ name: 'B', kind: 'param', value: 'ab=b' }, { name: 'C', kind: 'cookie', value: 'x=1' }]);
    assert.throws(() => cleanVariants([{ name: 'B', value: 'no equals sign' }], { strict: true }), /name=value/);
    assert.throws(() => cleanVariants([{ name: '', value: 'a=1' }], { strict: true }), /short name/);
    assert.throws(() => cleanVariants(Array.from({ length: 5 }, (_, i) => ({ name: `V${i}`, value: `a=${i}` })), { strict: true }), /up to 4/);
    assert.equal(withParam('https://s.test/products/x?variant=1', { kind: 'param', value: 'ab=b' }), 'https://s.test/products/x?variant=1&ab=b');
    assert.equal(withParam('https://s.test/cart', { kind: 'cookie', value: 'ab=b' }), 'https://s.test/cart');
    assert.ok(onOwnCheckout('https://shop.test/checkouts/cn/1', 'https://www.shop.test'));
    assert.ok(onOwnCheckout('https://my-shop.myshopify.com/checkouts/cn/1', 'https://shop.test'));
    assert.ok(!onOwnCheckout('https://pay-elsewhere.test/checkout', 'https://shop.test'));
    assert.equal(priceFrom('₹1,499.00'), 1499);
    assert.equal(priceFrom('Rs. 1299'), 1299);
    assert.equal(priceFrom('€ 1.299,50'), 1299.5);
    assert.equal(priceFrom('Sold out'), null);
    note(t, 'tools by script address or page global; settings cleaned; ?ab=b added to links; own vs other checkout hosts; price text parsed');
  });

  describe('on a store running a test', () => {
    let P, owner, storeId, browser;
    before(async () => {
      P = await startProduct({ mock: { extra: 'ab' } });
      owner = await signup(P, 'abtest@shop.test');
      storeId = await addStore(P, owner, { runNow: false });
      browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    });
    after(async () => { await browser?.close(); await P.stop(); });

    it('warns when an A/B tool runs but no versions are listed', async (t) => {
      const run = await runAndWait(owner, storeId, { groups: GROUPS }, 300000);
      assert.equal(run.status, 'done', run.error || '');
      const c = byId(run, 'ab.tools');
      assert.ok(c, 'A/B check reported');
      assert.equal(c.status, 'warn');
      assert.match(c.detail, /VWO/);
      assert.match(c.fix, /A\/B tests/);
      assert.ok(!run.result.checks.some((x) => x.id.startsWith('ab.variant.')), 'no versions shopped without a list');
      note(t, `ab.tools: ${c.status} — ${c.detail}`);
    });

    it('saves test versions and refuses bad ones with a plain message', async () => {
      const bad = await owner.patch(`/api/stores/${storeId}`, { config: { abVariants: [{ name: 'B', kind: 'param', value: 'just text' }] } });
      assert.equal(bad.status, 400);
      assert.match(bad.json.error, /name=value/);
      const ok = await owner.patch(`/api/stores/${storeId}`, { config: { abVariants: VERSIONS } });
      assert.equal(ok.status, 200, ok.text);
      const s = (await owner.get(`/api/stores/${storeId}`)).json;
      const cfg = (s.store || s).config;
      assert.deepEqual(cfg.abVariants, VERSIONS);
      const other = await signup(P, 'abtest-other@shop.test');
      assert.equal((await other.patch(`/api/stores/${storeId}`, { config: { abVariants: [] } })).status, 404, 'another account cannot change them');
    });

    it('shops every version and reports the broken ones', async (t) => {
      const run = await runAndWait(owner, storeId, { groups: GROUPS }, 300000);
      assert.equal(run.status, 'done', run.error || '');
      assert.equal(byId(run, 'ab.tools').status, 'pass');
      const [a, b, c] = [1, 2, 3].map((n) => byId(run, `ab.variant.${n}`));
      assert.equal(a.status, 'pass', a.detail);
      assert.match(a.detail, /Add to cart works.*checkout opens on your store/);
      assert.equal(b.status, 'fail');
      assert.equal(b.severity, 'critical');
      assert.match(b.detail, /New buy button.*Add to cart did nothing/);
      assert.ok(b.evidence?.screenshot, 'screenshot of the broken version');
      assert.equal(c.status, 'fail');
      assert.equal(c.severity, 'major');
      assert.match(c.detail, /1,?299\.00.*cart charges 1499\.00/);
      // The main journey (no version forced) is unaffected, and nothing is left in a cart.
      assert.equal(byId(run, 'fn.atc').status, 'pass');
      note(t, `Control: ${a.detail}`);
      note(t, `New buy button: ${b.detail}`);
      note(t, `Lower price: ${c.detail}`);

      const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      await ctx.addCookies(owner.browserCookies());
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`${P.base}/app#/s/${storeId}/runs/${run.id}`);
      await p.waitForSelector('text=Test version', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      await p.locator('text=New buy button').first().scrollIntoViewIfNeeded();
      await screenshot(t, p, 'report with A/B version results');
      await p.goto(`${P.base}/app#/s/${storeId}/suite/abtests`);
      await p.waitForSelector('.ab-row', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      assert.equal(await p.locator('.ab-row').count(), 3);
      assert.equal(await p.inputValue('.ab-row:nth-child(3) [name=value]'), 'ab_variant=c');
      assert.equal(await p.inputValue('.ab-row:nth-child(3) [name=kind]'), 'cookie');
      await screenshot(t, p, 'Test suite: A/B tests');
      // Add a fourth from the screen and save.
      await p.click('#adda');
      const last = p.locator('.ab-row').last();
      await last.locator('[name=name]').fill('Free gift');
      await last.locator('[name=value]').fill('ab_variant=d');
      await p.getByRole('button', { name: /save/i }).first().click();
      await p.waitForFunction(async (id) => {
        const r = await fetch(`/api/stores/${id}`); const j = await r.json(); return ((j.store || j).config.abVariants || []).length === 4;
      }, storeId, { timeout: 10000 });
      assert.deepEqual(errors, []);
      await ctx.close();
    });
  });
});
