/**
 * App Health: one row per app or service seen on the storefront, built from the script watch records of the
 * store's recent checks. Pages it loads on, what it costs on a phone, script errors it caused, code changes,
 * outside sites it talks to, and apps that stopped loading. Tharam's own row is always there: we add no code
 * to the store, and the row says so with numbers.
 */
import { db } from './db.js';
import { appFor } from './engine/apps.js';
import { isOn } from './features.js';

const WINDOW = 30; // checks looked at for "first seen" and "last code change"
// A slow 4G phone connection (the speed test baseline Lighthouse uses): 1.6 Mbit/s ≈ 200 KB a second.
const SLOW_PHONE_BYTES_PER_S = 200 * 1024;
const ORDER = { errors: 0, widget: 1, missing: 2, changed: 3, new: 4, ok: 5 };

// SQLite times are UTC without a zone: make them ISO so browsers read them right.
const iso = (t) => (t && !t.includes('T') ? t.replace(' ', 'T') + 'Z' : t);

function recentRuns(storeId) {
  const rows = db.prepare(`SELECT id, kind, finished_at, created_at, result_json FROM runs
    WHERE store_id = ? AND status = 'done' AND (trigger IS NULL OR trigger != 'release') AND result_json LIKE '%"scripts":{%'
    ORDER BY id DESC LIMIT ?`).all(storeId, WINDOW);
  const out = [];
  for (const r of rows) {
    try {
      const s = JSON.parse(r.result_json).scripts;
      if (s?.pages && Object.keys(s.pages).length) out.push({ id: r.id, kind: r.kind, at: iso(r.finished_at || r.created_at), scripts: s });
    } catch {}
  }
  return out;
}

const storeHostOf = (run, fallback) => run.scripts.storeHost || fallback;

/** appKey → { name, kind, pages:Set, keys:Set(script keys), scripts:[], sites:Set } for one check. */
function appsIn(run, storeHost) {
  const host = storeHostOf(run, storeHost);
  const apps = new Map();
  const at = (a) => {
    if (!apps.has(a.key)) apps.set(a.key, { key: a.key, name: a.name, kind: a.kind, pages: new Set(), keys: new Set(), scripts: [], sites: new Set(), hashes: new Map() });
    return apps.get(a.key);
  };
  for (const [page, p] of Object.entries(run.scripts.pages)) {
    for (const s of p.scripts) {
      const a = at(appFor(s.url, host));
      a.pages.add(page);
      if (!a.keys.has(s.key)) { a.keys.add(s.key); a.scripts.push(s.url); }
      if (s.hash && !a.hashes.has(s.key)) a.hashes.set(s.key, { hash: s.hash, url: s.url });
    }
    for (const site of p.sites) {
      const a = at(appFor(`http://${site}/`, host));
      a.pages.add(page);
      a.sites.add(site);
    }
  }
  return apps;
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
/** Script files whose content changed at the same address (only where both checks fingerprinted them). */
const updatedFiles = (x, y) => [...x.hashes].filter(([k, h]) => y.hashes.has(k) && y.hashes.get(k).hash !== h.hash).map(([, h]) => h.url);
const codeDiffers = (x, y) => !sameSet(x.keys, y.keys) || updatedFiles(x, y).length > 0;

/**
 * A/B tests (T109): the tools found on the store, and for each test version whether it was listed by the owner or
 * found by Tharam, and how it did in the latest check that shopped it. Null when the switch is off or no check has
 * looked for A/B tests yet.
 */
export function abHealth(storeId) {
  if (!isOn('ab_tests')) return null;
  const rows = db.prepare(`SELECT id, finished_at, created_at, result_json FROM runs
    WHERE store_id = ? AND status = 'done' AND (trigger IS NULL OR trigger != 'release') AND result_json LIKE '%"abTests":{%'
    ORDER BY id DESC LIMIT 20`).all(storeId);
  let latest = null;
  const last = new Map(); // version name → its newest result
  for (const r of rows) {
    let ab;
    try { ab = JSON.parse(r.result_json).abTests; } catch { continue; }
    if (!ab || !Array.isArray(ab.variants)) continue;
    const at = iso(r.finished_at || r.created_at);
    if (!latest) latest = { runId: r.id, at, tools: ab.tools || [], variants: ab.variants };
    for (const v of ab.variants) if (!last.has(v.name)) last.set(v.name, { ...v, at, runId: r.id });
  }
  if (!latest) return null;
  const now = new Set(latest.variants.map((v) => v.name));
  const versions = latest.variants.map((v) => ({ name: v.name, source: v.auto ? 'found' : 'listed', tool: v.by || null, ok: !!v.ok, problems: v.problems || [], at: latest.at }));
  // Versions that were checked before but are not in the latest check (the test ended or the list changed).
  for (const [name, v] of last) if (!now.has(name)) versions.push({ name, source: v.auto ? 'found' : 'listed', tool: v.by || null, ok: !!v.ok, problems: v.problems || [], at: v.at, stale: true });
  return {
    runId: latest.runId, checkedAt: latest.at, tools: latest.tools,
    listed: versions.filter((v) => v.source === 'listed' && !v.stale).length,
    found: versions.filter((v) => v.source === 'found' && !v.stale).length,
    failing: versions.filter((v) => !v.ok && !v.stale).length,
    versions,
  };
}

export function appHealth(store) {
  let storeHost;
  try { storeHost = new URL(store.url).host; } catch { storeHost = ''; }
  const runs = recentRuns(store.id);
  const visits = db.prepare("SELECT COUNT(*) n FROM runs WHERE store_id = ? AND created_at >= datetime('now', '-7 days')").get(store.id).n;
  const tharam = { scripts: 0, sites: [], bytes: 0, visits7d: visits };
  const abTests = abHealth(store.id);
  if (!runs.length) return { runId: null, checkedAt: null, apps: [], tharam, totals: { apps: 0, errors: 0, phoneBytes: 0 }, phone: null, compared: false, abTests };

  const latest = runs[0];
  const host = storeHostOf(latest, storeHost);
  const perRun = runs.map((r) => appsIn(r, storeHost));
  const now = perRun[0];
  const prev = perRun[1] || null;
  const reachedNow = new Set(Object.keys(latest.scripts.pages));
  const reachedPrev = runs[1] ? new Set(Object.keys(runs[1].scripts.pages)) : new Set();

  const rows = new Map();
  const row = (a) => {
    if (!rows.has(a.key)) rows.set(a.key, { key: a.key, name: a.name, kind: a.kind, pages: [], scripts: [], sites: [], errors: [], phone: { bytes: 0, files: 0, ms: 0, slowS: 0 }, changes: { added: [], removed: [], updated: [], lastChangedAt: null }, widget: null, firstSeenAt: null, lastSeenAt: latest.at, status: 'ok' });
    return rows.get(a.key);
  };

  for (const a of now.values()) {
    const r = row(a);
    r.pages = [...a.pages].sort();
    r.scripts = a.scripts;
    r.sites = [...a.sites].sort();
    // Code changes: script files added or gone since the previous check (pages both checks reached).
    const before = prev?.get(a.key);
    if (before && [...a.pages].some((pg) => reachedPrev.has(pg))) {
      const keys = [...a.keys], keysBefore = [...before.keys];
      r.changes.added = a.scripts.filter((u, i) => !before.keys.has(keys[i]));
      r.changes.removed = before.scripts.filter((u, i) => !a.keys.has(keysBefore[i]));
      r.changes.updated = updatedFiles(a, before);
    }
    // Last code change and first seen, within the window.
    for (let i = 0; i < perRun.length - 1; i++) {
      const x = perRun[i].get(a.key), y = perRun[i + 1].get(a.key);
      if (x && y && codeDiffers(x, y)) { r.changes.lastChangedAt = runs[i].at; break; }
      if (!x || !y) break;
    }
    let first = 0;
    while (first + 1 < perRun.length && perRun[first + 1].has(a.key)) first++;
    r.firstSeenAt = runs[first].at;
    if (prev && !before && a.scripts.length) r.status = 'new';
    if (r.changes.added.length || r.changes.removed.length || r.changes.updated.length) r.status = 'changed';
  }

  // Widgets: apps that loaded where their widget should show, but shoppers didn't see it.
  const w = latest.scripts.widgets;
  for (const c of w?.checked || []) {
    const r = rows.get(c.key);
    if (!r) continue;
    const gone = w.missing.find((m) => m.key === c.key);
    r.widget = { pages: c.pages, missingOn: gone ? gone.pages : [] };
    if (gone) r.status = 'widget';
  }

  // Apps that loaded last time but not now, on pages this check did reach: a missing widget.
  if (prev) {
    for (const a of prev.values()) {
      if (now.has(a.key) || !a.scripts.length || ['theme', 'shopify'].includes(a.kind)) continue;
      if (![...a.pages].some((pg) => reachedNow.has(pg))) continue;
      const r = row(a);
      Object.assign(r, { pages: [...a.pages].sort(), scripts: a.scripts, sites: [...a.sites].sort(), status: 'missing', lastSeenAt: runs[1].at });
      r.changes.removed = a.scripts;
    }
  }

  // Script errors, by the script that threw.
  let unattributed = 0;
  for (const e of latest.scripts.errors || []) {
    if (!e.source) { unattributed++; continue; }
    const r = row(appFor(e.source, host));
    if (!r.pages.length) r.pages = [e.page].filter((x) => x && x !== 'other');
    if (!r.errors.some((x) => x.message === e.message)) r.errors.push({ message: e.message, page: e.page, source: e.source });
    r.status = 'errors';
  }

  // Phone cost, from the latest check that measured speed (full checks).
  const phoneRun = runs.find((r) => r.scripts.phone?.files?.length);
  if (phoneRun) {
    const ph = storeHostOf(phoneRun, storeHost);
    for (const f of phoneRun.scripts.phone.files) {
      const a = appFor(f.url, ph);
      if (!rows.has(a.key) && a.kind === 'theme') continue;
      const r = row(a);
      if (!r.pages.length && f.page) r.pages = [f.page];
      // Per page: a shopper's phone downloads an app's files again on each page it opens first.
      const pg = (r.phone.byPage ||= {});
      const x = (pg[f.page || 'home'] ||= { bytes: 0, files: 0 });
      x.bytes += f.bytes;
      x.files += f.count || 1;
      r.phone.ms = Math.max(r.phone.ms, f.ms || 0);
    }
    // The cost shown is the heaviest page: what opening that one page costs a shopper.
    for (const r of rows.values()) {
      const pages = Object.values(r.phone.byPage || {});
      if (!pages.length) continue;
      const top = pages.reduce((a, b) => (b.bytes > a.bytes ? b : a));
      r.phone.bytes = top.bytes;
      r.phone.files = top.files;
      r.phone.slowS = Math.round((top.bytes / SLOW_PHONE_BYTES_PER_S) * 10) / 10;
    }
  }

  const list = [...rows.values()];
  const us = list.find((r) => r.kind === 'tharam');
  if (us) Object.assign(tharam, { scripts: us.scripts.length, sites: us.sites, bytes: us.phone.bytes });
  const apps = list.filter((r) => r.kind !== 'tharam')
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.kind === 'theme') - (b.kind === 'theme') || b.phone.bytes - a.phone.bytes || a.name.localeCompare(b.name));
  return {
    runId: latest.id,
    checkedAt: latest.at,
    compared: !!prev,
    comparedAt: runs[1]?.at || null,
    phone: phoneRun ? { runId: phoneRun.id, at: phoneRun.at, pages: phoneRun.scripts.phone.pages } : null,
    apps,
    abTests,
    unattributedErrors: unattributed,
    tharam,
    totals: {
      apps: apps.filter((r) => !['theme', 'shopify'].includes(r.kind)).length,
      errors: apps.reduce((n, r) => n + r.errors.length, 0) + unattributed,
      phoneBytes: apps.reduce((n, r) => n + (['theme', 'shopify'].includes(r.kind) || r.status === 'missing' ? 0 : r.phone.bytes), 0),
    },
  };
}

/**
 * For the cross-store early warning: the apps on the store's latest check, and the ones whose code changed
 * since the check before (new script files, or new content at the same address). An app that is new on the
 * store is not a code change. Theme, Shopify and Tharam files are left out.
 */
export function appChanges(store) {
  let storeHost;
  try { storeHost = new URL(store.url).host; } catch { storeHost = ''; }
  const runs = recentRuns(store.id).slice(0, 2);
  if (!runs.length) return { runId: null, apps: [], changed: [] };
  const skip = (a) => ['theme', 'shopify', 'tharam'].includes(a.kind) || !a.scripts.length;
  const now = appsIn(runs[0], storeHost);
  const prev = runs[1] ? appsIn(runs[1], storeHost) : null;
  const reachedPrev = runs[1] ? new Set(Object.keys(runs[1].scripts.pages)) : new Set();
  const apps = [...now.values()].filter((a) => !skip(a));
  const changed = [];
  for (const a of apps) {
    const before = prev?.get(a.key);
    if (!before || ![...a.pages].some((pg) => reachedPrev.has(pg))) continue;
    const keys = [...a.keys];
    const files = [...a.scripts.filter((u, i) => !before.keys.has(keys[i])), ...updatedFiles(a, before)];
    if (files.length) changed.push({ key: a.key, name: a.name, kind: a.kind, files });
  }
  return { runId: runs[0].id, apps: apps.map((a) => ({ key: a.key, name: a.name, kind: a.kind })), changed };
}
