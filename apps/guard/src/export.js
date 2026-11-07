/**
 * Exports for store owners (roadmap 13, part 1): runs, checks and products as CSV, and a printable report
 * (HTML to print, or a PDF made by our own browser) that carries the store's name.
 * Every function takes a store the caller already checked ownership of.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { CATEGORIES } from './engine/checks.js';
import { catalogReport } from './catalog-report.js';
import { loadSnapshot } from './engine/catalog-check.js';
import { getBrowser } from './engine/browser.js';

// ---------- CSV ----------
/** One CSV cell. Text that a spreadsheet would run as a formula (=, +, -, @) is prefixed with ' so it stays text. */
export function csvCell(v) {
  if (v == null) return '';
  let s = typeof v === 'number' || typeof v === 'boolean' ? String(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** A CSV file with a header row. Starts with a byte-order mark so Excel reads ₹, € and accents correctly. */
export function toCsv(columns, rows) {
  const lines = [columns.map((c) => csvCell(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u || 'store'); } };
const slug = (s) => String(s || 'store').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'store';
export const exportName = (store, what, ext = 'csv') => `tharam-${slug(hostOf(store.url))}-${what}-${new Date().toISOString().slice(0, 10)}.${ext}`;
const iso = (ts) => (ts ? (/[TZ]/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z') : '');
const KIND = { full: 'Full check', journeys: 'Quick check', free: 'Free scan' };
const VERDICT = { healthy: 'Customers can buy', warning: 'Needs attention', critical: "Customers can't buy", locked: 'Password protected', blocked: 'Blocked by bot protection' };
const STATUS = { pass: 'Pass', warn: 'Check', fail: 'Fail', skip: 'Skipped' };

const runsOf = db.prepare("SELECT id, seq, kind, status, score, verdict, trigger, error, created_at, finished_at, result_json FROM runs WHERE store_id = ? AND (trigger IS NULL OR trigger != 'release') AND created_at >= datetime('now', ?) ORDER BY id DESC LIMIT 5000");
const runOf = db.prepare("SELECT * FROM runs WHERE id = ? AND store_id = ? AND (trigger IS NULL OR trigger != 'release')");
const latestDone = db.prepare("SELECT * FROM runs WHERE store_id = ? AND status = 'done' AND (trigger IS NULL OR trigger != 'release') ORDER BY id DESC LIMIT 1");

/** The store's run, or its latest finished one. Null if the run is not this store's. */
export function runFor(store, runId) {
  return runId ? runOf.get(Number(runId), store.id) || null : latestDone.get(store.id) || null;
}

/** Runs of the last `days` days (1–365). */
export function runsCsv(store, days = 90) {
  const d = Math.min(365, Math.max(1, Math.round(Number(days)) || 90));
  const rows = runsOf.all(store.id, `-${d} days`).map((r) => {
    let checks = [];
    try { checks = JSON.parse(r.result_json || '{}').checks || []; } catch {}
    const dur = r.finished_at && r.created_at ? Math.round((new Date(iso(r.finished_at)) - new Date(iso(r.created_at))) / 1000) : null;
    return { ...r, fails: checks.filter((c) => c.status === 'fail').length, warns: checks.filter((c) => c.status === 'warn').length, total: checks.length, dur, problems: checks.filter((c) => c.status === 'fail').map((c) => c.title).join('; ') };
  });
  return toCsv([
    { label: 'Check number', get: (r) => r.seq ?? r.id },
    { label: 'Started (UTC)', get: (r) => iso(r.created_at) },
    { label: 'Finished (UTC)', get: (r) => iso(r.finished_at) },
    { label: 'Type', get: (r) => KIND[r.kind] || r.kind },
    { label: 'Started by', get: (r) => r.trigger || 'schedule' },
    { label: 'Status', get: (r) => (r.status === 'error' ? `Didn't finish${r.error ? `: ${r.error}` : ''}` : r.status) },
    { label: 'Result', get: (r) => VERDICT[r.verdict] || '' },
    { label: 'Score', key: 'score' },
    { label: 'Failed checks', key: 'fails' },
    { label: 'Checks to look at', key: 'warns' },
    { label: 'Checks run', key: 'total' },
    { label: 'Took (seconds)', key: 'dur' },
    { label: 'What failed', key: 'problems' },
  ], rows);
}

/** Every check of one run. */
export function checksCsv(store, run) {
  const result = JSON.parse(run.result_json || '{}');
  return toCsv([
    { label: 'Check number', get: () => run.seq ?? run.id },
    { label: 'Checked at (UTC)', get: () => iso(run.finished_at || run.created_at) },
    { label: 'Area', get: (c) => CATEGORIES[c.category]?.label || c.category },
    { label: 'Check', key: 'title' },
    { label: 'Result', get: (c) => STATUS[c.status] || c.status },
    { label: 'Importance', key: 'severity' },
    { label: 'What we found', key: 'detail' },
    { label: 'How to fix', get: (c) => (c.status === 'pass' ? '' : c.fix || '') },
    { label: 'Check id', key: 'id' },
  ], result.checks || []);
}

/** Every product from a full check's catalog snapshot, with its problems and what changed. */
export function productsCsv(store, runId) {
  const rep = catalogReport(store.id, runId ? Number(runId) : null, 'prev');
  if (!rep) return null;
  const snap = loadSnapshot(store.id, rep.run.id);
  const issues = new Map();
  for (const i of Object.values(rep.byType || {}).flat()) issues.set(i.handle, (issues.get(i.handle) || []).concat(i));
  const rows = (snap?.products || []).map((p) => {
    const r = rep.products.find((x) => x.handle === p.handle) || {};
    return { ...p, list: issues.get(p.handle) || [], changed: r.changed || '' };
  });
  return {
    run: rep.run,
    csv: toCsv([
      { label: 'Product', key: 'title' },
      { label: 'Handle', key: 'handle' },
      { label: 'Link', get: (p) => `${store.url.replace(/\/$/, '')}/products/${p.handle}` },
      { label: 'Vendor', key: 'vendor' },
      { label: 'Type', key: 'type' },
      { label: 'Variants', get: (p) => p.variants.length },
      { label: 'SKUs', get: (p) => [...new Set(p.variants.map((v) => v.sku).filter(Boolean))].join(' ') },
      { label: 'Lowest price', key: 'minPrice' },
      { label: 'Highest price', key: 'maxPrice' },
      { label: 'Currency', get: () => rep.currency || '' },
      { label: 'In stock', get: (p) => (p.available ? 'Yes' : 'No') },
      { label: 'Images', key: 'images' },
      { label: 'Problems', get: (p) => p.list.length },
      { label: 'What to fix', get: (p) => p.list.map((i) => i.message).join('; ') },
      { label: 'Changed since last check', key: 'changed' },
    ], rows),
  };
}

// ---------- Printable report ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** A run screenshot as a data: URL, so the printed report and PDF need nothing else. Only this run's files. */
function shotData(runId, url) {
  const m = /^\/shots\/run-(\d+)\/([\w.-]+\.png)$/.exec(String(url || ''));
  if (!m || Number(m[1]) !== runId) return null;
  const f = path.join(config.dataDir, 'shots', `run-${runId}`, m[2]);
  try { const b = fs.readFileSync(f); return b.length < 3e6 ? `data:image/png;base64,${b.toString('base64')}` : null; } catch { return null; }
}

/** A self-contained, print-ready report of one run, headed with the store's name. */
export function reportHtml(store, run, { autoPrint = false } = {}) {
  const r = JSON.parse(run.result_json || '{}');
  const name = store.name || hostOf(store.url);
  const checks = r.checks || [];
  const order = { fail: 0, warn: 1 };
  const sev = { critical: 0, major: 1, minor: 2 };
  const problems = checks.filter((c) => c.status === 'fail' || c.status === 'warn').sort((a, b) => order[a.status] - order[b.status] || (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3));
  const passed = checks.filter((c) => c.status === 'pass');
  const skipped = checks.filter((c) => c.status === 'skip');
  let shots = 0;
  const when = new Date(iso(run.finished_at || run.created_at)).toUTCString().replace(' GMT', ' UTC');
  const cover = shotData(run.id, r.cover);
  const problemHtml = (c) => {
    const img = shots < 6 ? shotData(run.id, c.evidence?.screenshot) : null;
    if (img) shots++;
    return `<div class="chk ${c.status}"><div class="top"><span class="st">${STATUS[c.status]}</span><h3>${esc(c.title)}</h3><span class="sev">${esc(c.severity)}</span></div>
      <p>${esc(c.detail)}</p>${c.fix ? `<p class="fix"><b>How to fix:</b> ${esc(c.fix)}</p>` : ''}${img ? `<img src="${img}" alt="Screenshot: ${esc(c.title)}">` : ''}</div>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(name)} – Tharam report #${esc(run.seq ?? run.id)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font: 13px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111827; margin: 0; padding: 24px; max-width: 900px; margin: 0 auto; background: #fff; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111827; padding-bottom: 12px; margin-bottom: 18px; gap: 16px; }
  header h1 { font-size: 22px; margin: 0 0 2px; }
  header .host { color: #4b5563; }
  header .brand { text-align: right; color: #4b5563; font-size: 12px; }
  header .brand b { color: #111827; font-size: 15px; letter-spacing: .02em; }
  .summary { display: flex; gap: 18px; align-items: center; margin-bottom: 16px; }
  .score { width: 86px; height: 86px; border-radius: 50%; border: 6px solid var(--c); display: grid; place-items: center; font-size: 26px; font-weight: 700; flex: none; }
  .verdict { font-size: 18px; font-weight: 700; color: var(--c); }
  .cats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 0 0 18px; }
  .cat { border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px 10px; } .cat span { display: block; color: #6b7280; font-size: 11.5px; } .cat b { font-size: 16px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: #374151; margin: 22px 0 8px; }
  .chk { border: 1px solid #e5e7eb; border-left: 4px solid #9ca3af; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; break-inside: avoid; }
  .chk.fail { border-left-color: #c62828; } .chk.warn { border-left-color: #b26a00; }
  .chk .top { display: flex; gap: 10px; align-items: baseline; } .chk h3 { font-size: 14px; margin: 0; flex: 1; }
  .chk .st { font-weight: 700; font-size: 12px; } .chk.fail .st { color: #c62828; } .chk.warn .st { color: #b26a00; }
  .chk .sev { color: #6b7280; font-size: 11.5px; text-transform: capitalize; }
  .chk p { margin: 6px 0 0; } .fix { background: #f3f4f6; padding: 6px 8px; border-radius: 4px; }
  .chk img, .cover img { max-width: 100%; max-height: 360px; border: 1px solid #e5e7eb; border-radius: 4px; margin-top: 8px; }
  ul.passed { columns: 2; padding-left: 18px; margin: 0; } ul.passed li { break-inside: avoid; }
  footer { margin-top: 26px; border-top: 1px solid #e5e7eb; padding-top: 8px; color: #6b7280; font-size: 11.5px; }
  @media print { body { padding: 0; } .noprint { display: none; } }
</style></head><body>
<header><div><h1>${esc(name)}</h1><div class="host">${esc(hostOf(store.url))}</div><div class="host">${esc(KIND[run.kind] || 'Check')} #${esc(run.seq ?? run.id)} · ${esc(when)}</div></div>
<div class="brand"><b>THARAM</b><br>Store check report</div></header>
${r.verdict ? `<section class="summary" style="--c:${{ healthy: '#1b7f3b', warning: '#b26a00', critical: '#c62828' }[r.verdict] || '#b26a00'}"><div class="score">${esc(r.score ?? '–')}</div><div><div class="verdict">${esc(VERDICT[r.verdict] || r.verdict)}</div><div>${esc(r.summary || '')}</div><div class="host">${checks.length} checks · ${problems.filter((c) => c.status === 'fail').length} to fix · ${problems.filter((c) => c.status === 'warn').length} to look at · ${passed.length} passed</div></div></section>` : `<p>This check did not finish${run.error ? `: ${esc(run.error)}` : ''}.</p>`}
${(r.categories || []).length ? `<div class="cats">${r.categories.map((c) => `<div class="cat"><span>${esc(c.label)}</span><b>${!c.tested ? 'Not tested' : CATEGORIES[c.key]?.rules ? `${c.counts.pass}/${c.counts.pass + c.counts.warn + c.counts.fail} rules met` : esc(c.score)}</b></div>`).join('')}</div>` : ''}
<h2>What needs fixing (${problems.length})</h2>
${problems.length ? problems.map(problemHtml).join('') : '<p>Nothing to fix. Customers can shop and buy.</p>'}
${passed.length ? `<h2>Passed (${passed.length})</h2><ul class="passed">${passed.map((c) => `<li>${esc(c.title)}</li>`).join('')}</ul>` : ''}
${skipped.length ? `<h2>Not checked this time (${skipped.length})</h2><ul class="passed">${skipped.map((c) => `<li>${esc(c.title)}${c.detail ? ` – <span class="host">${esc(c.detail)}</span>` : ''}</li>`).join('')}</ul>` : ''}
${cover ? `<h2>What customers saw</h2><div class="cover"><img src="${cover}" alt="Store as customers saw it"></div>` : ''}
<footer>Report for ${esc(name)} (${esc(hostOf(store.url))}) from Tharam Store Guard · ${esc(config.baseUrl.replace(/^https?:\/\//, ''))} · Generated ${esc(new Date().toUTCString().replace(' GMT', ' UTC'))}</footer>
${autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},300)})</script>' : ''}
</body></html>`;
}

/** Any self-contained HTML page as a PDF, made by our own browser. One at a time, so exports never compete with checks. */
let pdfChain = Promise.resolve();
export function htmlToPdf(html) {
  const job = pdfChain.then(async () => {
    const browser = await getBrowser();
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await ctx.newPage();
      // Nothing outside the report may load: everything it shows is inline.
      await page.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
      await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
      return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
    } finally { await ctx.close().catch(() => {}); }
  });
  pdfChain = job.catch(() => {});
  return job;
}
/** The same report as a PDF. */
export const reportPdf = (store, run) => htmlToPdf(reportHtml(store, run));
