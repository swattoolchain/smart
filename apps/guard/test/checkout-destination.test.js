// Which checkout addresses count as the store's own (T02: checkout hijack detection).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trustedCheckout } from '../src/engine/functional.js';
import { note } from './lib/evidence.js';

describe('Checkout destination', () => {
  const store = 'https://www.kaveri-handlooms.com';
  const trusted = [
    ['the store itself', 'https://www.kaveri-handlooms.com/checkouts/cn/abc'],
    ['the store without www', 'https://kaveri-handlooms.com/checkouts/cn/abc'],
    ['a subdomain of the store', 'https://checkout.kaveri-handlooms.com/checkouts/cn/abc'],
    ['the store\'s own myshopify address', 'https://kaveri.myshopify.com/checkouts/cn/abc', 'kaveri.myshopify.com'],
    ['Shopify checkout', 'https://checkout.shopify.com/123/checkouts/abc'],
    ['Shop Pay', 'https://shop.app/checkout/123'],
    ['Shopify pay', 'https://pay.shopify.com/checkouts/abc'],
  ];
  const untrusted = [
    ['a look-alike domain', 'https://kaveri-handlooms-secure.com/checkouts/cn/abc'],
    ['a domain that only starts like the store', 'https://www.kaveri-handlooms.com.evil.io/checkouts/cn/abc'],
    ['another store\'s myshopify address', 'https://attacker.myshopify.com/checkouts/cn/abc', 'kaveri.myshopify.com'],
    ['a fake Shopify host', 'https://checkout-shopify.com/checkouts/abc'],
    ['shop.app look-alike', 'https://shop.app.pay-now.io/checkout'],
    ['an IP address', 'http://203.0.113.9/checkouts/cn/abc'],
    ['not an address', 'about:blank'],
  ];
  for (const [what, url, shop] of trusted) it(`trusts ${what}`, () => assert.equal(trustedCheckout(url, store, shop), true, url));
  for (const [what, url, shop] of untrusted) it(`flags ${what}`, (t) => { assert.equal(trustedCheckout(url, store, shop), false, url); note(t, url); });
  it('a myshopify preview link trusts only its own myshopify address', () => {
    assert.equal(trustedCheckout('https://kaveri.myshopify.com/checkouts/x', 'https://kaveri.myshopify.com'), true);
    assert.equal(trustedCheckout('https://other.myshopify.com/checkouts/x', 'https://kaveri.myshopify.com'), false);
  });
});

describe('Checkout hijack, as the store owner sees it', () => {
  it('the report shows a critical alert naming the other website', { timeout: 300000 }, async (t) => {
    const { startProduct, signup, addStore, runAndWait } = await import('./lib/harness.js');
    const { screenshot } = await import('./lib/evidence.js');
    const { chromium } = await import('playwright');
    const P = await startProduct({ mock: { breaks: 'hijack' } });
    let browser;
    try {
      const owner = await signup(P, 'hijack@shop.test');
      const storeId = await addStore(P, owner, { runNow: false });
      const run = await runAndWait(owner, storeId, { kind: 'journeys' });
      assert.equal(run.verdict, 'critical');
      const c = run.result.checks.find((x) => x.id === 'fn.checkout');
      assert.equal(c.status, 'fail');
      note(t, c.detail);
      browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      await ctx.addCookies(owner.browserCookies());
      const p = await ctx.newPage();
      await p.goto(`${P.base}/app#/s/${storeId}`);
      await p.waitForSelector('.panel.status', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      assert.match(await p.textContent('.panel.status'), /Urgent: checkout is sending shoppers to another website/);
      await screenshot(t, p, 'Home after a checkout hijack');
      await p.goto(`${P.base}/app#/s/${storeId}/reports/${run.id}`);
      await p.waitForSelector('.rtabs', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      assert.match(await p.textContent('body'), /different website/);
      await screenshot(t, p, 'Report: checkout sent to another website');
    } finally {
      await browser?.close();
      await P.stop();
    }
  });
});
