// Discount codes and sale mode: each saved code is applied to a real cart and the price must really drop,
// a code with a minimum order is retried on a bigger cart, broken codes fail with a screenshot, Shopify
// stores get their active codes automatically, and sale mode (set by the founder) raises the check frequency
// until its end date, for at most 31 days.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait, shopifyOpen, ROOT, FOUNDER } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const check = (run, id) => run.result.checks.find((c) => c.id === id);
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

/** Signs in as the founder (ADMIN_EMAIL in the harness), created with the same script the owner uses on the server. */
async function founder(P, password = 'founder-test-password') {
  const r = spawnSync(process.execPath, ['scripts/create-user.js', FOUNDER, password, 'Founder'], { cwd: ROOT, env: { ...process.env, DATA_DIR: P.dataDir }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`create-user failed: ${r.stderr || r.stdout}`);
  const s = P.session();
  const l = await s.post('/api/auth/login', { email: FOUNDER, password });
  if (l.status !== 200) throw new Error(`founder login failed ${l.status} ${l.text}`);
  return s;
}

async function launchBrowser() {
  return chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
}
async function ownerPage(browser, owner) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addCookies(owner.browserCookies());
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  return p;
}
const quiet = (p) => p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));

describe('Discount code settings', () => {
  let P, owner, storeId;
  before(async () => {
    P = await startProduct();
    owner = await signup(P, 'codes-settings@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
  });
  after(async () => { await P.stop(); });

  const save = (codes) => owner.patch(`/api/stores/${storeId}`, { config: { discountCodes: codes } });

  it('saves up to 5 codes, without duplicates, with an optional expected percentage', async (t) => {
    const r = await save([{ code: 'BF20', percent: 20 }, { code: 'bf20', percent: 10 }, { code: 'MIN5000', percent: '' }, 'A1', 'A2', 'A3', 'A4']);
    assert.equal(r.status, 200);
    const codes = r.json.store.config.discountCodes;
    assert.deepEqual(codes.map((c) => c.code), ['BF20', 'MIN5000', 'A1', 'A2']);
    assert.equal(codes[0].percent, 20);
    assert.equal(codes[1].percent, null);
    note(t, `saved: ${codes.map((c) => c.code + (c.percent ? ` (${c.percent}%)` : '')).join(', ')}`);
  });

  it('refuses a code with spaces or symbols, and an expected discount outside 1–99%', async (t) => {
    const bad = await save([{ code: 'BLACK FRIDAY' }]);
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /isn’t a valid code/);
    const pct = await save([{ code: 'BF20', percent: 150 }]);
    assert.equal(pct.status, 400);
    assert.match(pct.json.error, /between 1 and 99%/);
    const kept = (await owner.get(`/api/stores/${storeId}`)).json.store.config.discountCodes;
    assert.equal(kept.length, 4, 'a refused save changes nothing');
    note(t, `${bad.json.error} / ${pct.json.error}`);
  });

  it('another account cannot change this store’s codes', async () => {
    const other = await signup(P, 'codes-other@shop.test');
    const r = await other.patch(`/api/stores/${storeId}`, { config: { discountCodes: [{ code: 'HACK' }] } });
    assert.ok([403, 404].includes(r.status), `got ${r.status}`);
  });
});

describe('Discount codes in a full check', () => {
  let P, owner, storeId, run, browser;
  before(async () => {
    P = await startProduct();
    owner = await signup(P, 'codes@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    browser = await launchBrowser();
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('a working code passes and the amount taken off is right', { timeout: 300000 }, async (t) => {
    await owner.patch(`/api/stores/${storeId}`, { config: { discountCodes: [{ code: 'BF20', percent: 20 }, { code: 'MIN5000' }, { code: 'NOPE10' }] } });
    run = await runAndWait(owner, storeId, { groups: ['sale.discount'] }, 280000);
    assert.equal(run.status, 'done', run.error || '');
    const c = check(run, 'fn.discount.bf20');
    assert.equal(c.status, 'pass', c.detail);
    assert.match(c.detail, /BF20 took ₹299\.80 off a cart of ₹1,499 \(20%\)/);
    note(t, c.detail);
  });

  it('a code with a minimum order is retried on a bigger cart and passes with a warning', (t) => {
    const c = check(run, 'fn.discount.min5000');
    assert.equal(c.status, 'warn', c.detail);
    assert.match(c.detail, /₹1,499 off a cart of ₹14,990 \(10%\)/);
    assert.match(c.detail, /needs a minimum order/);
    assert.match(c.fix, /mention the minimum/);
    note(t, c.detail);
  });

  it('a code that does nothing fails, with a screenshot of the cart and what to check', (t) => {
    const c = check(run, 'fn.discount.nope10');
    assert.equal(c.status, 'fail');
    assert.match(c.detail, /NOPE10 didn’t reduce the price/);
    assert.match(c.fix, /Shopify → Discounts/);
    assert.ok(c.evidence?.screenshot, 'screenshot attached');
    note(t, c.detail);
  });

  it('a code that takes off a different amount than expected fails', { timeout: 300000 }, async (t) => {
    await owner.patch(`/api/stores/${storeId}`, { config: { discountCodes: [{ code: 'BF20', percent: 30 }] } });
    const r = await runAndWait(owner, storeId, { groups: ['sale.discount'] }, 280000);
    const c = check(r, 'fn.discount.bf20');
    assert.equal(c.status, 'fail', c.detail);
    assert.match(c.detail, /You expected 30% off/);
    note(t, c.detail);
  });

  it('the Discount codes page and the report show the results', async (t) => {
    const p = await ownerPage(browser, owner);
    await p.goto(`${P.base}/app#/s/${storeId}/suite/codes`);
    await p.waitForSelector('#codes .code-row', { timeout: 20000 });
    await quiet(p);
    assert.equal(await p.inputValue('#dc0'), 'BF20');
    await screenshot(t, p, 'Discount codes settings');
    await p.goto(`${P.base}/app#/s/${storeId}/reports/${run.id}`);
    await p.waitForSelector('.rtabs button, .check', { timeout: 20000 });
    await quiet(p);
    const text = await p.textContent('body');
    assert.match(text, /Discount code NOPE10 works/);
    assert.match(text, /Discount code BF20 works/);
    await screenshot(t, p, 'Report with discount code results', { fullPage: true });
    assert.deepEqual(p.errors, []);
  });
});

describe('A discount code that stopped working', () => {
  let P, owner, storeId;
  before(async () => {
    P = await startProduct({ mock: { breaks: 'discount' } }); // BF20 no longer applies (expired, or a discount app broke it)
    owner = await signup(P, 'codes-broken@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
  });
  after(async () => { await P.stop(); });

  it('fails, while the other codes still pass', { timeout: 300000 }, async (t) => {
    await owner.patch(`/api/stores/${storeId}`, { config: { discountCodes: [{ code: 'BF20', percent: 20 }, { code: 'MIN5000' }] } });
    const run = await runAndWait(owner, storeId, { groups: ['sale.discount'] }, 280000);
    const bf = check(run, 'fn.discount.bf20');
    assert.equal(bf.status, 'fail', bf.detail);
    assert.match(bf.detail, /even on a cart of ₹14,990 with 10 × “Organic Cotton Kurta”/);
    assert.match(bf.detail, /expired/);
    assert.ok(bf.evidence?.screenshot);
    assert.equal(check(run, 'fn.discount.min5000').status, 'warn');
    note(t, bf.detail);
  });
});

describe('Discount codes on a Shopify store', () => {
  let P, owner;
  before(async () => {
    P = await startProduct();
    owner = await shopifyOpen(P);
  });
  after(async () => { await P.stop(); });

  it('the store’s active Shopify codes are checked without typing them in', { timeout: 300000 }, async (t) => {
    const run = await runAndWait(owner, owner.storeId, { groups: ['sale.discount'] }, 280000);
    assert.equal(run.status, 'done', run.error || '');
    const c = check(run, 'fn.discount.bf20');
    assert.ok(c, `BF20 picked up from Shopify; checks: ${run.result.checks.map((x) => x.id).join(', ')}`);
    assert.equal(c.status, 'pass', c.detail);
    assert.equal((await owner.get(`/api/stores/${owner.storeId}`)).json.store.config.discountCodes.length, 0, 'nothing was saved; codes are read fresh each check');
    note(t, c.detail);
  });
});

describe('Sale mode', () => {
  let P, boss, owner, storeId, browser;
  before(async () => {
    P = await startProduct();
    boss = await founder(P);
    owner = await signup(P, 'sale@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    browser = await launchBrowser();
  });
  after(async () => { await browser?.close(); await P.stop(); });

  const store = async () => (await owner.get(`/api/stores/${storeId}`)).json.store;
  const setSale = (until, s = boss) => s.post(`/api/admin/stores/${storeId}/sale`, { until });

  it('is off by default: checks follow the plan', async (t) => {
    const c = (await store()).config;
    assert.equal(c.saleUntil, null);
    assert.ok(c.journeyIntervalMin >= 60, `journey interval ${c.journeyIntervalMin}`);
    note(t, `journeys every ${c.journeyIntervalMin} min, full check every ${c.fullIntervalMin} min`);
  });

  it('only the founder can switch it on', async () => {
    const r = await setSale(day(3), owner);
    assert.equal(r.status, 403);
    assert.equal((await store()).config.saleUntil, null);
  });

  it('refuses an end date in the past, more than 31 days away, or not a real date', async (t) => {
    for (const [until, re] of [[day(-2), /has passed/], [day(40), /up to 31 days/], ['2026-02-30', /valid end date/], ['next friday', /valid end date/]]) {
      const r = await setSale(until);
      assert.equal(r.status, 400, until);
      assert.match(r.json.error, re);
    }
    assert.equal((await store()).config.saleUntil, null);
    note(t, 'past date, 40 days, 30 February and free text are all refused');
  });

  it('switched on, shopping checks run every 30 minutes and a full check every 6 hours', async (t) => {
    const until = day(10);
    const r = await setSale(until);
    assert.equal(r.status, 200);
    const c = (await store()).config;
    assert.equal(c.saleUntil, until);
    assert.equal(c.journeyIntervalMin, 30);
    assert.equal(c.fullIntervalMin, 360);
    assert.equal(c.sale, true);
    const audit = P.db().prepare("SELECT action, detail_json FROM audit WHERE action = 'store.sale' ORDER BY id DESC LIMIT 1").get();
    assert.ok(audit, 'audit entry written');
    assert.match(audit.detail_json, new RegExp(until));
    note(t, `on until ${until}: journeys every ${c.journeyIntervalMin} min, full every ${c.fullIntervalMin} min`);
  });

  it('31 days is the longest allowed', async () => {
    assert.equal((await setSale(day(30))).status, 200);
    assert.equal((await store()).config.saleUntil, day(30));
  });

  it('home tells the owner sale mode is on and until when', async (t) => {
    await owner.patch(`/api/stores/${storeId}`, { config: { discountCodes: [{ code: 'BF20' }] } });
    const p = await ownerPage(browser, owner);
    await p.goto(`${P.base}/app#/s/${storeId}`);
    await p.waitForSelector('.notice.sale-n', { timeout: 20000 });
    await quiet(p);
    const text = await p.textContent('.notice.sale-n');
    assert.match(text, /Sale mode is on until/);
    assert.match(text, /every 30 minutes/);
    assert.match(text, /including your discount code/);
    await screenshot(t, p, 'Home with sale mode on');
    note(t, text.trim());
  });

  it('switched off, checks go back to the plan', async () => {
    const r = await setSale(null);
    assert.equal(r.status, 200);
    const c = (await store()).config;
    assert.equal(c.saleUntil, null);
    assert.ok(c.journeyIntervalMin >= 60);
    assert.equal(c.sale, undefined);
  });
});

describe('Sale mode end date', () => {
  // saleActive is the single rule every schedule uses; it ends at the close of the chosen day (UTC).
  let saleActive;
  before(async () => {
    process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-sale-'));
    ({ saleActive } = await import('../src/scheduler.js'));
  });

  it('is on through the end date and off the day after', (t) => {
    assert.equal(saleActive({ saleUntil: day(0) }), true, 'still on during the last day');
    assert.equal(saleActive({ saleUntil: day(5) }), true);
    assert.equal(saleActive({ saleUntil: day(-1) }), false, 'off once the end date has passed');
    assert.equal(saleActive({}), false);
    assert.equal(saleActive({ saleUntil: 'soon' }), false, 'a malformed date never turns it on');
    note(t, `today ${day(0)} on, yesterday ${day(-1)} off`);
  });
});
