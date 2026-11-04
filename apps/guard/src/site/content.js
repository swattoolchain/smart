/**
 * Everything the website says about features, platforms, marketplaces and the managed service lives here.
 * Written for shop owners, not developers: plain words, no jargon, and an honest status on everything
 * (live = works today, beta = works, still being improved, soon = being built, planned = on the roadmap).
 */

export const STATUS = {
  live: null,
  beta: null,
  soon: { label: 'Early access', tone: 'soon' },
  planned: { label: 'Early access', tone: 'soon' },
  early: { label: 'Early access', tone: 'soon' },
};
/** For tables: available today, or early access. */
export const available = (st) => st === 'live' || st === 'beta';

/** The features. Each has its own page under /features. */
export const PRODUCTS = [
  {
    slug: 'monitoring', icon: 'pulse', name: 'Store checks, around the clock', pillar: 'Can customers buy?', status: 'live',
    short: 'We shop your store every few hours, like a real customer, and tell you the moment someone can’t buy.',
    title: 'Find out the moment customers can’t buy',
    lede: 'Every few hours, Tharam visits your store like a real customer, on a computer and on a phone. It searches, opens products, picks a size, adds to cart and goes to checkout. If anything stops working, it checks again to be sure, then tells you what broke and how to fix it.',
    points: [
      ['The whole shopping trip', 'Search, collections, product pages, sizes and colours, add to cart, cart and checkout. Exactly what your customers do.'],
      ['It tells you why', 'Not just “something is wrong”. For example: the Add to cart button stopped working, probably because of a recently updated app.'],
      ['No false alarms', 'Before alerting you, Tharam checks a second time. If your store’s security blocks our test, we say so instead of saying your store is broken.'],
      ['Alerts only when it matters', 'One email or Slack message when something breaks, and one when it’s working again. Never the same problem twice.'],
    ],
  },
  {
    slug: 'safe-to-publish', icon: 'publish', name: 'Safe to publish', pillar: 'Is this change safe?', status: 'live',
    short: 'Changing your store’s design? We test the new version before your customers see it.',
    title: 'Change your store without breaking it',
    lede: 'Before you publish a new design, sale banner or theme update, share its preview link with Tharam. We test the new version next to your current store, on computer, tablet and phone, and give you a clear answer: safe to publish, have a look first, or don’t publish yet.',
    points: [
      ['New and current, side by side', 'The same tests on both versions, so every difference comes from your change.'],
      ['What breaks, and what gets better', 'Anything that works today but breaks in the new version, and anything the new version fixes.'],
      ['Every screen size', 'Pictures of the new version and your current store, with the differences highlighted.'],
      ['Your staging store too', 'Save your staging theme or a separate staging store once. Check it with one click, every day, or automatically after each update from your developer.'],
      ['Stops a bad update for you', 'If your developer publishes through GitHub or another tool, Tharam can hold back an update that would break buying, and send you the report.'],
      ['Nothing changes on your store', 'The new version is only opened in our test browser. Nothing is published and no orders are placed.'],
    ],
  },
  {
    slug: 'laws-where-you-sell', icon: 'globe', name: 'Laws where you sell', pillar: 'Am I following the rules?', status: 'live',
    short: 'Tell us where you sell. We check the rules there: legal pages, cookie consent, price display and accessibility.',
    title: 'Sell abroad without worrying about the rules',
    lede: 'Every country has its own rules for online shops, and they keep changing. Tell Tharam where you sell, and every full check also looks for what the rules there ask for. In plain words, with what to fix and where to fix it in Shopify.',
    points: [
      ['Germany and Austria', 'Impressum, right of withdrawal, the new “Vertrag widerrufen” button required since June 2026, VAT and shipping next to every price, unit prices, and old links to the closed EU dispute platform.'],
      ['Cookie consent in the EU and UK', 'We visit as a first-time shopper from Germany and check that your banner appears, and that Meta, TikTok, Google and other tags wait until the shopper agrees.'],
      ['Accessibility, US and EU', 'What accessibility lawsuits in the US and the European Accessibility Act look for: buying with a keyboard, zoom, page language, the cart page, and an accessibility statement. We also tell you if you rely on an overlay widget.'],
      ['US privacy choices', 'The “Do not sell or share my personal information” link that California and other states ask for.'],
      ['Checks, not legal advice', 'Tharam shows exactly what it saw on your store, so you or your lawyer can decide. More countries are being added.'],
    ],
  },
  {
    slug: 'catalog', icon: 'catalog', name: 'Product and price checks', pillar: 'Are my products right?', status: 'live',
    short: 'Every product checked for wrong prices, unfinished descriptions and missing photos.',
    title: 'Catch product and price mistakes before customers do',
    lede: 'One wrong price can cost a lot. Tharam reads every product in your store on every full check and looks for mistakes a careful person would spot. You also see exactly what changed since last time: prices, sales, stock, descriptions and photos.',
    points: [
      ['Price mistakes', 'Products priced at zero, “sale” prices that aren’t lower, and prices that suddenly dropped by more than half.'],
      ['Unfinished descriptions', 'Dummy text like “lorem ipsum” or “TBD”, empty descriptions, and the same description copied across products.'],
      ['Photos and stock codes', 'Products without photos, and products sharing the same stock code (SKU), which confuses stock and shipping apps.'],
      ['What changed, word by word', 'A log of every price, stock, description and photo change since the last check.'],
    ],
  },
  {
    slug: 'experience', icon: 'speed', name: 'Speed, Google and mobile checks', pillar: 'Is it fast and easy to find?', status: 'live',
    short: 'A slow phone experience, a page hidden from Google, a broken link: the quiet things that cost sales.',
    title: 'Fast on phones, easy to find on Google',
    lede: 'Most customers shop on their phone and find you on Google. Tharam checks the things that quietly lose sales: slow pages, pages accidentally hidden from Google, broken links, error messages from apps, and design changes nobody approved. Works on any online store.',
    points: [
      ['Speed on phones', 'How fast your pages load on a phone, and which apps slow them down, by name.'],
      ['Show up on Google', 'Page titles and descriptions, and pages accidentally hidden from Google search.'],
      ['Easy for everyone', 'Checks that people using screen readers or bigger text can still shop (accessibility).'],
      ['No surprise design changes', 'Pictures of your pages on computer, tablet and phone, compared with the look you approved.'],
    ],
  },
  {
    slug: 'ai', icon: 'sparkle', name: 'AI that looks like a shopper', pillar: 'What would a person notice?', status: 'beta',
    short: 'AI looks at your pages and reads your product text, and spots what a shopper would notice.',
    title: 'An extra pair of eyes on every page',
    lede: 'Some problems only a person looking at the page would notice: text covering a photo, a popup hiding the Buy button, a silk saree described as cotton. Tharam’s AI looks at your pages and reads your product text the way a shopper would, and tells you what looks wrong.',
    points: [
      ['Looks at every page', 'On computer and phone: overlapping text, cut-off prices, broken photos, and anything blocking the Buy button.'],
      ['Reads your product text', 'Spelling, grammar and mix-ups in new or edited products, with a suggested correction.'],
      ['Explains changes', 'When a page looks different, AI says what changed and whether it looks deliberate or like a mistake.'],
      ['AI shoppers (early access)', 'AI shoppers with a goal, like “find a gift under ₹2,000 and check out”, that tell you where they got stuck.'],
    ],
  },
  {
    slug: 'reports', icon: 'reports', name: 'Reports and your store score', pillar: 'How did my store do?', status: 'live',
    short: 'A clear report after every check, and one number that says how often customers could buy.',
    title: 'Know how your store did, at a glance',
    lede: 'Every check gives you a simple report: what works, what broke, what got fixed, and how it compares with yesterday or last week. One number sums it up, Buyability: how often customers could actually buy from you.',
    points: [
      ['Compare with any day', 'What newly broke, what got fixed and what is still broken, compared with yesterday, last week or any earlier check.'],
      ['Buyability', 'The share of checks in which a customer could find a product, add it to the cart and reach checkout.'],
      ['Every problem, start to finish', 'When each problem started and how long it took to fix.'],
      ['Share as PDF', 'Save any report as a PDF for your team, your developer or your agency.'],
    ],
  },
];

/** Store platforms. What works where, in plain words. */
export const PLATFORMS = [
  { slug: 'shopify', name: 'Shopify', status: 'live', blurb: 'Everything Tharam does works on Shopify, with no install: shopping checks, product and price checks, Safe to publish, speed, Google and AI review.',
    caps: { experience: 'live', journey: 'live', catalog: 'live', publish: 'live', app: 'soon' },
    notes: ['Works with Shopify’s standard themes, like Dawn, and popular paid themes.', 'Store still behind a password? Add the password and we’ll test it.', 'Our checkout test stops before payment, so no orders are ever placed.'] },
  { slug: 'woocommerce', name: 'WooCommerce', status: 'beta', blurb: 'Speed, Google, mobile, broken link and design checks for your WooCommerce store, with shopping tests and a WordPress plugin in early access.',
    caps: { experience: 'live', journey: 'soon', catalog: 'soon', publish: 'live', app: 'planned' },
    notes: ['Product and price checks are possible without installing anything.', 'The plugin will also check order emails.'] },
  { slug: 'bigcommerce', name: 'BigCommerce', status: 'beta', blurb: 'Speed, Google, mobile, broken link and design checks, with shopping tests in early access.',
    caps: { experience: 'live', journey: 'planned', catalog: 'planned', publish: 'live', app: 'planned' }, notes: [] },
  { slug: 'adobe-commerce', name: 'Adobe Commerce (Magento)', status: 'beta', blurb: 'Speed, Google, mobile, broken link and design checks, with shopping tests in early access.',
    caps: { experience: 'live', journey: 'planned', catalog: 'planned', publish: 'live', app: 'planned' }, notes: [] },
  { slug: 'salesforce-commerce', name: 'Salesforce Commerce Cloud', status: 'beta', blurb: 'Speed, Google, mobile, broken link and design checks, with shopping tests for your storefront in early access.',
    caps: { experience: 'live', journey: 'soon', catalog: 'planned', publish: 'live', app: 'planned' }, notes: ['Join early access and we’ll set up shopping tests for your storefront with you.'] },
  { slug: 'wix', name: 'Wix', status: 'beta', blurb: 'Speed, Google, mobile, broken link and design checks, with shopping tests in early access.',
    caps: { experience: 'live', journey: 'planned', catalog: 'planned', publish: 'planned', app: 'planned' }, notes: [] },
  { slug: 'squarespace', name: 'Squarespace', status: 'beta', blurb: 'Speed, Google, mobile, broken link and design checks, with shopping tests in early access.',
    caps: { experience: 'live', journey: 'planned', catalog: 'planned', publish: 'planned', app: 'planned' }, notes: [] },
  { slug: 'headless', name: 'Custom-built stores', status: 'beta', blurb: 'Built your own store, or had a developer build one? Speed, Google, mobile and design checks, with shopping tests for your storefront in early access.',
    caps: { experience: 'live', journey: 'soon', catalog: 'planned', publish: 'live', app: 'planned' }, notes: ['Works with any store on a public web address, including “headless” stores built with Hydrogen or Next.js.'] },
];

export const CAPS = [
  ['experience', 'Speed, Google, mobile, broken links and page design'],
  ['journey', 'Shopping tests: search, add to cart and checkout'],
  ['catalog', 'Product and price checks'],
  ['publish', 'Test changes on a draft or staging site before publishing'],
  ['app', 'Install from your platform’s app store'],
];

/** Marketplaces: for brands that also sell there. All early access. */
export const MARKETPLACES = [
  { slug: 'amazon', name: 'Amazon', status: 'early', blurb: 'For brands selling on Amazon: know when a listing is hidden, when you lose the Buy Box, when another seller joins your listing, or when your title, photos or price change without you.',
    watch: ['A listing becomes hidden or shows as unavailable', 'You lose the Buy Box, or a new seller appears on your listing', 'Your title, photos, bullet points or price change without you', 'Stock runs out, or reviews suddenly drop'], via: 'Amazon’s official seller connection, which you approve.' },
  { slug: 'flipkart', name: 'Flipkart', status: 'early', blurb: 'For brands selling on Flipkart: know when a listing goes inactive, when prices or stock don’t match your own store, or when listing details change.',
    watch: ['A listing goes inactive or out of stock', 'A price is different from your own store', 'Listing details change', 'Orders suddenly stop'], via: 'Flipkart’s official seller connection, which you approve.' },
  { slug: 'meesho', name: 'Meesho', status: 'early', blurb: 'For brands selling on Meesho and their own store: keep prices, stock and product details in line everywhere.',
    watch: ['Prices or stock out of line with your store', 'Listings that disappear', 'Product details that drift'], via: 'Set up with you during early access.' },
  { slug: 'myntra', name: 'Myntra', status: 'early', blurb: 'For fashion brands selling on Myntra and their own store: keep prices, stock and product details in line everywhere.',
    watch: ['Prices or stock out of line with your store', 'Listings that disappear', 'Product details that drift'], via: 'Set up with you during early access.' },
];

/** The managed service: we look after the store for you. */
export const MANAGED = {
  points: [
    ['eye', 'We watch your store every day', 'We set up all the checks for you and read every alert ourselves, so you don’t have to.'],
    ['tool', 'We fix what breaks', 'With your permission, we fix broken buttons, app clashes and broken links, or give your developer exact instructions.'],
    ['publish', 'We check every change first', 'New design, sale banner or app? We test it before your customers see it.'],
    ['catalog', 'We keep products and prices right', 'Wrong prices, missing photos and unfinished descriptions, spotted and corrected.'],
    ['calendar', 'Ready for big sale days', 'Before Diwali, Black Friday and your big sales, a full readiness check, and a closer watch during the sale.'],
    ['reports', 'A monthly report and call', 'What happened, what we fixed, and what would help you sell more.'],
  ],
  steps: [
    ['Free store review', 'We check your store and walk you through what we find, on a 20-minute call.'],
    ['We take over the watching', 'You give us access through Shopify’s staff and collaborator settings, which you can remove at any time.'],
    ['You get on with selling', 'We watch, fix and report. You hear from us when something needs your decision.'],
  ],
};

/** Who Tharam is for. */
export const AUDIENCES = [
  ['store', 'Store owners', 'Know your store works without checking it yourself every day.'],
  ['agency', 'Agencies and freelancers', 'Watch every client store in one place and send them proof it works.'],
  ['code', 'App and theme developers', 'Make sure your app or theme works on real stores before customers complain.'],
  ['megaphone', 'Marketing agencies', 'Make sure the store works before you spend your client’s ad budget.'],
];

/** Plain promises shown under the homepage hero. */
export const PROMISES = [
  ['shield', 'No fake orders, ever'],
  ['bolt', 'Nothing to install'],
  ['lock', 'Your data stays private'],
  ['check', 'Free while in beta'],
];

export const FAQ = [
  ['Do I need to be technical?', 'No. You enter your store address and choose how often to check. Tharam tells you in plain words what broke and how to fix it, or we fix it for you with the managed service.'],
  ['Will the tests place fake orders?', 'No. Our test adds one item to a new cart, opens checkout to make sure it loads, then stops and empties the cart. It never enters payment details, so no order is ever created.'],
  ['Will it slow down my store?', 'No. A check is a few page visits every few hours, less than a single customer. It also tells your analytics it’s a test, so it doesn’t mess up your numbers.'],
  ['Does it work with my store?', 'Yes. Tharam works with Shopify, WooCommerce, BigCommerce, Magento, Wix, Squarespace and custom-built stores. Shopify stores get every check with no install; other platforms are joining early access for shopping tests.'],
  ['My store is still behind a password', 'No problem. Add your store password and we’ll unlock the store before each check.'],
  ['Can you look after my store for me?', 'Yes. With the managed service, our team watches your store, fixes what breaks and checks every change for you. Start with a free store review.'],
];
