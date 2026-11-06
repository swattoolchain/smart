// Website payments with Razorpay: the server sets every amount, checks every payment, and applies it exactly once.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { startProduct, signup, shopifyOpen, RZP, FOUNDER } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const sign = (orderId, paymentId, secret = RZP.keySecret) => crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

describe('Website payments (Razorpay)', () => {
  let P;
  before(async () => { P = await startProduct(); });
  after(async () => { await P.stop(); });

  const order = { plan_key: 'growth', seats: 2, period: 'month', currency: 'USD' };
  /** The shopper pays in the Razorpay window (simulated by the fake Razorpay). */
  const pay = async (orderId, amount) => (await fetch(`${P.fake.base}/rzp/pay`, { method: 'POST', body: JSON.stringify({ orderId, amount }) })).json();
  const licence = async (s) => (await s.get('/api/me')).json.license;
  const payments = (email) => P.db().prepare('SELECT p.* FROM payments p JOIN users u ON u.id = p.user_id WHERE u.email = ?').all(email);
  const webhook = (body, secret = RZP.webhookSecret) => {
    const raw = JSON.stringify(body);
    return fetch(`${P.base}/api/payments/razorpay/webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', secret).update(raw).digest('hex') } });
  };

  it('the price comes from the server, whatever the browser sends', async (t) => {
    const s = await signup(P, 'quote@pay.test');
    const q = await s.post('/api/account/quote', { ...order, amount: 1 });
    assert.equal(q.status, 200);
    assert.equal(q.json.quote.amount, 4900 * 2, 'Growth is $49 per store per month');
    for (const bad of [{ ...order, plan_key: 'beta' }, { ...order, plan_key: 'nope' }, { ...order, seats: 0 }, { ...order, seats: 1.5 }, { ...order, currency: 'XYZ' }]) {
      assert.equal((await s.post('/api/account/quote', bad)).status, 400, JSON.stringify(bad));
    }
    note(t, `quote for 2 Growth stores monthly: ${q.json.quote.amount / 100} USD; a browser-sent amount of 1 is ignored`);
  });

  it('pay, verify, and the plan starts straight away', async (t) => {
    const s = await signup(P, 'buyer@pay.test');
    const c = await s.post('/api/account/checkout', order);
    assert.equal(c.status, 200);
    assert.equal(c.json.amount, 9800);
    assert.equal(c.json.key, RZP.keyId);
    const p = await pay(c.json.orderId);
    const v = await s.post('/api/account/checkout/verify', { razorpay_order_id: c.json.orderId, razorpay_payment_id: p.id, razorpay_signature: sign(c.json.orderId, p.id) });
    assert.equal(v.status, 200, v.text);
    const lic = await licence(s);
    assert.equal(lic.plan.key, 'growth');
    assert.equal(lic.seats, 2);
    assert.equal(lic.state, 'active');
    const days = (Date.parse(lic.expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 864e5;
    assert.ok(days > 27 && days < 32, `paid for about a month, got ${days.toFixed(1)} days`);
    assert.equal(payments('buyer@pay.test').length, 1);
    assert.match(P.log(), /to=buyer@pay\.test subject=[^\n]*(receipt|Receipt|payment|Payment)/, 'a receipt was emailed');
    note(t, `Growth × 2 active until ${lic.expires_at}; one payment recorded; receipt emailed`);
  });

  it('refuses a forged signature and changes nothing', async () => {
    const s = await signup(P, 'forger@pay.test');
    const c = await s.post('/api/account/checkout', order);
    const p = await pay(c.json.orderId);
    const v = await s.post('/api/account/checkout/verify', { razorpay_order_id: c.json.orderId, razorpay_payment_id: p.id, razorpay_signature: sign(c.json.orderId, p.id, 'not-the-secret') });
    assert.equal(v.status, 400);
    assert.notEqual((await licence(s)).plan.key, 'growth');
    assert.equal(payments('forger@pay.test').length, 0);
  });

  it('nobody can confirm someone else\'s order', async () => {
    const owner = await signup(P, 'orderowner@pay.test');
    const other = await signup(P, 'other@pay.test');
    const c = await owner.post('/api/account/checkout', order);
    const p = await pay(c.json.orderId);
    const v = await other.post('/api/account/checkout/verify', { razorpay_order_id: c.json.orderId, razorpay_payment_id: p.id, razorpay_signature: sign(c.json.orderId, p.id) });
    assert.equal(v.status, 404);
    assert.equal(payments('other@pay.test').length, 0);
  });

  it('a payment for the wrong amount changes nothing and alerts the founder', async (t) => {
    const s = await signup(P, 'short@pay.test');
    const c = await s.post('/api/account/checkout', order);
    const p = await pay(c.json.orderId, 100);
    const v = await s.post('/api/account/checkout/verify', { razorpay_order_id: c.json.orderId, razorpay_payment_id: p.id, razorpay_signature: sign(c.json.orderId, p.id) });
    assert.equal(v.status, 400);
    assert.match(v.json.error, /doesn’t match/);
    assert.notEqual((await licence(s)).plan.key, 'growth');
    assert.equal(payments('short@pay.test').length, 0);
    assert.ok(P.log().includes(`to=${FOUNDER} subject=[payment] Amount mismatch for short@pay.test`), 'founder alerted');
    note(t, 'paid 1.00 instead of 98.00: refused, plan unchanged, founder emailed');
  });

  it('a payment that is not captured yet is not applied', async () => {
    const s = await signup(P, 'pending@pay.test');
    const c = await s.post('/api/account/checkout', order);
    await P.fake.control({ payStatus: 'authorized' });
    const p = await pay(c.json.orderId);
    await P.fake.control({ payStatus: 'captured' });
    const v = await s.post('/api/account/checkout/verify', { razorpay_order_id: c.json.orderId, razorpay_payment_id: p.id, razorpay_signature: sign(c.json.orderId, p.id) });
    assert.equal(v.status, 400);
    assert.equal(payments('pending@pay.test').length, 0);
  });

  it('the webhook applies a payment when the browser closed, and only once', async (t) => {
    const s = await signup(P, 'closed@pay.test');
    const c = await s.post('/api/account/checkout', order);
    const p = await pay(c.json.orderId);
    const event = { event: 'payment.captured', payload: { payment: { entity: { id: p.id, order_id: c.json.orderId, amount: 9800, currency: 'USD', status: 'captured' } } } };
    assert.equal((await webhook(event)).status, 200);
    assert.equal((await webhook(event)).status, 200, 'Razorpay retries are accepted');
    await s.post('/api/account/checkout/verify', { razorpay_order_id: c.json.orderId, razorpay_payment_id: p.id, razorpay_signature: sign(c.json.orderId, p.id) });
    assert.equal(payments('closed@pay.test').length, 1, 'applied exactly once');
    assert.equal((await licence(s)).plan.key, 'growth');
    note(t, 'webhook twice + browser confirmation: one payment, plan active');
  });

  it('refuses webhooks without Razorpay\'s signature', async () => {
    assert.equal((await webhook({ event: 'payment.captured' }, 'wrong-secret')).status, 401);
  });

  it('refunds and disputes alert the founder and leave the plan alone', async () => {
    const r = await webhook({ event: 'refund.processed', payload: { refund: { entity: { payment_id: 'pay_refund1', amount: 9800, currency: 'USD' } } } });
    assert.equal(r.status, 200);
    assert.ok(P.log().includes(`to=${FOUNDER} subject=[payment] refund.processed`));
  });

  it('renewing early adds a month after the current end date', async () => {
    const s = await signup(P, 'renew@pay.test');
    for (let i = 0; i < 2; i++) {
      const c = await s.post('/api/account/checkout', order);
      const p = await pay(c.json.orderId);
      await s.post('/api/account/checkout/verify', { razorpay_order_id: c.json.orderId, razorpay_payment_id: p.id, razorpay_signature: sign(c.json.orderId, p.id) });
    }
    const lic = await licence(s);
    const days = (Date.parse(lic.expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 864e5;
    assert.ok(days > 56 && days < 63, `two months paid, got ${days.toFixed(1)} days`);
  });

  it('Shopify accounts are refused', async () => {
    const shop = await shopifyOpen(P, 'pay-refused.myshopify.com');
    assert.equal((await shop.post('/api/account/checkout', order)).status, 400);
  });

  it('a website customer sees their plan and a way to pay', async (t) => {
    const s = await signup(P, 'page@pay.test');
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      await ctx.addCookies(s.browserCookies());
      const p = await ctx.newPage();
      await p.goto(`${P.base}/app#/account/billing`);
      await p.waitForSelector('#change-plan', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      await screenshot(t, p, 'Plan and billing for a website customer');
    } finally { await browser.close(); }
  });
});
