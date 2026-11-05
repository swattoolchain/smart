// The Shopify app: install on first open, session tokens, plan sync and webhooks.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startProduct, shopifyOpen, shopifyToken, shopifyHmac, SHOPIFY } from './lib/harness.js';
import { note } from './lib/evidence.js';

describe('Shopify app', () => {
  let P;
  before(async () => { P = await startProduct(); });
  after(async () => { await P.stop(); });

  const webhook = (topic, shop, body = {}, secret = SHOPIFY.secret) => {
    const raw = JSON.stringify(body);
    return fetch(`${P.base}/shopify/webhooks`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-hmac-sha256': shopifyHmac(raw, secret) } });
  };

  it('first open creates one account and one store, with no password', async (t) => {
    const s = await shopifyOpen(P, 'first-open.myshopify.com');
    const me = (await s.get('/api/me')).json.user;
    assert.equal(me.email, 'first-open.myshopify.com');
    const stores = (await s.get('/api/stores')).json.stores;
    assert.equal(stores.length, 1);
    assert.equal(stores[0].id, s.storeId);
    assert.equal(stores[0].config.onboarded, false, 'new installs start onboarding');
    const login = await P.session().post('/api/auth/login', { email: 'first-open.myshopify.com', password: '' });
    assert.equal(login.status, 401, 'a Shopify account has no usable password');
    note(t, `store ${s.storeId} created for first-open.myshopify.com; password login refused`);
  });

  it('opening the app many times at once still makes one store', async () => {
    const shop = 'parallel.myshopify.com';
    const opens = await Promise.all(Array.from({ length: 5 }, () => P.session({ shop }).post('/shopify/api/session', {})));
    assert.ok(opens.every((r) => r.status === 200));
    assert.equal(new Set(opens.map((r) => r.json.storeId)).size, 1);
    assert.equal(P.db().prepare("SELECT COUNT(*) n FROM stores s JOIN users u ON u.id = s.user_id WHERE u.email = ?").get(shop).n, 1);
  });

  it('refuses forged, expired or wrong-app session tokens', async () => {
    const shop = 'forged.myshopify.com';
    const send = (tok) => fetch(`${P.base}/shopify/api/session`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await send(shopifyToken(shop, { secret: 'not-the-secret' }))).status, 401);
    assert.equal((await send(shopifyToken(shop, { expIn: -120 }))).status, 401);
    assert.equal((await send(shopifyToken(shop, { aud: 'another-app' }))).status, 401);
    assert.equal((await send('garbage')).status, 401);
  });

  it('refuses webhooks without a valid signature', async () => {
    assert.equal((await webhook('app/uninstalled', 'first-open.myshopify.com', {}, 'wrong-secret')).status, 401);
  });

  it('uninstall stops access, and reinstall brings the same store back', async (t) => {
    const shop = 'reinstall.myshopify.com';
    const s = await shopifyOpen(P, shop);
    assert.equal((await webhook('app/uninstalled', shop)).status, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await s.get('/api/stores')).status, 401, 'uninstalled shops lose access');
    const again = await shopifyOpen(P, shop);
    assert.equal(again.storeId, s.storeId, 'reinstall keeps the same store and history');
    assert.equal((await again.get('/api/stores')).status, 200);
    note(t, 'uninstall → 401; reinstall → same store id');
  });

  it('privacy webhooks are accepted (Tharam stores no customer data)', async () => {
    for (const topic of ['customers/data_request', 'customers/redact', 'shop/redact']) assert.equal((await webhook(topic, 'gdpr.myshopify.com', { shop_domain: 'gdpr.myshopify.com' })).status, 200, topic);
  });

  it('the embedded page allows framing only by Shopify admin', async () => {
    const r = await fetch(`${P.base}/shopify?shop=first-open.myshopify.com`);
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy') || '';
    assert.match(csp, /frame-ancestors[^;]*admin\.shopify\.com/);
    const html = await r.text();
    assert.match(html, /shopify-api-key/);
    assert.match(html, /app-bridge\.js/);
  });
});
