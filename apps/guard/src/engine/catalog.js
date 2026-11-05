import { cleanCodes } from './discount.js';
/**
 * The test suite catalog: every check belongs to one group, and merchants switch groups on or off per store.
 * `run`: 'journeys' groups run on every scheduled journey test; 'full' groups run on the daily full check.
 */
export const GROUPS = [
  { key: 'journey.core', label: 'Store, product page and add to cart', run: 'journeys', locked: true, area: 'Shopping journey',
    description: 'Homepage loads, a product page shows its price, and Add to cart really adds the item. Always on: this is the heart of every test.',
    checks: ['fn.home', 'fn.pdp', 'fn.atc', 'fn.platform', 'fn.engine'] },
  { key: 'journey.collection', label: 'Collection page', run: 'journeys', area: 'Shopping journey',
    description: 'A collection page renders its product grid.', checks: ['fn.collection'] },
  { key: 'journey.search', label: 'Search', run: 'journeys', area: 'Shopping journey',
    description: 'Searching a word from one of your product titles returns results.', checks: ['fn.search'] },
  { key: 'journey.variant', label: 'Variant selection', run: 'journeys', area: 'Shopping journey',
    description: 'Picking a different size or colour selects it in the product form.', checks: ['fn.variant'] },
  { key: 'journey.checkout', label: 'Cart and checkout', run: 'journeys', area: 'Shopping journey',
    description: 'The cart lists the item and checkout opens. Stops before payment, then empties the cart.', checks: ['fn.cart', 'fn.checkout'] },
  { key: 'sale.discount', label: 'Discount codes', run: 'full', area: 'Shopping journey',
    description: 'Your sale codes applied to a real cart: the price really drops, by the amount you expect. Nothing is bought; the cart is emptied. Add codes under Test suite → Discount codes.', checks: ['fn.discount.'] },
  { key: 'errors.js', label: 'JavaScript errors', run: 'journeys', area: 'Errors and links',
    description: 'Script errors that happen while shopping, usually from apps or custom code.', checks: ['nf.jserrors'] },
  { key: 'speed', label: 'Mobile speed', run: 'full', area: 'Speed',
    description: 'Load time, layout shifts, page weight, slow third-party apps and insecure content on mobile.', checks: ['nf.speed.', 'nf.cls.', 'nf.weight.', 'nf.mixed.'] },
  { key: 'seo', label: 'SEO basics', run: 'full', area: 'SEO and accessibility',
    description: 'Titles, descriptions, headings, canonical links, share images, and pages hidden from Google.', checks: ['nf.seo.'] },
  { key: 'a11y', label: 'Accessibility', run: 'full', area: 'SEO and accessibility',
    description: 'Automated WCAG 2 A/AA checks and image alt text.', checks: ['nf.a11y.', 'nf.alt'] },
  { key: 'links', label: 'Broken links', run: 'full', area: 'Errors and links',
    description: 'Links in your homepage, menus and footer.', checks: ['nf.links'] },
  { key: 'policies', label: 'Store policies', run: 'full', area: 'Catalog and products',
    description: 'Privacy, refund, terms and shipping policies are published.', checks: ['nf.policies'] },
  { key: 'catalog', label: 'Catalog checks', run: 'full', area: 'Catalog and products',
    description: 'Every product checked for pricing mistakes, fake discounts, placeholder or duplicate text, missing images, duplicate SKUs, and whether product counts add up. Also logs what changed since the last check.',
    checks: ['nf.catalog', 'cat.pricing', 'cat.content', 'cat.media', 'cat.data', 'cat.counts', 'cat.changes'] },
  { key: 'ai.visual', label: 'AI visual review', run: 'full', area: 'AI review', ai: true,
    description: 'An AI reviewer looks at your pages on desktop and mobile like a shopper would, catching overlapping or cut-off text, broken images, popups covering the buy button, and layout problems.',
    checks: ['ai.visual'] },
  { key: 'ai.copy', label: 'AI copy review', run: 'full', area: 'AI review', ai: true,
    description: 'An AI editor checks product titles and descriptions for spelling, grammar and contradictions (for example a silk product described as cotton). Only new or edited products are reviewed, to keep it fast.',
    checks: ['ai.copy'] },
  { key: 'visual', label: 'Visual changes', run: 'full', area: 'Regression',
    description: 'Screenshots of key pages on desktop and mobile compared with the look you approved.', checks: ['nf.visual'] },
  // Regional packs run only for stores that sell in those markets (Store settings → Where you sell).
  { key: 'law.de', label: 'Germany and Austria legal pack', run: 'full', area: 'Laws where you sell', markets: ['DE', 'AT'],
    description: 'Impressum, right of withdrawal, the new “Vertrag widerrufen” button, privacy policy and terms, VAT and shipping next to prices, unit prices (Grundpreis), and outdated EU dispute (ODR) links.',
    checks: ['de.'] },
  { key: 'law.cookies', label: 'Cookie consent (EU and UK)', run: 'full', area: 'Laws where you sell', markets: ['DE', 'AT', 'EU', 'UK'],
    description: 'Visits as a first-time shopper from Germany: a consent banner appears, and no ad or tracking tags (Meta, TikTok, Google and others) fire before the shopper agrees.',
    checks: ['eu.'] },
  { key: 'access.law', label: 'Accessibility law readiness (ADA, European Accessibility Act)', run: 'full', area: 'Laws where you sell', markets: ['US', 'DE', 'AT', 'EU', 'UK'],
    description: 'What accessibility lawsuits and regulators look for: Add to cart works with a keyboard and shows focus, zoom is allowed, page language is set, the cart page passes WCAG 2.1 AA, an accessibility statement exists, and no overlay widget is relied on.',
    checks: ['ax.'] },
  { key: 'law.us', label: 'US privacy choices', run: 'full', area: 'Laws where you sell', markets: ['US'],
    description: 'The “Do not sell or share my personal information” link that California and other US state privacy laws ask for.',
    checks: ['us.'] },
];

/** Where a store can sell, for regional packs. */
export const MARKETS = [
  { code: 'US', label: 'United States' }, { code: 'DE', label: 'Germany' }, { code: 'AT', label: 'Austria' },
  { code: 'EU', label: 'Other EU countries' }, { code: 'UK', label: 'United Kingdom' }, { code: 'IN', label: 'India' },
  { code: 'SG', label: 'Singapore' }, { code: 'AU', label: 'Australia' }, { code: 'CA', label: 'Canada' }, { code: 'AE', label: 'United Arab Emirates' },
];

/**
 * Groups that are off for a run: the store's own choices (or a hand-picked selection), plus regional packs
 * for markets the store doesn't sell in. A hand-picked selection may include any regional pack.
 */
export function effectiveDisabled(cfg = {}, picked = null) {
  if (picked) return picked;
  const markets = cfg.markets || [];
  const off = GROUPS.filter((g) => g.markets && !g.markets.some((m) => markets.includes(m))).map((g) => g.key);
  return [...new Set([...(cfg.disabled || []), ...off])];
}

export function groupOf(checkId) {
  for (const g of GROUPS) for (const c of g.checks) if (c.endsWith('.') ? checkId.startsWith(c) : checkId === c) return g.key;
  return null;
}

export const INTERVALS = [30, 60, 180, 360, 720, 1440];
export const FULL_INTERVALS = [720, 1440, 10080];

export function normalizeConfig(input = {}, base = {}) {
  const cfg = { ...base };
  if (input.discountCodes !== undefined) cfg.discountCodes = cleanCodes(input.discountCodes);
  // Onboarding progress: the welcome flow and the first-report tour.
  if (typeof input.onboarded === 'boolean') cfg.onboarded = input.onboarded;
  if (typeof input.toured === 'boolean') cfg.toured = input.toured;
  // Video replay of failed shopping journeys (kept 7 days).
  if (typeof input.failureVideo === 'boolean') cfg.failureVideo = input.failureVideo;
  if (Array.isArray(input.disabled)) cfg.disabled = input.disabled.filter((k) => GROUPS.some((g) => g.key === k && !g.locked));
  if (input.testProduct !== undefined) cfg.testProduct = input.testProduct ? String(input.testProduct).slice(0, 200) : null;
  if (input.journeyIntervalMin !== undefined && INTERVALS.includes(Number(input.journeyIntervalMin))) cfg.journeyIntervalMin = Number(input.journeyIntervalMin);
  if (input.dailySales !== undefined) { const n = Number(input.dailySales); cfg.dailySales = Number.isFinite(n) && n > 0 ? Math.round(n) : null; }
  if (Array.isArray(input.markets)) cfg.markets = [...new Set(input.markets.map(String).filter((m) => MARKETS.some((x) => x.code === m)))];
  if (input.currency !== undefined) cfg.currency = /^[A-Z]{3}$/.test(String(input.currency)) ? String(input.currency) : null;
  if (input.fullIntervalMin !== undefined && FULL_INTERVALS.includes(Number(input.fullIntervalMin))) cfg.fullIntervalMin = Number(input.fullIntervalMin);
  return cfg;
}
