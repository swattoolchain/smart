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

export async function runDiscounts({ page, rec, origin, info, password, codes, shot }) {
  if (!codes?.length) return;
  if (!info.isShopify) {
    for (const c of codes) rec.add(check(codeId(c.code), 'trust', `Discount code ${c.code} works`, 'skip', { severity: 'major', detail: 'Discount codes are checked on Shopify stores for now.' }));
    return;
  }
  // A product that's in stock, so the cart can be filled.
  let variant = null;
  for (const p of info.products.slice(0, 6)) {
    const r = await page.request.get(`${origin}/products/${p.handle}.js`, { timeout: 15000 }).catch(() => null);
    const j = r && r.ok() ? await r.json().catch(() => null) : null;
    const v = j?.variants?.find((x) => x.available);
    if (v) { variant = { id: v.id, title: j.title }; break; }
  }
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
      await api(page, '/cart/clear.js', {});
      const added = await api(page, '/cart/add.js', { items: [{ id: variant.id, quantity: 1 }] });
      if (added.status >= 400) throw new Error(`Could not add “${variant.title}” to the cart (status ${added.status}).`);
      // Shopify's cart takes a discount code directly; older themes use the /discount/CODE link. Try both.
      let cart = (await api(page, '/cart/update.js', { discount: c.code })).json;
      if (!discountOf(cart)) {
        await page.goto(`${origin}/discount/${encodeURIComponent(c.code)}?redirect=/cart`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        cart = (await api(page, '/cart.js')).json;
      }
      // A code with a minimum order won't apply to one item. Try a bigger cart before calling it broken.
      let bigger = false;
      if (!discountOf(cart)) {
        await api(page, '/cart/add.js', { items: [{ id: variant.id, quantity: 9 }] });
        const again = (await api(page, '/cart/update.js', { discount: c.code })).json;
        if (again) cart = again; // the bigger cart, applied or not, so amounts below are right
        if (discountOf(again)) bigger = true;
      }
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
