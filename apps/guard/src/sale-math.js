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

  const themeId = clean(b.themeId, 20);
  if (themeId && !/^\d{1,20}$/.test(themeId)) throw new Error('Choose the sale theme from your theme list.');
  const freeShipping = num(b.freeShipping);
  if (freeShipping != null && !(Number.isFinite(freeShipping) && freeShipping >= 0)) throw new Error('Enter the free shipping amount as a number.');
  return {
    name, timeZone, startsAt, endsAt, markets: mk, codes, rules, themeId: themeId || null,
    banner: clean(b.banner, 140) || null, freeShipping, notes: clean(b.notes, 500) || null,
  };
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
