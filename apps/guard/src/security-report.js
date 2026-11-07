/**
 * Security watch S13: the monthly security report. One page (and PDF, and email) that tells the owner, in plain
 * words, what Tharam saw in the last 30 days: security problems found and whether they are fixed, what changed
 * (app code, incidents), and where the owner's security checklist stands.
 *
 * Built from data we already keep (finished checks, alerts, app code changes, incidents, the checklist), so it
 * never touches the store. The email goes out once a calendar month per store, never twice, and owners can
 * switch it off.
 */
import { db, q, ensureColumn } from './db.js';
import { config } from './config.js';
import { sendMail } from './alerts.js';
import { groupOf, GROUPS } from './engine/catalog.js';
import { checklist } from './security-checklist.js';
import { isOn } from './features.js';
import './early-warning.js'; // creates app_code_changes
import './incident.js'; // creates incidents

db.exec(`
CREATE TABLE IF NOT EXISTS security_report_log (
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (store_id, month)
);
`);
ensureColumn('security_settings', 'monthly_report', 'INTEGER NOT NULL DEFAULT 1');

export const REPORT_DAYS = 30;
export const MIN_STORE_AGE_DAYS = 7; // a brand-new store has no month to report on yet
const DAY = 24 * 3600 * 1000;
const SEVERITY = { critical: 0, major: 1, minor: 2 };
const SEVERITY_LABEL = { critical: 'Serious', major: 'Important', minor: 'Minor' };
const sqlTime = (s) => (s ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : String(s).replace(' ', 'T') + 'Z') : NaN);
const iso = (ms) => new Date(ms).toISOString();
const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u || 'store'); } };
const isSecurityGroup = (g) => !!g && g.startsWith('security.');
const GROUP_LABEL = Object.fromEntries(GROUPS.map((g) => [g.key, g.label]));

const Q = {
  runs: db.prepare("SELECT id, kind, created_at, finished_at, result_json FROM runs WHERE store_id = ? AND status = 'done' AND (trigger IS NULL OR trigger != 'release') AND created_at >= ? AND created_at <= ? ORDER BY id"),
  alerts: db.prepare("SELECT check_id, state FROM alerts WHERE store_id = ? AND check_id LIKE 'security.%' AND created_at >= ? AND created_at <= ?"),
  appChanges: db.prepare('SELECT app_name, app_key, files_json, seen_at FROM app_code_changes WHERE store_id = ? AND seen_at >= ? AND seen_at <= ? ORDER BY seen_at'),
  incidents: db.prepare('SELECT started_at, ended_at, reason FROM incidents WHERE store_id = ? AND started_at >= ? AND started_at <= ? ORDER BY started_at'),
  settings: db.prepare('SELECT monthly_report FROM security_settings WHERE store_id = ?'),
  setMonthly: db.prepare('INSERT INTO security_settings (store_id, monthly_report) VALUES (?, ?) ON CONFLICT(store_id) DO UPDATE SET monthly_report = excluded.monthly_report'),
  logged: db.prepare('SELECT 1 FROM security_report_log WHERE store_id = ? AND month = ?'),
  log: db.prepare('INSERT OR IGNORE INTO security_report_log (store_id, month) VALUES (?, ?)'),
  stores: db.prepare('SELECT * FROM stores ORDER BY id'),
};
const sqlStamp = (ms) => iso(ms).slice(0, 19).replace('T', ' ');

export const monthlyOn = (storeId) => (Q.settings.get(storeId)?.monthly_report ?? 1) === 1;
export function setMonthly(storeId, on) { Q.setMonthly.run(storeId, on ? 1 : 0); }

/** The report for one store the caller already checked ownership of. */
export function securityReport(store, { now = Date.now(), days = REPORT_DAYS, shopify = false } = {}) {
  const from = now - days * DAY;
  const runs = Q.runs.all(store.id, sqlStamp(from), sqlStamp(now)).map((r) => {
    let checks = [];
    try { checks = JSON.parse(r.result_json || '{}').checks || []; } catch {}
    const sec = checks.filter((c) => isSecurityGroup(groupOf(c.id)));
    return { id: r.id, at: sqlTime(r.finished_at || r.created_at), sec, groups: new Set(sec.map((c) => groupOf(c.id))) };
  });

  // Security problems: every check id that failed or warned at least once this month.
  const seen = new Map();
  runs.forEach((run, idx) => {
    for (const c of run.sec) {
      if (c.status !== 'fail' && c.status !== 'warn') continue;
      const t = seen.get(c.id) || { id: c.id, group: groupOf(c.id), times: 0, firstAt: run.at, lastAt: run.at, lastIdx: idx, last: c };
      t.times++; t.lastAt = run.at; t.lastIdx = idx; t.last = c;
      if (c.status === 'fail') t.failed = true;
      seen.set(c.id, t);
    }
  });
  const problems = [...seen.values()].map((t) => {
    // Fixed once a later check looked at the same area and the problem was gone (or passing).
    const fixed = runs.slice(t.lastIdx + 1).some((run) => run.groups.has(t.group) && run.sec.every((c) => c.id !== t.id || c.status === 'pass'));
    return {
      id: t.id, area: GROUP_LABEL[t.group] || t.group, title: t.last.title, severity: t.last.severity || 'minor',
      detail: t.last.detail || '', fix: t.last.fix || '', times: t.times,
      firstSeen: iso(t.firstAt), lastSeen: iso(t.lastAt), state: fixed ? 'fixed' : 'open',
    };
  }).sort((a, b) => (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) || (SEVERITY[a.severity] ?? 3) - (SEVERITY[b.severity] ?? 3) || a.title.localeCompare(b.title));

  // What was watched: the security areas that ran at least once, and how often.
  const watched = new Map();
  for (const run of runs) for (const g of run.groups) watched.set(g, (watched.get(g) || 0) + 1);
  const areas = [...watched.entries()].map(([g, n]) => ({ key: g, label: GROUP_LABEL[g] || g, checks: n })).sort((a, b) => a.label.localeCompare(b.label));

  const alerts = Q.alerts.all(store.id, sqlStamp(from), sqlStamp(now));
  const appChanges = Q.appChanges.all(store.id, sqlStamp(from), sqlStamp(now)).map((r) => {
    let files = [];
    try { files = JSON.parse(r.files_json || '[]'); } catch {}
    return { app: r.app_name || r.app_key, files: Array.isArray(files) ? files.length : 0, at: iso(sqlTime(r.seen_at)) };
  });
  const incidents = Q.incidents.all(store.id, sqlStamp(from), sqlStamp(now)).map((r) => ({
    startedAt: iso(sqlTime(r.started_at)), endedAt: r.ended_at ? iso(sqlTime(r.ended_at)) : null, reason: r.reason || '',
  }));

  const list = isOn('security_checklist') ? checklist(store, { now, shopify }) : null;
  const open = problems.filter((p) => p.state === 'open');
  const serious = open.filter((p) => p.severity === 'critical' || p.severity === 'major').length;
  const verdict = !runs.length ? 'nodata' : open.length ? (serious ? 'act' : 'watch') : 'clear';
  const headline = {
    nodata: 'No checks finished this month, so there is nothing to report yet.',
    act: `${open.length} security problem${open.length === 1 ? ' is' : 's are'} still open. ${serious === open.length ? 'Fix them first.' : 'Start with the serious ones.'}`,
    watch: `${open.length} small security issue${open.length === 1 ? ' is' : 's are'} still open. Nothing serious.`,
    clear: problems.length ? `We found ${problems.length} security problem${problems.length === 1 ? '' : 's'} this month and ${problems.length === 1 ? 'it is' : 'all are'} now fixed.` : 'No security problems seen this month.',
  }[verdict];
  const name = store.name || hostOf(store.url);
  return {
    store: { id: store.id, name, url: store.url },
    period: { from: iso(from), to: iso(now), days },
    verdict, headline,
    checksRun: runs.length, areas,
    problems,
    counts: { found: problems.length, open: open.length, fixed: problems.length - open.length, serious, alerts: alerts.filter((a) => a.state === 'failing').length },
    changes: { appCode: appChanges, incidents },
    checklist: list && {
      score: list.score, grade: list.grade, counts: list.counts,
      open: list.items.filter((i) => i.state !== 'done').map((i) => ({ title: i.title, state: i.state })),
    },
    pageUrl: `${config.baseUrl}/app#/s/${store.id}/securityreport`,
    checklistUrl: `${config.baseUrl}/app#/s/${store.id}/security`,
  };
}

// ---------- Printable page (also the source of the PDF) ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const day = (t) => new Date(t).toUTCString().slice(5, 16);

export function reportHtml(r, { autoPrint = false } = {}) {
  const color = { clear: '#1b7f3b', watch: '#b26a00', act: '#c62828', nodata: '#6b7280' }[r.verdict];
  const prob = (p) => `<div class="chk ${p.state}"><div class="top"><span class="st">${p.state === 'open' ? 'Still open' : 'Fixed'}</span><h3>${esc(p.title)}</h3><span class="sev">${esc(SEVERITY_LABEL[p.severity] || p.severity)}</span></div>
    <p>${esc(p.detail)}</p><p class="meta">${esc(p.area)} · first seen ${esc(day(p.firstSeen))}, last seen ${esc(day(p.lastSeen))}${p.times > 1 ? `, in ${p.times} checks` : ''}</p>${p.state === 'open' && p.fix ? `<p class="fix"><b>How to fix:</b> ${esc(p.fix)}</p>` : ''}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(r.store.name)} – Tharam monthly security report</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font: 13px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111827; margin: 0 auto; padding: 24px; max-width: 900px; background: #fff; }
  header { display: flex; justify-content: space-between; border-bottom: 2px solid #111827; padding-bottom: 12px; margin-bottom: 18px; gap: 16px; }
  header h1 { font-size: 22px; margin: 0 0 2px; } .host { color: #4b5563; }
  header .brand { text-align: right; color: #4b5563; font-size: 12px; } header .brand b { color: #111827; font-size: 15px; letter-spacing: .02em; }
  .headline { border-left: 6px solid ${color}; padding: 6px 14px; margin-bottom: 16px; font-size: 18px; font-weight: 700; color: ${color}; }
  .nums { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 18px; }
  .num { border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px 10px; } .num span { display: block; color: #6b7280; font-size: 11.5px; } .num b { font-size: 20px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: #374151; margin: 22px 0 8px; }
  .chk { border: 1px solid #e5e7eb; border-left: 4px solid #9ca3af; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; break-inside: avoid; }
  .chk.open { border-left-color: #c62828; } .chk.fixed { border-left-color: #1b7f3b; }
  .chk .top { display: flex; gap: 10px; align-items: baseline; } .chk h3 { font-size: 14px; margin: 0; flex: 1; }
  .chk .st { font-weight: 700; font-size: 12px; } .chk.open .st { color: #c62828; } .chk.fixed .st { color: #1b7f3b; }
  .chk .sev, .meta { color: #6b7280; font-size: 11.5px; } .chk p { margin: 6px 0 0; } .fix { background: #f3f4f6; padding: 6px 8px; border-radius: 4px; }
  ul { margin: 0; padding-left: 18px; }
  footer { margin-top: 26px; border-top: 1px solid #e5e7eb; padding-top: 8px; color: #6b7280; font-size: 11.5px; }
  @media print { body { padding: 0; } }
</style></head><body>
<header><div><h1>${esc(r.store.name)}</h1><div class="host">${esc(hostOf(r.store.url))}</div><div class="host">${esc(day(r.period.from))} to ${esc(day(r.period.to))}</div></div>
<div class="brand"><b>THARAM</b><br>Monthly security report</div></header>
<div class="headline">${esc(r.headline)}</div>
<div class="nums"><div class="num"><span>Checks that looked for threats</span><b>${r.checksRun}</b></div><div class="num"><span>Problems found</span><b>${r.counts.found}</b></div><div class="num"><span>Fixed</span><b>${r.counts.fixed}</b></div><div class="num"><span>Still open</span><b>${r.counts.open}</b></div></div>
<h2>Threats and problems (${r.problems.length})</h2>
${r.problems.length ? r.problems.map(prob).join('') : '<p>Nothing suspicious was seen. Customers were not sent to other sites, no card-reading scripts appeared, and your pages were not defaced.</p>'}
<h2>What changed</h2>
${r.changes.appCode.length || r.changes.incidents.length ? `<ul>${r.changes.appCode.map((c) => `<li>${esc(c.app)} changed its code on your store (${esc(day(c.at))}${c.files ? `, ${c.files} file${c.files === 1 ? '' : 's'}` : ''}).</li>`).join('')}${r.changes.incidents.map((i) => `<li>Incident mode was on from ${esc(day(i.startedAt))}${i.endedAt ? ` to ${esc(day(i.endedAt))}` : ' (still on)'}.</li>`).join('')}</ul>` : '<p>No app code changes and no incidents this month.</p>'}
${r.checklist ? `<h2>Your security checklist</h2><p><b>${r.checklist.score} of 100</b> (${esc(r.checklist.grade)}). ${r.checklist.counts.done} of ${r.checklist.counts.total} done.</p>${r.checklist.open.length ? `<ul>${r.checklist.open.map((i) => `<li>${i.state === 'due' ? 'Review again' : 'To do'}: ${esc(i.title)}</li>`).join('')}</ul>` : ''}` : ''}
${r.areas.length ? `<h2>What we watched</h2><p>${r.areas.map((a) => esc(a.label)).join(', ')}.</p>` : ''}
<footer>Monthly security report for ${esc(r.store.name)} from Tharam Store Guard · ${esc(config.baseUrl.replace(/^https?:\/\//, ''))} · Generated ${esc(new Date().toUTCString().replace(' GMT', ' UTC'))}</footer>
${autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},300)})</script>' : ''}
</body></html>`;
}

// ---------- Email ----------
export function reportEmail(r) {
  const subject = `Security report for ${r.store.name}: ${r.verdict === 'clear' ? (r.counts.found ? 'all problems fixed' : 'all clear') : r.verdict === 'nodata' ? 'nothing to report yet' : `${r.counts.open} still open`}`;
  const lines = r.problems.slice(0, 8).map((p) => `${p.state === 'open' ? 'Still open' : 'Fixed'}: ${p.title}${p.state === 'open' && p.fix ? `\n   Fix: ${p.fix}` : ''}`);
  const text = [
    r.headline, `${day(r.period.from)} to ${day(r.period.to)} · ${r.checksRun} checks looked for threats.`, '',
    ...(lines.length ? lines : ['Nothing suspicious was seen.']),
    ...(r.problems.length > 8 ? [`and ${r.problems.length - 8} more in the report`] : []),
    ...(r.checklist ? ['', `Your security checklist: ${r.checklist.score} of 100 (${r.checklist.grade}). ${r.checklistUrl}`] : []),
    '', `Full report (print it or save it as a PDF): ${r.pageUrl}`,
    '', 'You get this once a month. Switch it off on the report page.', '', '— Tharam',
  ].join('\n');
  const color = { clear: '#15803d', watch: '#b45309', act: '#b91c1c', nodata: '#78716c' }[r.verdict];
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1917;max-width:640px">
<p style="font-size:13px;color:#78716c;margin:0">Monthly security report · ${esc(r.store.name)}</p>
<h2 style="margin:4px 0 6px;color:${color}">${esc(r.headline)}</h2>
<p style="color:#57534e;margin:0 0 14px">${esc(day(r.period.from))} to ${esc(day(r.period.to))} · ${r.checksRun} checks looked for threats.</p>
${r.problems.slice(0, 8).map((p) => `<div style="border:1px solid #e7e5e4;border-left:4px solid ${p.state === 'open' ? '#b91c1c' : '#15803d'};border-radius:8px;padding:8px 12px;margin:0 0 8px"><b>${p.state === 'open' ? 'Still open' : 'Fixed'}: ${esc(p.title)}</b>${p.state === 'open' && p.fix ? `<br><span style="color:#57534e">Fix: ${esc(p.fix)}</span>` : ''}</div>`).join('') || '<p>Nothing suspicious was seen.</p>'}
${r.checklist ? `<p>Your security checklist: <b>${r.checklist.score} of 100</b> (${esc(r.checklist.grade)}). <a href="${esc(r.checklistUrl)}">Open the checklist</a></p>` : ''}
<p style="margin:18px 0"><a href="${esc(r.pageUrl)}" style="background:#14532d;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open the full report</a></p>
<p style="color:#78716c;font-size:13px">You get this once a month. You can switch it off on the report page.</p></div>`;
  return { subject, text, html };
}

const SENT = new Map(); // storeId → times: owners can email the report to themselves at most 5 times an hour
export async function emailReport(store, r, to) {
  const now = Date.now();
  const recent = (SENT.get(store.id) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= 5) { const e = new Error('You have emailed this report 5 times in the last hour. Try again later.'); e.status = 429; throw e; }
  SENT.set(store.id, [...recent, now]);
  const m = reportEmail(r);
  await sendMail({ to, ...m });
  return { to, subject: m.subject };
}

export const reportRecipient = (store) => store.alert_email || q.userById.get(store.user_id)?.email || null;

/** Sends this month's report to every store that is due. Once per store per calendar month; safe to call often. */
export async function sendMonthlyReports({ now = Date.now(), isShopify = () => false, send = sendMail } = {}) {
  if (!isOn('security_report')) return 0;
  const month = iso(now).slice(0, 7);
  let sent = 0;
  for (const store of Q.stores.all()) {
    if (!store.monitoring || !monthlyOn(store.id) || Q.logged.get(store.id, month)) continue;
    if (now - sqlTime(store.created_at) < MIN_STORE_AGE_DAYS * DAY) continue;
    const to = reportRecipient(store);
    if (!to) continue;
    // Recorded before sending, so a slow or failing mail server can never cause repeats.
    Q.log.run(store.id, month);
    try {
      const r = securityReport(store, { now, shopify: isShopify(store) });
      if (r.verdict === 'nodata') continue;
      await send({ to, ...reportEmail(r) });
      sent++;
    } catch (e) { console.error('monthly security report failed', store.id, e.message); }
  }
  return sent;
}
