# Store Guard

Shops a Shopify store like a real customer on a schedule and alerts the owner when something breaks.

## What it tests

- **Shopping journey:** homepage, collection, search, product page and price, variant selection, add to cart (real button, verified through Shopify's cart API, with diagnosis when the button is broken but the cart works), cart page, checkout opens (stops before payment, then empties the cart).
- **Non-functional:** mobile speed (LCP, layout shift, page weight, slow third-party apps), SEO basics and accidental `noindex`, accessibility (axe-core WCAG A/AA), broken homepage links, JavaScript errors during the journey, mixed content, policy pages, catalog quality (zero prices, missing images or descriptions).
- **Regression:** viewport screenshots on desktop and mobile compared against an approved baseline.

Products and collections are discovered automatically from `/products.json` and `/collections.json`.

## How it runs

- **Free check** (`kind: free`): public, rate-limited per IP, cached per URL for an hour.
- **Monitoring**: journeys every `JOURNEY_INTERVAL_MIN` (default 3h), full scan with visual regression every `FULL_SCAN_INTERVAL_MIN` (default 24h). Stores failing critically are re-checked every 30 minutes.
- **Alerts** go out only when a check changes state (broke or recovered). A newly failing critical check is re-tested a minute later before alerting, to avoid false alarms.

## Code map

| File | Role |
|---|---|
| `src/server.js` | HTTP API, accounts, website routes |
| `src/engine/discover.js` | Learns products and collections from public Shopify endpoints |
| `src/engine/functional.js` | Shopping journey checks |
| `src/engine/nonfunctional.js` | Speed, SEO, accessibility, links, errors, catalog |
| `src/engine/visual.js` | Screenshot baselines and diffs |
| `src/engine/score.js` | Health score and verdict |
| `src/queue.js` | In-process run queue, stop/cancel, failure confirmation |
| `src/live.js` | Live progress of running tests |
| `src/scheduler.js` | Monitoring schedule |
| `src/alerts.js` | Email (SMTP) and Slack alerts |
| `public/` | tharam.store website, report page, dashboard |


## Catalog checksum mode and AI review

Every full check on a monitored Shopify store also:
- **Reads the whole catalog** from `/products.json`, fingerprints each product, and logs what changed since any earlier check (price, sale started/ended, stock, description edits with the exact text, products added/removed).
- **Validates every product**: zero or missing prices, fake discounts (compare-at ≤ price), price drops over 50%, placeholder text (lorem ipsum, `{{ }}`, undefined, TBD), raw HTML, empty or duplicate descriptions, ALL-CAPS titles, missing images, duplicate SKUs, and whether product counts match the sitemap and collections.

With an AI key set (`AI_API_KEY`, Anthropic by default), two more checks run on full checks:
- **AI visual review** looks at each page on desktop and mobile and reports what a shopper would notice (overlaps, cut-off text, broken images, popups over the buy button).
- **AI copy review** checks product titles and descriptions for spelling, grammar and contradictions. Only new or edited products are sent, and every answer is cached by content hash, so cost stays near zero.
- **Explain this change** (on-demand in Reports) uses AI to describe what changed between two screenshots and whether it looks intentional or like a bug.

AI is provider-agnostic: set `AI_PROVIDER=openai`, `AI_BASE_URL` and model names for any OpenAI-compatible API (text-only providers skip the vision checks).

## Running validations by hand

Every manual run starts from **Run validations** (`#/s/:id/run`): pick a preset (Quick journey, Your test suite, Everything) or individual validations, review the run plan (steps, test product, time, what happens to the cart), then start. The selection applies to that run only unless "Also use this selection for scheduled checks" is ticked.

While a run is queued or running, its page shows live progress: the current phase, elapsed time, pass/fail tally, problems found so far and the browser's own steps (`src/live.js`). **Stop test** closes the test browser within a few seconds; a stopped run is saved as `cancelled`, keeps no results and sends no alerts.

## Reports

Every finished check is a report. In the Reports section you pick any report and compare it with the previous one, the same time a day or a week before, or any specific earlier report. The comparison shows what newly broke, what was fixed, every validation area's pass/fail with before/after, speed and page-weight trends, journey step timings, catalog changes, AI findings, and desktop/tablet/mobile screenshots with a pixel difference. Save as PDF prints a clean copy.

## Local development

```bash
cd apps/guard
npm install
npm run mock                                   # fake Shopify store on :4100 (MOCK_BREAK=atc,checkout,search,jserror,noindex,links,password)
ALLOW_LOCAL_TARGETS=1 npm start                # app on :3000
CHROME_PATH=/path/to/chrome npm test           # engine tests against the mock store
```

## Checking for false alarms on real stores

On the server:

```bash
cd /opt/tharam/deploy
docker compose exec guard node src/verify.js
docker compose cp guard:/app/verify-report.json .
```

Any store flagged `critical` that works fine in a browser is a false alarm to tune.
