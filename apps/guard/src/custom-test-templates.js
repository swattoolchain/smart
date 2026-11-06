/**
 * Your tests, part 4: ready-made templates for features many stores have. Each template is a test in the same
 * file format as an uploaded test, with [[blanks]] the owner fills in (a pincode, the text on a button, where a
 * result appears). Every blank has a sensible default that works on common Shopify themes and apps, so a
 * template can be added in one click and tuned later in the editor.
 *
 * Nothing here is sent anywhere or bought: templates that would submit something real (a newsletter sign-up)
 * only look at the form unless the owner ticks the box to really submit a test address.
 */
import { validate } from './engine/custom.js';

const text = (key, label, def, hint = '') => ({ key, label, default: def, hint, kind: 'text' });
const yes = (key, label, hint = '') => ({ key, label, default: false, hint, kind: 'flag' });

export const TEMPLATES = [
  {
    key: 'pincode', title: 'Delivery checker (pincode)', area: 'Delivery',
    why: 'Shoppers type their pincode on the product page to see if you deliver. If the checker breaks, they can’t tell, and many leave. Important for stores in India.',
    fill: [text('pincode', 'A pincode you deliver to', '560001'), text('field', 'The pincode box', '#pincode', 'Its CSS id, or text=… / role=…'), text('button', 'The button to press', 'text=Check'), text('result', 'Where the answer appears', '.delivery-result'), text('ok', 'Words that mean yes', 'Delivery available')],
    test: { name: 'Delivery checker works', severity: 'major', device: 'mobile', fix: 'Check your delivery or pincode app: is it on, and does its pincode list include this one?',
      steps: [{ open: '{product}' }, { fill: '[[field]]', value: '[[pincode]]' }, { click: '[[button]]' }, { expect_text: '[[result]]', contains: '[[ok]]' }] },
  },
  {
    key: 'cod', title: 'Cash on delivery is offered', area: 'Delivery',
    why: 'Many shoppers only buy when they can pay on delivery. This checks the product page still says cash on delivery is available.',
    fill: [text('words', 'The words on your product page', 'Cash on delivery')],
    test: { name: 'Cash on delivery is offered', severity: 'major', device: 'mobile', fix: 'Check the app or theme setting that shows the cash-on-delivery message, and that COD is still on in your payment settings.',
      steps: [{ open: '{product}' }, { expect_visible: 'text=[[words]]' }] },
  },
  {
    key: 'size-guide', title: 'Size guide opens', area: 'Product page',
    why: 'Shoppers who can’t see the size guide buy the wrong size, or don’t buy. This opens it on a phone.',
    fill: [text('link', 'The size guide link or button', 'text=Size guide'), text('popup', 'The size guide when it’s open', '.size-guide')],
    test: { name: 'Size guide opens', severity: 'minor', device: 'mobile', fix: 'Check the size guide app or the theme block on the product page.',
      steps: [{ open: '{product}' }, { click: '[[link]]' }, { expect_visible: '[[popup]]' }] },
  },
  {
    key: 'store-locator', title: 'Store locator shows your stores', area: 'Pages',
    why: 'If you have shops people visit, the store locator must list them. This opens the page and checks at least one store is shown.',
    fill: [text('page', 'The store locator page', '/pages/store-locator'), text('store', 'One store in the list', '.store-item')],
    test: { name: 'Store locator shows stores', severity: 'minor', device: 'desktop', fix: 'Check the store locator app or page: is it published, and does it still load its list?',
      steps: [{ open: '[[page]]' }, { wait_for: '[[store]]', timeout: 15 }, { expect_count: '[[store]]', min: 1 }] },
  },
  {
    key: 'gift-card', title: 'Gift cards can be bought', area: 'Cart',
    why: 'Gift cards sell most before festivals. This adds your gift card to the cart (nothing is bought).',
    fill: [text('page', 'Your gift card’s page', '/products/gift-card')],
    test: { name: 'Gift cards can be added to the cart', severity: 'major', device: 'desktop', fix: 'Check the gift card product is published to your online store and has a price.',
      steps: [{ open: '[[page]]' }, { add_to_cart: true }, { expect_cart_items: { min: 1 } }] },
  },
  {
    key: 'subscription', title: 'Subscribe-and-save option works', area: 'Cart',
    why: 'If you sell subscriptions, the subscribe option must show and reach the cart. This picks it and adds the product.',
    fill: [text('option', 'The subscribe option', 'text=Subscribe'), text('price', 'Where the subscription price shows', '.price')],
    test: { name: 'Subscribe-and-save option works', severity: 'major', device: 'desktop', fix: 'Check your subscription app: is the product in a selling plan, and does the widget still show on the product page?',
      steps: [{ open: '{product}' }, { click: '[[option]]' }, { expect_visible: '[[price]]' }, { add_to_cart: true }, { expect_cart_items: { min: 1 } }] },
  },
  {
    key: 'reviews', title: 'Product reviews show', area: 'Product page',
    why: 'Reviews are often what makes someone buy. Review apps sometimes stop loading after a theme change. This checks they appear.',
    fill: [text('review', 'One review on the page', '.review')],
    test: { name: 'Product reviews show', severity: 'minor', device: 'desktop', fix: 'Check your reviews app is on and its block is still in the product page template.',
      steps: [{ open: '{product}' }, { wait_for: '[[review]]', timeout: 15 }, { expect_count: '[[review]]', min: 1 }] },
  },
  {
    key: 'wishlist', title: 'Wishlist button works', area: 'Product page',
    why: 'Shoppers save things to buy later. This presses the wishlist button and checks it confirms.',
    fill: [text('button', 'The wishlist button', 'text=Add to wishlist'), text('done', 'What shows after pressing it', 'text=Added to wishlist')],
    test: { name: 'Wishlist button works', severity: 'minor', device: 'desktop', fix: 'Check your wishlist app is on and its button is still on the product page.',
      steps: [{ open: '{product}' }, { click: '[[button]]' }, { expect_visible: '[[done]]' }] },
  },
  {
    key: 'newsletter', title: 'Newsletter sign-up shows', area: 'Pages',
    why: 'Your sign-up form grows your list for the next sale. By default this only checks the form is there; tick the box to really sign up a test address and check the thank-you message.',
    fill: [text('email', 'The email box', 'input[type=email][name="contact[email]"]'), yes('submit', 'Really sign up a test address', 'Adds an address like tharam-test@example.com to your list each time it runs.'), text('address', 'Test address to sign up', 'tharam-test@example.com'), text('button', 'The sign-up button', 'text=Subscribe'), text('thanks', 'The thank-you message', 'text=Thanks for subscribing')],
    test: { name: 'Newsletter sign-up shows', severity: 'minor', device: 'desktop', fix: 'Check the newsletter block in your theme footer or home page.',
      steps: [{ open: '/' }, { expect_visible: '[[email]]' }],
      submitSteps: [{ open: '/' }, { fill: '[[email]]', value: '[[address]]' }, { click: '[[button]]' }, { expect_visible: '[[thanks]]' }] },
  },
  {
    key: 'chat', title: 'WhatsApp or chat button shows', area: 'Pages',
    why: 'Many shoppers ask a question before buying. This checks your WhatsApp or chat button is on the page (we don’t send a message).',
    fill: [text('button', 'The WhatsApp or chat button', 'a[href*="wa.me"]', 'For WhatsApp links this default works; for a chat app use its button.')],
    test: { name: 'WhatsApp or chat button shows', severity: 'minor', device: 'mobile', fix: 'Check your WhatsApp or chat app is on and allowed on this page.',
      steps: [{ open: '{product}' }, { wait_for: '[[button]]', timeout: 15 }, { expect_visible: '[[button]]' }] },
  },
  {
    key: 'switcher', title: 'Language or currency switcher works', area: 'Pages',
    why: 'Shoppers abroad need to switch to their language or currency. This opens the switcher and checks the choices show.',
    fill: [text('open', 'The switcher button', 'text=Country/region'), text('list', 'The list of choices', '.disclosure__list')],
    test: { name: 'Language or currency switcher works', severity: 'minor', device: 'desktop', fix: 'Check the country or language selector is still turned on in your theme header or footer.',
      steps: [{ open: '/' }, { click: '[[open]]' }, { expect_visible: '[[list]]' }] },
  },
];


/** The owner's values for a template: defaults for anything left empty. Throws a plain message on bad input. */
export function templateValues(tpl, input = {}) {
  const out = {};
  for (const f of tpl.fill) {
    const v = input?.[f.key];
    if (f.kind === 'flag') { out[f.key] = v === true || v === 'true' || v === 'on'; continue; }
    const s = v == null ? '' : String(v).trim();
    if (s.length > 200) throw new Error(`“${f.label}” is too long (200 characters at most).`);
    if (/[\n\r]/.test(s)) throw new Error(`“${f.label}” must be on one line.`);
    if (/\[\[|\]\]/.test(s)) throw new Error(`“${f.label}” can’t contain [[ or ]].`);
    out[f.key] = s || f.default;
  }
  return out;
}

function fillIn(v, values) {
  if (typeof v === 'string') return v.replace(/\[\[(\w+)\]\]/g, (_, k) => (values[k] ?? ''));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillIn(x, values)]));
  return v;
}

/** One template as a test in the file format, with the owner's values filled in. */
export function testFromTemplate(key, input = {}) {
  const tpl = TEMPLATES.find((t) => t.key === key);
  if (!tpl) throw Object.assign(new Error('There is no template with that name.'), { status: 404 });
  const values = templateValues(tpl, input);
  const steps = values.submit && tpl.test.submitSteps ? tpl.test.submitSteps : tpl.test.steps;
  const { submitSteps, ...rest } = tpl.test;
  return { ...rest, runs: 'full', steps: steps.map((s) => fillIn(s, values)) };
}

/** The gallery for the app: what each template does, its blanks and its steps (with the defaults filled in). */
export function templateList() {
  return TEMPLATES.map((t) => ({ key: t.key, title: t.title, area: t.area, why: t.why, fill: t.fill.map(({ key, label, default: def, hint, kind }) => ({ key, label, default: def, hint, kind })), test: testFromTemplate(t.key) }));
}

/** Every template, filled with its defaults, must pass the file rules (used by the tests and at startup). */
export function checkTemplates(limits = { tests: 1 }) {
  const out = [];
  for (const t of TEMPLATES) {
    for (const submit of t.fill.some((f) => f.kind === 'flag') ? [false, true] : [false]) {
      const { problems } = validate({ tests: [testFromTemplate(t.key, { submit })] }, limits);
      if (problems.length) out.push(`${t.key}${submit ? ' (submit)' : ''}: ${problems.join(' ')}`);
    }
  }
  return out;
}

/** A name not used by the store's tests yet: "Size guide opens", "Size guide opens (2)"… */
export function freeName(name, tests) {
  const used = new Set(tests.map((t) => String(t.name).toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; n < 100; n++) { const x = `${name} (${n})`; if (!used.has(x.toLowerCase())) return x; }
  return `${name} (${Date.now()})`;
}

