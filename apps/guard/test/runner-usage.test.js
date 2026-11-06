// Runner visibility and usage by store (T67).
// Part 1 runs the numbers in-process against its own database, with checks seeded at known times on two runners,
// so every figure on the Runners and Usage pages can be worked out by hand. Part 2 starts the whole product with a
// real worker: checks record which runner ran them, the founder sees the Runners and Usage pages, drain and pause
// are audited, and store owners never see runner names.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, startWorker, FOUNDER, ROOT } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0); // Thu 5 Nov 2026, 12:00 UTC
const at = (min) => new Date(NOW + min * 60000).toISOString().replace('T', ' ').slice(0, 19); // minutes from NOW

describe('Runner and usage numbers', () => {
  let db, u, main, w1, users, stores, ids;
  before(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-usage-'));
    process.env.RUN_CONCURRENCY = '2';
    let q, ensureLicense, setSetting, mainRunner;
    ({ db, q } = await import('../src/db.js'));
    ({ ensureLicense, setSetting } = await import('../src/license.js'));
    ({ mainRunner } = await import('../src/runners.js'));
    u = await import('../src/usage.js');
    main = mainRunner();
    w1 = Number(db.prepare("INSERT INTO runners (name, kind, slots, tags_json, last_seen) VALUES ('w1', 'worker', 2, '[\"india\"]', ?)").run(at(0)).lastInsertRowid);
    const user = (email, plan, currency) => {
      const id = Number(q.insertUser.run(email, 'x', email).lastInsertRowid);
      ensureLicense(id);
      db.prepare("UPDATE licenses SET plan_key = ?, status = ?, currency = ?, billing = 'month', seats = 1, expires_at = NULL WHERE user_id = ?").run(plan, plan === 'trial' ? 'trial' : 'active', currency, id);
      return id;
    };
    users = { a: user('a@shop.test', 'growth', 'EUR'), b: user('b@shop.test', 'starter', 'INR'), c: user('c@shop.test', 'trial', 'EUR') };
    const store = (uid, name) => Number(q.insertStore.run(uid, `https://${name}.example`, name, null, 'x@shop.test', null, '{}', 'Shopify', 1).lastInsertRowid);
    stores = { a1: store(users.a, 'A one'), a2: store(users.a, 'A two'), b1: store(users.b, 'B one'), c1: store(users.c, 'C one') };
    const run = ({ store = null, kind = 'journeys', trigger = 'manual', status = 'done', created, due = null, started, finished, runner, retried = 0 }) =>
      Number(db.prepare('INSERT INTO runs (store_id, url, kind, status, trigger, created_at, due_at, started_at, finished_at, runner_id, retried) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(store, 'https://x.example', kind, status, trigger, at(created), due == null ? null : at(due), at(started), at(finished), runner, retried).lastInsertRowid);
    ids = {
      r1: run({ store: stores.a1, trigger: 'schedule', created: -30, due: -32, started: -29, finished: -19, runner: main.id }), // 10 min, waited 3 min after due
      r2: run({ store: stores.a2, created: -20, started: -20, finished: -15, runner: w1 }), // 5 min
      r3: run({ store: stores.b1, status: 'error', created: -60, started: -59, finished: -53, runner: w1 }), // 6 min, failed
      r4: run({ store: stores.c1, created: -1500, started: -1500, finished: -1470, runner: main.id }), // 30 min, yesterday
      r5: run({ kind: 'free', created: -10, started: -10, finished: -8, runner: main.id }), // 2 min free website check
      r6: run({ store: stores.a1, created: -9, started: -5, finished: -3, runner: main.id, retried: 1 }), // 2 min, retried after w1 lost it
      // Started 31 Oct 23:50, finished 1 Nov 00:10: 10 minutes in each month.
      r7: run({ store: stores.a1, created: -(4 * 1440 + 730), started: -(4 * 1440 + 730), finished: -(4 * 1440 + 710), runner: main.id }),
    };
    db.prepare("INSERT INTO runner_leases (run_id, runner_id, attempt, state, spec_json, job_json, assigned_at, leased_at, finished_at) VALUES (?, ?, 1, 'lost', '{}', '{}', ?, ?, ?)").run(ids.r6, w1, at(-9), at(-8), at(-6));
    setSetting('test', 'browser_hour_cost', '0.6'); // one cent a minute keeps the sums readable
    setSetting('test', 'cost_currency', 'EUR');
  });

  const states = () => [
    { id: main.id, name: 'main', kind: 'main', status: 'active', healthy: true, slots: 2, used: 1, tags: [] },
    { id: w1, name: 'w1', kind: 'worker', status: 'draining', healthy: true, slots: 2, used: 0, tags: ['india'], last_seen: at(0) },
  ];

  it('per runner: checks and browser minutes per day, failures and lost checks, and what is running now', (t) => {
    const rep = u.runnerReport({ now: NOW, days: 7, states: states(), current: [{ runId: ids.r1, runnerId: main.id, storeId: stores.a1, kind: 'journeys' }] });
    const [m, w] = rep;
    assert.deepEqual(m.days.map((d) => d.date), ['2026-11-05', '2026-11-04', '2026-11-03', '2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30']);
    assert.deepEqual(m.today, { date: '2026-11-05', checks: 3, minutes: 14, failed: 0, lost: 0 }, 'main today: 10 + 2 (free check) + 2 (retry) minutes');
    assert.deepEqual(m.days[1], { date: '2026-11-04', checks: 1, minutes: 30, failed: 0, lost: 0 });
    assert.deepEqual(m.days[5], { date: '2026-10-31', checks: 1, minutes: 20, failed: 0, lost: 0 }, 'a check counts on the day it started');
    assert.deepEqual(m.totals, { checks: 5, minutes: 64, failed: 0, lost: 0 });
    assert.deepEqual(w.today, { date: '2026-11-05', checks: 2, minutes: 11, failed: 1, lost: 1 }, 'w1: 5 + 6 minutes, one error, one check lost and retried on main');
    assert.equal(w.status, 'draining');
    assert.deepEqual(m.current, [{ runId: ids.r1, store: 'A one', kind: 'Shopping check', since: at(-29), waiting: false }]);
    assert.deepEqual(w.current, []);
    note(t, 'main: 5 checks / 64 min in 7 days (14 today); w1: 2 checks / 11 min today, 1 failed, 1 lost');
  });

  it('each check shows its runner, queued/started/finished, wait, duration and whether it was retried', (t) => {
    const runs = u.recentRuns({ limit: 50 });
    const by = Object.fromEntries(runs.map((r) => [r.id, r]));
    assert.deepEqual([by[ids.r1].runner, by[ids.r1].waitSec, by[ids.r1].tookSec, by[ids.r1].retried], ['main', 180, 600, false], 'scheduled: wait counts from when it was due');
    assert.deepEqual([by[ids.r2].runner, by[ids.r2].waitSec, by[ids.r2].tookSec], ['w1', 0, 300]);
    assert.deepEqual([by[ids.r6].runner, by[ids.r6].waitSec, by[ids.r6].tookSec, by[ids.r6].retried], ['main', 240, 120, true]);
    assert.deepEqual([by[ids.r3].status, by[ids.r3].store.name, by[ids.r3].store.account], ['error', 'B one', 'b@shop.test']);
    assert.equal(by[ids.r5].store, null, 'free website check has no store');
    assert.deepEqual(u.recentRuns({ runnerId: w1 }).map((r) => r.id).sort(), [ids.r2, ids.r3].sort(), 'one runner\'s checks');
    assert.equal(u.recentRuns({ limit: 2 }).length, 2);
    note(t, 'check #r1 waited 3 min after it was due and took 10 min on main; #r6 marked as retried');
  });

  it('usage for a month: browser minutes per account and store, by plan, with estimated cost next to the price', (t) => {
    const r = u.usageReport({ now: NOW, period: 'month', date: '2026-11' });
    assert.deepEqual([r.from, r.to, r.rate], ['2026-11-01 00:00:00', '2026-12-01 00:00:00', { perHour: 0.6, currency: 'EUR' }]);
    const a = r.accounts.find((x) => x.email === 'a@shop.test');
    assert.deepEqual([a.plan, a.minutes, a.checks, a.cost], ['Growth', 27, 3, 0.27], '10 + 5 + 2 + the 10 November minutes of the check that started in October');
    assert.deepEqual(a.stores.map((s) => [s.name, s.minutes, s.checks, s.cost]), [['A one', 22, 2, 0.22], ['A two', 5, 1, 0.05]]);
    assert.deepEqual(a.pays, { amount: 45, currency: 'EUR', inCostCurrency: 45 });
    assert.equal(a.costPct, 0.6);
    const b = r.accounts.find((x) => x.email === 'b@shop.test');
    assert.deepEqual([b.minutes, b.cost, b.pays.amount, b.pays.currency, b.pays.inCostCurrency, b.costPct], [6, 0.06, 1499, 'INR', 16.49, 0.4], 'INR price converted with rough rates');
    const c = r.accounts.find((x) => x.email === 'c@shop.test');
    assert.deepEqual([c.plan, c.minutes, c.pays, c.costPct], ['Free trial', 30, null, null], 'a trial pays nothing');
    assert.deepEqual(r.freeChecks, { minutes: 2, checks: 1, cost: 0.02 });
    assert.deepEqual(r.totals, { minutes: 65, cost: 0.65, accounts: 3 });
    assert.deepEqual(r.plans.map((p) => [p.plan, p.accounts, p.stores, p.minutes, p.cost, p.pays]), [['Free trial', 1, 1, 30, 0.3, 0], ['Growth', 1, 2, 27, 0.27, 45], ['Starter', 1, 1, 6, 0.06, 16.49]]);
    assert.equal(r.days.length, 30);
    assert.deepEqual(r.days.find((d) => d.date === '2026-11-05'), { date: '2026-11-05', minutes: 25, byPlan: { Growth: 17, Starter: 6, 'Free website checks': 2 } });
    assert.deepEqual(r.days.find((d) => d.date === '2026-11-01').byPlan, { Growth: 10 });
    note(t, 'November: 65 browser minutes, EUR 0.65 at EUR 0.60/hour; Growth account 27 min = 0.6% of its EUR 45 price');
  });

  it('usage for a day, and for the month a long check started in', () => {
    const d = u.usageReport({ now: NOW, period: 'day', date: '2026-11-05' });
    const a = d.accounts.find((x) => x.email === 'a@shop.test');
    assert.deepEqual([a.minutes, a.checks, a.pays.amount, a.costPct], [17, 3, 1.5, 11.3], 'a day pays one thirtieth of the November price');
    assert.equal(d.totals.minutes, 25);
    assert.deepEqual(d.days, []);
    const oct = u.usageReport({ now: NOW, period: 'month', date: '2026-10' });
    assert.deepEqual(oct.accounts.map((x) => [x.email, x.minutes, x.checks]), [['a@shop.test', 10, 1]]);
    assert.throws(() => u.usageReport({ period: 'week' }), /day or month/);
    assert.throws(() => u.usageReport({ period: 'day', date: '2026-02-30' }), /YYYY-MM-DD/);
    assert.throws(() => u.usageReport({ period: 'month', date: '2026-13' }), /YYYY-MM/);
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

describe('Runners and usage in the founder console', () => {
  let P, founder, owner, store, worker, ids = {};
  const runners = async () => { const r = await founder.get('/api/admin/runners'); assert.equal(r.status, 200, r.text); return r.json; };
  const runner = async (name) => (await runners()).runners.find((x) => x.name === name);
  const setStatus = async (name, status) => { const r = await founder.patch(`/api/admin/runners/${(await runner(name)).id}`, { status }); assert.equal(r.status, 200, r.text); };
  const waitFor = async (fn, ms = 30000) => { const until = Date.now() + ms; while (Date.now() < until) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); } throw new Error('timed out'); };
  const check = async () => {
    const r = await owner.post(`/api/stores/${store}/run`, { kind: 'journeys' });
    assert.equal(r.status, 200, r.text);
    const id = r.json.runId;
    return waitFor(async () => { const g = await owner.get(`/api/runs/${id}`); return ['done', 'error', 'cancelled'].includes(g.json?.status) && g.json; }, 120000);
  };

  before(async () => {
    P = await startProduct({ env: { RUN_CONCURRENCY: '1' } });
    founder = await founderSession(P);
    owner = await signup(P, 'usage-owner@shop.test');
    store = await addStore(P, owner, { runNow: false });
    const tok = await founder.post('/api/admin/runners/join-tokens', { name: 'worker-u', slots: 1 });
    assert.equal(tok.status, 201, tok.text);
    worker = await startWorker(P, tok.json.token);
    await waitFor(async () => (await runner('worker-u'))?.healthy);
  });
  after(async () => { worker?.cleanup(); await P?.stop(); });

  it('each check records the runner that ran it, its wait and duration; the Runners page counts it', async (t) => {
    await setStatus('main', 'paused');
    const onWorker = await check();
    await setStatus('main', 'active');
    const onMain = await check();
    for (const d of [onWorker, onMain]) assert.equal(d.status, 'done', d.error || '');
    ids = { worker: onWorker.id, main: onMain.id };
    const runs = (await founder.get('/api/admin/runs')).json.runs;
    const w = runs.find((r) => r.id === onWorker.id), m = runs.find((r) => r.id === onMain.id);
    assert.deepEqual([w.runner, m.runner], ['worker-u', 'main']);
    for (const r of [w, m]) {
      assert.ok(r.tookSec > 0 && r.tookSec < 300, `took ${r.tookSec}s`);
      assert.ok(r.waitSec >= 0 && r.waitSec < 120, `waited ${r.waitSec}s`);
      assert.ok(r.startedAt && r.finishedAt && r.queuedAt);
      assert.equal(r.retried, false);
      assert.equal(r.store.account, 'usage-owner@shop.test');
    }
    assert.deepEqual((await founder.get(`/api/admin/runs?runner=${(await runner('worker-u')).id}`)).json.runs.map((r) => r.id), [onWorker.id]);
    const d = await runners();
    const wu = d.runners.find((r) => r.name === 'worker-u'), mn = d.runners.find((r) => r.name === 'main');
    assert.equal(wu.today.checks, 1);
    assert.equal(mn.today.checks, 1);
    assert.ok(wu.today.minutes > 0 && mn.today.minutes > 0);
    assert.deepEqual([wu.totals.failed, wu.totals.lost], [0, 0]);
    assert.ok(d.recent.some((r) => r.id === onWorker.id && r.runner === 'worker-u'));
    note(t, `check #${onWorker.id} ran on worker-u (${w.tookSec}s, waited ${w.waitSec}s); #${onMain.id} on main (${m.tookSec}s)`);
  });

  it('usage report: the store\'s browser minutes, by plan; the cost rate is a founder setting', async (t) => {
    const r = await founder.get('/api/admin/usage?period=month');
    assert.equal(r.status, 200, r.text);
    const a = r.json.accounts.find((x) => x.email === 'usage-owner@shop.test');
    assert.equal(a.checks, 2);
    assert.equal(a.stores.length, 1);
    assert.equal(a.stores[0].id, store);
    assert.ok(a.minutes > 0);
    assert.ok(r.json.plans.some((p) => p.plan === a.plan));
    const day = await founder.get('/api/admin/usage?period=day');
    assert.equal(day.json.accounts.find((x) => x.email === 'usage-owner@shop.test').checks, 2);
    assert.equal((await founder.get('/api/admin/usage?period=week')).status, 400);
    assert.equal((await founder.get('/api/admin/usage?period=month&date=2026-13')).status, 400);

    assert.equal((await founder.patch('/api/admin/settings', { browser_hour_cost: -1 })).status, 400);
    assert.equal((await founder.patch('/api/admin/settings', { browser_hour_cost: 'lots' })).status, 400);
    assert.equal((await founder.patch('/api/admin/settings', { cost_currency: 'XYZ' })).status, 400);
    assert.equal((await founder.patch('/api/admin/settings', { browser_hour_cost: 0.05, cost_currency: 'USD' })).status, 200);
    const again = (await founder.get('/api/admin/usage?period=month')).json;
    assert.deepEqual(again.rate, { perHour: 0.05, currency: 'USD' });
    const audit = JSON.stringify((await founder.get('/api/admin/audit')).json);
    assert.match(audit, /browser_hour_cost/, 'cost changes are audited');
    note(t, `month: ${a.minutes} browser minutes for the store over 2 checks; bad rates and currencies refused; rate change audited`);
  });

  it('drain and pause are audited with before and after', async () => {
    await setStatus('worker-u', 'draining');
    await setStatus('worker-u', 'paused');
    assert.equal((await runner('worker-u')).status, 'paused');
    await setStatus('worker-u', 'active');
    const rows = (await founder.get('/api/admin/audit')).json.audit.filter((a) => a.action === 'runner.update').map((a) => JSON.parse(a.detail_json));
    const steps = rows.filter((d) => d.runner === 'worker-u').map((d) => `${d.before.status}>${d.after.status}`);
    for (const s of ['active>draining', 'draining>paused', 'paused>active']) assert.ok(steps.includes(s), `${s} in ${steps.join(', ')}`);
  });

  it('store owners see when a check ran and how long it took, never the runner', async (t) => {
    for (const id of [ids.worker, ids.main]) {
      const r = await owner.get(`/api/runs/${id}`);
      assert.equal(r.status, 200);
      assert.ok(r.json.created_at && r.json.finished_at, 'checked at, took');
      assert.ok(!/worker-u|runner/i.test(r.text), 'no runner in the report');
    }
    const list = await owner.get(`/api/stores/${store}/runs`);
    assert.equal(list.status, 200);
    assert.ok(!/worker-u|runner_id|"runner"/i.test(list.text), 'no runner in the history');
    note(t, 'owner report and history carry times only, no runner names or ids');
  });

  it('customers and signed-out visitors are refused', async () => {
    for (const s of [owner, P.session()]) {
      for (const url of ['/api/admin/usage', '/api/admin/usage?period=day', '/api/admin/runs', '/api/admin/runners']) {
        const r = await s.get(url);
        assert.ok([401, 403].includes(r.status), `${url}: ${r.status}`);
      }
      assert.ok([401, 403].includes((await s.patch('/api/admin/settings', { browser_hour_cost: 0 })).status));
    }
    assert.equal((await owner.get('/api/admin/usage')).status, 403);
    assert.equal((await P.session().get('/api/admin/usage')).status, 401);
  });

  it('screens: Runners page with per-runner numbers and latest checks; Usage page', async (t) => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      await ctx.addCookies(founder.browserCookies());
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`${P.base}/app#/admin/runners`);
      await p.waitForSelector('#runners-recent tbody tr', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      assert.match(await p.locator('tr[data-name="worker-u"]').textContent(), /Checking in/);
      assert.match(await p.locator('#runners-recent').textContent(), /worker-u/);
      assert.match(await p.locator('#runners-days thead').textContent(), /main.*worker-u/s);
      await screenshot(t, p, 'Founder console: runners with checks, minutes and latest checks', { fullPage: true });

      await p.goto(`${P.base}/app#/admin/usage`);
      await p.waitForSelector('#usage-accounts tbody tr', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      assert.match(await p.locator('#usage-accounts').textContent(), /usage-owner@shop\.test/);
      assert.match(await p.locator('#usage-plans').textContent(), /\d/);
      assert.match(await p.textContent('.main-inner'), /USD 0\.05.*per browser hour/s);
      await screenshot(t, p, 'Founder console: usage by plan, account and store (month)', { fullPage: true });
      await p.selectOption('#usage-pick select[name=period]', 'day');
      await p.waitForFunction(() => location.hash.includes('period=day') && document.querySelector('#usage-pick input[type=date]'));
      await p.waitForSelector('#usage-accounts tbody tr');
      assert.equal(await p.locator('#usage-days').count(), 0, 'no per-day table for a single day');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
});
