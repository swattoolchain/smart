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
| `src/queue.js` | In-process run queue, failure confirmation |
| `src/scheduler.js` | Monitoring schedule |
| `src/alerts.js` | Email (SMTP) and Slack alerts |
| `public/` | tharam.store website, report page, dashboard |

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
