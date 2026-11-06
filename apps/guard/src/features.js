/**
 * Feature switches for the whole product, set by founders in the founder console.
 *
 * Every feature that is not part of the basic product has a switch here. A switch that is off
 * hides the feature everywhere: its menu items and pages, its API routes (they answer 404) and its
 * checks (the engine skips them). Turning a switch on or off is recorded in the audit log.
 *
 * Defaults: core features are on; everything else starts off, so a fresh install shows the simple
 * product. FEATURES_DEFAULT=on (used by the test harness) starts every switch on instead.
 *
 * Add a switch when a feature lands: { key, label, about, group, core? }. The key never changes.
 */
import { db } from './db.js';
import { audit } from './license.js';

db.exec(`CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);`);

/**
 * The switches, in founder console order. `area` groups them on screen. `checks` lists the check
 * groups (src/engine/checks.js) that belong to the feature: when it is off they don't run and
 * aren't offered in Test suite. `core: true` = on unless a founder turns it off.
 */
export const FLAGS = [
  { key: 'sale_report', area: 'Sales', label: 'Sale readiness report', about: 'One report and email before a big sale: buying on a phone, prices, discount codes, speed and looks.' },
  { key: 'webhooks', area: 'Alerts', label: 'Webhook alerts', about: 'Alerts to Zapier, Make, Microsoft Teams, Discord or the owner\'s own system, signed, with retries.' },
  { key: 'app_health', area: 'Apps', label: 'App health', about: 'Every app seen on the storefront: pages it loads on, phone speed cost, errors, code changes, outside sites and missing widgets. Needs script watch for its data.' },
  { key: 'script_watch', area: 'Security watch', label: 'Script watch', about: 'Every script and outside site on the home, product and cart pages; alerts on new scripts, known card-skimming sites and scripts reading form fields; links new failures to new scripts.', checks: ['security.scripts'] },
  { key: 'hijack_watch', area: 'Security watch', label: 'Redirects, hidden pages and mining', about: 'Shoppers sent to other sites, hidden frames and crypto-mining scripts.', checks: ['security.hijack'] },
  { key: 'theme_watch', area: 'Security watch', label: 'Theme code changes', about: 'Fingerprints every file of the live Shopify theme on each full check and shows changed lines.', checks: ['security.theme'] },
  { key: 'variant_sweep', area: 'Checks', label: 'Every variant can be added to the cart', about: 'Each full check adds every variant once through the cart and reports broken or unpublished ones.', checks: ['catalog.variants'] },
  { key: 'failure_video', area: 'Reports', label: 'Video replay of failures', about: 'Owners can record a video when a shopping check fails; kept 7 days, owner-only.' },
  { key: 'sale_traffic', area: 'Sales', label: 'Sale traffic test', about: 'Opt-in: up to 5 shoppers at once during the full check, to show slowdowns before a sale.', checks: ['sale.traffic'] },
  { key: 'ai_shopper', area: 'AI', label: 'AI shopper', about: 'A goal-driven shopper that browses and buys on any theme and reports friction, also on draft themes in Safe to publish. Needs the AI key.', checks: ['ai.shopper'] },
  { key: 'teams', area: 'Accounts', label: 'Team members (agencies)', about: 'Website accounts invite team members with roles. Members already invited can still switch back and leave while this is off.' },
  { key: 'spam_watch', area: 'Security watch', label: 'Spam links and defacement', about: 'Hidden spam links in page code, and pages that look defaced.', checks: ['security.spam', 'security.deface'] },
  { key: 'tamper_watch', area: 'Security watch', label: 'Product and discount tampering', about: 'Zero prices, mass edits, swapped products and unexpected discount codes, with before and after.', checks: ['security.tamper'] },
  { key: 'domain_watch', area: 'Security watch', label: 'Domain, certificate and email records', about: 'Domain and certificate expiry warnings; DNS, SPF and DMARC changes.', checks: ['security.domain'] },
  { key: 'security_checklist', area: 'Security watch', label: 'Security checklist', about: 'Owner-ticked checklist (two-step login, staff and app review, passwords) with reminders and a score.' },
  { key: 'incident_mode', area: 'Security watch', label: 'Incident mode and recovery packet', about: 'One button for a suspected hack: changes since the last healthy check, frequent checks, recovery steps, team alerts and a ready message for Shopify support.' },
  { key: 'price_checks', area: 'Checks', label: 'Prices stay the same', about: 'Records the price from product page to cart to checkout on every check; owners can add price rules under Test suite.', checks: ['pricing.journey'] },
  { key: 'ab_tests', area: 'Checks', label: 'A/B test versions', about: 'Finds A/B and price-test apps and shops once in every test version (owner-listed, or found automatically for Convert and Optimizely). Adds Test suite → A/B tests.', checks: ['sale.abtest'] },
  { key: 'woocommerce', area: 'Platforms', label: 'WooCommerce shopping tests', about: 'Add to cart and checkout tests for WooCommerce stores through the public Store API. Off: WooCommerce stores get the same checks as other non-Shopify platforms.' },
  { key: 'laws', area: 'Checks', label: 'Laws where you sell', about: 'Checks for the German legal notice, EU cookie consent and US accessibility, and the "Where you sell" setting.', checks: ['law.de', 'law.cookies', 'access.law', 'law.us'] },
].map((f) => ({ area: 'Other', core: false, checks: [], ...f }));

for (const f of FLAGS) if (!/^[a-z][a-z0-9_]*$/.test(f.key)) throw new Error(`Bad feature key ${f.key}`);

const S = {
  get: db.prepare('SELECT enabled FROM feature_flags WHERE key = ?'),
  all: db.prepare('SELECT key, enabled, updated_at, updated_by FROM feature_flags'),
  put: db.prepare(`INSERT INTO feature_flags (key, enabled, updated_by) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now'), updated_by = excluded.updated_by`),
};

const allOn = () => String(process.env.FEATURES_DEFAULT || '').toLowerCase() === 'on';
const flag = (key) => FLAGS.find((f) => f.key === key);
const defaultOf = (f) => (allOn() ? true : !!f.core);

/** Whether a feature is on. Unknown keys are off. */
export function isOn(key) {
  const f = flag(key);
  if (!f) return false;
  const row = S.get.get(key);
  return row ? row.enabled === 1 : defaultOf(f);
}

/** Keys of the features that are on, for the browser (to show menus and pages). */
export function enabledKeys() {
  return FLAGS.filter((f) => isOn(f.key)).map((f) => f.key);
}

/** Whether a check group may run: false when it belongs to a feature that is off. */
export function checkOn(group) {
  return FLAGS.every((f) => !f.checks.includes(group) || isOn(f.key));
}

/** Check groups that belong to features that are off. */
export function offChecks() {
  return FLAGS.filter((f) => !isOn(f.key)).flatMap((f) => f.checks);
}

/** Every switch with its state, for the founder console. */
export function flagList() {
  const rows = Object.fromEntries(S.all.all().map((r) => [r.key, r]));
  return FLAGS.map((f) => ({
    key: f.key, label: f.label, about: f.about || '', area: f.area, core: !!f.core,
    on: rows[f.key] ? rows[f.key].enabled === 1 : defaultOf(f),
    changed: rows[f.key] ? { at: rows[f.key].updated_at, by: rows[f.key].updated_by } : null,
  }));
}

/** Turns a switch on or off. Audited. */
export function setFlag(actor, key, on) {
  const f = flag(key);
  if (!f) throw new Error('Unknown feature');
  const before = isOn(key);
  S.put.run(key, on ? 1 : 0, String(actor));
  if (before !== !!on) audit(actor, null, 'feature.change', { key, label: f.label, before, after: !!on });
}

/** Route guard: a feature that is off answers as if the route did not exist. */
export function requireFeature(key) {
  return (req, res, next) => (isOn(key) ? next() : res.status(404).json({ error: 'Not found' }));
}
