// Full checks on workers (T68, runners part 2).
// Part 1 tests the rules and the file exchange in-process. Part 2 starts the whole product with a real worker:
// a first full check on the worker saves baselines and the catalog snapshot on the main server; a full check on the
// worker gives the same result as one on the main server; a worker compares with the main server's baselines and
// catalog (a changed look and a changed price are found); approving a new look is unchanged; baselines stay
// owner-only; the worker keeps no copies; machines and people without the check are refused.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PNG as PNGjs } from 'pngjs';
import { startProduct, signup, addStore, startWorker, runAndWait, FOUNDER, ROOT } from './lib/harness.js';
import { note } from './lib/evidence.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a50000000049454e44ae426082', 'hex');

describe('Full checks on workers: rules and files', () => {
  let r, f, dataDir;
  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-fullw-'));
    process.env.DATA_DIR = dataDir;
    await import('../src/db.js');
    r = await import('../src/runners.js');
    f = await import('../src/runner-files.js');
  });

  it('workers take full checks, except ones with AI review; publish and free checks stay on main', () => {
    const W = { id: 2, kind: 'worker' }, M = { id: 1, kind: 'main' };
    assert.equal(r.canRun(W, { kind: 'full', storeId: 3 }), true);
    assert.equal(r.canRun(W, { kind: 'full', storeId: 3, needsAi: true }), false, 'the AI key never leaves the main server');
    assert.equal(r.canRun(W, { kind: 'full', storeId: 3, release: 4 }), false);
    assert.equal(r.canRun(W, { kind: 'full', storeId: 3, captureOnly: true }), false);
    assert.equal(r.canRun(W, { kind: 'free' }), false);
    assert.equal(r.canRun(M, { kind: 'full', storeId: 3, needsAi: true }), true);
    assert.equal(r.usesAi('full', [], true), true);
    assert.equal(r.usesAi('full', ['ai.visual'], true), true, 'AI copy review still on');
    assert.equal(r.usesAi('full', ['ai.visual', 'ai.copy'], true), false, 'both AI groups off (e.g. not in the plan)');
    assert.equal(r.usesAi('full', [], false), false, 'no AI key');
    assert.equal(r.usesAi('journeys', [], true), false);
  });

  it('what a full check fetches, and what a worker may save', () => {
    const b = path.join(dataDir, 'baselines', 'store-7'), c = path.join(dataDir, 'catalog', 'store-7');
    assert.deepEqual(f.fullCheckInputs(7, 10), { baselines: [], catalogPrev: null });
    assert.equal(f.saveFirstBaseline(7, 'home-desktop.png', PNG), 'saved');
    assert.equal(f.saveFirstBaseline(7, 'home-desktop.png', Buffer.concat([PNG, Buffer.from('x')])), 'kept', 'an existing (approved) baseline is never replaced');
    assert.deepEqual(fs.readFileSync(path.join(b, 'home-desktop.png')), PNG);
    assert.equal(f.saveFirstBaseline(7, '../../x.png', PNG), 'Bad file name');
    assert.equal(f.saveFirstBaseline(7, 'home-desktop-diff.png', PNG), 'Bad file name', 'diff images are not baselines');
    assert.equal(f.saveFirstBaseline(7, 'home-mobile.png', Buffer.from('not a png')), 'Not a PNG image');
    fs.writeFileSync(path.join(b, 'home-tablet-diff.png'), PNG);
    assert.equal(f.saveCatalogSnapshot(7, 5, { products: 'x' }), 'Send a catalog snapshot with products');
    assert.equal(f.saveCatalogSnapshot(7, 5, { count: 1, products: [{ id: 1 }] }), 'saved');
    assert.equal(f.saveCatalogSnapshot(7, 9, { count: 2, products: [{ id: 1 }, { id: 2 }] }), 'saved');
    assert.deepEqual(f.fullCheckInputs(7, 10), { baselines: ['home-desktop.png'], catalogPrev: 9 });
    assert.deepEqual(f.fullCheckInputs(7, 9), { baselines: ['home-desktop.png'], catalogPrev: 5 }, 'the latest snapshot from before this check');
    assert.equal(f.readPreviousCatalog(7, 9).runId, 5);
    assert.equal(JSON.parse(f.readPreviousCatalog(7, 10).text).count, 2);
    assert.equal(f.readBaseline(7, '../x.png'), null);
    assert.ok(fs.existsSync(c));
  });
});

/** Creates the founder account from the server (founders can't sign up) and signs it in. */
async function founderSession(P, password = 'founder-test-password') {
  const r = spawnSync(process.execPath, ['scripts/create-user.js', FOUNDER, password, 'Founder'], { cwd: ROOT, env: { ...process.env, DATA_DIR: P.dataDir }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`create-user failed: ${r.stderr || r.stdout}`);
  const s = P.session();
  const l = await s.post('/api/auth/login', { email: FOUNDER, password });
  if (l.status !== 200) throw new Error(`founder login failed ${l.status} ${l.text}`);
  return s;
}

const TYPE = 'application/vnd.tharam.runner+json';
const KEYS = ['home-desktop', 'home-mobile', 'home-tablet', 'product-desktop', 'product-mobile', 'product-tablet'];

describe('Full checks on a worker', () => {
  let P, founder, owner, other, store, worker, runs = {};
  const runnersList = async () => (await founder.get('/api/admin/runners')).json.runners;
  const setStatus = async (name, status) => { const id = (await runnersList()).find((x) => x.name === name).id; const r = await founder.patch(`/api/admin/runners/${id}`, { status }); assert.equal(r.status, 200, r.text); };
  const leases = async (runId) => (await founder.get(`/api/admin/runs/${runId}/leases`)).json.leases;
  const waitFor = async (fn, ms = 30000) => { const until = Date.now() + ms; while (Date.now() < until) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); } throw new Error('timed out'); };
  const baseDir = () => path.join(P.dataDir, 'baselines', `store-${store}`);
  const catDir = () => path.join(P.dataDir, 'catalog', `store-${store}`);
  /** A full check on the worker or on the main server. */
  const full = async (where) => {
    await setStatus(where === 'worker' ? 'main' : 'worker-f', 'paused');
    try {
      const d = await runAndWait(owner, store, { kind: 'full' });
      assert.equal(d.status, 'done', d.error || '');
      const ls = await leases(d.id);
      assert.deepEqual(ls.map((l) => [l.runner, l.state]), where === 'worker' ? [['worker-f', 'done']] : [], `ran on ${where}`);
      return d;
    } finally { await setStatus(where === 'worker' ? 'main' : 'worker-f', 'active'); }
  };
  const visual = (d) => d.result.checks.find((c) => c.id === 'nf.visual');
  const byKey = (d) => Object.fromEntries(visual(d).evidence.visual.map((x) => [x.key, x.status]));

  before(async () => {
    P = await startProduct({ env: { RUN_CONCURRENCY: '1' } });
    founder = await founderSession(P);
    owner = await signup(P, 'fullw-owner@shop.test');
    other = await signup(P, 'fullw-other@shop.test');
    store = await addStore(P, owner, { runNow: false });
    const tok = await founder.post('/api/admin/runners/join-tokens', { name: 'worker-f', slots: 1 });
    assert.equal(tok.status, 201, tok.text);
    worker = await startWorker(P, tok.json.token);
    await waitFor(async () => (await runnersList()).find((x) => x.name === 'worker-f')?.healthy);
  });
  after(async () => { worker?.cleanup(); await P?.stop(); });

  it('the first full check on a worker saves baselines and the catalog snapshot on the main server', async (t) => {
    const d = await full('worker');
    runs.first = d.id;
    assert.match(visual(d).detail, /Saved today's screenshots as the approved look/);
    assert.deepEqual(fs.readdirSync(baseDir()).sort(), KEYS.map((k) => `${k}.png`));
    for (const k of KEYS) assert.deepEqual(fs.readFileSync(path.join(baseDir(), `${k}.png`)), fs.readFileSync(path.join(P.dataDir, 'shots', `run-${d.id}`, `${k}.png`)), `${k}: baseline = this check's screenshot`);
    const snap = JSON.parse(fs.readFileSync(path.join(catDir(), `run-${d.id}.json`), 'utf8'));
    assert.equal(snap.count, d.result.catalog.count);
    assert.ok(d.result.catalog.count >= 3);
    assert.equal(d.result.catalog.comparedWith, null);
    assert.ok(d.result.checks.some((c) => c.id === 'cat.pricing' && c.status === 'fail'), 'the zero-priced product is found on the worker');
    assert.ok(!fs.existsSync(path.join(worker.dataDir, 'baselines', `store-${store}`)) && !fs.existsSync(path.join(worker.dataDir, 'catalog', `store-${store}`)), 'the worker keeps no copies');
    note(t, `full check #${d.id} ran on worker-f: 6 baselines and a ${snap.count}-product catalog snapshot saved on the main server; nothing left on the worker`);
  });

  it('a full check on the worker gives the same result as one on the main server', async (t) => {
    const m = await full('main');
    const w = await full('worker');
    runs.main = m.id; runs.worker = w.id;
    for (const d of [m, w]) {
      assert.equal(visual(d).status, 'pass');
      assert.deepEqual(byKey(d), Object.fromEntries(KEYS.map((k) => [k, 'same'])));
      assert.deepEqual(Object.values(d.result.catalog.totals).reduce((a, b) => a + b, 0), 0, 'nothing changed in the catalog');
    }
    assert.equal(m.result.catalog.comparedWith, runs.first);
    assert.equal(w.result.catalog.comparedWith, m.id, 'the worker compared with the snapshot the main server made');
    const pick = (d) => Object.fromEntries(d.result.checks.filter((c) => /^(fn\.|cat\.|nf\.visual|sale\.|law\.)/.test(c.id)).map((c) => [c.id, c.status]));
    assert.deepEqual(pick(w), pick(m), 'journey, catalog and visual results match');
    assert.deepEqual(w.result.checks.map((c) => c.id).sort(), m.result.checks.map((c) => c.id).sort(), 'the same checks ran');
    assert.equal(w.verdict, m.verdict);
    note(t, `#${m.id} on main and #${w.id} on worker-f: same ${Object.keys(pick(m)).length} journey/catalog/visual results, verdict ${m.verdict}`);
  });

  it('the worker compares with the main server\'s baselines and catalog: a changed look and a changed price are found', async (t) => {
    // The approved home page (desktop) is now a different picture, and the last snapshot had another price.
    const orig = PNGjs.sync.read(fs.readFileSync(path.join(baseDir(), 'home-desktop.png')));
    const black = new PNGjs({ width: orig.width, height: orig.height });
    for (let i = 0; i < black.data.length; i += 4) black.data[i + 3] = 255;
    const tampered = PNGjs.sync.write(black);
    fs.writeFileSync(path.join(baseDir(), 'home-desktop.png'), tampered);
    const snapFile = path.join(catDir(), `run-${runs.worker}.json`);
    const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    const p = snap.products.find((x) => x.variants.some((v) => v.price > 0));
    p.variants[0].price = Math.round(p.variants[0].price * 2);
    p.checksum = 'changed';
    fs.writeFileSync(snapFile, JSON.stringify(snap));

    const d = await full('worker');
    runs.changed = d.id;
    assert.equal(byKey(d)['home-desktop'], 'changed');
    assert.equal(visual(d).status, 'warn');
    assert.ok(fs.existsSync(path.join(P.dataDir, 'shots', `run-${d.id}`, 'home-desktop-diff.png')), 'the difference image arrived');
    assert.deepEqual(fs.readFileSync(path.join(baseDir(), 'home-desktop.png')), tampered, 'a worker never replaces an approved baseline');
    assert.equal(d.result.catalog.comparedWith, runs.worker);
    assert.equal(d.result.catalog.totals.price, 1, `price change found: ${JSON.stringify(d.result.catalog.totals)}`);

    // Approving the new look works as before, from the check's screenshots on the main server.
    assert.equal((await other.post(`/api/stores/${store}/approve-visual`, { runId: d.id })).status, 404, 'another account');
    const ok = await owner.post(`/api/stores/${store}/approve-visual`, { runId: d.id });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(fs.readFileSync(path.join(baseDir(), 'home-desktop.png')), fs.readFileSync(path.join(P.dataDir, 'shots', `run-${d.id}`, 'home-desktop.png')));
    note(t, `#${d.id} on worker-f: home-desktop changed against the main server's baseline (diff image saved), price change found against the last snapshot; owner approved the new look`);
  });

  it('baselines stay owner-only', async () => {
    const url = `/baselines/${store}/home-desktop.png`;
    assert.equal((await owner.get(url)).status, 200);
    assert.equal((await other.get(url)).status, 404, 'another account');
    assert.equal((await P.session().get(url)).status, 404, 'signed out');
    assert.equal((await founder.get(url)).status, 404, 'not even the founder through the store route');
  });

  it('only the worker holding a full check can fetch or send its files', async () => {
    const creds = worker.credentials();
    const get = (url, auth) => fetch(P.base + url, { headers: auth ? { authorization: `Runner ${auth}` } : {} });
    const post = (url, body, type, auth) => fetch(P.base + url, { method: 'POST', headers: { 'content-type': type, ...(auth ? { authorization: `Runner ${auth}` } : {}) }, body });
    const id = runs.changed;
    assert.equal((await get(`/api/runner/runs/${id}/baselines/home-desktop.png`)).status, 401, 'no credentials');
    assert.equal((await get(`/api/runner/runs/${id}/baselines/home-desktop.png`, `1.${'x'.repeat(40)}`)).status, 401, 'made-up credentials');
    assert.equal((await get(`/api/runner/runs/${id}/baselines/home-desktop.png`, creds)).status, 409, 'a finished check');
    assert.equal((await get(`/api/runner/runs/${id}/catalog-previous`, creds)).status, 409);
    assert.equal((await post(`/api/runner/runs/${id}/baselines/home-desktop.png`, PNG, 'image/png', creds)).status, 409);
    assert.equal((await post(`/api/runner/runs/${id}/catalog`, JSON.stringify({ count: 0, products: [] }), TYPE, creds)).status, 409);
    for (const s of [owner, founder]) assert.equal((await s.get(`/api/runner/runs/${id}/catalog-previous`)).status, 401, 'people are not runners');
    assert.ok(!fs.existsSync(path.join(worker.dataDir, 'baselines', `store-${store}`)), 'still no copies on the worker');
  });
});
