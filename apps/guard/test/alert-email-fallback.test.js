// T60: clearing the alert email must never leave alerts going to a myshopify domain (a Shopify account's login
// name, not an address). Shopify stores fall back to the confirmed browser-access email, then the shop's contact
// email from Shopify, else the change is refused with a plain message. Website accounts keep their account email.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, shopifyOpen, lastMailLink } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const alertEmailOf = async (s, id) => (await s.get(`/api/stores/${id}`)).json.store.alert_email;

describe('Alert email fallback', () => {
  let P;
  before(async () => { P = await startProduct(); });
  after(async () => { await P?.stop(); });

  it("a Shopify store that clears its alert email gets the shop's contact email, not the myshopify domain", async (t) => {
    const shop = await shopifyOpen(P, 'clear-alerts.myshopify.com');
    assert.equal((await shop.patch(`/api/stores/${shop.storeId}`, { alertEmail: 'someone@else.example' })).status, 200);
    const r = await shop.patch(`/api/stores/${shop.storeId}`, { alertEmail: '' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.store.alert_email, 'hello@testshop.example');
    assert.doesNotMatch(await alertEmailOf(shop, shop.storeId), /myshopify\.com$/);
    note(t, `Cleared → ${r.json.store.alert_email} (the shop's contact email from Shopify)`);
  });

  it('with Shopify giving only the account email, that is used', async () => {
    await P.fake.control({ shopEmails: { email: 'owner@testshop.example', contactEmail: null } });
    try {
      const shop = await shopifyOpen(P, 'only-owner.myshopify.com');
      const r = await shop.patch(`/api/stores/${shop.storeId}`, { alertEmail: '' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.store.alert_email, 'owner@testshop.example');
    } finally { await P.fake.control({ shopEmails: { email: 'owner@testshop.example', contactEmail: 'hello@testshop.example' } }); }
  });

  it('a confirmed browser-access email comes first', async (t) => {
    const shop = await shopifyOpen(P, 'browser-alerts.myshopify.com');
    assert.equal((await shop.patch(`/api/stores/${shop.storeId}`, { config: { onboarded: true, toured: true } })).status, 200);
    assert.equal((await shop.post('/api/account/web-access', { email: 'me@browser-alerts.test' })).status, 200);
    const web = P.session();
    assert.equal((await web.post('/api/auth/link/verify', { token: lastMailLink(P).split('#/signin/')[1] })).status, 200);
    // Cleared in the browser, on the Alerts page.
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      await ctx.addCookies(web.browserCookies());
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`${P.base}/app#/s/${shop.storeId}/alerts/channels`);
      await p.waitForSelector('#ae', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      await p.fill('#ae', '');
      await p.dispatchEvent('#ch', 'input');
      await p.getByRole('button', { name: /^Save/ }).first().click();
      const until = Date.now() + 10000;
      while ((await alertEmailOf(shop, shop.storeId)) !== 'me@browser-alerts.test' && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      assert.equal(await alertEmailOf(shop, shop.storeId), 'me@browser-alerts.test');
      await p.reload();
      await p.waitForSelector('#ae', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      assert.equal(await p.inputValue('#ae'), 'me@browser-alerts.test');
      await screenshot(t, p, 'Alert email after clearing it: the confirmed browser-access email');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
    note(t, 'Cleared on the Alerts page → me@browser-alerts.test (confirmed browser-access email)');
  });

  it('with no address to fall back on, clearing is refused in plain words and nothing changes', async (t) => {
    const shop = await shopifyOpen(P, 'no-address.myshopify.com');
    const before = await alertEmailOf(shop, shop.storeId);
    await P.fake.control({ shopEmails: { email: null, contactEmail: null } });
    try {
      const r = await shop.patch(`/api/stores/${shop.storeId}`, { alertEmail: '', name: 'Renamed' });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, 'Enter an email address for alerts. We need one to tell you when something breaks.');
      assert.equal(await alertEmailOf(shop, shop.storeId), before, 'alert email unchanged');
      assert.notEqual((await shop.get(`/api/stores/${shop.storeId}`)).json.store.name, 'Renamed', 'nothing else saved either');
      // Setting a real address still works.
      assert.equal((await shop.patch(`/api/stores/${shop.storeId}`, { alertEmail: 'alerts@no-address.test' })).status, 200);
      note(t, r.json.error);
    } finally { await P.fake.control({ shopEmails: { email: 'owner@testshop.example', contactEmail: 'hello@testshop.example' } }); }
  });

  it('website accounts are unchanged: clearing goes back to the account email', async () => {
    const owner = await signup(P, 'web-owner@shop.test');
    const id = await addStore(P, owner, { runNow: false, alertEmail: 'team@shop.test' });
    assert.equal(await alertEmailOf(owner, id), 'team@shop.test');
    const r = await owner.patch(`/api/stores/${id}`, { alertEmail: '' });
    assert.equal(r.status, 200);
    assert.equal(r.json.store.alert_email, 'web-owner@shop.test');
    assert.equal((await owner.patch(`/api/stores/${id}`, { alertEmail: 'not-an-email' })).status, 400);
  });
});
