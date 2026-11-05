// Browser access for Shopify installs, and email sign-in links.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startProduct, shopifyOpen, signup, lastMailLink, shopifyHmac, SHOPIFY } from './lib/harness.js';
import { note } from './lib/evidence.js';

const tokenOf = (link) => link.split('#/signin/')[1];

describe('Browser access and sign-in links', () => {
  let P;
  before(async () => { P = await startProduct(); await signup(P, 'taken@web.test'); });
  after(async () => { await P.stop(); });

  it('a Shopify store owner confirms an email and is signed in to the same store', async (t) => {
    const shop = await shopifyOpen(P, 'browser.myshopify.com');
    assert.equal((await shop.post('/api/account/web-access', { email: 'owner@browser.test' })).status, 200);
    const link = lastMailLink(P);
    assert.ok(link, 'a confirmation link was emailed');
    const web = P.session();
    const v = await web.post('/api/auth/link/verify', { token: tokenOf(link) });
    assert.equal(v.status, 200);
    assert.equal(v.json.confirmed, true);
    const stores = (await web.get('/api/stores')).json.stores;
    assert.deepEqual(stores.map((s) => s.id), [shop.storeId]);
    assert.equal((await shop.get('/api/account/web-access')).json.email, 'owner@browser.test');
    note(t, 'confirmation link → browser session sees the Shopify store');
  });

  it('a link works once', async () => {
    const shop = await shopifyOpen(P, 'once.myshopify.com');
    await shop.post('/api/account/web-access', { email: 'owner@once.test' });
    const tok = tokenOf(lastMailLink(P));
    assert.equal((await P.session().post('/api/auth/link/verify', { token: tok })).status, 200);
    assert.equal((await P.session().post('/api/auth/link/verify', { token: tok })).status, 400);
    assert.equal((await P.session().post('/api/auth/link/verify', { token: 'x'.repeat(43) })).status, 400);
  });

  it('refuses an email that another account already uses', async () => {
    const shop = await shopifyOpen(P, 'taken.myshopify.com');
    assert.equal((await shop.post('/api/account/web-access', { email: 'taken@web.test' })).status, 409);
    assert.equal((await shop.post('/api/account/web-access', { email: 'owner@browser.test' })).status, 409);
  });

  it('later sign-ins use an emailed link, and never reveal whether an email exists', async () => {
    const a = await P.session().post('/api/auth/link', { email: 'owner@browser.test' });
    const linkA = lastMailLink(P);
    const b = await P.session().post('/api/auth/link', { email: 'nobody@nowhere.test' });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(a.json, b.json, 'same answer for known and unknown emails');
    assert.equal(lastMailLink(P), linkA, 'no link is sent to an unknown email');
    const web = P.session();
    assert.equal((await web.post('/api/auth/link/verify', { token: tokenOf(linkA) })).status, 200);
    assert.equal((await web.get('/api/me')).status, 200);
  });

  it('website accounts can also sign in with a link', async () => {
    await signup(P, 'linker@web.test');
    await P.session().post('/api/auth/link', { email: 'linker@web.test' });
    const web = P.session();
    assert.equal((await web.post('/api/auth/link/verify', { token: tokenOf(lastMailLink(P)) })).status, 200);
    assert.equal((await web.get('/api/me')).json.user.email, 'linker@web.test');
  });

  it('turning browser access off signs out every browser', async (t) => {
    const shop = await shopifyOpen(P, 'off.myshopify.com');
    await shop.post('/api/account/web-access', { email: 'owner@off.test' });
    const web = P.session();
    await web.post('/api/auth/link/verify', { token: tokenOf(lastMailLink(P)) });
    assert.equal((await web.get('/api/stores')).status, 200);
    assert.equal((await shop.del('/api/account/web-access')).status, 200);
    assert.equal((await web.get('/api/stores')).status, 401);
    assert.equal((await shop.get('/api/account/web-access')).json.email, null);
    note(t, 'browser 200 → owner turns access off in Shopify → browser 401');
  });

  it('uninstalling the app ends browser sessions too', async () => {
    const shopDomain = 'uninstall-web.myshopify.com';
    const shop = await shopifyOpen(P, shopDomain);
    await shop.post('/api/account/web-access', { email: 'owner@uninstall.test' });
    const web = P.session();
    await web.post('/api/auth/link/verify', { token: tokenOf(lastMailLink(P)) });
    assert.equal((await web.get('/api/stores')).status, 200);
    const raw = '{}';
    await fetch(`${P.base}/shopify/webhooks`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-shopify-topic': 'app/uninstalled', 'x-shopify-shop-domain': shopDomain, 'x-shopify-hmac-sha256': shopifyHmac(raw, SHOPIFY.secret) } });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await web.get('/api/stores')).status, 401);
  });

  it('website accounts cannot use the Shopify-only browser access settings', async () => {
    const s = await signup(P);
    assert.equal((await s.post('/api/account/web-access', { email: 'x@y.test' })).status, 400);
    assert.equal((await s.del('/api/account/web-access')).status, 400);
  });
});
