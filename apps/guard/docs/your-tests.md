# Your tests: the file format

Every store gets the same built-in checks. On top of them, a store owner can add their own tests for things only
their store has (a pincode checker, a size guide, a gift-wrap option). A test is written as a file, in YAML or JSON.
Nothing in the file is run as code: each step comes from the fixed list below, and Tharam's own step runner carries
it out in the test browser, on the store's own address only, stopping before payment.

```yaml
tests:
  - name: Delivery checker works      # shown in reports and alerts
    severity: major                   # critical, major (default) or minor
    runs: full                        # journeys (every shopping check) or full (the daily full check, default)
    device: mobile                    # desktop (default) or mobile
    enabled: true                     # false keeps the test in the file but doesn't run it
    fix: Check the delivery app.      # optional: what to do when it fails
    steps:
      - open: "{product}"
      - fill: "#pincode"
        value: "560001"
      - click: "text=Check"
      - expect_text: ".delivery-result"
        contains: "Delivery available"
```

## Steps

| Step | Value | Also takes |
| --- | --- | --- |
| `open` | a page of the store: `"/pages/contact"`, `"{product}"` | |
| `click` | a target | |
| `fill` | a target | `value` |
| `choose` | a target (a drop-down, or a button that opens choices) | `option` |
| `quantity` | a number | |
| `add_to_cart` | `true` | |
| `open_cart` | `true` | |
| `checkout` | `true` (opens checkout, never pays) | |
| `wait_for` | a target | `timeout` (seconds, up to 30) |
| `expect_visible` / `expect_hidden` | a target | |
| `expect_text` | a target | `contains` |
| `expect_price` | a target | `equals`, or `min` and/or `max` |
| `expect_count` | a target | `equals`, or `min` and/or `max` |
| `expect_url` | text the address must contain | |
| `expect_cart_total` | a number, or `{ min: 1000, max: 2000 }` (store currency) | |
| `expect_cart_items` | a number, or `{ min: 1 }` | |
| `expect_no_errors` | `true` (no script errors since the test started) | |

**Targets:** a CSS selector (`"#pincode"`), visible text (`"text=Check"`), or a role and its name
(`"role=button:Check"`). The object forms `{ css: … }`, `{ text: … }` and `{ role: button, name: Check }` work too.

**Values from your store:** `{product}` (the test product's page), `{product_handle}`, `{product_title}`,
`{variant}` (its first variant id), `{price}` and `{store}` (the store's address).

## Limits

- Tests per store: set by the plan (Starter 3, Growth and Beta 10, Pro 25; plans without a setting get 5).
- At most 25 steps per test, and 60 seconds per test. All of a store's tests in one check share 150 seconds.
- Pages of the store only. Shopify's own checkout pages are allowed; any other site stops the test.
- Files up to 100 KB. YAML: anchors (`&`, `*`), tags and multi-line `|` / `>` text are not supported.

## API (owner only)

- `GET /api/stores/:id/custom-tests` — current file, tests, limits and version history. `?version=N` for an older
  version, `?download=1` for the file itself.
- `PUT /api/stores/:id/custom-tests` — upload: the file as the body (`text/yaml` or JSON), or `{ "text": "…" }`.
  Mistakes come back as `400 { error, problems: ["Test 1 (“…”), step 3: “click” needs a target …"] }`.
  Every saved file becomes a new version; older versions are never deleted.
- `POST /api/stores/:id/custom-tests/draft` — `{ description, page? }`: AI opens the page (your test product by default),
  reads its outline and drafts one test in this format. Returns `{ test, note, left }`; nothing is saved. Only when the
  server has an AI key and the plan includes AI; drafts per account per day are set by the plan (`aiDrafts`, default 20).
  A draft that breaks the rules above is refused (`422`), never handed on.
- `POST /api/stores/:id/custom-tests/templates/:key` — `{ values }`: adds a ready-made template (delivery checker,
  cash on delivery, size guide, store locator, gift card, subscription, reviews, wishlist, newsletter, WhatsApp/chat,
  language or currency switcher; see `src/custom-test-templates.js`) with the owner's values, as a new version.
  Blanks left empty keep their defaults. The newsletter template only checks the form unless `submit: true`.
- `POST /api/stores/:id/custom-tests/:name/try` — run one test now; returns each step with its result and a
  screenshot. `{ "text": "…" }` tries a test from a file that isn't saved yet.
