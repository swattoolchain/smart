import { check, plural } from './checks.js';
import { formatMoney } from './products.js';

/**
 * Security watch S6: store data tampering. Someone with access to the admin (a stolen password, a rogue app or
 * staff account) can quietly make products free, cut every price, swap a product for another, or create a big
 * discount code for themselves. We compare each full check's catalog (and the store's active Shopify discount
 * codes) with the previous one and show what changed, before and after.
 */

const words = (t) => new Set(String(t || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
function similar(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return a === b ? 1 : 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}

/** Codes worth a closer look: half off or more, or free. */
export const BIG_CODE = 50;

/**
 * Finds signs of tampering between two catalog snapshots.
 * snap/prev: catalog snapshots (see products.js fetchCatalog), each optionally with `codes` (active Shopify
 * discount codes, or null when they could not be read).
 */
export function findTampering(snap, prev) {
  if (!prev) return null;
  const m = (n) => formatMoney(n, snap.currency);
  const found = [];
  const P = new Map(prev.products.map((p) => [p.id, p]));
  const prevTitle = new Map(prev.products.map((p) => [p.title, p.id]));
  let compared = 0;
  const priceChanges = [];
  for (const p of snap.products) {
    const o = P.get(p.id);
    if (!o) continue;
    compared++;
    let changed = false;
    for (const v of p.variants) {
      const ov = o.variants.find((x) => x.id === v.id);
      if (!ov || ov.price === v.price) continue;
      changed = true;
      priceChanges.push({ title: p.title, variant: v.title, before: ov.price, after: v.price });
      const label = p.variants.length > 1 ? ` (${v.title})` : '';
      if (ov.price > 0 && (v.price === 0 || v.price == null))
        found.push({ kind: 'free', severity: 'fail', handle: p.handle, title: p.title, before: m(ov.price), after: m(0), message: `“${p.title}”${label} became free: ${m(ov.price)} → ${m(0)}.` });
    }
    if (changed) p._priceChanged = true;
    // A product that kept its address but is now something else entirely.
    const otherId = prevTitle.get(p.title);
    if (otherId != null && otherId !== p.id && o.title !== p.title) {
      found.push({ kind: 'swap', severity: 'fail', handle: p.handle, title: p.title, before: o.title, after: p.title, message: `“${o.title}” now shows “${p.title}” (its title was taken from another product).` });
    } else if (o.title !== p.title && similar(o.title, p.title) < 0.34 && (o.textHash !== p.textHash || o.images !== p.images)) {
      found.push({ kind: 'swap', severity: 'fail', handle: p.handle, title: p.title, before: o.title, after: p.title, message: `“${o.title}” was replaced by a different product, “${p.title}”, at the same address (/products/${p.handle}).` });
    }
  }
  // Mass edits: many prices changed in one go.
  const changedProducts = snap.products.filter((p) => p._priceChanged).length;
  for (const p of snap.products) delete p._priceChanged;
  // Small catalogs: most of the products changing together counts too.
  const mass = changedProducts >= Math.max(3, Math.ceil(compared * 0.3)) || (compared < 10 && changedProducts >= 2 && changedProducts >= compared * 0.6);
  if (compared && mass) {
    const drops = priceChanges.filter((c) => c.before > 0 && c.after != null && (c.before - c.after) / c.before >= 0.5);
    const deep = drops.length >= priceChanges.length / 2;
    found.push({
      kind: 'mass', severity: deep ? 'fail' : 'warn', count: changedProducts,
      before: priceChanges.slice(0, 3).map((c) => m(c.before)).join(', '), after: priceChanges.slice(0, 3).map((c) => m(c.after)).join(', '),
      message: `${plural(changedProducts, 'product')} of ${compared} had their price changed at once${deep ? `, most cut by half or more` : ''}. For example ${priceChanges.slice(0, 3).map((c) => `“${c.title}” ${m(c.before)} → ${m(c.after)}`).join('; ')}.`,
    });
  }
  // New discount codes since the last check.
  if (Array.isArray(snap.codes) && Array.isArray(prev.codes)) {
    const seen = new Set(prev.codes.map((c) => String(c.code).toUpperCase()));
    for (const c of snap.codes) {
      if (seen.has(String(c.code).toUpperCase())) continue;
      const big = c.percent != null && c.percent >= BIG_CODE;
      found.push({ kind: 'code', severity: big ? 'fail' : 'warn', code: c.code, before: 'none', after: c.percent != null ? `${c.percent}% off` : 'new code',
        message: big ? `New discount code “${c.code}” gives ${c.percent}% off.` : `New discount code “${c.code}”${c.percent != null ? ` (${c.percent}% off)` : ''}.` });
    }
  }
  return { found, compared };
}

/** Adds the `sec.tamper` check from findTampering's result. */
export function tamperCheck({ rec, result }) {
  // A notice: news once, at the check that saw the change. The next check passing is not a "fix".
  const add = (status, opts) => rec.add({ ...check('sec.tamper', 'security', 'No unexpected changes to products, prices or discount codes', status, { severity: 'major', ...opts }), notice: true });
  if (!result) {
    add('pass', { detail: 'Saved today\'s products, prices and discount codes. From the next full check we compare against them.', evidence: { tamper: [] } });
    return;
  }
  const { found } = result;
  const fails = found.filter((f) => f.severity === 'fail');
  if (!found.length) {
    add('pass', { detail: 'No products made free, no mass price changes, no swapped products and no new big discount codes since the last check.', evidence: { tamper: [] } });
    return;
  }
  const list = [...fails, ...found.filter((f) => f.severity !== 'fail')];
  add(fails.length ? 'fail' : 'warn', {
    detail: `Since the last check: ${list.slice(0, 4).map((f) => f.message).join(' ')}${list.length > 4 ? ` And ${plural(list.length - 4, 'more change')}.` : ''} If you or your team didn't do this, someone else may have access to your store.`,
    evidence: { tamper: list.slice(0, 50) },
    fix: 'If these changes were yours, nothing to do. If not: in Shopify, change your password, turn on two-step login, check Settings → Users and permissions and remove anyone or any app you don\'t recognise, then put the prices back and turn off unknown discount codes under Discounts.',
  });
}
