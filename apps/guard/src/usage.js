/**
 * Runner visibility and usage, for the founder console (read-only).
 *
 *   runnerReport  per runner: checks and browser minutes per day, failures, checks lost when the runner went
 *                 quiet, what it is running now
 *   recentRuns    the latest checks with their runner, queued/started/finished times, wait, duration, retry flag
 *   usageReport   browser minutes per store and per account for a day or a month, by plan, with an estimated
 *                 cost next to what the customer pays
 *
 * Browser minutes = started_at → finished_at (or now while running), the same measure as the Capacity page.
 * Per-runner numbers go to the day the check started on (UTC). Usage for a day or month counts the part of each
 * check that falls inside it.
 *
 * Store owners never see any of this: runner names stay in the founder console.
 */
import { db } from './db.js';
import { ensureLicense, getPlan, priceOf, stateOf, setting } from './license.js';

const ms = (s) => (s ? new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z')).getTime() : null);
const sqlTime = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Rough exchange rates to euros, only to put an estimated cost next to a price in another currency.
 * Labelled "estimated" everywhere it is shown.
 */
export const EUR_PER = { EUR: 1, USD: 0.92, GBP: 1.17, INR: 0.011, AUD: 0.6, CAD: 0.67, SGD: 0.69, AED: 0.25 };
export const convert = (amount, from, to) => (EUR_PER[from] && EUR_PER[to] ? (amount * EUR_PER[from]) / EUR_PER[to] : null);

/** What one browser hour costs (founder setting), e.g. { perHour: 0.01, currency: 'EUR' }. */
export function costRate() {
  return { perHour: Number(setting('browser_hour_cost')) || 0, currency: setting('cost_currency') || 'EUR' };
}

/** Browser time of a run as [start, end] in ms, or null if it never got a browser. */
function span(r, now) {
  const a = ms(r.started_at);
  if (a == null) return null;
  const b = ms(r.finished_at) ?? (r.status === 'running' ? now : null);
  return b == null ? null : [a, Math.max(a, Math.min(b, now))];
}
const overlapMin = ([a, b], from, to) => Math.max(0, Math.min(b, to) - Math.max(a, from)) / 60000;

const RUN_COLS = `r.id, r.seq, r.kind, r.trigger, r.status, r.created_at, r.due_at, r.started_at, r.finished_at, r.runner_id, r.retried, r.store_id,
  s.name AS store_name, s.url AS store_url, s.user_id, u.email, rn.name AS runner_name`;
const RUN_FROM = 'runs r LEFT JOIN stores s ON s.id = r.store_id LEFT JOIN users u ON u.id = s.user_id LEFT JOIN runners rn ON rn.id = r.runner_id';

/** Runs that had a browser open at some point in [from, to). */
function runsIn(from, to) {
  return db.prepare(`SELECT ${RUN_COLS} FROM ${RUN_FROM}
    WHERE r.started_at IS NOT NULL AND r.started_at < ? AND (r.finished_at IS NULL OR r.finished_at >= ?)`).all(sqlTime(to), sqlTime(from));
}

/** Seconds from when a check was queued (or due, for scheduled checks) until it got a browser. */
export function waitSec(r) {
  const s = ms(r.started_at), q = ms(r.due_at) ?? ms(r.created_at);
  return s == null || q == null ? null : Math.max(0, Math.round((s - q) / 1000));
}
/** Seconds the check had a browser. */
export function tookSec(r) {
  const s = ms(r.started_at), f = ms(r.finished_at);
  return s == null || f == null ? null : Math.max(0, Math.round((f - s) / 1000));
}

export const FREE = 'Free website checks';
const KIND = { free: 'Free website check', journeys: 'Shopping check', full: 'Full check' };
export const kindLabel = (r) => (r.trigger === 'release' ? 'Safe to publish' : KIND[r.kind] || r.kind);

/**
 * Per runner, the last `days` days (UTC). `states`: runnerStates() from the queue (status, slots, used, healthy);
 * `current`: currentChecks() from the queue.
 */
export function runnerReport({ now = Date.now(), days = 7, states = [], current = [] } = {}) {
  const today = new Date(dayOf(now) + 'T00:00:00Z').getTime();
  const from = today - (days - 1) * 864e5;
  const dayList = Array.from({ length: days }, (_, i) => dayOf(from + i * 864e5)).reverse();
  const blank = () => Object.fromEntries(dayList.map((d) => [d, { date: d, checks: 0, minutes: 0, failed: 0, lost: 0 }]));
  const per = new Map(states.map((r) => [r.id, blank()]));
  const rows = db.prepare(`SELECT r.id, r.status, r.started_at, r.finished_at, r.runner_id FROM runs r
    WHERE r.runner_id IS NOT NULL AND r.started_at >= ?`).all(sqlTime(from));
  for (const r of rows) {
    const d = per.get(r.runner_id)?.[dayOf(ms(r.started_at))];
    if (!d) continue;
    d.checks++;
    const sp = span(r, now);
    if (sp) d.minutes += (sp[1] - sp[0]) / 60000;
    if (r.status === 'error') d.failed++;
  }
  // Checks a runner lost (it went quiet or restarted); they were retried elsewhere, so they don't count as its checks.
  for (const l of db.prepare("SELECT runner_id, COALESCE(leased_at, assigned_at) AS t FROM runner_leases WHERE state = 'lost' AND finished_at >= ?").all(sqlTime(from))) {
    const d = per.get(l.runner_id)?.[dayOf(ms(l.t))];
    if (d) d.lost++;
  }
  const storeName = db.prepare('SELECT name, url FROM stores WHERE id = ?');
  const runRow = db.prepare('SELECT started_at, created_at, kind, trigger FROM runs WHERE id = ?');
  return states.map((r) => {
    const series = dayList.map((d) => { const x = per.get(r.id)[d]; return { ...x, minutes: round1(x.minutes) }; });
    const sum = (k) => round1(series.reduce((n, x) => n + x[k], 0));
    const mine = current.filter((c) => c.runnerId === r.id).map((c) => {
      const run = runRow.get(c.runId) || {};
      const st = c.storeId ? storeName.get(c.storeId) : null;
      return { runId: c.runId, store: st ? st.name || st.url : null, kind: kindLabel({ kind: c.kind, trigger: c.release ? 'release' : run.trigger }), since: run.started_at || null, waiting: !run.started_at };
    });
    return {
      id: r.id, name: r.name, kind: r.kind, status: r.status, healthy: r.healthy, slots: r.slots, used: r.used, tags: r.tags,
      lastSeen: r.kind === 'main' ? null : r.last_seen,
      current: mine,
      today: series[0],
      totals: { checks: sum('checks'), minutes: sum('minutes'), failed: sum('failed'), lost: sum('lost') },
      days: series,
    };
  });
}

/** The latest checks with the runner that ran them, for the founder console. */
export function recentRuns({ limit = 50, runnerId = null } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const rows = runnerId
    ? db.prepare(`SELECT ${RUN_COLS} FROM ${RUN_FROM} WHERE r.runner_id = ? ORDER BY r.id DESC LIMIT ?`).all(Number(runnerId), lim)
    : db.prepare(`SELECT ${RUN_COLS} FROM ${RUN_FROM} ORDER BY r.id DESC LIMIT ?`).all(lim);
  return rows.map((r) => ({
    id: r.id, kind: kindLabel(r), trigger: r.trigger, status: r.status,
    store: r.store_id ? { id: r.store_id, name: r.store_name || r.store_url, account: r.email } : null,
    runner: r.runner_name || null,
    queuedAt: r.created_at, dueAt: r.due_at, startedAt: r.started_at, finishedAt: r.finished_at,
    waitSec: waitSec(r), tookSec: tookSec(r), retried: !!r.retried,
  }));
}

/** [from, to) in ms for a 'day' (YYYY-MM-DD) or 'month' (YYYY-MM), UTC. Throws on a bad date. */
export function periodRange(period, date, now = Date.now()) {
  if (period === 'day') {
    const d = date || dayOf(now);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || dayOf(Date.parse(d + 'T00:00:00Z') || 0) !== d) throw new Error('Pick a day as YYYY-MM-DD');
    const a = Date.parse(d + 'T00:00:00Z');
    return { period, date: d, from: a, to: a + 864e5 };
  }
  if (period === 'month') {
    const m = date || dayOf(now).slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new Error('Pick a month as YYYY-MM');
    const a = Date.parse(m + '-01T00:00:00Z');
    const n = new Date(a); n.setUTCMonth(n.getUTCMonth() + 1);
    return { period, date: m, from: a, to: n.getTime() };
  }
  throw new Error('Period must be day or month');
}

/** Monthly equivalent of what a licence pays, in its currency (major units), or 0. */
function monthlyPrice(l, plan) {
  const st = stateOf(l);
  if (!['active', 'grace'].includes(st)) return 0;
  const p = priceOf(l, plan);
  if (!p) return 0;
  return (p.period === 'year' ? p.amount / 12 : p.amount) / 100;
}

/**
 * Browser minutes per account and store in a day or month, by plan, with estimated cost.
 * Cost = minutes × the founder's cost per browser hour. "Pays" is the customer's monthly price (for a day,
 * one day's share of it), converted to the cost currency with rough rates when the currencies differ.
 */
export function usageReport({ now = Date.now(), period = 'month', date = null } = {}) {
  const range = periodRange(period, date, now);
  const { from, to } = range;
  const end = Math.min(to, now);
  const rate = costRate();
  const cost = (min) => round4((min / 60) * rate.perHour);
  const dayCount = Math.round((to - from) / 864e5);
  const share = period === 'day' ? 1 / new Date(Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth() + 1, 0)).getUTCDate() : 1;

  const accounts = new Map();
  const free = { minutes: 0, checks: 0 };
  const days = Array.from({ length: dayCount }, (_, i) => ({ date: dayOf(from + i * 864e5), minutes: 0, byPlan: {} }));
  const planOf = new Map();
  const plan = (userId) => {
    if (!planOf.has(userId)) {
      let v = { name: 'Unknown', key: null, license: null, plan: null };
      try { const l = ensureLicense(userId); const p = getPlan(l.plan_key); v = { name: p?.name || l.plan_key, key: l.plan_key, license: l, plan: p }; } catch {}
      planOf.set(userId, v);
    }
    return planOf.get(userId);
  };

  for (const r of runsIn(from, end)) {
    const sp = span(r, now);
    if (!sp) continue;
    const min = overlapMin(sp, from, end);
    const startedHere = sp[0] >= from && sp[0] < to;
    const perDay = (label) => {
      for (const d of days) {
        const a0 = Date.parse(d.date + 'T00:00:00Z');
        const m = overlapMin(sp, a0, Math.min(a0 + 864e5, end));
        if (m > 0) { d.minutes += m; d.byPlan[label] = (d.byPlan[label] || 0) + m; }
      }
    };
    if (!r.user_id) { free.minutes += min; if (startedHere) free.checks++; perDay(FREE); continue; }
    const p = plan(r.user_id);
    perDay(p.name);
    let a = accounts.get(r.user_id);
    if (!a) accounts.set(r.user_id, (a = { userId: r.user_id, email: r.email, plan: p.name, planKey: p.key, minutes: 0, checks: 0, stores: new Map() }));
    a.minutes += min; if (startedHere) a.checks++;
    let s = a.stores.get(r.store_id);
    if (!s) a.stores.set(r.store_id, (s = { id: r.store_id, name: r.store_name || r.store_url, url: r.store_url, minutes: 0, checks: 0 }));
    s.minutes += min; if (startedHere) s.checks++;
  }

  const byPlan = {};
  const list = [...accounts.values()].map((a) => {
    const p = plan(a.userId);
    const lic = p.license;
    const price = lic && p.plan ? monthlyPrice(lic, p.plan) * share : 0;
    const priceCur = lic?.currency || rate.currency;
    const priceInCost = price ? convert(price, priceCur, rate.currency) : 0;
    const c = cost(a.minutes);
    const row = {
      userId: a.userId, email: a.email, plan: a.plan, planKey: a.planKey, state: lic ? stateOf(lic) : null, billing: lic?.billing || null,
      minutes: round1(a.minutes), checks: a.checks, cost: c,
      pays: price ? { amount: round2(price), currency: priceCur, inCostCurrency: priceInCost == null ? null : round2(priceInCost) } : null,
      costPct: price && priceInCost ? Math.round((c / priceInCost) * 1000) / 10 : null,
      stores: [...a.stores.values()].map((s) => ({ ...s, minutes: round1(s.minutes), cost: cost(s.minutes) })).sort((x, y) => y.minutes - x.minutes),
    };
    const b = (byPlan[a.plan] ||= { plan: a.plan, accounts: 0, stores: 0, minutes: 0, checks: 0, cost: 0, pays: 0 });
    b.accounts++; b.stores += row.stores.length; b.minutes += a.minutes; b.checks += a.checks; b.pays += priceInCost || 0;
    return row;
  }).sort((x, y) => y.minutes - x.minutes);

  const plans = Object.values(byPlan).map((b) => ({ ...b, minutes: round1(b.minutes), cost: cost(b.minutes), pays: round2(b.pays), costPct: b.pays ? Math.round((cost(b.minutes) / b.pays) * 1000) / 10 : null }))
    .sort((x, y) => y.minutes - x.minutes);
  const total = list.reduce((n, a) => n + a.minutes, 0) + free.minutes;
  return {
    ...range, from: sqlTime(from), to: sqlTime(to),
    rate,
    totals: { minutes: round1(total), cost: cost(total), accounts: list.length },
    plans,
    accounts: list,
    freeChecks: { minutes: round1(free.minutes), checks: free.checks, cost: cost(free.minutes) },
    days: period === 'month' ? days.map((d) => ({ date: d.date, minutes: round1(d.minutes), byPlan: Object.fromEntries(Object.entries(d.byPlan).map(([k, v]) => [k, round1(v)])) })) : [],
  };
}
