/**
 * The store scorecard: Buyability (the headline), time to fix, revenue at risk,
 * catalog accuracy, and changes checked before publishing. Computed from runs, alerts and publish checks.
 */
import { db } from './db.js';
import { storeConfig } from './scheduler.js';
import { GROUPS, MARKETS, groupOf } from './engine/catalog.js';

// Checks that decide whether a customer could buy. An incident on one of these means lost sales.
const CORE = ['fn.home', 'fn.pdp', 'fn.atc', 'fn.cart', 'fn.checkout'];

const runsSince = db.prepare(
  "SELECT verdict, created_at FROM runs WHERE store_id = ? AND status = 'done' AND (trigger IS NULL OR trigger != 'release') AND created_at > datetime('now', ?) ORDER BY id"
);
const alertsSince = db.prepare("SELECT check_id, state, created_at FROM alerts WHERE store_id = ? AND created_at > datetime('now', '-60 days') ORDER BY id");
const openCore = db.prepare(`SELECT check_id, since FROM check_state WHERE store_id = ? AND status = 'failing' AND check_id IN (${CORE.map(() => '?').join(',')})`);
const lastCatalog = db.prepare("SELECT result_json FROM runs WHERE store_id = ? AND status = 'done' AND kind = 'full' AND (trigger IS NULL OR trigger != 'release') AND result_json LIKE '%\"catalog\":{%' ORDER BY id DESC LIMIT 1");
const lastRegional = db.prepare("SELECT id, created_at, result_json FROM runs WHERE store_id = ? AND status = 'done' AND kind = 'full' AND (trigger IS NULL OR trigger != 'release') AND (result_json LIKE '%\"de.%' OR result_json LIKE '%\"eu.%' OR result_json LIKE '%\"ax.%' OR result_json LIKE '%\"us.%') ORDER BY id DESC LIMIT 10");
const releasesSince = db.prepare("SELECT verdict FROM releases WHERE store_id = ? AND status = 'done' AND created_at > datetime('now', '-30 days')");

const ts = (s) => new Date(s.replace(' ', 'T') + 'Z').getTime();
// Blocked (bot protection) and locked (password) runs couldn't test the store, so they don't count either way.
const counted = (r) => ['healthy', 'warning', 'critical'].includes(r.verdict);

function buyability(storeId, window) {
  const runs = runsSince.all(storeId, window).filter(counted);
  if (!runs.length) return { pct: null, runs: 0 };
  const ok = runs.filter((r) => r.verdict !== 'critical').length;
  return { pct: Math.round((ok / runs.length) * 1000) / 10, runs: runs.length };
}

/** Day-by-day Buyability for the last `days` days, oldest first; null where no checks ran. */
function daily(storeId, days = 30) {
  const runs = runsSince.all(storeId, `-${days} days`).filter(counted);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    const list = runs.filter((r) => r.created_at.slice(0, 10) === day);
    out.push({ day, pct: list.length ? Math.round((list.filter((r) => r.verdict !== 'critical').length / list.length) * 100) : null });
  }
  return out;
}

/** Incidents on buying-critical checks: when each started and ended (null while still open). */
function incidents(storeId) {
  const list = [];
  for (const a of alertsSince.all(storeId)) {
    if (!CORE.includes(a.check_id)) continue;
    if (a.state === 'failing') list.push({ check: a.check_id, start: ts(a.created_at), end: null });
    else { const open = [...list].reverse().find((i) => i.check === a.check_id && !i.end); if (open) open.end = ts(a.created_at); }
  }
  for (const o of openCore.all(storeId, ...CORE)) if (!list.some((i) => i.check === o.check_id && !i.end)) list.push({ check: o.check_id, start: ts(o.since), end: null });
  return list;
}

/** Hours within the last 30 days when at least one buying-critical check was failing (overlaps merged). */
function brokenHours(list) {
  const from = Date.now() - 30 * 864e5;
  const spans = list.map((i) => [Math.max(i.start, from), i.end || Date.now()]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0, cur = null;
  for (const [a, b] of spans) {
    if (!cur || a > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  return total / 3600e3;
}

/**
 * Rules met per country the store sells in, from the latest full check that ran the regional packs.
 * Germany and Austria share one pack, so they are reported together.
 */
function rulesMet(store, cfg) {
  const markets = cfg.markets || [];
  if (!markets.length) return { markets: [], run: null };
  // Each rule group comes from the latest full check that actually ran it (a hand-picked run may cover only some).
  const rows = lastRegional.all(store.id);
  const byGroup = new Map();
  let row = null;
  for (const r of rows) {
    const list = (JSON.parse(r.result_json).checks || []).filter((c) => c.status !== 'skip');
    for (const c of list) {
      const g = groupOf(c.id);
      if (!g || !GROUPS.find((x) => x.key === g)?.markets) continue;
      if (!byGroup.has(g)) byGroup.set(g, { run: r.id, checks: [] });
      if (byGroup.get(g).run === r.id) byGroup.get(g).checks.push(c);
    }
    row = row || r;
  }
  const checks = [...byGroup.values()].flatMap((x) => x.checks);
  const shown = [];
  const seen = new Set();
  for (const m of markets) {
    const groups = GROUPS.filter((g) => g.markets?.includes(m)).map((g) => g.key);
    if (!groups.length) continue;
    const key = groups.sort().join(',');
    const label = MARKETS.find((x) => x.code === m)?.label || m;
    if (seen.has(key)) { shown.find((x) => x.key === key).label += ` and ${label}`; continue; }
    seen.add(key);
    const list = checks.filter((c) => groups.includes(groupOf(c.id)));
    if (!list.length) { shown.push({ key, code: m, label, met: 0, total: 0, open: [], pending: true }); continue; }
    shown.push({ key, code: m, label, met: list.filter((c) => c.status === 'pass').length, total: list.length, open: list.filter((c) => c.status !== 'pass').map((c) => c.title) });
  }
  return { markets: shown.map(({ key, ...x }) => x), run: row ? { id: row.id, created_at: row.created_at } : null };
}

export function scorecard(store) {
  const cfg = storeConfig(store);
  const inc = incidents(store.id);
  const recent = inc.filter((i) => (i.end || Date.now()) > Date.now() - 30 * 864e5);
  const fixed = recent.filter((i) => i.end).map((i) => (i.end - i.start) / 60e3).sort((a, b) => a - b);
  const median = fixed.length ? fixed[Math.floor((fixed.length - 1) / 2)] : null;
  const hours = brokenHours(recent);

  let catalog = null;
  const row = lastCatalog.get(store.id);
  if (row) {
    const c = JSON.parse(row.result_json).catalog;
    if (c?.count) {
      const withIssues = new Set((c.issues || []).filter((i) => i.severity !== 'minor').map((i) => i.handle)).size;
      catalog = { products: c.count, withIssues, pct: Math.round(((c.count - withIssues) / c.count) * 1000) / 10, currency: c.currency || null };
    }
  }
  const currency = cfg.currency || catalog?.currency || null;
  const daySales = Number(cfg.dailySales) || null;
  const rel = releasesSince.all(store.id);

  return {
    buyability: { day: buyability(store.id, '-1 day'), week: buyability(store.id, '-7 days'), month: buyability(store.id, '-30 days'), daily: daily(store.id, 30) },
    timeToFix: { medianMinutes: median == null ? null : Math.round(median), incidents: recent.length, open: inc.filter((i) => !i.end).length },
    revenueAtRisk: { hours: Math.round(hours * 10) / 10, amount: daySales ? Math.round((hours * daySales) / 24) : null, dailySales: daySales, currency },
    catalog,
    rules: rulesMet(store, cfg),
    publishing: { checked: rel.length, caught: rel.filter((r) => r.verdict === 'blocked').length, reviewed: rel.filter((r) => r.verdict === 'review').length },
  };
}

/** Just the headline for lists (All stores). */
export function weekBuyability(storeId) {
  return buyability(storeId, '-7 days').pct;
}
