// Licensing, plans and plan limits: what each account may use is decided on the server, from its licence.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, founderSession } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const DAY = 864e5;
/** A licence date `days` from now, in the format the founder console uses. */
const at = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 19).replace('T', ' ');
const ms = (s) => new Date(s.replace(' ', 'T') + 'Z').getTime();

describe('Licensing, plans and plan limits', () => {
  let P, F, browser;
  before(async () => {
    P = await startProduct();
    F = await founderSession(P);
  });
  after(async () => { await browser?.close(); await P.stop(); });

  /** The account id of a customer, from the founder console. */
  async function uidOf(s) {
    const r = await F.get(`/api/admin/customers?q=${encodeURIComponent(s.email)}`);
    assert.equal(r.status, 200, r.text);
    const c = r.json.customers.find((x) => x.email === s.email);
    assert.ok(c, `customer ${s.email} not listed`);
    return c.id;
  }
  async function setLicense(s, body) {
    const r = await F.patch(`/api/admin/customers/${await uidOf(s)}/license`, body);
    assert.equal(r.status, 200, r.text);
    return r.json.view;
  }
  const license = async (s) => (await s.get('/api/me')).json.license;
  /** A second address for the same mock store, so an account can have more than one store. */
  const otherUrl = () => P.mock.origin.replace('localhost', '127.0.0.1');
  async function waitDone(s, runId) {
    // A stopped run must end within seconds, even when it is stopped while the browser is still starting.
    for (let i = 0; i < 60; i++) {
      const g = await s.get(`/api/runs/${runId}`);
      if (['done', 'error', 'cancelled'].includes(g.json?.status)) return g.json;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`run ${runId} did not stop within 30 seconds: ${JSON.stringify((await s.get(`/api/runs/${runId}`)).json).slice(0, 400)}`);
  }

  describe('States', () => {
    it('new accounts start on the signup plan: beta by default, a 14-day trial when the founder chooses it', async (t) => {
      const beta = await signup(P);
      const b = await license(beta);
      assert.equal(b.plan.key, 'beta');
      assert.equal(b.state, 'active');
      assert.equal(b.expires_at, null, 'beta has no end date');

      assert.equal((await F.patch('/api/admin/settings', { signup_plan: 'trial', trial_days: 14 })).status, 200);
      try {
        const trial = await signup(P);
        const l = await license(trial);
        assert.equal(l.plan.key, 'trial');
        assert.equal(l.state, 'trial');
        assert.equal(l.usable, true);
        assert.equal(l.daysLeft, 14);
        assert.ok(l.features.includes('visual') && l.features.includes('environments'), 'a trial includes everything in Pro');
        note(t, `beta: active, no end date. trial: ${l.daysLeft} days left, ${l.features.length} features`);
      } finally {
        assert.equal((await F.patch('/api/admin/settings', { signup_plan: 'beta' })).status, 200);
      }
      // Paid plans can't be the signup plan.
      assert.equal((await F.patch('/api/admin/settings', { signup_plan: 'pro' })).status, 400);
    });

    it('a trial that has ended stops checks straight away, with no grace days', async (t) => {
      const s = await signup(P);
      const storeId = await addStore(P, s, { runNow: false });
      await setLicense(s, { plan_key: 'trial', seats: 1, status: 'trial', expires_at: at(-1) });
      const l = await license(s);
      assert.equal(l.state, 'expired');
      assert.equal(l.usable, false);
      const run = await s.post(`/api/stores/${storeId}/run`, {});
      assert.equal(run.status, 403);
      assert.match(run.json.error, /free trial has ended/);
      assert.equal(run.json.upgrade, true);
      const add = await s.post('/api/stores', { url: otherUrl(), name: 'Second' });
      assert.equal(add.status, 403, 'no new stores on an ended trial');
      note(t, `trial ended yesterday → ${l.state}; run refused: "${run.json.error}"`);
    });

    it('a paid plan past its end date keeps working for the grace days, then stops', async (t) => {
      const s = await signup(P);
      const storeId = await addStore(P, s, { runNow: false });
      await setLicense(s, { plan_key: 'starter', seats: 1, status: 'active', expires_at: at(-3) });
      let l = await license(s);
      assert.equal(l.state, 'grace');
      assert.equal(l.usable, true);
      assert.ok(l.graceEnds && ms(l.graceEnds) > Date.now(), 'grace ends in the future');
      assert.ok(Math.abs(ms(l.graceEnds) - (ms(l.expires_at) + 7 * DAY)) < 2000, 'grace lasts 7 days by default');
      assert.equal((await s.get(`/api/stores/${storeId}`)).json.store.blocked, null, 'store is still checked in grace');

      await setLicense(s, { expires_at: at(-8) });
      l = await license(s);
      assert.equal(l.state, 'expired');
      const run = await s.post(`/api/stores/${storeId}/run`, {});
      assert.equal(run.status, 403);
      assert.match(run.json.error, /plan has expired/);
      assert.match((await s.get(`/api/stores/${storeId}`)).json.store.blocked, /plan has expired/);

      // A licence's own grace days win over the setting.
      await setLicense(s, { expires_at: at(-8), grace_days: 10 });
      assert.equal((await license(s)).state, 'grace');
      await setLicense(s, { expires_at: at(-1), grace_days: 0 });
      assert.equal((await license(s)).state, 'expired');
      note(t, '3 days late → grace; 8 days late → expired; licence grace 10 → grace again; grace 0 → expired the day after');
    });

    it('suspended and cancelled accounts can\'t run checks or add stores', async (t) => {
      const s = await signup(P);
      const storeId = await addStore(P, s, { runNow: false });
      for (const [status, words] of [['suspended', /account is paused/], ['cancelled', /plan has ended/]]) {
        await setLicense(s, { status });
        const l = await license(s);
        assert.equal(l.state, status);
        assert.equal(l.usable, false);
        const run = await s.post(`/api/stores/${storeId}/run`, {});
        assert.equal(run.status, 403);
        assert.match(run.json.error, words);
        assert.equal((await s.post('/api/stores', { url: otherUrl() })).status, 403);
        note(t, `${status}: run refused "${run.json.error}"`);
      }
      // Only basic shopping checks are listed as features while not usable; nothing else.
      assert.deepEqual((await license(s)).features, ['journeys']);
    });
  });

  describe('Plan limits', () => {
    it('the store limit: a plan covers as many stores as were paid for', async (t) => {
      const s = await signup(P);
      await setLicense(s, { plan_key: 'starter', seats: 1 });
      const first = await addStore(P, s, { runNow: false });
      const refused = await s.post('/api/stores', { url: otherUrl(), name: 'Second' });
      assert.equal(refused.status, 403);
      assert.match(refused.json.error, /covers 1 store/);

      await setLicense(s, { seats: 2 });
      const second = await s.post('/api/stores', { url: otherUrl(), name: 'Second' });
      assert.equal(second.status, 200, second.text);
      const secondId = second.json.id;

      // Back down to one store: the newest store is no longer checked, the first one still is.
      await setLicense(s, { seats: 1 });
      assert.equal((await s.get(`/api/stores/${first}`)).json.store.blocked, null);
      const run = await s.post(`/api/stores/${secondId}/run`, {});
      assert.equal(run.status, 403);
      assert.match(run.json.error, /Your plan covers 1 store/);
      note(t, `1 seat: second store refused; 2 seats: added; back to 1: second store blocked "${run.json.error}"`);
    });

    it('a plan with its own store cap refuses more seats than it allows', async () => {
      const s = await signup(P);
      const r = await F.patch(`/api/admin/customers/${await uidOf(s)}/license`, { plan_key: 'beta', seats: 6 });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /Beta allows up to 5 stores/);
    });

    it('the environment limit after a downgrade: only the first environments stay covered', async (t) => {
      const s = await signup(P);
      await setLicense(s, { plan_key: 'pro', seats: 1 });
      const storeId = await addStore(P, s, { runNow: false });
      const envs = [];
      for (const n of [1, 2]) {
        const r = await s.post(`/api/stores/${storeId}/environments`, { name: `Draft ${n}`, kind: 'theme', url: `${P.mock.origin}/?preview_theme_id=${n}` });
        assert.equal(r.status, 200, r.text);
        envs.push(r.json.environment?.id ?? r.json.id);
      }
      assert.ok(envs.every(Boolean), 'environment ids returned');

      const small = await F.post('/api/admin/plans', { key: 'one-env', name: 'One environment', kind: 'paid', prices: { USD: { month: 2900 } },
        features: ['journeys', 'publish', 'environments'], limits: { environments: 1 }, public: false });
      assert.equal(small.status, 200, small.text);
      await setLicense(s, { plan_key: 'one-env' });

      const third = await s.post(`/api/stores/${storeId}/environments`, { name: 'Draft 3', kind: 'theme', url: `${P.mock.origin}/?preview_theme_id=3` });
      assert.equal(third.status, 403);
      assert.match(third.json.error, /allows 1 environment/);
      const rel = await s.post(`/api/stores/${storeId}/releases`, { environmentId: envs[1] });
      assert.equal(rel.status, 403);
      assert.match(rel.json.error, /covers 1 environment per store/);
      assert.equal((await s.get(`/api/stores/${storeId}/environments`)).json.environments.length, 2, 'nothing is deleted on a downgrade');

      // A plan without environments at all names the plans that have them.
      await setLicense(s, { plan_key: 'starter' });
      const none = await s.post(`/api/stores/${storeId}/environments`, { name: 'Draft 4', kind: 'theme', url: `${P.mock.origin}/?preview_theme_id=4` });
      assert.equal(none.status, 403);
      assert.match(none.json.error, /Growth and Pro/);
      note(t, `Pro: 2 environments saved. One-env plan: 3rd refused, 2nd can't be checked. Starter: "${none.json.error}"`);
    });

    it('manual runs per day: a plan\'s daily limit is enforced per store', async (t) => {
      const plan = await F.post('/api/admin/plans', { key: 'one-run', name: 'One run a day', kind: 'paid', prices: { USD: { month: 900 } },
        features: ['journeys'], limits: { manualRunsPerDay: 1 }, public: false });
      assert.equal(plan.status, 200, plan.text);
      assert.equal(plan.json.plan.limits.manualRunsPerDay, 1);
      const s = await signup(P);
      await setLicense(s, { plan_key: 'one-run', seats: 1 });
      const storeId = await addStore(P, s, { runNow: false });
      const first = await s.post(`/api/stores/${storeId}/run`, { kind: 'journeys' });
      assert.equal(first.status, 200, first.text);
      const c = await s.post(`/api/stores/${storeId}/run/${first.json.runId}/cancel`);
      assert.equal(c.status, 200, c.text);
      assert.equal((await waitDone(s, first.json.runId)).status, 'cancelled', 'a run stopped right after it starts ends at once');
      const second = await s.post(`/api/stores/${storeId}/run`, { kind: 'journeys' });
      assert.equal(second.status, 429);
      assert.match(second.json.error, /most your plan allows/);
      note(t, `limit 1/day: first run started, second refused "${second.json.error}"`);
    });

    it('locked check groups are switched off by the server, whatever the browser asks for', async (t) => {
      const s = await signup(P);
      await setLicense(s, { plan_key: 'starter', seats: 1 });
      const storeId = await addStore(P, s, { runNow: false });
      const groups = (await s.get('/api/catalog')).json.groups.map((g) => g.key);
      assert.ok(groups.includes('catalog') && groups.includes('visual'));
      const r = await s.post(`/api/stores/${storeId}/run`, { groups });
      assert.equal(r.status, 200, r.text);
      const g = (await s.get(`/api/runs/${r.json.runId}`)).json;
      const skipped = g.live?.disabled ?? g.result?.skippedGroups;
      assert.ok(Array.isArray(skipped), 'run shows what it skips');
      for (const k of ['catalog', 'visual', 'ai.visual', 'law.de']) assert.ok(skipped.includes(k), `${k} must be skipped on Starter`);
      for (const k of ['journey.core', 'speed']) assert.ok(!skipped.includes(k), `${k} is included in Starter`);
      await s.post(`/api/stores/${storeId}/run/${r.json.runId}/cancel`);
      await waitDone(s, r.json.runId);

      // Settings beyond the plan are refused too.
      const often = await s.patch(`/api/stores/${storeId}`, { config: { journeyIntervalMin: 60 } });
      assert.equal(often.status, 403);
      const slack = await s.patch(`/api/stores/${storeId}`, { slack: 'https://hooks.slack.com/services/T/B/x' });
      assert.equal(slack.status, 403);
      assert.match(slack.json.error, /Slack alerts/);
      const rel = await s.post(`/api/stores/${storeId}/releases`, {});
      assert.equal(rel.status, 403);
      assert.match(rel.json.error, /Safe to publish/);
      note(t, `Starter asked for all ${groups.length} groups; server skipped ${skipped.length}: ${skipped.join(', ')}`);
    });
  });

  describe('Founder licence changes and payments', () => {
    it('licence edits are validated, and a refused edit changes nothing', async (t) => {
      const s = await signup(P);
      const uid = await uidOf(s);
      const before = (await F.get(`/api/admin/customers/${uid}`)).json.license;
      const bad = [
        [{ expires_at: '2027-02-31' }, /Expiry must be a date/],
        [{ expires_at: 'next tuesday' }, /Expiry must be a date/],
        [{ seats: 0 }, /whole number from 1 to 1000/],
        [{ seats: 2.5 }, /whole number from 1 to 1000/],
        [{ plan_key: 'platinum' }, /Unknown plan/],
        [{ status: 'deleted' }, /Unknown status/],
        [{ grace_days: 91 }, /Grace days must be 0 to 90/],
        [{ currency: 'XYZ' }, /Unknown currency/],
        [{ price_override: -1 }, /zero or more/],
      ];
      for (const [body, msg] of bad) {
        const r = await F.patch(`/api/admin/customers/${uid}/license`, body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match(r.json.error, msg);
      }
      const after = (await F.get(`/api/admin/customers/${uid}`)).json.license;
      for (const k of ['plan_key', 'seats', 'status', 'expires_at', 'grace_days', 'currency', 'price_override']) assert.equal(after[k], before[k], k);
      note(t, `${bad.length} bad edits refused; licence unchanged`);
    });

    it('a licence change is written to the audit trail with before and after; repeating it writes nothing', async (t) => {
      const s = await signup(P);
      const uid = await uidOf(s);
      const change = { plan_key: 'growth', seats: 3, expires_at: '2027-01-31' };
      const v = await setLicense(s, change);
      assert.equal(v.plan.key, 'growth');
      assert.equal(v.seats, 3);
      assert.equal(v.expires_at, '2027-01-31 23:59:59', 'a date means the end of that day');
      const audit = (await F.get(`/api/admin/customers/${uid}`)).json.audit;
      const upd = audit.filter((a) => a.action === 'license.update');
      assert.equal(upd.length, 1);
      const d = JSON.parse(upd[0].detail_json);
      assert.deepEqual(d.plan_key, { before: 'beta', after: 'growth' });
      assert.deepEqual(d.seats, { before: 5, after: 3 });
      assert.equal(upd[0].actor, F.email);
      await setLicense(s, change);
      assert.equal((await F.get(`/api/admin/customers/${uid}`)).json.audit.filter((a) => a.action === 'license.update').length, 1, 'no-op edit is not audited');
      // Customers can't change licences.
      assert.equal((await s.patch(`/api/admin/customers/${uid}/license`, { plan_key: 'pro' })).status, 403);
      assert.equal((await license(s)).plan.key, 'growth');
      note(t, `audit: ${Object.keys(d).join(', ')} with before/after, by ${upd[0].actor}`);
    });

    it('recording payments: plan and stores stated, duplicates caught, time added from the right date', async (t) => {
      const s = await signup(P);
      const uid = await uidOf(s);
      const pay = (body) => F.post(`/api/admin/customers/${uid}/payments`, { currency: 'USD', method: 'bank', sendReceipt: false, ...body });

      // From a free plan the number of stores paid for must be stated, and only paid plans take payments.
      let r = await pay({ amount: 3800, plan_key: 'starter' });
      assert.equal(r.status, 400); assert.match(r.json.error, /how many stores/);
      r = await pay({ amount: 3800, plan_key: 'beta', seats: 2 });
      assert.equal(r.status, 400); assert.match(r.json.error, /paid plans/);
      r = await pay({ amount: '', plan_key: 'starter', seats: 2 });
      assert.equal(r.status, 400); assert.match(r.json.error, /amount/);
      r = await pay({ amount: 0, plan_key: 'starter', seats: 2 });
      assert.equal(r.status, 400); assert.match(r.json.error, /zero payment needs a note/);
      r = await pay({ amount: 3800, plan_key: 'starter', seats: 2, periods: 37 });
      assert.equal(r.status, 400);

      r = await pay({ amount: 3800, plan_key: 'starter', seats: 2, reference: 'utr 0001 abc' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.view.plan.key, 'starter');
      assert.equal(r.json.view.seats, 2, 'beta seats are not carried into the paid plan');
      assert.equal(r.json.view.state, 'active');
      assert.equal(r.json.payment.reference, 'UTR0001ABC');
      const firstEnd = r.json.view.expires_at;
      const days = (ms(firstEnd) - Date.now()) / DAY;
      assert.ok(days > 27 && days < 32, `one month paid, got ${days.toFixed(1)} days`);

      // One bank reference is one payment, whatever the spacing or case.
      r = await pay({ amount: 3800, reference: 'UTR0001abc', method: 'upi' });
      assert.equal(r.status, 400); assert.match(r.json.error, /already recorded/);
      // The same amount again within minutes, without a reference, looks like a double click.
      r = await pay({ amount: 3800 });
      assert.equal(r.status, 400); assert.match(r.json.error, /few minutes ago/);
      r = await pay({ amount: 3800, confirmDuplicate: true });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.payment.covers_from, firstEnd, 'a renewal continues from the current end date');
      const extra = (ms(r.json.view.expires_at) - ms(firstEnd)) / DAY;
      assert.ok(extra >= 28 && extra <= 31, `renewal adds a month, got ${extra}`);

      // Paying during grace continues from the old end date: no free days.
      const graceEnd = at(-3);
      await setLicense(s, { expires_at: graceEnd });
      assert.equal((await license(s)).state, 'grace');
      r = await pay({ amount: 3800, reference: 'GRACE-1' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.payment.covers_from, graceEnd);

      // After the grace period has run out, paid time starts today.
      await setLicense(s, { expires_at: at(-30) });
      assert.equal((await license(s)).state, 'expired');
      r = await pay({ amount: 3800, reference: 'LAPSED-1' });
      assert.equal(r.status, 200, r.text);
      assert.ok(Math.abs(ms(r.json.payment.covers_from) - Date.now()) < 120000, 'starts now');
      assert.equal(r.json.view.state, 'active');

      // A payment turns a paused account back on.
      await setLicense(s, { status: 'suspended' });
      r = await pay({ amount: 3800, reference: 'BACK-ON' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.view.state, 'active');

      // The customer sees their payments, without the founder's internal fields.
      const bill = await s.get('/api/account/billing');
      assert.equal(bill.status, 200);
      assert.equal(bill.json.payments.length, 5);
      assert.equal(bill.json.payments[0].recorded_by, undefined);
      assert.equal(bill.json.payments[0].note, undefined);
      assert.equal((await s.post(`/api/admin/customers/${uid}/payments`, { amount: 1, plan_key: 'starter', seats: 1 })).status, 403, 'customers can\'t record payments');
      const audit = (await F.get(`/api/admin/customers/${uid}`)).json.audit.filter((a) => a.action === 'payment.record');
      assert.equal(audit.length, 5, 'every payment is audited');
      note(t, `5 payments recorded, 7 refused; first covers to ${firstEnd}; grace renewal from ${graceEnd}`);
    });

    it('the audit trail is append-only, even with direct database access', async (t) => {
      const s = await signup(P);
      await setLicense(s, { plan_key: 'growth', seats: 1 });
      const db = new Database(path.join(P.dataDir, 'guard.db'), { fileMustExist: true });
      db.pragma('busy_timeout = 5000');
      try {
        const last = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 1').get();
        assert.ok(last);
        assert.throws(() => db.prepare("UPDATE audit SET action = 'nothing' WHERE id = ?").run(last.id), /append-only/);
        assert.throws(() => db.prepare('DELETE FROM audit WHERE id = ?').run(last.id), /append-only/);
        assert.throws(() => db.prepare("INSERT OR REPLACE INTO audit (id, actor, action) VALUES (?, 'x', 'forged')").run(last.id), /append-only/);
        assert.equal(db.prepare('SELECT action FROM audit WHERE id = ?').get(last.id).action, last.action, 'row unchanged');
        note(t, `audit row ${last.id} (${last.action}): update, delete and replace all refused`);
      } finally { db.close(); }
    });
  });

  describe('On screen', () => {
    it('the plan banner tells the owner about grace, expiry and a paused account', async (t) => {
      browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
      const s = await signup(P, 'banner@licence.test');
      await addStore(P, s, { runNow: false });
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      await ctx.addCookies(s.browserCookies());
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      const show = async (label, words) => {
        await p.goto('about:blank'); // a fresh load, so the app reads the licence again
        await p.goto(`${P.base}/app#/account/billing`);
        await p.waitForSelector('#plan-banner.plan-banner', { timeout: 20000 });
        await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
        const text = await p.textContent('#plan-banner');
        assert.match(text, words);
        await screenshot(t, p, label);
        note(t, `${label}: "${text.trim()}"`);
      };
      await setLicense(s, { plan_key: 'starter', seats: 1, status: 'active', expires_at: at(-2) });
      await show('Plan in grace', /Checks continue until/);
      await setLicense(s, { expires_at: at(-20) });
      await show('Plan expired', /plan has expired/);
      await setLicense(s, { status: 'suspended' });
      await show('Account paused', /account is paused/);
      assert.deepEqual(errors, []);
      await ctx.close();
    });
  });
});
