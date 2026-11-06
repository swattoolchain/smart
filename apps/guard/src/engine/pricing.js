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
 * The journey price check. trail: { product, variant, quantity, currency, page, cart, checkout }.
 * Fails when the cart or checkout charges more than the product page showed; warns when it charges less
 * and no discount explains it.
 */
export async function priceCheck(rec, trail, { shot = null } = {}) {
  const cur = trail.currency;
  const qty = trail.quantity || 1;
  const shown = trail.page.minor * qty;
  const tol = trail.page.exact ? 1 : 100; // a page showing "₹1,499" rounds to whole units
  const steps = [
    { label: trail.page.trusted ? 'Product page' : 'Product price (from your product data)', minor: shown, note: trail.page.text || '' },
    trail.cart ? { label: 'Cart', minor: trail.cart.charged, note: trail.cart.discounted ? 'A discount is applied' : '' } : null,
    trail.checkout ? { label: 'Checkout subtotal', minor: trail.checkout.minor, note: '' } : trail.checkoutReached ? { label: 'Checkout subtotal', minor: null, note: 'Not shown before payment details' } : null,
  ].filter(Boolean);
  const name = `“${trail.product}”${trail.variant && trail.variant !== 'Default Title' ? ` (${trail.variant})` : ''}${qty > 1 ? ` × ${qty}` : ''}`;
  const over = steps.slice(1).find((s) => s.minor != null && s.minor > shown + tol);
  const discounted = !!trail.cart?.discounted;
  const under = !discounted && steps.slice(1).find((s) => s.minor != null && s.minor < shown - tol);
  const evidence = { priceTrail: { currency: cur, steps: steps.map((s) => ({ ...s, money: s.minor == null ? null : money(s.minor, cur) })) } };
  const screenshot = (over || under) && shot ? await shot().catch(() => null) : null;
  if (over) {
    return rec.add(check('fn.price', 'functional', 'Price stays the same to checkout', 'fail', {
      severity: 'critical',
      detail: `${name} shows ${money(shown, cur)} on the product page, but the ${over.label.toLowerCase()} asks for ${money(over.minor, cur)}. Customers are charged more than the price they saw.`,
      evidence: { ...evidence, screenshot },
      fix: 'Check apps that change prices in the cart or checkout (bundle, upsell, currency and pricing apps) and any checkout customisations. Then compare the price in Shopify admin with what your theme shows on the product page.',
    }));
  }
  if (under) {
    return rec.add(check('fn.price', 'functional', 'Price stays the same to checkout', 'warn', {
      severity: 'major',
      detail: `${name} shows ${money(shown, cur)} on the product page, but the ${under.label.toLowerCase()} asks for only ${money(under.minor, cur)}, and no discount explains it. You may be selling below your price.`,
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
