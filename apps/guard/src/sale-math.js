/**
 * Sale plans: the pure parts (no database, no network), so they can be tested on their own.
 *   - time zones: the owner enters the sale's start and end in the store's local time
 *   - expected sale prices: which rule applies to a product, and the price it should end up at
 *   - Shopify discounts: does what's scheduled in Shopify match the plan
 *   - when the daily pre-check is due
 */

export const RULE_SCOPES = ['all', 'collection', 'product', 'tag'];
export const RULE_TYPES = ['percent', 'fixed', 'price'];
// The most specific rule wins: a product rule beats a tag rule beats a collection rule beats a whole-store rule.
const SPECIFIC = { product: 4, tag: 3, collection: 2, all: 1 };

// ---------- time zones ----------
export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
/** Minutes the zone is ahead of UTC at a moment. */
function offsetMin(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}
/** "2026-11-27T00:00" in "Asia/Kolkata" → the UTC moment (ms). Throws a readable error for bad input. */
export function zonedToUtc(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(local || '').trim());
  if (!m) throw new Error('Enter the date and time as YYYY-MM-DD HH:MM.');
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) throw new Error('That date or time does not exist.');
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(guess).getUTCDate() !== d) throw new Error('That date does not exist.');
  let utc = guess - offsetMin(guess, tz) * 60000;
  utc = guess - offsetMin(utc, tz) * 60000; // once more, for days the clocks change
  return utc;
}
/** The UTC moment shown as local "YYYY-MM-DDTHH:MM" in a zone. */
export function utcToZoned(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${String(+p.hour % 24).padStart(2, '0')}:${p.minute}`;
}

// ---------- plan input ----------
const clean = (s, n) => String(s ?? '').trim().slice(0, n);
const handleOk = (s) => /^[a-z0-9][a-z0-9_-]{0,99}$/i.test(s);
const num = (v) => (v === '' || v == null ? null : Number(v));

/**
 * Validates a sale plan as the owner entered it. Returns clean fields or throws a readable error.
 * `markets`: the allowed market keys. `now`: for "the sale has already ended".
 */
export function cleanPlan(input = {}, { markets = [], now = Date.now(), base = null } = {}) {
  const b = { ...(base || {}), ...input };
  const name = clean(b.name, 80);
  if (!name) throw new Error('Give the sale a name, for example “Black Friday 2026”.');
  const timeZone = clean(b.timeZone, 64);
  if (!validTimeZone(timeZone)) throw new Error('Choose the time zone your sale runs in.');
  const startsAt = zonedToUtc(b.startsLocal, timeZone);
  const endsAt = zonedToUtc(b.endsLocal, timeZone);
  if (endsAt <= startsAt) throw new Error('The sale must end after it starts.');
  if (endsAt - startsAt > 92 * 86400000) throw new Error('A sale plan can cover up to 3 months. Split longer offers into several plans.');
  if (endsAt <= now && !base) throw new Error('This sale has already ended. Choose dates in the future.');

  const mk = Array.isArray(b.markets) ? [...new Set(b.markets.map(String))] : [];
  const unknown = mk.find((m) => !markets.includes(m));
  if (unknown) throw new Error(`Unknown market: ${unknown}.`);

  const codes = [];
  for (const c of Array.isArray(b.codes) ? b.codes : []) {
    const code = clean(typeof c === 'string' ? c : c?.code, 40);
    if (!code) continue;
    if (!/^[\w-]{2,40}$/.test(code)) throw new Error(`Discount code “${code}” can only use letters, numbers, - and _.`);
    const percent = num(typeof c === 'object' ? c.percent : null);
    if (percent != null && !(percent > 0 && percent <= 100)) throw new Error(`The discount for ${code} must be between 1 and 100%.`);
    if (codes.some((x) => x.code.toLowerCase() === code.toLowerCase())) continue;
    codes.push({ code, percent });
  }
  if (codes.length > 10) throw new Error('A sale plan can have up to 10 discount codes.');

  const rules = [];
  for (const r of Array.isArray(b.rules) ? b.rules : []) {
    const scope = String(r?.scope || 'all');
    const type = String(r?.type || 'percent');
    if (!RULE_SCOPES.includes(scope)) throw new Error('Each discount applies to the whole store, a collection, a product or a tag.');
    if (!RULE_TYPES.includes(type)) throw new Error('Each discount is a percentage off, an amount off, or a new price.');
    const target = scope === 'all' ? '' : clean(r?.target, 100);
    if (scope !== 'all' && !target) throw new Error(`Say which ${scope} the discount applies to.`);
    if ((scope === 'collection' || scope === 'product') && !handleOk(target)) throw new Error(`Use the ${scope}'s handle, the last part of its address (for example “summer-dresses”).`);
    const value = Number(r?.value);
    if (!Number.isFinite(value) || value <= 0) throw new Error('Enter the size of each discount.');
    if (type === 'percent' && value > 100) throw new Error('A percentage discount can be at most 100%.');
    rules.push({ scope, target, type, value: Math.round(value * 100) / 100 });
  }
  if (rules.length > 20) throw new Error('A sale plan can have up to 20 discount rules.');

  const offers = [];
  for (const o of Array.isArray(b.offers) ? b.offers : []) offers.push(cleanOffer(o));
  if (offers.length > 10) throw new Error('A sale plan can have up to 10 offers.');

  const themeId = clean(b.themeId, 20);
  if (themeId && !/^\d{1,20}$/.test(themeId)) throw new Error('Choose the sale theme from your theme list.');
  const freeShipping = num(b.freeShipping);
  if (freeShipping != null && !(Number.isFinite(freeShipping) && freeShipping >= 0)) throw new Error('Enter the free shipping amount as a number.');
  return {
    name, timeZone, startsAt, endsAt, markets: mk, codes, rules, offers, themeId: themeId || null,
    banner: clean(b.banner, 140) || null, freeShipping, notes: clean(b.notes, 500) || null,
  };
}

// ---------- offers: buy X get Y, free gifts, bundles ----------
export const OFFER_TYPES = ['bxgy', 'gift', 'bundle'];
const ITEM_SCOPES = ['all', 'collection', 'product'];
function cleanSide(side, { label, allowAll, allowAmount }) {
  const s = side || {};
  const amount = allowAmount ? num(s.amount) : null;
  if (amount != null) {
    if (!(Number.isFinite(amount) && amount > 0)) throw new Error(`Enter the order amount for ${label} as a number.`);
    return { amount: Math.round(amount * 100) / 100 };
  }
  const scope = String(s.scope || (allowAll ? 'all' : 'product'));
  if (!ITEM_SCOPES.includes(scope) || (scope === 'all' && !allowAll)) throw new Error(`Say which product or collection ${label} is.`);
  const target = scope === 'all' ? '' : clean(s.target, 100).toLowerCase();
  if (scope !== 'all' && !handleOk(target)) throw new Error(`For ${label}, use the ${scope}'s handle, the last part of its address (for example “summer-dresses”).`);
  const quantity = num(s.quantity) ?? 1;
  if (!(Number.isInteger(quantity) && quantity >= 1 && quantity <= 100)) throw new Error(`The number of items for ${label} must be a whole number from 1 to 100.`);
  return { scope, target, quantity };
}
/**
 * One offer as the owner entered it (flat form fields or the saved shape). Returns the saved shape:
 *   bxgy:   { type, buy: {scope,target,quantity} | {amount}, get: {scope,target,quantity}, percent, code }
 *   gift:   same as bxgy, percent is always 100 (the item is free)
 *   bundle: { type, name, products: [handles], price }   a set of products sold together for one price
 */
export function cleanOffer(o = {}) {
  const type = String(o.type || 'bxgy');
  if (!OFFER_TYPES.includes(type)) throw new Error('Each offer is “buy X get Y”, a free gift, or a bundle.');
  if (type === 'bundle') {
    const name = clean(o.name, 80);
    const list = Array.isArray(o.products) ? o.products : String(o.products || '').split(/[\s,]+/);
    const products = [...new Set(list.map((h) => clean(h, 100).toLowerCase()).filter(Boolean))];
    if (products.length < 2) throw new Error('A bundle needs at least 2 products (their handles, separated by commas).');
    if (products.length > 10) throw new Error('A bundle can have up to 10 products.');
    const bad = products.find((h) => !handleOk(h));
    if (bad) throw new Error(`“${bad}” isn’t a product handle. Use the last part of the product’s address.`);
    const price = num(o.price);
    if (!(Number.isFinite(price) && price > 0)) throw new Error('Enter the bundle’s price.');
    return { type, name: name || null, products, price: Math.round(price * 100) / 100 };
  }
  const buy = cleanSide(o.buy || { scope: o.buyScope, target: o.buyTarget, quantity: o.buyQty, amount: o.buyAmount }, { label: 'what customers buy', allowAll: true, allowAmount: true });
  const get = cleanSide(o.get || { scope: o.getScope, target: o.getTarget, quantity: o.getQty }, { label: type === 'gift' ? 'the gift' : 'what customers get', allowAll: false });
  let percent = 100;
  if (type === 'bxgy') {
    percent = num(o.percent) ?? 100;
    if (!(percent > 0 && percent <= 100)) throw new Error('The discount on what customers get must be between 1 and 100%.');
  }
  const code = clean(o.code, 40) || null;
  if (code && !/^[\w-]{2,40}$/.test(code)) throw new Error(`Discount code “${code}” can only use letters, numbers, - and _.`);
  return { type, buy, get, percent: Math.round(percent * 100) / 100, code };
}
const sideText = (s) => (s.amount != null ? `spend ${s.amount}` : `${s.quantity} × ${s.scope === 'all' ? 'anything' : `${s.scope} “${s.target}”`}`);
export function offerLabel(o) {
  if (o.type === 'bundle') return `Bundle${o.name ? ` “${o.name}”` : ''}: ${o.products.join(' + ')} for ${o.price}`;
  const buy = o.buy.amount != null ? `Spend ${o.buy.amount}` : `Buy ${sideText(o.buy)}`;
  if (o.type === 'gift') return `${buy}, get ${sideText(o.get)} free`;
  return `${buy}, get ${sideText(o.get)} ${o.percent >= 100 ? 'free' : `${o.percent}% off`}`;
}

// ---------- which products a discount covers ----------
/**
 * The product handles a Shopify discount's items cover. `items`: { all, products, collections, partial }.
 * Returns null when it can't be told (no items read, or Shopify listed only part of them).
 */
export function coveredHandles(items, products, inCollection) {
  if (!items || items.partial) return null;
  if (items.all) return new Set(products.map((p) => String(p.handle).toLowerCase()));
  const hs = new Set((items.products || []).map((h) => String(h).toLowerCase()));
  for (const p of products) if ((items.collections || []).some((c) => inCollection(String(c).toLowerCase(), p.id))) hs.add(String(p.handle).toLowerCase());
  return hs;
}
/** Products a plan side (scope + target) means. */
export function sideHandles(side, products, inCollection) {
  return new Set(products.filter((p) => side.scope === 'all'
    || (side.scope === 'product' && String(p.handle).toLowerCase() === side.target)
    || (side.scope === 'collection' && inCollection(side.target, p.id))).map((p) => String(p.handle).toLowerCase()));
}
const titlesOf = (hs, products) => [...hs].slice(0, 5).map((h) => products.find((p) => String(p.handle).toLowerCase() === h)?.title || h).join(', ') + (hs.size > 5 ? ` and ${hs.size - 5} more` : '');
const minus = (a, b) => new Set([...a].filter((x) => !b.has(x)));

/**
 * Do the Shopify discounts apply to the products the plan discounts? For each plan code found in Shopify,
 * and each automatic discount that stands for a plan rule, compares the products it covers with the
 * products the plan expects it on:
 *   - a code: the products of the plan's % rules with the same %, or every product the plan discounts
 *   - an automatic discount: the products its rule matches
 * Products the plan discounts but Shopify doesn't are a fail (customers pay full price); the reverse is a warning.
 */
export function compareScope(plan, discounts, products, inCollection) {
  const out = [];
  if (!plan.rules.length || !products.length) return out;
  const ruleSet = (r) => new Set(products.filter((p) => matchingRules([r], p, inCollection).length).map((p) => String(p.handle).toLowerCase()));
  const planned = new Set();
  for (const r of plan.rules) for (const h of ruleSet(r)) planned.add(h);
  const check = (name, d, expected, area) => {
    const covered = coveredHandles(d.items, products, inCollection);
    if (!covered || !expected.size) return;
    const missing = minus(expected, covered), extra = minus(covered, expected);
    if (missing.size) out.push({ area, level: 'fail', title: `${name} doesn’t apply to ${missing.size} product${missing.size === 1 ? '' : 's'} your plan discounts`, detail: `In Shopify, “${d.title}” doesn’t cover: ${titlesOf(missing, products)}. Customers would pay full price for ${missing.size === 1 ? 'it' : 'them'}.`, fix: 'Add them under “Applies to” in Shopify admin → Discounts, or change the plan.' });
    if (extra.size) out.push({ area, level: 'warn', title: `${name} also applies to ${extra.size} product${extra.size === 1 ? '' : 's'} your plan doesn’t discount`, detail: `In Shopify, “${d.title}” also covers: ${titlesOf(extra, products)}.`, fix: 'If they shouldn’t be in the sale, remove them under “Applies to” in Shopify admin → Discounts.' });
    if (!missing.size && !extra.size) out.push({ area, level: 'pass', title: `${name} applies to the right products`, detail: `“${d.title}” covers the ${plural(expected.size, 'product')} your plan expects.` });
  };
  for (const c of plan.codes) {
    const d = discounts.find((x) => x.type === 'basic' && x.codes?.some((k) => k.toLowerCase() === c.code.toLowerCase()));
    if (!d) continue;
    const same = c.percent != null ? plan.rules.filter((r) => r.type === 'percent' && Math.abs(r.value - c.percent) < 0.05) : [];
    const expected = same.length ? new Set(same.flatMap((r) => [...ruleSet(r)])) : planned;
    check(`Discount code ${c.code}`, d, expected, 'codes');
  }
  const seen = new Set();
  for (const r of plan.rules) {
    const auto = automaticFor(r, plan, discounts);
    if (!auto || seen.has(auto)) continue;
    seen.add(auto);
    const same = plan.rules.filter((x) => automaticFor(x, plan, discounts) === auto);
    check(`Shopify discount “${auto.title}”`, auto, new Set(same.flatMap((x) => [...ruleSet(x)])), 'prices');
  }
  return out;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Checks the plan's offers. Buy X get Y and free gifts are matched with Shopify's buy X get Y discounts
 * (`discounts` null: can't be read, e.g. stores outside the Shopify app). Bundles are checked against the
 * store's own products: they exist and the bundle costs less than buying them one by one. The price in a
 * real cart is tried by the pricing checks (T75-T78).
 */
export function compareOffers(plan, discounts, products, inCollection, { now = Date.now() } = {}) {
  const out = [];
  const byHandle = new Map(products.map((p) => [String(p.handle).toLowerCase(), p]));
  const tz = plan.timeZone;
  for (const o of plan.offers || []) {
    const name = offerLabel(o);
    if (o.type === 'bundle') {
      const missing = o.products.filter((h) => !byHandle.has(h));
      if (products.length && missing.length) { out.push({ area: 'offers', level: 'fail', title: `${name}: ${missing.length === 1 ? 'a product isn’t' : `${missing.length} products aren’t`} in your store`, detail: `We couldn’t find ${missing.map((h) => `“${h}”`).join(', ')}.`, fix: 'Check the handles in the bundle, or remove the bundle from the plan.' }); continue; }
      if (!products.length) continue;
      const sum = Math.round(o.products.reduce((a, h) => a + Math.min(...(byHandle.get(h).variants || [{ price: 0 }]).map((v) => Number(v.price))), 0) * 100) / 100;
      if (o.price >= sum) out.push({ area: 'offers', level: 'fail', title: `${name} costs more than buying the products one by one`, detail: `Bought separately they cost ${sum}; the bundle is ${o.price}.`, fix: 'Lower the bundle price, or check the products in it.' });
      else out.push({ area: 'offers', level: 'pass', title: `${name} is cheaper than buying separately`, detail: `${sum} separately, ${o.price} as a bundle (${Math.round(((sum - o.price) / sum) * 100)}% less).` });
      continue;
    }
    // Products named in the offer must exist.
    const absent = [];
    for (const side of [o.buy, o.get]) {
      if (side.amount != null || side.scope === 'all' || !products.length) continue;
      if (!sideHandles(side, products, inCollection).size) absent.push(`${side.scope} “${side.target}”`);
    }
    if (absent.length) out.push({ area: 'offers', level: 'fail', title: `${name}: ${absent.join(' and ')} not found in your store`, detail: 'No product matches, so customers can’t get this offer.', fix: 'Use the handle from the product’s or collection’s address.' });
    if (!discounts) continue;
    const live = discounts.filter((d) => d.type === 'bxgy' && (!ms(d.endsAt) || ms(d.endsAt) > plan.startsAt) && (!ms(d.startsAt) || ms(d.startsAt) < plan.endsAt));
    const cands = o.code ? live.filter((d) => d.codes?.some((k) => k.toLowerCase() === o.code.toLowerCase())) : live.filter((d) => d.kind === 'automatic');
    if (!cands.length) { out.push({ area: 'offers', level: 'fail', title: `${name} isn’t set up in Shopify`, detail: o.code ? `We couldn’t find a buy X get Y discount with the code ${o.code} for the sale’s dates.` : 'We couldn’t find an automatic buy X get Y discount for the sale’s dates.', fix: 'Create it in Shopify admin → Discounts → Buy X get Y, with the sale’s start and end times.' }); continue; }
    const graded = cands.map((d) => ({ d, problems: offerProblems(o, d, plan, products, inCollection, tz) })).sort((a, b) => a.problems.length - b.problems.length);
    const { d, problems } = graded[0];
    if (!problems.length) out.push({ area: 'offers', level: 'pass', title: `${name} is set up in Shopify`, detail: `“${d.title}” matches the offer and the sale’s dates.` });
    else out.push({ area: 'offers', level: 'fail', title: `${name} doesn’t match Shopify`, detail: `“${d.title}”: ${problems.map((p) => p.text).join(' ')}`, fix: problems[0].fix });
  }
  if (!discounts && (plan.offers || []).some((o) => o.type !== 'bundle')) out.push({ area: 'offers', level: 'later', title: 'Buy X get Y offers and gifts are tried when the sale goes live', detail: 'For stores outside the Shopify app we can’t see offers before they start.' });
  return out;
}
function offerProblems(o, d, plan, products, inCollection, tz) {
  const p = [];
  const fixIt = 'Change the buy X get Y discount in Shopify admin → Discounts, or the plan, so they agree.';
  const s = ms(d.startsAt), e = ms(d.endsAt);
  if (s && s > plan.startsAt + GRACE) p.push({ text: `It starts at ${fmt(s, tz)}, after your sale starts.`, fix: 'Move its start date to the sale’s start.' });
  if (e && e < plan.endsAt - GRACE) p.push({ text: `It stops at ${fmt(e, tz)}, before your sale ends.`, fix: 'Move its end date to the sale’s end.' });
  const buys = d.buys || {}, gets = d.gets || {};
  if (o.buy.amount != null) {
    if (buys.amount == null) p.push({ text: `Customers must buy ${buys.quantity ?? 'some'} items, not spend ${o.buy.amount}.`, fix: fixIt });
    else if (Math.abs(buys.amount - o.buy.amount) > 0.01) p.push({ text: `Customers must spend ${buys.amount}; your plan says ${o.buy.amount}.`, fix: fixIt });
  } else {
    if (buys.quantity != null && buys.quantity !== o.buy.quantity) p.push({ text: `Customers must buy ${buys.quantity}; your plan says ${o.buy.quantity}.`, fix: fixIt });
    if (buys.amount != null) p.push({ text: `Customers must spend ${buys.amount} instead of buying ${o.buy.quantity}.`, fix: fixIt });
    const want = sideHandles(o.buy, products, inCollection), has = coveredHandles(buys.items, products, inCollection);
    if (has && want.size) { const miss = minus(want, has); if (miss.size) p.push({ text: `Buying ${titlesOf(miss, products)} doesn’t count towards it.`, fix: 'Add them under “Customer buys” in Shopify, or change the plan.' }); }
  }
  if (gets.quantity != null && gets.quantity !== o.get.quantity) p.push({ text: `Customers get ${gets.quantity}; your plan says ${o.get.quantity}.`, fix: fixIt });
  if (gets.percent != null && Math.abs(gets.percent - o.percent) > 0.05) p.push({ text: gets.percent >= 100 ? `It gives the item free; your plan says ${o.percent}% off.` : `It takes ${gets.percent}% off${o.percent >= 100 ? '; your plan says free' : `; your plan says ${o.percent}%`}.`, fix: fixIt });
  const wantGet = sideHandles(o.get, products, inCollection), hasGet = coveredHandles(gets.items, products, inCollection);
  if (hasGet && wantGet.size) { const miss = minus(wantGet, hasGet); if (miss.size) p.push({ text: `${titlesOf(miss, products)} ${miss.size === 1 ? 'isn’t' : 'aren’t'} among what customers get.`, fix: 'Add them under “Customer gets” in Shopify, or change the plan.' }); }
  return p;
}

// ---------- expected prices ----------
const tagsOf = (p) => (Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',')).map((t) => t.trim().toLowerCase()).filter(Boolean);
/** The rules that match a product. `inCollection(handle, productId)` says whether a product is in a collection. */
export function matchingRules(rules, product, inCollection) {
  return rules.filter((r) => r.scope === 'all'
    || (r.scope === 'product' && r.target.toLowerCase() === String(product.handle).toLowerCase())
    || (r.scope === 'tag' && tagsOf(product).includes(r.target.toLowerCase()))
    || (r.scope === 'collection' && inCollection(r.target.toLowerCase(), product.id)));
}
export const priceAfter = (price, rule) => {
  const p = Number(price);
  const out = rule.type === 'percent' ? p * (1 - rule.value / 100) : rule.type === 'fixed' ? p - rule.value : rule.value;
  return Math.round(out * 100) / 100;
};
export const ruleLabel = (r, money = (n) => String(n)) => `${r.type === 'percent' ? `${r.value}% off` : r.type === 'fixed' ? `${money(r.value)} off` : `new price ${money(r.value)}`} ${r.scope === 'all' ? 'everything' : `${r.scope} “${r.target}”`}`;

/**
 * For every variant of every product, the price it should have during the sale, and what looks wrong.
 * Returns { rows, problems, unmatchedRules, counts }.
 */
export function expectedPrices(products, rules, inCollection) {
  const rows = [];
  const matched = new Set();
  let conflicts = 0;
  for (const p of products) {
    const match = matchingRules(rules, p, inCollection);
    for (const r of match) matched.add(rules.indexOf(r));
    if (!match.length) continue;
    const top = Math.max(...match.map((r) => SPECIFIC[r.scope]));
    const best = match.filter((r) => SPECIFIC[r.scope] === top);
    const rule = best[0];
    const conflict = best.length > 1 && best.some((r) => r.type !== rule.type || r.value !== rule.value);
    if (conflict) conflicts++;
    for (const v of p.variants || []) {
      const now = Number(v.price);
      const sale = priceAfter(now, rule);
      const issues = [];
      if (sale <= 0) issues.push({ level: 'fail', text: 'would be free or below zero' });
      else if (sale >= now) issues.push({ level: 'fail', text: 'sale price is not lower than today’s price' });
      else if ((now - sale) / now > 0.8) issues.push({ level: 'warn', text: `more than 80% off (${Math.round(((now - sale) / now) * 100)}%)` });
      if (v.compare_at_price && Number(v.compare_at_price) > now) issues.push({ level: 'warn', text: 'already discounted today; the sale comes on top' });
      if (conflict) issues.push({ level: 'warn', text: 'two discounts in your plan apply to this product' });
      rows.push({ product: p.title, handle: p.handle, variant: v.title === 'Default Title' ? null : v.title, sku: v.sku || null, now, sale, rule: rules.indexOf(rule), issues });
    }
  }
  const unmatchedRules = rules.map((r, i) => ({ ...r, i })).filter((r) => !matched.has(r.i));
  return {
    rows,
    unmatchedRules,
    counts: { products: new Set(rows.map((r) => r.handle)).size, variants: rows.length, fail: rows.filter((r) => r.issues.some((i) => i.level === 'fail')).length, warn: rows.filter((r) => r.issues.some((i) => i.level === 'warn') && !r.issues.some((i) => i.level === 'fail')).length, conflicts },
  };
}

// ---------- Shopify discounts ----------
const ms = (iso) => (iso ? new Date(iso).getTime() : null);
const fmt = (t, tz) => new Date(t).toLocaleString('en-GB', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ` (${tz})`;
const GRACE = 5 * 60000; // a few minutes either side is fine

/**
 * Compares the plan's codes and free shipping with the discounts scheduled in Shopify.
 * `discounts`: [{ title, kind: code|automatic, type: basic|bxgy|shipping, codes, startsAt, endsAt, percent, minSubtotal }].
 * Returns findings: [{ area, level: pass|warn|fail|later, title, detail, fix }].
 */
export function compareDiscounts(plan, discounts, { now = Date.now() } = {}) {
  const out = [];
  const tz = plan.timeZone;
  for (const c of plan.codes) {
    const d = discounts.find((x) => x.codes?.some((k) => k.toLowerCase() === c.code.toLowerCase()));
    const title = `Discount code ${c.code}`;
    if (!d) { out.push({ area: 'codes', level: 'fail', title: `${title} isn’t set up in Shopify`, detail: 'We couldn’t find this code among your Shopify discounts.', fix: 'Create it in Shopify admin → Discounts, with the sale’s start and end times.' }); continue; }
    const s = ms(d.startsAt), e = ms(d.endsAt);
    const problems = [];
    if (s && s > plan.startsAt + GRACE) problems.push({ level: 'fail', text: `It starts at ${fmt(s, tz)}, after your sale starts.`, fix: 'Move its start date to the sale’s start.' });
    if (s && s < plan.startsAt - 3600000 && s <= now && (!e || e > now)) problems.push({ level: 'warn', text: 'It already works today, before the sale starts.', fix: 'If customers shouldn’t use it yet, set its start date to the sale’s start.' });
    if (e && e < plan.endsAt - GRACE) problems.push({ level: 'fail', text: `It stops at ${fmt(e, tz)}, before your sale ends.`, fix: 'Move its end date to the sale’s end.' });
    if (!e) problems.push({ level: 'warn', text: 'It has no end date, so it keeps working after the sale.', fix: 'Set an end date in Shopify admin → Discounts.' });
    else if (e > plan.endsAt + 3600000) problems.push({ level: 'warn', text: `It keeps working until ${fmt(e, tz)}, after your sale ends.`, fix: 'Move its end date to the sale’s end.' });
    if (c.percent != null && d.percent != null && Math.abs(d.percent - c.percent) > 0.05) problems.push({ level: 'fail', text: `It takes ${d.percent}% off in Shopify; your plan says ${c.percent}%.`, fix: 'Change the discount in Shopify or the plan, so they agree.' });
    if (!problems.length) out.push({ area: 'codes', level: 'pass', title: `${title} is scheduled for the sale`, detail: `${d.title}${d.percent != null ? `, ${d.percent}% off` : ''}: ${s ? fmt(s, tz) : 'already active'} to ${e ? fmt(e, tz) : 'no end date'}.` });
    else {
      const worst = problems.some((p) => p.level === 'fail') ? 'fail' : 'warn';
      out.push({ area: 'codes', level: worst, title: `${title} ${worst === 'fail' ? 'doesn’t match the sale' : 'needs a look'}`, detail: problems.map((p) => p.text).join(' '), fix: problems[0].fix });
    }
  }
  if (plan.freeShipping != null) {
    const ship = discounts.filter((d) => d.type === 'shipping' && (!ms(d.endsAt) || ms(d.endsAt) > plan.startsAt) && (!ms(d.startsAt) || ms(d.startsAt) < plan.endsAt));
    if (!ship.length) out.push({ area: 'shipping', level: 'warn', title: 'No free shipping discount found for the sale', detail: `Your plan has free shipping from ${plan.freeShipping}. We couldn’t find a free shipping discount in Shopify for these dates. If it comes from your shipping rates instead, it is checked when the sale goes live.`, fix: 'Create a free shipping discount in Shopify admin → Discounts, or check your shipping rates.' });
    else {
      const right = ship.find((d) => d.minSubtotal == null ? plan.freeShipping === 0 : Math.abs(d.minSubtotal - plan.freeShipping) < 0.01);
      if (right) out.push({ area: 'shipping', level: 'pass', title: 'Free shipping is set up for the sale', detail: `${right.title}: free shipping from ${right.minSubtotal ?? 0}.` });
      else out.push({ area: 'shipping', level: 'fail', title: 'Free shipping starts at a different amount', detail: `Shopify gives free shipping from ${ship.map((d) => d.minSubtotal ?? 0).join(' / ')}; your plan says ${plan.freeShipping}.`, fix: 'Change the minimum order in the Shopify discount or in the plan, so they agree.' });
    }
  }
  return out;
}

/** Automatic Shopify discounts that run during the sale and take the same percentage as a rule. */
export function automaticFor(rule, plan, discounts) {
  if (rule.type !== 'percent') return null;
  return discounts.find((d) => d.kind === 'automatic' && d.percent != null && Math.abs(d.percent - rule.value) < 0.05
    && (!ms(d.startsAt) || ms(d.startsAt) <= plan.startsAt + GRACE) && (!ms(d.endsAt) || ms(d.endsAt) >= plan.endsAt - GRACE)) || null;
}

/** Plans that share some of the same time. */
export const overlaps = (a, b) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/** The daily pre-check runs once a day from the time the plan is saved until the sale starts. */
export function rehearsalDue(plan, lastAt, now = Date.now()) {
  if (plan.startsAt <= now) return false;
  if (plan.startsAt - now > 45 * 86400000) return false; // too early to be useful
  return !lastAt || now - lastAt >= 23 * 3600000;
}

/** One verdict from all findings. */
export function verdictOf(findings) {
  if (findings.some((f) => f.level === 'fail')) return 'not_ready';
  if (findings.some((f) => f.level === 'warn')) return 'review';
  return 'ready';
}
