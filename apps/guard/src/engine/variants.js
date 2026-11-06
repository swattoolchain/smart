/**
 * Every-variant sweep: on a full check, each variant the store offers for sale is added to a cart once
 * through Shopify's cart API, then the cart is emptied again. Nothing is bought.
 *
 * What it finds:
 *   - broken: the store shows the variant as in stock, but the cart refuses it (or it never lands in the cart)
 *   - unpublished: the cart can't find the variant at all (product hidden from the online store, deleted variant)
 * Sold-out variants are not tried: refusing them is correct.
 *
 * Capped per check (VARIANT_SWEEP_MAX, default 100) and paced, so big catalogs are covered over several checks:
 * each check starts where the previous one left off.
 */
import { check, shortErr, plural } from './checks.js';
import { fetchCatalog } from './products.js';

export const SWEEP_MAX = Math.max(1, Number(process.env.VARIANT_SWEEP_MAX || 100));
const PAUSE_MS = Number(process.env.VARIANT_SWEEP_PAUSE_MS ?? 250);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nameOf = (p, v) => (!v.title || v.title === 'Default Title' ? p.title : `${p.title} – ${v.title}`);

/** Which variants this check tries: available ones, starting at `offset`, at most `max`. */
export function pickVariants(products, { max = SWEEP_MAX, offset = 0 } = {}) {
  const all = [];
  let soldOut = 0;
  for (const p of products || []) for (const v of p.variants || []) {
    if (v.available === false) { soldOut++; continue; }
    all.push({ product: p.title, handle: p.handle, variant: v.title, id: v.id, name: nameOf(p, v), price: v.price });
  }
  const start = all.length ? ((offset % all.length) + all.length) % all.length : 0;
  const picked = all.length <= max ? all : [...all.slice(start), ...all.slice(0, start)].slice(0, max);
  return { picked, total: all.length, soldOut, start, next: all.length ? (start + picked.length) % all.length : 0 };
}

/** What the cart said, in words a store owner understands. */
function classify(status, body) {
  const msg = String(body?.description || body?.message || '').trim();
  if (status === 404 || /cannot find|not found|no longer available|not available on/i.test(msg)) return { problem: 'unpublished', message: msg || 'The cart could not find this variant.' };
  if (status >= 500) return { problem: 'error', message: `The store answered with an error (${status}).` };
  return { problem: 'broken', message: msg || `The cart refused it (${status}).` };
}

async function clearCart(request, origin) {
  await request.post(`${origin}/cart/clear.js`, { timeout: 15000 }).catch(() => null);
}

/** Adds one variant to the cart and reports what happened. */
async function tryVariant(request, origin, item) {
  let res;
  try {
    res = await request.post(`${origin}/cart/add.js`, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      data: JSON.stringify({ items: [{ id: Number(item.id), quantity: 1 }] }),
      timeout: 20000,
      maxRedirects: 0,
    });
  } catch (e) {
    return { problem: 'error', message: `No answer from the store: ${shortErr(e)}` };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok()) return classify(res.status(), body);
  const items = Array.isArray(body?.items) ? body.items : body?.id ? [body] : [];
  const landed = items.some((i) => Number(i.variant_id ?? i.id) === Number(item.id));
  if (!landed) return { problem: 'broken', message: 'The store said yes, but the item did not appear in the cart.' };
  return null;
}

/**
 * Runs the sweep and adds one check, `fn.variants`.
 * `products`: the normalized catalog (from the catalog check); fetched here if not given.
 * `offset`: where to start in a capped catalog (the previous check's `next`).
 */
export async function runVariantSweep({ request, origin, rec, products = null, offset = 0, max = SWEEP_MAX }) {
  const title = 'Every variant can be added to the cart';
  try {
    if (!products) products = (await fetchCatalog(request, origin)).products;
    const { picked, total, soldOut, start, next } = pickVariants(products, { max, offset });
    if (!picked.length) {
      rec.add(check('fn.variants', 'functional', title, 'skip', { severity: 'minor', detail: soldOut ? `All ${plural(soldOut, 'variant')} are sold out, so there was nothing to add.` : 'No products for sale were found.' }));
      return { tried: 0, total, soldOut, next: 0, problems: [] };
    }
    rec.step(`Adding ${plural(picked.length, 'variant')} to the cart one by one`);
    await clearCart(request, origin);
    const problems = [];
    let errors = 0;
    for (const [i, item] of picked.entries()) {
      const r = await tryVariant(request, origin, item);
      if (r?.problem === 'error') errors++;
      if (r) problems.push({ ...item, ...r });
      await clearCart(request, origin);
      if (PAUSE_MS && i < picked.length - 1) await sleep(PAUSE_MS); // be gentle with the store
    }
    const broken = problems.filter((p) => p.problem === 'broken');
    const unpublished = problems.filter((p) => p.problem === 'unpublished');
    const scope = total > picked.length ? `${picked.length} of ${total} variants for sale (the rest are checked in the next full checks)` : `all ${plural(picked.length, 'variant')} for sale`;
    const names = (list) => list.slice(0, 4).map((p) => `“${p.name}”`).join(', ') + (list.length > 4 ? ` and ${list.length - 4} more` : '');
    const parts = [];
    if (broken.length) parts.push(`Customers can't add ${names(broken)} to the cart, although the store shows ${broken.length === 1 ? 'it' : 'them'} as in stock.`);
    if (unpublished.length) parts.push(`${names(unpublished)} ${unpublished.length === 1 ? 'is' : 'are'} listed in your store but the cart can't find ${unpublished.length === 1 ? 'it' : 'them'}: usually a product not available on the Online Store sales channel, or a deleted variant.`);
    const onlyErrors = errors && errors === problems.length;
    let status = 'pass';
    if (broken.length) status = 'fail';
    else if (unpublished.length) status = 'warn';
    else if (onlyErrors && errors === picked.length) status = 'skip';
    else if (onlyErrors) status = 'warn';
    const detail = status === 'pass'
      ? `Tried ${scope}: each one went into the cart. The cart was emptied after each try.${soldOut ? ` ${plural(soldOut, 'sold-out variant')} skipped.` : ''}`
      : status === 'skip'
        ? `The store did not answer while we added variants to the cart (${plural(errors, 'try', 'tries')}). We will try again in the next full check.`
        : `${parts.join(' ')}${onlyErrors ? `The store did not answer for ${plural(errors, 'variant')} (${names(problems)}); we will try again in the next full check.` : ''} Checked ${scope}.`;
    const fix = [
      broken.length && 'Open each product in Shopify admin → Products and check the variant: inventory, “Continue selling when out of stock”, and any app that limits what can be bought (pre-order, B2B, bundle or quantity apps). Then try adding it to the cart yourself.',
      unpublished.length && `${broken.length ? 'For variants the cart can\'t find: in' : 'In'} Shopify admin → Products, open the product and make sure it is available on the Online Store sales channel. If the variant was removed, update links and ads that still point to it.`,
    ].filter(Boolean).join(' ');
    rec.add(check('fn.variants', 'functional', title, status, {
      severity: 'major',
      detail: detail.trim(),
      fix,
      evidence: problems.length ? { variants: problems.slice(0, 50).map(({ product, variant, handle, id, name, problem, message }) => ({ product, variant, handle, id, name, problem, message })) } : null,
    }));
    return { tried: picked.length, total, soldOut, start, next, problems: problems.slice(0, 200) };
  } catch (e) {
    rec.add(check('fn.variants', 'functional', title, 'skip', { severity: 'minor', detail: `The variant check could not run: ${shortErr(e)}` }));
    return null;
  } finally {
    await clearCart(request, origin);
  }
}
