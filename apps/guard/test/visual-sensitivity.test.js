// Visual changes (T113): the owner sets how sensitive the look comparison is (default unchanged: 12%), and a
// visual change can be answered two ways: "This is the new look" or "Changes this small are fine" (a higher
// limit for that page only). Both answers are recorded; other accounts are refused.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait, founderSession, ROOT } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.FEATURES_DEFAULT = 'on';
const { normalizeConfig, VISUAL_DEFAULT_PERCENT } = await import('../src/engine/catalog.js');
const visualCheck = (run) => run.result.checks.find((c) => c.id === 'nf.visual');
const byKey = (run) => Object.fromEntries(visualCheck(run).evidence.visual.map((v) => [v.key, v]));

async function restartMock(P, breaks) {
  P.mock.stop();
  await new Promise((r) => setTimeout(r, 300));
  const child = spawn(process.execPath, ['test/mock-store.js'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(P.mock.port), MOCK_BREAK: breaks, MOCK_EXTRA: '' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${P.mock.origin}/products.json`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  P.mock.stop = () => { try { child.kill('SIGTERM'); } catch {} };
}

describe('Visual sensitivity: settings', () => {
  it('the usual setting is 12%; a custom number from 1 to 50 is kept, anything else is refused plainly', () => {
    assert.equal(VISUAL_DEFAULT_PERCENT, 12);
    assert.equal(normalizeConfig({}, {}).visualThreshold, undefined, 'a store that never set it keeps the default');
    assert.equal(normalizeConfig({ visualThreshold: 25 }).visualThreshold, 25);
    assert.equal(normalizeConfig({ visualThreshold: '7.5' }).visualThreshold, 7.5);
    assert.equal(normalizeConfig({ visualThreshold: null }, { visualThreshold: 25 }).visualThreshold, null, 'empty goes back to the usual setting');
    for (const bad of [0, 0.5, 51, 'lots', -3]) assert.throws(() => normalizeConfig({ visualThreshold: bad }), /from 1 to 50/, String(bad));
    assert.deepEqual(normalizeConfig({ visualPages: { 'home-mobile': 20 } }).visualPages, { 'home-mobile': 20 });
    assert.deepEqual(normalizeConfig({ visualPages: {} }, { visualPages: { 'home-mobile': 20 } }).visualPages, {}, 'reset');
    assert.throws(() => normalizeConfig({ visualPages: { '../etc': 20 } }), /Unknown page/);
    assert.throws(() => normalizeConfig({ visualPages: { 'home-mobile': 99 } }), /from 1 to 50/);
  });
});

describe('Visual sensitivity: in the product', () => {
  let P, owner, storeId, browser, changed, small, accepted;
  const get = async () => (await owner.get(`/api/stores/${storeId}/visual`)).json;
  const patch = (config) => owner.patch(`/api/stores/${storeId}`, { config });
  before(async () => {
    P = await startProduct();
    owner = await signup(P, 'sens@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('existing stores keep 12%: a small change is not reported, a big one is, exactly as before', { timeout: 600000 }, async (t) => {
    const v0 = await get();
    assert.deepEqual(v0.sensitivity, { percent: 12, isDefault: true, defaultPercent: 12, pages: {} });
    await runAndWait(owner, storeId, { groups: ['visual'] }, 280000); // saves the approved look
    await restartMock(P, 'theme'); // a sale banner and warmer colours: a small change
    small = await runAndWait(owner, storeId, { groups: ['visual'] }, 280000);
    const s = byKey(small)['home-desktop'];
    assert.ok(s.ratio >= 2 && s.ratio < 12, `the banner changes ${s.ratio}% of the page`);
    assert.equal(s.status, 'same', 'under 12% nothing is reported');
    assert.equal(visualCheck(small).status, 'pass');
    await restartMock(P, 'restyle'); // every page dark: a big change
    changed = await runAndWait(owner, storeId, { groups: ['visual'] }, 280000);
    assert.equal(visualCheck(changed).status, 'warn');
    assert.equal(byKey(changed)['home-desktop'].status, 'changed');
    assert.ok(byKey(changed)['home-desktop'].ratio > 12);
    note(t, `small change ${s.ratio}% not reported; dark theme ${byKey(changed)['home-desktop'].ratio}% reported (limit 12%)`);
  });

  it('a custom sensitivity is respected: a low number catches the small change, a high one lets the big change pass', { timeout: 600000 }, async (t) => {
    await restartMock(P, 'theme');
    const ratio = byKey(small)['home-desktop'].ratio;
    assert.equal((await patch({ visualThreshold: 1 })).status, 200);
    assert.equal((await get()).sensitivity.percent, 1);
    const strict = await runAndWait(owner, storeId, { groups: ['visual'] }, 280000);
    assert.equal(byKey(strict)['home-desktop'].status, 'changed', `${ratio}% is more than 1%`);
    assert.equal(visualCheck(strict).status, 'warn');
    assert.equal((await patch({ visualThreshold: 50 })).status, 200);
    const lax = await runAndWait(owner, storeId, { groups: ['visual'] }, 280000);
    assert.equal(byKey(lax)['home-desktop'].status, 'same');
    assert.equal(visualCheck(lax).status, 'pass');
    await patch({ visualThreshold: null });
    assert.equal((await get()).sensitivity.isDefault, true, 'emptying it goes back to the usual 12%');
    note(t, `the same ${ratio}% change: reported at 1%, not at 50% or 12%`);
    changed = strict;
  });

  it('bad values are refused on the server; other accounts cannot read or change the setting', async () => {
    for (const bad of [0, 51, 'x']) {
      const r = await patch({ visualThreshold: bad });
      assert.equal(r.status, 400, String(bad));
      assert.match(r.json.error, /from 1 to 50/);
    }
    assert.equal((await patch({ visualPages: { nope: 5 } })).status, 400);
    const other = await signup(P, 'sens-other@shop.test');
    assert.ok([403, 404].includes((await other.patch(`/api/stores/${storeId}`, { config: { visualThreshold: 40 } })).status));
    assert.ok([403, 404].includes((await other.get(`/api/stores/${storeId}/visual`)).status));
    assert.equal((await get()).sensitivity.percent, 12, 'nothing changed');
  });

  it('"Changes this small are fine" stops the alert next run, only for that page, and a bigger change still alerts', { timeout: 600000 }, async (t) => {
    // `changed` is the check made with the 1% setting while the store showed the sale banner.
    await patch({ visualThreshold: 1 });
    const before = byKey(changed);
    assert.equal(before['home-desktop'].status, 'changed');
    const other = await signup(P, 'sens-other2@shop.test');
    assert.equal((await other.post(`/api/stores/${storeId}/accept-visual-change`, { runId: changed.id })).status, 404, 'another account');
    const otherStore = await addStore(P, other, { runNow: false });
    assert.equal((await other.post(`/api/stores/${otherStore}/accept-visual-change`, { runId: changed.id })).status, 404, 'a run that is not theirs');
    assert.equal((await owner.post(`/api/stores/${storeId}/accept-visual-change`, { runId: changed.id, key: 'product-nothing' })).status, 400);

    const r = await owner.post(`/api/stores/${storeId}/accept-visual-change`, { runId: changed.id, key: 'home-desktop' });
    assert.equal(r.status, 200, r.text);
    accepted = r.json.accepted['home-desktop'];
    assert.ok(accepted > before['home-desktop'].ratio && accepted <= before['home-desktop'].ratio + 1, `just above ${before['home-desktop'].ratio}: ${accepted}`);
    assert.deepEqual(Object.keys((await get()).sensitivity.pages), ['home-desktop']);

    const next = await runAndWait(owner, storeId, { groups: ['visual'] }, 280000);
    const n = byKey(next);
    assert.equal(n['home-desktop'].status, 'same', 'the accepted page no longer alerts');
    const others = Object.keys(before).filter((k) => k !== 'home-desktop' && before[k].status === 'changed');
    assert.ok(others.length > 0, 'the banner also changed other pages');
    for (const k of others) assert.equal(n[k].status, 'changed', `${k} still alerts: other pages keep the store's limit`);

    await restartMock(P, 'restyle'); // a much bigger change: every page dark
    const big = await runAndWait(owner, storeId, { groups: ['visual'] }, 280000);
    assert.equal(byKey(big)['home-desktop'].status, 'changed', 'a bigger change on the accepted page still alerts');
    assert.ok(byKey(big)['home-desktop'].ratio > accepted);
    note(t, `accepted up to ${accepted}% on home-desktop; the next check was quiet there but still reported ${others.join(', ')}; a ${byKey(big)['home-desktop'].ratio}% change alerted`);
    changed = big;
  });

  it('both answers are written to the audit log, and "this is the new look" works as before', async (t) => {
    const r = await owner.post(`/api/stores/${storeId}/approve-visual`, { runId: changed.id });
    assert.equal(r.status, 200);
    assert.equal(r.json.approved, 6);
    const founder = await founderSession(P);
    const log = (await founder.get('/api/admin/audit')).json.audit.map((a) => a.action);
    assert.ok(log.includes('visual.accept_small'), log.join());
    assert.ok(log.includes('visual.approve'), log.join());
    note(t, 'audit has visual.accept_small and visual.approve');
  });

  it('an accepted limit can be reset, and a change too big to call small is refused', async (t) => {
    assert.equal((await patch({ visualPages: {} })).status, 200);
    assert.deepEqual((await get()).sensitivity.pages, {});
    const ratio = byKey(changed)['home-desktop'].ratio;
    assert.ok(ratio > 49.5, `the dark theme changes ${ratio}% of the page`);
    const r = await owner.post(`/api/stores/${storeId}/accept-visual-change`, { runId: changed.id, key: 'home-desktop' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /more than a small change/);
    assert.deepEqual((await get()).sensitivity.pages, {}, 'nothing was saved');
    note(t, `${ratio}% cannot be called small (limit 50%)`);
  });

  it('screens: the sensitivity setting and the two answers', { timeout: 300000 }, async (t) => {
    await patch({ visualThreshold: 20 });
    await runAndWait(owner, storeId, { groups: ['visual'] }, 280000);
    await restartMock(P, 'restyle');
    const run = await runAndWait(owner, storeId, { groups: ['visual'] }, 280000);
    assert.equal(visualCheck(run).status, 'pass', 'dark look was approved above, so no change yet');
    await restartMock(P, ''); // back to the light look: a big change from the approved dark one
    const run2 = await runAndWait(owner, storeId, { groups: ['visual'] }, 280000);
    assert.equal(visualCheck(run2).status, 'warn', JSON.stringify(visualCheck(run2).evidence.visual));
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#/s/${storeId}/suite/visual`);
    await p.waitForSelector('#vsens', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    assert.equal(await p.inputValue('#vpct'), '20');
    assert.equal(await p.isChecked('input[name=lvl][value=custom]'), true);
    await screenshot(t, p, 'Test suite → Visual changes: sensitivity');
    await p.goto(`${P.base}/app#/s/${storeId}/visual`);
    await p.waitForSelector('[data-visual=small]', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    assert.match(await p.textContent('.main-inner'), /more than 20% of it differs/);
    assert.ok(await p.isVisible('[data-visual=approve]'));
    await screenshot(t, p, 'Visual changes with the two answers');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});
