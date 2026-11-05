/**
 * Sale rehearsal, part 1: sale plans and the pre-check.
 *
 * The owner writes down the sale once (dates in the store's time zone, markets, codes, the discounts they
 * expect, sale theme, banner, free shipping). Before the sale starts, the pre-check rehearses it: every
 * product's sale price is worked out and checked, the discounts scheduled in Shopify are compared with the
 * plan, the sale theme is found and tested next to the live store, and the owner gets a report and an email.
 * It runs on demand and once a day until the sale starts. Works for any sale day (Black Friday, Diwali,
 * 11.11, end of season sales, Boxing Day, ...).
 */
import { db, q } from './db.js';
import { config } from './config.js';
import { MARKETS } from './engine/catalog.js';
import { newContext, gotoStore } from './engine/browser.js';
import { entitlements, has, blockReason } from './license.js';
import { sendMail } from './alerts.js';
import { startRelease } from './release.js';
import * as shopify from './shopify.js';
import { cleanPlan, expectedPrices, compareDiscounts, automaticFor, overlaps, rehearsalDue, verdictOf, ruleLabel, utcToZoned } from './sale-math.js';

db.exec(`
CREATE TABLE IF NOT EXISTS sale_plans (
  id INTEGER PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  starts_at INTEGER NOT NULL,            -- ms since 1970, UTC
  ends_at INTEGER NOT NULL,
  plan_json TEXT NOT NULL DEFAULT '{}',  -- markets, codes, rules, theme, banner, free shipping, notes
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS sale_plans_store ON sale_plans(store_id, starts_at);
CREATE TABLE IF NOT EXISTS sale_rehearsals (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER REFERENCES sale_plans(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL DEFAULT 'manual', -- manual | schedule
  status TEXT NOT NULL DEFAULT 'running', -- running | done | error
  verdict TEXT,                           -- ready | review | not_ready
  release_id INTEGER,                     -- the sale theme tested next to the live store
  summary_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS sale_rehearsals_plan ON sale_rehearsals(plan_id, id DESC);
`);
db.exec("UPDATE sale_rehearsals SET status = 'error', summary_json = '{\"error\":\"Interrupted by a restart. Run it again.\"}', finished_at = datetime('now') WHERE status = 'running'");

const Q = {
  byStore: db.prepare('SELECT * FROM sale_plans WHERE store_id = ? ORDER BY starts_at'),
  byId: db.prepare('SELECT * FROM sale_plans WHERE id = ?'),
  insert: db.prepare('INSERT INTO sale_plans (store_id, name, time_zone, starts_at, ends_at, plan_json) VALUES (?, ?, ?, ?, ?, ?)'),
  update: db.prepare("UPDATE sale_plans SET name = ?, time_zone = ?, starts_at = ?, ends_at = ?, plan_json = ?, updated_at = datetime('now') WHERE id = ?"),
  del: db.prepare('DELETE FROM sale_plans WHERE id = ?'),
  upcoming: db.prepare('SELECT * FROM sale_plans WHERE starts_at > ? ORDER BY starts_at'),
  insRehearsal: db.prepare('INSERT INTO sale_rehearsals (plan_id, store_id, trigger) VALUES (?, ?, ?)'),
  finish: db.prepare("UPDATE sale_rehearsals SET status = ?, verdict = ?, release_id = ?, summary_json = ?, finished_at = datetime('now') WHERE id = ?"),
  rehearsal: db.prepare('SELECT * FROM sale_rehearsals WHERE id = ?'),
  rehearsals: db.prepare('SELECT id, trigger, status, verdict, release_id, created_at, finished_at, summary_json FROM sale_rehearsals WHERE plan_id = ? ORDER BY id DESC LIMIT ?'),
  last: db.prepare('SELECT * FROM sale_rehearsals WHERE plan_id = ? ORDER BY id DESC LIMIT 1'),
  todayManual: db.prepare("SELECT COUNT(*) AS n FROM sale_rehearsals WHERE store_id = ? AND trigger = 'manual' AND created_at > datetime('now', '-1 day')"),
  recentSaleRelease: db.prepare("SELECT id FROM releases WHERE store_id = ? AND trigger = 'sale' AND preview_url = ? AND created_at > datetime('now', '-3 days') LIMIT 1"),
};
const MARKET_CODES = MARKETS.map((m) => m.code);
const REHEARSALS_PER_DAY = 10;
const running = new Set(); // plan ids being rehearsed in this process

/** How many sale plans a store may have that haven't ended yet. */
export const planLimit = (ent) => (has(ent, 'publish') ? 10 : 2);

const parse = (row) => ({ ...JSON.parse(row.plan_json || '{}'), id: row.id, storeId: row.store_id, name: row.name, timeZone: row.time_zone, startsAt: row.starts_at, endsAt: row.ends_at, createdAt: row.created_at, updatedAt: row.updated_at });
const sqlMs = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').getTime() : null);
function phase(p, now = Date.now()) { return now < p.startsAt ? 'upcoming' : now < p.endsAt ? 'live' : 'ended'; }

function rehearsalView(r, { full = false } = {}) {
  if (!r) return null;
  const sum = r.summary_json ? JSON.parse(r.summary_json) : null;
  const v = { id: r.id, trigger: r.trigger, status: r.status, verdict: r.verdict, releaseId: r.release_id, createdAt: r.created_at, finishedAt: r.finished_at };
  if (full) v.summary = sum;
  else { v.counts = sum?.counts || null; v.error = sum?.error || null; }
  return v;
}
function planView(row) {
  const p = parse(row);
  return { ...p, phase: phase(p), startsLocal: utcToZoned(p.startsAt, p.timeZone), endsLocal: utcToZoned(p.endsAt, p.timeZone), last: rehearsalView(Q.last.get(p.id)) };
}
const toRow = (c) => [c.name, c.timeZone, c.startsAt, c.endsAt, JSON.stringify({ markets: c.markets, codes: c.codes, rules: c.rules, themeId: c.themeId, banner: c.banner, freeShipping: c.freeShipping, notes: c.notes })];

// ---------- reading the store ----------
/** Every product from the storefront's products.json, up to 1,000. */
async function storeProducts(request, origin) {
  const out = [], seen = new Set();
  for (let page = 1; page <= 4; page++) {
    const r = await request.get(`${origin}/products.json?limit=250&page=${page}`, { timeout: 30000 }).catch(() => null);
    const j = r && r.ok() ? await r.json().catch(() => null) : null;
    const list = j?.products || [];
    let fresh = 0;
    for (const p of list) if (!seen.has(p.id)) { seen.add(p.id); out.push(p); fresh++; }
    if (list.length < 250 || !fresh) break;
  }
  return out;
}
async function collectionIds(request, origin, handle) {
  const ids = new Set();
  for (let page = 1; page <= 4; page++) {
    const r = await request.get(`${origin}/collections/${encodeURIComponent(handle)}/products.json?limit=250&page=${page}`, { timeout: 30000 }).catch(() => null);
    if (!r || r.status() === 404) return page === 1 ? null : ids;
    const list = (await r.json().catch(() => null))?.products || [];
    const before = ids.size;
    for (const p of list) ids.add(p.id);
    if (list.length < 250 || ids.size === before) break;
  }
  return ids;
}

const DISCOUNTS_QUERY = `{ discountNodes(first: 50, query: "status:active OR status:scheduled") { nodes { id discount { __typename
  ... on DiscountCodeBasic { title startsAt endsAt codes(first: 5) { nodes { code } } customerGets { value { ... on DiscountPercentage { percentage } } } }
  ... on DiscountCodeBxgy { title startsAt endsAt codes(first: 5) { nodes { code } } }
  ... on DiscountCodeFreeShipping { title startsAt endsAt codes(first: 5) { nodes { code } } minimumRequirement { ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } } } }
  ... on DiscountAutomaticBasic { title startsAt endsAt customerGets { value { ... on DiscountPercentage { percentage } } } }
  ... on DiscountAutomaticBxgy { title startsAt endsAt }
  ... on DiscountAutomaticFreeShipping { title startsAt endsAt minimumRequirement { ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } } } } } } } }`;
/** Active and scheduled discounts from Shopify (read_discounts). */
export async function scheduledDiscounts(shop) {
  const d = await shopify.gql(shop, DISCOUNTS_QUERY);
  return (d.discountNodes?.nodes || []).map((n) => {
    const x = n.discount || {};
    const t = x.__typename || '';
    const pct = x.customerGets?.value?.percentage;
    const min = x.minimumRequirement?.greaterThanOrEqualToSubtotal?.amount;
    return {
      title: x.title || 'Discount', kind: t.startsWith('DiscountCode') ? 'code' : 'automatic',
      type: /FreeShipping/.test(t) ? 'shipping' : /Bxgy/.test(t) ? 'bxgy' : 'basic',
      codes: (x.codes?.nodes || []).map((c) => c.code), startsAt: x.startsAt || null, endsAt: x.endsAt || null,
      percent: typeof pct === 'number' ? Math.round(pct * 1000) / 10 : null, minSubtotal: min != null ? Number(min) : null,
    };
  });
}

// ---------- the pre-check ----------
async function rehearse(store, plan, { trigger, rehearsalId }) {
  const findings = [];
  const add = (area, level, title, detail = '', fix = null, extra = {}) => findings.push({ area, level, title, detail, fix, ...extra });
  const now = Date.now();
  const ent = entitlements(store.user_id);
  const shop = shopify.shopForStore(store.id);
  const money = (n) => String(n);

  // Dates and other plans
  if (plan.startsAt <= now) add('dates', 'warn', 'The sale has already started', 'The pre-check is meant for before the sale. Prices that change at the start can’t be checked in advance.');
  else add('dates', 'pass', 'Start and end are set', `${utcToZoned(plan.startsAt, plan.timeZone).replace('T', ' ')} to ${utcToZoned(plan.endsAt, plan.timeZone).replace('T', ' ')} (${plan.timeZone}).`);
  for (const other of Q.byStore.all(store.id).map(parse)) {
    if (other.id !== plan.id && overlaps(plan, other)) add('dates', 'warn', `Overlaps with “${other.name}”`, 'Both sales run at the same time. Discounts from both may add up on the same products.', 'Check that this is intended, or change the dates of one plan.');
  }

  // Shopify discounts (read only, with the read_discounts permission the app already has)
  let discounts = null;
  if (shop) {
    try { discounts = await scheduledDiscounts(shop.shop); } catch (e) { add('codes', 'warn', 'We couldn’t read your discounts from Shopify', 'Shopify didn’t answer just now. The next pre-check tries again.'); }
  }
  if (discounts) findings.push(...compareDiscounts(plan, discounts, { now }));
  else {
    if (plan.codes.length) add('codes', 'later', `${plan.codes.length === 1 ? 'Your discount code is' : `Your ${plan.codes.length} discount codes are`} checked when the sale goes live`, shop ? '' : 'For stores outside the Shopify app we can’t see discounts before they start. When the sale starts, each code is tried in a real cart.');
    if (plan.freeShipping != null) add('shipping', 'later', 'Free shipping is checked when the sale goes live', 'A real cart is filled up to the amount when the sale starts.');
  }
  if (plan.codes.length && plan.markets.length > 1) add('codes', 'later', 'Codes in each market are tried at go-live', `Scheduled codes don’t work in a cart before the sale starts, so they are tried in ${plan.markets.join(', ')} and their currencies when the sale goes live.`);

  // Expected sale prices for every product
  let prices = null;
  const ctx = await newContext();
  try {
    if (plan.rules.length) {
      const products = await storeProducts(ctx.request, store.url);
      if (!products.length) add('prices', 'warn', 'We couldn’t read your products', 'Your store’s product list (products.json) didn’t answer, so sale prices weren’t worked out.', 'Check the store is online and not password protected, or add the storefront password in Store settings.');
      else {
        const cols = new Map();
        for (const r of plan.rules.filter((x) => x.scope === 'collection')) {
          const h = r.target.toLowerCase();
          if (!cols.has(h)) cols.set(h, await collectionIds(ctx.request, store.url, h));
          if (cols.get(h) === null) add('prices', 'fail', `Collection “${r.target}” doesn’t exist`, 'No collection has this handle, so no product gets this discount.', 'Use the last part of the collection’s address, for example “summer-dresses”.');
        }
        prices = expectedPrices(products, plan.rules, (h, id) => !!cols.get(h)?.has(id));
        for (const r of prices.unmatchedRules) if (!(r.scope === 'collection' && cols.get(r.target.toLowerCase()) === null)) add('prices', 'warn', `The discount for ${r.scope === 'all' ? 'everything' : `${r.scope} “${r.target}”`} matches no product`, `No product in your store gets ${ruleLabel(r, money).replace(/ (everything|(collection|product|tag) “.*”)$/, '')}.`, 'Check the handle or tag, or remove the rule.');
        const bad = prices.rows.filter((x) => x.issues.some((i) => i.level === 'fail'));
        const odd = prices.rows.filter((x) => x.issues.some((i) => i.level === 'warn') && !x.issues.some((i) => i.level === 'fail'));
        if (bad.length) add('prices', 'fail', `${bad.length} sale price${bad.length === 1 ? '' : 's'} would be wrong`, bad.slice(0, 5).map((x) => `${x.product}${x.variant ? ` (${x.variant})` : ''}: ${x.now} → ${x.sale}, ${x.issues.find((i) => i.level === 'fail').text}`).join('; '), 'Change the discount in your plan, or the product’s price, before the sale.');
        if (odd.length) add('prices', 'warn', `${odd.length} sale price${odd.length === 1 ? '' : 's'} to look at`, odd.slice(0, 5).map((x) => `${x.product}${x.variant ? ` (${x.variant})` : ''}: ${x.issues.map((i) => i.text).join(', ')}`).join('; '));
        if (prices.rows.length && !bad.length && !odd.length) add('prices', 'pass', `Sale prices worked out for ${prices.counts.products} product${prices.counts.products === 1 ? '' : 's'}`, `${prices.counts.variants} prices, all lower than today and above zero.`);
        // Where the discount comes from: a scheduled Shopify discount we can read now, or price changes made at the start.
        const unmatched = new Set(prices.unmatchedRules.map((r) => r.i));
        const atStart = [];
        plan.rules.forEach((r, i) => {
          if (unmatched.has(i)) return;
          const auto = discounts && automaticFor(r, plan, discounts);
          if (auto) add('prices', 'pass', `Shopify discount “${auto.title}” is scheduled for ${ruleLabel(r, money)}`, `${auto.percent}% off for the sale’s dates.`);
          else atStart.push(ruleLabel(r, money));
        });
        if (atStart.length) add('prices', 'later', `${atStart.length === 1 ? 'Your sale price is' : `Sale prices from ${atStart.length} discounts are`} checked at go-live`, `${atStart.join('; ')}. Prices that change when the sale starts can’t be read before. When it starts, every product is compared with the sale prices below.`);
      }
    }

    // Sale theme and banner
    if (plan.themeId) {
      const preview = `${store.url.replace(/\/$/, '')}/?preview_theme_id=${plan.themeId}`;
      let themeOk = true;
      if (shop) {
        try {
          const themes = await shopify.draftThemes(shop.shop);
          const t = themes.find((x) => x.id === plan.themeId);
          if (t) add('theme', 'pass', `Sale theme “${t.name}” is ready`, 'It is in your theme list and not published yet.');
          else { themeOk = false; add('theme', 'fail', 'The sale theme isn’t in your theme list', 'It may have been deleted, renamed into another theme, or already published.', 'Choose the sale theme again in this plan.'); }
        } catch { add('theme', 'warn', 'We couldn’t read your themes from Shopify', 'The next pre-check tries again.'); }
      }
      if (themeOk && plan.banner) {
        const page = await ctx.newPage();
        try {
          const nav = await gotoStore(page, preview, { password: store.storefront_password });
          const text = nav.locked ? '' : await page.evaluate(() => document.body?.innerText || '').catch(() => '');
          const want = plan.banner.toLowerCase().replace(/\s+/g, ' ');
          if (nav.locked) add('banner', 'warn', 'We couldn’t open the sale theme', 'The store asked for a password.', 'Add the storefront password in Store settings.');
          else if (text.toLowerCase().replace(/\s+/g, ' ').includes(want)) add('banner', 'pass', 'Sale banner is on the sale theme', `“${plan.banner}” is on its homepage.`);
          else add('banner', 'fail', 'Sale banner is missing on the sale theme', `We couldn’t find “${plan.banner}” on the sale theme’s homepage.`, 'Add the banner to the sale theme, or correct the text in the plan.');
        } catch { add('banner', 'warn', 'We couldn’t open the sale theme', 'The preview didn’t load. The next pre-check tries again.'); }
        finally { await page.close().catch(() => {}); }
      }
      // The sale theme, tested next to the live store with the whole suite (Safe to publish).
      if (themeOk) {
        const reuse = trigger === 'schedule' ? Q.recentSaleRelease.get(store.id, preview) : null;
        if (!has(ent, 'publish')) add('theme', 'later', 'Side-by-side test of the sale theme isn’t in your plan', 'Safe to publish tests the sale theme next to your live store. Upgrade to have it in every pre-check.');
        else if (reuse) findings.push({ area: 'theme', level: 'pass', title: 'Sale theme tested next to your live store recently', detail: 'Open the result to see what is different.', releaseId: reuse.id });
        else if (q.activeRunForStore.get(store.id)) add('theme', 'later', 'Sale theme not tested this time', 'Another test was running for this store. The next pre-check tests it, or start it from Safe to publish.');
        else {
          const id = startRelease(store, { url: preview, label: `Sale theme for ${plan.name}`, trigger: 'sale' });
          findings.push({ area: 'theme', level: 'pass', title: 'Sale theme is being tested next to your live store', detail: 'It takes a few minutes. Open the result to see if anything would break.', releaseId: id });
        }
      }
    } else if (plan.banner) add('banner', 'later', 'Sale banner is checked when the sale goes live', 'Choose a sale theme in the plan to have it checked before.');
  } finally {
    await ctx.close().catch(() => {});
  }

  const verdict = verdictOf(findings);
  const counts = { fail: findings.filter((f) => f.level === 'fail').length, warn: findings.filter((f) => f.level === 'warn').length, pass: findings.filter((f) => f.level === 'pass').length, later: findings.filter((f) => f.level === 'later').length };
  const releaseId = findings.find((f) => f.releaseId)?.releaseId || null;
  const summary = { verdict, counts, findings, prices: prices ? { counts: prices.counts, rows: prices.rows.slice(0, 300), more: Math.max(0, prices.rows.length - 300) } : null, plan: { name: plan.name, startsAt: plan.startsAt, endsAt: plan.endsAt, timeZone: plan.timeZone } };
  return { verdict, releaseId, summary };
}

const VERDICT = { ready: 'Ready for the sale', review: 'Ready, with things to look at', not_ready: 'Not ready yet' };
function rehearsalMail(store, plan, rh, summary) {
  const name = store.name || new URL(store.url).host;
  const link = `${config.baseUrl}/app#/s/${store.id}/sales/${plan.id}`;
  const line = (f) => `- ${f.title}${f.detail ? `\n  ${f.detail}` : ''}${f.fix ? `\n  What to do: ${f.fix}` : ''}`;
  const fails = summary.findings.filter((f) => f.level === 'fail'), warns = summary.findings.filter((f) => f.level === 'warn');
  const text = [
    `Sale rehearsal for ${plan.name} on ${name}: ${VERDICT[summary.verdict]}.`,
    `The sale starts ${utcToZoned(plan.startsAt, plan.timeZone).replace('T', ' ')} (${plan.timeZone}).`,
    fails.length ? `\nFix before the sale:\n${fails.map(line).join('\n')}` : '',
    warns.length ? `\nHave a look:\n${warns.map(line).join('\n')}` : '',
    summary.counts.pass ? `\n${summary.counts.pass} thing${summary.counts.pass === 1 ? ' is' : 's are'} ready.` : '',
    summary.counts.later ? `${summary.counts.later} thing${summary.counts.later === 1 ? ' is' : 's are'} checked when the sale goes live.` : '',
    `\nFull report: ${link}`,
    rh.trigger === 'schedule' ? '\nWe rehearse the sale once a day until it starts.' : '',
  ].filter(Boolean).join('\n');
  return { to: store.alert_email, subject: `${summary.verdict === 'ready' ? 'Ready' : summary.verdict === 'review' ? 'Have a look' : 'Not ready'}: ${plan.name} on ${name}`, text };
}

/** Starts a pre-check of a plan. Returns the rehearsal id; the work carries on in the background. */
export function startRehearsal(store, planRow, trigger = 'manual') {
  const plan = parse(planRow);
  const id = Number(Q.insRehearsal.run(plan.id, store.id, trigger).lastInsertRowid);
  running.add(plan.id);
  (async () => {
    try {
      const { verdict, releaseId, summary } = await rehearse(store, plan, { trigger, rehearsalId: id });
      Q.finish.run('done', verdict, releaseId, JSON.stringify(summary), id);
      const fresh = q.storeById.get(store.id);
      if (fresh) await sendMail(rehearsalMail(fresh, plan, { trigger }, summary)).catch(() => {});
    } catch (e) {
      console.error('sale rehearsal failed', e);
      Q.finish.run('error', null, null, JSON.stringify({ error: 'The pre-check could not finish. Try again in a few minutes.' }), id);
    } finally { running.delete(plan.id); }
  })();
  return id;
}

/** Called by the scheduler: rehearses each upcoming sale once a day until it starts. */
export function dueSaleRehearsals(now = Date.now()) {
  for (const row of Q.upcoming.all(now)) {
    if (running.has(row.id)) continue;
    const store = q.storeById.get(row.store_id);
    if (!store || !store.monitoring || blockReason(entitlements(store.user_id), store.id)) continue;
    const last = Q.last.get(row.id);
    if (last?.status === 'running') continue;
    if (rehearsalDue(parse(row), sqlMs(last?.created_at), now)) startRehearsal(store, row, 'schedule');
  }
}

// ---------- routes ----------
export function salePlanRoutes(app, { requireUser, ownStore, refuse }) {
  const ownPlan = (req, res) => {
    const s = ownStore(req, res);
    if (!s) return null;
    const row = Q.byId.get(Number(req.params.pid));
    if (!row || row.store_id !== s.id) { res.status(404).json({ error: 'Sale plan not found.' }); return null; }
    return { s, row };
  };
  const usable = (s, res) => {
    const why = blockReason(entitlements(s.user_id), s.id);
    if (why) { refuse(res, why); return false; }
    return true;
  };

  app.get('/api/stores/:id/sale-plans', requireUser, (req, res) => {
    const s = ownStore(req, res);
    if (!s) return;
    const ent = entitlements(s.user_id);
    res.json({ plans: Q.byStore.all(s.id).map(planView), limit: planLimit(ent), markets: MARKETS, shopify: !!shopify.shopForStore(s.id) });
  });
  app.post('/api/stores/:id/sale-plans', requireUser, (req, res) => {
    const s = ownStore(req, res);
    if (!s || !usable(s, res)) return;
    const ent = entitlements(s.user_id);
    const open = Q.byStore.all(s.id).filter((r) => r.ends_at > Date.now()).length;
    if (open >= planLimit(ent)) return refuse(res, `Your plan covers ${planLimit(ent)} upcoming sale plans per store. Remove one that you no longer need${has(ent, 'publish') ? '' : ', or upgrade for more'}.`);
    let c;
    try { c = cleanPlan(req.body || {}, { markets: MARKET_CODES }); } catch (e) { return res.status(400).json({ error: e.message }); }
    const id = Number(Q.insert.run(s.id, ...toRow(c)).lastInsertRowid);
    res.json({ plan: planView(Q.byId.get(id)) });
  });
  app.get('/api/stores/:id/sale-plans/:pid', requireUser, (req, res) => {
    const o = ownPlan(req, res);
    if (!o) return;
    const history = Q.rehearsals.all(o.row.id, 30).map((r) => rehearsalView(r));
    const latest = Q.last.get(o.row.id);
    res.json({ plan: planView(o.row), latest: rehearsalView(latest, { full: true }), history });
  });
  app.patch('/api/stores/:id/sale-plans/:pid', requireUser, (req, res) => {
    const o = ownPlan(req, res);
    if (!o || !usable(o.s, res)) return;
    const cur = planView(o.row);
    let c;
    try { c = cleanPlan(req.body || {}, { markets: MARKET_CODES, base: { ...cur } }); } catch (e) { return res.status(400).json({ error: e.message }); }
    Q.update.run(...toRow(c), o.row.id);
    res.json({ plan: planView(Q.byId.get(o.row.id)) });
  });
  app.delete('/api/stores/:id/sale-plans/:pid', requireUser, (req, res) => {
    const o = ownPlan(req, res);
    if (!o) return;
    Q.del.run(o.row.id);
    res.json({ ok: true });
  });
  app.post('/api/stores/:id/sale-plans/:pid/rehearse', requireUser, (req, res) => {
    const o = ownPlan(req, res);
    if (!o || !usable(o.s, res)) return;
    if (running.has(o.row.id)) return res.status(409).json({ error: 'A pre-check of this sale is already running.' });
    if (Q.todayManual.get(o.s.id).n >= REHEARSALS_PER_DAY) return refuse(res, `You’ve rehearsed sales for this store ${REHEARSALS_PER_DAY} times in the last 24 hours, the most allowed. The daily pre-check keeps running.`, 429);
    if (o.row.ends_at <= Date.now()) return res.status(400).json({ error: 'This sale has ended.' });
    res.json({ id: startRehearsal(o.s, o.row, 'manual') });
  });
  app.get('/api/stores/:id/sale-plans/:pid/rehearsals/:rid', requireUser, (req, res) => {
    const o = ownPlan(req, res);
    if (!o) return;
    const r = Q.rehearsal.get(Number(req.params.rid));
    if (!r || r.plan_id !== o.row.id) return res.status(404).json({ error: 'Pre-check not found.' });
    res.json(rehearsalView(r, { full: true }));
  });
}
