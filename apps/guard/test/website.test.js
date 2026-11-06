// The public website: home, pricing, German page, Black Friday page, checks page, free scan,
// lead capture and the demo page, at desktop and phone sizes.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startProduct, FOUNDER, ROOT } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const DESKTOP = { width: 1360, height: 900 };
const PHONE = { width: 390, height: 844 };
const CAL = 'tharam/demo';

/** Creates the founder account from the server (founders can't sign up) and signs it in. */
async function founder(P, password = 'founder-test-password') {
  const r = spawnSync(process.execPath, ['scripts/create-user.js', FOUNDER, password, 'Founder'], { cwd: ROOT, env: { ...process.env, DATA_DIR: P.dataDir }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`create-user failed: ${r.stderr || r.stdout}`);
  const s = P.session();
  const l = await s.post('/api/auth/login', { email: FOUNDER, password });
  if (l.status !== 200) throw new Error(`founder login failed ${l.status} ${l.text}`);
  return s;
}

/** Days to the next Black Friday (the day after the fourth Thursday of November, UTC), like the site. */
function daysToBlackFriday(now = new Date()) {
  for (const y of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    const nov1 = new Date(Date.UTC(y, 10, 1));
    const bf = new Date(Date.UTC(y, 10, 1 + ((4 - nov1.getUTCDay() + 7) % 7) + 22));
    if (bf.getTime() + 864e5 > now.getTime()) return { bf, days: Math.max(0, Math.ceil((bf - now) / 864e5)) };
  }
}

describe('Public website', () => {
  let P, browser, boss;
  before(async () => {
    P = await startProduct({ env: { FREE_SCANS_PER_IP_PER_HOUR: '3', CAL_LINK: `https://cal.com/${CAL}`, CONTACT_EMAIL: 'hello@tharam.test' } });
    boss = await founder(P);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P?.stop(); });

  async function open(path, { viewport = DESKTOP, timezoneId } = {}) {
    const ctx = await browser.newContext({ viewport, ...(timezoneId && { timezoneId }) });
    const p = await ctx.newPage();
    p.errors = [];
    p.on('pageerror', (e) => p.errors.push(e.message));
    // The demo page loads the booking widget from cal.com: never reach the internet from tests.
    await p.route(/^https:\/\/(app\.)?cal\.com\//, (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.__calLoaded=true;' }));
    const res = await p.goto(P.base + path);
    p.status = res.status();
    return p;
  }
  const sideways = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  async function both(t, path, label, check) {
    for (const [name, viewport] of [['desktop', DESKTOP], ['phone', PHONE]]) {
      const p = await open(path, { viewport });
      assert.equal(p.status, 200, `${path} on ${name}`);
      if (check) await check(p, name);
      const over = await sideways(p);
      assert.ok(over <= 1, `${path} scrolls sideways by ${over}px on ${name}`);
      await screenshot(t, p, `${label}, ${name}`, { fullPage: true });
      assert.deepEqual(p.errors, [], `${path} script errors on ${name}`);
      await p.context().close();
    }
  }

  it('home: says what Tharam does, offers the free check and links to pricing and the sale page', async (t) => {
    const { days } = daysToBlackFriday();
    await both(t, '/', 'Home', async (p) => {
      assert.ok(await p.locator('h1').first().isVisible(), 'headline visible');
      assert.match(await p.title(), /Tharam/);
      assert.ok(await p.locator('#check-form input[name=url]').isVisible(), 'store address box visible');
      assert.ok((await p.locator('a[href="/pricing"]').count()) > 0, 'link to pricing');
      if (days <= 60) {
        const strip = p.locator('a.sale-strip');
        assert.equal(await strip.getAttribute('href'), '/sale-ready');
        assert.match(await strip.textContent(), new RegExp(days === 0 ? 'It’s Black Friday' : `${days} days? to Black Friday`));
      }
    });
    note(t, `Black Friday in ${days} days: ${days <= 60 ? 'countdown strip shown on home' : 'no strip yet (more than 60 days away)'}`);
  });

  it('home: the free check asks for an address before starting', async (t) => {
    const p = await open('/');
    await p.click('#check-form button');
    assert.match(await p.textContent('#check-err'), /Enter your store address/);
    await p.fill('#check-form input[name=url]', 'not a url at all');
    await p.click('#check-form button');
    await p.waitForFunction(() => document.getElementById('check-err').textContent.length > 0 && !document.querySelector('#check-form button').disabled);
    assert.match(await p.textContent('#check-err'), /valid URL|address/i);
    await screenshot(t, p, 'Free check refuses a bad address');
    assert.ok(new URL(p.url()).pathname === '/', 'stayed on home');
    note(t, `Empty and invalid addresses refused on the page: "${(await p.textContent('#check-err')).trim()}"`);
    await p.context().close();
  });

  it('pricing: plans and prices come from the founder console, in the visitor’s currency', async (t) => {
    const r = await P.session().get('/pricing');
    assert.equal(r.status, 200);
    for (const name of ['Starter', 'Growth', 'Pro']) assert.match(r.text, new RegExp(`<h3>${name}</h3>`));
    assert.match(r.text, /Free while we’re in beta/, 'beta headline while new signups start on the free beta');
    assert.match(r.text, /After the beta/, 'paid plans not sold during the beta');
    // Same list as the in-app plan picker.
    const api = (await P.session().get('/api/public/plans')).json.plans;
    for (const pl of api) assert.ok(r.text.includes(`<h3>${pl.name}</h3>`), `${pl.name} from /api/public/plans is on the page`);

    const cases = [
      ['Asia/Kolkata', 'INR', '₹1,499', '₹3,999', '₹7,999'],
      ['Europe/Berlin', 'EUR', '€19', '€45', '€89'],
      ['America/New_York', 'USD', '$19', '$49', '$99'],
    ];
    for (const [tz, cur, starter, growth, pro] of cases) {
      const p = await open('/pricing', { timezoneId: tz });
      assert.equal(await p.locator(`input[name=cur][value=${cur}]`).isChecked(), true, `${cur} chosen for ${tz}`);
      const prices = (await p.locator('.plan .pv').allTextContents()).map((s) => s.trim());
      assert.deepEqual(prices, [starter, growth, pro], `monthly prices in ${cur}`);
      const cells = (await p.locator('.pv-cell').allTextContents()).map((s) => s.trim());
      assert.deepEqual(cells, [starter, growth, pro], `comparison table in ${cur}`);
      await screenshot(t, p, `Pricing in ${cur} (${tz})`);
      assert.deepEqual(p.errors, []);
      note(t, `${tz}: ${cur} chosen, monthly ${prices.join(' / ')}`);
      await p.context().close();
    }

    // Yearly: ten months' price, shown per month and per year; switching currency by hand works.
    const p = await open('/pricing', { timezoneId: 'America/New_York' });
    await p.click('label:has(input[name=bill][value=y])');
    assert.equal((await p.locator('.plan .pv').first().textContent()).trim(), '$16');
    assert.match(await p.locator('.plan .pp').first().textContent(), /billed yearly/);
    assert.equal((await p.locator('.plan .py').first().textContent()).trim(), '$190 per store, per year');
    await p.click('label:has(input[name=cur][value=INR])');
    assert.equal((await p.locator('.plan .py').first().textContent()).trim(), '₹14,990 per store, per year');
    await screenshot(t, p, 'Pricing, yearly in INR');
    note(t, 'Yearly: Starter $16/month billed yearly, $190 per year; INR ₹14,990 per year');
    await p.context().close();
  });

  it('pricing: phone layout', async (t) => {
    const p = await open('/pricing', { viewport: PHONE, timezoneId: 'Asia/Kolkata' });
    assert.equal(await p.locator('.plan').count() >= 3, true);
    const over = await sideways(p);
    assert.ok(over <= 1, `pricing scrolls sideways by ${over}px on a phone`);
    await screenshot(t, p, 'Pricing on a phone', { fullPage: true });
    await p.context().close();
  });

  it('pricing: a founder price change, a hidden plan and the end of the beta show on the page at once', async (t) => {
    const ch = await boss.patch('/api/admin/plans/starter', { prices: { USD: { month: 2900, year: 29000 }, EUR: { month: 2700, year: 27000 }, INR: { month: 199900, year: 1999000 } } });
    assert.equal(ch.status, 200, ch.text);
    assert.equal((await boss.patch('/api/admin/plans/pro', { public: false })).status, 200);
    assert.equal((await boss.patch('/api/admin/settings', { signup_plan: 'trial' })).status, 200);
    try {
      const p = await open('/pricing', { timezoneId: 'America/New_York' });
      assert.deepEqual((await p.locator('.plan h3').allTextContents()).filter((n) => n !== 'Beta' && n !== 'Free trial'), ['Starter', 'Growth'], 'hidden Pro plan is gone');
      assert.equal((await p.locator('.plan .pv').first().textContent()).trim(), '$29');
      assert.doesNotMatch(await p.textContent('body'), /Free while we’re in beta/);
      assert.ok(await p.locator('a.btn:has-text("Choose Starter")').isVisible(), 'paid plans can be chosen after the beta');
      assert.equal(await p.locator('a.btn:has-text("Choose Starter")').getAttribute('href'), '/app#signup');
      await screenshot(t, p, 'Pricing after the founder changed plans');
      note(t, 'Starter raised to $29, Pro hidden, signups on the trial: page shows Starter $29, no Pro, "Choose Starter" buttons');
      // Plan picker in the app agrees.
      const api = (await P.session().get('/api/public/plans')).json.plans;
      assert.equal(api.find((x) => x.key === 'pro'), undefined);
      assert.equal(api.find((x) => x.key === 'starter').prices.USD.month, 2900);
      await p.context().close();
    } finally {
      await boss.patch('/api/admin/settings', { signup_plan: 'beta' });
      await boss.patch('/api/admin/plans/pro', { public: true });
      await boss.patch('/api/admin/plans/starter', { prices: { USD: { month: 1900, year: 19000 }, EUR: { month: 1900, year: 19000 }, INR: { month: 149900, year: 1499000 } } });
    }
    // Only founders change plans.
    const visitor = P.session();
    assert.equal((await visitor.patch('/api/admin/plans/starter', { prices: { USD: { month: 1 } } })).status, 401);
  });

  it('German page: in German, linked to the English home, with the free check', async (t) => {
    const r = await P.session().get('/de');
    assert.equal(r.status, 200);
    assert.match(r.text, /<html lang="de"/);
    assert.match(r.text, /hreflang="de" href="https:\/\/tharam\.store\/de"/);
    assert.match(r.text, /hreflang="en" href="https:\/\/tharam\.store\/"/);
    const home = (await P.session().get('/')).text;
    assert.match(home, /hreflang="de" href="https:\/\/tharam\.store\/de"/, 'English home points to the German page');
    await both(t, '/de', 'German home', async (p) => {
      assert.equal(await p.textContent('#check-form button'), 'Shop kostenlos prüfen');
      assert.equal(await p.getAttribute('#check-form input', 'placeholder'), 'ihrshop.de');
      assert.match(await p.textContent('body'), /Impressum/);
    });
    note(t, 'lang=de, hreflang de/en both ways, German form and Impressum text');
  });

  it('Black Friday page: the countdown and what gets checked before the sale', async (t) => {
    const { bf, days } = daysToBlackFriday();
    const a = await P.session().get('/black-friday');
    const b = await P.session().get('/sale-ready');
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const when = bf.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    assert.ok(b.text.includes(when), `shows the date ${when}`);
    assert.match(b.text, /Every price and sale price/);
    await both(t, '/black-friday', 'Black Friday page', async (p) => {
      assert.ok(await p.locator('h1').first().isVisible());
      assert.ok((await p.locator('a[href^="/app"], #check-form').count()) > 0, 'a way to start');
    });
    note(t, `Black Friday ${when}, ${days} days away; /black-friday and /sale-ready both open the page`);
  });

  it('checks page: lists every check in plain words', async (t) => {
    await both(t, '/checks', 'Every check we run', async (p) => {
      assert.equal((await p.textContent('h1')).trim(), 'Every check we run');
      const text = await p.textContent('main');
      for (const w of ['cart', 'checkout']) assert.match(text, new RegExp(w, 'i'));
    });
  });

  it('free scan: from the home page to a public report, then signing up from the report', async (t) => {
    const p = await open('/');
    await p.fill('#check-form input[name=url]', P.mock.origin);
    await p.click('#check-form button');
    // Free reports open by a random link, never by their run number.
    await p.waitForURL(/\/scan\/[a-f0-9]{32}$/, { timeout: 15000 });
    const runId = p.url().split('/').pop();
    await screenshot(t, p, 'Free check running');
    await p.waitForSelector('#signup', { timeout: 240000 });
    await screenshot(t, p, 'Free check report', { fullPage: true });
    const run = (await P.session().get(`/api/runs/${runId}`)).json;
    assert.equal(run.kind, 'free');
    assert.equal(run.status, 'done', run.error || '');
    assert.ok(run.result, 'report visible without signing in');
    note(t, `Free check ${runId} of ${run.url}: score ${run.score}, verdict ${run.verdict}`);

    // Same store again within the hour: the same report, no new check.
    const again = await P.session().post('/api/scan', { url: P.mock.origin });
    assert.equal(again.status, 200);
    assert.deepEqual([again.json.runId, again.json.cached], [runId, true]);

    // "Start monitoring" from the report saves a lead, makes the account and adds the store.
    const email = 'scan-signup@shop.test';
    await p.fill('#signup input[name=email]', email);
    await p.fill('#signup input[name=password]', 'a good long password');
    await p.click('#signup button');
    await p.waitForURL(/\/app/, { timeout: 15000 });
    const db = P.db();
    const lead = db.prepare('SELECT * FROM leads WHERE email = ?').get(email);
    assert.ok(lead, 'lead saved');
    assert.equal(lead.source, 'report');
    assert.equal(lead.run_id, db.prepare('SELECT id FROM runs WHERE public_id = ?').get(runId).id);
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    assert.ok(user, 'account created');
    const store = db.prepare('SELECT url FROM stores WHERE user_id = ?').get(user.id);
    assert.equal(store?.url, P.mock.origin, 'the scanned store is now monitored');
    note(t, `Signing up from the report saved lead ${lead.id} (source report, run ${runId}) and added ${store.url}`);
    await p.context().close();
  });

  it('free scan: three per visitor per hour, then a clear limit message; other visitors unaffected', async (t) => {
    const from = (ipAddr) => ({ 'x-forwarded-for': ipAddr });
    const s = P.session();
    // Unreachable shops: the checks fail quickly, but each still counts toward the limit.
    for (let i = 1; i <= 3; i++) {
      const r = await s.post('/api/scan', { url: `http://localhost:${i}` }, from('203.0.113.7'));
      assert.equal(r.status, 200, `scan ${i}: ${r.text}`);
      assert.ok(r.json.runId);
    }
    const fourth = await s.post('/api/scan', { url: 'http://localhost:4' }, from('203.0.113.7'));
    assert.equal(fourth.status, 429);
    assert.match(fourth.json.error, /free scan limit for this hour/);
    const other = await s.post('/api/scan', { url: 'http://localhost:5' }, from('198.51.100.20'));
    assert.equal(other.status, 200, 'another visitor can still scan');
    const n = P.db().prepare("SELECT COUNT(*) AS n FROM runs WHERE kind = 'free' AND requester_ip = '203.0.113.7'").get().n;
    assert.equal(n, 3, 'the refused scan started nothing');
    // Bad input never starts a check.
    for (const url of ['', 'not a url at all', 'http://']) {
      const r = await s.post('/api/scan', { url }, from('198.51.100.21'));
      assert.equal(r.status, 400, `"${url}" refused`);
      assert.ok(r.json.error);
    }
    note(t, `3 scans from 203.0.113.7 accepted, 4th refused (429: "${fourth.json.error}"), 198.51.100.20 still allowed; empty, nonsense and host-less addresses refused with 400`);
  });

  it('free scan: private network addresses are refused in production', async (t) => {
    // The test product allows local stores (ALLOW_LOCAL_TARGETS=1); the real server doesn't.
    const code = `import('./src/engine/browser.js').then(async (m) => { const out = {};
      for (const u of ['http://localhost:3000', 'http://127.0.0.1', 'http://10.0.0.5', 'http://192.168.1.1', 'https://shop.example.com']) {
        try { m.normalizeStoreUrl(u); out[u] = 'ok'; } catch (e) { out[u] = e.message; } }
      console.log(JSON.stringify(out)); })`;
    const env = { ...process.env };
    delete env.ALLOW_LOCAL_TARGETS;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: { ...env, DATA_DIR: P.dataDir }, encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    for (const u of ['http://localhost:3000', 'http://127.0.0.1', 'http://10.0.0.5', 'http://192.168.1.1']) assert.notEqual(out[u], 'ok', `${u} refused`);
    assert.equal(out['https://shop.example.com'], 'ok');
    note(t, JSON.stringify(out));
  });

  it('lead capture: early-access and review requests are saved and the founder is told', async (t) => {
    const s = P.session();
    const bad = await s.post('/api/leads', { email: 'not-an-email', source: 'managed-service' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /valid email/);

    const p = await open('/managed');
    const form = p.locator('form[data-waitlist="managed-service"]');
    await form.locator('input[name=email]').fill('brand@lead.test');
    if (await form.locator('input[name=url]').count()) await form.locator('input[name=url]').fill('https://brand.example.com');
    await form.locator('button').click();
    await p.waitForFunction(() => /on the list/.test(document.querySelector('form[data-waitlist="managed-service"] .wl-msg')?.textContent || ''));
    await screenshot(t, p, 'Managed service request sent');
    const lead = P.db().prepare("SELECT * FROM leads WHERE email = 'brand@lead.test'").get();
    assert.ok(lead, 'lead saved');
    assert.equal(lead.source, 'managed-service');
    // The founder hears about it (mail log in tests).
    const until = Date.now() + 5000;
    while (!/New lead: brand@lead\.test/.test(P.log()) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    assert.match(P.log(), /New lead: brand@lead\.test/);
    await p.context().close();

    // Platform early access (WooCommerce and others not live yet).
    const pl = await open('/platforms');
    const link = await pl.locator('a[href^="/platforms/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    let joined = null;
    for (const href of link) {
      const q = await open(href);
      const f = q.locator('form[data-waitlist^="platform-"]');
      if (await f.count()) {
        await f.locator('input[name=email]').fill('woo@lead.test');
        await f.locator('button').click();
        await q.waitForFunction(() => /on the list/.test(document.querySelector('form[data-waitlist] .wl-msg')?.textContent || ''));
        joined = await f.getAttribute('data-waitlist');
        await screenshot(t, q, `Early access joined (${joined})`);
        await q.context().close();
        break;
      }
      await q.context().close();
    }
    await pl.context().close();
    assert.ok(joined, 'at least one platform page offers early access');
    assert.equal(P.db().prepare("SELECT source FROM leads WHERE email = 'woo@lead.test'").get()?.source, joined);
    note(t, `Leads saved: managed-service (founder emailed), ${joined}; bad email refused`);
  });

  it('demo page: shows the booking calendar, and the contact email when booking is unavailable', async (t) => {
    const cfg = (await P.session().get('/api/public-config')).json;
    assert.deepEqual(cfg, { calLink: CAL, contactEmail: 'hello@tharam.test' });
    const p = await open('/demo');
    await p.waitForFunction(() => window.Cal && window.Cal.loaded);
    assert.ok(await p.locator('#cal').isVisible(), 'calendar area shown');
    assert.ok(await p.locator('#fallback').isHidden());
    await screenshot(t, p, 'Demo page with booking');
    await p.context().close();

    for (const [name, viewport] of [['desktop', DESKTOP], ['phone', PHONE]]) {
      const ctx = await browser.newContext({ viewport });
      const q = await ctx.newPage();
      await q.route('**/api/public-config', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ calLink: '', contactEmail: 'hello@tharam.test' }) }));
      await q.goto(`${P.base}/demo`);
      await q.waitForSelector('#fallback:not([hidden])');
      assert.equal(await q.textContent('#mail'), 'hello@tharam.test');
      assert.equal(await q.getAttribute('#mail', 'href'), 'mailto:hello@tharam.test');
      assert.ok(await q.locator('#cal').isHidden());
      await screenshot(t, q, `Demo page without booking, ${name}`);
      await ctx.close();
    }
    note(t, `Calendar loads for ${CAL}; without a booking link the page shows hello@tharam.test`);
  });

  it('unknown pages get a friendly 404', async (t) => {
    const p = await open('/no-such-page');
    assert.equal(p.status, 404);
    assert.match(await p.textContent('body'), /not found|can’t find|can't find/i);
    await screenshot(t, p, 'Page not found');
    await p.context().close();
  });
});
