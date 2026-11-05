import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { config } from './config.js';
import { db } from './db.js';
import { CATEGORIES } from './engine/checks.js';
import { loadSnapshot } from './engine/catalog-check.js';
import { diffCatalog, validateCatalog } from './engine/products.js';

const BAD = new Set(['fail', 'warn']);
export const SHOT_KEYS = ['home-desktop', 'home-tablet', 'home-mobile', 'product-desktop', 'product-tablet', 'product-mobile'];

function parse(run) {
  return run ? { id: run.id, kind: run.kind, trigger: run.trigger, created_at: run.created_at, finished_at: run.finished_at, score: run.score, verdict: run.verdict, result: JSON.parse(run.result_json) } : null;
}

const doneRuns = db.prepare("SELECT * FROM runs WHERE store_id = ? AND status = 'done' AND result_json IS NOT NULL AND (trigger IS NULL OR trigger != 'release') ORDER BY id DESC LIMIT 400");
const runRow = db.prepare("SELECT * FROM runs WHERE id = ? AND store_id = ? AND status = 'done' AND result_json IS NOT NULL");

/** Lists finished reports for the picker. */
export function reportList(storeId) {
  return doneRuns.all(storeId).map((r) => ({ id: r.id, seq: r.seq, kind: r.kind, created_at: r.created_at, score: r.score, verdict: r.verdict }));
}

/** Picks the report and the one to compare it with. base: prev | day | week | none | <run id> */
export function resolvePair(storeId, runId, base) {
  const runs = doneRuns.all(storeId);
  if (!runs.length) return { run: null, base: null };
  const run = runId ? runs.find((r) => r.id === Number(runId)) : runs.find((r) => r.kind === 'full') || runs[0];
  if (!run) return { run: null, base: null };
  const older = runs.filter((r) => r.id < run.id);
  const sameKind = older.filter((r) => r.kind === run.kind);
  let b = null;
  if (base === 'none') b = null;
  else if (/^\d+$/.test(String(base || ''))) b = runs.find((r) => r.id === Number(base)) || null;
  else if (base === 'day' || base === 'week') {
    const target = new Date(run.created_at.replace(' ', 'T') + 'Z').getTime() - (base === 'day' ? 1 : 7) * 86400e3;
    const pool = (sameKind.length ? sameKind : older).filter((r) => new Date(r.created_at.replace(' ', 'T') + 'Z').getTime() <= target + 3 * 3600e3);
    b = pool.sort((x, y) => Math.abs(new Date(x.created_at.replace(' ', 'T') + 'Z') - target) - Math.abs(new Date(y.created_at.replace(' ', 'T') + 'Z') - target))[0] || null;
  } else b = sameKind[0] || older[0] || null;
  return { run: parse(run), base: parse(b) };
}

function checkDiff(a, b) {
  const A = new Map((a?.checks || []).map((c) => [c.id, c]));
  const B = new Map((b?.checks || []).map((c) => [c.id, c]));
  const rows = [];
  for (const id of new Set([...A.keys(), ...B.keys()])) {
    const x = A.get(id), y = B.get(id);
    const sa = x?.status || null, sb = y?.status || null;
    let change = 'same';
    if (!b) change = BAD.has(sa) ? 'problem' : 'ok';
    else if (!x) change = 'removed';
    else if (BAD.has(sa) && (!sb || !BAD.has(sb))) change = 'new';
    else if (!BAD.has(sa) && BAD.has(sb)) change = 'fixed';
    else if (sa === 'fail' && sb === 'warn') change = 'worse';
    else if (sa === 'warn' && sb === 'fail') change = 'better';
    else if (BAD.has(sa)) change = 'still';
    else change = 'ok';
    const ref = x || y;
    rows.push({ id, category: ref.category, title: ref.title, severity: ref.severity, a: sa, b: sb, change, detail: x?.detail || '', prevDetail: y?.detail || '', fix: x?.fix || '', evidence: x?.evidence || null, changes: x?.changes || null });
  }
  return rows;
}

const MET = [
  ['lcp', 'Largest content shown', 'ms', true],
  ['load', 'Fully loaded', 'ms', true],
  ['ttfb', 'Server response', 'ms', true],
  ['cls', 'Layout shift', '', true],
  ['bytes', 'Page weight', 'bytes', true],
  ['requests', 'Requests', '', true],
];
function metricRows(a, b) {
  const rows = [];
  for (const [page, label] of [['home', 'Homepage'], ['product', 'Product page']]) {
    const x = a?.metrics?.[page], y = b?.metrics?.[page];
    if (!x && !y) continue;
    for (const [key, name, unit, lowerBetter] of MET) {
      const va = x?.[key], vb = y?.[key];
      if (va == null && vb == null) continue;
      let trend = 'same';
      if (va != null && vb != null && vb !== 0) {
        const rel = (va - vb) / Math.abs(vb);
        const absMin = unit === 'ms' ? 150 : unit === 'bytes' ? 50 * 1024 : key === 'cls' ? 0.02 : 3;
        if (Math.abs(va - vb) >= absMin && Math.abs(rel) >= 0.1) trend = (va > vb) === lowerBetter ? 'worse' : 'better';
      }
      rows.push({ page: label, key, name, unit, a: va ?? null, b: vb ?? null, trend });
    }
  }
  for (const [page, label] of [['home', 'Homepage'], ['product', 'Product page']]) {
    const ca = a?.metrics?.[`a11y_${page}`], cb = b?.metrics?.[`a11y_${page}`];
    if (!ca && !cb) continue;
    const n = (v) => (v ? v.filter((x) => x.impact === 'critical' || x.impact === 'serious').length : null);
    const va = n(ca), vb = n(cb);
    rows.push({ page: label, key: 'a11y', name: 'Serious accessibility issues', unit: '', a: va, b: vb, trend: va != null && vb != null && va !== vb ? (va > vb ? 'worse' : 'better') : 'same' });
  }
  const la = a?.metrics?.links, lb = b?.metrics?.links;
  if (la || lb) {
    const va = la ? la.broken.length : null, vb = lb ? lb.broken.length : null;
    rows.push({ page: 'Homepage', key: 'links', name: 'Broken links', unit: '', a: va, b: vb, trend: va != null && vb != null && va !== vb ? (va > vb ? 'worse' : 'better') : 'same' });
  }
  return rows;
}

function catalogDiffBetween(storeId, aId, bId) {
  const a = loadSnapshot(storeId, aId);
  if (!a) return null;
  const b = bId ? loadSnapshot(storeId, bId) : null;
  return diffCatalog(a, b);
}

function journeyTimings(result) {
  const steps = result?.steps || [];
  return steps.map((s, i) => ({ text: s.text, ms: steps[i + 1] ? steps[i + 1].at - s.at : null }));
}

function shotPath(runId, key) {
  return path.join(config.dataDir, 'shots', `run-${runId}`, `${key}.png`);
}

/** Pixel comparison between two runs' screenshots, cached in the newer run's folder. */
function visualDiff(aId, bId) {
  const out = [];
  for (const key of SHOT_KEYS) {
    const pa = shotPath(aId, key);
    const pb = bId ? shotPath(bId, key) : null;
    const hasA = fs.existsSync(pa), hasB = pb && fs.existsSync(pb);
    if (!hasA && !hasB) continue;
    const row = { key, a: hasA ? `/shots/run-${aId}/${key}.png` : null, b: hasB ? `/shots/run-${bId}/${key}.png` : null, diff: null, ratio: null };
    if (hasA && hasB) {
      const cache = path.join(config.dataDir, 'shots', `run-${aId}`, `cmp-${bId}-${key}.png`);
      const meta = cache + '.json';
      try {
        if (!fs.existsSync(meta)) {
          const A = PNG.sync.read(fs.readFileSync(pa)), B = PNG.sync.read(fs.readFileSync(pb));
          if (A.width === B.width && A.height === B.height) {
            const d = new PNG({ width: A.width, height: A.height });
            const n = pixelmatch(A.data, B.data, d.data, A.width, A.height, { threshold: 0.15, alpha: 0.35 });
            fs.writeFileSync(cache, PNG.sync.write(d));
            fs.writeFileSync(meta, JSON.stringify({ ratio: Math.round((n / (A.width * A.height)) * 1000) / 10 }));
          } else fs.writeFileSync(meta, JSON.stringify({ ratio: 100, sizeChanged: true }));
        }
        row.ratio = JSON.parse(fs.readFileSync(meta, 'utf8')).ratio;
        if (fs.existsSync(cache)) row.diff = `/shots/run-${aId}/cmp-${bId}-${key}.png`;
      } catch {
        /* comparison is best-effort */
      }
    }
    out.push(row);
  }
  return out;
}

export function buildComparison(storeId, runId, base) {
  const { run, base: b } = resolvePair(storeId, runId, base);
  return run ? compareRuns(storeId, run, b) : null;
}

/** Compares two specific runs, e.g. a draft theme (a) against the live theme (b). */
export function comparePair(storeId, aId, bId) {
  const a = parse(runRow.get(aId, storeId)), b = parse(runRow.get(bId, storeId));
  return a && b ? compareRuns(storeId, a, b) : null;
}

function compareRuns(storeId, run, b) {
  const checks = checkDiff(run.result, b?.result);
  const areas = Object.entries(CATEGORIES).map(([key, c]) => {
    const ca = run.result.categories?.find((x) => x.key === key);
    const cb = b?.result?.categories?.find((x) => x.key === key);
    const list = checks.filter((x) => x.category === key);
    return {
      key, label: c.label, rules: !!c.rules,
      a: c.rules ? null : ca?.tested ? ca.score : null, b: c.rules ? null : cb?.tested ? cb.score : null,
      counts: { pass: list.filter((x) => x.a === 'pass').length, warn: list.filter((x) => x.a === 'warn').length, fail: list.filter((x) => x.a === 'fail').length, skip: list.filter((x) => x.a === 'skip').length },
      checks: list,
    };
  }).filter((x) => x.checks.length);
  return {
    run: { ...run, result: { ...run.result, checks: undefined, steps: undefined } },
    base: b ? { ...b, result: undefined } : null,
    summary: run.result.summary,
    platform: run.result.platform,
    testedProduct: run.result.testedProduct,
    areas,
    changes: {
      new: checks.filter((x) => x.change === 'new' || x.change === 'worse'),
      fixed: checks.filter((x) => x.change === 'fixed' || x.change === 'better'),
      still: checks.filter((x) => x.change === 'still' || (x.change === 'problem')),
    },
    metrics: metricRows(run.result, b?.result),
    timings: { a: journeyTimings(run.result), b: b ? journeyTimings(b.result) : [] },
    visual: visualDiff(run.id, b?.id),
    catalog: run.result.catalog || null,
    ai: run.result.ai || null,
    catalogDiff: catalogDiffBetween(storeId, run.id, b?.id),
    cover: run.result.cover,
  };
}
