// Theme watch with full checks on workers (T69).
// Theme file fingerprints need the store's Shopify token, so they are always read on the main server. When a full
// check runs on a worker, the theme checks join the worker's result on the main server when it is saved:
// a first record, a changed theme file (with its lines and one alert email), Shopify unreachable (skipped, record
// kept, change reported next time). The Shopify token and the theme files never go to the worker.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startProduct, shopifyOpen, startWorker, runAndWait, FOUNDER, ROOT } from './lib/harness.js';
import { note } from './lib/evidence.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from '../src/engine/checks.js';

const LAYOUT = '<!doctype html>\n<html>\n<head>\n{{ content_for_header }}\n</head>\n<body>\n{{ content_for_layout }}\n</body>\n</html>';
const BASE = { 'layout/theme.liquid': LAYOUT, 'sections/header.liquid': '<header>{{ shop.name }}</header>', 'assets/global.js': 'console.log(1);', 'assets/logo.png': null };

const find = (run, id) => run.result.checks.find((c) => c.id === id);
const mails = (P, re) => (P.log().match(new RegExp(`\\[mail skipped\\] to=[^\\n]* subject=[^\\n]*${re}`, 'g')) || []).length;
const waitMail = async (P, re, n = 1) => { const until = Date.now() + 5000; while (mails(P, re) < n && Date.now() < until) await new Promise((r) => setTimeout(r, 100)); return mails(P, re); };

/** Creates the founder account from the server (founders can't sign up) and signs it in. */
async function founderSession(P, password = 'founder-test-password') {
  const r = spawnSync(process.execPath, ['scripts/create-user.js', FOUNDER, password, 'Founder'], { cwd: ROOT, env: { ...process.env, DATA_DIR: P.dataDir }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`create-user failed: ${r.stderr || r.stdout}`);
  const s = P.session();
  const l = await s.post('/api/auth/login', { email: FOUNDER, password });
  if (l.status !== 200) throw new Error(`founder login failed ${l.status} ${l.text}`);
  return s;
}

describe('Theme results joined to a worker\'s check', () => {
  let withExtraChecks;
  before(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-themew-'));
    ({ withExtraChecks } = await import('../src/queue.js'));
  });
  const pass = (id, category = 'functional', severity = 'critical') => check(id, category, id, 'pass', { severity });
  const themeFail = { ...check('sec.theme', 'security', 'Theme code unchanged', 'fail', { severity: 'major', detail: '1 file changed' }), notice: true };

  it('adds the theme check and scores the result again, without changing the verdict', () => {
    const result = { checks: [pass('fn.home'), pass('sec.scripts', 'security', 'major')], score: 100, verdict: 'healthy', summary: 'All good' };
    const out = withExtraChecks(result, [themeFail]);
    assert.deepEqual(out.checks.map((c) => c.id), ['fn.home', 'sec.scripts', 'sec.theme']);
    assert.equal(out.verdict, 'healthy', 'a theme change is a notice: it never changes the health verdict');
    assert.equal(out.categories.find((c) => c.key === 'security').counts.fail, 1, 'counted in the Security area like on the main server');
    assert.equal(result.checks.length, 2, 'the worker\'s result is not changed in place');
  });

  it('a check that could not finish, or no theme checks, is left as it is', () => {
    const failed = { error: 'The scan could not finish.', checks: [], score: 0, verdict: 'critical' };
    assert.equal(withExtraChecks(failed, [themeFail]), failed);
    const ok = { checks: [pass('fn.home')], score: 100, verdict: 'healthy' };
    assert.equal(withExtraChecks(ok, []), ok);
    assert.equal(withExtraChecks(ok, undefined), ok);
  });

  it('a theme check the worker somehow sent is replaced by the main server\'s', () => {
    const fake = { ...check('sec.theme', 'security', 'Theme code unchanged', 'pass', { severity: 'major' }), notice: true };
    const out = withExtraChecks({ checks: [pass('fn.home'), fake] }, [themeFail]);
    assert.deepEqual(out.checks.filter((c) => c.id === 'sec.theme').map((c) => c.status), ['fail']);
  });
});

describe('Theme code changes on a worker', () => {
  let P, founder, owner, storeId, worker;
  const shop = 'theme-worker.myshopify.com';
  const files = (f) => P.fake.control({ themeFiles: f });
  const runnersList = async () => (await founder.get('/api/admin/runners')).json.runners;
  const setStatus = async (name, status) => { const id = (await runnersList()).find((x) => x.name === name).id; const r = await founder.patch(`/api/admin/runners/${id}`, { status }); assert.equal(r.status, 200, r.text); };
  const waitFor = async (fn, ms = 30000) => { const until = Date.now() + ms; while (Date.now() < until) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); } throw new Error('timed out'); };
  /** A full check (theme group only) that must run on the worker. */
  const onWorker = async () => {
    await setStatus('main', 'paused');
    try {
      const r = await runAndWait(owner, storeId, { groups: ['security.theme'] });
      assert.equal(r.status, 'done', r.error || '');
      const ls = (await founder.get(`/api/admin/runs/${r.id}/leases`)).json.leases;
      assert.deepEqual(ls.map((l) => [l.runner, l.state]), [['worker-t', 'done']], 'ran on the worker');
      return r;
    } finally { await setStatus('main', 'active'); }
  };

  before(async () => {
    P = await startProduct({ env: { RUN_CONCURRENCY: '1' } });
    founder = await founderSession(P);
    owner = await shopifyOpen(P, shop);
    storeId = owner.storeId;
    await files(BASE);
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { alertEmail: 'owner@theme-worker.test' })).status, 200);
    const tok = await founder.post('/api/admin/runners/join-tokens', { name: 'worker-t', slots: 1 });
    assert.equal(tok.status, 201, tok.text);
    worker = await startWorker(P, tok.json.token);
    await waitFor(async () => (await runnersList()).find((x) => x.name === 'worker-t')?.healthy);
  });
  after(async () => { worker?.cleanup(); await P?.stop(); });

  it('the first full check on a worker records the live theme on the main server', async (t) => {
    const r = await onWorker();
    const c = find(r, 'sec.theme');
    assert.equal(c?.status, 'pass', c?.detail);
    assert.equal(c.detail, 'First record of your live theme “Dawn”: 4 files. We\'ll tell you when any of them changes.');
    assert.equal(P.db().prepare('SELECT COUNT(*) n FROM theme_files WHERE store_id = ?').get(storeId).n, 4, 'record saved once the result was saved');
    note(t, `Ran on worker-t. ${c.detail}`);
  });

  it('the worker never gets the Shopify token or the theme files', () => {
    const specs = P.db().prepare('SELECT l.spec_json FROM runner_leases l JOIN runs r ON r.id = l.run_id WHERE r.store_id = ?').all(storeId).map((x) => x.spec_json);
    assert.ok(specs.length >= 1);
    for (const s of specs) {
      assert.doesNotMatch(s, /shpat_|shprt_|access_token/, 'no Shopify token');
      assert.doesNotMatch(s, /content_for_layout|sec\.theme|extraChecks/, 'no theme files or theme results');
    }
  });

  it('a changed theme file is still reported when the full check ran on a worker', async (t) => {
    await files({ ...BASE, 'layout/theme.liquid': LAYOUT.replace('</head>', '<script src="https://cdn.reviews-app.example/widget.js"></script>\n</head>') });
    const r = await onWorker();
    const c = find(r, 'sec.theme');
    assert.equal(c.status, 'fail');
    assert.equal(c.detail, '1 file of your live theme “Dawn” changed since the last check: layout/theme.liquid (+1 line).');
    assert.deepEqual(c.evidence.files[0].lines, [{ t: '+', n: 5, s: '<script src="https://cdn.reviews-app.example/widget.js"></script>' }]);
    assert.notEqual(r.verdict, 'critical', 'a notice never makes the store critical');
    assert.equal(r.result.categories.find((x) => x.key === 'security').counts.fail, 1, 'counted in the Security area');
    assert.equal(await waitMail(P, 'Check failed on [^\\n]*Theme code unchanged'), 1, 'one alert email, as on the main server');
    note(t, c.detail);
  });

  it('the next check on a worker without changes passes', async () => {
    const r = await onWorker();
    assert.equal(find(r, 'sec.theme').status, 'pass');
    assert.match(find(r, 'sec.theme').detail, /^All 4 files of “Dawn” are the same as at the last check\.$/);
  });

  it('Shopify unreachable: skipped with a plain note, record kept, change reported on the next check', async (t) => {
    await P.fake.control({ themeError: true });
    await files({ ...BASE, 'assets/global.js': 'console.log(2);' });
    try {
      const r = await onWorker();
      assert.equal(find(r, 'sec.theme').status, 'skip');
      assert.match(find(r, 'sec.theme').detail, /couldn’t read your theme files from Shopify/);
    } finally { await P.fake.control({ themeError: false }); }
    const r2 = await onWorker();
    const c = find(r2, 'sec.theme');
    assert.equal(c.status, 'fail', 'the change made while Shopify was unreachable is still reported');
    assert.match(c.detail, /assets\/global\.js \(\+1 −1 lines\)/);
    note(t, c.detail);
  });

  it('the same store on the main server keeps the same record (no double alert)', async () => {
    const r = await runAndWait(owner, storeId, { groups: ['security.theme'] });
    assert.equal(r.status, 'done', r.error || '');
    assert.equal(find(r, 'sec.theme').status, 'pass', 'the worker check\'s record is the one the main server compares with');
  });
});
