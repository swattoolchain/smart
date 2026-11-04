/**
 * Everything the marketing site says about products, platforms and marketplaces lives here,
 * so adding a platform or marketplace is one entry. Status is always honest:
 * live = works today, beta = works with limits, soon = being built, planned = on the roadmap.
 */

export const STATUS = {
  live: { label: 'Live', tone: 'live' },
  beta: { label: 'Beta', tone: 'beta' },
  soon: { label: 'Coming soon', tone: 'soon' },
  planned: { label: 'Planned', tone: 'planned' },
  early: { label: 'Early access', tone: 'soon' },
};

/** The five pillars of Commerce Assurance, each a product page. */
export const PRODUCTS = [
  {
    slug: 'monitoring', icon: 'pulse', name: 'Journey monitoring', pillar: 'Buyability', status: 'live',
    short: 'A real browser shops your store around the clock and tells you the moment customers can’t buy.',
    title: 'Know the moment customers can’t buy',
    lede: 'Tharam shops your store like a real customer on desktop and phone, as often as every hour: homepage, search, collection, product, variant, add to cart and checkout. When something breaks, it re-tests to confirm, then alerts you with a screenshot and how to fix it.',
    points: [
      ['The whole buying journey', 'Search, collections, product pages, variant pickers, add to cart, cart and checkout, verified through the store’s own cart, not just by clicking.'],
      ['Diagnosis, not just a red light', 'When the button is broken but the cart works, Tharam says so, and points at the theme code or app that is likely responsible.'],
      ['No false alarms', 'A new critical failure is re-tested a minute later before anyone is woken up. Bot protection is reported as “blocked”, never as your store being broken.'],
      ['Alerts only on change', 'One alert when something breaks and one when it recovers, by email or Slack, with the report link.'],
    ],
  },
  {
    slug: 'safe-to-publish', icon: 'publish', name: 'Safe to publish', pillar: 'Release safety', status: 'live',
    short: 'Test a draft theme against your live store before it goes live, with one clear verdict.',
    title: 'Publish theme changes without fear',
    lede: 'Paste a theme preview link. Tharam runs your full test suite on the draft and on your live theme side by side, compares every check, screenshot and speed measure, and gives one verdict: safe to publish, review first, or don’t publish yet.',
    points: [
      ['Draft against live, side by side', 'The same tests on both themes at the same time, so every difference is caused by the draft.'],
      ['What breaks, and what it fixes', 'Every check that works live but fails on the draft, with how it behaves live and how to fix it, and every live problem the draft fixes.'],
      ['Every device', 'Desktop, tablet and phone screenshots of the draft and live store, with changed pixels highlighted.'],
      ['Nothing touches your store', 'The draft is opened only in Tharam’s test browser. Nothing is published, and no orders are placed.'],
    ],
  },
  {
    slug: 'catalog', icon: 'catalog', name: 'Catalog guard', pillar: 'Catalog integrity', status: 'live',
    short: 'Every product checked for pricing mistakes, placeholder text and missing images, with a log of what changed.',
    title: 'Catch catalog mistakes before customers do',
    lede: 'Tharam reads your whole catalog on every full check, fingerprints each product and validates it the way a careful merchandiser would. You see what is wrong and exactly what changed since the last check: prices, sales, stock, descriptions and images.',
    points: [
      ['Pricing mistakes', 'Zero prices, “sales” where the compare-at price isn’t higher, and price drops of more than half, shown in your store’s currency.'],
      ['Content that looks unfinished', 'Lorem ipsum, TBD, template code and raw HTML showing as text, empty or duplicate descriptions.'],
      ['Data that breaks operations', 'Duplicate SKUs, missing images, and product counts that don’t match your sitemap or collections.'],
      ['A change log for every product', 'Who changed what is in your admin; what changed, and when, is in Tharam, word by word.'],
    ],
  },
  {
    slug: 'experience', icon: 'speed', name: 'Experience checks', pillar: 'Experience quality', status: 'live',
    short: 'Speed, SEO, accessibility, broken links, script errors and visual changes, on any platform.',
    title: 'Fast, findable and accessible, on every device',
    lede: 'The things that quietly cost sales: a slow phone experience, a page accidentally hidden from Google, a broken link in the menu, a script error from an app update, a layout that shifted. Tharam checks them on every full check, on any e-commerce platform.',
    points: [
      ['Mobile speed', 'Load time, layout shift, page weight and the third-party apps slowing you down, by name.'],
      ['SEO basics', 'Titles, descriptions, headings, canonical links, share images, and pages hidden from Google.'],
      ['Accessibility', 'Automated WCAG 2 A and AA checks and image alt text, so more customers can buy.'],
      ['Visual changes', 'Desktop, tablet and phone screenshots compared with the look you approved.'],
    ],
  },
  {
    slug: 'ai', icon: 'sparkle', name: 'AI review and AI shoppers', pillar: 'Human-eye checks', status: 'beta',
    short: 'AI reviews pages and product copy like a shopper would. AI shopper agents are coming next.',
    title: 'Everything a human would notice, checked by AI',
    lede: 'Some problems only show up to a person looking at the page: text overlapping an image, a popup covering the buy button, a silk saree described as cotton. Tharam’s AI review looks at your pages and product copy like a shopper would. AI shopper agents, which browse and buy toward a goal on any theme, are being built now.',
    points: [
      ['AI visual review', 'Each page on desktop and phone, reviewed for overlaps, cut-off text, broken images and anything blocking the buy button.'],
      ['AI copy review', 'Spelling, grammar and contradictions in titles and descriptions. Only new or edited products are reviewed.'],
      ['Explain this change', 'Ask why two screenshots differ and whether it looks intended or like a bug.'],
      ['AI shopper agents (coming soon)', 'Goal-driven shoppers, like “find a gift under ₹2,000 and check out”, that report where they struggled.'],
    ],
  },
  {
    slug: 'reports', icon: 'reports', name: 'Reports and Buyability', pillar: 'Proof', status: 'live',
    short: 'Every check is a report you can compare with any earlier one, plus the Buyability score.',
    title: 'Proof your store worked, and what changed',
    lede: 'Every check produces a report. Compare it with the previous check, the same time yesterday or last week, or any report you choose: what newly broke, what was fixed, speed trends, catalog changes and screenshots. Save any report as a PDF for your team or your client.',
    points: [
      ['Compare any two checks', 'Newly broken, fixed and still broken, area by area, with before and after.'],
      ['Buyability', 'The share of tests in which a customer could complete a purchase, over a day, a week and a month.'],
      ['Incidents', 'Each time something broke and how long it took to fix.'],
      ['PDF reports', 'A clean copy of any report, ready to share.'],
    ],
  },
];

/** Own-store platforms. Capabilities: experience (speed/SEO/a11y/links/visual), journey, catalog, publish, app. */
export const PLATFORMS = [
  { slug: 'shopify', name: 'Shopify', status: 'live', blurb: 'Our deepest integration. Every Tharam capability works on Shopify today, and the Shopify app is on its way to the App Store.',
    caps: { experience: 'live', journey: 'live', catalog: 'live', publish: 'live', app: 'soon' },
    notes: ['Works with Online Store 2.0 themes, Dawn and popular premium themes.', 'Password-protected stores are tested using the storefront password.', 'Checkout tests stop before payment; no orders are created.'] },
  { slug: 'woocommerce', name: 'WooCommerce', status: 'beta', blurb: 'Speed, SEO, accessibility, links, errors and visual changes are checked today. Shopping-journey tests and a WordPress plugin are next.',
    caps: { experience: 'live', journey: 'soon', catalog: 'soon', publish: 'planned', app: 'planned' },
    notes: ['WooCommerce’s public Store API makes catalog checks possible without a plugin.', 'The plugin will add order and email checks.'] },
  { slug: 'bigcommerce', name: 'BigCommerce', status: 'beta', blurb: 'Experience checks work today. Journey tests and a BigCommerce app are on the roadmap.',
    caps: { experience: 'live', journey: 'planned', catalog: 'planned', publish: 'planned', app: 'planned' }, notes: [] },
  { slug: 'adobe-commerce', name: 'Adobe Commerce (Magento)', status: 'beta', blurb: 'Experience checks work today. Journey tests and a Magento extension are on the roadmap.',
    caps: { experience: 'live', journey: 'planned', catalog: 'planned', publish: 'planned', app: 'planned' }, notes: [] },
  { slug: 'salesforce-commerce', name: 'Salesforce Commerce Cloud', status: 'beta', blurb: 'Experience checks work today. Journey tests for your storefront are set up with you.',
    caps: { experience: 'live', journey: 'beta', catalog: 'planned', publish: 'planned', app: 'planned' }, notes: ['Talk to us to set up custom journeys for your storefront.'] },
  { slug: 'wix', name: 'Wix', status: 'beta', blurb: 'Experience checks work today. Journey tests are on the roadmap.',
    caps: { experience: 'live', journey: 'planned', catalog: 'planned', publish: 'planned', app: 'planned' }, notes: [] },
  { slug: 'squarespace', name: 'Squarespace', status: 'beta', blurb: 'Experience checks work today. Journey tests are on the roadmap.',
    caps: { experience: 'live', journey: 'planned', catalog: 'planned', publish: 'planned', app: 'planned' }, notes: [] },
  { slug: 'headless', name: 'Custom and headless', status: 'beta', blurb: 'Experience checks work on any storefront. Journey tests for custom and headless stores are set up with you.',
    caps: { experience: 'live', journey: 'beta', catalog: 'planned', publish: 'planned', app: 'planned' }, notes: ['Works with Hydrogen, Next.js and other headless storefronts on a public URL.'] },
];

export const CAPS = [
  ['experience', 'Speed, SEO, accessibility, links, errors and visual changes'],
  ['journey', 'Shopping-journey monitoring (search, add to cart, checkout)'],
  ['catalog', 'Catalog guard (pricing, content, images, change log)'],
  ['publish', 'Safe to publish (draft theme against live)'],
  ['app', 'Native app or plugin'],
];

/** Marketplaces: listing health for brands that sell on them. All early access. */
export const MARKETPLACES = [
  { slug: 'amazon', name: 'Amazon', status: 'early', blurb: 'Listing health for brands selling on Amazon: suppressed listings, lost Buy Box, unwanted sellers on your listing, and changes to your titles, images and prices.',
    watch: ['Listings suppressed or showing as unavailable', 'Losing the Buy Box, or new sellers on your listing', 'Title, image, bullet and price changes you didn’t make', 'Stock-outs and sudden review changes'], via: 'Amazon’s Selling Partner API, authorised by you.' },
  { slug: 'flipkart', name: 'Flipkart', status: 'early', blurb: 'Listing health for brands selling on Flipkart: inactive listings, price and stock mismatches, and content drift.',
    watch: ['Listings that went inactive or out of stock', 'Prices that differ from your own store', 'Content changes on your listings', 'Order flow that suddenly stops'], via: 'Flipkart’s Marketplace Seller APIs, authorised by you.' },
  { slug: 'meesho', name: 'Meesho', status: 'early', blurb: 'Catalog consistency for brands selling on Meesho alongside their own store.',
    watch: ['Prices and stock out of line with your store', 'Listings that disappear', 'Catalog content drift'], via: 'Connected with you during early access.' },
  { slug: 'myntra', name: 'Myntra', status: 'early', blurb: 'Catalog consistency for fashion brands selling on Myntra alongside their own store.',
    watch: ['Prices and stock out of line with your store', 'Listings that disappear', 'Catalog content drift'], via: 'Connected with you during early access.' },
];

export const FAQ = [
  ['Will the tests place fake orders?', 'No. Tests add one item to a fresh cart, open checkout, confirm it loads, then stop and empty the cart. No payment details are entered, so no orders are created.'],
  ['Will it slow down my store?', 'No. A test is a few page views every few hours, less than a single shopper. Tharam identifies itself in its browser signature so you can filter it from analytics.'],
  ['Does it work with my platform?', 'Speed, SEO, accessibility, links, script errors and visual changes are checked on any store. Shopping-journey tests, catalog guard and Safe to publish run on Shopify today, with other platforms following. See Platforms for each one.'],
  ['My store is password protected', 'Add your storefront password and Tharam unlocks the store before testing.'],
  ['What is Commerce Assurance?', 'Continuous proof that customers can find, trust and buy from you, on your own store and every marketplace you sell on. Tharam is the platform built for it.'],
];
