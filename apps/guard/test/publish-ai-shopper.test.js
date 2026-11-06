// AI shopper in Safe to publish (T71, T33 part 2): the AI shopper shops the draft theme (in a preview session)
// and the live theme, and the publish check compares them. If it reaches checkout on live but gets stuck on the
// draft, that alone is a "Don't publish" reason. Both step lists show side by side.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startFakeAi, startProduct, signup, addStore } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-pub-shopper-'));
const { judge, shopperBlocker } = await import('../src/release.js');

const steps = (...xs) => xs.map((did, i) => ({ n: i + 1, at: i ? '/products/tee' : '/', did, action: 'click', thought: '' }));
const LIVE_OK = { outcome: 'checkout', steps: steps('clicked link "Tee"', 'clicked button "Add to cart"', 'clicked link "Cart"', 'clicked button "Check out"', 'reached checkout'), friction: [] };
const DRAFT_STUCK = { outcome: 'stuck', steps: steps('clicked link "Tee"', 'clicked button "Add to cart"', 'stuck: clicking Add to cart did nothing'), friction: [{ severity: 'critical', issue: 'Clicking Add to cart did nothing' }] };
const EMPTY = { changes: { new: [], fixed: [] }, visual: [], metrics: [] };

describe('AI shopper in Safe to publish: the verdict', () => {
  it('reaches checkout on live but gets stuck on the draft: "Don\'t publish"', (t) => {
    const j = judge(EMPTY, 'the draft', { live: LIVE_OK, draft: DRAFT_STUCK });
    assert.equal(j.verdict, 'blocked');
    assert.equal(j.blockers.length, 1);
    const b = j.blockers[0];
    assert.equal(b.id, 'ai.shopper');
    assert.equal(b.detail, 'On the draft, an AI shopper got stuck on /products/tee: clicking Add to cart did nothing. It noticed: Clicking Add to cart did nothing.');
    assert.equal(b.liveDetail, 'An AI shopper reached checkout in 4 steps.');
    assert.deepEqual(j.shopper, { live: LIVE_OK, draft: DRAFT_STUCK }, 'both step lists are kept for the side-by-side view');
    note(t, `${j.headline} ${b.detail}`);
  });

  it('the plain check difference is replaced, not shown twice', () => {
    const cmp = { ...EMPTY, changes: { new: [{ id: 'ai.shopper', title: 'An AI shopper can find a product and reach checkout', a: 'warn', severity: 'major', detail: 'got stuck' }], fixed: [] } };
    const j = judge(cmp, 'Staging', { live: LIVE_OK, draft: { ...DRAFT_STUCK, outcome: 'limit' } });
    assert.equal([...j.blockers, ...j.reviews].filter((x) => x.id === 'ai.shopper').length, 1);
    assert.match(j.blockers[0].detail, /^On Staging, an AI shopper did not reach checkout within 3 steps/);
  });

  it('no blocker when both reach checkout, when live is stuck too, or when the shopper did not run', () => {
    assert.equal(judge(EMPTY, 'the draft', { live: LIVE_OK, draft: LIVE_OK }).verdict, 'safe');
    assert.equal(shopperBlocker({ live: DRAFT_STUCK, draft: DRAFT_STUCK }), null, 'stuck on both: nothing new on the draft');
    assert.equal(shopperBlocker({ live: DRAFT_STUCK, draft: LIVE_OK }), null, 'the draft does better');
    assert.equal(shopperBlocker({ live: LIVE_OK, draft: null }), null);
    const j = judge(EMPTY, 'the draft', { live: null, draft: null });
    assert.equal(j.verdict, 'safe');
    assert.equal(j.shopper, undefined, 'no shopper panel when it ran on neither');
    assert.equal(judge(EMPTY).shopper, undefined);
  });
});

describe('AI shopper in Safe to publish: end to end', () => {
  let P, owner, storeId, fake;
  before(async () => {
    fake = await startFakeAi();
    // The mock store's draft theme (MOCK_DRAFT_BREAK default "theme,atc"): Add to cart does nothing there.
    P = await startProduct({ env: { AI_PROVIDER: 'anthropic', AI_API_KEY: 'test-ai-key', AI_BASE_URL: fake.base } });
    owner = await signup(P, 'pub-shopper@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    const groups = (await owner.get('/api/catalog')).json.groups.map((g) => g.key);
    const keep = ['journey.core', 'ai.shopper'];
    const r = await owner.patch(`/api/stores/${storeId}`, { config: { disabled: groups.filter((g) => !keep.includes(g)) } });
    assert.equal(r.status, 200, r.text);
  });
  after(async () => { await P?.stop(); fake?.stop(); });

  it('shops the draft and live; stuck on the draft only means "Don\'t publish", with both step lists side by side', { timeout: 400000 }, async (t) => {
    await fake.control({ mode: 'shop', calls: 0, prompts: [] });
    const start = await owner.post(`/api/stores/${storeId}/releases`, { url: `${P.mock.origin}/?preview_theme_id=222`, label: 'Diwali draft' });
    assert.equal(start.status, 200, start.text);
    const id = start.json.id;
    let r;
    for (const until = Date.now() + 360000; Date.now() < until;) {
      r = (await owner.get(`/api/stores/${storeId}/releases/${id}`)).json;
      if (r.status !== 'running') break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    assert.equal(r.status, 'done', JSON.stringify(r.summary));
    const sum = r.summary;
    assert.equal(sum.shopper.live.outcome, 'checkout', JSON.stringify(sum.shopper.live.steps));
    assert.equal(sum.shopper.draft.outcome, 'stuck', JSON.stringify(sum.shopper.draft.steps));
    assert.equal(r.verdict, 'blocked');
    const b = sum.blockers.find((x) => x.id === 'ai.shopper');
    assert.ok(b, JSON.stringify(sum.blockers.map((x) => x.id)));
    assert.match(b.detail, /^On the draft, an AI shopper got stuck on \/products\/[\w-]+: clicking Add to cart did nothing/);
    assert.match(b.liveDetail, /reached checkout in \d+ steps/);
    const st = await fake.state();
    assert.ok(st.calls <= 24, `at most 12 AI calls per side (got ${st.calls})`);

    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
      await ctx.addCookies(owner.browserCookies());
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`${P.base}/app#/s/${storeId}/publish/${id}`);
      await p.waitForSelector('.pub-shopper', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      const cols = p.locator('.pub-shopper-col');
      assert.equal(await cols.count(), 2);
      assert.match(await cols.nth(0).textContent(), /Live theme\s*Reached checkout[\s\S]*reached checkout/);
      assert.match(await cols.nth(1).textContent(), /Draft\s*Got stuck[\s\S]*clicking Add to cart did nothing/);
      assert.match(await p.textContent('.pub-verdict'), /Don.t publish yet/);
      assert.match(await p.textContent('.main-inner'), /On the draft, an AI shopper got stuck/);
      await screenshot(t, p, 'Safe to publish: AI shopper on live and draft side by side', { fullPage: true });
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
    note(t, `Live: ${sum.shopper.live.steps.map((s) => s.did).join(' → ')}\nDraft: ${sum.shopper.draft.steps.map((s) => s.did).join(' → ')}`);
  });
});
