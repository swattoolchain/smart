// Sale rehearsal, part 2: the go-live burst. When a planned sale starts, the live store is checked every few
// minutes: sale theme live, banner, every product's sale price, codes in a real cart, and the shopping journey.
// The mock store's sale switches on by itself (MOCK_SALE, started here with GET /__sale), like a scheduled sale.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';
import { utcToZoned, burstEvery, burstDue, livePrices, baselineFrom, liveChanges, nearPrice } from '../src/sale-math.js';

const MIN = 60000, DAY = 86400000;
const TZ = 'Asia/Kolkata';
const local = (ms) => utcToZoned(ms, TZ);

describe('Go-live burst: schedule and prices (no server)', () => {
  it('checks every 5 minutes for the first hour, then every 15 minutes up to 7 hours; less often on smaller plans', (t) => {
    const s = Date.UTC(2026, 10, 26, 18, 30);
    const plan = { startsAt: s, endsAt: s + 3 * DAY };
    assert.equal(burstEvery(plan, s - MIN), null, 'not before the start');
    assert.equal(burstEvery(plan, s), 5);
    assert.equal(burstEvery(plan, s + 59 * MIN), 5);
    assert.equal(burstEvery(plan, s + 61 * MIN), 15);
    assert.equal(burstEvery(plan, s + 7 * 60 * MIN + 1), null, 'after 7 hours the usual checks carry on');
    assert.equal(burstEvery(plan, s + 30 * MIN, 'basic'), 15);
    assert.equal(burstEvery(plan, s + 2 * 60 * MIN, 'basic'), 30);
    assert.equal(burstEvery(plan, s + 5 * 60 * MIN, 'basic'), null);
    assert.equal(burstEvery({ startsAt: s, endsAt: s + 30 * MIN }, s + 40 * MIN), null, 'not after the sale ends');

    assert.equal(burstDue(plan, null, s + 10_000), true, 'the first check right at go-live');
    assert.equal(burstDue(plan, s - 2 * 3600000, s + 10_000), true, 'a check before the start doesn’t count');
    assert.equal(burstDue(plan, s + 2 * MIN, s + 4 * MIN), false, '2 minutes after the last one');
    assert.equal(burstDue(plan, s, s + 5 * MIN), true, 'scheduler tick 5 minutes later');
    assert.equal(burstDue(plan, s + 70 * MIN, s + 80 * MIN), false, 'after the first hour: 15 minutes apart');
    assert.equal(burstDue(plan, s + 70 * MIN, s + 85 * MIN), true);
    note(t, 'Full: 12 checks in the first hour + 24 over the next 6 hours. Basic: 4 + 6.');
  });

  it('every product in the sale: right price, still normal, different, sold out, or taken off in the cart', (t) => {
    const products = [
      { id: 1, title: 'Kurta', handle: 'kurta', tags: 'cotton', variants: [
        { title: 'S', price: '800.00', compare_at_price: '1000.00', available: true }, // 20% off: right
        { title: 'M', price: '1000.00', available: true }, // still the normal price
        { title: 'L', price: '850.00', available: true }, // different from the plan
        { title: 'XL', price: '1000.00', available: false } ] }, // sold out
      { id: 2, title: 'Saree', handle: 'saree', tags: 'silk', variants: [{ title: 'Default Title', price: '5000.00', available: true }] },
      { id: 3, title: 'Mug', handle: 'mug', tags: '', variants: [{ title: 'Default Title', price: '199.00', available: true }] },
    ];
    const rules = [{ scope: 'tag', type: 'percent', value: 20, target: 'cotton' }, { scope: 'tag', type: 'percent', value: 25, target: 'silk' }];
    const baseline = baselineFrom([{ handle: 'kurta', variant: 'M', now: 1000 }, { handle: 'kurta', variant: 'L', now: 1000 }]);
    const r = livePrices(products, rules, () => false, baseline, new Set([1]));
    const st = Object.fromEntries(r.rows.map((x) => [`${x.handle}/${x.variant || '-'}`, x.state]));
    assert.deepEqual(st, { 'kurta/S': 'ok', 'kurta/M': 'normal', 'kurta/L': 'wrong', 'kurta/XL': 'soldout', 'saree/-': 'cart' });
    assert.equal(r.rows.find((x) => x.variant === 'S').normal, 1000, 'without a pre-check, the compare-at price is the normal price');
    assert.ok(!r.rows.some((x) => x.handle === 'mug'), 'products outside the sale are left alone');
    assert.ok(nearPrice(1199, 1199.2) && nearPrice(1199.99, 1199.2) && !nearPrice(1150, 1199.2), 'shops may round sale prices');
    assert.ok(nearPrice(9.9, 9.95) && !nearPrice(9.5, 9.95));
    note(t, JSON.stringify(r.counts));
  });

  it('alerts only on change: new problems, fixed ones, and ones still open', () => {
    const f = (key, level = 'fail') => ({ key, level, title: key });
    const c = liveChanges([{ key: 'theme', title: 'theme' }, { key: 'banner', title: 'banner' }], [f('banner'), f('prices.wrong'), f('soldout', 'warn')]);
    assert.deepEqual(c.broke.map((x) => x.key), ['prices.wrong']);
    assert.deepEqual(c.fixed.map((x) => x.key), ['theme']);
    assert.deepEqual(c.still.map((x) => x.key), ['banner']);
    const quiet = liveChanges([{ key: 'banner', title: 'banner' }], [f('banner')]);
    assert.equal(quiet.broke.length + quiet.fixed.length, 0, 'the same problem again sends nothing');
  });
});

describe('Go-live burst in the product', () => {
  let P, owner, storeId, mallory, browser, planId;
  // From the start: kurta Small at its sale price, Medium sold out, Large at a wrong price, saree at its new price.
  const sale = { at: Date.now() + 365 * DAY, prices: { 101: 1199.2, 103: 1300, 201: 6999 }, soldOut: [102], banner: 'BLACK FRIDAY · 20% OFF', themeId: 333 };
  async function waitCheck(s, pid, id) {
    for (let i = 0; i < 240; i++) {
      const r = await s.get(`/api/stores/${storeId}/sale-plans/${pid}/live-checks/${id}`);
      if (r.json?.status && r.json.status !== 'running') return r.json;
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error('live check did not finish');
  }
  before(async () => {
    P = await startProduct({ mock: { sale } });
    owner = await signup(P, 'live-owner@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    mallory = await signup(P, 'live-mallory@shop.test');
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('a sale that started: the pre-check’s normal prices are kept for comparison', async (t) => {
    const start = Math.floor(Date.now() / MIN) * MIN; // this minute
    const r = await owner.post(`/api/stores/${storeId}/sale-plans`, {
      name: 'Black Friday 2026', timeZone: TZ, startsLocal: local(start), endsLocal: local(start + 2 * DAY), markets: ['IN'],
      rules: [{ scope: 'tag', type: 'percent', value: 20, target: 'cotton' }, { scope: 'product', type: 'price', value: 6999, target: 'silk-saree' }],
      codes: [{ code: 'BF20', percent: 20 }], banner: 'Black Friday · 20% off',
    });
    assert.equal(r.status, 200, r.text);
    planId = r.json.plan.id;
    assert.equal(r.json.plan.phase, 'live');
    const go = await owner.post(`/api/stores/${storeId}/sale-plans/${planId}/rehearse`, {});
    let rh;
    for (let i = 0; i < 120; i++) {
      rh = (await owner.get(`/api/stores/${storeId}/sale-plans/${planId}/rehearsals/${go.json.id}`)).json;
      if (rh.status !== 'running') break;
      await new Promise((res) => setTimeout(res, 500));
    }
    assert.equal(rh.status, 'done');
    assert.ok(rh.summary.prices.rows.length >= 4, 'normal prices saved by the pre-check');
    // The sale theme is added after the pre-check, so no side-by-side test is running when the sale checks start.
    const th = await owner.patch(`/api/stores/${storeId}/sale-plans/${planId}`, { themeId: '333' });
    assert.equal(th.status, 200, th.text);
    for (let i = 0; i < 240 && P.db().prepare("SELECT COUNT(*) AS n FROM runs WHERE store_id = ? AND status IN ('queued','running')").get(storeId).n; i++) await new Promise((res) => setTimeout(res, 500));
    const live = await owner.get(`/api/stores/${storeId}/sale-plans/${planId}/live`);
    assert.equal(live.status, 200);
    assert.equal(live.json.phase, 'live');
    assert.equal(live.json.every, 5, 'trial (with Safe to publish): every 5 minutes in the first hour');
    note(t, `Plan ${planId} started ${local(start)} ${TZ}; burst every ${live.json.every} min`);
  });

  let first;
  it('the sale didn’t switch on: normal prices, old theme and no banner are caught, and the owner is emailed', async (t) => {
    const go = await owner.post(`/api/stores/${storeId}/sale-plans/${planId}/live-check`, {});
    assert.equal(go.status, 200, go.text);
    const again = await owner.post(`/api/stores/${storeId}/sale-plans/${planId}/live-check`, {});
    assert.equal(again.status, 409, 'one check at a time');
    first = await waitCheck(owner, planId, go.json.id);
    assert.equal(first.status, 'done', JSON.stringify(first.summary || first.error));
    const f = (key) => first.summary.findings.find((x) => x.key === key);
    assert.equal(f('theme').level, 'fail'); assert.match(f('theme').detail, /Dawn/);
    assert.equal(f('banner').level, 'fail');
    assert.equal(f('prices.normal').level, 'fail');
    assert.match(f('prices.normal').title, /^4 prices still at the normal price/);
    assert.match(f('prices.normal').detail, /Organic Cotton Kurta \(Small\): 1499, should be 1199.2/);
    assert.equal(f('code.bf20').level, 'pass', 'BF20 takes 20% off in a real cart');
    assert.equal(first.verdict, 'fail');
    assert.ok(first.runId, 'the shopping journey (checkout included) is started with the check');
    assert.equal(first.summary.journey, 'started');
    const mail = P.log();
    assert.match(mail, /Sale problem on Mock Store: /);
    assert.match(mail, /What to do: Publish the sale theme/);
    note(t, first.summary.findings.map((x) => `${x.level}: ${x.title}`).join(' | '));
  });

  let second;
  it('once the sale is on: theme and banner OK, a wrong price and a sold-out item are reported; fixes are emailed', async (t) => {
    const on = await fetch(`${P.mock.origin}/__sale`).then((r) => r.json());
    assert.equal(on.on, true);
    const go = await owner.post(`/api/stores/${storeId}/sale-plans/${planId}/live-check`, {});
    assert.equal(go.status, 200, go.text);
    second = await waitCheck(owner, planId, go.json.id);
    assert.equal(second.status, 'done', JSON.stringify(second.summary || second.error));
    const f = (key) => second.summary.findings.find((x) => x.key === key);
    assert.equal(f('theme').level, 'pass');
    assert.equal(f('banner').level, 'pass', 'banner found whatever its letter case');
    assert.equal(f('prices.normal'), undefined);
    assert.equal(f('prices.wrong').level, 'fail');
    assert.match(f('prices.wrong').detail, /Organic Cotton Kurta \(Large\): shows 1300, your plan says 1279.2/);
    assert.equal(f('soldout').level, 'warn');
    assert.match(f('soldout').detail, /Medium/);
    const rows = second.summary.prices.rows;
    assert.equal(rows.find((x) => x.handle === 'silk-saree').state, 'ok', 'new price 6999');
    assert.equal(rows.find((x) => x.variant === 'Small').state, 'ok');
    assert.equal(second.summary.findings.find((x) => x.key === 'code.bf20').level, 'pass');
    if (!second.runId) assert.equal(second.summary.journey, 'busy', 'the journey from the first check is still running: not started twice');
    const mail = P.log();
    assert.match(mail, /Sale problem on Mock Store: 1 price different from your plan/);
    assert.match(mail, /Fixed now:\n- Your sale theme isn’t live\n- The sale banner is missing\n- 4 prices still at the normal price/);
    note(t, second.summary.findings.map((x) => `${x.level}: ${x.title}`).join(' | '));
  });

  it('the same problems again send no new email', async () => {
    const before = (P.log().match(/Sale problem on Mock Store|Fixed during/g) || []).length;
    const go = await owner.post(`/api/stores/${storeId}/sale-plans/${planId}/live-check`, {});
    const third = await waitCheck(owner, planId, go.json.id);
    assert.equal(third.verdict, 'fail');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((P.log().match(/Sale problem on Mock Store|Fixed during/g) || []).length, before);
  });

  it('only while the sale runs; another account can’t see or start checks', async (t) => {
    const later = Date.now() + 5 * DAY;
    const up = await owner.post(`/api/stores/${storeId}/sale-plans`, { name: 'Diwali', timeZone: TZ, startsLocal: local(later), endsLocal: local(later + DAY) });
    const r = await owner.post(`/api/stores/${storeId}/sale-plans/${up.json.plan.id}/live-check`, {});
    assert.equal(r.status, 400);
    assert.match(r.json.error, /hasn’t started yet/);
    const urls = [['get', `/api/stores/${storeId}/sale-plans/${planId}/live`], ['post', `/api/stores/${storeId}/sale-plans/${planId}/live-check`], ['get', `/api/stores/${storeId}/sale-plans/${planId}/live-checks/${second.id}`]];
    for (const [m, u] of urls) {
      const x = m === 'get' ? await mallory.get(u) : await mallory.post(u, {});
      assert.equal(x.status, 404, `${m} ${u}`);
    }
    assert.equal((await P.session().get(urls[0][1])).status, 401);
    const other = await owner.get(`/api/stores/${storeId}/sale-plans/${planId}/live-checks/999999`);
    assert.equal(other.status, 404);
    note(t, 'Upcoming plan refused; 3 routes refused for another account and when signed out');
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

  it('screens: Sale live on the overview and on the plan', async (t) => {
    const p = await page();
    await p.goto(`${P.base}/app#/s/${storeId}`);
    await p.waitForSelector('.sale-live-card');
    await quiet(p);
    assert.match(await p.textContent('.sale-live-card'), /Sale live · Black Friday 2026/);
    assert.match(await p.textContent('.sale-live-card'), /Something in your sale is broken/);
    await screenshot(t, p, 'Overview: Sale live');
    await p.click('.sale-live-card');
    await p.waitForSelector('#sale-live');
    await quiet(p);
    const txt = await p.textContent('.main-inner');
    assert.match(txt, /Checked every 5 minutes/);
    assert.match(txt, /1 price different from your plan/);
    assert.match(txt, /Different from plan/);
    assert.match(txt, /Last rehearsal before the sale/);
    assert.equal(await p.locator('#sp-run').count(), 0, 'no “Rehearse now” while the sale runs; “Check now” instead');
    assert.equal(await p.locator('#sl-run').count(), 1);
    await screenshot(t, p, 'Sale plan while the sale is live', { fullPage: true });
    assert.deepEqual(p.errors, []);
    const m = await page({ width: 390, height: 844 });
    await m.goto(`${P.base}/app#/s/${storeId}/sales/${planId}`);
    await m.waitForSelector('#sale-live');
    await quiet(m);
    await screenshot(t, m, 'Sale live on a phone');
    assert.deepEqual(m.errors, []);
  });
});
