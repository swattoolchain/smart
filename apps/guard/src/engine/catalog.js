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
];

export function groupOf(checkId) {
  for (const g of GROUPS) for (const c of g.checks) if (c.endsWith('.') ? checkId.startsWith(c) : checkId === c) return g.key;
  return null;
}

export const INTERVALS = [60, 180, 360, 720, 1440];
export const FULL_INTERVALS = [720, 1440, 10080];

export function normalizeConfig(input = {}, base = {}) {
  const cfg = { ...base };
  if (Array.isArray(input.disabled)) cfg.disabled = input.disabled.filter((k) => GROUPS.some((g) => g.key === k && !g.locked));
  if (input.testProduct !== undefined) cfg.testProduct = input.testProduct ? String(input.testProduct).slice(0, 200) : null;
  if (input.journeyIntervalMin !== undefined && INTERVALS.includes(Number(input.journeyIntervalMin))) cfg.journeyIntervalMin = Number(input.journeyIntervalMin);
  if (input.fullIntervalMin !== undefined && FULL_INTERVALS.includes(Number(input.fullIntervalMin))) cfg.fullIntervalMin = Number(input.fullIntervalMin);
  return cfg;
}
