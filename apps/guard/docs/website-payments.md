# Website payments (Razorpay) — setup and how it works

Status: built and tested against a local stand-in (test/fake-services.js). Not yet switched on in production.

## How it works for a customer
1. App → Account menu → Plan and billing → "Renew or change plan" (or "Choose a plan").
2. Pick a plan, number of stores, monthly or yearly, and currency. The exact amount and the new paid-until date show before paying.
3. Pay in the Razorpay window. The plan updates immediately and a receipt is emailed.

Rules
- Renewing the same plan continues from the current end date (late payments in the grace period too: no free days).
- Changing plan, stores or billing period starts today; unused paid time on the old plan (same currency) becomes extra days on the new one.
- Paused accounts can't pay to reactivate (contact us). Currency can't change mid-period.
- Shopify-installed accounts are billed by Shopify, never here.
- Without Razorpay keys, the same picker opens an email asking us for an invoice.

## Safety
- The amount is computed on the server from the plan; the browser only sends plan, stores, period, currency.
- The order is bound to the customer. The checkout signature is verified, then the payment is fetched from Razorpay
  (order, status = captured, amount, currency) before anything changes.
- Applied exactly once (transaction + unique payment reference), whether the browser or the webhook arrives first.
- Amount mismatches, refunds and disputes email the founder; plans are not changed automatically for those.
- Every payment is in the founder console (Payments, customer history, audit log).

## To switch it on
1. Razorpay dashboard (start in Test mode) → API keys. Add to /opt/tharam/deploy/.env:
   RAZORPAY_KEY_ID=rzp_test_...
   RAZORPAY_KEY_SECRET=...
   RAZORPAY_WEBHOOK_SECRET=... (any long random string; use the same one in step 2)
2. Razorpay → Webhooks → Add: URL https://tharam.store/api/payments/razorpay/webhook,
   secret as above, events: payment.captured, order.paid, refund.created, refund.processed, payment.dispute.created.
3. Razorpay → Payment capture: automatic.
4. For USD/EUR/GBP prices, enable International Payments in Razorpay.
5. Redeploy. Test with Razorpay's test cards, then switch to live keys.

Code: src/payments.js (routes, Razorpay, webhook), src/license.js (quote, createCheckout, applyCheckout),
public/assets/app.js (planPicker).
