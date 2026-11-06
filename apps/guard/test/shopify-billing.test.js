// Shopify billing: the plan follows the store's Shopify subscription; Shopify accounts never pay through Razorpay.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, shopifyOpen, shopifyToken, shopifyHmac, SHOPIFY } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

describe('Shopify billing', () => {
  let P;
  before(async () => { P = await startProduct(); });
  after(async () => { await P.stop(); });

  const licence = async (s) => (await s.get('/api/me')).json.license;
  /** Opening the app after choosing a plan forces a fresh read of the subscription from Shopify. */
  const reopen = (s) => s.post('/shopify/api/session', { welcome: true });
  const subscribe = (sub) => P.fake.control({ subscription: sub });
  const live = async (shop) => { await P.fake.control({ devStore: false, subscription: null }); return shopifyOpen(P, shop); };

  it('a new install starts on the free plan, billed through Shopify', async (t) => {
    const s = await live('billing-new.myshopify.com');
    const lic = await licence(s);
    assert.equal(lic.plan.kind === 'paid', false);
    assert.equal(lic.usable, true);
    const stores = (await s.get('/api/stores')).json;
    assert.match(stores.license.shopify.pricingUrl, /^https:\/\/admin\.shopify\.com\/store\/billing-new\/charges\/[^/]+\/pricing_plans$/);
    note(t, `plan ${lic.plan.name}; plan page ${stores.license.shopify.pricingUrl}`);
  });

  for (const [name, key] of [['Starter', 'starter'], ['Growth', 'growth'], ['Pro', 'pro']]) {
    it(`choosing ${name} in Shopify switches the plan to ${name}`, async () => {
      const s = await live(`billing-${key}.myshopify.com`);
      await subscribe({ name, status: 'ACTIVE', test: false });
      await reopen(s);
      const lic = await licence(s);
      assert.equal(lic.plan.key, key);
      assert.equal(lic.state, 'active');
      assert.equal(lic.billing, 'shopify');
    });
  }

  it('cancelling the subscription in Shopify ends the paid plan and stops manual checks', async (t) => {
    const s = await live('billing-cancel.myshopify.com');
    await subscribe({ name: 'Growth', status: 'ACTIVE', test: false });
    await reopen(s);
    assert.equal((await licence(s)).plan.key, 'growth');
    await subscribe(null);
    await reopen(s);
    const lic = await licence(s);
    assert.equal(lic.state, 'cancelled');
    assert.equal(lic.usable, false);
    const run = await s.post(`/api/stores/${s.storeId}/run`, {});
    assert.equal(run.status, 403);
    assert.equal(run.json.upgrade, true);
    note(t, `after cancelling: state ${lic.state}; run refused: "${run.json.error}"`);
  });

  it('the subscription webhook updates the plan without the owner opening the app', async () => {
    const shop = 'billing-webhook.myshopify.com';
    const s = await live(shop);
    await subscribe({ name: 'Pro', status: 'ACTIVE', test: false });
    const raw = JSON.stringify({ app_subscription: { name: 'Pro', status: 'ACTIVE' } });
    const r = await fetch(`${P.base}/shopify/webhooks`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-shopify-topic': 'app_subscriptions/update', 'x-shopify-shop-domain': shop, 'x-shopify-hmac-sha256': shopifyHmac(raw, SHOPIFY.secret) } });
    assert.equal(r.status, 200);
    await new Promise((res) => setTimeout(res, 500));
    assert.equal((await licence(s)).plan.key, 'pro');
  });

  it('a free test charge does not unlock a paid plan on a live store', async (t) => {
    const s = await live('billing-testcharge.myshopify.com');
    const before = (await licence(s)).plan.key;
    await subscribe({ name: 'Pro', status: 'ACTIVE', test: true });
    await reopen(s);
    assert.equal((await licence(s)).plan.key, before);
    note(t, `test charge for Pro ignored; plan stays ${before}`);
  });

  it('a test charge does count on a development store (for Shopify reviewers and our own testing)', async () => {
    await P.fake.control({ devStore: true, subscription: null });
    const s = await shopifyOpen(P, 'billing-devstore.myshopify.com');
    await subscribe({ name: 'Growth', status: 'ACTIVE', test: true });
    await reopen(s);
    assert.equal((await licence(s)).plan.key, 'growth');
    await P.fake.control({ devStore: false });
  });

  it('an unknown plan name in Shopify changes nothing', async () => {
    const s = await live('billing-unknown.myshopify.com');
    const before = (await licence(s)).plan.key;
    await subscribe({ name: 'Enterprise Ultra', status: 'ACTIVE', test: false });
    await reopen(s);
    assert.equal((await licence(s)).plan.key, before);
  });

  it('Shopify accounts can never pay through the website (Razorpay)', async () => {
    const s = await live('billing-norazorpay.myshopify.com');
    for (const u of ['/api/account/quote', '/api/account/checkout']) {
      const r = await s.post(u, { plan: 'growth', seats: 1, period: 'month', currency: 'USD' });
      assert.equal(r.status, 400, u);
      assert.match(r.json.error, /billed through Shopify/);
    }
  });

  it('the plan page inside Shopify sends the owner to Shopify, never to a payment form', async (t) => {
    const shop = 'billing-page.myshopify.com';
    await live(shop);
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const p = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
      const scripts = [];
      p.on('request', (r) => scripts.push(r.url()));
      await p.route('https://cdn.shopify.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.shopify={idToken:async()=>${JSON.stringify(shopifyToken(shop, { expIn: 600 }))}};` }));
      await p.route('https://checkout.razorpay.com/**', (r) => r.abort());
      await p.goto(`${P.base}/shopify/plan?shop=${shop}`);
      await p.waitForSelector('text=billed through Shopify', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask').forEach((x) => x.remove()));
      const link = p.locator('a', { hasText: 'Choose a plan' });
      assert.match(await link.getAttribute('href'), /admin\.shopify\.com\/store\/billing-page\/charges\/.+\/pricing_plans/);
      assert.equal(await link.getAttribute('target'), '_top', 'opens Shopify’s page in the admin, not inside the frame');
      assert.equal(await p.locator('#change-plan').count(), 0, 'no website payment button');
      assert.ok(!scripts.some((u) => u.includes('razorpay')), 'Razorpay is never loaded');
      await screenshot(t, p, 'Plan page inside Shopify');
    } finally { await browser.close(); }
  });
});
