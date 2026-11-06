import { db } from './db.js';
import { loadSnapshot, snapshotRuns } from './engine/catalog-check.js';
import { diffCatalog, validateCatalog } from './engine/products.js';

const runRow = db.prepare("SELECT id, created_at, result_json FROM runs WHERE id = ? AND store_id = ?");

function aiCopyByHandle(storeId, runId) {
  const r = db.prepare("SELECT result_json FROM runs WHERE id = ? AND store_id = ?").get(runId, storeId);
  const copy = r ? JSON.parse(r.result_json)?.catalog?.copy?.issues || [] : [];
  const map = new Map();
  for (const i of copy) map.set(i.handle, (map.get(i.handle) || []).concat(i));
  return map;
}

/** Catalog view for a store: snapshot + validations + changes vs a chosen earlier snapshot. */
export function catalogReport(storeId, runId, base) {
  const snaps = snapshotRuns(storeId);
  if (!snaps.length) return null;
  const curId = runId && snaps.includes(runId) ? runId : snaps[0];
  const cur = loadSnapshot(storeId, curId);
  if (!cur) return null;
  const older = snaps.filter((r) => r < curId);
  let baseId = null;
  if (base === 'none') baseId = null;
  else if (/^\d+$/.test(String(base))) baseId = snaps.includes(Number(base)) ? Number(base) : null;
  else if (base === 'week') baseId = older.find((r) => cur && new Date(loadSnapshot(storeId, r)?.takenAt) <= new Date(cur.takenAt) - 7 * 86400e3) || older[older.length - 1] || null;
  else baseId = older[0] || null;
  const prev = baseId ? loadSnapshot(storeId, baseId) : null;

  const issues = validateCatalog(cur, prev);
  const diff = diffCatalog(cur, prev);
  const copyMap = aiCopyByHandle(storeId, curId);
  for (const [handle, list] of copyMap) {
    const p = cur.products.find((x) => x.handle === handle);
    for (const i of list) issues.push({ handle, title: p?.title || handle, type: 'copy', severity: i.severity, message: i.issue + (i.fix ? ` → suggested: “${i.fix}”` : ''), snippet: i.snippet });
  }

  const issuesByHandle = new Map();
  for (const i of issues) issuesByHandle.set(i.handle, (issuesByHandle.get(i.handle) || []).concat(i));
  const byType = {};
  for (const i of issues) (byType[i.type] = byType[i.type] || []).push(i);

  const products = cur.products
    .map((p) => ({
      handle: p.handle, url: p.url || null, title: p.title, image: p.image, available: p.available,
      price: p.minPrice, maxPrice: p.maxPrice, variants: p.variants.length, images: p.images,
      issues: (issuesByHandle.get(p.handle) || []).length,
      worst: (issuesByHandle.get(p.handle) || []).some((i) => i.severity === 'critical') ? 'critical' : (issuesByHandle.get(p.handle) || []).some((i) => i.severity === 'major') ? 'major' : (issuesByHandle.get(p.handle) || []).length ? 'minor' : null,
      changed: diff?.changes.find((c) => c.handle === p.handle)?.kind || null,
    }))
    .sort((a, b) => ({ critical: 0, major: 1, minor: 2, null: 3 }[a.worst] - { critical: 0, major: 1, minor: 2, null: 3 }[b.worst]));

  return {
    run: { id: curId, takenAt: cur.takenAt, count: cur.count, truncated: cur.truncated },
    currency: cur.currency || null,
    base: prev ? { id: baseId, takenAt: prev.takenAt, count: prev.count } : null,
    reports: snaps.map((id) => { const r = runRow.get(id, storeId); return { id, created_at: r?.created_at }; }),
    summary: {
      products: cur.count,
      withIssues: issuesByHandle.size,
      critical: issues.filter((i) => i.severity === 'critical').length,
      major: issues.filter((i) => i.severity === 'major').length,
      minor: issues.filter((i) => i.severity === 'minor').length,
    },
    byType,
    totals: diff?.totals || null,
    changes: diff?.changes.slice(0, 200) || [],
    products: products.slice(0, 500),
  };
}
