// Security watch S6: store data tampering (free products, mass price edits, swapped products, new discount codes).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { startMock, startProduct, signup, addStore, runAndWait, ROOT } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.ALLOW_LOCAL_TARGETS = '1';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-tamper-'));
const { runScan } = await import('../src/engine/index.js');
const { getBrowser } = await import('../src/engine/browser.js');
const { findTampering, tamperCheck } = await import('../src/engine/tamper.js');
const { Recorder } = await import('../src/engine/checks.js');
const { groupOf } = await import('../src/engine/catalog.js');

const P = (id, title, prices, extra = {}) => ({ id, handle: `p${id}`, title, textHash: `t${id}`, images: 1, variants: prices.map((price, i) => ({ id: id * 100 + i, title: `V${i}`, price })), ...extra });
const snap = (products, codes) => ({ currency: 'INR', products, codes });
const catalog = () => [P(1, 'Organic Cotton Kurta', [1499, 1599]), P(2, 'Handwoven Silk Saree', [8999]), P(3, 'Brass Diya Set', [499]), P(4, 'Jute Tote Bag', [299]), P(5, 'Block Print Scarf', [799]), P(6, 'Copper Water Bottle', [999]), P(7, 'Cane Basket', [650]), P(8, 'Clay Planter', [350]), P(9, 'Linen Cushion', [550]), P(10, 'Wooden Comb', [199])];
const kinds = (r) => r.found.map((f) => `${f.kind}:${f.severity}`).sort();

describe('Tampering: the rules', () => {
  it('nothing changed: nothing found', () => {
    assert.deepEqual(findTampering(snap(catalog(), []), snap(catalog(), [])).found, []);
  });

  it('the first check only saves the catalog', () => {
    assert.equal(findTampering(snap(catalog(), []), null), null);
    const rec = new Recorder();
    tamperCheck({ rec, result: null });
    assert.equal(rec.checks[0].status, 'pass');
    assert.equal(rec.checks[0].notice, true, 'a notice: news once, never "recovered"');
  });

  it('a product made free is caught with before and after', (t) => {
    const now = catalog(); now[0].variants[1].price = 0;
    const r = findTampering(snap(now), snap(catalog()));
    assert.deepEqual(kinds(r), ['free:fail']);
    assert.equal(r.found[0].before, '₹1,599');
    assert.equal(r.found[0].after, '₹0');
    note(t, r.found[0].message);
  });

  it('one or two honest price edits are not a mass edit', () => {
    const now = catalog(); now[1].variants[0].price = 7999; now[2].variants[0].price = 549;
    assert.deepEqual(findTampering(snap(now), snap(catalog())).found, []);
  });

  it('many prices changed at once is worth a look; many cut by half or more is a problem', (t) => {
    const up = catalog().map((p) => ({ ...p, variants: p.variants.map((v) => ({ ...v, price: Math.round(v.price * 1.1) })) }));
    assert.deepEqual(kinds(findTampering(snap(up), snap(catalog()))), ['mass:warn']);
    const cut = catalog().map((p) => ({ ...p, variants: p.variants.map((v) => ({ ...v, price: Math.round(v.price / 10) })) }));
    const r = findTampering(snap(cut), snap(catalog()));
    assert.deepEqual(kinds(r), ['mass:fail']);
    assert.match(r.found[0].message, /10 products of 10 .* cut by half or more/);
    note(t, r.found[0].message);
  });

  it('a product replaced by another at the same address is caught; a small rename is not', (t) => {
    const now = catalog(); now[1] = { ...now[1], title: 'Prepaid Gift Card Bundle', textHash: 'other' };
    const r = findTampering(snap(now), snap(catalog()));
    assert.deepEqual(kinds(r), ['swap:fail']);
    assert.equal(r.found[0].before, 'Handwoven Silk Saree');
    note(t, r.found[0].message);
    const renamed = catalog(); renamed[1] = { ...renamed[1], title: 'Handwoven Silk Saree – Red', textHash: 'edited' };
    assert.deepEqual(findTampering(snap(renamed), snap(catalog())).found, []);
  });

  it('two products swapping titles is caught', () => {
    const now = catalog(); [now[3].title, now[4].title] = [now[4].title, now[3].title];
    assert.deepEqual(kinds(findTampering(snap(now), snap(catalog()))), ['swap:fail', 'swap:fail']);
  });

  it('a new big discount code is a problem, a new small one worth a look, known codes nothing', (t) => {
    const prev = snap(catalog(), [{ code: 'BF20', percent: 20 }]);
    assert.deepEqual(findTampering(snap(catalog(), [{ code: 'bf20', percent: 20 }]), prev).found, []);
    const r = findTampering(snap(catalog(), [{ code: 'BF20', percent: 20 }, { code: 'FREE100', percent: 100 }, { code: 'WELCOME5', percent: 5 }]), prev);
    assert.deepEqual(kinds(r), ['code:fail', 'code:warn']);
    note(t, r.found.map((f) => f.message).join(' '));
  });

  it('codes are only compared when both checks could read them', () => {
    assert.deepEqual(findTampering(snap(catalog(), [{ code: 'FREE100', percent: 100 }]), snap(catalog(), null)).found, []);
    assert.deepEqual(findTampering(snap(catalog(), null), snap(catalog(), [{ code: 'X', percent: 10 }])).found, []);
  });

  it('the report says what changed and what to do', () => {
    const now = catalog(); now[0].variants[0].price = 0;
    const rec = new Recorder();
    tamperCheck({ rec, result: findTampering(snap(now, [{ code: 'FREE100', percent: 100 }]), snap(catalog(), [])) });
    const c = rec.checks[0];
    assert.equal(c.status, 'fail');
    assert.equal(c.category, 'security');
    assert.match(c.detail, /became free: ₹1,499 → ₹0/);
    assert.match(c.detail, /FREE100/);
    assert.match(c.fix, /two-step login/);
    assert.equal(c.evidence.tamper.length, 2);
    assert.equal(groupOf('sec.tamper'), 'security.tamper');
  });
});

describe('Tampering on a store', { concurrency: 1 }, () => {
  const storeId = 7000 + Math.floor(Math.random() * 1000);
  const SLOW = ['speed', 'seo', 'a11y', 'links', 'policies', 'visual', 'law.de', 'law.cookies', 'access.law', 'law.us', 'ai.visual', 'ai.copy', 'sale.discount'];
  let n = 0;
  async function full(extra, shopifyCodes = [{ code: 'BF20', percent: 20 }], disabled = SLOW) {
    const mock = await startMock({ extra });
    try { return await runScan({ runId: 1000 + n++, origin: mock.origin, kind: 'full', storeId, disabled, shopifyCodes }); } finally { mock.stop(); }
  }
  const check = (r) => r.checks.find((c) => c.id === 'sec.tamper');
  after(async () => { (await getBrowser()).close(); });

  it('the first full check saves the catalog and codes', { timeout: 180000 }, async () => {
    const c = check(await full(''));
    assert.equal(c?.status, 'pass');
    assert.match(c.detail, /Saved today/);
  });

  it('an unchanged store passes', { timeout: 180000 }, async () => {
    assert.equal(check(await full(''))?.status, 'pass');
  });

  it('a variant made free and a new 100% code are caught', { timeout: 180000 }, async (t) => {
    const c = check(await full('zero', [{ code: 'BF20', percent: 20 }, { code: 'FREE100', percent: 100 }]));
    assert.equal(c?.status, 'fail', c?.detail);
    assert.match(c.detail, /“Organic Cotton Kurta” \(Medium\) became free/);
    assert.match(c.detail, /FREE100/);
    note(t, c.detail);
  });

  it('every price cut by 90% is caught as a mass edit', { timeout: 180000 }, async (t) => {
    await full('');
    const c = check(await full('cut'));
    assert.equal(c?.status, 'fail', c?.detail);
    assert.ok(c.evidence.tamper.some((f) => f.kind === 'mass'));
    note(t, c.detail);
  });

  it('a product replaced by another is caught', { timeout: 180000 }, async (t) => {
    await full('');
    const c = check(await full('swap'));
    assert.equal(c?.status, 'fail', c?.detail);
    assert.match(c.detail, /“Handwoven Silk Saree” was replaced by a different product, “Prepaid Gift Card Bundle”/);
    note(t, c.detail);
  });

  it('works with catalog checks switched off, without showing the catalog', { timeout: 180000 }, async () => {
    await full('', undefined, [...SLOW, 'catalog']);
    const r = await full('zero', undefined, [...SLOW, 'catalog']);
    assert.equal(check(r)?.status, 'fail');
    assert.equal(r.catalog, null);
    assert.ok(!r.checks.some((c) => c.id.startsWith('cat.')));
  });

  it('switching the group off skips it', { timeout: 180000 }, async () => {
    assert.equal(check(await full('zero', undefined, [...SLOW, 'security.tamper'])), undefined);
  });
});

describe('Tampering in the report and alerts', () => {
  let Pr, owner, storeId, first, second, browser, mock2;
  before(async () => {
    Pr = await startProduct();
    owner = await signup(Pr, 'tamper@shop.test');
    storeId = await addStore(Pr, owner, { runNow: false });
    first = await runAndWait(owner, storeId, { kind: 'full' }, 300000);
    // Someone makes a product free: restart the store on the same address with the change.
    Pr.mock.stop();
    await new Promise((r) => setTimeout(r, 300));
    mock2 = spawn(process.execPath, ['test/mock-store.js'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(Pr.mock.port), MOCK_EXTRA: 'zero' }, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`${Pr.mock.origin}/products.json`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
    second = await runAndWait(owner, storeId, { kind: 'full' }, 300000);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); mock2?.kill(); await Pr.stop(); });

  it('the second full check reports the free product and sends one alert', { timeout: 60000 }, async (t) => {
    assert.equal(first.status, 'done', first.error || '');
    assert.equal(second.status, 'done', second.error || '');
    const res = JSON.parse(Pr.db().prepare('SELECT result_json FROM runs WHERE id = ?').get(second.id).result_json);
    const c = res.checks.find((x) => x.id === 'sec.tamper');
    assert.equal(c?.status, 'fail', c?.detail);
    const alerts = Pr.db().prepare("SELECT * FROM alerts WHERE store_id = ? AND check_id = 'sec.tamper'").all(storeId);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].state, 'failing');

    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${Pr.base}/app#/s/${storeId}/reports/${second.id}`);
    await p.waitForSelector('.rtabs button', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    await p.locator('.rtabs button[data-rtab=areas]').click();
    await p.waitForTimeout(400);
    const item = p.locator('.rtab-pane:not([hidden])').getByText('No unexpected changes to products, prices or discount codes').first();
    await item.scrollIntoViewIfNeeded();
    assert.ok(await item.isVisible());
    assert.match(await p.locator('.rtab-pane:not([hidden])').textContent(), /became free/);
    await screenshot(t, p, 'Report: a product made free since the last check');
    assert.deepEqual(errors, []);
    note(t, c.detail);
  });
});
