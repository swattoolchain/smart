/**
 * Online payments for website customers (Razorpay): choose a plan, pay, and the licence updates itself.
 * The amount always comes from the server's quote; the browser only says which plan, stores and period.
 * A payment is applied once, whether the browser's confirmation or Razorpay's webhook arrives first.
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import { q } from './db.js';
import { quote, createCheckout, setCheckoutOrder, checkoutByOrder, applyCheckout, licenseView } from './license.js';
import { shopForUser } from './shopify.js';
import { sendReceipt } from './billing-mail.js';
import { sendMail } from './alerts.js';

const R = config.razorpay;
const notifyFounder = (subject, text) => { if (config.adminEmail) sendMail({ to: config.adminEmail, subject, text }).catch(() => {}); };
export const paymentsEnabled = () => !!(R.keyId && R.keySecret);
const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function razorpay(path, body) {
  const r = await fetch(`${R.apiBase}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${R.keyId}:${R.keySecret}`).toString('base64') },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.description || `Razorpay error ${r.status}`);
  return j;
}

async function finish(orderId, paymentId, amount, currency) {
  const lic = applyCheckout(orderId, paymentId, amount, currency, 'razorpay');
  if (lic) {
    const ck = checkoutByOrder(orderId);
    const user = q.userById.get(ck.user_id);
    sendReceipt(user, { amount, currency, reference: paymentId }, lic).catch((e) => console.error('receipt failed', e));
  }
  return lic;
}

export function paymentRoutes(app, { requireUser }) {
  // Website customers only: shops that installed from the Shopify App Store are billed by Shopify.
  const guard = (req, res) => {
    if (shopForUser(req.user.id)) { res.status(400).json({ error: 'Your plan is billed through Shopify. Change it from the Plan page in Shopify admin.' }); return false; }
    return true;
  };

  app.post('/api/account/quote', requireUser, (req, res) => {
    if (!guard(req, res)) return;
    try { res.json({ quote: quote(req.user.id, req.body || {}), online: paymentsEnabled() }); } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/account/checkout', requireUser, async (req, res) => {
    if (!guard(req, res)) return;
    if (!paymentsEnabled()) return res.status(503).json({ error: 'Online payment isn’t switched on yet. Email us and we’ll send an invoice.' });
    let qt;
    try { qt = quote(req.user.id, req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const id = createCheckout(req.user.id, qt, 'razorpay');
      const order = await razorpay('/v1/orders', { amount: qt.amount, currency: qt.currency, receipt: `tharam_${id}`, notes: { user_id: String(req.user.id), plan: qt.plan.key, seats: String(qt.seats), period: qt.period } });
      setCheckoutOrder(id, order.id);
      res.json({ provider: 'razorpay', key: R.keyId, orderId: order.id, amount: qt.amount, currency: qt.currency, quote: qt,
        name: 'Tharam', description: `${qt.plan.name} · ${qt.seats} store${qt.seats === 1 ? '' : 's'} · ${qt.period === 'year' ? 'yearly' : 'monthly'}`, email: req.user.email });
    } catch (e) {
      console.error('checkout failed', e);
      res.status(502).json({ error: 'We couldn’t start the payment. Please try again in a minute.' });
    }
  });

  // The browser's confirmation after a successful payment. Checked with our secret before anything changes.
  app.post('/api/account/checkout/verify', requireUser, async (req, res) => {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sig } = req.body || {};
    if (!orderId || !paymentId || !sig) return res.status(400).json({ error: 'Missing payment details' });
    const ck = checkoutByOrder(String(orderId));
    if (!ck || ck.user_id !== req.user.id) return res.status(404).json({ error: 'Unknown order' });
    if (!same(hmacHex(R.keySecret, `${orderId}|${paymentId}`), sig)) return res.status(400).json({ error: 'Payment could not be verified' });
    try {
      // Confirm with Razorpay what was actually paid before applying it.
      const p = await razorpay(`/v1/payments/${encodeURIComponent(paymentId)}`);
      if (p.order_id !== orderId || p.status !== 'captured') return res.status(400).json({ error: 'Payment isn’t complete yet. If money was taken, your plan updates within a few minutes.' });
      await finish(orderId, paymentId, p.amount, p.currency);
      res.json({ ok: true, license: licenseView(req.user.id) });
    } catch (e) {
      console.error('verify failed', e);
      if (/does not match/.test(e.message)) {
        if (config.adminEmail) sendMail({ to: config.adminEmail, subject: `[payment] Amount mismatch for ${req.user.email}`, text: `${e.message}\nOrder ${orderId}, payment ${paymentId}` }).catch(() => {});
        return res.status(400).json({ error: 'The amount paid doesn’t match this plan, so nothing was changed. We’ve been notified and will sort it out with you.' });
      }
      res.status(502).json({ error: 'We received your payment but couldn’t update your plan yet. It will update within a few minutes; no need to pay again.' });
    }
  });
}

/** Razorpay webhook: the source of truth if the browser closed before confirming. */
export async function razorpayWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!R.webhookSecret || !same(hmacHex(R.webhookSecret, raw), req.get('x-razorpay-signature') || '')) return res.status(401).send('Invalid signature');
  let ev = {};
  try { ev = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).send('Bad JSON'); }
  const p = ev.payload?.payment?.entity;
  if (['payment.captured', 'order.paid'].includes(ev.event) && p?.order_id && checkoutByOrder(p.order_id)) {
    try { await finish(p.order_id, p.id, p.amount, p.currency); }
    catch (e) {
      console.error('webhook apply failed', e);
      // A mismatch will never succeed on retry: tell the founder instead of asking Razorpay to retry.
      if (/does not match/.test(e.message)) { notifyFounder(`[payment] Amount mismatch on ${p.order_id}`, `${e.message}\nPayment ${p.id}`); return res.status(200).send('ok'); }
      return res.status(500).send('retry');
    }
  }
  // Refunds and disputes need a person: the plan isn't changed automatically.
  if (/^(refund\.|payment\.dispute\.)/.test(ev.event || '')) {
    const ref = ev.payload?.refund?.entity || ev.payload?.dispute?.entity || {};
    notifyFounder(`[payment] ${ev.event}`, `Razorpay reported ${ev.event} for payment ${ref.payment_id || p?.id || '?'} (${ref.amount ?? ''} ${ref.currency ?? ''}). Review the customer's plan in the founder console.`);
  }
  res.status(200).send('ok');
}
