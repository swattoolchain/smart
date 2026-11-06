// Visual changes: the first full check saves the approved look, a later change is detected with a
// difference image, approving the new look makes it the baseline, and screenshots are served only to the
// store's owner (signed links for the embedded Shopify app).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait, shopifyOpen, ROOT } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const KEYS = ['home-desktop', 'home-tablet', 'home-mobile', 'product-desktop', 'product-tablet', 'product-mobile'];
const visualCheck = (run) => run.result.checks.find((c) => c.id === 'nf.visual');

/** Restarts the product's mock store on the same address with different breakages. */
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

describe('Visual changes and approving a new look', () => {
  let P, owner, storeId, first, changed, browser;
  const baseDir = () => path.join(P.dataDir, 'baselines', `store-${storeId}`);
  const visual = async () => (await owner.get(`/api/stores/${storeId}/visual`)).json;
  before(async () => {
    P = await startProduct();
    owner = await signup(P, 'visual@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('the first full check saves the approved look for home and product, on desktop, tablet and phone', { timeout: 300000 }, async (t) => {
    first = await runAndWait(owner, storeId, { groups: ['visual'] }, 280000);
    assert.equal(first.status, 'done', first.error || '');
    const c = visualCheck(first);
    assert.equal(c.status, 'pass');
    assert.match(c.detail, /Saved today's screenshots as the approved look/);
    assert.deepEqual(c.evidence.visual.map((v) => v.status), KEYS.map(() => 'baseline'));
    for (const k of KEYS) assert.ok(fs.existsSync(path.join(baseDir(), `${k}.png`)), `${k} baseline saved`);
    const v = await visual();
    assert.equal(v.runId, first.id);
    assert.deepEqual(v.shots.map((s) => s.key), KEYS);
    assert.ok(v.shots.every((s) => s.current && s.baseline && !s.diff));
    note(t, `${KEYS.length} baselines saved`);
  });

  it('the same look on the next check is not a change', { timeout: 300000 }, async (t) => {
    const r = await runAndWait(owner, storeId, { groups: ['visual'] }, 280000);
    const c = visualCheck(r);
    assert.equal(c.status, 'pass');
    assert.equal(c.detail, 'No unexpected visual changes.');
    assert.ok(c.evidence.visual.every((v) => v.status === 'same'), JSON.stringify(c.evidence.visual));
    note(t, c.evidence.visual.map((v) => `${v.key} ${v.ratio}%`).join(', '));
  });

  it('a new look is detected, with a difference image', { timeout: 300000 }, async (t) => {
    await restartMock(P, 'restyle'); // a theme update that turned every page dark
    changed = await runAndWait(owner, storeId, { groups: ['visual'] }, 280000);
    const c = visualCheck(changed);
    assert.equal(c.status, 'warn', JSON.stringify(c.evidence.visual));
    assert.match(c.detail, /Visible changes on: .*home-desktop \([\d.]+% of pixels\)/);
    assert.match(c.detail, /approve the new look/);
    assert.match(c.fix, /recent theme and app updates/);
    const v = await visual();
    const home = v.shots.find((s) => s.key === 'home-desktop');
    assert.equal(home.status, 'changed');
    assert.ok(home.ratio > 12, `ratio ${home.ratio}`);
    assert.equal(home.diff, `/shots/run-${changed.id}/home-desktop-diff.png`);
    const img = await owner.get(home.diff);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    note(t, c.detail);
  });

  it('the Visual changes page shows approved and new screenshots side by side', async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#/s/${storeId}/visual`);
    await p.waitForSelector('img', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    await p.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 10000 });
    const broken = await p.evaluate(() => [...document.images].filter((i) => i.naturalWidth === 0).map((i) => i.src));
    assert.deepEqual(broken, [], 'every screenshot loads for the owner');
    await screenshot(t, p, 'Visual changes after a theme update', { fullPage: true });
    assert.deepEqual(errors, []);
  });

  it('approving the new look makes it the baseline, and the next check sees no change', { timeout: 300000 }, async (t) => {
    const r = await owner.post(`/api/stores/${storeId}/approve-visual`, { runId: changed.id });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, approved: 6 });
    for (const k of KEYS) {
      const a = fs.readFileSync(path.join(baseDir(), `${k}.png`));
      const b = fs.readFileSync(path.join(P.dataDir, 'shots', `run-${changed.id}`, `${k}.png`));
      assert.ok(a.equals(b), `${k} baseline is the approved screenshot`);
    }
    assert.ok(!fs.readdirSync(baseDir()).some((f) => f.includes('diff')), 'difference images never become a baseline');
    const next = await runAndWait(owner, storeId, { groups: ['visual'] }, 280000);
    assert.equal(visualCheck(next).status, 'pass');
    assert.equal(visualCheck(next).detail, 'No unexpected visual changes.');
    note(t, `approved run ${changed.id}; next check: ${visualCheck(next).detail}`);
  });

  it('only the owner can approve, and only their own store’s checks', async () => {
    const other = await signup(P, 'visual-other@shop.test');
    assert.ok([403, 404].includes((await other.post(`/api/stores/${storeId}/approve-visual`, { runId: changed.id })).status));
    const otherStore = await addStore(P, other, { runNow: false });
    const r = await other.post(`/api/stores/${otherStore}/approve-visual`, { runId: changed.id });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /Run not found/);
    assert.ok(!fs.existsSync(path.join(P.dataDir, 'baselines', `store-${otherStore}`)), 'nothing copied to the other store');
  });

  it('screenshots and baselines are served only to the owner', async (t) => {
    const shot = `/shots/run-${changed.id}/home-desktop.png`;
    const base = `/baselines/${storeId}/home-desktop.png`;
    assert.equal((await owner.get(shot)).status, 200);
    assert.equal((await owner.get(base)).status, 200);
    const anon = P.session();
    const other = await signup(P, 'visual-peek@shop.test');
    for (const s of [anon, other]) {
      assert.equal((await s.get(shot)).status, 404);
      assert.equal((await s.get(base)).status, 404);
      assert.equal((await s.get(`/shots/run-${changed.id}/../../guard.db`)).status, 404);
    }
    assert.equal((await anon.get(`/baselines/${storeId}/secret.png`)).status, 404, 'only screenshot names are served');
    note(t, 'owner 200; signed-out visitor and another account 404');
  });
});

describe('Screenshots inside Shopify admin', () => {
  let P, owner, run;
  before(async () => {
    P = await startProduct();
    owner = await shopifyOpen(P);
    run = await runAndWait(owner, owner.storeId, { groups: ['visual'] }, 280000);
  });
  after(async () => { await P.stop(); });

  it('the embedded app gets signed links that open without a login, for that file only', async (t) => {
    assert.equal(run.status, 'done', run.error || '');
    const v = (await owner.get(`/api/stores/${owner.storeId}/visual`)).json;
    const home = v.shots.find((s) => s.key === 'home-desktop');
    assert.match(home.current, /^\/shots\/run-\d+\/home-desktop\.png\?t=[\w-]{32}\.\d{10}$/);
    assert.match(home.baseline, /^\/baselines\/\d+\/home-desktop\.png\?v=\d+&t=[\w-]{32}\.\d{10}$/);
    const anon = P.session();
    assert.equal((await anon.get(home.current)).status, 200, 'signed screenshot link works without cookies');
    assert.equal((await anon.get(home.baseline)).status, 200, 'signed baseline link works without cookies');
    const t1 = home.current.split('?t=')[1];
    assert.equal((await anon.get(home.current.split('?')[0])).status, 404, 'no signature, no screenshot');
    assert.equal((await anon.get(`/shots/run-${run.id}/home-mobile.png?t=${t1}`)).status, 404, 'a signature opens only its own file');
    assert.equal((await anon.get(`${home.current.split('?')[0]}?t=${'A'.repeat(32)}.${t1.split('.')[1]}`)).status, 404, 'forged signature refused');
    const exp = Number(t1.split('.')[1]);
    const hours = (exp - Date.now() / 1000) / 3600;
    assert.ok(hours > 5.9 && hours <= 6, `links expire after 6 hours (${hours.toFixed(2)} h)`);
    note(t, `signed link valid ${hours.toFixed(1)} h; unsigned, swapped and forged links refused`);
  });

  it('another shop’s session gets no signed links to these screenshots', async () => {
    const other = await shopifyOpen(P);
    const r = await other.get(`/api/stores/${owner.storeId}/visual`);
    assert.ok([403, 404].includes(r.status), `got ${r.status}`);
    assert.ok(!/\?t=/.test(r.text));
  });
});
