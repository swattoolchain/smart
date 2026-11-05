# Working on this repo

Tharam (tharam.store) is a Commerce Assurance platform: it shops a store like a customer, around the clock, and tells the owner in plain words when buying breaks. Shopify is the main vertical; WooCommerce and marketplaces come later. The product lives in `apps/guard`.

## How work happens here (autonomous task engine)

Work comes from the task sheet "Tharam task queue" (Google Sheets, tab `Tasks`). Unattended runs take tasks from it and open pull requests. A human reviews and merges; nothing reaches production without that.

- Branch per task: `claude/<ID>-<short-slug>` from the latest `main`. PR title: `[<ID>] <task>`.
- PR body: what changed, why, how to test, assumptions made, and the test evidence (the counts from `test-results/summary.md`; the full HTML report is the `tharam-test-report` artifact of the CI run).
- One task per PR. Keep changes scoped to it.
- Every feature task adds or updates tests in `apps/guard/test/` (see below). A feature without tests is not done.
- Done means: PR open, CI green, sheet row updated (Status `pr_open`, Branch/PR link, Notes).

### Hard rules
- Never push to `main`, never merge your own PR, never bypass branch protection, never force-push a shared branch.
- Never read, print, change or commit secrets: `.env` files, SSH keys, GitHub Secrets, API keys, Shopify or Razorpay secrets. Tests use the fake values in `test/lib/harness.js` only.
- Never connect to the production server (Contabo VPS). Deployment is done by the owner.
- Never change `.github/workflows/*` or `deploy/*` unless the task explicitly says so.
- Nothing destructive: no data-losing migrations (add columns and tables; never drop or rewrite user data), no deleting branches you did not create.
- Ambiguous, too large, or needs a credential or a human decision: set the row to `blocked` with exactly what is needed, and move on.
- Bigger than one run: finish a coherent first part, open its PR, and add new `pending` rows for the rest.
- Shopify App Store rules apply to anything in the embedded app: everything must work inside Shopify admin, Shopify accounts are billed only through Shopify billing, no extra login before use, and new Shopify permissions (scopes) are a human decision: mark such tasks `blocked` with the reason.

## Run it

```
cd apps/guard
npm ci
npm test            # whole suite: engine, API and screens; writes test-results/report.html
npm run test:engine # just the check engine against the mock store
npm run mock        # mock Shopify storefront on :4100
ALLOW_LOCAL_TARGETS=1 npm start   # app on :3000
```

Chromium: `npx playwright install chromium` (or set `CHROME_PATH`). Node 22.

## Tests and evidence

- Node's built-in runner (`node:test`), one file per feature: `apps/guard/test/<feature>.test.js`.
- `test/lib/harness.js` starts the whole product in isolation: a mock storefront, fake Shopify and Razorpay APIs, and the server on a free port with a temporary database. Use `startProduct()`, `signup()`, `shopifyOpen()`, `addStore()`, `runAndWait()`, `lastMailLink()`.
- `test/lib/evidence.js`: `note(t, text)` records what was checked; `screenshot(t, page, label)` saves a screenshot. Both appear in the HTML report next to the test.
- Test what the store owner relies on: the happy path, the refusals (other accounts, bad input, expired links), and at least one screenshot for anything on screen.
- The mock store (`test/mock-store.js`) has breakage switches (`MOCK_BREAK`) and extras (`MOCK_EXTRA`); add new switches there when a feature needs a new kind of broken store.

## Code conventions

- Express 5, better-sqlite3, Playwright. No new dependencies without a clear reason in the PR.
- Database changes: `ensureColumn` and `CREATE TABLE IF NOT EXISTS` in `src/db.js` (or the feature's module), never destructive.
- Every route that takes an id checks ownership (`ownStore` or equivalent). The isolation test lists every store route; add new ones to `STORE_ROUTES` in `test/isolation.test.js`.
- Plan limits are enforced on the server (`src/license.js`: `entitlements`, `has`), never only in the browser.

## Writing for store owners

Everything a store owner reads (screens, emails, alerts, reports) is plain language: short sentences, no jargon, say what happened and what to do. "Customers can't add this product to the cart" — not "ATC selector failed". Project the vision of the product, not internal progress.
