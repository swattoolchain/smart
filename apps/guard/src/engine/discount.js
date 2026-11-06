/**
 * Discount codes: each of the store's sale codes is applied to a real cart, the way a shopper would,
 * and we check the price really drops (by the amount the owner expects, if they told us).
 * Nothing is bought: the cart is emptied afterwards.
 */
import { check, shortErr } from './checks.js';

const money = (minor, cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur || 'USD', maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100); } catch { return (minor / 100).toFixed(2); } };
export const codeId = (code) => `fn.discount.${String(code).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;

async function api(page, path, body) {
  return page.evaluate(async ([path, body]) => {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) } : { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    let j = null;
    try { j = await r.json(); } catch {}
    return { status: r.status, json: j };
  }, [path, body]).catch((e) => ({ status: 0, error: String(e) }));
}

/** How much the cart is reduced by, from Shopify's cart: cart-level and line-level discounts. */
function discountOf(cart) {
  if (!cart) return 0;
  if (Number(cart.total_discount) > 0) return Number(cart.total_discount);
  const lines = (cart.items || []).reduce((s, i) => s + (i.line_level_discount_allocations || []).reduce((a, d) => a + Number(d.amount || 0), 0), 0);
  const level = (cart.cart_level_discount_applications || []).reduce((s, d) => s + Number(d.total_allocated_amount || 0), 0);
  return lines + level;
}

/**
 * Puts one item in a fresh cart and applies a code, the way a shopper would. A code with a minimum order
 * won't apply to one item, so a bigger cart (10 items) is tried before calling it broken.
 * Returns { cart, bigger }. The caller clears the cart afterwards.
 */
async function applyCode(page, origin, variant, code) {
  await api(page, '/cart/clear.js', {});
  const added = await api(page, '/cart/add.js', { items: [{ id: variant.id, quantity: 1 }] });
  if (added.status >= 400) throw new Error(`Could not add “${variant.title}” to the cart (status ${added.status}).`);
  // Shopify's cart takes a discount code directly; older themes use the /discount/CODE link. Try both.
  let cart = (await api(page, '/cart/update.js', { discount: code })).json;
  if (!discountOf(cart)) {
    await page.goto(`${origin}/discount/${encodeURIComponent(code)}?redirect=/cart`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    cart = (await api(page, '/cart.js')).json;
  }
  let bigger = false;
  if (!discountOf(cart)) {
    await api(page, '/cart/add.js', { items: [{ id: variant.id, quantity: 9 }] });
    const again = (await api(page, '/cart/update.js', { discount: code })).json;
    if (again) cart = again; // the bigger cart, applied or not, so amounts below are right
    if (discountOf(again)) bigger = true;
  }
  return { cart, bigger };
}
const totals = (cart) => {
  const off = discountOf(cart);
  const before = Number(cart?.original_total_price ?? cart?.items_subtotal_price ?? 0) || (cart?.total_price || 0) + off;
  return { off, before, cur: cart?.currency || null, pct: before && off ? Math.round((off / before) * 1000) / 10 : null };
};
/** A product that's in stock, so the cart can be filled. */
async function inStockVariant(page, origin, products) {
  for (const p of products.slice(0, 6)) {
    const r = await page.request.get(`${origin}/products/${p.handle}.js`, { timeout: 15000 }).catch(() => null);
    const j = r && r.ok() ? await r.json().catch(() => null) : null;
    const v = j?.variants?.find((x) => x.available);
    if (v) return { id: v.id, title: j.title };
  }
  return null;
}

// ---------- codes in each market ----------
/** The country a shopper picks for each Tharam market. Other EU countries: France stands for them. */
export const MARKET_COUNTRY = { US: 'US', DE: 'DE', AT: 'AT', EU: 'FR', UK: 'GB', IN: 'IN', SG: 'SG', AU: 'AU', CA: 'CA', AE: 'AE' };
/**
 * Switches the storefront to a country the way a shopper does with the country picker (Shopify's
 * localization form; Shopify Markets then sets the currency). Returns { ok, country, currency }.
 */
export async function switchCountry(page, origin, country) {
  const status = await page.evaluate(async (cc) => {
    const body = new URLSearchParams({ form_type: 'localization', utf8: '✓', _method: 'put', country_code: cc, return_to: '/' });
    const r = await fetch('/localization', { method: 'POST', body, credentials: 'same-origin', redirect: 'follow' });
    return r.status;
  }, country).catch(() => 0);
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  const now = await page.evaluate(() => ({ country: window.Shopify?.country || null, currency: window.Shopify?.currency?.active || null })).catch(() => ({}));
  const cart = (await api(page, '/cart.js')).json;
  const currency = cart?.currency || now.currency || null;
  // The theme says which country is shown; when it doesn't, a successful form post is taken as the switch.
  const ok = now.country ? now.country === country : status > 0 && status < 400;
  return { ok, country: now.country || (ok ? country : null), currency };
}

/**
 * Tries each code in each market: switch country, fill a cart, apply the code, read the % off in that
 * market's currency. `markets`: Tharam market codes. Nothing is bought; the cart is emptied after each code.
 * Returns [{ market, country, ok, currency, codes: [{ code, status: pass|warn|fail|skip, pct, off, before, detail }] }].
 */
export async function codesByMarket({ page, origin, products, codes, markets }) {
  const out = [];
  if (!/^https?:/.test(page.url()) || !page.url().startsWith(origin)) await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  const variant = await inStockVariant(page, origin, products);
  for (const market of markets.slice(0, 5)) {
    const country = MARKET_COUNTRY[market] || market;
    const row = { market, country, ok: false, currency: null, codes: [] };
    out.push(row);
    try {
      const sw = await switchCountry(page, origin, country);
      row.ok = sw.ok; row.currency = sw.ok ? sw.currency : null;
      if (!sw.ok) continue;
      for (const c of codes.slice(0, 5)) {
        if (!variant) { row.codes.push({ code: c.code, status: 'skip', detail: 'No product in stock to put in the cart.' }); continue; }
        try {
          const { cart, bigger } = await applyCode(page, origin, variant, c.code);
          const t = totals(cart);
          const expectOk = !c.percent || (t.pct != null && Math.abs(t.pct - c.percent) <= 1);
          const status = !t.off ? 'fail' : !expectOk ? 'fail' : bigger ? 'warn' : 'pass';
          const detail = t.off
            ? `${c.code} took ${money(t.off, t.cur)} off a cart of ${money(t.before, t.cur)} (${t.pct}%).${bigger ? ' It needed 10 items.' : ''}${expectOk ? '' : ` Your plan says ${c.percent}%.`}`
            : `${c.code} didn’t reduce the price of a cart in ${t.cur || 'this currency'}.`;
          row.codes.push({ code: c.code, status, pct: t.pct, off: t.off, before: t.before, currency: t.cur, detail });
        } catch (e) {
          row.codes.push({ code: c.code, status: 'skip', detail: shortErr(e) });
        } finally {
          await api(page, '/cart/update.js', { discount: '' });
          await api(page, '/cart/clear.js', {});
        }
      }
    } catch (e) {
      row.error = shortErr(e);
    }
  }
  return out;
}

export async function runDiscounts({ page, rec, origin, info, password, codes, shot }) {
  if (!codes?.length) return;
  if (!info.isShopify) {
    for (const c of codes) rec.add(check(codeId(c.code), 'trust', `Discount code ${c.code} works`, 'skip', { severity: 'major', detail: 'Discount codes are checked on Shopify stores for now.' }));
    return;
  }
  const variant = await inStockVariant(page, origin, info.products);
  if (!variant) {
    for (const c of codes) rec.add(check(codeId(c.code), 'trust', `Discount code ${c.code} works`, 'skip', { severity: 'major', detail: 'No product in stock to put in the cart.' }));
    return;
  }
  for (const c of codes.slice(0, 5)) {
    const id = codeId(c.code);
    const title = `Discount code ${c.code} works`;
    rec.step(`Apply discount code ${c.code}`);
    try {
      if (!/^https?:/.test(page.url()) || !page.url().startsWith(origin)) await page.goto(origin + '/cart', { waitUntil: 'domcontentloaded', timeout: 30000 });
      const { cart, bigger } = await applyCode(page, origin, variant, c.code);
      const before = Number(cart?.original_total_price ?? cart?.items_subtotal_price ?? 0) || (cart?.total_price || 0) + discountOf(cart);
      const off = discountOf(cart);
      const cur = cart?.currency;
      let status, detail, fix = '';
      if (off > 0) {
        const pct = before ? Math.round((off / before) * 1000) / 10 : null;
        const expectOk = !c.percent || (pct != null && Math.abs(pct - c.percent) <= 1);
        status = expectOk ? (bigger ? 'warn' : 'pass') : 'fail';
        detail = `${c.code} took ${money(off, cur)} off a cart of ${money(before, cur)}${pct != null ? ` (${pct}%)` : ''}.${bigger ? ' It didn’t apply to a single item, so it needs a minimum order or quantity.' : ''}${expectOk ? '' : ` You expected ${c.percent}% off.`}`;
        if (!expectOk) fix = 'Check the discount’s value in Shopify → Discounts. Another automatic discount may also be combining with it, or the wrong code was set up.';
        else if (bigger) fix = 'If that’s intended, mention the minimum in your sale emails so shoppers aren’t surprised at checkout.';
      } else {
        status = 'fail';
        detail = `${c.code} didn’t reduce the price, even on a cart of ${money(before, cur)} with 10 × “${variant.title}”. It may have expired, not started yet, reached its usage limit, be spelt differently, or only apply to other products or customers.`;
        fix = 'Check the code in Shopify → Discounts: its status, start and end dates, usage limits and which products it applies to.';
      }
      rec.add(check(id, 'trust', title, status, { severity: 'major', detail, fix, evidence: status === 'pass' ? null : { screenshot: await (async () => { await page.goto(origin + '/cart', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}); return shot(page, `discount-${id.slice(12)}`); })() } }));
    } catch (e) {
      rec.add(check(id, 'trust', title, 'skip', { severity: 'major', detail: shortErr(e) }));
    } finally {
      await api(page, '/cart/update.js', { discount: '' });
      await api(page, '/cart/clear.js', {});
    }
  }
}

/** Store setting: up to 5 codes, each with an optional expected percentage off. */
export function cleanCodes(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const x of input.slice(0, 5)) {
    const code = String(x?.code ?? x ?? '').trim();
    if (!code) continue;
    if (!/^[A-Za-z0-9_\-]{1,40}$/.test(code)) throw new Error(`“${code.slice(0, 40)}” isn’t a valid code. Use letters, numbers, dashes and underscores.`);
    const p = x?.percent === '' || x?.percent == null ? null : Number(x.percent);
    if (p != null && !(p > 0 && p < 100)) throw new Error(`Expected discount for ${code} must be between 1 and 99%.`);
    if (!out.some((o) => o.code.toUpperCase() === code.toUpperCase())) out.push({ code, percent: p });
  }
  return out;
}
