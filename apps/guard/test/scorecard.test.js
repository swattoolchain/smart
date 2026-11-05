// Scorecard and home numbers: Buyability for a day, a week and a month; money at risk from daily sales;
// time to fix; homepage speed on phones from the latest check that measured it (never a publish preview);
// products needing fixes; changes checked before publishing. History is written straight into the
// product's database with known times, then read back through the API and the home screen.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const healthy = { verdict: 'healthy', checks: [] };

describe('Scorecard and home numbers', () => {
  let P, owner, storeId, sc, browser, w, ids = {};
  before(async () => {
    P = await startProduct();
    owner = await signup(P, 'scorecard@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    await owner.patch(`/api/stores/${storeId}`, { config: { dailySales: 24000, currency: 'INR' } });
    // One real check first, so home has a latest report to show.
    const real = await runAndWait(owner, storeId, { kind: 'journeys' }, 280000);
    assert.equal(real.status, 'done', real.error || '');
    assert.notEqual(real.verdict, 'critical');
    ids.real = real.id;

    w = new Database(path.join(P.dataDir, 'guard.db'));
    w.pragma('busy_timeout = 5000');
    const run = w.prepare(`INSERT INTO runs (store_id, url, kind, status, verdict, score, result_json, trigger, created_at)
      VALUES (?, ?, ?, ?, ?, 90, ?, ?, datetime('now', ?))`);
    const add = (when, verdict = 'healthy', { kind = 'journeys', status = 'done', trigger = 'schedule', result = null } = {}) =>
      Number(run.run(storeId, P.mock.origin, kind, status, verdict, JSON.stringify(result || { ...healthy, verdict }), trigger, when).lastInsertRowid);

    // Today (minutes ago, so they stay on today's date whenever this runs): the real check, 3 good and 2 where
    // customers could not buy, plus the full and journey checks below → 6 of 8 = 75%.
    add('-1 minutes'); add('-2 minutes'); add('-3 minutes'); add('-4 minutes', 'critical'); add('-6 minutes', 'critical');
    // Rest of the week: 11 good checks plus the older full check below → 18 of 20 = 90%.
    for (const d of [2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 6]) add(`-${d} days`);
    // Rest of the month: 20 good checks → 38 of 40 = 95%.
    for (const d of [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 29]) add(`-${d} days`);
    // Never counted: older than 30 days, bot-protection and password pages, failed or stopped runs, publish previews.
    add('-40 days', 'critical'); add('-1 hours', 'blocked'); add('-1 hours', 'locked');
    add('-1 hours', 'critical', { status: 'error' }); add('-1 hours', 'critical', { status: 'cancelled' });
    add('-30 minutes', 'critical', { trigger: 'release' });

    // Speed and products: an older full check, then the latest full check, then a journey check (no speed),
    // then a publish preview of a slow draft. The scorecard must use the latest full check.
    const cat = (count, issues) => ({ ...healthy, catalog: { count, currency: 'INR', issues } });
    add('-3 days', 'healthy', { kind: 'full', result: { ...cat(10, [{ handle: 'x', severity: 'critical' }]), metrics: { home: { lcp: 5200, load: 6000 } } } });
    ids.full = add('-10 minutes', 'healthy', { kind: 'full', result: { ...cat(40, [
      { handle: 'kurta', severity: 'major' }, { handle: 'kurta', severity: 'major' }, { handle: 'diya', severity: 'critical' }, { handle: 'saree', severity: 'minor' },
    ]), metrics: { home: { lcp: 2300, load: 3100 } } } });
    add('-5 minutes', 'healthy', { result: healthy });
    ids.release = add('-2 minutes', 'healthy', { kind: 'full', trigger: 'release', result: { ...cat(40, []), metrics: { home: { lcp: 9000, load: 9500 } } } });

    // Buying problems: add to cart broken for 90 minutes, checkout for 30 minutes, cart still broken for 2 hours.
    const alert = w.prepare("INSERT INTO alerts (store_id, check_id, state, message, created_at) VALUES (?, ?, ?, 'x', datetime('now', ?))");
    alert.run(storeId, 'fn.checkout', 'failing', '-10 days'); alert.run(storeId, 'fn.checkout', 'recovered', '-10 days'); // moved to 30 minutes later just below
    w.prepare("UPDATE alerts SET created_at = datetime('now', '-10 days', '+30 minutes') WHERE store_id = ? AND check_id = 'fn.checkout' AND state = 'recovered'").run(storeId);
    alert.run(storeId, 'fn.atc', 'failing', '-3 days'); alert.run(storeId, 'fn.atc', 'recovered', '-3 days');
    w.prepare("UPDATE alerts SET created_at = datetime('now', '-3 days', '+90 minutes') WHERE store_id = ? AND check_id = 'fn.atc' AND state = 'recovered'").run(storeId);
    alert.run(storeId, 'fn.search', 'failing', '-1 days'); // not a buying check: doesn't count
    alert.run(storeId, 'fn.atc', 'failing', '-50 days'); alert.run(storeId, 'fn.atc', 'recovered', '-49 days'); // too old
    w.prepare("INSERT OR REPLACE INTO check_state (store_id, check_id, status, since) VALUES (?, 'fn.cart', 'failing', datetime('now', '-2 hours'))").run(storeId);

    // Publishing: three checked this month (one blocked, one to review, one safe); older and unfinished ones don't count.
    const rel = w.prepare("INSERT INTO releases (store_id, preview_url, status, verdict, created_at) VALUES (?, 'https://x/?preview_theme_id=1', ?, ?, datetime('now', ?))");
    rel.run(storeId, 'done', 'blocked', '-2 days'); rel.run(storeId, 'done', 'review', '-5 days'); rel.run(storeId, 'done', 'safe', '-20 days');
    rel.run(storeId, 'done', 'blocked', '-40 days'); rel.run(storeId, 'running', null, '-1 hours'); rel.run(storeId, 'error', null, '-1 hours');

    sc = (await owner.get(`/api/stores/${storeId}/scorecard`)).json;
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { try { w?.close(); } catch {} await browser?.close(); await P.stop(); });

  it('Buyability counts checks where customers could buy, for today, 7 days and 30 days', (t) => {
    assert.deepEqual(sc.buyability.day, { pct: 75, runs: 8 });
    assert.deepEqual(sc.buyability.week, { pct: 90, runs: 20 });
    assert.deepEqual(sc.buyability.month, { pct: 95, runs: 40 });
    note(t, `today ${sc.buyability.day.pct}%, 7 days ${sc.buyability.week.pct}%, 30 days ${sc.buyability.month.pct}% (blocked, locked, failed, stopped, preview and older checks left out)`);
  });

  it('the daily bars cover 30 days, with today at 75% and empty days left empty', () => {
    const d = sc.buyability.daily;
    assert.equal(d.length, 30);
    assert.equal(d.at(-1).day, new Date().toISOString().slice(0, 10));
    assert.equal(d.at(-1).pct, 75);
    assert.equal(d.at(-7).pct, 100, '6 days ago: three good checks');
    assert.equal(d.at(-8).pct, null, '7 days ago: no checks');
    assert.equal(d.at(-2).pct, null, 'yesterday: no checks');
  });

  it('time to fix is the typical time a buying problem stayed broken, with open problems counted', (t) => {
    // Fixed in 30 and 90 minutes; the cart is still broken.
    assert.equal(sc.timeToFix.medianMinutes, 30);
    assert.equal(sc.timeToFix.incidents, 3);
    assert.equal(sc.timeToFix.open, 1);
    note(t, `typical ${sc.timeToFix.medianMinutes} min over ${sc.timeToFix.incidents} incidents, ${sc.timeToFix.open} open`);
  });

  it('money at risk = hours customers could not buy × daily sales / 24', (t) => {
    const r = sc.revenueAtRisk;
    assert.equal(r.hours, 4, '1.5 h + 0.5 h + 2 h still open');
    assert.equal(r.dailySales, 24000);
    assert.equal(r.currency, 'INR');
    assert.ok(r.amount >= 4000 && r.amount <= 4010, `amount ${r.amount}`);
    note(t, `${r.hours} h × ₹24,000 / 24 = ₹${r.amount}`);
  });

  it('homepage speed comes from the latest check that measured it, never a publish preview', (t) => {
    assert.equal(sc.speed.ms, 2300, 'largest content shown after 2.3 s on the latest full check');
    assert.equal(sc.speed.run, ids.full);
    assert.notEqual(sc.speed.run, ids.release);
    note(t, `${sc.speed.ms} ms from run ${sc.speed.run} (the 9.0 s draft preview in run ${ids.release} is ignored)`);
  });

  it('products needing fixes come from the latest full check; minor issues don’t count', (t) => {
    assert.deepEqual(sc.catalog, { products: 40, withIssues: 2, pct: 95, currency: 'INR' });
    note(t, `${sc.catalog.withIssues} of ${sc.catalog.products} products need fixing (${sc.catalog.pct}% right)`);
  });

  it('changes checked counts finished publish checks of the last 30 days', () => {
    assert.deepEqual(sc.publishing, { checked: 3, caught: 1, reviewed: 1 });
  });

  it('home shows the same numbers', async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#/s/${storeId}`);
    await p.waitForSelector('.kpis', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    const tile = async (label) => (await p.locator('.kpi', { hasText: label }).first().textContent()).replace(/\s+/g, ' ');
    assert.match(await tile('Customers could buy'), /90%.*Today 75% · 30 days 95%/);
    assert.equal(await p.locator('.kpi.lead .sc-bars i').count(), 14);
    assert.match(await tile('Money at risk'), /₹4,0\d\d.*4 h when customers couldn’t buy/);
    assert.match(await tile('Homepage on phones'), /2\.3 s.*Fast/);
    assert.match(await tile('Products'), /2.*of 40 need fixing/);
    assert.match(await tile('Time to fix'), /30 min.*1 problem still open/);
    assert.match(await tile('Changes checked'), /3.*1 risky change caught/);
    assert.equal(await p.locator('.kpi', { hasText: 'Homepage on phones' }).getAttribute('href'), `#/s/${storeId}/reports/${ids.full}`, 'speed tile opens the report it came from');
    await screenshot(t, p, 'Home numbers');
    assert.deepEqual(errors, []);
    note(t, (await p.locator('.kpi').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim()).join(' | '));
  });

  it('another account cannot read the scorecard', async () => {
    const other = await signup(P, 'scorecard-other@shop.test');
    const r = await other.get(`/api/stores/${storeId}/scorecard`);
    assert.ok([403, 404].includes(r.status), `got ${r.status}`);
  });
});

describe('Scorecard for a new store', () => {
  let P;
  before(async () => { P = await startProduct(); });
  after(async () => { await P.stop(); });

  it('has no numbers yet, instead of made-up ones', async (t) => {
    const owner = await signup(P, 'scorecard-new@shop.test');
    const id = await addStore(P, owner, { runNow: false });
    const sc = (await owner.get(`/api/stores/${id}/scorecard`)).json;
    assert.deepEqual(sc.buyability.week, { pct: null, runs: 0 });
    assert.ok(sc.buyability.daily.every((d) => d.pct === null));
    assert.deepEqual(sc.timeToFix, { medianMinutes: null, incidents: 0, open: 0 });
    assert.deepEqual(sc.revenueAtRisk, { hours: 0, amount: null, dailySales: null, currency: null });
    assert.equal(sc.catalog, null);
    assert.equal(sc.speed, null);
    assert.deepEqual(sc.publishing, { checked: 0, caught: 0, reviewed: 0 });
    note(t, 'all empty until checks run');
  });
});
