/**
 * Sale rehearsal, part 2: the go-live burst.
 *
 * When a planned sale starts, we check it often: every 5 minutes for the first hour, then every 15 minutes
 * (less often on plans without Safe to publish). Each check looks at the live store the way a shopper would:
 * is the sale theme live, does every product in the sale show its sale price, is the banner there, do the
 * codes take the right amount off in a real cart, and is free shipping set up. Each check also starts the
 * store's shopping journey (checkout included) when nothing else is running for the store.
 * The owner gets an email (and Slack) within minutes when something breaks, and again when it's fixed.
 */
import { db, q } from './db.js';
import { config } from './config.js';
import { newContext, gotoStore, settle, themeOf } from './engine/browser.js';
import { runDiscounts } from './engine/discount.js';
import { entitlements, has, blockReason } from './license.js';
import { sendMail, sendSlack } from './alerts.js';
import * as shopify from './shopify.js';
import { parse, phase, storeProducts, collectionIds, scheduledDiscounts } from './sale-plans.js';
import { automaticFor, compareDiscounts, burstDue, burstEvery, livePrices, baselineFrom, liveChanges, utcToZoned } from './sale-math.js';

const Q = {
  plan: db.prepare('SELECT * FROM sale_plans WHERE id = ?'),
  live: db.prepare('SELECT * FROM sale_plans WHERE starts_at <= ? AND ends_at > ? ORDER BY starts_at'),
  insert: db.prepare('INSERT INTO sale_live_checks (plan_id, store_id, trigger) VALUES (?, ?, ?)'),
  finish: db.prepare("UPDATE sale_live_checks SET status = ?, verdict = ?, run_id = ?, summary_json = ?, finished_at = datetime('now') WHERE id = ?"),
  byId: db.prepare('SELECT * FROM sale_live_checks WHERE id = ?'),
  last: db.prepare('SELECT * FROM sale_live_checks WHERE plan_id = ? ORDER BY id DESC LIMIT 1'),
  lastDone: db.prepare("SELECT * FROM sale_live_checks WHERE plan_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1"),
  list: db.prepare('SELECT * FROM sale_live_checks WHERE plan_id = ? ORDER BY id DESC LIMIT ?'),
  manualToday: db.prepare("SELECT COUNT(*) AS n FROM sale_live_checks WHERE store_id = ? AND trigger = 'manual' AND created_at > datetime('now', '-1 day')"),
  // Normal prices from the last pre-check that worked them out (before the sale started).
  baseline: db.prepare("SELECT summary_json FROM sale_rehearsals WHERE plan_id = ? AND status = 'done' AND summary_json LIKE '%\"rows\"%' ORDER BY id DESC LIMIT 1"),
};
const MANUAL_PER_DAY = 30;
const running = new Set(); // plan ids being checked in this process
const sqlMs = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').getTime() : null);
const burstKind = (ent) => (has(ent, 'publish') ? 'full' : 'basic');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const listOf = (rows, fmt) => rows.slice(0, 5).map(fmt).join('; ') + (rows.length > 5 ? `; and ${rows.length - 5} more` : '');
const label = (x) => `${x.product}${x.variant ? ` (${x.variant})` : ''}`;

export function liveView(r, { full = false } = {}) {
  if (!r) return null;
  const sum = r.summary_json ? JSON.parse(r.summary_json) : null;
  const v = { id: r.id, trigger: r.trigger, status: r.status, verdict: r.verdict, runId: r.run_id, createdAt: r.created_at, finishedAt: r.finished_at, counts: sum?.counts || null, error: sum?.error || null };
  if (full) v.summary = sum;
  return v;
}

// ---------- one live check ----------
async function checkLive(store, plan, { trigger }) {
  const findings = [];
  const add = (key, area, level, title, detail = '', fix = null) => findings.push({ key, area, level, title, detail, fix });
  const now = Date.now();
  const shop = shopify.shopForStore(store.id);

  let discounts = null;
  if (shop) {
    try { discounts = await scheduledDiscounts(shop.shop); } catch { add('shopify', 'codes', 'warn', 'We couldn’t read your discounts from Shopify', 'Shopify didn’t answer just now. The next check tries again.'); }
  }

  let prices = null, isShopify = !!shop;
  const ctx = await newContext({ mobile: true });
  try {
    // The live homepage, on a phone: which theme is live, and is the banner there.
    const page = await ctx.newPage();
    let homeText = '', theme = null, locked = false;
    try {
      const nav = await gotoStore(page, store.url, { password: store.storefront_password });
      locked = !!nav.locked;
      if (!locked) {
        await settle(page, 500);
        homeText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        theme = await themeOf(page);
        if (theme) isShopify = true;
      }
    } catch { /* reported below */ }
    if (locked) add('locked', 'store', 'fail', 'Your store asks shoppers for a password', 'The sale has started, but the store is still password protected, so shoppers can’t get in.', 'Remove the password in Online Store → Preferences, or add the storefront password in Store settings if this is intended.');
    else if (!homeText) add('home', 'store', 'warn', 'We couldn’t open your homepage', 'It didn’t load in time. The next check tries again.');
    else {
      if (plan.themeId) {
        if (!theme) add('theme', 'theme', 'warn', 'We couldn’t tell which theme is live', 'Your store doesn’t say which theme it shows.');
        else if (String(theme.id) === String(plan.themeId)) add('theme', 'theme', 'pass', 'Your sale theme is live', theme.name ? `Shoppers see “${theme.name}”.` : '');
        else add('theme', 'theme', 'fail', 'Your sale theme isn’t live', `Shoppers still see “${theme.name || `theme ${theme.id}`}”, not the sale theme.`, 'Publish the sale theme in Online Store → Themes, or check the app that was meant to publish it at the start.');
      }
      if (plan.banner) {
        const want = plan.banner.toLowerCase().replace(/\s+/g, ' ');
        if (homeText.toLowerCase().replace(/\s+/g, ' ').includes(want)) add('banner', 'banner', 'pass', 'The sale banner is on your homepage', `“${plan.banner}”.`);
        else add('banner', 'banner', 'fail', 'The sale banner is missing', `Shoppers on a phone don’t see “${plan.banner}” on your homepage.`, 'Turn on the banner in the theme editor, or correct the text in the sale plan.');
      }
    }

    // Every product in the sale: does it show the sale price now?
    if (plan.rules.length && !locked) {
      const products = await storeProducts(ctx.request, store.url);
      if (!products.length) add('products', 'prices', 'warn', 'We couldn’t read your products', 'Your store’s product list didn’t answer, so sale prices weren’t checked this time.');
      else {
        const cols = new Map();
        for (const r of plan.rules.filter((x) => x.scope === 'collection')) {
          const h = r.target.toLowerCase();
          if (!cols.has(h)) cols.set(h, await collectionIds(ctx.request, store.url, h));
        }
        const viaCart = new Set();
        plan.rules.forEach((r, i) => { if (discounts && automaticFor(r, plan, discounts)) viaCart.add(i); });
        let baseline = new Map();
        try { baseline = baselineFrom(JSON.parse(Q.baseline.get(plan.id)?.summary_json || '{}').prices?.rows || []); } catch {}
        prices = livePrices(products, plan.rules, (h, id) => !!cols.get(h)?.has(id), baseline, viaCart);
        const by = (s) => prices.rows.filter((x) => x.state === s);
        const normal = by('normal'), wrong = by('wrong'), sold = by('soldout'), cart = by('cart');
        if (normal.length) add('prices.normal', 'prices', 'fail', `${plural(normal.length, 'price')} still at the normal price`, listOf(normal, (x) => `${label(x)}: ${x.shown}, should be ${x.expected}`), 'The sale price didn’t switch on for these. Check the price change, the discount, or the app that was meant to start the sale.');
        if (wrong.length) add('prices.wrong', 'prices', 'fail', `${plural(wrong.length, 'price')} different from your plan`, listOf(wrong, (x) => `${label(x)}: shows ${x.shown}, your plan says ${x.expected}`), 'Correct these prices, or the discount in your plan if the plan is out of date.');
        if (!normal.length && !wrong.length && by('ok').length) add('prices', 'prices', 'pass', `Sale prices are right on ${plural(new Set(by('ok').map((x) => x.handle)).size, 'product')}`, `${plural(by('ok').length, 'price')} checked against your plan.`);
        if (cart.length) add('prices.cart', 'prices', 'pass', `${plural(cart.length, 'price')} taken off in the cart by Shopify`, 'An automatic Shopify discount gives these their sale price at checkout, so the product page keeps the normal price.');
        if (sold.length) add('soldout', 'prices', 'warn', `${plural(sold.length, 'sale item')} sold out`, listOf(sold, label), 'Restock them, or take them out of sale collections and ads so shoppers don’t land on them.');
      }
    }

    // Codes: tried in a real cart, the way a shopper would.
    if (plan.codes.length && !locked) {
      if (discounts) {
        for (const c of plan.codes) {
          const d = discounts.find((x) => x.codes?.some((k) => k.toLowerCase() === c.code.toLowerCase()));
          const s = d?.startsAt ? new Date(d.startsAt).getTime() : null, e = d?.endsAt ? new Date(d.endsAt).getTime() : null;
          if (d && ((s && s > now) || (e && e <= now))) add(`code.${c.code.toLowerCase()}.dates`, 'codes', 'fail', `Discount code ${c.code} isn’t active in Shopify`, s && s > now ? `It starts at ${utcToZoned(s, plan.timeZone).replace('T', ' ')} (${plan.timeZone}), after your sale started.` : 'It has already ended.', 'Change its dates in Shopify admin → Discounts.');
        }
      }
      const out = [];
      const rec = { step() {}, add(c) { out.push(c); } };
      const tryPage = await ctx.newPage();
      try {
        await gotoStore(tryPage, store.url, { password: store.storefront_password });
        const list = (await storeProducts(ctx.request, store.url)).slice(0, 6).map((p) => ({ handle: p.handle }));
        await runDiscounts({ page: tryPage, rec, origin: new URL(tryPage.url()).origin, info: { isShopify, products: list }, password: store.storefront_password, codes: plan.codes.slice(0, 5), shot: async () => null });
      } catch { /* each code is reported below */ }
      finally { await tryPage.close().catch(() => {}); }
      for (const c of plan.codes.slice(0, 5)) {
        const r = out.find((x) => x.title === `Discount code ${c.code} works`);
        const key = `code.${c.code.toLowerCase()}`;
        if (!r || r.status === 'skip') add(key, 'codes', 'warn', `We couldn’t try discount code ${c.code}`, r?.detail || 'The cart didn’t answer. The next check tries again.');
        else if (r.status === 'pass') add(key, 'codes', 'pass', `Discount code ${c.code} works`, r.detail);
        else add(key, 'codes', r.status === 'warn' ? 'warn' : 'fail', r.status === 'warn' ? `Discount code ${c.code} needs a bigger cart` : `Discount code ${c.code} doesn’t work`, r.detail, r.fix || null);
      }
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  // Free shipping: is a Shopify free-shipping discount running at the planned amount.
  if (discounts && plan.freeShipping != null) {
    for (const f of compareDiscounts({ ...plan, codes: [] }, discounts, { now })) findings.push({ ...f, key: 'shipping' });
  }

  // The shopping journey on the live store (checkout included), unless something is already running.
  let runId = null;
  if (!q.activeRunForStore.get(store.id)) {
    const { startRun } = await import('./scheduler.js');
    runId = startRun({ storeId: store.id, origin: store.url, kind: 'journeys', password: store.storefront_password, trigger: 'sale' });
  }

  const counts = { fail: findings.filter((f) => f.level === 'fail').length, warn: findings.filter((f) => f.level === 'warn').length, pass: findings.filter((f) => f.level === 'pass').length };
  const verdict = counts.fail ? 'fail' : counts.warn ? 'warn' : 'ok';
  const summary = { verdict, counts, findings, journey: runId ? 'started' : 'busy', prices: prices ? { counts: prices.counts, rows: prices.rows.slice(0, 300), more: Math.max(0, prices.rows.length - 300) } : null, trigger };
  return { verdict, runId, summary };
}

// ---------- alerts: only when something breaks or gets fixed ----------
function liveMail(store, plan, changes, checkId) {
  const name = store.name || new URL(store.url).host;
  const link = `${config.baseUrl}/app#/s/${store.id}/sales/${plan.id}`;
  const line = (f) => `- ${f.title}${f.detail ? `\n  ${f.detail}` : ''}${f.fix ? `\n  What to do: ${f.fix}` : ''}`;
  const { broke, fixed, still } = changes;
  const subject = broke.length
    ? `Sale problem on ${name}: ${broke[0].title}${broke.length > 1 ? ` (+${broke.length - 1} more)` : ''}`
    : `Fixed during ${plan.name} on ${name}: ${fixed.map((f) => f.title).join(', ')}`;
  const text = [
    `${plan.name} is live on ${name}. ${broke.length ? 'Something shoppers rely on broke:' : 'Good news: this is working again.'}`,
    broke.length ? broke.map(line).join('\n') : '',
    fixed.length ? `\nFixed now:\n${fixed.map((f) => `- ${f.title}`).join('\n')}` : '',
    still.length ? `\nStill to fix:\n${still.map((f) => `- ${f.title}`).join('\n')}` : '',
    `\nSee the sale live: ${link}`,
    '\nWe keep checking the sale every few minutes during its first hours, and email you only when something changes.',
  ].filter(Boolean).join('\n');
  return { subject, text };
}

/** Starts a live check of a running sale. Returns its id; the work carries on in the background. */
export function startLiveCheck(store, planRow, trigger = 'schedule') {
  const plan = parse(planRow);
  const id = Number(Q.insert.run(plan.id, store.id, trigger).lastInsertRowid);
  running.add(plan.id);
  (async () => {
    try {
      const prev = Q.lastDone.get(plan.id);
      const prevFails = prev?.summary_json ? JSON.parse(prev.summary_json).findings.filter((f) => f.level === 'fail').map((f) => ({ key: f.key, title: f.title })) : [];
      const { verdict, runId, summary } = await checkLive(store, plan, { trigger });
      Q.finish.run('done', verdict, runId, JSON.stringify(summary), id);
      const changes = liveChanges(prevFails, summary.findings);
      if (changes.broke.length || changes.fixed.length) {
        const fresh = q.storeById.get(store.id);
        if (fresh) {
          const { subject, text } = liveMail(fresh, plan, changes, id);
          const to = fresh.alert_email || q.userById.get(fresh.user_id)?.email;
          const slack = has(entitlements(fresh.user_id), 'slack') ? fresh.slack_webhook : null;
          await Promise.allSettled([sendMail({ to, subject, text }), sendSlack(slack, `*${subject}*\n${text}`)]);
        }
      }
    } catch (e) {
      console.error('sale live check failed', e);
      Q.finish.run('error', null, null, JSON.stringify({ error: 'The check could not finish. The next one tries again.' }), id);
    } finally { running.delete(plan.id); }
  })();
  return id;
}

/** Called by the scheduler every 5 minutes: the go-live burst for every sale that is running. */
export function dueSaleBursts(now = Date.now()) {
  const started = [];
  for (const row of Q.live.all(now, now)) {
    if (running.has(row.id)) continue;
    const store = q.storeById.get(row.store_id);
    if (!store || !store.monitoring) continue;
    const ent = entitlements(store.user_id);
    if (blockReason(ent, store.id)) continue;
    const last = Q.last.get(row.id);
    if (last?.status === 'running') continue;
    if (burstDue(parse(row), sqlMs(last?.created_at), now, burstKind(ent))) started.push(startLiveCheck(store, row, 'schedule'));
  }
  return started;
}

// ---------- routes ----------
export function saleLiveRoutes(app, { requireUser, ownStore, refuse }) {
  const ownPlan = (req, res) => {
    const s = ownStore(req, res);
    if (!s) return null;
    const row = Q.plan.get(Number(req.params.pid));
    if (!row || row.store_id !== s.id) { res.status(404).json({ error: 'Sale plan not found.' }); return null; }
    return { s, row };
  };
  app.get('/api/stores/:id/sale-plans/:pid/live', requireUser, (req, res) => {
    const o = ownPlan(req, res);
    if (!o) return;
    const p = parse(o.row);
    const ent = entitlements(o.s.user_id);
    const kind = burstKind(ent);
    const every = burstEvery(p, Date.now(), kind);
    const last = Q.last.get(p.id);
    res.json({
      phase: phase(p), every, kind,
      nextInMin: every && last ? Math.max(0, Math.round(every - (Date.now() - sqlMs(last.created_at)) / 60000)) : every ? 0 : null,
      latest: liveView(Q.lastDone.get(p.id), { full: true }), running: last?.status === 'running' ? liveView(last) : null,
      history: Q.list.all(p.id, 40).map((r) => liveView(r)),
    });
  });
  app.post('/api/stores/:id/sale-plans/:pid/live-check', requireUser, (req, res) => {
    const o = ownPlan(req, res);
    if (!o) return;
    const why = blockReason(entitlements(o.s.user_id), o.s.id);
    if (why) return refuse(res, why);
    const p = parse(o.row);
    if (phase(p) !== 'live') return res.status(400).json({ error: phase(p) === 'upcoming' ? 'The sale hasn’t started yet. Rehearse it instead.' : 'This sale has ended.' });
    if (running.has(p.id)) return res.status(409).json({ error: 'The sale is being checked right now.' });
    if (Q.manualToday.get(o.s.id).n >= MANUAL_PER_DAY) return refuse(res, `You’ve checked sales for this store ${MANUAL_PER_DAY} times in the last 24 hours, the most allowed. The automatic checks keep running.`, 429);
    res.json({ id: startLiveCheck(o.s, o.row, 'manual') });
  });
  app.get('/api/stores/:id/sale-plans/:pid/live-checks/:cid', requireUser, (req, res) => {
    const o = ownPlan(req, res);
    if (!o) return;
    const r = Q.byId.get(Number(req.params.cid));
    if (!r || r.plan_id !== o.row.id) return res.status(404).json({ error: 'Check not found.' });
    res.json(liveView(r, { full: true }));
  });
}
