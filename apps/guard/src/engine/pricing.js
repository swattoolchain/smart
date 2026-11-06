/**
 * Prices stay the same from product page to checkout.
 * Black-box only: we read the price a shopper sees on the product page, what Shopify's cart charges,
 * and the subtotal the checkout shows before payment, then compare them. No admin access is needed.
 * Price rules: the owner tells us what a product should cost (for example 3 × ₹1,299), and we check the cart.
 */
import { check, shortErr } from './checks.js';

export const MAX_PRICE_RULES = 10;

/** "₹1,499.00", "1.499,00 €", "Rs. 1,499", "$14.99" -> [{ minor, exact }] (minor units; exact = shown with decimals). */
export function amountsIn(text) {
  const out = [];
  // Thousands groups of 3 (1,499,000) or Indian lakh groups (1,49,999), then optional decimals.
  const re = /\d{1,3}(?:[.,\s\u00a0\u202f']\d{2,3})*[.,\s\u00a0\u202f']\d{3}(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g;
  for (const m of String(text || '').matchAll(re)) {
    const s = m[0];
    const dec = /[.,](\d{1,2})$/.exec(s);
    // A trailing separator with 1-2 digits is the decimal point; any other separator groups thousands.
    if (dec) {
      const whole = s.slice(0, dec.index).replace(/[^\d]/g, '') || '0';
      out.push({ minor: Number(whole) * 100 + Number(dec[1].padEnd(2, '0')), exact: true });
    } else {
      out.push({ minor: Number(s.replace(/[^\d]/g, '')) * 100, exact: false });
    }
  }
  return out.filter((a) => Number.isFinite(a.minor));
}

/** Shopify JSON prices: "1499.00" (products.json) or 149900 (product .js and cart.js). */
export const toMinor = (v, cents = false) => (v == null || v === '' ? null : cents ? Math.round(Number(v)) : Math.round(Number(v) * 100));

export function money(minor, cur) {
  if (minor == null) return '–';
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur || 'USD', maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);
  } catch {
    return (minor / 100).toFixed(2);
  }
}

/**
 * The price a shopper sees on the product page. Looks inside the product section (around the add-to-cart form)
 * first; when the price there matches the product's own price we use it. `trusted` is false when we could only
 * guess (no product section, or nothing readable), so a mismatch is never blamed on a guess.
 */
export async function pagePrice(page, expected) {
  const found = await page
    .evaluate(() => {
      const SEL = ['.price-item--sale', '.price__sale .price-item--last', '[data-product-price]', '.product__price', '.product-single__price', '.price-item--regular', '.price .money', '.money', '.price', '[data-price]', '[class*="price"]'];
      const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const struck = (el) => !!el.closest('s, del, strike, [class*="compare"], [class*="was-price"]') || (!!el.closest('.price__regular') && !!el.closest('.price--on-sale'));
      const form = document.querySelector('form[action*="/cart/add"]');
      let scope = null;
      for (let a = form?.parentElement, i = 0; a && i < 6; a = a.parentElement, i++) {
        if (SEL.some((s) => [...a.querySelectorAll(s)].some((el) => visible(el) && !struck(el) && /\d/.test(el.textContent)))) { scope = a; break; }
      }
      const root = scope || document.querySelector('main') || document.body;
      const texts = [];
      for (const s of SEL) for (const el of root.querySelectorAll(s)) {
        if (texts.length >= 8) break;
        if (!visible(el) || struck(el)) continue;
        const t = el.textContent.replace(/\s+/g, ' ').trim();
        if (/\d/.test(t) && t.length < 160 && !texts.includes(t)) texts.push(t);
      }
      return { texts, scoped: !!scope };
    })
    .catch(() => ({ texts: [], scoped: false }));
  for (const t of found.texts) {
    const hit = amountsIn(t).find((a) => expected != null && Math.abs(a.minor - expected) <= (a.exact ? 1 : 100));
    if (hit) return { minor: hit.minor, exact: hit.exact, text: t, trusted: true };
  }
  const first = found.texts.map((t) => ({ t, a: amountsIn(t)[0] })).find((x) => x.a);
  if (first && found.scoped) return { minor: first.a.minor, exact: first.a.exact, text: first.t, trusted: true };
  return { minor: expected, exact: true, text: null, trusted: false };
}

const SUBTOTAL = /^(subtotal|sub-total|sub total|zwischensumme|sous-total|subtotale|subtotaal|小計|小计)\b/i;

/** The subtotal the checkout shows before payment, or null when it isn't on screen. */
export async function checkoutSubtotal(page) {
  const text = await page
    .evaluate((src) => {
      const re = new RegExp(src, 'i');
      const els = [...document.querySelectorAll('body *')].filter((el) => el.children.length <= 2 && re.test((el.textContent || '').trim()) && (el.textContent || '').trim().length < 60);
      for (const el of els) {
        let a = el;
        for (let i = 0; i < 4 && a; i++, a = a.parentElement) {
          const t = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
          if (t.length < 200 && /\d/.test(t.replace(re, '').replace(/\d+\s*(items?|artikel|articles?)/i, ''))) return t;
        }
      }
      return null;
    }, SUBTOTAL.source)
    .catch(() => null);
  if (!text) return null;
  const a = amountsIn(text.replace(/\d+\s*(items?|artikel|articles?)\b/i, ''));
  return a.length ? { minor: a.at(-1).minor, text } : null;
}

/** What the cart charges for one variant, from Shopify's cart.js. */
export function cartLine(cart, variantId) {
  const line = (cart?.items || []).find((i) => String(i.variant_id ?? i.id) === String(variantId));
  if (!line) return null;
  const qty = Number(line.quantity) || 1;
  const unit = Number.isInteger(line.price) ? line.price : toMinor(line.price);
  const full = Number(line.original_line_price ?? line.line_price ?? unit * qty);
  const charged = Number(line.final_line_price ?? line.line_price ?? unit * qty);
  const lineDiscount = full - charged > 0 || (line.line_level_discount_allocations || []).some((d) => Number(d.amount) > 0);
  const cartDiscount = Number(cart.total_discount) > 0 || (cart.cart_level_discount_applications || []).length > 0;
  return { quantity: qty, charged, discounted: lineDiscount || cartDiscount };
}

/**
 * The whole cart, when it holds more than the test item (a shipping-protection or upsell app added a paid line,
 * or items were left from an earlier visit). The checkout subtotal is for the whole cart, so it is compared with
 * this total, not with the test item's price. null when the cart holds only the test item.
 */
export function wholeCart(cart, variantId) {
  const items = cart?.items || [];
  const others = items.filter((i) => String(i.variant_id ?? i.id) !== String(variantId));
  if (!others.length) return null;
  // Shopify's checkout subtotal: line prices after line discounts, before order-level discounts and shipping.
  const minor = Number(cart.items_subtotal_price ?? cart.total_price);
  if (!Number.isFinite(minor)) return null;
  return { minor, lines: items.length, others: others.map((i) => String(i.title || i.product_title || '').slice(0, 80)).filter(Boolean) };
}

/**
 * The journey price check. trail: { product, variant, quantity, currency, page, cart, checkout }.
 * Fails when the cart or checkout charges more than the product page showed; warns when it charges less
 * and no discount explains it. When the cart holds other lines too (trail.whole), the checkout subtotal is
 * compared with the whole cart instead. When the product page price could not be read (page.trusted false),
 * a difference against our guess from product data is at most a warning: it may be a market or B2B price
 * the shopper never saw.
 */
export async function priceCheck(rec, trail, { shot = null } = {}) {
  const cur = trail.currency;
  const qty = trail.quantity || 1;
  const shown = trail.page.minor * qty;
  const tol = trail.page.exact ? 1 : 100; // a page showing "₹1,499" rounds to whole units
  const whole = trail.whole || null;
  // Each step with what it is compared with: the price shown (ref 'page'), or the whole cart (ref 'cart').
  const steps = [
    { label: trail.page.trusted ? 'Product page' : 'Product price (from your product data)', minor: shown, note: trail.page.text || '' },
    trail.cart ? { label: 'Cart', minor: trail.cart.charged, note: trail.cart.discounted ? 'A discount is applied' : '', ref: 'page' } : null,
    whole ? { label: `Whole cart (${whole.lines} items)`, minor: whole.minor, note: whole.others.length ? `Also in the cart: ${whole.others.slice(0, 3).join(', ')}` : '' } : null,
    trail.checkout ? { label: 'Checkout subtotal', minor: trail.checkout.minor, note: '', ref: whole ? 'cart' : 'page' } : trail.checkoutReached ? { label: 'Checkout subtotal', minor: null, note: 'Not shown before payment details' } : null,
  ].filter(Boolean);
  const name = `“${trail.product}”${trail.variant && trail.variant !== 'Default Title' ? ` (${trail.variant})` : ''}${qty > 1 ? ` × ${qty}` : ''}`;
  const refOf = (s) => (s.ref === 'cart' ? whole.minor : shown);
  const tolOf = (s) => (s.ref === 'cart' ? 1 : tol);
  const compared = steps.filter((s) => s.ref && s.minor != null);
  const over = compared.find((s) => s.minor > refOf(s) + tolOf(s));
  const discounted = !!trail.cart?.discounted;
  const under = !discounted && compared.find((s) => s.minor < refOf(s) - tolOf(s));
  const evidence = { priceTrail: { currency: cur, steps: steps.map(({ ref, ...s }) => ({ ...s, money: s.minor == null ? null : money(s.minor, cur) })) } };
  const screenshot = (over || under) && shot ? await shot().catch(() => null) : null;
  // Against our guess from product data (the page price could not be read): never critical.
  const guessed = (s) => s.ref === 'page' && !trail.page.trusted;
  if (over && guessed(over)) {
    return rec.add(check('fn.price', 'functional', 'Price stays the same to checkout', 'warn', {
      severity: 'major',
      detail: `We could not read the price on the product page of ${name}. Your product data says ${money(shown, cur)}, but the ${over.label.toLowerCase()} asks for ${money(over.minor, cur)}. This can be right (a price for another country or a customer price list), so check what shoppers see on the product page.`,
      evidence: { ...evidence, screenshot },
      fix: 'Open the product page as a shopper and compare its price with the cart. If they differ, check apps that change prices in the cart (bundle, upsell, currency and pricing apps).',
    }));
  }
  if (over) {
    const vsCart = over.ref === 'cart';
    return rec.add(check('fn.price', 'functional', 'Price stays the same to checkout', 'fail', {
      severity: 'critical',
      detail: vsCart
        ? `The checkout subtotal asks for ${money(over.minor, cur)}, but the cart with the same items comes to ${money(whole.minor, cur)}. Customers are charged more than the cart showed.`
        : `${name} shows ${money(shown, cur)} on the product page, but the ${over.label.toLowerCase()} asks for ${money(over.minor, cur)}. Customers are charged more than the price they saw.`,
      evidence: { ...evidence, screenshot },
      fix: 'Check apps that change prices in the cart or checkout (bundle, upsell, currency and pricing apps) and any checkout customisations. Then compare the price in Shopify admin with what your theme shows on the product page.',
    }));
  }
  if (under) {
    return rec.add(check('fn.price', 'functional', 'Price stays the same to checkout', 'warn', {
      severity: 'major',
      detail: under.ref === 'cart'
        ? `The checkout subtotal asks for only ${money(under.minor, cur)}, but the cart with the same items comes to ${money(whole.minor, cur)}, and no discount explains it. You may be selling below your price.`
        : `${name} shows ${money(shown, cur)} on the product page, but the ${under.label.toLowerCase()} asks for only ${money(under.minor, cur)}, and no discount explains it. You may be selling below your price.`,
      evidence: { ...evidence, screenshot },
      fix: 'Check for an automatic discount or pricing app you did not mean to leave on, and that the product page shows the current price.',
    }));
  }
  const last = steps.filter((s) => s.minor != null).at(-1);
  return rec.add(check('fn.price', 'functional', 'Price stays the same to checkout', 'pass', {
    severity: 'critical',
    detail: `${name}: ${steps.filter((s) => s.minor != null).map((s) => `${s.label.toLowerCase()} ${money(s.minor, cur)}`).join(', ')}.${discounted && last.minor < shown ? ' The lower price comes from a discount.' : ''}${trail.page.trusted ? '' : ' We could not read the price on the product page, so we used your product data.'}`,
    evidence,
  }));
}

async function api(page, path, body) {
  return page.evaluate(async ([path, body]) => {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) } : { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    let j = null;
    try { j = await r.json(); } catch {}
    return { status: r.status, json: j };
  }, [path, body]).catch((e) => ({ status: 0, error: String(e) }));
}

export const ruleId = (i) => `fn.price.rule-${i + 1}`;

/** The owner's price rules, each put in a fresh cart. Nothing is bought; the cart is emptied. */
export async function runPriceRules({ page, rec, origin, rules }) {
  if (!rules?.length) return;
  if (!page.url().startsWith(origin)) await page.goto(origin + '/cart', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  for (const [i, r] of rules.slice(0, MAX_PRICE_RULES).entries()) {
    const id = ruleId(i);
    let title = `Price rule: ${r.quantity} × ${r.product}`;
    rec.step(`Check price rule ${i + 1}: ${r.quantity} × ${r.product}`);
    try {
      const p = await api(page, `/products/${encodeURIComponent(r.product)}.js`);
      if (p.status !== 200 || !p.json?.variants) {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: `We couldn't find the product “${r.product}” on your store, so this rule wasn't checked.`, fix: 'Open Test suite → Price rules and pick the product again. It may have been renamed, unpublished or deleted.' }));
        continue;
      }
      const want = r.variant ? String(r.variant).toLowerCase() : null;
      const v = p.json.variants.find((x) => want && (String(x.id) === want || String(x.title).toLowerCase() === want)) || (!want && p.json.variants.find((x) => x.available));
      title = `Price rule: ${r.quantity} × ${p.json.title}${v && v.title !== 'Default Title' ? ` (${v.title})` : ''}`;
      if (!v) {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: want ? `“${p.json.title}” has no variant called “${r.variant}”, so this rule wasn't checked.` : `“${p.json.title}” is sold out, so this rule wasn't checked.`, fix: want ? 'Open Test suite → Price rules and choose the variant again.' : '' }));
        continue;
      }
      await api(page, '/cart/clear.js', {});
      const added = await api(page, '/cart/add.js', { items: [{ id: v.id, quantity: r.quantity }] });
      if (added.status >= 400) {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: `The cart did not accept ${r.quantity} of this product (status ${added.status}), so the price could not be checked. It may be out of stock or limited per order.` }));
        continue;
      }
      const cart = (await api(page, '/cart.js')).json;
      const cur = cart?.currency;
      const line = cartLine(cart, v.id);
      const expected = Math.round(r.price * 100) * r.quantity;
      const trail = { currency: cur, steps: [{ label: 'You expect', minor: expected, money: money(expected, cur), note: `${r.quantity} × ${money(Math.round(r.price * 100), cur)}` }, { label: 'Cart', minor: line?.charged ?? null, money: line ? money(line.charged, cur) : null, note: line?.discounted ? 'A discount is applied' : '' }] };
      if (!line) { rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: 'The product did not appear in the cart, so the price could not be checked.', evidence: { priceTrail: trail } })); continue; }
      const each = money(Math.round(line.charged / r.quantity), cur);
      if (line.charged > expected + 1) {
        rec.add(check(id, 'functional', title, 'fail', { severity: 'critical', detail: `You expect ${money(expected, cur)} for ${r.quantity}, but the cart charges ${money(line.charged, cur)} (${each} each).`, evidence: { priceTrail: trail }, fix: 'Check the price and any quantity or volume pricing for this product in Shopify admin, and apps that change prices in the cart. If the price changed on purpose, update the rule.' }));
      } else if (line.charged < expected - 1) {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: `You expect ${money(expected, cur)} for ${r.quantity}, but the cart charges only ${money(line.charged, cur)} (${each} each).${line.discounted ? ' A discount is applied.' : ''}`, evidence: { priceTrail: trail }, fix: 'If this lower price is not intended, check discounts and pricing apps. If it is, update the rule.' }));
      } else {
        rec.add(check(id, 'functional', title, 'pass', { severity: 'critical', detail: `The cart charges ${money(line.charged, cur)} for ${r.quantity}, as you expect.`, evidence: { priceTrail: trail } }));
      }
    } catch (e) {
      rec.add(check(id, 'functional', title, 'skip', { severity: 'major', detail: shortErr(e) }));
    }
  }
  await api(page, '/cart/clear.js', {});
}

/** Validates the owner's price rules (Test suite → Price rules). Throws an Error with a plain message. */
export function cleanPriceRules(input) {
  if (!Array.isArray(input)) throw new Error('Price rules must be a list.');
  const out = [];
  for (const raw of input) {
    if (!raw || (!raw.product && !raw.price)) continue;
    let product = String(raw.product || '').trim();
    const m = /\/products\/([^/?#]+)/.exec(product);
    if (m) product = decodeURIComponent(m[1]);
    product = product.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,199}$/i.test(product)) throw new Error(`“${raw.product || ''}” is not a product. Use the product's link or its handle, like cotton-kurta.`);
    const quantity = raw.quantity == null || raw.quantity === '' ? 1 : Number(raw.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error('Quantity must be a whole number from 1 to 99.');
    const ps = String(raw.price ?? '').replace(/,/g, '').trim();
    const price = Number(ps);
    if (!/^\d+(\.\d{1,2})?$/.test(ps) || price <= 0 || price > 10000000) throw new Error(`Enter the price each for “${product}”, like 1299 or 1299.50.`);
    const variant = raw.variant ? String(raw.variant).trim().slice(0, 100) : null;
    out.push({ product, variant, quantity, price });
  }
  if (out.length > MAX_PRICE_RULES) throw new Error(`Up to ${MAX_PRICE_RULES} price rules.`);
  return out;
}

/*
 * Quantity breaks (tiered or volume pricing). The owner lists a product's breaks in Test suite → Price rules,
 * for example "5+ 10%, 10+ 20%" or "5+ 450, 10+ 400". Each check puts the product in a fresh cart at every
 * break and one below it (4, 5, 9 and 10 units) and checks the unit price and total the cart charges, then
 * the checkout subtotal at the biggest break. Volume-discount apps and Shopify Functions both show up in
 * Shopify's cart.js, so this works whatever gives the discount. Nothing is bought; the cart is emptied.
 */
export const MAX_TIER_SETS = 5;
const MAX_TIERS = 5;
const MAX_QTYS = 8;
export const tierId = (i) => `fn.price.tiers-${i + 1}`;

/** "5+ 10%, 10+ 20%" or "5+: 450, 10+ = 400" -> [{ min, percent } | { min, price }]. Throws a plain message. */
export function parseTiers(text, product = 'this product') {
  const s = String(text ?? '').trim();
  if (!s) throw new Error(`Enter the quantity breaks for “${product}”, like 5+ 10%, 10+ 20%.`);
  const out = [];
  // Thousands commas (1,299.50) go first, so they are not read as a list separator. "450,100+ 400" stays a list.
  for (const part of s.replace(/(\d),(?=\d{3}(?![\d+]))/g, '$1').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d{1,2})\s*\+?\s*(?:units?|pcs|items?)?\s*[:=@→>-]*\s*(?:₹|rs\.?|\$|€|£)?\s*(\d{1,8}(?:\.\d{1,2})?)\s*(%|percent|off|% off)?$/i.exec(part);
    if (!m) throw new Error(`“${part}” is not a quantity break. Write it like 5+ 10% (10% off from 5 units) or 5+ 450 (450 each from 5 units).`);
    const min = Number(m[1]);
    const val = Number(m[2]);
    if (min < 2 || min > 99) throw new Error(`Quantity breaks start at 2 to 99 units (“${part}”).`);
    if (m[3]) {
      if (val <= 0 || val >= 100) throw new Error(`A percentage off must be between 0 and 100 (“${part}”).`);
      out.push({ min, percent: val });
    } else {
      if (val <= 0 || val > 10000000) throw new Error(`Enter the price each for “${part}”, like 5+ 450.`);
      out.push({ min, price: val });
    }
  }
  out.sort((a, b) => a.min - b.min);
  if (out.length > MAX_TIERS) throw new Error(`Up to ${MAX_TIERS} quantity breaks per product.`);
  if (new Set(out.map((t) => t.min)).size !== out.length) throw new Error(`Each quantity can have only one break for “${product}”.`);
  return out;
}

/** Shows tiers the way the owner writes them: "5+ 10%, 10+ 450". */
export const tiersText = (tiers) => (tiers || []).map((t) => `${t.min}+ ${t.percent != null ? `${t.percent}%` : t.price}`).join(', ');

/** Validates Test suite → Price rules → Quantity breaks. Throws an Error with a plain message. */
export function cleanPriceTiers(input) {
  if (!Array.isArray(input)) throw new Error('Quantity breaks must be a list.');
  const out = [];
  for (const raw of input) {
    if (!raw || (!raw.product && !raw.tiers)) continue;
    let product = String(raw.product || '').trim();
    const m = /\/products\/([^/?#]+)/.exec(product);
    if (m) product = decodeURIComponent(m[1]);
    product = product.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,199}$/i.test(product)) throw new Error(`“${raw.product || ''}” is not a product. Use the product's link or its handle, like cotton-kurta.`);
    const tiers = Array.isArray(raw.tiers) ? parseTiers(tiersText(raw.tiers), product) : parseTiers(raw.tiers, product);
    const variant = raw.variant ? String(raw.variant).trim().slice(0, 100) : null;
    out.push({ product, variant, tiers });
  }
  if (out.length > MAX_TIER_SETS) throw new Error(`Up to ${MAX_TIER_SETS} products with quantity breaks.`);
  return out;
}

/** The quantities worth trying: each break and one below it, up to MAX_QTYS. */
export function tierQuantities(tiers) {
  const qs = new Set();
  for (const t of tiers) { if (t.min - 1 >= 1) qs.add(t.min - 1); qs.add(t.min); }
  return [...qs].sort((a, b) => a - b).slice(0, MAX_QTYS);
}

/** The unit price (minor units) the owner expects at a quantity, from the base unit price and the breaks. */
export function tierUnit(tiers, qty, baseMinor) {
  const t = [...tiers].reverse().find((x) => qty >= x.min);
  if (!t) return baseMinor;
  return t.price != null ? Math.round(t.price * 100) : Math.round((baseMinor * (100 - t.percent)) / 100);
}

/**
 * Compares what the cart charged at each quantity with the breaks. rows: [{ qty, charged }] (charged in minor
 * units, null when the cart refused). Returns { rows (with expected values), over, under, refused }.
 * Shopify rounds each line, so up to one minor unit per item is not a difference.
 */
export function compareTiers(tiers, baseMinor, rows) {
  const out = rows.map((r) => {
    const unit = tierUnit(tiers, r.qty, baseMinor);
    const expect = unit * r.qty;
    const tol = Math.max(1, r.qty);
    const state = r.charged == null ? 'refused' : r.charged > expect + tol ? 'over' : r.charged < expect - tol ? 'under' : 'ok';
    return { ...r, unit, expect, state };
  });
  return { rows: out, over: out.filter((r) => r.state === 'over'), under: out.filter((r) => r.state === 'under'), refused: out.filter((r) => r.state === 'refused') };
}

/** The quantity breaks, each product in fresh carts at every break. Runs with the price rules. */
export async function runPriceTiers({ page, rec, origin, sets }) {
  if (!sets?.length) return;
  if (!page.url().startsWith(origin)) await page.goto(origin + '/cart', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  for (const [i, set] of sets.slice(0, MAX_TIER_SETS).entries()) {
    const id = tierId(i);
    let title = `Quantity breaks: ${set.product}`;
    rec.step(`Check quantity breaks for ${set.product}`);
    try {
      const p = await api(page, `/products/${encodeURIComponent(set.product)}.js`);
      if (p.status !== 200 || !p.json?.variants) {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: `We couldn't find the product “${set.product}” on your store, so its quantity breaks weren't checked.`, fix: 'Open Test suite → Price rules and pick the product again. It may have been renamed, unpublished or deleted.' }));
        continue;
      }
      const want = set.variant ? String(set.variant).toLowerCase() : null;
      const v = p.json.variants.find((x) => want && (String(x.id) === want || String(x.title).toLowerCase() === want)) || (!want && p.json.variants.find((x) => x.available));
      title = `Quantity breaks: ${p.json.title}${v && v.title !== 'Default Title' ? ` (${v.title})` : ''}`;
      if (!v) {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: want ? `“${p.json.title}” has no variant called “${set.variant}”, so its quantity breaks weren't checked.` : `“${p.json.title}” is sold out, so its quantity breaks weren't checked.` }));
        continue;
      }
      const base = toMinor(v.price, true);
      const rows = [];
      let cur = null;
      let lastCart = null;
      for (const qty of tierQuantities(set.tiers)) {
        await api(page, '/cart/clear.js', {});
        const added = await api(page, '/cart/add.js', { items: [{ id: v.id, quantity: qty }] });
        if (added.status >= 400) { rows.push({ qty, charged: null }); continue; }
        const cart = (await api(page, '/cart.js')).json;
        cur = cart?.currency || cur;
        const line = cartLine(cart, v.id);
        rows.push({ qty, charged: line && line.quantity === qty ? line.charged : null });
        lastCart = line && line.quantity === qty ? { qty, cart } : lastCart;
      }
      // The checkout at the biggest break the cart accepted: its subtotal must match the cart.
      let checkout = null;
      if (lastCart) {
        await api(page, '/cart/clear.js', {});
        await api(page, '/cart/add.js', { items: [{ id: v.id, quantity: lastCart.qty }] });
        const cartNow = (await api(page, '/cart.js')).json;
        await page.goto(origin + '/checkout', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(1200);
        if (/\/checkouts?\//.test(page.url())) {
          const sub = await checkoutSubtotal(page);
          const cartTotal = Number(cartNow?.items_subtotal_price ?? cartNow?.total_price);
          checkout = { qty: lastCart.qty, minor: sub?.minor ?? null, cart: Number.isFinite(cartTotal) ? cartTotal : null };
        }
        await page.goto(origin + '/cart', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
      const r = compareTiers(set.tiers, base, rows);
      const m = (x) => money(x, cur);
      const tierTable = {
        currency: cur,
        rows: r.rows.map((x) => ({ qty: x.qty, expect: m(x.expect), expectEach: m(x.unit), charged: x.charged == null ? null : m(x.charged), chargedEach: x.charged == null ? null : m(Math.round(x.charged / x.qty)), state: x.state })),
        checkout: checkout && checkout.minor != null ? { qty: checkout.qty, money: m(checkout.minor), cart: checkout.cart == null ? null : m(checkout.cart), higher: checkout.cart != null && checkout.minor > checkout.cart + 1 } : null,
      };
      const evidence = { tierTable };
      const say = (x) => `${x.qty} cost${x.qty === 1 ? 's' : ''} ${m(x.charged)} (${m(Math.round(x.charged / x.qty))} each), but your breaks say ${m(x.expect)} (${m(x.unit)} each)`;
      const coBad = checkout && checkout.minor != null && checkout.cart != null && checkout.minor > checkout.cart + 1;
      if (r.over.length || coBad) {
        const parts = r.over.map(say);
        if (coBad) parts.push(`at checkout, ${checkout.qty} come to ${m(checkout.minor)} while the cart showed ${m(checkout.cart)}`);
        rec.add(check(id, 'functional', title, 'fail', { severity: 'critical', detail: `Customers buying more are charged too much: ${parts.join('; ')}.`, evidence, fix: 'Check your volume or quantity discount app (or Shopify discount) for this product: is it on, does it include this product and variant, and do its breaks match these? If the breaks changed on purpose, update them in Test suite → Price rules.' }));
      } else if (r.under.length) {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: `The cart charges less than your breaks: ${r.under.map(say).join('; ')}. You may be giving a bigger discount than you meant.`, evidence, fix: 'Check that the discount app or Shopify discount has the breaks you meant, and that no other discount stacks on top. If the lower price is intended, update the breaks.' }));
      } else if (r.refused.length === r.rows.length) {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: `The cart did not accept ${r.rows.map((x) => x.qty).join(', ')} of this product, so the breaks could not be checked. It may be low on stock or limited per order.`, evidence }));
      } else {
        const ok = r.rows.filter((x) => x.state === 'ok');
        rec.add(check(id, 'functional', title, 'pass', { severity: 'critical', detail: `Every quantity break works: ${ok.map((x) => `${x.qty} at ${m(x.unit)} each`).join(', ')}.${r.refused.length ? ` The cart did not accept ${r.refused.map((x) => x.qty).join(', ')}, so we skipped ${r.refused.length === 1 ? 'that one' : 'those'}.` : ''}${checkout?.minor != null ? ` Checkout shows the same ${m(checkout.minor)} for ${checkout.qty}.` : ''}`, evidence }));
      }
    } catch (e) {
      rec.add(check(id, 'functional', title, 'skip', { severity: 'major', detail: shortErr(e) }));
    }
  }
  await api(page, '/cart/clear.js', {});
}
