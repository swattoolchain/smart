# Shopify App Store submission pack: Tharam

Everything needed to fill in the app listing and the review form in the Partner Dashboard. The form shows a character counter on every field; the texts below are written to fit, but trim if the counter says so.

## App name

**Tharam: Store Monitoring**

The brand comes first, as the App Store rules ask. Alternatives if the name is taken: "Tharam: Store Health Monitor", "Tharam: Checkout Monitor".

## App icon

`public/assets/brand/` holds the Tharam mark. Upload a 1200×1200 PNG with no text, on a solid background.

## Introduction (one line)

> Know your store works before your customers find out: we shop it like a customer, around the clock.

## App details

> Tharam shops your store the way a customer does: it searches, opens products, picks a size, adds to cart and reaches checkout, on desktop and phone, around the clock. When something breaks, you get a plain-language alert that says what happened and how to fix it, with a screenshot.
>
> Before you publish a new theme, Tharam checks the draft side by side with your live store and tells you if it is safe. It also watches every product for zero prices, fake discounts and placeholder text, tests your discount codes, and alerts you if checkout is ever sent to another website.

## Feature list

1. Shops your store like a customer, every few minutes to every few hours
2. Alerts you in plain words, with a screenshot, when buying breaks
3. Checks a draft theme against your live store before you publish
4. Finds zero prices, fake discounts, placeholder text and missing images
5. Tests your discount codes and gets you ready for big sales
6. Alerts you at once if checkout sends shoppers to another website
7. Tracks speed on phones, Google visibility and accessibility
8. Shows rules met for the countries you sell in (Germany, US and more)

## Pricing (managed pricing, set up under the app's Pricing in the Partner Dashboard)

| Plan | Monthly (USD) | Yearly (USD) | What it adds |
| --- | --- | --- | --- |
| Starter | $19 | $190 | Daily shopping checks, speed, Google and accessibility, email alerts |
| Growth | $49 | $490 | Checks every hour, product checks, visual changes, Safe to publish, laws where you sell, Slack |
| Pro | $99 | $990 | Checks every 30 minutes and everything in Tharam, including AI review |

Prices are per store (one Shopify store = one subscription). They match the plans in `src/license.js`.

**Decision for Dinesh before submitting:** new installs currently get the free **Beta** plan with everything included (`signup_plan` setting). Either keep a free plan in the listing ("Free during launch") or switch new installs to a 14-day trial of Pro. Reviewers must be able to use every feature without paying; both options allow that.

## How to test the app (for the reviewer)

Paste into "Testing instructions". No separate account, login or password is needed.

> 1. Install Tharam on your development store and open it from the Apps menu. You are signed in automatically through Shopify.
> 2. The setup takes four short steps. Tharam reads your store's name, domain and currency from Shopify. If your development store has a storefront password, enter it in step 2 so Tharam can shop the store like a customer (Online Store → Preferences shows it). Choose who gets alerts in step 3, then start the first check in step 4.
> 3. The first full check takes 2–3 minutes. The home screen then shows whether customers can buy, the main numbers, anything that needs attention, and quick actions.
> 4. Open any report to see every check, grouped in tabs, with screenshots.
> 5. "Safe to publish" lists your unpublished themes. Choose one to check it against your live theme.
> 6. "Account and plan" → "Plan and billing" opens Shopify's plan page. All charges go through Shopify.
>
> Tharam only reads your store (themes, products and discounts). Test carts are anonymous and emptied after each check; Tharam never places an order or enters payment details.

## Permissions (scopes) and why

| Scope | Why Tharam needs it |
| --- | --- |
| `read_themes` | List unpublished themes for Safe to publish, and check a draft before it goes live. Also re-checks the store when a new theme is published. |
| `read_products` | Check every product for zero prices, fake discounts, placeholder text and missing images, and pick a test product. |
| `read_discounts` | Find the store's discount codes so Tharam can check they apply and give the right amount. |

Tharam asks for no write permissions and no customer or order data.

## Data and privacy (review form answers)

- **Customer data:** none. Tharam never reads customers or orders. The `customers/data_request` and `customers/redact` webhooks are acknowledged; there is nothing to return or delete.
- **Shop data stored:** store name, domain, currency, contact email for alerts, check results and screenshots of the storefront. Shopify access tokens are encrypted (AES-256-GCM).
- **On uninstall:** checks stop at once. Shopify's `shop/redact` webhook deletes the store's data.
- **Test carts:** anonymous, emptied after each check, no order placed, no payment details entered.
- **Hosting:** Tharam's own server with Contabo in the EU. HTTPS only.
- **Privacy policy:** https://tharam.store/privacy · **Terms:** https://tharam.store/terms

## Support

- Email: hello@tharam.store
- Website: https://tharam.store
- In the app: "How to use Tharam" in the app menu.

## Screenshots (1600×900)

In `docs/listing/`, generated from the real embedded app by `test/listing-screens.test.js` (`WRITE_LISTING=1 node --test test/listing-screens.test.js`):

| File | Caption |
| --- | --- |
| 01-home.png | Can customers buy right now? The answer and your key numbers, at a glance |
| 02-report.png | Every check in one report, with screenshots and fixes |
| 03-products.png | Zero prices, placeholder text and missing images, found for you |
| 04-safe-to-publish.png | Check a new theme before your customers see it |
| 05-run-checks.png | Run a check any time, including a sale readiness check |
| 06-alerts.png | Plain-language alerts when something breaks, and when it's fixed |

## Demo screencast (2–3 minutes, recommended)

1. Open Tharam from Shopify admin (0:00–0:15).
2. The four setup steps (0:15–0:45).
3. Home: the status, the numbers, quick actions (0:45–1:15).
4. A report and its tabs; a product priced at zero (1:15–1:45).
5. Safe to publish with a draft theme (1:45–2:15).
6. The plan page in Shopify (2:15–2:30).

## Before pressing Submit

- [ ] Production runs the `release/shopify-review` branch and the latest deploy is healthy (https://tharam.store/healthz).
- [ ] Pricing plans exist in managed pricing and match the table above.
- [ ] Webhooks are registered (`shopify app deploy` with `shopify.app.toml`), including the three privacy topics.
- [ ] Install and uninstall on a fresh development store once, end to end.
- [ ] The Shopify client secret has been rotated since it was shared in chat.
- [ ] App icon, screenshots, texts and support email filled in.
