// Laws where you sell: the Germany/Austria, EU cookie, accessibility and US privacy packs run only for the
// markets a store sells in, find what is missing in plain words, show "rules met" on the scorecard without
// changing the health score, and the German website page is served in German.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';
import { effectiveDisabled, normalizeConfig } from '../src/engine/catalog.js';

const check = (run, id) => run.result.checks.find((c) => c.id === id);
const ids = (run, prefix) => run.result.checks.filter((c) => c.id.startsWith(prefix)).map((c) => c.id);
const status = (run, prefix) => Object.fromEntries(run.result.checks.filter((c) => c.id.startsWith(prefix)).map((c) => [c.id, c.status]));
const GERMAN = ['law.de', 'law.cookies', 'access.law'];

async function launchBrowser() {
  return chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
}
async function ownerPage(browser, owner, viewport = { width: 1360, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  if (owner) await ctx.addCookies(owner.browserCookies());
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  return p;
}
const quiet = (p) => p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));

describe('Where you sell (markets setting)', () => {
  it('keeps only known markets, once each', () => {
    assert.deepEqual(normalizeConfig({ markets: ['DE', 'XX', 'US', 'DE', 42] }).markets, ['DE', 'US']);
    assert.deepEqual(normalizeConfig({ markets: [] }, { markets: ['DE'] }).markets, []);
    assert.deepEqual(normalizeConfig({ name: 'x' }, { markets: ['DE'] }).markets, ['DE'], 'untouched when not sent');
  });

  it('turns on only the packs for the markets a store sells in', (t) => {
    const off = (markets) => effectiveDisabled({ markets }).filter((k) => /^(law|access)\./.test(k)).sort();
    assert.deepEqual(off([]), ['access.law', 'law.cookies', 'law.de', 'law.us'], 'no markets: no regional packs');
    assert.deepEqual(off(['IN']), ['access.law', 'law.cookies', 'law.de', 'law.us'], 'India has no pack yet');
    assert.deepEqual(off(['DE']), ['law.us']);
    assert.deepEqual(off(['AT']), ['law.us']);
    assert.deepEqual(off(['UK']), ['law.de', 'law.us']);
    assert.deepEqual(off(['US']), ['law.cookies', 'law.de']);
    assert.deepEqual(off(['US', 'DE']), []);
    assert.ok(effectiveDisabled({ markets: ['DE'], disabled: ['law.cookies'] }).includes('law.cookies'), 'the owner can still switch a pack off');
    note(t, 'DE/AT: Germany pack, cookies, accessibility · UK: cookies, accessibility · US: accessibility, US privacy');
  });

  it('is saved on the store, and another account cannot change it', async (t) => {
    const P = await startProduct();
    try {
      const owner = await signup(P, 'markets@shop.test');
      const id = await addStore(P, owner, { runNow: false });
      const r = await owner.patch(`/api/stores/${id}`, { config: { markets: ['DE', 'AT', 'Mars'] } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.store.config.markets, ['DE', 'AT']);
      const other = await signup(P, 'markets-other@shop.test');
      assert.ok([403, 404].includes((await other.patch(`/api/stores/${id}`, { config: { markets: [] } })).status));
      assert.deepEqual((await owner.get(`/api/stores/${id}`)).json.store.config.markets, ['DE', 'AT']);
      note(t, 'saved DE, AT; unknown “Mars” dropped');
    } finally { await P.stop(); }
  });
});

describe('Germany: a store with its legal pages in order', () => {
  let P, owner, storeId, run, browser;
  before(async () => {
    P = await startProduct({ mock: { extra: 'de' } });
    owner = await signup(P, 'de-good@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    await owner.patch(`/api/stores/${storeId}`, { config: { markets: ['DE', 'AT'] } });
    browser = await launchBrowser();
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('meets the German rules, and flags the outdated EU dispute link', { timeout: 300000 }, async (t) => {
    run = await runAndWait(owner, storeId, { groups: GERMAN }, 280000);
    assert.equal(run.status, 'done', run.error || '');
    const de = status(run, 'de.');
    assert.deepEqual(de, { 'de.impressum': 'pass', 'de.withdrawal': 'pass', 'de.withdrawbutton': 'pass', 'de.legalpages': 'pass', 'de.odr': 'warn', 'de.priceinfo': 'pass' });
    assert.match(check(run, 'de.impressum').detail, /with an address and email/);
    assert.match(check(run, 'de.withdrawbutton').detail, /Vertrag widerrufen/);
    assert.match(check(run, 'de.odr').detail, /closed on 20 July 2025/);
    assert.equal(check(run, 'eu.tracking').status, 'pass', 'no trackers before consent');
    assert.equal(check(run, 'eu.banner').status, 'warn', 'no banner, but nothing tracks either');
    assert.equal(check(run, 'ax.statement').status, 'pass', 'Barrierefreiheit page linked');
    assert.deepEqual(ids(run, 'us.'), [], 'US pack not run');
    note(t, Object.entries({ ...de, ...status(run, 'eu.'), ...status(run, 'ax.') }).map(([k, v]) => `${k} ${v}`).join(', '));
  });

  it('the scorecard counts rules met for Germany and Austria together', async (t) => {
    const sc = (await owner.get(`/api/stores/${storeId}/scorecard`)).json;
    assert.equal(sc.rules.run.id, run.id);
    assert.equal(sc.rules.markets.length, 1, 'one pack for both countries');
    const m = sc.rules.markets[0];
    assert.equal(m.label, 'Germany and Austria');
    const lawChecks = run.result.checks.filter((c) => /^(de|eu|ax)\./.test(c.id) && c.status !== 'skip');
    assert.equal(m.total, lawChecks.length);
    assert.equal(m.met, lawChecks.filter((c) => c.status === 'pass').length);
    assert.ok(m.open.includes('No outdated EU dispute platform (ODR) link'));
    note(t, `${m.label}: ${m.met} of ${m.total} rules met; to fix: ${m.open.join('; ')}`);
  });

  it('home shows the rules met, and the report shows them as rules, not a score', async (t) => {
    const p = await ownerPage(browser, owner);
    await p.goto(`${P.base}/app#/s/${storeId}`);
    await p.waitForSelector('.kpis', { timeout: 20000 });
    await quiet(p);
    const home = await p.textContent('body');
    assert.match(home, /Laws where you sell/);
    assert.match(home, /Germany and Austria \d+\/\d+/);
    await screenshot(t, p, 'Home with rules met', { fullPage: true });
    await p.goto(`${P.base}/app#/s/${storeId}/reports/${run.id}`);
    await p.waitForSelector('.rtabs button', { timeout: 20000 });
    await quiet(p);
    assert.ok((await p.locator('.rules-met').count()) >= 1, 'rules met shown');
    assert.match(await p.locator('.rules-met').first().textContent(), /\d+ of \d+ rules met/);
    await screenshot(t, p, 'Report with rules met');
    assert.deepEqual(p.errors, []);
  });
});

describe('Germany: a store missing its legal pages', () => {
  let P, owner, storeId, run, good;
  before(async () => {
    P = await startProduct({ mock: { extra: 'track' } }); // English store with a Meta pixel, selling to Germany
    owner = await signup(P, 'de-bad@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    await owner.patch(`/api/stores/${storeId}`, { config: { markets: ['DE'] } });
  });
  after(async () => { await P.stop(); });

  it('lists every missing rule with what to do', { timeout: 300000 }, async (t) => {
    run = await runAndWait(owner, storeId, { groups: GERMAN }, 280000);
    assert.equal(run.status, 'done', run.error || '');
    assert.deepEqual(status(run, 'de.'), { 'de.impressum': 'fail', 'de.withdrawal': 'fail', 'de.withdrawbutton': 'fail', 'de.legalpages': 'warn', 'de.odr': 'pass', 'de.priceinfo': 'fail' });
    assert.match(check(run, 'de.impressum').fix, /Add an Impressum page/);
    assert.match(check(run, 'de.legalpages').detail, /terms \(AGB\)/);
    assert.match(check(run, 'de.priceinfo').detail, /include VAT/);
    for (const c of run.result.checks.filter((x) => x.id.startsWith('de.') && x.status !== 'pass')) assert.ok(c.fix, `${c.id} says what to do`);
    note(t, run.result.checks.filter((c) => c.id.startsWith('de.') && c.status !== 'pass').map((c) => `${c.title}: ${c.detail}`).join(' | '));
  });

  it('a pixel that fires before consent fails the cookie rules', (t) => {
    const tr = check(run, 'eu.tracking');
    assert.equal(tr.status, 'fail');
    assert.match(tr.detail, /Meta \(Facebook\) pixel/);
    assert.equal(check(run, 'eu.banner').status, 'fail', 'no banner while tracking');
    note(t, tr.detail);
  });

  it('missing legal pages never lower the health score or the verdict', { timeout: 300000 }, async (t) => {
    // Accessibility checks (access.law) do count towards the accessibility score, so compare the legal packs alone.
    const laws = await runAndWait(owner, storeId, { groups: ['law.de', 'law.cookies'] }, 280000);
    good = await runAndWait(owner, storeId, { groups: ['journey.core'] }, 280000);
    assert.equal(good.status, 'done');
    assert.ok(laws.result.checks.some((c) => c.id.startsWith('de.') && c.status === 'fail'), 'legal rules failing');
    assert.equal(laws.score, good.score, `with failing legal rules ${laws.score}, without ${good.score}`);
    assert.equal(laws.verdict, good.verdict);
    assert.notEqual(laws.verdict, 'critical');
    const sc = (await owner.get(`/api/stores/${storeId}/scorecard`)).json;
    assert.equal(sc.rules.markets[0].label, 'Germany');
    assert.ok(sc.rules.markets[0].open.length >= 5);
    assert.equal(sc.rules.run.id, laws.id, 'rules come from the last check that ran them, not the latest journey');
    note(t, `score ${laws.score} with failing legal rules = ${good.score} without; Germany ${sc.rules.markets[0].met}/${sc.rules.markets[0].total}`);
  });
});

describe('United States: privacy choices link', () => {
  for (const [extra, want] of [['us', 'pass'], ['', 'warn']]) {
    it(`${want === 'pass' ? 'a store with' : 'a store without'} the “Your privacy choices” link: ${want}`, { timeout: 300000 }, async (t) => {
      const P = await startProduct({ mock: { extra } });
      try {
        const owner = await signup(P, `us-${want}@shop.test`);
        const id = await addStore(P, owner, { runNow: false });
        await owner.patch(`/api/stores/${id}`, { config: { markets: ['US'] } });
        const run = await runAndWait(owner, id, { groups: ['law.us'] }, 280000);
        const c = check(run, 'us.optout');
        assert.equal(c.status, want, c.detail);
        if (want === 'warn') assert.match(c.fix, /Settings → Customer privacy/);
        assert.deepEqual([...ids(run, 'de.'), ...ids(run, 'eu.')], []);
        const sc = (await owner.get(`/api/stores/${id}/scorecard`)).json;
        assert.equal(sc.rules.markets[0].label, 'United States');
        assert.equal(sc.rules.markets[0].met, want === 'pass' ? 1 : 0);
        note(t, c.detail);
      } finally { await P.stop(); }
    });
  }
});

describe('No markets chosen', () => {
  it('no rule checks run and the scorecard shows no laws tile', { timeout: 300000 }, async (t) => {
    const P = await startProduct({ mock: { extra: 'de' } });
    try {
      const owner = await signup(P, 'nomarkets@shop.test');
      const id = await addStore(P, owner, { runNow: false });
      const run = await runAndWait(owner, id, { kind: 'journeys' }, 280000);
      assert.equal(run.status, 'done');
      assert.deepEqual([...ids(run, 'de.'), ...ids(run, 'eu.'), ...ids(run, 'us.')], []);
      const sc = (await owner.get(`/api/stores/${id}/scorecard`)).json;
      assert.deepEqual(sc.rules, { markets: [], run: null });
      note(t, 'no markets: rules = none');
    } finally { await P.stop(); }
  });
});

describe('German website page', () => {
  let P, browser;
  before(async () => { P = await startProduct(); browser = await launchBrowser(); });
  after(async () => { await browser?.close(); await P.stop(); });

  it('is served in German and linked to the English home page', async (t) => {
    const r = await fetch(`${P.base}/de`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<html[^>]+lang="de"/);
    assert.match(html, /Impressum/);
    assert.match(html, /Widerruf/);
    assert.match(html, /hreflang="en"/);
    assert.match(await (await fetch(`${P.base}/`)).text(), /hreflang="de"[^>]*\/de/);
    for (const viewport of [{ width: 1360, height: 900 }, { width: 390, height: 844 }]) {
      const p = await ownerPage(browser, null, viewport);
      await p.goto(`${P.base}/de`);
      await p.waitForLoadState('networkidle');
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `page scrolls sideways by ${overflow}px at ${viewport.width}px`);
      await screenshot(t, p, `German page ${viewport.width < 600 ? 'phone' : 'desktop'}`, { fullPage: viewport.width < 600 ? false : true });
      assert.deepEqual(p.errors, []);
    }
    note(t, `title: ${/<title>([^<]*)/.exec(html)?.[1]}`);
  });
});
