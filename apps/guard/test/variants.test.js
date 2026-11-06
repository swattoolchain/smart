// Every-variant sweep (roadmap 5): each variant for sale is added to a cart once per full check,
// broken and unpublished variants are reported, the sweep is capped and covers big catalogs over several checks.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, request as pwRequest } from 'playwright';
import { startMock, startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.VARIANT_SWEEP_PAUSE_MS = '0';
const { runVariantSweep, pickVariants } = await import('../src/engine/variants.js');
const { Recorder } = await import('../src/engine/checks.js');
const { groupOf, GROUPS } = await import('../src/engine/catalog.js');
const { FEATURES } = await import('../src/license.js');

async function sweep(mock, opts = {}) {
  const request = await pwRequest.newContext();
  try {
    const rec = new Recorder();
    const out = await runVariantSweep({ request, origin: mock.origin, rec, ...opts });
    const counts = await (await fetch(`${mock.origin}/__addcount`)).json();
    return { out, check: rec.checks.find((c) => c.id === 'fn.variants'), counts };
  } finally { await request.dispose(); }
}

describe('Every-variant sweep', { concurrency: 1 }, () => {
  it('picks only variants for sale, caps them, and continues where the last check stopped', (t) => {
    const products = [
      { title: 'Shirt', handle: 'shirt', variants: [{ id: 1, title: 'S' }, { id: 2, title: 'M', available: false }, { id: 3, title: 'L' }] },
      { title: 'Mug', handle: 'mug', variants: [{ id: 4, title: 'Default Title' }, { id: 5, title: 'Blue' }] },
    ];
    const a = pickVariants(products, { max: 3, offset: 0 });
    assert.deepEqual(a.picked.map((v) => v.id), [1, 3, 4]);
    assert.equal(a.total, 4);
    assert.equal(a.soldOut, 1);
    assert.equal(a.picked[2].name, 'Mug', 'a product without options is named by its title only');
    assert.equal(a.picked[0].name, 'Shirt – S');
    const b = pickVariants(products, { max: 3, offset: a.next });
    assert.deepEqual(b.picked.map((v) => v.id), [5, 1, 3], 'the next check starts after the last one and wraps around');
    const all = pickVariants(products, { max: 100, offset: 3 });
    assert.deepEqual(all.picked.map((v) => v.id), [1, 3, 4, 5], 'small catalogs are always checked whole, in order');
    note(t, `cap 3 of 4: first check ${a.picked.map((v) => v.id)}, next ${b.picked.map((v) => v.id)}; sold out skipped`);
  });

  it('is its own switchable group in the full check, included with the catalog plan feature', (t) => {
    const g = GROUPS.find((x) => x.key === 'catalog.variants');
    assert.ok(g, 'group exists');
    assert.equal(g.run, 'full');
    assert.equal(groupOf('fn.variants'), 'catalog.variants');
    assert.equal(groupOf('fn.variant'), 'journey.variant', 'the journey variant check keeps its own group');
    assert.ok(FEATURES.find((f) => f.key === 'catalog').groups.includes('catalog.variants'));
    note(t, `group “${g.label}” in area “${g.area}”`);
  });

  it('a healthy store passes: every variant went into the cart and the cart was emptied', { timeout: 60000 }, async (t) => {
    const mock = await startMock();
    try {
      const { out, check, counts } = await sweep(mock);
      assert.equal(check.status, 'pass', check.detail);
      assert.equal(out.tried, 5, 'all 5 variants of the mock store');
      assert.equal(counts.adds, 5, 'one add per variant');
      assert.ok(counts.carts.every((n) => n === 0), `carts left empty: ${JSON.stringify(counts.carts)}`);
      assert.match(check.detail, /all 5 variants/);
      note(t, check.detail);
    } finally { mock.stop(); }
  });

  it('a variant shown in stock that the cart refuses fails, naming the product and option', { timeout: 60000 }, async (t) => {
    const mock = await startMock({ extra: 'brokenvariant' });
    try {
      const { check, out } = await sweep(mock);
      assert.equal(check.status, 'fail');
      assert.equal(check.severity, 'major');
      assert.equal(check.category, 'functional');
      assert.match(check.detail, /Customers can't add “Organic Cotton Kurta – Large” to the cart/);
      assert.match(check.fix, /Shopify admin → Products/);
      assert.equal(out.problems.length, 1);
      assert.deepEqual(check.evidence.variants.map((v) => [v.id, v.problem]), [[103, 'broken']]);
      assert.match(check.evidence.variants[0].message, /could not be added/);
      note(t, `${check.detail} | fix: ${check.fix}`);
    } finally { mock.stop(); }
  });

  it('a variant the cart cannot find is reported as not on the online store (warning)', { timeout: 60000 }, async (t) => {
    const mock = await startMock({ extra: 'unpublishedvariant' });
    try {
      const { check } = await sweep(mock);
      assert.equal(check.status, 'warn');
      assert.match(check.detail, /“Organic Cotton Kurta – Medium” is listed in your store but the cart can't find it/);
      assert.match(check.fix, /Online Store sales channel/);
      assert.deepEqual(check.evidence.variants.map((v) => [v.id, v.problem]), [[102, 'unpublished']]);
      note(t, check.detail);
    } finally { mock.stop(); }
  });

  it('a big catalog is capped per check, skips sold-out variants and continues next time', { timeout: 90000 }, async (t) => {
    const mock = await startMock({ extra: 'manyvariants' });
    try {
      const first = await sweep(mock, { max: 20 });
      assert.equal(first.out.total, 44, '5 + 39 colours for sale (one sold out)');
      assert.equal(first.out.soldOut, 1);
      assert.equal(first.out.tried, 20);
      assert.equal(first.counts.adds, 20, 'never more adds than the cap');
      assert.equal(first.check.status, 'pass');
      assert.match(first.check.detail, /20 of 44 variants/);
      const second = await sweep(mock, { max: 20, offset: first.out.next });
      assert.equal(second.out.start, 20);
      assert.equal(second.counts.adds - first.counts.adds, 20);
      note(t, `${first.check.detail} — next check starts at variant ${first.out.next}`);
    } finally { mock.stop(); }
  });
});

describe('Every-variant sweep: time budget', { concurrency: 1 }, () => {
  it('a slow cart: the sweep stops at its time budget, saves where it stopped, and the next check goes on from there', { timeout: 90000 }, async (t) => {
    const mock = await startMock({ extra: 'manyvariants,slowcart' });
    try {
      const saved = [];
      const t0 = Date.now();
      const first = await sweep(mock, { budgetMs: 1500, savePosition: (n) => saved.push(n) });
      const took = Date.now() - t0;
      assert.equal(first.out.cutShort, 'time');
      assert.ok(first.out.tried >= 1 && first.out.tried < 44, `tried ${first.out.tried}`);
      assert.ok(took < 5000, `stopped near its budget (${took} ms)`);
      assert.equal(first.out.next, first.out.tried, 'the next check starts after the last one tried');
      assert.equal(saved.at(-1), first.out.next, 'position saved');
      assert.equal(first.check.status, 'pass');
      assert.match(first.check.detail, new RegExp(`${first.out.tried} of 44 variants for sale \\(the store’s cart was slow, so we stopped to keep the check on time; the rest are checked in the next full checks\\)`));
      assert.deepEqual((await (await fetch(`${mock.origin}/__addcount`)).json()).carts.filter((n) => n > 0), [], 'the cart was emptied');
      const second = await sweep(mock, { budgetMs: 1500, offset: first.out.next });
      assert.equal(second.out.start, first.out.next);
      // A deadline already reached still tries one variant, so the position always moves.
      const late = await sweep(mock, { deadline: Date.now() - 1, offset: second.out.next });
      assert.equal(late.out.tried, 1);
      assert.equal(late.out.next, second.out.next + 1);
      note(t, `300 ms per add, 1.5 s budget: tried ${first.out.tried} of 44 in ${took} ms, saved position ${first.out.next}; next check started at ${second.out.start}`);
    } finally { mock.stop(); }
  });

  it('a cancelled check stops the sweep at once and empties the cart', { timeout: 60000 }, async (t) => {
    const mock = await startMock({ extra: 'manyvariants,slowcart' });
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 700);
      const saved = [];
      const r = await sweep(mock, { signal: ac.signal, savePosition: (n) => saved.push(n) });
      assert.equal(r.out.cutShort, 'cancelled');
      assert.ok(r.out.tried < 10, `tried ${r.out.tried}`);
      assert.equal(saved.at(-1), r.out.next);
      assert.deepEqual(r.counts.carts.filter((n) => n > 0), [], 'the cart was emptied');
      note(t, `cancelled after ${r.out.tried} variants; position ${r.out.next} saved; cart empty`);
    } finally { mock.stop(); }
  });
});

describe('Every-variant sweep in a full check', { concurrency: 1 }, () => {
  let P, owner, storeId, browser;
  before(async () => {
    P = await startProduct({ env: { VARIANT_SWEEP_PAUSE_MS: '0' }, mock: { extra: 'brokenvariant,unpublishedvariant' } });
    owner = await signup(P, 'variants@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  let run;
  it('a full check reports the broken and the missing variant, and the alert-worthy one fails', { timeout: 300000 }, async (t) => {
    run = await runAndWait(owner, storeId, { kind: 'full', groups: ['catalog', 'catalog.variants'] }, 280000);
    assert.equal(run.status, 'done', run.error || '');
    const c = run.result.checks.find((x) => x.id === 'fn.variants');
    assert.ok(c, `fn.variants present: ${run.result.checks.map((x) => x.id).join(',')}`);
    assert.equal(c.status, 'fail');
    assert.match(c.detail, /Organic Cotton Kurta – Large/);
    assert.match(c.detail, /Organic Cotton Kurta – Medium/);
    assert.equal(run.result.variants.tried, 5);
    assert.equal(run.result.variants.problems.length, 2);
    note(t, c.detail);
  });

  it('switching the group off skips the sweep', { timeout: 300000 }, async (t) => {
    const r = await runAndWait(owner, storeId, { kind: 'full', groups: ['catalog'] }, 280000);
    assert.equal(r.status, 'done', r.error || '');
    assert.equal(r.result.checks.find((x) => x.id === 'fn.variants'), undefined);
    const adds = (await (await fetch(`${P.mock.origin}/__addcount`)).json()).adds;
    note(t, `no fn.variants check; mock store saw ${adds} cart adds in total (journey adds included)`);
  });

  it('the report lists each variant with what the store said', { timeout: 60000 }, async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#/s/${storeId}/runs/${run.id}`);
    await p.waitForSelector('.variant-list li', { timeout: 20000 }).catch(() => {});
    if (!(await p.locator('.variant-list li').count())) {
      await p.goto(`${P.base}/app#/s/${storeId}/reports/${run.id}`);
      await p.waitForSelector('.variant-list li', { timeout: 20000 });
    }
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    const items = await p.locator('.variant-list li').allTextContents();
    assert.equal(items.length >= 2, true);
    assert.ok(items.some((x) => /Large/.test(x) && /cart refuses it/.test(x)), items.join(' | '));
    assert.ok(items.some((x) => /Medium/.test(x) && /cart can't find it/.test(x)), items.join(' | '));
    await p.locator('.variant-list').first().scrollIntoViewIfNeeded();
    await screenshot(t, p, 'Report: variants the cart refuses or cannot find');
    assert.deepEqual(errors, []);
    note(t, items.join(' | '));
    await ctx.close();
  });
});
