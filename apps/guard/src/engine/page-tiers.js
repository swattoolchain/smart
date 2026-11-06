/**
 * Quantity breaks shown on the product page (Pricing 2b). Many volume-discount apps draw a small table or list
 * near Add to cart ("Buy 5+ save 10%", "10+ ₹1,199 each"). Without the owner listing anything, we read what the
 * page promises for the test product and check the cart charges that at each quantity:
 * "your page says 10% off at 5, the cart gives 0%".
 *
 * We read the text shoppers see, not any one app's markup, so it works the same for any app that shows its
 * breaks as text near the product form (a table, a list or a row of boxes). Nothing is bought; the cart is emptied.
 */
import { check, shortErr } from './checks.js';
import { amountsIn, toMinor, money, compareTiers, cartAtQuantities, tiersText } from './pricing.js';

export const PAGE_TIERS_ID = 'fn.price.tiers-page';
const MAX_TIERS = 5;

const QTY = /(?:^|\b)(?:buy|from|order|get)?\s*(\d{1,3})\s*(?:\+|or more|and (?:up|above|more)|(?:-|–|to)\s*\d{1,3}|\s*(?:pcs|pieces|items?|units?|qty)\b)/i;
const PCT = /(\d{1,2}(?:\.\d{1,2})?)\s*%/;
const CURRENCY = /[₹$€£]|\brs\.?\b|\binr\b|\busd\b|\beur\b|\bgbp\b/i;

/**
 * Reads quantity breaks from lines of text taken near Add to cart. Returns [{ min, percent } | { min, price }]
 * sorted by quantity, or [] when the lines don't look like a break table.
 */
export function parseTierLines(lines) {
  const found = new Map();
  let hints = 0;
  for (const raw of lines || []) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 120) continue;
    const q = QTY.exec(t);
    if (!q) continue;
    const min = Number(q[1]);
    if (min < 2 || min > 99 || found.has(min)) continue;
    const rest = t.slice(0, q.index) + ' ' + t.slice(q.index + q[0].length);
    const p = PCT.exec(rest);
    if (/save|off|discount|each|per|\/\s*(?:ea|pc|item)/i.test(t)) hints++;
    if (p) {
      const percent = Number(p[1]);
      if (percent > 0 && percent < 100) found.set(min, { min, percent });
      continue;
    }
    // A price each: only with a currency mark or "each/per", so "Pack of 6" or a year is never read as a price.
    if (!CURRENCY.test(rest) && !/each|per|\/\s*(?:ea|pc|item)/i.test(rest)) continue;
    const a = amountsIn(rest.replace(/\d+\s*(?:pcs|items?|units?)/gi, '')).find((x) => x.minor > 0);
    if (a) found.set(min, { min, price: a.minor / 100 });
  }
  const tiers = [...found.values()].sort((a, b) => a.min - b.min).slice(0, MAX_TIERS);
  // One line alone is a break only when it says so ("save", "off", "each"); otherwise we need at least two.
  if (tiers.length >= 2 || (tiers.length === 1 && hints)) return tiers;
  return [];
}

/** The lines of text near the product form that could be a break table. */
export async function pageTierLines(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const form = document.querySelector('form[action*="/cart/add"]');
    // The product section: the form's ancestors, up to the one that holds the product's main content.
    let scope = form || document.querySelector('main') || document.body;
    for (let a = form?.parentElement, i = 0; a && i < 5; a = a.parentElement, i++) { scope = a; if (a.matches('main, [id*="MainContent"], section[class*="product"], [class*="product__info"], [class*="product-single"]')) break; }
    const out = [];
    const rows = [...scope.querySelectorAll('tr, li, [class*="tier"], [class*="break"], [class*="volume"], [class*="bulk"], [class*="quantity-discount"], [class*="qty-discount"], [class*="offer"], p, span, div')]
      .filter((el) => el.children.length <= 6 && vis(el));
    for (const el of rows) {
      if (out.length >= 30) break;
      // Prefer whole rows: skip a cell whose row we already read.
      if (el.closest('tr') && el.tagName !== 'TR') continue;
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 120 && /\d/.test(t) && !out.includes(t)) out.push(t);
    }
    return out;
  }).catch(() => []);
}

/**
 * The check: the test product's page, its quantity breaks (if it shows any), and the cart at each one.
 * Skipped when the owner already lists breaks for this product (Test suite → Price rules), or the page shows none.
 */
export async function runPageTiers({ page, rec, origin, product, listed = [] }) {
  if (!product || listed.includes(product)) return;
  const title = 'Quantity breaks on the product page';
  try {
    await page.goto(`${origin}/products/${encodeURIComponent(product)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(800); // volume-discount widgets often draw after the page loads
    const lines = await pageTierLines(page);
    const tiers = parseTierLines(lines);
    if (!tiers.length) return;
    rec.step(`Check the quantity breaks shown on the product page (${tiersText(tiers)})`);
    const p = await page.evaluate(async (h) => { const r = await fetch(`/products/${encodeURIComponent(h)}.js`, { headers: { Accept: 'application/json' } }); return r.ok ? r.json() : null; }, product).catch(() => null);
    const v = p?.variants?.find((x) => x.available);
    if (!v) return;
    const name = `${p.title}${v.title && v.title !== 'Default Title' ? ` (${v.title})` : ''}`;
    const base = toMinor(v.price, true);
    const { rows, checkout, currency: cur } = await cartAtQuantities({ page, origin, variantId: v.id, tiers });
    const r = compareTiers(tiers, base, rows);
    const m = (x) => money(x, cur);
    const said = tiers.map((t) => `${t.min}+ ${t.percent != null ? `${t.percent}% off` : `${m(Math.round(t.price * 100))} each`}`).join(', ');
    const tierTable = {
      currency: cur,
      source: 'page',
      rows: r.rows.map((x) => ({ qty: x.qty, expect: m(x.expect), expectEach: m(x.unit), charged: x.charged == null ? null : m(x.charged), chargedEach: x.charged == null ? null : m(Math.round(x.charged / x.qty)), state: x.state })),
      checkout: checkout && checkout.minor != null ? { qty: checkout.qty, money: m(checkout.minor), cart: checkout.cart == null ? null : m(checkout.cart), higher: checkout.cart != null && checkout.minor > checkout.cart + 1 } : null,
    };
    const evidence = { tierTable, pageTiers: { said, lines: lines.slice(0, 6) } };
    const say = (x) => `at ${x.qty} the page says ${m(x.unit)} each, the cart gives ${m(Math.round(x.charged / x.qty))} each`;
    const coBad = checkout && checkout.minor != null && checkout.cart != null && checkout.minor > checkout.cart + 1;
    const full = `${title}: ${name}`;
    if (coBad) {
      rec.add(check(PAGE_TIERS_ID, 'functional', full, 'fail', { severity: 'critical', detail: `At checkout, ${checkout.qty} come to ${m(checkout.minor)} while the cart showed ${m(checkout.cart)}. Customers buying more are charged more than the cart said.`, evidence, fix: 'Check checkout customisations and apps that change prices at checkout.' }));
    } else if (r.over.length || r.under.length) {
      const bad = [...r.over, ...r.under].sort((a, b) => a.qty - b.qty);
      rec.add(check(PAGE_TIERS_ID, 'functional', full, 'warn', { severity: 'major', detail: `Your product page says ${said}, but the cart doesn't match: ${bad.map(say).join('; ')}.${r.over.length ? ' Shoppers who buy more for the discount pay more than the page promised.' : ' The cart gives more off than the page says.'}`, evidence, fix: 'Check your volume or quantity discount app: is the discount itself still on (not just the table), and does it include this product and variant? If the page shows old breaks, update the app\'s table.' }));
    } else if (r.refused.length === r.rows.length) {
      rec.add(check(PAGE_TIERS_ID, 'functional', full, 'warn', { severity: 'minor', detail: `Your product page says ${said}, but the cart did not accept ${r.rows.map((x) => x.qty).join(', ')} of this product, so we could not check it. It may be low on stock or limited per order.`, evidence }));
    } else {
      rec.add(check(PAGE_TIERS_ID, 'functional', full, 'pass', { severity: 'major', detail: `Your product page says ${said}, and the cart charges that: ${r.rows.filter((x) => x.state === 'ok').map((x) => `${x.qty} at ${m(x.unit)} each`).join(', ')}.${checkout?.minor != null ? ` Checkout shows the same ${m(checkout.minor)} for ${checkout.qty}.` : ''}`, evidence }));
    }
  } catch (e) {
    rec.add(check(PAGE_TIERS_ID, 'functional', title, 'skip', { severity: 'minor', detail: shortErr(e) }));
  }
}
