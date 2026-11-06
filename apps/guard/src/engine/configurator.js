/**
 * Product configurators (Pricing 3): engraving, gift wrap, made-to-order sizes and other add-on upcharges.
 * The owner lists a test configuration in Test suite → Price rules → Product options: the product, the options a
 * shopper fills ("Engraving* = Happy Diwali; Gift wrap = Yes", a * marks an option that must be required) and the
 * price they expect for it. Each check, in a real browser on the product page:
 *  1. clicks Add to cart with the required options empty: the cart must stay empty;
 *  2. fills every option the way a shopper does (text, dropdown, tick box or choice button, found by its label);
 *  3. reads the price shown, adds to cart, and checks the cart line carries each choice (Shopify line item
 *     properties) and the cart total, with any add-on lines, is the price expected; then the checkout subtotal.
 * Options apps keep choices as line item properties and add upcharges as extra lines, so it all shows in cart.js.
 * Nothing is bought; the cart is emptied. No admin access is needed.
 */
import { check, shortErr } from './checks.js';
import { settle } from './browser.js';
import { pagePrice, checkoutSubtotal, money, toMinor } from './pricing.js';

export const MAX_CONFIGS = 5;
const MAX_OPTIONS = 6;
export const configId = (i) => `fn.price.config-${i + 1}`;

const ATC = ['form[action*="/cart/add"] [type="submit"]', 'button[name="add"]', '[data-add-to-cart]', 'button.product-form__submit', 'button:has-text("Add to cart")', 'button:has-text("Add to Cart")', 'button:has-text("Add to bag")'];
const YES = /^(yes|y|on|true|checked|ticked|✓)$/i;
const NO = /^(no|n|off|false|unchecked|none)$/i;

/** "Engraving* = Happy Diwali; Gift wrap = Yes" -> [{ name, value, required }]. Throws a plain message. */
export function parseOptions(text, product = 'this product') {
  const s = String(text ?? '').trim();
  if (!s) throw new Error(`Enter the options to fill for “${product}”, like Engraving* = Happy Diwali; Gift wrap = Yes.`);
  const out = [];
  for (const part of s.split(/[;\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^([^=:<>]{1,60}?)\s*(\*)?\s*[=:]\s*([^<>]{1,100})$/.exec(part);
    if (!m) throw new Error(`“${part}” is not an option. Write it as name = value, like Gift wrap = Yes.`);
    const name = m[1].replace(/\*$/, '').trim();
    if (!name) throw new Error(`“${part}” needs the option's name before the = sign.`);
    out.push({ name, value: m[3].trim(), required: !!m[2] || /\*\s*$/.test(m[1]) });
  }
  if (out.length > MAX_OPTIONS) throw new Error(`Up to ${MAX_OPTIONS} options per product.`);
  if (new Set(out.map((o) => o.name.toLowerCase())).size !== out.length) throw new Error(`Each option can be listed once for “${product}”.`);
  return out;
}

export const optionsText = (opts) => (opts || []).map((o) => `${o.name}${o.required ? '*' : ''} = ${o.value}`).join('; ');
/** The options in a sentence for store owners: Engraving “Happy Diwali” and Gift wrap “Yes”. */
export const optionsSay = (opts) => (opts || []).map((o) => `${o.name} “${o.value}”`).join(' and ');

/** Validates Test suite → Price rules → Product options. Throws an Error with a plain message. */
export function cleanPriceConfigs(input) {
  if (!Array.isArray(input)) throw new Error('Product options must be a list.');
  const out = [];
  for (const raw of input) {
    if (!raw || (!raw.product && !raw.options && !raw.price)) continue;
    let product = String(raw.product || '').trim();
    const m = /\/products\/([^/?#]+)/.exec(product);
    if (m) product = decodeURIComponent(m[1]);
    product = product.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,199}$/i.test(product)) throw new Error(`“${raw.product || ''}” is not a product. Use the product's link or its handle, like cotton-kurta.`);
    const options = Array.isArray(raw.options) ? parseOptions(optionsText(raw.options), product) : parseOptions(raw.options, product);
    const ps = String(raw.price ?? '').replace(/,/g, '').trim();
    const price = Number(ps);
    if (!/^\d+(\.\d{1,2})?$/.test(ps) || price <= 0 || price > 10000000) throw new Error(`Enter the price you expect for “${product}” with these options, like 1598.`);
    const variant = raw.variant ? String(raw.variant).trim().slice(0, 100) : null;
    out.push({ product, variant, options, price });
  }
  if (out.length > MAX_CONFIGS) throw new Error(`Up to ${MAX_CONFIGS} products with options.`);
  return out;
}

/** Does a cart line carry this choice? Properties match by name (any case, "_" hidden prefix allowed). */
export function hasChoice(props, opt) {
  const want = opt.name.toLowerCase().trim();
  for (const [k, v] of Object.entries(props || {})) {
    if (k.replace(/^_/, '').toLowerCase().trim() !== want) continue;
    const got = String(v ?? '').trim().toLowerCase();
    const val = opt.value.toLowerCase();
    if (got === val || got.startsWith(val) || (YES.test(opt.value) && YES.test(got))) return true;
  }
  return false;
}

/** Fills one option on the product page, the way a shopper would. Returns how, or null when it isn't there. */
async function fill(page, form, opt) {
  const byName = form.locator(`[name="properties[${opt.name.replace(/"/g, '\\"')}]"]`);
  const byLabel = form.getByLabel(opt.name, { exact: false });
  const candidates = [byName, byLabel];
  for (const loc of candidates) {
    const n = await loc.count().catch(() => 0);
    if (!n) continue;
    const el = loc.first();
    const tag = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => '');
    const type = await el.evaluate((e) => (e.type || '').toLowerCase()).catch(() => '');
    if (tag === 'select') {
      const ok = await el.selectOption({ label: opt.value }).then(() => true).catch(() => false)
        || await el.selectOption(opt.value).then(() => true).catch(() => false)
        || await el.evaluate((e, v) => { const o = [...e.options].find((x) => x.textContent.trim().toLowerCase().startsWith(v.toLowerCase())); if (!o) return false; e.value = o.value; e.dispatchEvent(new Event('change', { bubbles: true })); return true; }, opt.value).catch(() => false);
      if (ok) return 'select';
      continue;
    }
    if (type === 'checkbox') {
      if (NO.test(opt.value)) await el.uncheck({ timeout: 4000 }).catch(() => {});
      else await el.check({ timeout: 4000 }).catch(() => {});
      return 'tick box';
    }
    if (type === 'radio') {
      const radio = form.locator(`[name="${await el.getAttribute('name')}"]`);
      const k = await radio.count();
      for (let i = 0; i < k; i++) {
        const r = radio.nth(i);
        const lab = await r.evaluate((e) => (e.labels?.[0]?.textContent || e.value || '').trim()).catch(() => '');
        if (lab.toLowerCase().startsWith(opt.value.toLowerCase()) || String(await r.getAttribute('value')).toLowerCase() === opt.value.toLowerCase()) { await r.check({ timeout: 4000 }).catch(() => {}); return 'choice'; }
      }
      continue;
    }
    if (['input', 'textarea'].includes(tag)) {
      await el.fill(opt.value, { timeout: 4000 }).catch(() => {});
      return 'text';
    }
  }
  return null;
}

async function cart(page) {
  return page.evaluate(async () => { const r = await fetch('/cart.js', { headers: { Accept: 'application/json' }, credentials: 'same-origin' }); return r.ok ? r.json() : null; }).catch(() => null);
}
async function clear(page) {
  await page.evaluate(() => fetch('/cart/clear.js', { method: 'POST', credentials: 'same-origin' })).catch(() => {});
}
async function atcButton(page) {
  for (const sel of ATC) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 4); i++) if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
  }
  return null;
}
async function waitCart(page, ms = 6000) {
  for (let t = 0; t < ms; t += 600) {
    const c = await cart(page);
    if ((c?.item_count || 0) > 0) return c;
    await page.waitForTimeout(600);
  }
  return cart(page);
}

/** The owner's product options, each tried on the product page. */
export async function runPriceConfigs({ page, rec, origin, configs, shot = null }) {
  if (!configs?.length) return;
  for (const [i, cfg] of configs.slice(0, MAX_CONFIGS).entries()) {
    const id = configId(i);
    let title = `Product options: ${cfg.product}`;
    rec.step(`Check product options for ${cfg.product}`);
    try {
      if (!page.url().startsWith(origin)) await page.goto(origin + '/cart', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      const p = await page.evaluate(async (h) => { const r = await fetch(`/products/${encodeURIComponent(h)}.js`, { headers: { Accept: 'application/json' } }); return r.ok ? r.json() : null; }, cfg.product).catch(() => null);
      if (!p?.variants) {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: `We couldn't find the product “${cfg.product}” on your store, so its options weren't checked.`, fix: 'Open Test suite → Price rules and pick the product again. It may have been renamed, unpublished or deleted.' }));
        continue;
      }
      const want = cfg.variant ? String(cfg.variant).toLowerCase() : null;
      const v = p.variants.find((x) => want && (String(x.id) === want || String(x.title).toLowerCase() === want)) || (!want && p.variants.find((x) => x.available));
      title = `Product options: ${p.title}${v && v.title !== 'Default Title' ? ` (${v.title})` : ''}`;
      if (!v) {
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: want ? `“${p.title}” has no variant called “${cfg.variant}”, so its options weren't checked.` : `“${p.title}” is sold out, so its options weren't checked.` }));
        continue;
      }
      const expected = Math.round(cfg.price * 100);
      const base = toMinor(v.price, true);
      const url = `${origin}/products/${p.handle}?variant=${v.id}`;
      const problems = []; // { text, severity }
      const notes = [];

      // 1. Required options are really required.
      await clear(page);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settle(page, 800);
      const required = cfg.options.filter((o) => o.required);
      if (required.length) {
        const btn = await atcButton(page);
        if (btn) await btn.click({ timeout: 6000 }).catch(() => {});
        const c0 = await waitCart(page, 2400);
        if ((c0?.item_count || 0) > 0) {
          problems.push({ severity: 'major', text: `customers can add it to the cart without filling ${required.map((o) => `“${o.name}”`).join(' or ')}, so orders can arrive without it` });
          await clear(page);
        } else notes.push(`Add to cart waits for ${required.map((o) => `“${o.name}”`).join(' and ')}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await settle(page, 800);
      }

      // 2. Fill every option like a shopper.
      const form = page.locator('form[action*="/cart/add"]').filter({ has: page.locator('[type="submit"], button') }).first();
      const scope = (await form.count()) ? form : page.locator('body');
      const missing = [];
      for (const o of cfg.options) if (!(await fill(page, scope, o))) missing.push(o.name);
      if (missing.length) {
        const s = shot ? await shot().catch(() => null) : null;
        rec.add(check(id, 'functional', title, 'warn', { severity: 'major', detail: `We couldn't find ${missing.map((n) => `“${n}”`).join(' and ')} on the product page, so these options weren't checked. The option may be renamed, or your options app shows it differently.`, evidence: s ? { screenshot: s } : null, fix: 'Open the product page and check the option names. Then update them in Test suite → Price rules → Product options to match the labels shoppers see.' }));
        await clear(page);
        continue;
      }
      await page.waitForTimeout(700);
      const shown = await pagePrice(page, expected);

      // 3. Add to cart and read what the cart carries.
      const btn = await atcButton(page);
      if (btn) await btn.click({ timeout: 6000 }).catch(() => {});
      const c = await waitCart(page);
      if (!c || !(c.item_count > 0)) {
        const s = shot ? await shot().catch(() => null) : null;
        rec.add(check(id, 'functional', title, 'fail', { severity: 'critical', detail: `With ${optionsSay(cfg.options)} filled in, Add to cart did nothing. Customers who choose these options can't buy.`, evidence: s ? { screenshot: s } : null, fix: 'Try the product page with these options yourself. Check the options app (or theme code) that handles them, and any required field it may be waiting for.' }));
        continue;
      }
      const line = (c.items || []).find((x) => String(x.variant_id ?? x.id) === String(v.id));
      const lost = line ? cfg.options.filter((o) => !NO.test(o.value) && !hasChoice(line.properties, o)) : cfg.options;
      if (!line) problems.push({ severity: 'critical', text: 'the product itself did not reach the cart' });
      else if (lost.length) problems.push({ severity: 'critical', text: `the cart lost the customer's choice${lost.length === 1 ? '' : 's'} for ${lost.map((o) => `“${o.name}”`).join(' and ')}, so the order won't say what to make` });
      const addOns = (c.items || []).filter((x) => x !== line).map((x) => `${x.title || x.product_title} ${money(x.final_line_price ?? x.line_price, c.currency)}`);
      const total = Number(c.items_subtotal_price ?? c.total_price);
      const cur = c.currency;
      if (total > expected + 1) problems.push({ severity: 'critical', text: `the cart comes to ${money(total, cur)}, more than the ${money(expected, cur)} you expect` });
      else if (total < expected - 1) problems.push({ severity: 'major', text: `the cart comes to only ${money(total, cur)}, less than the ${money(expected, cur)} you expect${total <= base + 1 && expected > base ? ' (the upcharge was not added)' : ''}` });
      if (shown.trusted && Math.abs(shown.minor - expected) > (shown.exact ? 1 : 100) && Math.abs(shown.minor - total) > (shown.exact ? 1 : 100)) {
        problems.push({ severity: 'major', text: `the product page shows ${money(shown.minor, cur)} with these options, but the cart asks for ${money(total, cur)}` });
      }

      // The product page with the options filled, as the shopper saw it, when something is already wrong.
      const pdpShot = problems.length && shot ? await shot().catch(() => null) : null;
      // 4. Checkout subtotal at the same cart.
      let co = null;
      await page.goto(origin + '/checkout', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1200);
      if (/\/checkouts?\//.test(page.url())) co = await checkoutSubtotal(page);
      if (co && co.minor > total + 1) problems.push({ severity: 'critical', text: `checkout asks for ${money(co.minor, cur)}, more than the cart's ${money(total, cur)}` });

      const steps = [
        { label: 'You expect', minor: expected, note: optionsSay(cfg.options) },
        { label: 'Product page', minor: shown.trusted ? shown.minor : null, note: shown.trusted ? '' : 'Price not readable' },
        { label: 'Cart', minor: total, note: [line && lost.length === 0 ? 'Choices saved on the order line' : line ? 'Choices missing' : '', addOns.length ? `Add-ons: ${addOns.join(', ')}` : ''].filter(Boolean).join(' · ') },
        co ? { label: 'Checkout subtotal', minor: co.minor, note: '' } : null,
      ].filter(Boolean).map((s) => ({ ...s, money: s.minor == null ? null : money(s.minor, cur) }));
      const evidence = { priceTrail: { currency: cur, steps }, choices: line?.properties || null };
      if (problems.length) {
        const critical = problems.some((x) => x.severity === 'critical');
        const s = pdpShot || (shot ? await shot().catch(() => null) : null);
        rec.add(check(id, 'functional', title, critical ? 'fail' : 'warn', {
          severity: critical ? 'critical' : 'major',
          detail: `With ${optionsSay(cfg.options)}: ${problems.map((x) => x.text).join('; ')}.`,
          evidence: { ...evidence, screenshot: s },
          fix: 'Check the options app (or theme code) for this product: that each option is saved to the order, that its upcharge is the right amount, and that required options are marked required. If the price changed on purpose, update it in Test suite → Price rules.',
        }));
      } else {
        rec.add(check(id, 'functional', title, 'pass', { severity: 'critical', detail: `With ${optionsSay(cfg.options)}, the cart keeps every choice and comes to ${money(total, cur)}, as you expect.${addOns.length ? ` Add-ons in the cart: ${addOns.join(', ')}.` : ''}${notes.length ? ` ${notes.join('. ')}.` : ''}${co ? ` Checkout shows the same ${money(co.minor, cur)}.` : ''}`, evidence }));
      }
    } catch (e) {
      rec.add(check(id, 'functional', title, 'skip', { severity: 'major', detail: shortErr(e) }));
    } finally {
      await page.goto(origin + '/cart', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await clear(page);
    }
  }
}
