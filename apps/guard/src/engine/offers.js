/**
 * Automatic offers: bundles, buy X get Y, spend-and-save and free gifts (Pricing 4).
 * The owner lists the offers they run in Test suite → Price rules → Offers. Each full check builds the cart that
 * should get the offer and, where the offer has a threshold, the cart just below it, then reads what Shopify's
 * cart.js and the checkout charge. It only looks at the cart and checkout, so it works the same whether the offer
 * comes from a Shopify automatic discount, a Shopify Function or a discount app. Nothing is bought; the cart is
 * emptied afterwards.
 */
import { check, shortErr } from './checks.js';
import { money, toMinor, checkoutSubtotal } from './pricing.js';

export const MAX_OFFERS = 5;
export const offerId = (i) => `fn.offer.${i + 1}`;
export const OFFER_TYPES = ['spend', 'bxgy', 'bundle', 'gift'];
const MAX_QTY = 99;

const handleOf = (raw) => {
  let s = String(raw || '').trim();
  const m = /\/products\/([^/?#]+)/.exec(s);
  if (m) s = decodeURIComponent(m[1]);
  return s.toLowerCase();
};
const HANDLE = /^[a-z0-9][a-z0-9_-]{0,199}$/i;
const num = (s) => Number(String(s).replace(/,/g, ''));
const AMOUNT = String.raw`(?:₹|rs\.?|\$|€|£)?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d{1,8}(?:\.\d{1,2})?)`;

/**
 * What the owner wrote for an offer -> its numbers. Throws a plain message.
 *  spend:  "5000 10%", "spend 5,000 get 10% off", "5000 500 off"  -> { min, percent } | { min, amount }
 *  bxgy:   "buy 2 get 1", "2+1", "buy 2 get 1 50%"                 -> { buy, get, percent } (percent 100 = free)
 *  bundle: "2999"                                                  -> { price } (the price of the whole bundle)
 *  gift:   "3000", "spend 3000"                                    -> { min }
 */
export function parseOffer(type, text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (type === 'spend') {
    const m = new RegExp(String.raw`^(?:spend|over|above|from)?\s*${AMOUNT}\s*(?:\+|or more)?\s*[:=,→>-]*\s*(?:get|save|and get)?\s*${AMOUNT}\s*(%|percent)?\s*(?:off)?$`, 'i').exec(s);
    if (!m) throw new Error('Write a spend offer like “5000 10%” (10% off from 5,000) or “5000 500 off” (500 off from 5,000).');
    const min = num(m[1]);
    const val = num(m[2]);
    if (!(min > 0 && min <= 10000000)) throw new Error('The amount to spend must be more than 0.');
    if (m[3]) {
      if (!(val > 0 && val < 100)) throw new Error('A percentage off must be between 0 and 100.');
      return { min, percent: val };
    }
    if (!(val > 0 && val < min)) throw new Error('The amount off must be more than 0 and less than the amount to spend.');
    return { min, amount: val };
  }
  if (type === 'bxgy') {
    const m = /^(?:buy\s*)?(\d{1,2})\s*(?:\+|,|and|get)\s*(?:get\s*)?(\d{1,2})\s*(?:free)?\s*(?:(?:at\s*)?(\d{1,2}(?:\.\d{1,2})?|100)\s*(?:%|percent)\s*(?:off)?)?\s*(?:free)?$/i.exec(s);
    if (!m) throw new Error('Write a buy-X-get-Y offer like “buy 2 get 1” (the third is free) or “buy 2 get 1 50%” (half price).');
    const buy = Number(m[1]);
    const get = Number(m[2]);
    const percent = m[3] == null ? 100 : Number(m[3]);
    if (buy < 1 || get < 1 || buy + get > 20) throw new Error('Buy and get must be at least 1, and 20 items or fewer together.');
    if (!(percent > 0 && percent <= 100)) throw new Error('The discount on the free items must be between 0 and 100%.');
    return { buy, get, percent };
  }
  if (type === 'bundle') {
    const m = new RegExp(String.raw`^(?:for|at)?\s*${AMOUNT}$`, 'i').exec(s);
    if (!m) throw new Error('Enter the price of the whole bundle, like 2999.');
    const price = num(m[1]);
    if (!(price > 0 && price <= 10000000)) throw new Error('The bundle price must be more than 0.');
    return { price };
  }
  if (type === 'gift') {
    const m = new RegExp(String.raw`^(?:spend|over|above|from)?\s*${AMOUNT}\s*(?:\+|or more)?$`, 'i').exec(s);
    if (!m) throw new Error('Enter the amount to spend for the free gift, like 3000.');
    const min = num(m[1]);
    if (!(min > 0 && min <= 10000000)) throw new Error('The amount to spend must be more than 0.');
    return { min };
  }
  throw new Error('Choose what kind of offer this is.');
}

/** Shows an offer the way the owner writes it. */
export function offerText(o) {
  if (o.type === 'spend') return `${o.min} ${o.percent != null ? `${o.percent}%` : `${o.amount} off`}`;
  if (o.type === 'bxgy') return `buy ${o.buy} get ${o.get}${o.percent !== 100 ? ` ${o.percent}%` : ''}`;
  if (o.type === 'bundle') return String(o.price);
  if (o.type === 'gift') return String(o.min);
  return '';
}

/**
 * Validates Test suite → Price rules → Offers. Each offer: { type, products, variant, offer } where products is
 * a list of product links or handles (or text with commas):
 *  spend: the product used to fill the cart; bxgy: the product to buy, and optionally a different one to get;
 *  bundle: 2 to 4 products; gift: the product used to fill the cart, then the gift.
 */
export function cleanOffers(input) {
  if (!Array.isArray(input)) throw new Error('Offers must be a list.');
  const out = [];
  for (const raw of input) {
    if (!raw) continue;
    const list = (Array.isArray(raw.products) ? raw.products : String(raw.products ?? '').split(/[,\s]+/)).map(handleOf).filter(Boolean);
    const hasNumbers = raw.offer != null && String(raw.offer).trim() !== '';
    const saved = ['min', 'buy', 'price'].some((k) => raw[k] != null);
    if (!list.length && !hasNumbers && !saved) continue;
    const type = String(raw.type || '').toLowerCase();
    if (!OFFER_TYPES.includes(type)) throw new Error('Choose what kind of offer this is: spend and save, buy X get Y, bundle or free gift.');
    for (const h of list) if (!HANDLE.test(h)) throw new Error(`“${h}” is not a product. Use the product's link or its handle, like cotton-kurta.`);
    const need = { spend: [1, 1, 'one product to fill the cart with'], bxgy: [1, 2, 'the product to buy (and, if different, the product they get)'], bundle: [2, 4, '2 to 4 products'], gift: [2, 2, 'the product to fill the cart with, then the gift'] }[type];
    if (list.length < need[0] || list.length > need[1]) throw new Error(`For this offer, enter ${need[2]}.`);
    const numbers = hasNumbers ? parseOffer(type, raw.offer) : parseOffer(type, offerText({ type, ...raw }));
    const variant = raw.variant ? String(raw.variant).trim().slice(0, 100) : null;
    out.push({ type, products: list, variant, ...numbers });
  }
  if (out.length > MAX_OFFERS) throw new Error(`Up to ${MAX_OFFERS} offers.`);
  return out;
}

/** How the offer reads in a report title. */
export function offerTitle(o, names, cur) {
  const m = (v) => money(Math.round(v * 100), cur);
  if (o.type === 'spend') return `Offer: spend ${m(o.min)}, get ${o.percent != null ? `${o.percent}%` : m(o.amount)} off`;
  if (o.type === 'bxgy') return `Offer: buy ${o.buy} ${names[0]}, get ${o.get}${names[1] ? ` ${names[1]}` : ''} ${o.percent === 100 ? 'free' : `${o.percent}% off`}`;
  if (o.type === 'bundle') return `Offer: ${names.join(' + ')} for ${m(o.price)}`;
  return `Offer: free ${names[1]} from ${m(o.min)}`;
}

/** The discount a cart gives in total (line and order discounts), in minor units, from Shopify's cart.js. */
export function cartDiscount(cart) {
  if (!cart) return 0;
  const orig = Number(cart.original_total_price);
  const total = Number(cart.total_price);
  const byTotals = Number.isFinite(orig) && Number.isFinite(total) ? orig - total : 0;
  const lineFull = (cart.items || []).reduce((s, i) => s + Number(i.original_line_price ?? i.line_price ?? 0), 0);
  const lineFinal = (cart.items || []).reduce((s, i) => s + Number(i.final_line_price ?? i.line_price ?? 0), 0);
  const byLines = lineFull - lineFinal + (cart.cart_level_discount_applications || []).reduce((s, d) => s + Number(d.total_allocated_amount || 0), 0);
  return Math.max(byTotals, byLines, Number(cart.total_discount) || 0, 0);
}

/**
 * The carts worth trying for an offer and the discount each should give (minor units).
 * units: { [handle]: unit price in minor units }. Returns { carts: [{ role, lines: [{ handle, qty }], expectOff | expectGiftFree }], problem }.
 * role 'gets' must get the offer; role 'below' must not.
 */
export function planCarts(o, units) {
  const u = (h) => units[h];
  if (o.type === 'spend' || o.type === 'gift') {
    const fill = o.products[0];
    const min = Math.round(o.min * 100);
    const q = Math.ceil(min / u(fill));
    if (q > MAX_QTY) return { carts: [], problem: `It takes more than ${MAX_QTY} of this product to reach the amount, so the offer could not be checked. Choose a pricier product to fill the cart with.` };
    const below = q - 1;
    const extra = o.type === 'gift' ? [{ handle: o.products[1], qty: 1 }] : [];
    const off = (qty) => (o.type === 'gift' ? 0 : o.percent != null ? Math.round((qty * u(fill) * o.percent) / 100) : Math.round(o.amount * 100));
    const carts = [{ role: 'gets', lines: [{ handle: fill, qty: q }, ...extra], expectOff: off(q), subtotal: q * u(fill) }];
    if (below >= 1) carts.push({ role: 'below', lines: [{ handle: fill, qty: below }, ...extra], expectOff: 0, subtotal: below * u(fill) });
    return { carts };
  }
  if (o.type === 'bxgy') {
    const [buy, getP = null] = o.products;
    const freeEach = Math.round((u(getP || buy) * o.percent) / 100);
    const expectOff = o.get * freeEach;
    if (!getP) {
      return { carts: [
        { role: 'gets', lines: [{ handle: buy, qty: o.buy + o.get }], expectOff },
        { role: 'below', lines: [{ handle: buy, qty: o.buy + o.get - 1 }], expectOff: 0 },
      ] };
    }
    const carts = [{ role: 'gets', lines: [{ handle: buy, qty: o.buy }, { handle: getP, qty: o.get }], expectOff }];
    if (o.buy - 1 >= 1) carts.push({ role: 'below', lines: [{ handle: buy, qty: o.buy - 1 }, { handle: getP, qty: o.get }], expectOff: 0 });
    return { carts };
  }
  // bundle: one of each; the whole cart should come to the bundle price.
  const full = o.products.reduce((s, h) => s + u(h), 0);
  const price = Math.round(o.price * 100);
  if (price >= full) return { carts: [], problem: `The bundle price (${price / 100}) is not less than the products cost on their own, so there is no discount to check.` };
  return { carts: [{ role: 'gets', lines: o.products.map((h) => ({ handle: h, qty: 1 })), expectOff: full - price }] };
}

/**
 * Compares a tried cart with what it should get. tried: { role, expectOff, gotOff, giftCharged?, giftUnit? }.
 * state: 'ok' | 'missing' (no or too little discount) | 'over' (more discount than meant) | 'leak' (given below the threshold) | 'refused'
 */
export function judgeCart(type, tried, lines = 1) {
  if (tried.refused) return 'refused';
  const tol = Math.max(1, lines);
  if (type === 'gift') {
    const free = tried.giftCharged != null && tried.giftCharged <= 1;
    if (tried.role === 'gets') return free ? 'ok' : 'missing';
    return free ? 'leak' : 'ok';
  }
  if (tried.role === 'below') return tried.gotOff > tol ? 'leak' : 'ok';
  if (tried.gotOff < tried.expectOff - tol) return 'missing';
  if (tried.gotOff > tried.expectOff + tol) return 'over';
  return 'ok';
}

async function api(page, path, body) {
  return page.evaluate(async ([path, body]) => {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) } : { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    let j = null;
    try { j = await r.json(); } catch {}
    return { status: r.status, json: j };
  }, [path, body]).catch((e) => ({ status: 0, error: String(e) }));
}

const NOT_FOUND = Symbol('not found');

/** The owner's automatic offers, each tried in fresh carts. Runs on full checks. */
export async function runOffers({ page, rec, origin, offers }) {
  if (!offers?.length) return;
  if (!page.url().startsWith(origin)) await page.goto(origin + '/cart', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  for (const [i, o] of offers.slice(0, MAX_OFFERS).entries()) {
    const id = offerId(i);
    let title = `Offer: ${o.products.join(' + ')}`;
    rec.step(`Check offer ${i + 1}: ${o.type} on ${o.products.join(', ')}`);
    try {
      // Each product: its variant (the one named for the first product, else the first in stock) and price.
      const found = {};
      for (const [k, h] of o.products.entries()) {
        if (found[h]) continue;
        const p = await api(page, `/products/${encodeURIComponent(h)}.js`);
        if (p.status !== 200 || !p.json?.variants) { found[h] = NOT_FOUND; continue; }
        const want = k === 0 && o.variant ? String(o.variant).toLowerCase() : null;
        const v = p.json.variants.find((x) => want && (String(x.id) === want || String(x.title).toLowerCase() === want)) || (!want && p.json.variants.find((x) => x.available));
        found[h] = { title: p.json.title, variant: v || null, unit: v ? toMinor(v.price, true) : null };
      }
      const missing = o.products.filter((h) => found[h] === NOT_FOUND);
      if (missing.length) {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: `We couldn't find ${missing.map((h) => `“${h}”`).join(' and ')} on your store, so this offer wasn't checked.`, fix: 'Open Test suite → Price rules → Offers and pick the product again. It may have been renamed, unpublished or deleted.' }));
        continue;
      }
      const names = o.products.map((h) => found[h].title);
      const soldOut = o.products.filter((h) => !found[h].variant);
      if (soldOut.length) {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: o.variant && !found[o.products[0]].variant ? `“${names[0]}” has no variant called “${o.variant}”, so this offer wasn't checked.` : `${soldOut.map((h) => `“${found[h].title}”`).join(' and ')} ${soldOut.length === 1 ? 'is' : 'are'} sold out, so this offer wasn't checked.` }));
        continue;
      }
      const v0 = found[o.products[0]].variant;
      const vname = v0.title && v0.title !== 'Default Title' ? ` (${v0.title})` : '';
      const units = Object.fromEntries(o.products.map((h) => [h, found[h].unit]));
      const plan = planCarts(o, units);
      const cart0 = (await api(page, '/cart.js')).json;
      let cur = cart0?.currency || null;
      title = offerTitle(o, names.map((n, k) => (k === 0 ? n + vname : n)), cur);
      if (plan.problem) {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: plan.problem }));
        continue;
      }
      const tried = [];
      let checkout = null;
      const giftV = o.type === 'gift' ? found[o.products[1]].variant : null;
      for (const c of plan.carts) {
        await api(page, '/cart/clear.js', {});
        let refused = false;
        for (const l of c.lines) {
          // A gift app may add the gift itself once the cart qualifies: don't add a second one.
          if (giftV && l.handle === o.products[1]) {
            const now = (await api(page, '/cart.js')).json;
            if ((now?.items || []).some((x) => String(x.variant_id ?? x.id) === String(giftV.id))) continue;
          }
          const added = await api(page, '/cart/add.js', { items: [{ id: found[l.handle].variant.id, quantity: l.qty }] });
          if (added.status >= 400) { refused = true; break; }
        }
        const cart = refused ? null : (await api(page, '/cart.js')).json;
        cur = cart?.currency || cur;
        const giftLine = giftV && cart ? (cart.items || []).find((x) => String(x.variant_id ?? x.id) === String(giftV.id)) : null;
        const row = {
          role: c.role,
          lines: c.lines,
          expectOff: c.expectOff,
          subtotal: c.subtotal ?? null,
          refused,
          gotOff: cart ? cartDiscount(cart) : null,
          full: cart ? Number(cart.original_total_price ?? cart.items_subtotal_price) : null,
          total: cart ? Number(cart.total_price) : null,
          giftCharged: giftLine ? Number(giftLine.final_line_price ?? giftLine.line_price) : giftV ? null : undefined,
          giftUnit: giftV ? found[o.products[1]].unit : undefined,
        };
        row.state = judgeCart(o.type, row, c.lines.length);
        tried.push(row);
        // The checkout for the cart that gets the offer must not ask for more than the cart did.
        if (c.role === 'gets' && cart && !refused) {
          await page.goto(origin + '/checkout', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(1200);
          if (/\/checkouts?\//.test(page.url())) {
            const sub = await checkoutSubtotal(page);
            const cartSub = Number(cart.items_subtotal_price ?? cart.total_price);
            if (sub?.minor != null && Number.isFinite(cartSub)) checkout = { minor: sub.minor, cart: cartSub, higher: sub.minor > cartSub + 1 };
          }
          await page.goto(origin + '/cart', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        }
      }
      const m = (x) => money(x, cur);
      const describe = (r) => r.lines.map((l) => `${l.qty} × ${found[l.handle].title}`).join(' + ');
      const offerTable = {
        currency: cur,
        rows: tried.map((r) => ({
          role: r.role,
          cart: describe(r),
          full: r.full == null ? null : m(r.full),
          expect: o.type === 'gift' ? (r.role === 'gets' ? 'Gift free' : 'Gift at full price') : r.role === 'below' ? 'No discount' : `${m(r.expectOff)} off`,
          got: r.refused ? null : o.type === 'gift' ? (r.giftCharged == null ? 'No gift in the cart' : r.giftCharged <= 1 ? 'Gift free' : `Gift costs ${m(r.giftCharged)}`) : r.gotOff ? `${m(r.gotOff)} off` : 'No discount',
          total: r.total == null ? null : m(r.total),
          state: r.state,
        })),
        checkout: checkout ? { money: m(checkout.minor), cart: m(checkout.cart), higher: checkout.higher } : null,
      };
      const evidence = { offerTable };
      const gets = tried.find((r) => r.role === 'gets');
      const below = tried.find((r) => r.role === 'below');
      const threshold = o.type === 'spend' || o.type === 'gift' ? m(Math.round(o.min * 100)) : null;
      const fixApp = 'Check the automatic discount in Shopify admin (Discounts) or the offer app: is it active, are the dates right, does it include these products and variants, and can it combine with your other discounts? If the offer changed on purpose, update it in Test suite → Price rules → Offers.';
      if (gets.state === 'refused') {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: `The cart did not accept ${describe(gets)}, so the offer could not be checked. A product may be low on stock or limited per order.`, evidence }));
      } else if (gets.state === 'missing' || checkout?.higher) {
        const parts = [];
        if (gets.state === 'missing') {
          if (o.type === 'gift') parts.push(gets.giftCharged == null ? `a cart of ${m(gets.subtotal)} did not keep the free ${names[1]}` : `a cart of ${m(gets.subtotal)} still charges ${m(gets.giftCharged)} for the ${names[1]}`);
          else parts.push(`${describe(gets)} gets ${gets.gotOff ? `only ${m(gets.gotOff)} off` : 'no discount'}, but the offer should take ${m(gets.expectOff)} off`);
        }
        if (checkout?.higher) parts.push(`at checkout the subtotal is ${m(checkout.minor)} while the cart showed ${m(checkout.cart)}`);
        rec.add(check(id, 'functional', title, 'fail', { severity: 'critical', detail: `Customers who qualify for this offer don't get it: ${parts.join('; ')}.`, evidence, fix: fixApp }));
      } else if (gets.state === 'over') {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: `${describe(gets)} gets ${m(gets.gotOff)} off, more than the ${m(gets.expectOff)} this offer should give. Another discount may stack on top, or the offer is bigger than you meant.`, evidence, fix: 'Check which discounts apply to this cart and whether they are allowed to combine. If the bigger discount is intended, update the offer.' }));
      } else if (below?.state === 'leak') {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: o.type === 'gift' ? `The ${names[1]} is free in a cart of only ${m(below.subtotal)}, below the ${threshold} the gift needs.` : `${describe(below)} already gets ${m(below.gotOff)} off, though it is below what the offer needs${threshold ? ` (${threshold})` : ''}. You may be giving the discount away too early.`, evidence, fix: 'Check the minimum amount or quantity on the automatic discount or offer app. If the lower threshold is intended, update the offer.' }));
      } else {
        const what = o.type === 'gift' ? `the ${names[1]} is free in a cart of ${m(gets.subtotal)}` : `${describe(gets)} gets ${m(gets.gotOff)} off`;
        const notBelow = below ? (below.state === 'refused' ? ' The cart just below the offer could not be built, so we skipped it.' : ` Just below it (${describe(below)}), there is ${o.type === 'gift' ? 'no free gift' : 'no discount'}, as it should be.`) : '';
        rec.add(check(id, 'functional', title, 'pass', { severity: 'critical', detail: `The offer works: ${what}.${notBelow}${checkout ? ` Checkout shows the same ${m(checkout.minor)} subtotal as the cart.` : ''}`, evidence }));
      }
    } catch (e) {
      rec.add(check(id, 'functional', title, 'skip', { severity: 'major', detail: shortErr(e) }));
    }
  }
  await api(page, '/cart/clear.js', {});
}
