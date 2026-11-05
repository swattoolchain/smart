// Sale rehearsal, part 1: sale plans and the pre-check before a sale starts.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, shopifyOpen } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';
import { zonedToUtc, utcToZoned, cleanPlan, expectedPrices, compareDiscounts, rehearsalDue, verdictOf, automaticFor } from '../src/sale-math.js';

const DAY = 86400000;
const TZ = 'Asia/Kolkata';
const local = (ms) => utcToZoned(ms, TZ);
// A sale 10 days from now, for 4 days, at midnight store time.
const start = zonedToUtc(local(Date.now() + 10 * DAY).slice(0, 10) + 'T00:00', TZ);
const end = start + 4 * DAY;
const MARKETS = ['IN', 'US', 'DE', 'UK'];
const iso = (ms) => new Date(ms).toISOString();

describe('Sale plans: dates, prices and Shopify discounts (no server)', () => {
  it('converts the sale’s local start and end in its time zone, including clock changes', (t) => {
    assert.equal(zonedToUtc('2026-11-27T00:00', 'Asia/Kolkata'), Date.UTC(2026, 10, 26, 18, 30));
    assert.equal(zonedToUtc('2026-11-27T00:00', 'America/New_York'), Date.UTC(2026, 10, 27, 5, 0)); // EST, UTC-5
    assert.equal(zonedToUtc('2026-07-01T09:00', 'America/New_York'), Date.UTC(2026, 6, 1, 13, 0)); // EDT, UTC-4
    assert.equal(zonedToUtc('2026-12-26T08:00', 'Australia/Sydney'), Date.UTC(2026, 11, 25, 21, 0)); // AEDT, UTC+11
    assert.equal(utcToZoned(Date.UTC(2026, 10, 26, 18, 30), 'Asia/Kolkata'), '2026-11-27T00:00');
    assert.throws(() => zonedToUtc('2026-02-30T10:00', 'UTC'), /does not exist/);
    assert.throws(() => zonedToUtc('next friday', 'UTC'), /YYYY-MM-DD/);
    note(t, 'Black Friday midnight in India = 26 Nov 18:30 UTC; New York and Sydney follow daylight saving');
  });

  it('refuses plans that make no sense, with plain reasons', (t) => {
    const ok = { name: 'Black Friday', timeZone: TZ, startsLocal: local(start), endsLocal: local(end), markets: ['IN'] };
    const bad = [
      [{ name: '' }, /name/],
      [{ timeZone: 'Mars/Olympus' }, /time zone/],
      [{ endsLocal: local(start - DAY) }, /end after it starts/],
      [{ endsLocal: local(start + 100 * DAY) }, /3 months/],
      [{ startsLocal: local(Date.now() - 5 * DAY), endsLocal: local(Date.now() - 2 * DAY) }, /already ended/],
      [{ markets: ['XX'] }, /Unknown market/],
      [{ rules: [{ scope: 'all', type: 'percent', value: 150 }] }, /at most 100%/],
      [{ rules: [{ scope: 'collection', type: 'percent', value: 10, target: 'Summer Dresses!' }] }, /handle/],
      [{ rules: [{ scope: 'tag', type: 'percent', value: 10, target: '' }] }, /which tag/],
      [{ codes: [{ code: 'BF 20!' }] }, /letters, numbers/],
      [{ codes: [{ code: 'BF20', percent: 0 }] }, /between 1 and 100/],
      [{ themeId: 'abc' }, /theme/],
    ];
    for (const [patch, re] of bad) assert.throws(() => cleanPlan({ ...ok, ...patch }, { markets: MARKETS }), re, JSON.stringify(patch));
    const c = cleanPlan({ ...ok, codes: [{ code: 'BF20', percent: '20' }, 'bf20', { code: 'VIP' }], rules: [{ scope: 'all', type: 'percent', value: '25' }] }, { markets: MARKETS });
    assert.deepEqual(c.codes, [{ code: 'BF20', percent: 20 }, { code: 'VIP', percent: null }], 'duplicate codes are dropped');
    assert.equal(c.startsAt, start);
    note(t, `${bad.length} kinds of bad input refused`);
  });

  it('works out each product’s sale price; the most specific discount wins; wrong prices are caught', (t) => {
    const products = [
      { id: 1, title: 'Kurta', handle: 'kurta', tags: 'cotton, festive', variants: [{ title: 'S', price: '1000.00' }, { title: 'M', price: '1000.00', compare_at_price: '1200.00' }] },
      { id: 2, title: 'Saree', handle: 'saree', tags: ['silk'], variants: [{ title: 'Default Title', price: '5000.00' }] },
      { id: 3, title: 'Diya', handle: 'diya', tags: '', variants: [{ title: 'Default Title', price: '80.00' }] },
      { id: 4, title: 'Gift card', handle: 'gift-card', tags: 'gift', variants: [{ title: 'Default Title', price: '500.00' }] },
    ];
    const rules = [
      { scope: 'all', type: 'percent', value: 10 },
      { scope: 'tag', type: 'percent', value: 30, target: 'cotton' },
      { scope: 'product', type: 'fixed', value: 100, target: 'diya' }, // 80 - 100: below zero
      { scope: 'product', type: 'price', value: 600, target: 'gift-card' }, // dearer than today
      { scope: 'collection', type: 'percent', value: 50, target: 'silk-wear' },
      { scope: 'tag', type: 'percent', value: 5, target: 'nobody-has-this' },
    ];
    const silk = new Set([2]);
    const r = expectedPrices(products, rules, (h, id) => h === 'silk-wear' && silk.has(id));
    const by = (h) => r.rows.filter((x) => x.handle === h);
    assert.deepEqual(by('kurta').map((x) => x.sale), [700, 700], 'tag rule (30%) beats the store-wide 10%');
    assert.ok(by('kurta')[1].issues.some((i) => /already discounted/.test(i.text)));
    assert.equal(by('saree')[0].sale, 2500, 'collection rule beats the store-wide one');
    assert.match(by('diya')[0].issues[0].text, /free or below zero/);
    assert.match(by('gift-card')[0].issues[0].text, /not lower/);
    assert.equal(r.counts.fail, 2);
    assert.deepEqual(r.unmatchedRules.map((x) => x.target), ['nobody-has-this'], 'a rule that matches nothing is reported');
    note(t, `${r.rows.length} prices, ${r.counts.fail} wrong, unmatched: ${r.unmatchedRules.length}`);
  });

  it('compares the plan with the discounts scheduled in Shopify', (t) => {
    const plan = { timeZone: TZ, startsAt: start, endsAt: end, freeShipping: 999, codes: [{ code: 'BF20', percent: 20 }, { code: 'LATE', percent: null }, { code: 'SHORT', percent: null }, { code: 'WRONG', percent: 30 }, { code: 'FOREVER', percent: null }, { code: 'MISSING', percent: null }] };
    const discounts = [
      { title: 'Black Friday 20', kind: 'code', type: 'basic', codes: ['bf20'], startsAt: iso(start), endsAt: iso(end), percent: 20 },
      { title: 'Late', kind: 'code', type: 'basic', codes: ['LATE'], startsAt: iso(start + 3 * 3600000), endsAt: iso(end), percent: 10 },
      { title: 'Short', kind: 'code', type: 'basic', codes: ['SHORT'], startsAt: iso(start), endsAt: iso(end - DAY), percent: 10 },
      { title: 'Wrong', kind: 'code', type: 'basic', codes: ['WRONG'], startsAt: iso(start), endsAt: iso(end), percent: 25 },
      { title: 'Forever', kind: 'code', type: 'basic', codes: ['FOREVER'], startsAt: iso(start), endsAt: null, percent: 10 },
      { title: 'Free shipping', kind: 'automatic', type: 'shipping', codes: [], startsAt: iso(start), endsAt: iso(end), minSubtotal: 1499 },
    ];
    const f = compareDiscounts(plan, discounts, { now: Date.now() });
    const of = (code) => f.find((x) => x.title.includes(code));
    assert.equal(of('BF20').level, 'pass', 'codes match whatever their letter case');
    assert.equal(of('LATE').level, 'fail'); assert.match(of('LATE').detail, /after your sale starts/);
    assert.equal(of('SHORT').level, 'fail'); assert.match(of('SHORT').detail, /before your sale ends/);
    assert.equal(of('WRONG').level, 'fail'); assert.match(of('WRONG').detail, /25%.*30%/);
    assert.equal(of('FOREVER').level, 'warn'); assert.match(of('FOREVER').detail, /no end date/);
    assert.equal(of('MISSING').level, 'fail'); assert.match(of('MISSING').title, /isn’t set up/);
    const ship = f.find((x) => x.area === 'shipping');
    assert.equal(ship.level, 'fail'); assert.match(ship.detail, /1499.*999/);
    assert.ok(automaticFor({ type: 'percent', value: 20 }, plan, [{ kind: 'automatic', percent: 20, startsAt: iso(start), endsAt: iso(end) }]));
    assert.equal(automaticFor({ type: 'percent', value: 20 }, plan, [{ kind: 'automatic', percent: 20, startsAt: iso(start + DAY), endsAt: iso(end) }]), null, 'an automatic discount that starts late doesn’t count');
    assert.equal(verdictOf(f), 'not_ready');
    note(t, f.map((x) => `${x.level}: ${x.title}`).join(' | '));
  });

  it('the daily pre-check runs once a day until the sale starts', () => {
    const now = Date.now();
    const p = { startsAt: now + 5 * DAY };
    assert.equal(rehearsalDue(p, null, now), true, 'never rehearsed');
    assert.equal(rehearsalDue(p, now - 2 * 3600000, now), false, 'rehearsed 2 hours ago');
    assert.equal(rehearsalDue(p, now - 24 * 3600000, now), true, 'rehearsed yesterday');
    assert.equal(rehearsalDue({ startsAt: now - 3600000 }, null, now), false, 'the sale has started');
    assert.equal(rehearsalDue({ startsAt: now + 60 * DAY }, null, now), false, 'too far ahead');
  });
});

describe('Sale plans in the product', () => {
  let P, owner, storeId, mallory, malloryStore, browser;
  const planBody = (extra = {}) => ({ name: 'Black Friday 2026', timeZone: TZ, startsLocal: local(start), endsLocal: local(end), markets: ['IN', 'US'], ...extra });
  async function waitRehearsal(s, sid, pid, id) {
    for (let i = 0; i < 120; i++) {
      const r = await s.get(`/api/stores/${sid}/sale-plans/${pid}/rehearsals/${id}`);
      if (r.json?.status && r.json.status !== 'running') return r.json;
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error('rehearsal did not finish');
  }
  before(async () => {
    P = await startProduct();
    owner = await signup(P, 'sale-owner@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    mallory = await signup(P, 'sale-mallory@shop.test');
    malloryStore = await addStore(P, mallory, { runNow: false });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  let planId, rehearsal;
  it('an owner saves a sale plan in the store’s time zone; bad plans are refused', async (t) => {
    const bad = await owner.post(`/api/stores/${storeId}/sale-plans`, planBody({ endsLocal: local(start - DAY) }));
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /end after it starts/);
    const r = await owner.post(`/api/stores/${storeId}/sale-plans`, planBody({
      codes: [{ code: 'BF20', percent: 20 }],
      rules: [
        { scope: 'tag', type: 'percent', value: 20, target: 'cotton' },
        { scope: 'collection', type: 'percent', value: 10, target: 'festive' },
        { scope: 'product', type: 'fixed', value: 100, target: 'brass-diya' },
        { scope: 'product', type: 'percent', value: 15, target: 'no-such-product' },
      ],
      banner: 'BLACK FRIDAY · 20% OFF', freeShipping: 999,
    }));
    assert.equal(r.status, 200, r.text);
    planId = r.json.plan.id;
    assert.equal(r.json.plan.startsAt, start);
    assert.equal(r.json.plan.startsLocal, local(start));
    assert.equal(r.json.plan.phase, 'upcoming');
    const list = await owner.get(`/api/stores/${storeId}/sale-plans`);
    assert.equal(list.json.plans.length, 1);
    note(t, `Plan ${planId}: starts ${local(start)} ${TZ} = ${new Date(start).toISOString()}`);
  });

  it('the pre-check works out sale prices, flags wrong ones, and emails the owner', async (t) => {
    const go = await owner.post(`/api/stores/${storeId}/sale-plans/${planId}/rehearse`, {});
    assert.equal(go.status, 200, go.text);
    const again = await owner.post(`/api/stores/${storeId}/sale-plans/${planId}/rehearse`, {});
    assert.equal(again.status, 409, 'one pre-check at a time');
    rehearsal = await waitRehearsal(owner, storeId, planId, go.json.id);
    assert.equal(rehearsal.status, 'done', JSON.stringify(rehearsal.summary));
    const sum = rehearsal.summary;
    const rows = sum.prices.rows;
    const kurta = rows.filter((x) => x.handle === 'cotton-kurta').map((x) => x.sale);
    assert.deepEqual(kurta, [1199.2, 1199.2, 1279.2], 'kurta: the tag rule (20%) beats the collection rule');
    assert.equal(rows.find((x) => x.handle === 'silk-saree').sale, 8099.1, 'saree: 10% from the festive collection');
    assert.match(rows.find((x) => x.handle === 'brass-diya').issues[0].text, /free or below zero/);
    const titles = sum.findings.map((f) => `${f.level}: ${f.title}`);
    assert.ok(titles.some((x) => /^fail: 1 sale price would be wrong/.test(x)), titles.join('\n'));
    assert.ok(titles.some((x) => /^warn: The discount for product “no-such-product” matches no product/.test(x)), titles.join('\n'));
    assert.ok(titles.some((x) => /^later: Your discount code is checked when the sale goes live/.test(x)), 'no Shopify access: codes wait for go-live');
    assert.ok(titles.some((x) => /^later: Free shipping is checked/.test(x)));
    assert.equal(rehearsal.verdict, 'not_ready');
    const mail = P.log();
    assert.match(mail, /Sale rehearsal for Black Friday 2026 on Mock Store: Not ready yet/);
    assert.match(mail, /What to do: Change the discount in your plan/);
    note(t, titles.join(' | '));
  });

  it('plans that overlap are pointed out', async (t) => {
    const r = await owner.post(`/api/stores/${storeId}/sale-plans`, planBody({ name: 'Cyber Monday', startsLocal: local(end - DAY), endsLocal: local(end + DAY), rules: [{ scope: 'tag', type: 'percent', value: 15, target: 'silk' }] }));
    assert.equal(r.status, 200, r.text);
    const go = await owner.post(`/api/stores/${storeId}/sale-plans/${r.json.plan.id}/rehearse`, {});
    const done = await waitRehearsal(owner, storeId, r.json.plan.id, go.json.id);
    assert.ok(done.summary.findings.some((f) => f.level === 'warn' && /Overlaps with “Black Friday 2026”/.test(f.title)));
    assert.equal(done.verdict, 'review');
    note(t, `Cyber Monday: ${done.verdict}`);
  });

  it('another account can’t see, change, rehearse or remove the plan', async (t) => {
    const urls = [
      ['get', `/api/stores/${storeId}/sale-plans`], ['post', `/api/stores/${storeId}/sale-plans`],
      ['get', `/api/stores/${storeId}/sale-plans/${planId}`], ['patch', `/api/stores/${storeId}/sale-plans/${planId}`],
      ['delete', `/api/stores/${storeId}/sale-plans/${planId}`], ['post', `/api/stores/${storeId}/sale-plans/${planId}/rehearse`],
      ['get', `/api/stores/${storeId}/sale-plans/${planId}/rehearsals/${rehearsal.id}`],
      // Mallory's own store, Alice's plan: still not found.
      ['get', `/api/stores/${malloryStore}/sale-plans/${planId}`], ['delete', `/api/stores/${malloryStore}/sale-plans/${planId}`],
      ['post', `/api/stores/${malloryStore}/sale-plans/${planId}/rehearse`],
    ];
    for (const [m, u] of urls) {
      const r = m === 'get' ? await mallory.get(u) : m === 'delete' ? await mallory.del(u) : await mallory.req(m.toUpperCase(), u, planBody());
      assert.equal(r.status, 404, `${m} ${u} → ${r.status}`);
    }
    const anon = await P.session().get(`/api/stores/${storeId}/sale-plans`);
    assert.equal(anon.status, 401);
    assert.equal((await owner.get(`/api/stores/${storeId}/sale-plans/${planId}`)).status, 200, 'still there for its owner');
    note(t, `${urls.length} requests from another account refused`);
  });

  it('the plan limit is enforced on the server', async (t) => {
    const list = await owner.get(`/api/stores/${storeId}/sale-plans`);
    const { limit } = list.json;
    for (let i = list.json.plans.length; i < limit; i++) {
      const r = await owner.post(`/api/stores/${storeId}/sale-plans`, planBody({ name: `Sale ${i}` }));
      assert.equal(r.status, 200, r.text);
    }
    const over = await owner.post(`/api/stores/${storeId}/sale-plans`, planBody({ name: 'One too many' }));
    assert.equal(over.status, 403);
    assert.match(over.json.error, /covers \d+ upcoming sale plans/);
    // Make room again for the screens below.
    for (const p of (await owner.get(`/api/stores/${storeId}/sale-plans`)).json.plans.filter((x) => /^Sale \d+$/.test(x.name))) await owner.del(`/api/stores/${storeId}/sale-plans/${p.id}`);
    note(t, `Limit ${limit} upcoming plans per store on this plan`);
  });

  it('editing keeps the plan valid', async () => {
    const r = await owner.patch(`/api/stores/${storeId}/sale-plans/${planId}`, { endsLocal: local(start - 3600000) });
    assert.equal(r.status, 400);
    const ok = await owner.patch(`/api/stores/${storeId}/sale-plans/${planId}`, { name: 'Black Friday weekend' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.plan.name, 'Black Friday weekend');
    assert.equal(ok.json.plan.startsAt, start, 'other fields unchanged');
    await owner.patch(`/api/stores/${storeId}/sale-plans/${planId}`, { name: 'Black Friday 2026' });
  });

  it('Shopify store: scheduled discounts, the sale theme and its banner are checked, and the theme is tested next to live', async (t) => {
    await P.fake.control({ discounts: [
      { id: 'gid://shopify/DiscountCodeNode/1', discount: { __typename: 'DiscountCodeBasic', title: 'Black Friday 20', startsAt: iso(start), endsAt: iso(end), codes: { nodes: [{ code: 'BF20' }] }, customerGets: { value: { percentage: 0.2 } } } },
      { id: 'gid://shopify/DiscountCodeNode/2', discount: { __typename: 'DiscountCodeBasic', title: 'Early birds', startsAt: iso(start + 6 * 3600000), endsAt: iso(end), codes: { nodes: [{ code: 'EARLY' }] }, customerGets: { value: { percentage: 0.1 } } } },
      { id: 'gid://shopify/DiscountAutomaticNode/3', discount: { __typename: 'DiscountAutomaticBasic', title: '25% off everything', startsAt: iso(start), endsAt: iso(end), customerGets: { value: { percentage: 0.25 } } } },
      { id: 'gid://shopify/DiscountAutomaticNode/4', discount: { __typename: 'DiscountAutomaticFreeShipping', title: 'Free shipping', startsAt: iso(start), endsAt: iso(end), minimumRequirement: { greaterThanOrEqualToSubtotal: { amount: '999.0' } } } },
    ] });
    const shop = await shopifyOpen(P, 'sale-shop.myshopify.com');
    const r = await shop.post(`/api/stores/${shop.storeId}/sale-plans`, planBody({ name: 'Diwali', codes: [{ code: 'BF20', percent: 20 }, { code: 'EARLY' }], rules: [{ scope: 'all', type: 'percent', value: 25 }], themeId: '222', banner: 'Diwali sale · 40% off', freeShipping: 999 }));
    assert.equal(r.status, 200, r.text);
    const go = await shop.post(`/api/stores/${shop.storeId}/sale-plans/${r.json.plan.id}/rehearse`, {});
    const done = await waitRehearsal(shop, shop.storeId, r.json.plan.id, go.json.id);
    assert.equal(done.status, 'done', JSON.stringify(done.summary));
    const f = (re) => done.summary.findings.find((x) => re.test(x.title));
    assert.equal(f(/Discount code BF20/).level, 'pass');
    assert.equal(f(/Discount code EARLY/).level, 'fail');
    assert.match(f(/Discount code EARLY/).detail, /after your sale starts/);
    assert.equal(f(/Free shipping/).level, 'pass');
    assert.equal(f(/Shopify discount “25% off everything” is scheduled/).level, 'pass', 'an automatic Shopify discount covers the 25% rule');
    assert.equal(f(/Sale theme “Dawn – Black Friday” is ready/).level, 'pass');
    assert.equal(f(/Sale banner is on the sale theme/).level, 'pass', 'banner text found on the draft theme, whatever its case');
    const side = done.summary.findings.find((x) => x.releaseId);
    assert.ok(side, 'the sale theme is tested next to the live store');
    assert.equal(done.releaseId, side.releaseId);
    const rel = (await shop.get(`/api/stores/${shop.storeId}/releases`)).json.releases.find((x) => x.id === side.releaseId);
    assert.equal(rel.trigger, 'sale');
    assert.match(rel.preview_url, /preview_theme_id=222/);
    note(t, done.summary.findings.map((x) => `${x.level}: ${x.title}`).join(' | '));
    // Stop the side-by-side test so the rest of the file isn't waiting on it.
    await shop.post(`/api/stores/${shop.storeId}/releases/${side.releaseId}/cancel`, {});
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

  it('screens: list, new plan form and the rehearsal report', async (t) => {
    const p = await page();
    await p.goto(`${P.base}/app#/s/${storeId}/sales`);
    await p.waitForSelector('tr.link');
    await quiet(p);
    assert.ok(await p.locator('.rail-item[href$="/sales"]').isVisible(), 'Sale plans is in the side menu');
    assert.match(await p.textContent('.main-inner'), /Black Friday 2026/);
    await screenshot(t, p, 'Sale plans list');

    await p.click('a[href$="/sales/new"]');
    await p.waitForSelector('#spf');
    await quiet(p);
    await p.fill('#sp-name', 'Boxing Day');
    await p.fill('#sp-start', local(start + 30 * DAY));
    await p.fill('#sp-end', local(start + 31 * DAY));
    await p.selectOption('#sp-tz', TZ);
    await p.fill('.sale-rule [name=value]', '30');
    await p.fill('#sp-codes', 'BOXING30 30');
    await screenshot(t, p, 'New sale plan form', { fullPage: true });
    await p.click('#spf button[type=submit]');
    await p.waitForFunction(() => /#\/s\/\d+\/sales\/\d+$/.test(location.hash));
    await p.waitForSelector('.pub-verdict', { timeout: 60000 });
    assert.match(await p.textContent('.main-inner'), /Boxing Day/);
    assert.match(await p.textContent('.main-inner'), /checked when the sale goes live/);

    await p.goto(`${P.base}/app#/s/${storeId}/sales/${planId}`);
    await p.waitForSelector('.pub-verdict');
    await quiet(p);
    assert.match(await p.textContent('.pub-verdict'), /Not ready yet/);
    assert.match(await p.textContent('.pub-verdict h2'), /to fix before the sale/);
    assert.ok(await p.locator('.sev.fail').count() >= 1);
    await screenshot(t, p, 'Rehearsal report', { fullPage: true });
    assert.deepEqual(p.errors, []);

    // On a phone-sized screen
    const m = await page({ width: 390, height: 844 });
    await m.goto(`${P.base}/app#/s/${storeId}/sales/${planId}`);
    await m.waitForSelector('.pub-verdict');
    await quiet(m);
    await screenshot(t, m, 'Rehearsal report on a phone');
    assert.deepEqual(m.errors, []);
  });

  it('removing a plan removes its rehearsals, not the store’s discounts', async () => {
    const r = await owner.del(`/api/stores/${storeId}/sale-plans/${planId}`);
    assert.equal(r.status, 200);
    assert.equal((await owner.get(`/api/stores/${storeId}/sale-plans/${planId}`)).status, 404);
    assert.equal(P.db().prepare('SELECT COUNT(*) AS n FROM sale_rehearsals WHERE plan_id = ?').get(planId).n, 0);
  });
});
