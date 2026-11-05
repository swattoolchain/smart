// Sale rehearsal, part 3: the end check (is everything back to normal after the sale?) and the sale calendar
// (big sale days by market, suggested 3 weeks ahead, plus the owner's own days).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';
import { utcToZoned, endPrices, endCheckDue } from '../src/sale-math.js';
import { upcomingDays, nthWeekday, easter, cleanDay, SALE_DAYS } from '../src/sale-calendar.js';

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const TZ = 'Asia/Kolkata';
const local = (ms) => utcToZoned(ms, TZ);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

describe('Sale end and calendar (no server)', () => {
  it('after the sale: prices back, still at the sale price, or changed', (t) => {
    const row = (variant, normal, expected, shown, state = 'ok') => ({ product: 'Kurta', handle: 'kurta', variant, normal, expected, shown, state });
    const r = endPrices({ rows: [row('S', 1000, 800, 1000, 'normal'), row('M', 1000, 800, 800), row('L', 1000, 800, 900, 'wrong'), row('XL', 1000, 800, 800, 'soldout'), row('XXL', 1000, 800, 999.5, 'normal')] });
    assert.deepEqual(r.rows.map((x) => x.state), ['back', 'still', 'changed', 'soldout', 'back']);
    assert.deepEqual([r.counts.back, r.counts.still, r.counts.changed], [2, 1, 1]);
    note(t, JSON.stringify(r.counts));
  });

  it('end checks: right after the end, then every 2 hours only while something is still on, 3 at most', () => {
    const now = Date.now();
    assert.equal(endCheckDue({ count: 0 }, now), true);
    assert.equal(endCheckDue({ count: 1, lastAt: now - 30 * MIN, lastVerdict: 'fail' }, now), false, 'too soon');
    assert.equal(endCheckDue({ count: 1, lastAt: now - 2 * HOUR, lastVerdict: 'fail' }, now), true);
    assert.equal(endCheckDue({ count: 1, lastAt: now - 5 * HOUR, lastVerdict: 'ok' }, now), false, 'ended cleanly: done');
    assert.equal(endCheckDue({ count: 1, lastAt: now - 5 * HOUR, lastVerdict: 'warn' }, now), false, 'only things to look at: no more checks');
    assert.equal(endCheckDue({ count: 3, lastAt: now - 5 * HOUR, lastVerdict: 'fail' }, now), false, 'at most 3');
  });

  it('works out the sale days: fixed dates, weekdays, Easter and moon tables', (t) => {
    assert.equal(isoDay(nthWeekday(2026, 11, 4, 4)), '2026-11-26', 'Thanksgiving 2026');
    assert.equal(isoDay(nthWeekday(2026, 5, 0, -1)), '2026-05-31', 'last Sunday of May');
    assert.equal(isoDay(easter(2026)), '2026-04-05');
    assert.equal(isoDay(easter(2027)), '2027-03-28');
    const at = (key, y) => isoDay(SALE_DAYS.find((d) => d.key === key).at(y));
    assert.equal(at('black-friday', 2026), '2026-11-27');
    assert.equal(at('cyber-monday', 2026), '2026-11-30');
    assert.equal(at('black-friday', 2027), '2027-11-26');
    assert.equal(at('buen-fin', 2026), '2026-11-13', 'Friday before the third Monday of November');
    assert.equal(at('mothering-sunday', 2026), '2026-03-08', 'the week before Mothering Sunday (15 March)');
    assert.equal(at('mothers-day', 2026), '2026-05-03', 'the week before 10 May');
    assert.equal(at('diwali', 2026), '2026-11-03', 'the days before Diwali (8 November)');
    assert.equal(SALE_DAYS.find((d) => d.key === 'diwali').at(2040), null, 'no guess beyond the moon table');
    note(t, `${SALE_DAYS.length} built-in sale days`);
  });

  it('suggests the days for the store’s markets 3 weeks ahead, unless a plan covers them', (t) => {
    const today = '2026-11-08';
    const t0 = Date.UTC(2026, 10, 8);
    const india = upcomingDays({ today, markets: ['IN'] });
    const keys = india.map((d) => d.key);
    assert.ok(keys.includes('diwali') && keys.includes('singles-day') && keys.includes('black-friday') && keys.includes('eoss-winter'));
    assert.ok(!keys.includes('boxing-day') && !keys.includes('buen-fin'), 'not for India');
    assert.equal(india.find((d) => d.key === 'diwali').daysUntil, -5, 'Diwali sales are on now');
    assert.ok(india.find((d) => d.key === 'singles-day').suggest, '3 days away');
    assert.ok(india.find((d) => d.key === 'black-friday').suggest, '19 days away');
    assert.ok(!india.find((d) => d.key === 'eoss-winter').suggest, '42 days away: too early');
    assert.ok(india.some((d) => d.key === 'valentines' && d.start === '2027-02-07'), 'next year’s days too');
    const uk = upcomingDays({ today, markets: ['UK'] });
    assert.ok(uk.some((d) => d.key === 'boxing-day'));
    const any = upcomingDays({ today, markets: [] });
    assert.ok(any.some((d) => d.key === 'buen-fin'), 'no markets chosen: every day');
    assert.equal(any.find((d) => d.key === 'buen-fin').suggest, false, '…but a Mexico-only day isn’t pushed to them');
    assert.equal(any.find((d) => d.key === 'singles-day').suggest, true);
    const covered = upcomingDays({ today, markets: ['IN'], plans: [{ startsAt: Date.UTC(2026, 10, 26, 18, 30), endsAt: Date.UTC(2026, 10, 30, 18, 30) }] });
    assert.equal(covered.find((d) => d.key === 'black-friday').covered, true);
    assert.equal(covered.find((d) => d.key === 'black-friday').suggest, false, 'already planned');
    const own = upcomingDays({ today, markets: ['IN'], custom: [{ id: 7, name: 'Anniversary', start_date: '2025-11-20', days: 3, every_year: 1 }, { id: 8, name: 'Old one', start_date: '2025-01-01', days: 1, every_year: 0 }], horizon: 400 });
    const ann = own.filter((d) => d.custom);
    assert.deepEqual(ann.map((d) => d.start), ['2026-11-20', '2027-11-20'], 'every year; a past one-off is left out');
    assert.ok(ann[0].suggest);
    for (let i = 1; i < india.length; i++) assert.ok(india[i - 1].start <= india[i].start, 'in date order');
    assert.equal(t0, new Date(today + 'T00:00:00Z').getTime());
    note(t, india.filter((d) => d.suggest).map((d) => `${d.name} in ${d.daysUntil} days`).join(' | '));
  });

  it('refuses own sale days that make no sense', () => {
    assert.throws(() => cleanDay({ name: '', date: '2026-12-01' }), /name/);
    assert.throws(() => cleanDay({ name: 'X', date: '2026-02-30' }), /date/);
    assert.throws(() => cleanDay({ name: 'X', date: '2026-12-01', days: 90 }), /between 1 and 60/);
    assert.deepEqual(cleanDay({ name: ' Anniversary ', date: '2026-12-01', days: '3', everyYear: true }), { name: 'Anniversary', date: '2026-12-01', days: 3, everyYear: true });
  });
});

describe('Sale end check and calendar in the product', () => {
  let P, owner, storeId, mallory, browser, planId;
  // The sale is on in the mock store from the start; GET /__sale?end=1 ends it properly.
  const sale = { at: 0, prices: { 101: 1199.2, 103: 1300, 201: 6999 }, soldOut: [102], banner: 'BLACK FRIDAY · 20% OFF', themeId: 333 };
  async function waitCheck(pid, id) {
    for (let i = 0; i < 240; i++) {
      const r = await owner.get(`/api/stores/${storeId}/sale-plans/${pid}/live-checks/${id}`);
      if (r.json?.status && r.json.status !== 'running') return r.json;
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error('check did not finish');
  }
  before(async () => {
    P = await startProduct({ mock: { sale } });
    owner = await signup(P, 'end-owner@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    mallory = await signup(P, 'end-mallory@shop.test');
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('a sale that just ended is checked; nothing to check before it starts', async (t) => {
    const start = Date.now() - 2 * DAY;
    const r = await owner.post(`/api/stores/${storeId}/sale-plans`, {
      name: 'Black Friday 2026', timeZone: TZ, startsLocal: local(start), endsLocal: local(Date.now() + DAY), markets: ['IN'],
      rules: [{ scope: 'tag', type: 'percent', value: 20, target: 'cotton' }, { scope: 'product', type: 'price', value: 6999, target: 'silk-saree' }],
      codes: [{ code: 'BF20', percent: 20 }, { code: 'FLASH50' }], themeId: '333', banner: 'Black Friday · 20% off',
    });
    assert.equal(r.status, 200, r.text);
    planId = r.json.plan.id;
    // The sale ended a few minutes ago.
    const ended = await owner.patch(`/api/stores/${storeId}/sale-plans/${planId}`, { endsLocal: local(Math.floor(Date.now() / MIN) * MIN - 5 * MIN) });
    assert.equal(ended.status, 200, ended.text);
    assert.equal(ended.json.plan.phase, 'ended');
    const live = await owner.get(`/api/stores/${storeId}/sale-plans/${planId}/live`);
    assert.equal(live.json.canCheckEnd, true);
    assert.equal(live.json.end, null);
    assert.equal(live.json.every, null, 'no more frequent checks after the end');
    note(t, `Plan ${planId} ended at ${ended.json.plan.endsLocal} ${TZ}`);
  });

  let first;
  it('still on after the sale: sale prices, code, banner and sale theme are reported, and the owner is emailed', async (t) => {
    const go = await owner.post(`/api/stores/${storeId}/sale-plans/${planId}/live-check`, {});
    assert.equal(go.status, 200, go.text);
    assert.equal(go.json.mode, 'end');
    first = await waitCheck(planId, go.json.id);
    assert.equal(first.status, 'done', JSON.stringify(first.summary || first.error));
    assert.equal(first.trigger, 'end-manual');
    assert.equal(first.summary.mode, 'end');
    const f = (key) => first.summary.findings.find((x) => x.key === key);
    assert.equal(f('end.prices').level, 'fail');
    assert.match(f('end.prices').title, /^2 prices still at the sale price/);
    assert.match(f('end.prices').detail, /Handwoven Silk Saree: 6999, normally 8999/);
    assert.equal(f('end.changed').level, 'warn');
    assert.match(f('end.changed').detail, /Large\): 1300, before the sale 1599/);
    assert.equal(f('end.code.bf20').level, 'fail');
    assert.match(f('end.code.bf20').title, /BF20 still works after the sale/);
    assert.equal(f('end.code.flash50').level, 'pass', 'a code that no longer works has stopped');
    assert.equal(f('end.banner').level, 'fail');
    assert.equal(f('end.theme').level, 'fail');
    assert.equal(first.verdict, 'fail');
    const mail = P.log();
    assert.match(mail, /Still on after Black Friday 2026 on Mock Store: /);
    assert.match(mail, /What to do: Publish your normal theme again/);
    assert.match(mail, /We check again in 2 hours/);
    note(t, first.summary.findings.map((x) => `${x.level}: ${x.title}`).join(' | '));
  });

  it('once the sale is ended properly: “ended cleanly” and the fixes are emailed', async (t) => {
    const r = await fetch(`${P.mock.origin}/__sale?end=1`).then((x) => x.json());
    assert.equal(r.ended, true);
    const go = await owner.post(`/api/stores/${storeId}/sale-plans/${planId}/live-check`, {});
    assert.equal(go.status, 200, go.text);
    const second = await waitCheck(planId, go.json.id);
    assert.equal(second.verdict, 'ok', second.summary.findings.map((x) => `${x.level}: ${x.title}`).join(' | '));
    const f = (key) => second.summary.findings.find((x) => x.key === key);
    assert.match(f('end.prices').title, /Prices are back to normal on 2 products/);
    assert.equal(f('end.theme').level, 'pass');
    assert.equal(f('end.banner').level, 'pass');
    assert.equal(f('end.code.bf20').level, 'pass');
    const mail = P.log();
    assert.match(mail, /Black Friday 2026 ended cleanly on Mock Store/);
    assert.match(mail, /Back to normal now:\n- Your sale theme is still live\n- The sale banner is still showing\n- 2 prices still at the sale price/);
    const live = await owner.get(`/api/stores/${storeId}/sale-plans/${planId}/live`);
    assert.equal(live.json.end.verdict, 'ok');
    assert.equal(live.json.endHistory.length, 2);
    note(t, second.summary.findings.map((x) => `${x.level}: ${x.title}`).join(' | '));
  });

  it('the calendar: built-in days, own days (suggested 3 weeks ahead), and covered by a plan', async (t) => {
    const cal = await owner.get(`/api/stores/${storeId}/sale-calendar`);
    assert.equal(cal.status, 200);
    assert.ok(cal.json.days.length >= 10, 'no markets chosen: every built-in day in the next year');
    assert.ok(cal.json.days.some((d) => d.key === 'black-friday'));
    const bad = await owner.post(`/api/stores/${storeId}/sale-calendar`, { name: 'Anniversary', date: 'soon' });
    assert.equal(bad.status, 400);
    const soon = isoDay(Date.now() + 10 * DAY);
    const add = await owner.post(`/api/stores/${storeId}/sale-calendar`, { name: 'Store anniversary', date: soon, days: 3, everyYear: true });
    assert.equal(add.status, 200, add.text);
    let mine = (await owner.get(`/api/stores/${storeId}/sale-calendar`)).json;
    const ann = mine.days.find((d) => d.id === add.json.id);
    assert.equal(ann.start, soon);
    assert.equal(ann.suggest, true);
    assert.ok(mine.suggestions.some((d) => d.id === add.json.id));
    // Plan it: then it's covered and no longer suggested.
    const plan = await owner.post(`/api/stores/${storeId}/sale-plans`, { name: 'Anniversary sale', timeZone: TZ, startsLocal: `${soon}T00:00`, endsLocal: `${isoDay(Date.now() + 13 * DAY)}T00:00` });
    assert.equal(plan.status, 200, plan.text);
    mine = (await owner.get(`/api/stores/${storeId}/sale-calendar`)).json;
    assert.equal(mine.days.find((d) => d.id === add.json.id).covered, true);
    await owner.del(`/api/stores/${storeId}/sale-plans/${plan.json.plan.id}`);
    note(t, `${cal.json.days.length} days in the next year; own day on ${soon} suggested, then covered`);
  });

  it('another account can’t see or change the calendar or check the end', async () => {
    const day = (await owner.get(`/api/stores/${storeId}/sale-calendar`)).json.days.find((d) => d.custom);
    for (const [m, u] of [['get', `/api/stores/${storeId}/sale-calendar`], ['post', `/api/stores/${storeId}/sale-calendar`], ['delete', `/api/stores/${storeId}/sale-calendar/${day.id}`], ['post', `/api/stores/${storeId}/sale-plans/${planId}/live-check`]]) {
      const r = m === 'get' ? await mallory.get(u) : m === 'delete' ? await mallory.del(u) : await mallory.post(u, { name: 'x', date: '2026-12-01' });
      assert.equal(r.status, 404, `${m} ${u}`);
    }
    const mstore = await addStore(P, mallory, { runNow: false });
    assert.equal((await mallory.del(`/api/stores/${mstore}/sale-calendar/${day.id}`)).status, 404, 'not through another store either');
    assert.ok((await owner.get(`/api/stores/${storeId}/sale-calendar`)).json.days.some((d) => d.id === day.id), 'still there');
  });

  async function page(viewport = { width: 1360, height: 900 }) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    p.errors = [];
    p.on('pageerror', (e) => p.errors.push(e.message));
    return p;
  }
  const quiet = (p) => p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));

  it('screens: the calendar with a suggestion, planning from it, and the end-of-sale report', async (t) => {
    const p = await page();
    await p.goto(`${P.base}/app#/s/${storeId}/sales`);
    await p.waitForSelector('#sale-cal');
    await quiet(p);
    const sug = p.locator('.sale-suggest', { hasText: 'Store anniversary' });
    assert.match(await sug.textContent(), /Store anniversary is in 10 days/);
    await screenshot(t, p, 'Sale plans with the sale calendar', { fullPage: true });
    await sug.locator('[data-plan-day]').click();
    await p.waitForSelector('#spf');
    assert.equal(await p.inputValue('#sp-name'), `Store anniversary ${isoDay(Date.now() + 10 * DAY).slice(0, 4)}`);
    assert.equal(await p.inputValue('#sp-start'), `${isoDay(Date.now() + 10 * DAY)}T00:00`);
    assert.equal(await p.inputValue('#sp-end'), `${isoDay(Date.now() + 13 * DAY)}T00:00`, 'three days, to midnight after the last');
    await quiet(p);
    await screenshot(t, p, 'New plan from the calendar');

    await p.goto(`${P.base}/app#/s/${storeId}/sales/${planId}`);
    await p.waitForSelector('#sale-end');
    await quiet(p);
    const txt = await p.textContent('.main-inner');
    assert.match(txt, /Sale ended cleanly/);
    assert.match(txt, /Prices are back to normal/);
    await screenshot(t, p, 'End-of-sale report', { fullPage: true });
    assert.deepEqual(p.errors, []);
    const m = await page({ width: 390, height: 844 });
    await m.goto(`${P.base}/app#/s/${storeId}/sales`);
    await m.waitForSelector('#sale-cal');
    await quiet(m);
    await screenshot(t, m, 'Sale calendar on a phone');
    assert.deepEqual(m.errors, []);
  });
});
