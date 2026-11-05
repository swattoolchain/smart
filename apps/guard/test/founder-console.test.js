// The founder console: customers, licences, payments, plans, sale mode, audit log and settings.
// Only founders (ADMIN_EMAIL) get in; customers are refused on every console route.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startProduct, signup, shopifyOpen, addStore, FOUNDER, ROOT } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

/** Creates the founder account from the server (founders can't sign up) and signs it in. */
async function founder(P, password = 'founder-test-password') {
  const r = spawnSync(process.execPath, ['scripts/create-user.js', FOUNDER, password, 'Founder'], { cwd: ROOT, env: { ...process.env, DATA_DIR: P.dataDir }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`create-user failed: ${r.stderr || r.stdout}`);
  const s = P.session();
  const l = await s.post('/api/auth/login', { email: FOUNDER, password });
  if (l.status !== 200) throw new Error(`founder login failed ${l.status} ${l.text}`);
  s.email = FOUNDER;
  return s;
}

const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

describe('Founder console', () => {
  let P, boss, alice, bob, aliceId, bobId, aliceStore, browser;
  before(async () => {
    P = await startProduct();
    boss = await founder(P);
    alice = await signup(P, 'alice@console.test');
    bob = await signup(P, 'bob@console.test');
    const ids = Object.fromEntries(P.db().prepare('SELECT email, id FROM users').all().map((u) => [u.email, u.id]));
    aliceId = ids['alice@console.test']; bobId = ids['bob@console.test'];
    aliceStore = await addStore(P, alice, { runNow: false });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P?.stop(); });

  const auditFor = (uid, action) => P.db().prepare('SELECT * FROM audit WHERE user_id = ? AND action = ? ORDER BY id DESC').all(uid, action);

  async function consolePage(path, viewport = { width: 1360, height: 900 }) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addCookies(boss.browserCookies());
    const p = await ctx.newPage();
    p.errors = [];
    p.on('pageerror', (e) => p.errors.push(e.message));
    await p.goto(`${P.base}/app#${path}`);
    await p.waitForSelector('.main-inner h1', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    return p;
  }

  it('customers list: every account with plan and state, searchable and filterable', async (t) => {
    const all = (await boss.get('/api/admin/customers')).json.customers;
    const a = all.find((c) => c.email === 'alice@console.test');
    assert.ok(a && all.find((c) => c.email === 'bob@console.test'), 'both customers listed');
    assert.equal(a.plan_key, 'beta');
    assert.equal(a.state, 'active');
    assert.equal(a.stores, 1);
    assert.deepEqual((await boss.get('/api/admin/customers?q=alice')).json.customers.map((c) => c.email), ['alice@console.test']);
    assert.deepEqual((await boss.get('/api/admin/customers?q=nobody-here')).json.customers, []);
    assert.ok((await boss.get('/api/admin/customers?plan=beta')).json.customers.length >= 2);
    assert.deepEqual((await boss.get('/api/admin/customers?plan=pro')).json.customers, []);
    assert.deepEqual((await boss.get('/api/admin/customers?state=expired')).json.customers, []);
    const one = (await boss.get(`/api/admin/customers/${aliceId}`)).json;
    assert.equal(one.user.email, 'alice@console.test');
    assert.equal(one.stores.length, 1);
    assert.equal(one.stores[0].url, P.mock.origin);
    assert.equal((await boss.get('/api/admin/customers/999999')).status, 404);
    const p = await consolePage('/admin/customers');
    await p.waitForSelector('tr.link');
    assert.ok((await p.locator('tr.link').count()) >= 2);
    await screenshot(t, p, 'Customers list');
    assert.deepEqual(p.errors, []);
    note(t, `${all.length} accounts listed; search, plan and state filters work; unknown customer 404`);
    await p.context().close();
  });

  it('licence edit: plan, stores, status, dates and currency, with plain refusals and an audit entry', async (t) => {
    const r = await boss.patch(`/api/admin/customers/${aliceId}/license`, { plan_key: 'growth', seats: 3, billing: 'month', currency: 'INR', expires_at: day(30), notes: 'Agreed on a call' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.view.plan.key, 'growth');
    assert.equal(r.json.view.seats, 3);
    const lic = P.db().prepare('SELECT * FROM licenses WHERE user_id = ?').get(aliceId);
    assert.equal(lic.currency, 'INR');
    assert.equal(lic.expires_at, `${day(30)} 23:59:59`);
    const a = auditFor(aliceId, 'license.update')[0];
    assert.equal(a.actor, FOUNDER);
    const d = JSON.parse(a.detail_json);
    assert.deepEqual(d.plan_key, { before: 'beta', after: 'growth' });
    assert.deepEqual(d.seats, { before: 5, after: 3 });
    // Price shown to the founder: plan price per store x stores.
    const view = (await boss.get(`/api/admin/customers/${aliceId}`)).json.license;
    assert.deepEqual([view.price.amount, view.price.currency], [399900 * 3, 'INR']);

    const bad = [
      [{ plan_key: 'nope' }, /Unknown plan/],
      [{ seats: 0 }, /whole number from 1 to 1000/],
      [{ status: 'gold' }, /Unknown status/],
      [{ currency: 'JPY' }, /Unknown currency/],
      [{ expires_at: 'next week' }, /date like/],
      [{ grace_days: 400 }, /0 to 90/],
      [{ plan_key: 'trial', seats: 4 }, /allows up to 3 stores/],
    ];
    for (const [body, msg] of bad) {
      const x = await boss.patch(`/api/admin/customers/${aliceId}/license`, body);
      assert.equal(x.status, 400, JSON.stringify(body));
      assert.match(x.json.error, msg);
    }
    // A custom price is in one currency: changing currency without restating it is refused.
    assert.equal((await boss.patch(`/api/admin/customers/${aliceId}/license`, { price_override: 500000 })).status, 200);
    const cur = await boss.patch(`/api/admin/customers/${aliceId}/license`, { currency: 'USD' });
    assert.equal(cur.status, 400);
    assert.match(cur.json.error, /custom price in INR/);
    assert.equal((await boss.patch(`/api/admin/customers/${aliceId}/license`, { price_override: null })).status, 200);
    // Saving with no change writes nothing to the audit log.
    const n = auditFor(aliceId, 'license.update').length;
    assert.equal((await boss.patch(`/api/admin/customers/${aliceId}/license`, { seats: 3 })).status, 200);
    assert.equal(auditFor(aliceId, 'license.update').length, n);
    note(t, `Alice moved to Growth x3 in INR (price ₹${(399900 * 3) / 100}), ${bad.length} bad edits refused, custom-price currency guard, no-op save not audited`);
  });

  it('licence edit from the customer page in the browser', async (t) => {
    const p = await consolePage(`/admin/customers/${aliceId}`);
    await p.waitForSelector('#licf');
    await p.fill('#licf textarea[name=notes]', 'Renewal call booked');
    await p.fill('#licf input[name=seats]', '4');
    await p.click('#licf button[type=submit]');
    await p.waitForFunction(() => document.querySelector('#licf input[name=seats]')?.value === '4' && /Renewal call booked/.test(document.querySelector('#licf textarea[name=notes]')?.value || ''));
    await p.waitForTimeout(400);
    const lic = P.db().prepare('SELECT seats, notes, expires_at FROM licenses WHERE user_id = ?').get(aliceId);
    assert.equal(lic.seats, 4);
    assert.equal(lic.notes, 'Renewal call booked');
    assert.equal(lic.expires_at, `${day(30)} 23:59:59`, 'saving notes never moves the expiry');
    // A refusal is shown on the form.
    await p.fill('#licf input[name=grace_days]', '400');
    await p.evaluate(() => document.querySelector('#licf input[name=grace_days]').removeAttribute('max'));
    await p.click('#licf button[type=submit]');
    await p.waitForFunction(() => document.getElementById('lic-err')?.textContent.length > 0);
    assert.match(await p.textContent('#lic-err'), /Grace days must be 0 to 90/);
    await screenshot(t, p, 'Customer page with a refused licence edit', { fullPage: true });
    assert.deepEqual(p.errors, []);
    await p.context().close();
  });

  it('record payment: extends the licence, guards against double entry, asks for stores when moving from free', async (t) => {
    // Bob is on the free beta: a payment must say how many stores were paid for.
    const noSeats = await boss.post(`/api/admin/customers/${bobId}/payments`, { amount: 3800, currency: 'USD', plan_key: 'starter', method: 'upi', sendReceipt: false });
    assert.equal(noSeats.status, 400);
    assert.match(noSeats.json.error, /how many stores were paid for/);
    const freePlan = await boss.post(`/api/admin/customers/${bobId}/payments`, { amount: 3800, currency: 'USD', plan_key: 'beta', seats: 2, sendReceipt: false });
    assert.match(freePlan.json.error, /Payments are for paid plans/);
    const zero = await boss.post(`/api/admin/customers/${bobId}/payments`, { amount: 0, currency: 'USD', plan_key: 'starter', seats: 1, sendReceipt: false });
    assert.match(zero.json.error, /zero payment needs a note/);

    const ok = await boss.post(`/api/admin/customers/${bobId}/payments`, { amount: 3800, currency: 'USD', plan_key: 'starter', seats: 2, period: 'month', periods: 1, method: 'upi' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.view.plan.key, 'starter');
    assert.equal(ok.json.view.seats, 2, 'seats from the payment, not the 5 of the free plan');
    assert.equal(ok.json.view.status, 'active');
    const lic = P.db().prepare('SELECT * FROM licenses WHERE user_id = ?').get(bobId);
    const days = (new Date(lic.expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 864e5;
    assert.ok(days > 27 && days < 32, `one month from today (${days.toFixed(1)} days)`);

    // The same amount again within minutes, without a reference: refused as a double click...
    const dup = await boss.post(`/api/admin/customers/${bobId}/payments`, { amount: 3800, currency: 'USD', plan_key: 'starter', seats: 2, sendReceipt: false });
    assert.equal(dup.status, 400);
    assert.match(dup.json.error, /recorded a few minutes ago/);
    // ...unless confirmed as a second payment, which extends from the current end date.
    const second = await boss.post(`/api/admin/customers/${bobId}/payments`, { amount: 3800, currency: 'USD', plan_key: 'starter', seats: 2, confirmDuplicate: true, sendReceipt: false });
    assert.equal(second.status, 200, second.text);
    const after2 = P.db().prepare('SELECT expires_at FROM licenses WHERE user_id = ?').get(bobId).expires_at;
    assert.ok(after2 > lic.expires_at, 'second month added on top');
    // One bank reference is one payment, however it is typed.
    assert.equal((await boss.post(`/api/admin/customers/${bobId}/payments`, { amount: 100, currency: 'USD', plan_key: 'starter', seats: 2, reference: 'utr 1234 5678', sendReceipt: false })).status, 200);
    const ref = await boss.post(`/api/admin/customers/${bobId}/payments`, { amount: 200, currency: 'USD', plan_key: 'starter', seats: 2, reference: 'UTR12345678', sendReceipt: false });
    assert.match(ref.json.error, /reference is already recorded/);

    assert.equal(P.db().prepare('SELECT COUNT(*) AS n FROM payments WHERE user_id = ?').get(bobId).n, 3);
    const a = JSON.parse(auditFor(bobId, 'payment.record').at(-1).detail_json);
    assert.deepEqual([a.plan_before, a.plan, a.seats_before, a.seats, a.status_before], ['beta', 'starter', 5, 2, 'active']);
    // Receipt emailed for the first payment (MAIL_DEBUG log).
    const until = Date.now() + 5000;
    while (!/Payment received: Tharam Starter/.test(P.log()) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    assert.equal((P.log().match(/Payment received: Tharam Starter/g) || []).length, 1, 'one receipt: the others were sent with sendReceipt off');
    // Overview counts the money.
    const bill = (await boss.get('/api/admin/billing')).json;
    assert.ok(bill.counts.paying >= 1);
    assert.equal(bill.mrr.USD, 1900 * 2);
    assert.ok(bill.recentPayments.some((x) => x.email === 'bob@console.test'));
    note(t, `Bob: free -> Starter x2 by UPI, MRR $${bill.mrr.USD / 100}; missing stores, free plan, zero without note, double entry and repeated reference all refused`);
  });

  it('record payment from the customer page in the browser', async (t) => {
    const p = await consolePage(`/admin/customers/${bobId}`);
    await p.click('#pay');
    await p.waitForSelector('dialog[open] input[name=amount], .modal input[name=amount]');
    const amount = await p.inputValue('input[name=amount]');
    assert.equal(amount, '38', 'suggests plan price x stores');
    await p.fill('input[name=reference]', 'INV-2026-0042');
    await p.uncheck('input[name=sendReceipt]');
    await screenshot(t, p, 'Record payment dialog');
    await p.click('button:has-text("Record payment") >> nth=-1');
    await p.waitForFunction(() => /INV-2026-0042/i.test(document.body.textContent), null, { timeout: 10000 });
    assert.ok(P.db().prepare("SELECT 1 FROM payments WHERE reference = 'INV-2026-0042' AND user_id = ?").get(bobId));
    await screenshot(t, p, 'Customer page after the payment', { fullPage: true });
    assert.deepEqual(p.errors, []);
    await p.context().close();
  });

  it('plan edit: a partial change keeps everything else', async (t) => {
    const before = (await boss.get('/api/admin/plans')).json.plans.find((x) => x.key === 'growth');
    const r = await boss.patch('/api/admin/plans/growth', { tagline: 'Ship changes without breaking the store.' });
    assert.equal(r.status, 200, r.text);
    const after1 = r.json.plan;
    assert.equal(after1.tagline, 'Ship changes without breaking the store.');
    for (const k of ['name', 'kind', 'prices', 'features', 'public', 'highlight', 'active', 'sort']) assert.deepEqual(after1[k], before[k], `${k} unchanged`);
    // Built-in plans have no stored "tests per day" or "price rules"; saving writes the defaults (20, 10) that already applied.
    const limits = { manualRunsPerDay: 20, priceRules: 10, ...before.limits };
    assert.deepEqual(after1.limits, limits, 'limits unchanged');
    // Changing one limit keeps the other limits.
    const r2 = await boss.patch('/api/admin/plans/growth', { limits: { environments: 5 } });
    assert.equal(r2.status, 200, r2.text);
    assert.deepEqual(r2.json.plan.limits, { ...limits, environments: 5 });
    assert.deepEqual(r2.json.plan.prices, before.prices);
    // Customers on the plan see the new limit straight away.
    assert.equal((await alice.get('/api/me')).json.license.plan.key, 'growth');
    assert.equal(P.db().prepare("SELECT json_extract(limits_json, '$.environments') AS n FROM plans WHERE key = 'growth'").get().n, 5);
    const bad = [
      [{ limits: { journeyMinInterval: 5 } }, /Shopping checks interval must be 30 to 1440/],
      [{ name: '' }, /Name the plan/],
      [{ kind: 'paid', prices: {} }, /needs at least one price/],
      [{ prices: { USD: { month: -1 } } }, /zero or more/],
      [{ public: 'maybe' }, /true or false/],
    ];
    for (const [body, msg] of bad) {
      const x = await boss.patch('/api/admin/plans/growth', body);
      assert.equal(x.status, 400, JSON.stringify(body));
      assert.match(x.json.error, msg);
    }
    assert.equal((await boss.patch('/api/admin/plans/nope', { name: 'x' })).status, 400);
    // The plan new signups start on can't be retired or made paid.
    const sp = await boss.patch('/api/admin/plans/beta', { active: false });
    assert.match(sp.json.error, /New signups start on this plan/);
    // New plan: key rules and duplicates.
    assert.match((await boss.post('/api/admin/plans', { key: 'Agency!', name: 'Agency', prices: { USD: { month: 1 } } })).json.error, /lowercase letters/);
    const np = await boss.post('/api/admin/plans', { key: 'agency', name: 'Agency', kind: 'paid', prices: { USD: { month: 29900 } } });
    assert.equal(np.status, 200, np.text);
    assert.equal(np.json.plan.public, false, 'new plans start hidden');
    assert.match((await boss.post('/api/admin/plans', { key: 'agency', name: 'Again', prices: { USD: { month: 1 } } })).json.error, /exists/);
    const audits = P.db().prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'plan.%'").get().n;
    assert.ok(audits >= 3, 'plan changes audited');
    const p = await consolePage('/admin/plans');
    await p.waitForSelector('[data-edit=growth]');
    await screenshot(t, p, 'Plans');
    await p.click('[data-edit=growth]');
    await p.waitForSelector('input[name=name]');
    assert.equal(await p.inputValue('input[name=name]'), 'Growth');
    await screenshot(t, p, 'Editing the Growth plan');
    assert.deepEqual(p.errors, []);
    await p.context().close();
    note(t, `Tagline-only and one-limit changes kept prices, features and other limits; ${bad.length} bad edits refused; signup plan protected; new plan 'agency' starts hidden; ${audits} plan audit entries`);
  });

  it('sale mode: founder turns it on for a store up to 31 days, and off again', async (t) => {
    const until = day(10);
    for (const [body, msg] of [[{ until: day(-2) }, /passed/], [{ until: day(40) }, /31 days/], [{ until: '2026-02-30' }, /valid end date/]]) {
      const x = await boss.post(`/api/admin/stores/${aliceStore}/sale`, body);
      assert.equal(x.status, 400);
      assert.match(x.json.error, msg);
    }
    assert.equal((await boss.post('/api/admin/stores/999999/sale', { until })).status, 404);
    const on = await boss.post(`/api/admin/stores/${aliceStore}/sale`, { until });
    assert.equal(on.status, 200, on.text);
    const st = (await boss.get(`/api/admin/customers/${aliceId}`)).json.stores[0];
    assert.equal(st.saleUntil, until);
    assert.equal((await alice.get(`/api/stores/${aliceStore}`)).json.store.config.saleUntil, until, 'the owner sees sale mode too');
    const p = await consolePage(`/admin/customers/${aliceId}`);
    await p.waitForSelector(`[data-sale="${aliceStore}"]`);
    assert.match(await p.textContent('.panel:has(h2:text("Stores"))'), /Until/);
    await screenshot(t, p, 'Store in sale mode on the customer page');
    await p.context().close();
    const off = await boss.post(`/api/admin/stores/${aliceStore}/sale`, { until: null });
    assert.equal(off.status, 200);
    assert.equal((await alice.get(`/api/stores/${aliceStore}`)).json.store.config.saleUntil, null);
    const log = auditFor(aliceId, 'store.sale').map((a) => JSON.parse(a.detail_json));
    assert.deepEqual(log.map((d) => [d.before, d.after]), [[until, null], [null, until]]);
    note(t, `Sale mode on until ${until} then off; past, >31 days and invalid dates refused; both changes audited`);
  });

  it('audit view: every founder action with who and when, newest first; notes can be added', async (t) => {
    const empty = await boss.post(`/api/admin/customers/${aliceId}/note`, { text: '   ' });
    assert.equal(empty.status, 400);
    assert.equal((await boss.post(`/api/admin/customers/${aliceId}/note`, { text: 'Asked for an invoice in INR' })).status, 200);
    const log = (await boss.get('/api/admin/audit')).json.audit;
    assert.ok(log.length >= 8);
    const ids = log.map((a) => a.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'newest first');
    assert.equal(log[0].action, 'note');
    assert.equal(log[0].email, 'alice@console.test');
    assert.equal(log[0].actor, FOUNDER);
    const actions = new Set(log.map((a) => a.action));
    for (const a of ['license.update', 'payment.record', 'store.sale', 'note']) assert.ok(actions.has(a), `${a} in the log`);
    const cust = (await boss.get(`/api/admin/customers/${aliceId}`)).json.audit;
    assert.ok(cust.every((a) => a.user_id === aliceId), "customer page shows only that customer's history");
    const p = await consolePage('/admin/audit');
    await p.waitForTimeout(500);
    assert.match(await p.textContent('.main-inner'), /alice@console\.test/);
    await screenshot(t, p, 'Audit log');
    assert.deepEqual(p.errors, []);
    await p.context().close();
    const o = await consolePage('/admin');
    await o.waitForSelector('.figure');
    await screenshot(t, o, 'Founder console overview');
    await o.context().close();
    note(t, `${log.length} audit entries, kinds: ${[...actions].join(', ')}`);
  });

  it('settings: signup plan, trial and grace days, payment note, validated', async () => {
    for (const [body, msg] of [[{ signup_plan: 'starter' }, /free or trial plan/], [{ trial_days: 0 }, /1 to 90/], [{ grace_days: 'x' }, /0 to 90/], [{ payment_note: ' ' }, /how customers can pay/]]) {
      const x = await boss.patch('/api/admin/settings', body);
      assert.equal(x.status, 400, JSON.stringify(body));
      assert.match(x.json.error, msg);
    }
    assert.equal((await boss.patch('/api/admin/settings', { trial_days: 21 })).status, 200);
    assert.equal((await boss.get('/api/admin/settings')).json.settings.trial_days, '21');
    assert.ok(P.db().prepare("SELECT 1 FROM audit WHERE action LIKE 'setting%'").get(), 'setting change audited');
  });

  it('customers are refused on every console route, and never see the console', async (t) => {
    const routes = [
      ['get', '/api/admin/billing'], ['get', '/api/admin/customers'], ['get', `/api/admin/customers/${bobId}`],
      ['patch', `/api/admin/customers/${aliceId}/license`, { plan_key: 'pro', seats: 100 }],
      ['post', `/api/admin/customers/${aliceId}/payments`, { amount: 1, currency: 'USD', plan_key: 'pro', seats: 1, note: 'free' }],
      ['post', `/api/admin/stores/${aliceStore}/sale`, { until: day(5) }], ['post', `/api/admin/customers/${aliceId}/note`, { text: 'hi' }],
      ['get', '/api/admin/plans'], ['post', '/api/admin/plans', { key: 'mine', name: 'Mine', kind: 'free' }], ['patch', '/api/admin/plans/pro', { prices: { USD: { month: 1 } } }],
      ['get', '/api/admin/payments'], ['get', '/api/admin/audit'], ['get', '/api/admin/settings'], ['patch', '/api/admin/settings', { trial_days: 90 }],
      ['get', '/api/admin/overview'],
    ];
    const shop = await shopifyOpen(P);
    const auditBefore = P.db().prepare('SELECT COUNT(*) AS n FROM audit').get().n;
    const who = [['website customer', alice, 403], ['Shopify customer', shop, 403], ['signed-out visitor', P.session(), 401]];
    for (const [label, s, code] of who) {
      for (const [m, u, b] of routes) {
        const r = await s[m](u, b);
        assert.equal(r.status, code, `${label}: ${m.toUpperCase()} ${u}`);
        assert.doesNotMatch(r.text, /bob@console\.test|alice@console\.test/, `${label}: no customer data in the refusal`);
      }
    }
    assert.equal(P.db().prepare('SELECT COUNT(*) AS n FROM audit').get().n, auditBefore, 'nothing changed');
    assert.equal(P.db().prepare("SELECT seats FROM licenses WHERE user_id = ?").get(aliceId).seats, 4);
    assert.equal((await alice.get('/api/me')).json.admin, false);
    // In the browser: no console link, and the console address goes back home.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addCookies(alice.browserCookies());
    const p = await ctx.newPage();
    await p.goto(`${P.base}/app#/admin/customers`);
    await p.waitForFunction(() => !location.hash.startsWith('#/admin'), null, { timeout: 15000 });
    await p.waitForTimeout(500);
    assert.equal(await p.locator('a[href="#/admin"]').count(), 0);
    assert.doesNotMatch(await p.textContent('body'), /Founder console/);
    await screenshot(t, p, 'Customer sent away from the console');
    await ctx.close();
    note(t, `${routes.length} console routes x 3 kinds of non-founder: 403/403/401, no data leaked, nothing changed`);
  });
});
