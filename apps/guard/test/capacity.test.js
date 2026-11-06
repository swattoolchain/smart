// Capacity: the founder console's Capacity page and the "time to add a worker" emails.
// Part 1 runs the capacity code in-process against its own database, with checks seeded at known times, so every
// number on the page can be worked out by hand. Part 2 starts the whole product: a real check records when it got
// a browser, the founder sees the page, and customers are refused.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait, FOUNDER, ROOT } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0); // 12:00 UTC
const at = (min) => new Date(NOW + min * 60000).toISOString().replace('T', ' ').slice(0, 19); // minutes from NOW
const MIN = 60000;

describe('Capacity numbers and alerts', () => {
  let db, capacityReport, checkCapacityAlerts, percentile, peakOverlap, dueTime, userA, userB, storeA, storeB, realLog;
  const mail = [];
  before(async () => {
    realLog = console.log;
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-capacity-'));
    process.env.SMTP_HOST = '';
    process.env.MAIL_DEBUG = '1';
    process.env.ADMIN_EMAIL = 'founder@tharam.test';
    process.env.RUN_CONCURRENCY = '2';
    process.env.BASE_URL = 'http://tharam.test';
    let q, ensureLicense;
    ({ db, q } = await import('../src/db.js'));
    ({ ensureLicense } = await import('../src/license.js'));
    ({ capacityReport, checkCapacityAlerts, percentile, peakOverlap } = await import('../src/capacity.js'));
    ({ dueTime } = await import('../src/scheduler.js'));
    userA = Number(q.insertUser.run('a@shop.test', 'x', 'A').lastInsertRowid);
    userB = Number(q.insertUser.run('b@shop.test', 'x', 'B').lastInsertRowid);
    ensureLicense(userA); ensureLicense(userB);
    db.prepare("UPDATE licenses SET plan_key = 'trial' WHERE user_id = ?").run(userA);
    db.prepare("UPDATE licenses SET plan_key = 'growth' WHERE user_id = ?").run(userB);
    storeA = Number(q.insertStore.run(userA, 'https://a.example', 'A', null, 'a@shop.test', null, '{}', 'Shopify', 1).lastInsertRowid);
    storeB = Number(q.insertStore.run(userB, 'https://b.example', 'B', null, 'b@shop.test', null, '{}', 'Shopify', 1).lastInsertRowid);
    console.log = (...a) => { const s = a.join(' '); const m = /^\[mail skipped\] to=(\S*) subject=(.*)$/.exec(s); if (m) mail.push({ to: m[1], subject: m[2], text: '' }); else if (mail.length && !mail.at(-1).text) mail.at(-1).text = s; else realLog(...a); };
  });
  after(() => { if (realLog) console.log = realLog; });

  const run = ({ store = null, kind = 'journeys', trigger = 'schedule', status = 'done', created, due = null, started = null, finished = null }) =>
    Number(db.prepare('INSERT INTO runs (store_id, url, kind, status, trigger, created_at, due_at, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(store, 'https://x.example', kind, status, trigger, at(created), due == null ? null : at(due), started == null ? null : at(started), finished == null ? null : at(finished)).lastInsertRowid);

  it('helpers: percentiles, overlapping checks and when a scheduled check was due', () => {
    assert.equal(percentile([15, 1, 6, 2], 50), 2);
    assert.equal(percentile([15, 1, 6, 2], 95), 15);
    assert.equal(percentile([], 50), null);
    assert.equal(peakOverlap([[0, 10], [5, 15], [10, 20]]), 2, 'a check ending as another starts does not overlap it');
    assert.equal(peakOverlap([[0, 10], [1, 9], [2, 8]]), 3);
    // Due at last check + interval; never more than one 5-minute scheduler tick before it was queued; never in the future.
    assert.equal(dueTime(at(-185), 180, NOW), at(-5));
    assert.equal(dueTime(at(-182), 180, NOW), at(-2));
    assert.equal(dueTime(at(-100), 180, NOW), at(0));
    assert.equal(dueTime(null, 180, NOW), at(0));
  });

  it('seeded checks give the right browser minutes, peaks, late starts and durations', (t) => {
    // Today (12:00 now). Times are minutes from now.
    run({ store: storeA, created: -120, due: -120, started: -118, finished: -115 }); // 3 min, 2 min late
    run({ store: storeB, kind: 'full', created: -120, due: -122, started: -116, finished: -110 }); // 6 min, 6 min late; overlaps the first
    run({ kind: 'free', trigger: null, created: -60, started: -60, finished: -59 }); // free website check, 1 min
    run({ store: storeA, created: -30, due: -30, started: -15, finished: -13 }); // 2 min, 15 min late
    run({ store: storeA, created: -200, finished: -190 }); // before started_at existed: left out
    // Yesterday.
    run({ store: storeA, created: -1680, due: -1680, started: -1679, finished: -1676 }); // 3 min, 1 min late
    run({ store: storeA, trigger: 'manual', status: 'cancelled', created: -1620, started: -1620, finished: -1618 }); // stopped: browser time only
    // Too old for 7 days.
    run({ store: storeA, created: -10 * 1440, due: -10 * 1440, started: -10 * 1440 + 30, finished: -10 * 1440 + 35 });
    // Waiting right now, 20 minutes after it was due.
    const waiting = run({ store: storeB, status: 'queued', created: -20, due: -20 });

    const r = capacityReport({ now: NOW, queue: { waiting: 1, active: 0 } });
    assert.equal(r.slots, 2);
    assert.equal(r.browserMinutes.days.length, 7);
    const [today, yesterday] = r.browserMinutes.days;
    assert.deepEqual(today, { date: '2026-11-05', total: 12, byPlan: { 'Free trial': 5, Growth: 6, 'Free website checks': 1 }, checks: 4 });
    assert.deepEqual(yesterday, { date: '2026-11-04', total: 5, byPlan: { 'Free trial': 5 }, checks: 2 });
    assert.equal(r.browserMinutes.total, 17);
    assert.deepEqual(r.browserMinutes.plans, ['Free trial', 'Free website checks', 'Growth']);
    assert.deepEqual(r.slotUse.peaks.slice(0, 3).map((p) => p.peak), [2, 1, 0]);
    assert.equal(r.slotUse.peaks[0].pct, 100);
    assert.equal(r.slotUse.peak, 2);
    assert.equal(r.slotUse.lastHourPct, 3, '3 busy minutes out of 2 slots × 60 minutes = 2.5%');
    assert.deepEqual({ count: r.lateStarts.count, medianMin: r.lateStarts.medianMin, p95Min: r.lateStarts.p95Min, overLimit: r.lateStarts.overLimit }, { count: 4, medianMin: 2, p95Min: 15, overLimit: 1 });
    assert.deepEqual(r.lateStarts.now, { started: 1, waiting: 1, worstMin: 20 });
    assert.deepEqual(r.queue, { waiting: 1, active: 0, oldestWaitingMin: 20 });
    assert.deepEqual(r.durations, [
      { kind: 'Shopping check', count: 3, medianSec: 180, p95Sec: 180, avgSec: 160 },
      { kind: 'Full check', count: 1, medianSec: 360, p95Sec: 360, avgSec: 360 },
      { kind: 'Free website check', count: 1, medianSec: 60, p95Sec: 60, avgSec: 60 },
    ]);
    assert.ok(r.machine.memTotalMb > 0 && r.machine.rssMb > 0 && r.machine.memUsedPct >= 0);
    assert.ok(r.machine.diskTotalGb > 0 && r.machine.diskFreeGb >= 0);
    db.prepare('DELETE FROM runs WHERE id = ?').run(waiting);
    note(t, `today ${today.total} browser min (${JSON.stringify(today.byPlan)}), peak 2 of 2 slots; late starts median ${r.lateStarts.medianMin} / p95 ${r.lateStarts.p95Min} min, ${r.lateStarts.overLimit} over 10 min; durations ${r.durations.map((d) => `${d.kind} ${d.medianSec}s`).join(', ')}`);
  });

  it('a late start emails the founder once, not again while it lasts, and not again within 6 hours', async (t) => {
    mail.length = 0;
    let sent = await checkCapacityAlerts({ now: NOW, queue: { waiting: 0, active: 0 } });
    assert.deepEqual(sent.map((s) => s.kind), ['late']);
    assert.equal(mail.length, 1);
    assert.equal(mail[0].to, 'founder@tharam.test');
    assert.equal(mail[0].subject, '[capacity] Scheduled checks are starting late');
    assert.match(mail[0].text, /^1 scheduled check started more than 10 minutes late in the last hour\. The longest wait was 15 minutes\./);
    assert.match(mail[0].text, /Time to add a worker/);
    assert.match(mail[0].text, /http:\/\/tharam\.test\/app#\/admin\/capacity/);

    // Five and thirty minutes later it is still going: nothing more.
    assert.equal((await checkCapacityAlerts({ now: NOW + 5 * MIN })).length, 0);
    assert.equal((await checkCapacityAlerts({ now: NOW + 30 * MIN })).length, 0);
    assert.equal(mail.length, 1);
    // An hour later it has cleared; it comes back after 75 minutes, but the last email was under 6 hours ago.
    assert.equal((await checkCapacityAlerts({ now: NOW + 70 * MIN })).length, 0);
    assert.equal(db.prepare("SELECT active FROM capacity_alerts WHERE kind = 'late'").get().active, 0);
    run({ store: storeA, created: 60, due: 60, started: 75, finished: 77 });
    assert.equal((await checkCapacityAlerts({ now: NOW + 80 * MIN })).length, 0);
    assert.equal(db.prepare("SELECT active FROM capacity_alerts WHERE kind = 'late'").get().active, 1);
    assert.equal(mail.length, 1);
    // Seven hours on, cleared and back again: a new email.
    assert.equal((await checkCapacityAlerts({ now: NOW + 6 * 60 * MIN })).length, 0);
    run({ store: storeA, created: 420, due: 420, started: 440, finished: 442 });
    sent = await checkCapacityAlerts({ now: NOW + 445 * MIN });
    assert.deepEqual(sent.map((s) => s.kind), ['late']);
    assert.equal(mail.length, 2);
    assert.match(mail[1].text, /longest wait was 20 minutes/);
    note(t, `one email “${mail[0].subject}”; none at +5, +30, +70, +80 min; a second only at +7 h 25 min`);
  });

  it('slots more than 60% busy for an hour email the founder once', async (t) => {
    mail.length = 0;
    const later = NOW + 1440 * MIN; // a day later, with both slots busy for the last 70 minutes
    run({ store: storeA, trigger: 'manual', created: 1440 - 70, started: 1440 - 70, finished: 1440 - 1 });
    run({ store: storeB, trigger: 'manual', kind: 'full', created: 1440 - 70, started: 1440 - 70, finished: 1440 - 1 });
    const r = capacityReport({ now: later });
    assert.equal(r.slotUse.lastHourPct, 98);
    const sent = await checkCapacityAlerts({ now: later, queue: { waiting: 3, active: 2 } });
    assert.deepEqual(sent.map((s) => s.kind), ['busy']);
    assert.equal(mail.length, 1);
    assert.equal(mail[0].subject, '[capacity] Check slots 98% busy for the last hour');
    assert.match(mail[0].text, /On average 98% of the 2 check slots were in use over the last hour \(alert above 60%\)/);
    assert.match(mail[0].text, /Right now: 2 of 2 busy, 3 waiting/);
    assert.equal((await checkCapacityAlerts({ now: later + 5 * MIN })).length, 0, 'still 90% busy: not sent again');
    assert.equal(mail.length, 1);
    // A quiet hour (under 60%) clears it without an email.
    assert.equal((await checkCapacityAlerts({ now: later + 120 * MIN })).length, 0);
    assert.equal(db.prepare("SELECT active FROM capacity_alerts WHERE kind = 'busy'").get().active, 0);
    note(t, `“${mail[0].subject}” once; not repeated 5 minutes later; cleared quietly after a quiet hour`);
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

describe('Capacity page in the founder console', () => {
  let P, founder, owner, storeId, browser, done;
  before(async () => {
    P = await startProduct();
    founder = await founderSession(P);
    owner = await signup(P, 'capacity-owner@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    done = await runAndWait(owner, storeId, { kind: 'journeys' }, 280000);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('a check records when it got a browser, separately from when it was queued', (t) => {
    assert.equal(done.status, 'done', done.error || '');
    const r = P.db().prepare('SELECT created_at, started_at, finished_at, due_at FROM runs WHERE id = ?').get(done.id);
    assert.ok(r.started_at, 'started_at is set');
    assert.ok(r.started_at >= r.created_at && r.finished_at >= r.started_at, JSON.stringify(r));
    assert.equal(r.due_at, null, 'only scheduled checks have a due time');
    note(t, `queued ${r.created_at}, browser from ${r.started_at} to ${r.finished_at}`);
  });

  it('the founder sees the numbers; the real check shows up under its plan', async (t) => {
    const r = await founder.get('/api/admin/capacity');
    assert.equal(r.status, 200);
    const d = r.json;
    assert.equal(d.slots, 2);
    assert.equal(d.browserMinutes.days[0].checks, 1);
    assert.ok(d.browserMinutes.total > 0);
    assert.deepEqual(d.browserMinutes.plans.length, 1);
    assert.equal(d.durations[0].kind, 'Shopping check');
    assert.equal(d.durations[0].count, 1);
    assert.deepEqual(d.queue, { waiting: 0, active: 0, oldestWaitingMin: null });
    assert.equal((await founder.get('/api/admin/capacity?days=30')).json.browserMinutes.days.length, 30);
    assert.equal((await founder.get('/api/admin/capacity?days=999')).json.browserMinutes.days.length, 30);
    note(t, `plan “${d.browserMinutes.plans[0]}”: ${d.browserMinutes.total} browser min, shopping check took ${d.durations[0].medianSec}s`);
  });

  it('customers and signed-out visitors are refused', async (t) => {
    assert.equal((await owner.get('/api/admin/capacity')).status, 403);
    assert.equal((await P.session().get('/api/admin/capacity')).status, 401);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addCookies(owner.browserCookies());
    const page = await ctx.newPage();
    await page.goto(`${P.base}/app#/admin/capacity`);
    await page.waitForTimeout(1500);
    assert.equal(await page.getByText('Founder console').count(), 0);
    assert.equal(await page.locator('#cap-minutes').count(), 0);
    await ctx.close();
    note(t, 'website customer: 403; signed out: 401; the console page sends customers home');
  });

  it('Capacity page: verdict, slots, late starts, browser minutes, durations and the machine', async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(founder.browserCookies());
    const page = await ctx.newPage();
    await page.goto(`${P.base}/app#/admin/capacity`);
    await page.locator('#cap-minutes').waitFor();
    for (const text of ['Capacity is fine', 'Check slots in use now', 'Scheduled checks: how late they start', 'Browser minutes per day, by plan', 'How long checks take', 'This machine', 'Shopping check']) {
      assert.ok(await page.getByText(text).first().isVisible(), text);
    }
    assert.equal(await page.locator('#cap-minutes tbody tr').count(), 7);
    await screenshot(t, page, 'Capacity page', { fullPage: true });
    await ctx.close();
  });
});
