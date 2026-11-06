// A/B test safety (T99): A/B tools are found on the storefront, and every test version the owner lists
// is shopped once: page loads, Add to cart works, the cart charges the price shown, checkout opens on the store.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';
import { matchTools, cleanVariants, withParam, onOwnCheckout, priceFrom, convertSeen, convertVariant, optimizelySeen, optimizelyVariant, AUTO_TOOLS } from '../src/engine/abtest.js';

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

// T106: versions found and forced automatically, for tools whose forcing method is documented (Convert).
describe('A/B test safety: versions found on our own', () => {
  it('reads Convert versions from the page and builds the documented forcing link', () => {
    assert.deepEqual(convertSeen({ 100: { variation: { id: '1002', name: 'Sticky <b>bar' } }, bad: { variation: { id: '1' } }, 200: { variation: { id: 'x' } } }),
      [{ exp: '100', id: '1002', label: 'Sticky bbar' }]);
    assert.deepEqual(convertSeen(null), []);
    const v = convertVariant({ exp: '100', id: '1002', label: 'Sticky bar' });
    assert.deepEqual(v, { name: 'Sticky bar (Convert)', kind: 'param', value: '_conv_eforce=100.1002', auto: 'Convert' });
    assert.equal(withParam('https://s.test/products/x?variant=1', v), 'https://s.test/products/x?variant=1&_conv_eforce=100.1002');
    assert.deepEqual(AUTO_TOOLS, ['Convert', 'Optimizely']);
  });

  describe('on a store running a Convert test, with nothing listed', () => {
    let P, owner, storeId;
    before(async () => {
      P = await startProduct({ mock: { extra: 'convert' } });
      owner = await signup(P, 'abtest-convert@shop.test');
      storeId = await addStore(P, owner, { runNow: false });
    });
    after(async () => { await P.stop(); });

    it('finds both versions, forces each one and reports the broken one', async (t) => {
      const run = await runAndWait(owner, storeId, { groups: GROUPS }, 300000);
      assert.equal(run.status, 'done', run.error || '');
      const tools = byId(run, 'ab.tools');
      assert.equal(tools.status, 'pass', tools.detail);
      assert.match(tools.detail, /Convert/);
      assert.match(tools.detail, /found 2 Convert test versions on our own/);
      const vs = run.result.checks.filter((c) => c.id.startsWith('ab.variant.'));
      assert.equal(vs.length, 2);
      const orig = vs.find((c) => /Original/.test(c.title));
      const sticky = vs.find((c) => /Sticky buy bar/.test(c.title));
      assert.equal(orig.status, 'pass', orig.detail);
      assert.equal(sticky.status, 'fail');
      assert.equal(sticky.severity, 'critical');
      assert.match(sticky.detail, /Add to cart did nothing/);
      assert.equal(sticky.evidence.variant, '_conv_eforce=100.1002');
      assert.equal(sticky.evidence.found, 'Convert');
      note(t, tools.detail);
      note(t, `${orig.title}: ${orig.detail}`);
      note(t, `${sticky.title}: ${sticky.detail}`);

      const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
      try {
        const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
        await ctx.addCookies(owner.browserCookies());
        const p = await ctx.newPage();
        const errors = [];
        p.on('pageerror', (e) => errors.push(e.message));
        await p.goto(`${P.base}/app#/s/${storeId}/runs/${run.id}`);
        await p.waitForSelector('text=Sticky buy bar', { timeout: 20000 });
        await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
        await p.locator('text=Sticky buy bar').first().scrollIntoViewIfNeeded();
        await screenshot(t, p, 'report: Convert versions found and shopped on our own');
        await p.goto(`${P.base}/app#/s/${storeId}/suite/abtests`);
        await p.waitForSelector('#ab-auto', { timeout: 20000 });
        await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
        await screenshot(t, p, 'Test suite: A/B tests explains Convert needs no list');
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  });
});

// T107: Optimizely versions read from optimizely.get('data') and forced with ?optimizely_x=<variationId>.
describe('A/B test safety: Optimizely versions found on our own', () => {
  it('reads every version of each Optimizely experiment and builds the documented forcing link', (t) => {
    const seen = optimizelySeen({
      200: { id: '200', name: 'Price <i>test', variations: [{ id: '2001', name: 'Original' }, { id: '2002', name: 'Lower price' }] },
      300: { id: '300', name: 'One version', variations: [{ id: '3001', name: 'Greeting' }] },
      bad: { id: 'x', variations: [{ id: '1' }, { id: '2' }] },
      400: { id: '400', name: 'Hero', variations: [{ id: '4001' }, { id: 'nope' }, { id: '4002', name: 'New hero' }, { id: '4003' }, { id: '4004' }] },
    });
    assert.deepEqual(seen, [
      { exp: '200', id: '2001', test: 'Price itest', label: 'Original' },
      { exp: '200', id: '2002', test: 'Price itest', label: 'Lower price' },
      { exp: '400', id: '4001', test: 'Hero', label: 'version 4001' },
      { exp: '400', id: '4002', test: 'Hero', label: 'New hero' },
    ], 'one-version experiments and bad ids are skipped; at most 4 versions');
    assert.deepEqual(optimizelySeen(null), []);
    assert.deepEqual(optimizelySeen([{ id: '9', variations: [{ id: '91' }, { id: '92' }] }]).length, 2);
    const v = optimizelyVariant(seen[1]);
    assert.deepEqual(v, { name: 'Lower price (Optimizely)', kind: 'param', value: 'optimizely_x=2002', auto: 'Optimizely' });
    assert.equal(withParam('https://s.test/cart', v), 'https://s.test/cart?optimizely_x=2002');
    note(t, 'Optimizely: versions come from optimizely.get("data").experiments; each is forced with ?optimizely_x=<variation id>.');
  });

  describe('on a store running an Optimizely test, with nothing listed', () => {
    let P, owner, storeId;
    before(async () => {
      P = await startProduct({ mock: { extra: 'optimizely' } });
      owner = await signup(P, 'abtest-optimizely@shop.test');
      storeId = await addStore(P, owner, { runNow: false });
    });
    after(async () => { await P.stop(); });

    it('finds both versions in one visit, forces each one and reports the one with the wrong price', async (t) => {
      const run = await runAndWait(owner, storeId, { groups: GROUPS }, 300000);
      assert.equal(run.status, 'done', run.error || '');
      const tools = byId(run, 'ab.tools');
      assert.equal(tools.status, 'pass', tools.detail);
      assert.match(tools.detail, /found 2 Optimizely test versions on our own/);
      const vs = run.result.checks.filter((c) => c.id.startsWith('ab.variant.'));
      assert.equal(vs.length, 2, 'the one-version experiment is not shopped');
      const orig = vs.find((c) => /Original/.test(c.title));
      const lower = vs.find((c) => /Lower price/.test(c.title));
      assert.equal(orig.status, 'pass', orig.detail);
      assert.equal(lower.status, 'fail');
      assert.equal(lower.severity, 'major');
      assert.match(lower.detail, /1,?299\.00.*cart charges 1499\.00/);
      assert.equal(lower.evidence.variant, 'optimizely_x=2002');
      assert.equal(lower.evidence.found, 'Optimizely');
      note(t, tools.detail);
      note(t, `${orig.title}: ${orig.detail}`);
      note(t, `${lower.title}: ${lower.detail}`);

      const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
      try {
        const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
        await ctx.addCookies(owner.browserCookies());
        const p = await ctx.newPage();
        const errors = [];
        p.on('pageerror', (e) => errors.push(e.message));
        await p.goto(`${P.base}/app#/s/${storeId}/runs/${run.id}`);
        await p.waitForSelector('text=Lower price (Optimizely)', { timeout: 20000 });
        await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
        await p.locator('text=Lower price (Optimizely)').first().scrollIntoViewIfNeeded();
        await screenshot(t, p, 'report: Optimizely versions found and shopped on our own');
        await p.goto(`${P.base}/app#/s/${storeId}/suite/abtests`);
        await p.waitForSelector('#ab-auto', { timeout: 20000 });
        assert.match(await p.textContent('#ab-auto'), /Optimizely/);
        await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
        await screenshot(t, p, 'Test suite: A/B tests explains Optimizely needs no list');
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  });
});
