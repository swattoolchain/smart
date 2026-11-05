// Runners (T65, part 1): worker machines that run checks for the main server.
// Part 1 tests the routing rules and join tokens in-process. Part 2 starts the whole product with real workers
// (src/worker.js): a shared queue without double-running, tag routing, draining, a worker that dies mid-check,
// screenshots that arrive from a worker and stay owner-only, and refusals for everyone else.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, startWorker, FOUNDER, ROOT } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const R = (id, o = {}) => ({ id, kind: 'worker', status: 'active', healthy: true, slots: 2, used: 0, tags: [], ...o });
const MAIN = R(1, { kind: 'main' });
const JOURNEY = { kind: 'journeys', storeId: 5 };

describe('Runner routing and join tokens', () => {
  let r, db;
  before(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-runners-'));
    ({ db } = await import('../src/db.js'));
    r = await import('../src/runners.js');
  });

  it('a check goes to the runner with the most free slots; the main server wins a tie', () => {
    assert.equal(r.chooseRunner(JOURNEY, [MAIN, R(2)]).id, 1, 'tie: main first, so nothing changes until workers have room');
    assert.equal(r.chooseRunner(JOURNEY, [{ ...MAIN, used: 1 }, R(2)]).id, 2);
    assert.equal(r.chooseRunner(JOURNEY, [{ ...MAIN, used: 2 }, R(2, { used: 2 }), R(3, { slots: 4, used: 1 })]).id, 3);
    assert.equal(r.chooseRunner(JOURNEY, [{ ...MAIN, used: 2 }, R(2, { used: 2 })]), null, 'every slot busy: the check waits');
  });

  it('only active, healthy runners take checks; workers take journey checks only', () => {
    const busyMain = { ...MAIN, used: 2 };
    assert.equal(r.chooseRunner(JOURNEY, [busyMain, R(2, { healthy: false })]), null, 'a worker that stopped checking in');
    assert.equal(r.chooseRunner(JOURNEY, [busyMain, R(2, { status: 'draining' })]), null, 'draining');
    assert.equal(r.chooseRunner(JOURNEY, [busyMain, R(2, { status: 'paused' })]), null, 'paused');
    for (const job of [{ kind: 'full', storeId: 5 }, { kind: 'journeys', storeId: 5, release: 3 }, { kind: 'journeys', storeId: 5, preview: { url: 'x' } }, { kind: 'free' }]) {
      assert.equal(r.chooseRunner(job, [busyMain, R(2)]), null, `${JSON.stringify(job)} stays on the main server`);
      assert.equal(r.chooseRunner(job, [MAIN, R(2, { slots: 9 })]).id, 1);
    }
  });

  it('tags: sale mode, plan and region preferred in that order, with fallback to any runner', () => {
    assert.deepEqual(r.wantedTags({ sale: true, plan: 'pro', markets: ['IN', 'DE', 'AT'] }), ['sale', 'pro', 'india', 'eu']);
    assert.deepEqual(r.wantedTags({}), []);
    const runners = [MAIN, R(2, { tags: ['india'] }), R(3, { tags: ['sale'], slots: 1 })];
    assert.equal(r.chooseRunner({ ...JOURNEY, tags: ['sale', 'india'] }, runners).id, 3, 'sale runner first even with fewer free slots');
    assert.equal(r.chooseRunner({ ...JOURNEY, tags: ['india'] }, runners).id, 2);
    assert.equal(r.chooseRunner({ ...JOURNEY, tags: ['sale', 'india'] }, [MAIN, R(2, { tags: ['india'] }), R(3, { tags: ['sale'], slots: 1, used: 1 })]).id, 2, 'sale runner full: next tag');
    assert.equal(r.chooseRunner({ ...JOURNEY, tags: ['eu'] }, runners).id, 1, 'nobody tagged eu: any runner');
    assert.equal(r.chooseRunner({ kind: 'full', storeId: 5, tags: ['india'] }, runners).id, 1, 'a tag never sends a full check to a worker');
  });

  it('a retried check avoids the runner that lost it, unless nothing else can take it', () => {
    assert.equal(r.chooseRunner({ ...JOURNEY, avoid: 1 }, [MAIN, R(2, { slots: 1 })]).id, 2);
    assert.equal(r.chooseRunner({ ...JOURNEY, avoid: 2 }, [{ ...MAIN, used: 2 }, R(2)]).id, 2);
  });

  it('when checks wait: sale mode first, then paid plans, then retries, then first come first served', () => {
    const jobs = [{ n: 'free-1', seqNo: 1 }, { n: 'paid', paid: true, seqNo: 2 }, { n: 'free-2', seqNo: 3 }, { n: 'sale', sale: true, seqNo: 4 }, { n: 'retry', retry: true, seqNo: 5 }];
    assert.deepEqual(jobs.sort(r.byPriority).map((j) => j.n), ['sale', 'paid', 'retry', 'free-1', 'free-2']);
  });

  it('a join token works once, within 24 hours; bad, used and expired tokens are refused', () => {
    assert.throws(() => r.createJoinToken({ name: 'main' }), /already exists/);
    assert.throws(() => r.createJoinToken({ name: 'w1', slots: 0 }), /Slots/);
    assert.throws(() => r.createJoinToken({ name: '../x' }), /short name/);
    const t = r.createJoinToken({ name: 'w1', slots: 3, tags: 'Sale, india, bad tag!' }, 'founder');
    assert.match(t.token, /^tjr_[\w-]{32}$/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM runner_join_tokens WHERE token_hash LIKE ?').get(`%${t.token}%`).n, 0, 'only a hash is stored');
    assert.equal(r.joinWithToken('tjr_wrong'), null);
    const j = r.joinWithToken(t.token);
    assert.deepEqual([j.runner.name, j.runner.slots, j.runner.tags, j.runner.status], ['w1', 3, ['sale', 'india'], 'active']);
    assert.equal(r.joinWithToken(t.token), null, 'used once');
    assert.equal(r.authRunner(j.credentials).id, j.runner.id);
    assert.equal(r.authRunner(j.credentials.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))), null, 'wrong secret');
    assert.equal(r.authRunner(`${r.mainRunner().id}.${'x'.repeat(30)}`), null, 'nobody can sign in as the main server');
    const old = r.createJoinToken({ name: 'w2' });
    db.prepare("UPDATE runner_join_tokens SET expires_at = datetime('now', '-1 minute') WHERE name = 'w2'").run();
    assert.equal(r.joinWithToken(old.token), null, 'expired');
    assert.throws(() => r.updateRunner(r.mainRunner().id, { slots: 4 }), /RUN_CONCURRENCY/);
    assert.throws(() => r.updateRunner(j.runner.id, { status: 'gone' }), /Status/);
    assert.equal(r.updateRunner(j.runner.id, { status: 'draining', slots: 5 })[1].slots, 5);
  });
});

/** Creates the founder account from the server (founders can't sign up) and signs it in. */
async function founderSession(P, password = 'founder-test-password') {
  const r = spawnSync(process.execPath, ['scripts/create-user.js', FOUNDER, password, 'Founder'], { cwd: ROOT, env: { ...process.env, DATA_DIR: P.dataDir }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`create-user failed: ${r.stderr || r.stdout}`);
  const s = P.session();
  const l = await s.post('/api/auth/login', { email: FOUNDER, password });
  if (l.status !== 200) throw new Error(`founder login failed ${l.status} ${l.text}`);
  s.email = FOUNDER;
  return s;
}

const TYPE = 'application/vnd.tharam.runner+json';

describe('Workers running checks', () => {
  let P, founder, owners, stores, other, workers = [];
  const runners = async () => { const r = await founder.get('/api/admin/runners'); assert.equal(r.status, 200, r.text); return r.json.runners; };
  const runner = async (name) => (await runners()).find((x) => x.name === name);
  const leases = async (runId) => (await founder.get(`/api/admin/runs/${runId}/leases`)).json.leases;
  const setStatus = async (name, status) => { const r = await founder.patch(`/api/admin/runners/${(await runner(name)).id}`, { status }); assert.equal(r.status, 200, r.text); };
  const token = async (body) => { const r = await founder.post('/api/admin/runners/join-tokens', body); assert.equal(r.status, 201, r.text); return r.json.token; };
  const start = (i) => owners[i].post(`/api/stores/${stores[i]}/run`, { kind: 'journeys' }).then((r) => { assert.equal(r.status, 200, r.text); return r.json.runId; });
  const wait = async (i, runId, ms = 120000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const g = await owners[i].get(`/api/runs/${runId}`);
      if (['done', 'error', 'cancelled'].includes(g.json?.status)) return g.json;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`run ${runId} did not finish`);
  };
  const waitFor = async (fn, ms = 30000) => { const until = Date.now() + ms; while (Date.now() < until) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); } throw new Error('timed out'); };

  before(async () => {
    P = await startProduct({ env: { RUN_CONCURRENCY: '1', RUNNER_TIMEOUT_S: '4' } });
    founder = await founderSession(P);
    owners = [];
    stores = [];
    for (let i = 0; i < 3; i++) {
      const o = await signup(P, `runner-owner-${i}@shop.test`);
      owners.push(o);
      stores.push(await addStore(P, o, { runNow: false }));
    }
    other = await signup(P, 'runner-other@shop.test');
  });
  after(async () => { for (const w of workers) w.cleanup(); await P?.stop(); });

  it('customers, signed-out visitors and unknown machines are refused', async () => {
    for (const s of [owners[0], P.session()]) {
      assert.ok([401, 403].includes((await s.get('/api/admin/runners')).status));
      assert.ok([401, 403].includes((await s.post('/api/admin/runners/join-tokens', { name: 'sneaky' })).status));
      assert.ok([401, 403].includes((await s.patch('/api/admin/runners/1', { status: 'paused' })).status));
      assert.ok([401, 403].includes((await s.get('/api/admin/runs/1/leases')).status));
    }
    const post = (url, body, auth) => fetch(P.base + url, { method: 'POST', headers: { 'content-type': TYPE, ...(auth ? { authorization: `Runner ${auth}` } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post('/api/runner/join', { token: 'tjr_made-up-token-made-up-token-123' })).status, 401);
    assert.equal((await post('/api/runner/check-in', { running: [] })).status, 401);
    assert.equal((await post('/api/runner/check-in', { running: [] }, `1.${'x'.repeat(40)}`)).status, 401);
    assert.equal((await post('/api/runner/runs/1/complete', { error: 'x' }, '2.nope')).status, 401);
    const list = await runners();
    assert.deepEqual(list.map((r) => [r.name, r.kind, r.slots, r.status, r.healthy]), [['main', 'main', 1, 'active', true]], 'with no workers there is only the main server');
  });

  it('a worker joins with a one-time token; the token cannot be used again', async (t) => {
    const tok = await token({ name: 'worker-a', slots: 1 });
    workers.push(await startWorker(P, tok));
    const again = await fetch(`${P.base}/api/runner/join`, { method: 'POST', headers: { 'content-type': TYPE }, body: JSON.stringify({ token: tok }) });
    assert.equal(again.status, 401, 'reused join token');
    const a = await waitFor(async () => { const x = await runner('worker-a'); return x?.healthy && x; });
    assert.deepEqual([a.kind, a.slots, a.status], ['worker', 1, 'active']);
    note(t, 'worker-a joined with its token; the same token was refused the second time');
  });

  it('the main server and a worker share the queue: every check runs once, screenshots arrive and stay owner-only', async (t) => {
    const ids = await Promise.all([0, 1, 2].map(start));
    const done = await Promise.all(ids.map((id, i) => wait(i, id)));
    for (const d of done) assert.equal(d.status, 'done', d.error || '');
    const where = [];
    for (const id of ids) {
      const ls = await leases(id);
      assert.ok(ls.length <= 1, `run ${id} ran once`);
      where.push(ls.length ? ls[0].runner : 'main');
      if (ls.length) assert.deepEqual([ls[0].state, ls[0].attempt], ['done', 1]);
    }
    assert.ok(where.includes('main') && where.includes('worker-a'), `both runners worked: ${where.join(', ')}`);
    // Screenshots from the worker's check are on the main server, and only for the store owner.
    const i = where.indexOf('worker-a');
    const cover = done[i].result.cover;
    assert.match(cover, new RegExp(`^/shots/run-${ids[i]}/[\\w.-]+\\.png$`));
    const mine = await owners[i].get(cover);
    assert.equal(mine.status, 200);
    assert.equal((await other.get(cover)).status, 404, 'another account');
    assert.equal((await P.session().get(cover)).status, 404, 'signed out');
    await waitFor(() => fs.readdirSync(path.join(workers[0].dataDir, 'shots')).length === 0, 5000); // the worker keeps no copies
    // The owner sees the report as usual, never which machine ran it.
    assert.ok(!JSON.stringify(done[i]).includes('worker-a'), 'runner names are not shown to store owners');
    note(t, `3 journey checks at once with 1 slot on main and 1 on worker-a: ${where.join(', ')}; each ran once`);
  });

  it('tags route a store to its runner, with fallback; a draining worker takes no new checks', async (t) => {
    const tok = await token({ name: 'worker-india', slots: 1, tags: 'india' });
    workers.push(await startWorker(P, tok));
    await waitFor(async () => (await runner('worker-india'))?.healthy);
    assert.equal((await owners[1].patch(`/api/stores/${stores[1]}`, { config: { markets: ['IN'] } })).status, 200);
    let id = await start(1);
    assert.equal((await wait(1, id)).status, 'done');
    assert.equal((await leases(id))[0]?.runner, 'worker-india', 'a store selling in India goes to the india runner, though main was free');
    id = await start(0);
    assert.equal((await wait(0, id)).status, 'done');
    assert.equal((await leases(id)).length, 0, 'a store with no tag stays on the free main server');

    await setStatus('worker-india', 'draining');
    id = await start(1);
    assert.equal((await wait(1, id)).status, 'done');
    assert.notEqual((await leases(id))[0]?.runner, 'worker-india', 'draining: no new checks');
    await setStatus('worker-india', 'active');
    const audit = (await founder.get('/api/admin/audit')).json;
    assert.match(JSON.stringify(audit), /runner\.update/, 'status changes are in the audit log');
    note(t, 'india-tagged store → worker-india; untagged store → main; while draining, the india store went elsewhere');
  });

  it('a worker that dies mid-check: the check is retried once elsewhere, and the dead worker cannot send it back', async (t) => {
    await setStatus('main', 'paused');
    await setStatus('worker-india', 'paused');
    const id = await start(2);
    const leased = await waitFor(async () => { const ls = await leases(id); return ls[0]?.state === 'leased' && ls[0]; });
    assert.equal(leased.runner, 'worker-a');
    const creds = workers[0].credentials();
    workers[0].kill();
    await setStatus('main', 'active');
    const d = await wait(2, id);
    assert.equal(d.status, 'done', d.error || '');
    const ls = await leases(id);
    assert.deepEqual(ls.map((l) => [l.runner, l.state, l.attempt]), [['worker-a', 'lost', 1]], 'lost on worker-a; the retry ran on main (no lease)');
    assert.equal((await runner('worker-a')).healthy, false);
    const late = await fetch(`${P.base}/api/runner/runs/${id}/complete`, { method: 'POST', headers: { 'content-type': TYPE, authorization: `Runner ${creds}` }, body: JSON.stringify({ result: { checks: [], score: 0, verdict: 'critical' } }) });
    assert.equal(late.status, 409, 'a check never counts twice');
    assert.equal((await owners[2].get(`/api/runs/${id}`)).json.verdict, d.verdict, 'the saved result is unchanged');
    await setStatus('worker-india', 'active');
    note(t, `worker-a was killed during check ${id}; it moved to main and finished (${d.verdict}); worker-a's late result was refused`);
  });

  it('founder console: Runners tab lists the machines and creates join tokens', async (t) => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      await ctx.addCookies(founder.browserCookies());
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`${P.base}/app#/admin/runners`);
      await p.waitForSelector('#runners tbody tr', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      assert.equal(await p.locator('#runners tr.runner-row').count(), 3);
      assert.match(await p.locator('tr[data-name="worker-a"]').textContent(), /Not responding/);
      assert.match(await p.locator('tr[data-name="worker-india"]').textContent(), /Checking in.*india/s);
      await p.fill('#rjoin input[name=name]', 'worker-eu');
      await p.fill('#rjoin input[name=tags]', 'eu');
      await p.click('#rjoin button[type=submit]');
      await p.waitForSelector('#rjoin-token');
      assert.match(await p.textContent('#rjoin-token'), /^tjr_/);
      await screenshot(t, p, 'Founder console: runners and a new join token', { fullPage: true });
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
});
