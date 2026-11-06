// Safe to publish: a draft theme or a staging store is tested side by side with the live store,
// and the owner gets one verdict: safe, review or blocked.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, startMock, signup, addStore, shopifyOpen } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

describe('Safe to publish', () => {
  // The live store is healthy. Its draft theme (?preview_theme_id=…) has a new look and a broken add to cart.
  // Three staging stores stand in for candidates: one broken, one that only looks different, one identical.
  let P, broken, looks, same, owner, storeId, browser;
  const envs = {};
  before(async () => {
    P = await startProduct({ mock: { draftBreaks: 'theme,atc' } });
    [broken, looks, same] = await Promise.all([startMock({ breaks: 'atc' }), startMock({ breaks: 'theme' }), startMock()]);
    owner = await signup(P, 'publisher@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); for (const m of [broken, looks, same]) m?.stop(); await P.stop(); });

  async function waitRelease(s, sid, rid, ms = 300000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const r = await s.get(`/api/stores/${sid}/releases/${rid}`);
      assert.equal(r.status, 200, r.text);
      if (r.json.status !== 'running') return r.json;
      await new Promise((res) => setTimeout(res, 1000));
    }
    throw new Error(`publish check ${rid} did not finish`);
  }
  async function open(s, hash) {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(s.browserCookies());
    const p = await ctx.newPage();
    p.errors = [];
    p.on('pageerror', (e) => p.errors.push(e.message));
    await p.goto(`${P.base}/app${hash}`);
    return p;
  }
  const quiet = (p) => p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));

  it('accepts only this store\'s draft preview links', async (t) => {
    const bad = [
      [P.mock.origin + '/', /link to your live store/],
      ['https://other-store.com/?preview_theme_id=5', /isn't for/],
      ['not a link at all ::', /full preview link|isn't for/],
    ];
    for (const [url, msg] of bad) {
      const r = await owner.post(`/api/stores/${storeId}/releases`, { url });
      assert.equal(r.status, 400, url);
      assert.match(r.json.error, msg);
    }
    assert.equal((await owner.post(`/api/stores/${storeId}/releases`, { themeId: '12ab' })).status, 400, 'theme ids are numbers');
    assert.equal((await owner.get(`/api/stores/${storeId}/releases`)).json.releases.length, 0, 'nothing started');
    note(t, `${bad.length} wrong links refused with an explanation; a bad theme id refused`);
  });

  it('a draft that breaks add to cart is blocked, with the broken check named (Shopify theme picker)', async (t) => {
    const shop = await shopifyOpen(P, 'publish-shop.myshopify.com');
    const themes = await shop.get(`/api/stores/${shop.storeId}/shopify/themes`);
    assert.equal(themes.status, 200, themes.text);
    assert.equal(themes.json.themes.length, 1);
    const draft = themes.json.themes[0];
    assert.equal(draft.id, '222');
    assert.equal((await owner.get(`/api/stores/${storeId}/shopify/themes`)).json.themes, null, 'website stores have no theme list');

    const start = await shop.post(`/api/stores/${shop.storeId}/releases`, { themeId: draft.id, themeName: draft.name });
    assert.equal(start.status, 200, start.text);
    const busy = await shop.post(`/api/stores/${shop.storeId}/run`, {});
    assert.equal(busy.status, 409, 'no second test while a publish check runs');
    const r = await waitRelease(shop, shop.storeId, start.json.id);
    assert.equal(r.status, 'done', JSON.stringify(r.summary));
    assert.equal(r.verdict, 'blocked');
    assert.equal(r.label, draft.name);
    assert.ok(r.summary.blockers.length >= 1);
    assert.ok(r.summary.blockers.some((b) => /cart/i.test(b.title + b.detail)), `blockers: ${r.summary.blockers.map((b) => b.title).join(', ')}`);
    assert.match(r.summary.headline, /breaks? on the draft/);
    assert.equal(r.summary.theme.draft?.role, 'unpublished');
    assert.equal(r.summary.theme.live?.role, 'main');
    assert.ok(r.compare, 'side-by-side comparison is included');

    const list = (await shop.get(`/api/stores/${shop.storeId}/releases`)).json.releases;
    assert.equal(list[0].verdict, 'blocked');
    assert.equal(list[0].summary.counts.blockers, r.summary.blockers.length);
    note(t, `"${r.summary.headline}" — ${r.summary.blockers.map((b) => b.title).join('; ')}`);
  });

  it('saves staging environments, refuses bad ones, and keeps their keys private', async (t) => {
    const add = (body) => owner.post(`/api/stores/${storeId}/environments`, body);
    assert.equal((await add({ kind: 'store', url: broken.origin })).status, 400, 'a name is needed');
    assert.match((await add({ name: 'Live', kind: 'store', url: P.mock.origin })).json.error, /your live store/);
    for (const [k, m] of [['broken', broken], ['looks', looks], ['same', same]]) {
      const r = await add({ name: `Staging ${k}`, kind: 'store', url: m.origin + '/some/page' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.url, m.origin, 'only the address of the site is kept');
      assert.match(r.json.token, /^tg_/);
      envs[k] = r.json;
    }
    const old = envs.broken.token;
    const fresh = await owner.post(`/api/stores/${storeId}/environments/${envs.broken.id}/token`);
    assert.notEqual(fresh.json.token, old, 'a new key replaces the old one');
    envs.broken = fresh.json;
    assert.equal((await P.session().post('/api/gate', {}, { authorization: `Bearer ${old}` })).status, 401, 'the old key no longer works');
    const other = await signup(P);
    assert.equal((await other.get(`/api/stores/${storeId}/environments`)).status, 404);
    note(t, `3 staging environments saved; old pipeline key refused after a new one was made`);
  });

  it('a deploy pipeline gets "blocked" for a broken staging store, and the owner is emailed', async (t) => {
    const gate = P.session();
    const auth = { authorization: `Bearer ${envs.broken.token}` };
    const start = await gate.post('/api/gate', { label: 'commit abc123' }, auth);
    assert.equal(start.status, 202, start.text);
    assert.equal(start.json.done, false);
    assert.equal(start.json.pass, null);
    // Asking again while it runs returns the same check instead of starting another.
    assert.equal((await gate.post('/api/gate', {}, auth)).json.id, start.json.id);
    let g;
    for (let i = 0; i < 300; i++) {
      g = (await gate.get(`/api/gate/check/${start.json.id}`, auth)).json;
      if (g.done) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(g.status, 'done', JSON.stringify(g));
    assert.equal(g.verdict, 'blocked');
    assert.equal(g.pass, false, 'the pipeline must stop the deploy');
    assert.ok(g.blockers.length >= 1);
    assert.match(g.report, new RegExp(`#/s/${storeId}/publish/${start.json.id}$`));
    assert.equal((await gate.get(`/api/gate/check/${start.json.id}`, { authorization: `Bearer ${envs.same.token}` })).status, 404, 'another environment\'s key can\'t read it');
    await new Promise((r) => setTimeout(r, 500));
    assert.match(P.log(), /subject=Don't publish Staging broken yet/);
    const p = await open(owner, `#/s/${storeId}/publish/${start.json.id}`);
    await p.waitForFunction(() => /breaks? on Staging broken/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 20000 });
    await quiet(p);
    await screenshot(t, p, 'Blocked: broken staging store', { fullPage: true });
    assert.deepEqual(p.errors, []);
    await p.context().close();
    note(t, `pipeline verdict: ${g.verdict}, pass=${g.pass}: ${g.headline}`);
  });

  it('a staging store that only looks different needs a review, nothing is broken', async (t) => {
    const start = await owner.post(`/api/stores/${storeId}/releases`, { environmentId: envs.looks.id });
    assert.equal(start.status, 200, start.text);
    const r = await waitRelease(owner, storeId, start.json.id);
    assert.equal(r.status, 'done', JSON.stringify(r.summary));
    assert.equal(r.verdict, 'review', r.summary.headline);
    assert.equal(r.summary.blockers.length, 0);
    assert.match(r.summary.headline, /Nothing is broken/);
    assert.equal(r.environment.name, 'Staging looks');
    const p = await open(owner, `#/s/${storeId}/publish/${r.id}`);
    await p.waitForFunction(() => /Nothing is broken/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 20000 });
    await quiet(p);
    await screenshot(t, p, 'Review: looks different', { fullPage: true });
    await p.context().close();
    note(t, r.summary.headline);
  });

  it('an identical staging store is safe to publish', async (t) => {
    const start = await owner.post(`/api/stores/${storeId}/releases`, { environmentId: envs.same.id, label: 'Same as live' });
    assert.equal(start.status, 200, start.text);
    const r = await waitRelease(owner, storeId, start.json.id);
    assert.equal(r.status, 'done', JSON.stringify(r.summary));
    assert.equal(r.verdict, 'safe', `${r.summary.headline} ${JSON.stringify(r.summary.reviews.map((x) => x.title))}`);
    assert.match(r.summary.headline, /also works on Staging same/);
    const envList = (await owner.get(`/api/stores/${storeId}/environments`)).json.environments;
    assert.equal(envList.find((e) => e.id === envs.same.id).last.verdict, 'safe', 'the environment shows its last result');
    const p = await open(owner, `#/s/${storeId}/publish`);
    await p.waitForSelector('tr.link', { timeout: 20000 });
    await quiet(p);
    await screenshot(t, p, 'Safe to publish page with past checks', { fullPage: true });
    await p.context().close();
    note(t, r.summary.headline);
  });

  it('a publish check can be stopped, and nothing is judged', async (t) => {
    const start = await owner.post(`/api/stores/${storeId}/releases`, { environmentId: envs.same.id });
    assert.equal(start.status, 200, start.text);
    const c = await owner.post(`/api/stores/${storeId}/releases/${start.json.id}/cancel`);
    assert.equal(c.status, 200);
    const r = await waitRelease(owner, storeId, start.json.id, 60000);
    assert.equal(r.status, 'cancelled');
    assert.equal(r.verdict, null);
    const other = await signup(P);
    assert.equal((await other.post(`/api/stores/${storeId}/releases/${start.json.id}/cancel`)).status, 404);
    // The store is free for the next test straight away.
    const next = await owner.post(`/api/stores/${storeId}/run`, {});
    assert.equal(next.status, 200, next.text);
    await owner.post(`/api/stores/${storeId}/run/${next.json.runId}/cancel`);
    note(t, 'stopped check: cancelled, no verdict; the store accepted a new test right after');
  });
});
