/**
 * Free shipping, the way a shopper meets it: a real cart just above the free-shipping amount (and one just
 * below), checkout opened, a sample address entered, and the shipping step read. Nothing is bought: we stop
 * at the shipping step, before contact details are submitted for an order or any payment, and empty the cart.
 * Works on Shopify checkout (one-page and the older multi-step one) and on checkouts with the same common
 * address fields; when the shipping step can't be reached we say so instead of guessing.
 */
import { MARKET_COUNTRY } from './discount.js';

// A sample address per country: a real-looking public place, so shipping rates can be worked out.
export const SAMPLE_ADDRESS = {
  IN: { city: 'Bengaluru', zone: 'KA', zip: '560001', address1: '1 MG Road' },
  US: { city: 'New York', zone: 'NY', zip: '10001', address1: '350 5th Ave' },
  GB: { city: 'London', zone: '', zip: 'SW1A 1AA', address1: '10 Downing Street' },
  DE: { city: 'Berlin', zone: '', zip: '10117', address1: 'Unter den Linden 1' },
  AT: { city: 'Wien', zone: '', zip: '1010', address1: 'Stephansplatz 1' },
  FR: { city: 'Paris', zone: '', zip: '75001', address1: '1 Rue de Rivoli' },
  SG: { city: 'Singapore', zone: '', zip: '018956', address1: '10 Bayfront Ave' },
  AU: { city: 'Sydney', zone: 'NSW', zip: '2000', address1: '1 Macquarie St' },
  CA: { city: 'Toronto', zone: 'ON', zip: 'M5V 2T6', address1: '290 Bremner Blvd' },
  AE: { city: 'Dubai', zone: 'DU', zip: '00000', address1: '1 Sheikh Mohammed bin Rashid Blvd' },
};
/** A shipping option that costs nothing: says free, or shows a price of 0. */
export const isFree = (t) => /\bfree\b|gratis|kostenlos|kostenfrei|gratuit/i.test(t) || /(^|\s)[^\d\s]{0,3}\s?0(?:[.,]00)?(?=\s|$)/.test(t);

async function api(page, path, body) {
  return page.evaluate(async ([path, body]) => {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) } : { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    let j = null;
    try { j = await r.json(); } catch {}
    return { status: r.status, json: j };
  }, [path, body]).catch(() => ({ status: 0, json: null }));
}

/**
 * How many of which in-stock variant make a cart just above `amount` (and just below it).
 * `products`: products.json entries. Prices are in the store's own currency.
 */
export function cartsFor(products, amount) {
  const vs = [];
  for (const p of products) for (const v of p.variants || []) if (v.available !== false && Number(v.price) > 0) vs.push({ id: v.id, price: Number(v.price), title: p.title });
  if (!vs.length || !(amount > 0)) return null;
  vs.sort((a, b) => a.price - b.price);
  // The cheapest item that reaches the amount in at most 50 pieces, so the cart stays close to the amount.
  const v = vs.find((x) => Math.ceil(amount / x.price) <= 50) || vs[vs.length - 1];
  const above = Math.max(1, Math.ceil(amount / v.price));
  if (above > 50) return null; // even 50 of the dearest item don't reach it: not a cart a shopper makes
  const below = above - 1;
  return { variant: v, above: { quantity: above, total: Math.round(above * v.price * 100) / 100 }, below: below > 0 ? { quantity: below, total: Math.round(below * v.price * 100) / 100 } : null };
}

async function fill(page, selectors, value) {
  for (const s of selectors) {
    const el = page.locator(s).first();
    if (await el.count().catch(() => 0)) {
      try {
        const tag = await el.evaluate((n) => n.tagName);
        if (tag === 'SELECT') await el.selectOption(value).catch(async () => { await el.selectOption({ label: value }).catch(() => {}); });
        else await el.fill(value);
        return true;
      } catch { /* try the next one */ }
    }
  }
  return false;
}

/** Opens checkout with the current cart, enters the address, and reads the shipping options. */
async function shippingStep(page, origin, country) {
  await page.goto(`${origin}/checkout`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!/\/checkouts?\b|checkout\.shopify\.com|shop\.app\/checkout/.test(page.url())) return { reached: false, why: 'Checkout didn’t open.' };
  const a = SAMPLE_ADDRESS[country] || SAMPLE_ADDRESS.US;
  await fill(page, ['input[name="email"]', 'input[type="email"]', '#email', 'input[name="checkout[email]"]'], 'sale-check@example.com');
  await fill(page, ['select[name="countryCode"]', 'select[autocomplete="shipping country"]', 'select[name="checkout[shipping_address][country]"]'], country);
  await page.waitForTimeout(400);
  await fill(page, ['input[name="firstName"]', 'input[autocomplete="shipping given-name"]', 'input[name="checkout[shipping_address][first_name]"]'], 'Sale');
  await fill(page, ['input[name="lastName"]', 'input[autocomplete="shipping family-name"]', 'input[name="checkout[shipping_address][last_name]"]'], 'Check');
  await fill(page, ['input[name="address1"]', 'input[autocomplete="shipping address-line1"]', 'input[name="checkout[shipping_address][address1]"]'], a.address1);
  await fill(page, ['input[name="city"]', 'input[autocomplete="shipping address-level2"]', 'input[name="checkout[shipping_address][city]"]'], a.city);
  if (a.zone) await fill(page, ['select[name="zone"]', 'select[autocomplete="shipping address-level1"]', 'select[name="checkout[shipping_address][province]"]'], a.zone);
  const zipOk = await fill(page, ['input[name="postalCode"]', 'input[autocomplete="shipping postal-code"]', 'input[name="checkout[shipping_address][zip]"]'], a.zip);
  if (!zipOk) return { reached: false, why: 'We couldn’t find the address fields at checkout.' };
  await page.locator('input[name="postalCode"], input[autocomplete="shipping postal-code"], input[name="checkout[shipping_address][zip]"]').first().press('Tab').catch(() => {});
  // The older checkout has a separate shipping step.
  const cont = page.getByRole('button', { name: /continue to shipping/i }).first();
  if (await cont.count().catch(() => 0)) await cont.click({ timeout: 5000 }).catch(() => {});
  // Shipping options: radio buttons named for shipping, or a block under a "Shipping method" heading.
  const rates = await page.waitForFunction(() => {
    const out = [];
    for (const r of document.querySelectorAll('input[type=radio]')) {
      const name = `${r.name} ${r.id}`.toLowerCase();
      if (!/shipping|delivery/.test(name)) continue;
      const box = r.closest('label, [role=row], li, div');
      const t = (box?.innerText || '').replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
    return out.length ? out : null;
  }, null, { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => null);
  if (!rates?.length) return { reached: false, why: 'The shipping options didn’t appear after entering an address.' };
  return { reached: true, rates, free: rates.some(isFree) };
}

/**
 * Checks free shipping in each market: a cart just above the amount should get free shipping at checkout,
 * one just below shouldn't. `products`: products.json entries; `amount` in the store's currency.
 * Returns { carts, markets: [{ market, country, above: {reached, free, rates, why}, below }] } or null when
 * no cart can be made.
 */
export async function freeShippingByMarket({ page, origin, products, amount, markets }) {
  const plan = cartsFor(products, amount);
  if (!plan) return null;
  const out = { carts: { item: plan.variant.title, price: plan.variant.price, above: plan.above, below: plan.below }, markets: [] };
  const fillCart = async (quantity) => {
    await api(page, '/cart/clear.js', {});
    const r = await api(page, '/cart/add.js', { items: [{ id: plan.variant.id, quantity }] });
    return r.status > 0 && r.status < 400;
  };
  for (const market of markets.slice(0, 3)) {
    const country = MARKET_COUNTRY[market] || market;
    const row = { market, country, above: null, below: null };
    out.markets.push(row);
    for (const side of ['above', 'below']) {
      if (!plan[side]) continue;
      try {
        await page.goto(origin + '/cart', { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (!(await fillCart(plan[side].quantity))) { row[side] = { reached: false, why: `“${plan.variant.title}” couldn’t be added to the cart.` }; continue; }
        row[side] = await shippingStep(page, origin, country);
      } catch (e) {
        row[side] = { reached: false, why: 'Checkout didn’t answer in time.' };
      } finally {
        await page.goto(origin + '/cart', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await api(page, '/cart/clear.js', {});
      }
    }
  }
  return out;
}
