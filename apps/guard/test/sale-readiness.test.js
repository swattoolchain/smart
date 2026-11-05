// Sale readiness (T23): one report before a sale (buying, every price, discount codes, phone speed, script errors,
// laws where you sell, looks), built from a full check, with an emailable summary.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-sale-unit-'));
const { readinessFrom, saleEmail, SECTIONS } = await import('../src/sale-readiness.js');

const c = (id, status = 'pass', severity = 'major', extra = {}) => ({ id, category: 'functional', title: `Check ${id}`, status, severity, detail: `Detail of ${id}`, fix: status === 'pass' ? '' : `Fix ${id}`, ...extra });
const ALL_PASS = ['fn.home', 'fn.pdp', 'fn.atc', 'fn.cart', 'fn.checkout', 'cat.pricing', 'cat.content', 'fn.discount.bf20', 'nf.speed.home', 'nf.jserrors', 'us.optout', 'nf.visual'].map((id) => c(id));
const sec = (r, key) => r.sections.find((s) => s.key === key);
const mails = (P, re) => (P.log().match(new RegExp(`\\[mail skipped\\] to=[^\\n]* subject=[^\\n]*${re}`, 'g')) || []);

async function openSale(P, owner, storeId, fn) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#/s/${storeId}/sale`);
    await p.waitForSelector('#sale-run', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    await fn(p);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

describe('Sale readiness', () => {
  it('answers seven questions from one check: ready, needs attention, fix first, not checked', () => {
    assert.deepEqual(SECTIONS.map((s) => s.key), ['buying', 'prices', 'codes', 'speed', 'errors', 'laws', 'looks']);
    let r = readinessFrom({ checks: ALL_PASS, catalog: { count: 42 } });
    assert.equal(r.verdict, 'ready');
    assert.equal(r.headline, 'Ready for your sale.');
    assert.ok(r.sections.every((s) => s.status === 'ready'));
    assert.match(sec(r, 'prices').summary, /^42 products checked\./);
    assert.match(sec(r, 'laws').summary, /^1 of 1 rules met/);

    // A sale code that stops working is a blocker even though it's not "critical": the sale depends on it.
    r = readinessFrom({ checks: ALL_PASS.map((x) => (x.id === 'fn.discount.bf20' ? c(x.id, 'fail') : x)) });
    assert.equal(sec(r, 'codes').status, 'blocker');
    assert.equal(r.verdict, 'blocked');
    assert.equal(r.headline, 'Fix 1 thing before your sale.');
    assert.equal(sec(r, 'codes').items[0].fix, 'Fix fn.discount.bf20');

    // A zero price or fake discount is a blocker too: the sale sends many more shoppers to it.
    r = readinessFrom({ checks: ALL_PASS.map((x) => (x.id === 'cat.pricing' ? c(x.id, 'fail', 'major') : x.id === 'cat.content' ? c(x.id, 'warn', 'minor') : x)) });
    assert.equal(sec(r, 'prices').status, 'blocker');
    assert.equal(sec(r, 'prices').items[0].id, 'cat.pricing', 'failures listed before warnings');

    // A slow phone page is something to look at, not a blocker.
    r = readinessFrom({ checks: ALL_PASS.map((x) => (x.id === 'nf.speed.home' ? c(x.id, 'warn') : x)) });
    assert.equal(sec(r, 'speed').status, 'attention');
    assert.equal(r.verdict, 'attention');
    assert.match(r.headline, /^Almost ready: 1 area to look at/);

    // A critical failure anywhere (here: add to cart) means fix first.
    r = readinessFrom({ checks: ALL_PASS.map((x) => (x.id === 'fn.atc' ? c(x.id, 'fail', 'critical') : x)) });
    assert.equal(sec(r, 'buying').status, 'blocker');

    // No codes and no markets: those areas say how to get them checked; skipped checks don't count.
    r = readinessFrom({ checks: [...ALL_PASS.filter((x) => !/^(fn\.discount|us\.)/.test(x.id)), c('nf.speed.product', 'skip')] });
    assert.equal(sec(r, 'codes').status, 'not_checked');
    assert.match(sec(r, 'codes').summary, /Add your sale codes/);
    assert.equal(sec(r, 'laws').status, 'not_checked');
    assert.equal(r.verdict, 'partial');
    assert.equal(r.counts.notChecked, 2);
  });

  it('the email says the verdict in the subject and lists what to fix', () => {
    const r = { store: { name: 'Kurta Co', url: 'https://kurta.example' }, checkedAt: '2026-11-05T09:00:00Z', reportUrl: 'https://tharam.store/app#/s/1/reports/9', pageUrl: 'https://tharam.store/app#/s/1/sale',
      ...readinessFrom({ checks: ALL_PASS.map((x) => (x.id === 'cat.pricing' ? c(x.id, 'fail', 'critical', { title: 'Prices are right', detail: '1 product <b>priced</b> at zero' }) : x)) }) };
    const m = saleEmail(r);
    assert.equal(m.subject, 'Sale readiness for Kurta Co: fix 1 thing first');
    assert.match(m.text, /🔴 Every price is right: Fix before the sale/);
    assert.match(m.text, /Prices are right: 1 product <b>priced<\/b> at zero\n\s+Fix: Fix cat\.pricing/);
    assert.match(m.text, /Full report with screenshots: https:\/\/tharam\.store\/app#\/s\/1\/reports\/9/);
    assert.ok(m.html.includes('1 product &lt;b&gt;priced&lt;/b&gt; at zero'), 'store text is escaped in the HTML email');
    assert.ok(!m.html.includes('<b>priced</b>'));
  });

  describe('in the product', () => {
    let P, owner, other, storeId;
    before(async () => {
      P = await startProduct();
      owner = await signup(P, 'sale@shop.test');
      other = await signup(P, 'nosy@shop.test');
      storeId = await addStore(P, owner, { runNow: false });
    });
    after(async () => { await P?.stop(); });

    it('before a full check: the page offers to run one, and the API says which validations it runs', async (t) => {
      const r = await owner.get(`/api/stores/${storeId}/sale-readiness`);
      assert.equal(r.status, 404);
      for (const g of ['journey.core', 'journey.checkout', 'catalog', 'sale.discount', 'speed', 'errors.js', 'visual']) assert.ok(r.json.groups.includes(g), g);
      assert.ok(!r.json.groups.some((g) => g.startsWith('law.')), 'no markets set: no law packs');
      await openSale(P, owner, storeId, async (p) => {
        assert.match(await p.textContent('.main-inner'), /No full check yet/);
        await screenshot(t, p, 'Sale readiness before a full check');
        // The button opens Run validations with the Sale readiness preset chosen.
        await p.click('#sale-run');
        await p.waitForSelector('input[name=preset]', { timeout: 20000 });
        const picked = await p.$$eval('input[name=g]:checked', (els) => els.map((e) => e.value));
        for (const g of ['sale.discount', 'catalog', 'speed', 'visual']) assert.ok(picked.includes(g), `${g} selected`);
        assert.ok(!picked.includes('seo'), 'nothing outside the sale preset');
      });
    });

    it('a sale readiness check on a store with a zero price: fix first, with each area answered', async (t) => {
      assert.equal((await owner.patch(`/api/stores/${storeId}`, { config: { discountCodes: [{ code: 'BF20', percent: 20 }], markets: ['US'] } })).status, 200);
      const groups = (await owner.get(`/api/stores/${storeId}/sale-readiness`)).json.groups;
      assert.ok(groups.includes('law.us') && !groups.includes('law.de'), 'law packs follow where the store sells');
      const run = await runAndWait(owner, storeId, { groups });
      assert.equal(run.status, 'done', run.error || '');
      const r = await owner.get(`/api/stores/${storeId}/sale-readiness`);
      assert.equal(r.status, 200, r.text);
      const d = r.json;
      assert.equal(d.runId, run.id);
      assert.equal(d.verdict, 'blocked');
      assert.equal(sec(d, 'prices').status, 'blocker', 'the mock store sells a product at ₹0');
      assert.ok(sec(d, 'prices').items.some((i) => i.id === 'cat.pricing'));
      assert.equal(sec(d, 'codes').status, 'ready', 'BF20 takes 20% off');
      assert.equal(sec(d, 'buying').status, 'ready');
      assert.notEqual(sec(d, 'laws').status, 'not_checked', 'US rules checked for a store selling in the US');
      assert.notEqual(sec(d, 'speed').status, 'not_checked');
      assert.equal(d.recipient, 'sale@shop.test');
      note(t, `${d.headline} ${d.sections.map((s) => `${s.title}: ${s.label}`).join('; ')}`);
      await openSale(P, owner, storeId, async (p) => {
        assert.match(await p.textContent('.sale-verdict'), /Not ready/);
        assert.match(await p.textContent('[data-sec=prices]'), /Fix before the sale/);
        assert.match(await p.textContent('[data-sec=codes]'), /Ready/);
        await screenshot(t, p, 'Sale readiness: fix first', { fullPage: true });
        await p.setViewportSize({ width: 390, height: 844 });
        await p.reload();
        await p.waitForSelector('.sale-verdict', { timeout: 20000 });
        await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
        await p.waitForTimeout(400);
        await screenshot(t, p, 'Sale readiness on a phone', { fullPage: true });
      });
    });

    it('"Email me this summary" sends it to the alert email, at most 5 times an hour', async (t) => {
      await openSale(P, owner, storeId, async (p) => {
        await p.click('#sale-email');
        await p.waitForSelector('.toast', { timeout: 10000 });
        assert.match(await p.textContent('.toast'), /Sent to sale@shop\.test/);
      });
      const sent = mails(P, 'Sale readiness for Mock Store: fix 1 thing first');
      assert.equal(sent.length, 1);
      assert.match(sent[0], /to=sale@shop\.test/);
      assert.match(P.log(), /🔴 Every price is right: Fix before the sale/);
      for (let i = 0; i < 4; i++) assert.equal((await owner.post(`/api/stores/${storeId}/sale-readiness/email`, {})).status, 200);
      const sixth = await owner.post(`/api/stores/${storeId}/sale-readiness/email`, {});
      assert.equal(sixth.status, 429);
      assert.match(sixth.json.error, /5 times in the last hour/);
      note(t, `Subject: ${sent[0].replace(/.*subject=/, '')}`);
    });

    it('a journeys-only check later does not replace the full sale report', async () => {
      const before = (await owner.get(`/api/stores/${storeId}/sale-readiness`)).json.runId;
      const j = await runAndWait(owner, storeId, { kind: 'journeys' });
      assert.equal(j.status, 'done');
      assert.equal((await owner.get(`/api/stores/${storeId}/sale-readiness`)).json.runId, before);
      // …but asking for that run by id still works, with fewer areas checked.
      const r = (await owner.get(`/api/stores/${storeId}/sale-readiness?run=${j.id}`)).json;
      assert.equal(r.runId, j.id);
      assert.equal(sec(r, 'prices').status, 'not_checked');
    });

    it('other accounts and signed-out visitors are refused; runs of other stores are not found', async () => {
      for (const s of [other, P.session()]) {
        assert.ok([401, 403, 404].includes((await s.get(`/api/stores/${storeId}/sale-readiness`)).status));
        assert.ok([401, 403, 404].includes((await s.post(`/api/stores/${storeId}/sale-readiness/email`, {})).status));
      }
      const mine = await addStore(P, other, { runNow: false });
      const runId = (await owner.get(`/api/stores/${storeId}/sale-readiness`)).json.runId;
      assert.equal((await other.get(`/api/stores/${mine}/sale-readiness?run=${runId}`)).status, 404, "another store's run can't be read through your own store");
      assert.equal((await owner.get(`/api/stores/${storeId}/sale-readiness?run=abc`)).status, 404);
    });
  });
});
