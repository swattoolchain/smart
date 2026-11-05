/**
 * Change attribution (roadmap 4): when a check newly fails, name the scripts and outside sites that appeared
 * on the store since the last check where it worked. Uses the per-run script records from Script watch.
 * The sentence goes into the check's detail, so the report, the alert email and Slack all carry it.
 */
import { db, q } from './db.js';

const PAGES = { home: 'home', product: 'product', cart: 'cart' };
const onPages = (kinds) => { const n = kinds.map((k) => PAGES[k] || k); return `${n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)} pages` : `${n[0]} page`}`; };
const MAX_LOOKBACK = 60; // finished checks to look back through for the last time it worked

/** Scripts and sites in `now` that weren't in `then`, on pages both checks reached. */
export function addedSince(then, now) {
  const reached = new Set(Object.keys(then?.pages || {}));
  const before = new Set(), sitesBefore = new Set();
  for (const p of Object.values(then?.pages || {})) { for (const s of p.scripts || []) before.add(s.key); for (const h of p.sites || []) sitesBefore.add(h); }
  const scripts = new Map(), sites = new Set();
  for (const [kind, p] of Object.entries(now?.pages || {})) {
    if (!reached.has(kind)) continue;
    for (const s of p.scripts || []) {
      if (before.has(s.key)) continue;
      if (scripts.has(s.key)) scripts.get(s.key).pages.push(kind);
      else scripts.set(s.key, { url: s.url, host: s.host, pages: [kind] });
    }
    for (const h of p.sites || []) if (!sitesBefore.has(h)) sites.add(h);
  }
  return { scripts: [...scripts.values()], sites: [...sites].sort() };
}

/**
 * Adds `changes` (and a sentence in the detail) to each check in `result` that fails now, wasn't failing
 * before, and worked in an earlier check of this store. Changes `result` in place; returns how many were named.
 */
export function attributeFailures(storeId, runId, result) {
  if (!storeId || !result?.scripts?.pages || !Object.keys(result.scripts.pages).length) return 0;
  const failing = (result.checks || []).filter((c) => c.status === 'fail' && ['critical', 'major'].includes(c.severity)
    && !c.id.startsWith('sec.') && q.getCheckState.get(storeId, c.id)?.status !== 'failing');
  if (!failing.length) return 0;
  const rows = db.prepare("SELECT id, seq, created_at, result_json FROM runs WHERE store_id = ? AND id < ? AND status = 'done' AND (trigger IS NULL OR trigger != 'release') ORDER BY id DESC LIMIT ?").all(storeId, runId, MAX_LOOKBACK);
  const parsed = new Map();
  const get = (row) => { if (!parsed.has(row.id)) { try { parsed.set(row.id, JSON.parse(row.result_json)); } catch { parsed.set(row.id, null); } } return parsed.get(row.id); };
  let named = 0;
  for (const c of failing) {
    // The latest check where this one worked, and the latest such check that recorded the store's scripts
    // (usually the same one; a check from before Script watch, or one where it was switched off, has no record).
    let last = null, good = null;
    for (const row of rows) {
      const r = get(row);
      if (!r?.checks?.some((x) => x.id === c.id && x.status === 'pass')) continue;
      last ||= row;
      if (r.scripts?.pages && Object.keys(r.scripts.pages).length) { good = { row, r }; break; }
    }
    if (!good) continue;
    const added = addedSince(good.r.scripts, result.scripts);
    if (!added.scripts.length && !added.sites.length) continue;
    c.changes = { sinceRunId: last.id, sinceSeq: last.seq, since: last.created_at, scripts: added.scripts.slice(0, 10), sites: added.sites.slice(0, 10) };
    const list = added.scripts.slice(0, 3).map((s) => `${s.url} (${onPages(s.pages)})`);
    const sites = added.sites.filter((h) => !added.scripts.some((s) => s.host === h)).slice(0, 3);
    const parts = [list.length && `${list.join(', ')}${added.scripts.length > 3 ? `, and ${added.scripts.length - 3} more` : ''}`, sites.length && `new outside site${sites.length === 1 ? '' : 's'} ${sites.join(', ')}`].filter(Boolean);
    c.detail = `${c.detail || ''}${c.detail && !/[.!?]$/.test(c.detail) ? '.' : ''} This started after ${added.scripts.length ? (added.scripts.length === 1 ? 'this script' : 'these scripts') : 'this'} appeared: ${parts.join('; ')}. It last worked in check #${last.seq ?? last.id}.`.trim();
    c.fix = `${added.scripts.length ? 'Check the new script first: switch off or undo the app or theme change that added it, then run a check again. ' : ''}${c.fix || ''}`.trim();
    named++;
  }
  return named;
}
