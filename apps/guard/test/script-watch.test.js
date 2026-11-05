// Script watch (S1): every script and outside site on the home, product and cart pages is recorded per check;
// a new script is reported once, a script from a known malicious site is critical.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.BAD_DOMAINS = '';
const { scriptKey, pageKind, isBadHost, badDomains } = await import('../src/engine/scripts.js');

const find = (run, id) => run.result.checks.find((c) => c.id === id);
const mails = (P, re) => (P.log().match(new RegExp(`\\[mail skipped\\] to=[^\\n]* subject=[^\\n]*${re}`, 'g')) || []).length;

describe('Script watch', () => {
  let P, owner, storeId, runs = [];
  const toggle = (q) => fetch(`${P.mock.origin}/__extra?${q}`).then((r) => r.json());
  const journeys = async () => { const r = await runAndWait(owner, storeId, { kind: 'journeys' }); runs.push(r); assert.equal(r.status, 'done', r.error || ''); return r; };
  before(async () => {
    P = await startProduct({ env: { BAD_DOMAINS: 'evil-cdn.localhost' } });
    owner = await signup(P, 'scripts@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
  });
  after(async () => { await P?.stop(); });

  it('the first check records every script and outside site on the home, product and cart pages', async (t) => {
    const r = await journeys();
    const s = r.result.scripts;
    assert.deepEqual(Object.keys(s.pages).sort(), ['cart', 'home', 'product']);
    for (const k of ['home', 'product', 'cart']) assert.ok(s.pages[k].scripts.some((x) => x.url.endsWith('/assets/theme.js')), `theme script on ${k}`);
    assert.equal(s.baseline, true);
    assert.equal(find(r, 'sec.scripts.new').status, 'pass');
    assert.match(find(r, 'sec.scripts.new').detail, /First record of your store's scripts/);
    assert.equal(find(r, 'sec.scripts.bad').status, 'pass');
    assert.ok(!JSON.stringify(s).includes('?v='), 'cache-busters are not part of the record');
    note(t, `First record: ${s.counts.scripts} scripts, ${s.counts.sites} outside sites; pages ${Object.keys(s.pages).join(', ')}`);
  });

  it('the same scripts next time: nothing new, no alert', async () => {
    const r = await journeys();
    assert.equal(find(r, 'sec.scripts.new').status, 'pass');
    assert.match(find(r, 'sec.scripts.new').detail, /^Same \d+ scripts? as the last check/);
    assert.deepEqual(r.result.scripts.added, []);
  });

  it('a new script on every page is reported once, with where it is and where it comes from', async (t) => {
    const verdictBefore = runs.at(-1).verdict;
    await toggle('newscript=1');
    const r = await journeys();
    const c = find(r, 'sec.scripts.new');
    assert.equal(c.status, 'fail');
    assert.equal(c.severity, 'major');
    assert.match(c.detail, /^1 new script since the last check, 1 on the product or cart page|^1 new script since the last check/);
    assert.match(c.detail, /review-widget\.js/);
    const host = P.mock.origin.replace('localhost', '127.0.0.1').replace('http://', '');
    assert.deepEqual(r.result.scripts.added.map((x) => x.url), [`http://${host}/apps/review-widget.js`]);
    assert.deepEqual(r.result.scripts.addedSites, [host]);
    assert.equal(r.verdict, verdictBefore, 'a new script never changes the health verdict');
    // One alert email, naming the check.
    const until = Date.now() + 5000;
    while (!mails(P, 'No new scripts since the last check') && Date.now() < until) await new Promise((res) => setTimeout(res, 100));
    assert.equal(mails(P, 'No new scripts since the last check'), 1);
    note(t, c.detail);
  });

  it('the next check with the same scripts passes quietly: no "fixed" email', async () => {
    const r = await journeys();
    assert.equal(find(r, 'sec.scripts.new').status, 'pass');
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(mails(P, 'Fixed on [^\\n]*No new scripts'), 0);
    assert.equal(mails(P, 'No new scripts since the last check'), 1, 'still just the one email');
  });

  it('the Scripts and apps tab lists every script per page, new ones marked', async (t) => {
    const runId = runs[2].id;
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      await ctx.addCookies(owner.browserCookies());
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`${P.base}/app#/s/${storeId}/reports/${runId}`);
      await p.waitForSelector('[data-rtab=scripts]', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      assert.match(await p.textContent('[data-rtab=scripts]'), /Scripts and apps\s*1/);
      await p.click('[data-rtab=scripts]');
      const pane = p.locator('[data-pane=scripts]');
      assert.ok(await pane.isVisible());
      assert.equal(await pane.locator('h3').count(), 3, 'home, product and cart');
      assert.ok((await pane.locator('.tag-new').count()) >= 1);
      assert.match(await pane.textContent(), /review-widget\.js/);
      await screenshot(t, p, 'Scripts and apps tab with a new script', { fullPage: true });
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  it('a script from a known malicious site is critical', async (t) => {
    await toggle('badscript=1');
    try {
      const r = await journeys();
      const c = find(r, 'sec.scripts.bad');
      assert.equal(c.status, 'fail');
      assert.equal(c.severity, 'critical');
      assert.match(c.detail, /evil-cdn\.localhost/);
      assert.equal(r.verdict, 'critical');
      assert.match(r.result.summary, /known malicious website/);
      assert.deepEqual(r.result.scripts.bad.map((h) => h.replace(/:\d+$/, '')), ['evil-cdn.localhost']);
      note(t, `${c.title}: ${c.detail}`);
    } finally { await toggle('badscript=0'); }
  });

  it('switching Script watch off in the test suite stops it', async () => {
    const pr = await owner.patch(`/api/stores/${storeId}`, { config: { disabled: ['security.scripts'] } });
    assert.equal(pr.status, 200, pr.text);
    const r = await journeys();
    assert.ok(!r.result.checks.some((c) => c.id.startsWith('sec.scripts')));
    assert.equal(r.result.scripts, null);
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { config: { disabled: [] } })).status, 200);
  });

  it('script addresses, pages and the bad-site list', () => {
    assert.equal(scriptKey('https://cdn.shopify.com/s/files/1/0001/t/12/assets/global.js?v=123'), 'cdn.shopify.com/s/files/1/0001/t/*/assets/global.js');
    assert.equal(scriptKey('https://cdn.shopify.com/s/files/1/0001/t/13/assets/global.js?v=456'), 'cdn.shopify.com/s/files/1/0001/t/*/assets/global.js', 'theme id and version ignored');
    assert.equal(scriptKey('https://cdn.shopify.com/extensions/0193a1b2-aaaa-bbbb-cccc-123456789abc/1.2.3/assets/app.js'), 'cdn.shopify.com/extensions/*/*/assets/app.js');
    assert.equal(scriptKey('https://apps.example/widget.3f2a9b8c7d.js'), 'apps.example/widget.*.js');
    assert.notEqual(scriptKey('https://apps.example/widget.js'), scriptKey('https://skim.example/widget.js'), 'different sites are different scripts');
    assert.equal(pageKind('https://s.example/'), 'home');
    assert.equal(pageKind('https://s.example/products/kurta'), 'product');
    assert.equal(pageKind('https://s.example/collections/all/products/kurta'), 'product');
    assert.equal(pageKind('https://s.example/cart'), 'cart');
    assert.equal(pageKind('https://s.example/search?q=x'), null);
    assert.ok(badDomains().includes('coinhive.com'));
    assert.equal(isBadHost('www.coinhive.com'), true);
    assert.equal(isBadHost('notcoinhive.com'), false);
    assert.equal(isBadHost('cdn.shopify.com'), false);
  });
});
