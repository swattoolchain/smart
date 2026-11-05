// Product catalog checks: zero prices, placeholder text, missing images, fake discounts and duplicate SKUs
// are found, a healthy catalog passes, and the Catalog page lists every problem for the owner.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMock, startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';
import { fetchCatalog, validateCatalog, diffCatalog } from '../src/engine/products.js';

// fetchCatalog takes a Playwright-style request object; plain fetch is enough against the mock store.
const request = {
  get: async (url) => {
    const r = await fetch(url);
    const body = await r.text();
    return { ok: () => r.ok, json: async () => JSON.parse(body), text: async () => body };
  },
};
const snapshotOf = async (extra) => {
  const mock = await startMock({ extra });
  try { return await fetchCatalog(request, mock.origin); } finally { mock.stop(); }
};
const find = (issues, handle, type, re) => issues.find((i) => i.handle === handle && i.type === type && re.test(i.message));
const check = (run, id) => run.result.checks.find((c) => c.id === id);

describe('Catalog checks on the product data', () => {
  let broken, clean;
  before(async () => {
    broken = await snapshotOf('placeholder,sale');
    clean = await snapshotOf('clean');
  });

  it('reads the whole catalog with its currency', (t) => {
    assert.equal(broken.count, 3);
    assert.equal(broken.currency, 'INR');
    assert.equal(broken.truncated, false);
    note(t, `${broken.count} products read, currency ${broken.currency}`);
  });

  it('a product priced at zero is a serious issue', (t) => {
    const issues = validateCatalog(broken);
    const i = find(issues, 'brass-diya', 'pricing', /Priced at zero/);
    assert.ok(i, 'zero price found');
    assert.equal(i.severity, 'critical');
    assert.match(i.message, /order it for free/);
    assert.equal(issues[0].severity, 'critical', 'serious issues come first');
    note(t, `Brass Diya Set: ${i.message}`);
  });

  it('placeholder text in a description is found, with the words that gave it away', (t) => {
    const issues = validateCatalog(broken);
    const lorem = find(issues, 'silk-saree', 'content', /Lorem ipsum/);
    const tbd = find(issues, 'silk-saree', 'content', /Unfinished placeholder/);
    assert.ok(lorem && tbd, 'both placeholder kinds found');
    assert.equal(lorem.severity, 'major');
    assert.match(lorem.snippet, /Lorem ipsum/i);
    assert.equal(tbd.snippet, 'TBD');
    assert.ok(!find(validateCatalog(clean), 'silk-saree', 'content', /placeholder|Lorem/i), 'the real description is not flagged');
    note(t, `${lorem.message} / ${tbd.message}`);
  });

  it('a product without images is found', (t) => {
    const i = find(validateCatalog(broken), 'brass-diya', 'media', /No product images/);
    assert.ok(i);
    assert.equal(i.severity, 'major');
    note(t, `Brass Diya Set: ${i.message}`);
  });

  it('a compare-at price that is not higher than the price is a fake discount', (t) => {
    const i = find(validateCatalog(broken), 'cotton-kurta', 'pricing', /not a real discount/);
    assert.ok(i, 'fake discount found');
    assert.equal(i.severity, 'major');
    assert.equal(i.variant, 'Small', 'names the variant');
    assert.match(i.message, /₹1,299/);
    assert.match(i.message, /₹1,499/);
    note(t, `Organic Cotton Kurta: ${i.message}`);
  });

  it('a real sale (compare-at higher than the price) is not flagged', () => {
    const snap = structuredClone(clean);
    const v = snap.products.find((p) => p.handle === 'cotton-kurta').variants[0];
    v.compareAt = 1999;
    assert.equal(validateCatalog(snap).length, 0);
  });

  it('a SKU used by two products is found on both, once each', (t) => {
    const issues = validateCatalog(broken).filter((i) => i.type === 'data');
    assert.deepEqual(issues.map((i) => i.handle).sort(), ['brass-diya', 'cotton-kurta']);
    assert.ok(issues.every((i) => i.snippet === 'KUR-S' && /Duplicate SKUs/.test(i.message)));
    note(t, issues[0].message);
  });

  it('a healthy catalog has no issues at all', (t) => {
    const issues = validateCatalog(clean);
    assert.deepEqual(issues, [], issues.map((i) => `${i.handle}: ${i.message}`).join('\n'));
    note(t, `${clean.count} products, 0 issues`);
  });

  it('a word typed twice is found, but a title running into its description is not', (t) => {
    // Bug found by this suite: “Brass Diya Set” + “Set of four…” was reported as the repeated word “Set Set”.
    assert.ok(!validateCatalog(clean).some((i) => /Repeated word/.test(i.message)));
    const snap = structuredClone(clean);
    const p = snap.products.find((x) => x.handle === 'brass-diya');
    p.text = 'Set of four hand-cast brass diyas for for Diwali and everyday puja.';
    const i = find(validateCatalog(snap), 'brass-diya', 'content', /Repeated word/);
    assert.ok(i, 'real doubled word still found');
    assert.equal(i.snippet, 'for for');
    note(t, i.message);
  });

  it('a big price drop since the last check is flagged, and the change is logged', async (t) => {
    const before = await snapshotOf('clean');
    const after = await snapshotOf('clean,price'); // the kurta's Small size drops from 1,499 to 699
    const i = find(validateCatalog(after, before), 'cotton-kurta', 'pricing', /dropped 53%/);
    assert.ok(i, 'price drop found');
    assert.equal(i.severity, 'major');
    const d = diffCatalog(after, before);
    assert.equal(d.totals.price, 1);
    const f = d.changes[0].fields.find((x) => x.field === 'price');
    assert.deepEqual([f.before, f.after], [1499, 699]);
    note(t, i.message);
  });
});

describe('Catalog checks in a full check and on the Catalog page', () => {
  let P, owner, storeId, run, browser;
  before(async () => {
    P = await startProduct({ mock: { extra: 'placeholder,sale' } });
    owner = await signup(P, 'catalog@shop.test');
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

  it('before any full check, the Catalog page explains there is no snapshot yet', async () => {
    const r = await owner.get(`/api/stores/${storeId}/catalog`);
    assert.equal(r.status, 404);
    assert.match(r.json.error, /Run a full check first/);
  });

  it('a catalog check reports each problem in plain words', { timeout: 300000 }, async (t) => {
    run = await runAndWait(owner, storeId, { groups: ['catalog'] }, 280000);
    assert.equal(run.status, 'done', run.error || '');
    assert.equal(run.kind, 'full');
    assert.equal(check(run, 'cat.pricing').status, 'fail', 'zero price fails the pricing check');
    assert.match(check(run, 'cat.pricing').detail, /Brass Diya Set/);
    assert.equal(check(run, 'cat.content').status, 'warn');
    assert.equal(check(run, 'cat.media').status, 'warn');
    assert.equal(check(run, 'cat.data').status, 'warn');
    assert.equal(run.result.catalog.count, 3);
    for (const id of ['cat.pricing', 'cat.content', 'cat.media', 'cat.data']) note(t, `${id} ${check(run, id).status}: ${check(run, id).detail}`);
  });

  it('the catalog view lists every problem, grouped, worst products first', async (t) => {
    const r = await owner.get(`/api/stores/${storeId}/catalog`);
    assert.equal(r.status, 200);
    const c = r.json;
    assert.equal(c.run.id, run.id);
    assert.equal(c.currency, 'INR');
    assert.equal(c.summary.products, 3);
    assert.equal(c.summary.withIssues, 3);
    assert.ok(c.summary.critical >= 1);
    for (const type of ['pricing', 'content', 'media', 'data']) assert.ok(c.byType[type]?.length, `${type} issues listed`);
    assert.equal(c.products[0].handle, 'brass-diya', 'the zero-priced product is listed first');
    assert.equal(c.products[0].worst, 'critical');
    note(t, `summary ${JSON.stringify(c.summary)}; groups ${Object.keys(c.byType).join(', ')}`);
  });

  it('another account cannot read this catalog', async () => {
    const other = await signup(P, 'catalog-other@shop.test');
    const r = await other.get(`/api/stores/${storeId}/catalog`);
    assert.ok([403, 404].includes(r.status), `got ${r.status}`);
    assert.ok(!/Brass Diya/.test(r.text));
  });

  it('the Catalog page shows the issues and all products', async (t) => {
    const p = await page();
    await p.goto(`${P.base}/app#/s/${storeId}/catalog`);
    await p.waitForSelector('.figures', { timeout: 20000 });
    await quiet(p);
    const text = await p.textContent('.main-inner');
    for (const s of ['Priced at zero', 'not a real discount', 'Lorem ipsum', 'No product images', 'KUR-S']) assert.ok(text.includes(s), `page shows “${s}”`);
    assert.ok((await p.locator('.sev.fail').count()) >= 1, 'a serious issue is marked');
    await screenshot(t, p, 'Catalog issues', { fullPage: true });

    await p.goto(`${P.base}/app#/s/${storeId}/catalog/products`);
    await p.waitForSelector('table.data tbody tr', { timeout: 20000 });
    await quiet(p);
    assert.equal(await p.locator('table.data tbody tr').count(), 3);
    assert.match(await p.textContent('table.data tbody tr:first-child'), /Brass Diya Set/);
    await screenshot(t, p, 'Catalog, all products');
    assert.deepEqual(p.errors, []);
  });
});

describe('Catalog checks on a healthy store', () => {
  let P, owner, storeId;
  before(async () => {
    P = await startProduct({ mock: { extra: 'clean' } });
    owner = await signup(P, 'catalog-clean@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
  });
  after(async () => { await P.stop(); });

  it('every catalog check passes and the Catalog page has no issues', { timeout: 300000 }, async (t) => {
    const run = await runAndWait(owner, storeId, { groups: ['catalog'] }, 280000);
    assert.equal(run.status, 'done', run.error || '');
    for (const id of ['cat.pricing', 'cat.content', 'cat.media']) assert.equal(check(run, id).status, 'pass', `${id}: ${check(run, id).detail}`);
    assert.equal(check(run, 'cat.data'), undefined, 'no SKU warning');
    const c = (await owner.get(`/api/stores/${storeId}/catalog`)).json;
    assert.equal(c.summary.withIssues, 0);
    assert.deepEqual(c.byType, {});
    note(t, `${check(run, 'cat.pricing').detail} ${check(run, 'cat.media').detail}`);
  });
});
