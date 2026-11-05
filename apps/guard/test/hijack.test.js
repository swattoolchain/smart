// Store hijack watch (S2): shoppers sent to another website, hidden pages from other websites, and
// cryptocurrency mining. Each is a critical (or, for an unknown hidden page, major) alert with evidence.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';
import { isOffSite, sameBusiness, MINER_RE, POOL_RE } from '../src/engine/hijack.js';
import { groupOf } from '../src/engine/catalog.js';

const find = (run, id) => run.result.checks.find((c) => c.id === id);
const mails = (P, re) => (P.log().match(new RegExp(`\\[mail skipped\\] to=[^\\n]* subject=[^\\n]*${re}`, 'g')) || []).length;
const waitMail = async (P, re) => { const until = Date.now() + 5000; while (!mails(P, re) && Date.now() < until) await new Promise((r) => setTimeout(r, 100)); return mails(P, re); };

describe('Redirects, hidden pages and mining', () => {
  let P, owner, storeId;
  const runs = {};
  const toggle = (q) => fetch(`${P.mock.origin}/__extra?${q}`).then((r) => r.json());
  // A critical failure is re-checked once a minute later before anyone is alerted (queue.js); that re-check can
  // still be running when the next test starts a check, so wait for it instead of failing on "already running".
  const journeys = async () => {
    for (let i = 0; ; i++) {
      try { const r = await runAndWait(owner, storeId, { kind: 'journeys' }); assert.equal(r.status, 'done', r.error || ''); return r; }
      catch (e) { if (!/409/.test(e.message) || i > 60) throw e; await new Promise((res) => setTimeout(res, 2000)); }
    }
  };
  const confirmRun = async (after) => {
    const until = Date.now() + 150000;
    while (Date.now() < until) {
      const runs = (await owner.get(`/api/stores/${storeId}/runs?limit=10`)).json.runs;
      const c = runs.find((x) => x.trigger === 'confirm' && x.id > after && ['done', 'error'].includes(x.status));
      if (c) return c;
      await new Promise((res) => setTimeout(res, 1000));
    }
    throw new Error('no re-check ran');
  };
  before(async () => {
    P = await startProduct({ env: { BAD_DOMAINS: 'evil-cdn.localhost' } });
    owner = await signup(P, 'hijack@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
  });
  after(async () => { await P?.stop(); });

  it('a healthy store passes all three, including the phone-from-Google visit', async (t) => {
    const r = runs.clean = await journeys();
    for (const id of ['sec.redirect', 'sec.frames', 'sec.mining']) assert.equal(find(r, id)?.status, 'pass', `${id}: ${find(r, id)?.detail}`);
    assert.match(find(r, 'sec.redirect').detail, /phone shopper arriving from Google/);
    assert.equal(r.verdict, 'healthy');
    note(t, ['sec.redirect', 'sec.frames', 'sec.mining'].map((id) => `${find(r, id).title}: ${find(r, id).detail}`).join('\n'));
  });

  it('a home page that sends every shopper to a scam site is critical, with the address and a screenshot', async (t) => {
    await toggle('redirect=1');
    try {
      const r = runs.redirect = await journeys();
      const c = find(r, 'sec.redirect');
      assert.equal(c.status, 'fail');
      assert.equal(c.severity, 'critical');
      assert.match(c.detail, /^Your home page sent our shopper to another website: http:\/\/prize-win\.localhost:\d+\/claim\./);
      assert.ok(!c.detail.includes('ref=store'), 'addresses are recorded without their query string');
      assert.equal(c.evidence.redirects[0].page, 'home');
      assert.match(c.evidence.redirects[0].from, /^http:\/\/localhost:\d+\/$/);
      assert.match(c.evidence.screenshot || '', /^\/shots\/run-\d+\/\d+-redirect-(desktop|phone)\.png$/);
      assert.equal(r.verdict, 'critical');
      assert.match(r.result.summary, /sending shoppers to another website/);
      // Re-checked a minute later (still redirecting), then one urgent alert email.
      assert.equal((await confirmRun(r.id)).verdict, 'critical');
      assert.equal(await waitMail(P, 'Urgent: Check failed on [^\\n]*Shoppers stay on your store'), 1, 'one alert email');
      note(t, `${c.title}: ${c.detail}\nFix: ${c.fix}`);
    } finally { await toggle('redirect=0'); }
  });

  it('when the redirect is gone the next check passes and a "fixed" email follows', async () => {
    const r = await journeys();
    assert.equal(find(r, 'sec.redirect').status, 'pass');
    assert.equal(await waitMail(P, 'Fixed[^\\n]*Shoppers stay on your store'), 1);
  });

  it('a redirect only for phone shoppers arriving from Google is caught by the extra phone visit', async (t) => {
    await toggle('phoneredirect=1');
    try {
      const r = await journeys();
      const c = find(r, 'sec.redirect');
      assert.equal(c.status, 'fail', c.detail);
      assert.match(c.detail, /^Your home page sent a phone shopper arriving from Google to another website: http:\/\/prize-win\.localhost:\d+\/claim/);
      assert.equal(c.evidence.redirects[0].device, 'phone');
      assert.equal(find(r, 'fn.home').status, 'pass', 'the desktop journey never saw it');
      note(t, c.detail);
    } finally { await toggle('phoneredirect=0'); }
  });

  it('a hidden page from an unknown website on product and cart pages is reported (major), with how it hides', async (t) => {
    await toggle('hiddenframe=1');
    try {
      const r = runs.frame = await journeys();
      const c = find(r, 'sec.frames');
      assert.equal(c.status, 'fail');
      assert.equal(c.severity, 'major');
      assert.match(c.detail, /stat-counter\.localhost:\d+\/f\.html \((product|cart) page, 1 × 1 pixels\)/);
      assert.ok(!c.detail.includes('id=7'));
      assert.deepEqual([...new Set(c.evidence.frames.map((f) => f.src.replace(/:\d+/, '')))], ['http://stat-counter.localhost/f.html'], 'the same page once, not once per visit');
      assert.equal(r.verdict, 'warning', 'major, not critical: some apps use hidden pages');
      note(t, c.detail);
    } finally { await toggle('hiddenframe=0'); }
  });

  it('a hidden page from a known malicious site is critical', async (t) => {
    await toggle('badframe=1');
    try {
      const r = await journeys();
      const c = find(r, 'sec.frames');
      assert.equal(c.status, 'fail');
      assert.equal(c.severity, 'critical');
      assert.match(c.detail, /known for stealing card details or mining: http:\/\/evil-cdn\.localhost:\d+\/f\.html \((product|cart) page, not shown at all\)/);
      assert.equal(r.verdict, 'critical');
      note(t, c.detail);
    } finally { await toggle('badframe=0'); }
  });

  it('mining code is critical, naming the script, the program and the pool connection', async (t) => {
    await toggle('miner=1');
    try {
      const r = runs.miner = await journeys();
      const c = find(r, 'sec.mining');
      assert.equal(c.status, 'fail');
      assert.equal(c.severity, 'critical');
      const signals = c.evidence.signals.map((s) => s.signal).join(' | ');
      assert.match(signals, /Mining code \(“CoinHive\.Anonymous”\)/);
      assert.match(signals, /A mining program \(CoinHive\) is running/);
      assert.match(signals, /Opens a connection to a mining pool/);
      assert.ok(c.evidence.signals.some((s) => /\/assets\/perf\.js$/.test(s.where) && s.page === 'home'));
      assert.ok(c.evidence.signals.some((s) => /^ws:\/\/pool\.minexmr\.localhost/.test(s.where)));
      assert.equal(r.verdict, 'critical');
      assert.match(r.result.summary, /mine cryptocurrency/);
      note(t, `${c.detail}\nFix: ${c.fix}`);
    } finally { await toggle('miner=0'); }
  });

  it('the report shows the alerts with how to fix them and the redirect screenshot', async (t) => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      await ctx.addCookies(owner.browserCookies());
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      for (const [key, id, label] of [['redirect', 'sec.redirect', 'Report: shoppers sent to another website'], ['miner', 'sec.mining', 'Report: cryptocurrency mining']]) {
        await p.goto(`${P.base}/app#/s/${storeId}/reports/${runs[key].id}`);
        await p.waitForSelector('[data-rtab=areas]', { timeout: 20000 });
        await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
        await p.click('[data-rtab=areas]');
        const row = p.locator(`tr[data-check="${id}"]`).first();
        await row.waitFor({ timeout: 10000 });
        assert.match(await row.textContent(), /How to fix:/);
        if (key === 'redirect') assert.equal(await row.locator('[data-shot]').count(), 1, 'screenshot button');
        await row.scrollIntoViewIfNeeded();
        await screenshot(t, p, label);
      }
      // The screenshot of the scam page, as the owner opens it.
      const shotUrl = find(runs.redirect, 'sec.redirect').evidence.screenshot;
      const img = await p.goto(`${P.base}${shotUrl}`);
      assert.equal(img.status(), 200);
      await screenshot(t, p, 'Evidence: where the shopper was sent');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  it('switching the group off in the test suite stops it', async () => {
    const pr = await owner.patch(`/api/stores/${storeId}`, { config: { disabled: ['security.hijack'] } });
    assert.equal(pr.status, 200, pr.text);
    const r = await journeys();
    assert.ok(!r.result.checks.some((c) => ['sec.redirect', 'sec.frames', 'sec.mining'].includes(c.id)));
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { config: { disabled: [] } })).status, 200);
  });

  it('what counts as another website, and what counts as mining', () => {
    assert.equal(isOffSite('prize-win.com', 'kaveri.com'), true);
    assert.equal(isOffSite('www.kaveri.com', 'kaveri.com'), false, 'www and the bare domain are the same store');
    assert.equal(isOffSite('kaveri.de', 'www.kaveri.com'), false, 'a country domain of the same store');
    assert.equal(isOffSite('checkout.shopify.com', 'kaveri.com'), false);
    assert.equal(isOffSite('shop.app', 'kaveri.com'), false);
    assert.equal(isOffSite('kaveri-2.myshopify.com', 'kaveri.com'), false);
    assert.equal(isOffSite('shop.other.com', 'shop.kaveri.com'), true, '"shop" alone does not make two sites the same');
    assert.equal(sameBusiness('kaveri.co.uk', 'kaveri.com'), true);
    assert.ok(MINER_RE.test('var m = new CoinHive.Anonymous("key")'));
    assert.ok(MINER_RE.test('new Client.Anonymous("abc", {c: "w"})'));
    assert.ok(!MINER_RE.test('window.Shopify.analytics.publish("page_viewed")'));
    assert.ok(POOL_RE.test('wss://pool.supportxmr.com:443'));
    assert.ok(POOL_RE.test('ws://1.2.3.4:3333/'));
    assert.ok(!POOL_RE.test('wss://chat.example.com/socket'));
    assert.equal(groupOf('sec.redirect'), 'security.hijack');
    assert.equal(groupOf('sec.mining'), 'security.hijack');
  });
});
