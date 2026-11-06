// Home: what needs attention after a quick check still includes what the last full check found.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

describe('Home: needs your attention', () => {
  let P, owner, storeId, full, quick, browser;
  before(async () => {
    // A store with a product priced at zero and placeholder text: only the full check sees those.
    P = await startProduct({ mock: { extra: 'placeholder' } });
    owner = await signup(P, 'home@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    full = await runAndWait(owner, storeId, { kind: 'full' }, 300000);
    quick = await runAndWait(owner, storeId, { kind: 'journeys' });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('the full check found the zero price and the quick check did not look at products', () => {
    assert.ok(full.result.checks.some((c) => c.id === 'cat.pricing' && c.status === 'fail'), 'full check flags the zero price');
    assert.ok(!quick.result.checks.some((c) => c.id === 'cat.pricing'), 'journey check does not include product checks');
  });

  it('after a quick check, home still lists the zero price and links to the full check', async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#/s/${storeId}`);
    await p.waitForSelector('[data-tour=fix]', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    const attention = await p.textContent('[data-tour=fix]');
    assert.doesNotMatch(attention, /Nothing needs your attention/);
    const row = p.locator('[data-tour=fix] a[data-focus="cat.pricing"]');
    assert.equal(await row.count(), 1, 'the pricing problem is listed');
    assert.match(await row.getAttribute('href'), new RegExp(`/reports/${full.id}$`), 'it opens the full check report');
    const needsFixing = await p.locator('.kpi', { hasText: 'Needs fixing' }).locator('.k-v').textContent();
    assert.ok(Number(needsFixing.trim()) >= 1, `Needs fixing tile shows ${needsFixing}`);
    note(t, `attention list: ${(await p.locator('[data-tour=fix] .t').allTextContents()).join('; ')}`);
    await screenshot(t, p, 'Home after a quick check, still showing the zero price');
    assert.deepEqual(errors, []);
  });

  it('the speed tile never says 0 s', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    await p.goto(`${P.base}/app#/s/${storeId}`);
    await p.waitForSelector('.kpis', { timeout: 20000 });
    const speed = await p.locator('.kpi', { hasText: 'Homepage on phones' }).locator('.k-v').textContent();
    assert.doesNotMatch(speed.trim(), /^0 s$/);
  });
});
