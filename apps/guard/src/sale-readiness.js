/**
 * Sale readiness: one report before a sale or Black Friday, built from a full check. Seven questions a store
 * owner asks before a big day (can people buy, are prices right, do the codes work, is it fast on a phone,
 * are app scripts breaking things, are the laws where you sell met, does it look right), each answered
 * Ready / Needs attention / Fix before the sale / Not checked, with what to fix. Also as an email.
 */
import { config } from './config.js';
import { db, q } from './db.js';
import { groupOf, GROUPS } from './engine/catalog.js';
import { sendMail } from './alerts.js';

export const SECTIONS = [
  { key: 'buying', title: 'Customers can buy', groups: ['journey.core', 'journey.collection', 'journey.search', 'journey.variant', 'journey.checkout'],
    ready: 'A shopper found a product, added it to the cart and reached checkout.', missing: 'The shopping journey was not checked.' },
  { key: 'prices', title: 'Every price is right', groups: ['catalog'],
    ready: 'No zero prices, fake discounts, missing photos or unfinished descriptions.', missing: 'Your product catalog was not checked in this report.' },
  { key: 'codes', title: 'Discount codes work', groups: ['sale.discount'],
    ready: 'Your sale codes applied in a real cart and took the right amount off.', missing: 'No discount codes were tested. Add your sale codes under Test suite → Discount codes.' },
  { key: 'speed', title: 'Fast on a phone', groups: ['speed'],
    ready: 'Home and product pages load quickly on a phone.', missing: 'Phone speed was not measured in this report.' },
  { key: 'errors', title: 'No app or script errors', groups: ['errors.js'],
    ready: 'No script errors while shopping.', missing: 'Script errors were not checked.' },
  { key: 'laws', title: 'Laws where you sell', groups: ['law.de', 'law.cookies', 'access.law', 'law.us'],
    ready: 'Every legal rule we check for your markets is met.', missing: 'No legal checks for your markets. Set where you sell under Store settings.' },
  { key: 'looks', title: 'Looks right', groups: ['visual', 'ai.visual'],
    ready: 'Pages look like the version you approved.', missing: 'Screenshots were not compared in this report.' },
];
export const SALE_GROUPS = [...new Set(SECTIONS.flatMap((s) => s.groups))];
const LABEL = { ready: 'Ready', attention: 'Needs attention', blocker: 'Fix before the sale', not_checked: 'Not checked' };
const iso = (t) => (t && !t.includes('T') ? t.replace(' ', 'T') + 'Z' : t);

/** The latest finished full check of the store (or the given one), with its result. */
function sourceRun(storeId, runId) {
  const row = runId
    ? db.prepare("SELECT * FROM runs WHERE id = ? AND store_id = ? AND status = 'done'").get(runId, storeId)
    : db.prepare("SELECT * FROM runs WHERE store_id = ? AND status = 'done' AND kind = 'full' AND (trigger IS NULL OR trigger != 'release') ORDER BY id DESC LIMIT 1").get(storeId);
  if (!row) return null;
  try { return { row, result: JSON.parse(row.result_json || '{}') }; } catch { return null; }
}

export function saleReadiness(store, runId = null) {
  const src = sourceRun(store.id, runId);
  if (!src) return null;
  const { row, result } = src;
  return {
    store: { id: store.id, name: store.name || hostOf(store.url), url: store.url },
    runId: row.id, checkedAt: iso(row.finished_at || row.created_at), kind: row.kind,
    ...readinessFrom(result),
    reportUrl: `${config.baseUrl}/app#/s/${store.id}/reports/${row.id}`,
    pageUrl: `${config.baseUrl}/app#/s/${store.id}/sale`,
  };
}

/** The seven answers and the verdict, from one check's result. */
export function readinessFrom(result) {
  const checks = (result.checks || []).filter((c) => c.status !== 'skip');
  const sections = SECTIONS.map((sec) => {
    const mine = checks.filter((c) => sec.groups.includes(groupOf(c.id)));
    const problems = mine.filter((c) => c.status === 'fail' || c.status === 'warn')
      .sort((a, b) => (a.status === 'fail' ? 0 : 1) - (b.status === 'fail' ? 0 : 1) || (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1));
    let status = 'ready';
    if (!mine.length) status = 'not_checked';
    // Anything that stops a sale must be fixed first: a critical failure, a sale code that doesn't work, or a
    // pricing mistake (a zero price or a fake discount) that the sale would put in front of many more shoppers.
    else if (problems.some((c) => c.status === 'fail' && (c.severity === 'critical' || sec.key === 'codes' || c.id === 'cat.pricing'))) status = 'blocker';
    else if (problems.length) status = 'attention';
    let summary = status === 'ready' ? sec.ready : status === 'not_checked' ? sec.missing : `${problems.length} thing${problems.length === 1 ? '' : 's'} to look at.`;
    if (sec.key === 'prices' && result.catalog?.count && status !== 'not_checked') summary = `${result.catalog.count} products checked. ${summary}`;
    if (sec.key === 'laws' && mine.length) summary = `${mine.filter((c) => c.status === 'pass').length} of ${mine.length} rules met. ${status === 'ready' ? '' : summary}`.trim();
    return {
      key: sec.key, title: sec.title, status, label: LABEL[status], summary,
      checked: mine.length,
      items: problems.slice(0, 8).map((c) => ({ id: c.id, title: c.title, status: c.status, severity: c.severity, detail: c.detail, fix: c.fix || '' })),
      more: Math.max(0, problems.length - 8),
    };
  });
  const blockers = sections.filter((s) => s.status === 'blocker').length;
  const attention = sections.filter((s) => s.status === 'attention').length;
  const notChecked = sections.filter((s) => s.status === 'not_checked').length;
  const verdict = blockers ? 'blocked' : attention ? 'attention' : notChecked ? 'partial' : 'ready';
  const headline = {
    blocked: `Fix ${blockers} thing${blockers === 1 ? '' : 's'} before your sale.`,
    attention: `Almost ready: ${attention} area${attention === 1 ? '' : 's'} to look at before your sale.`,
    partial: `Everything we checked is ready. ${notChecked} area${notChecked === 1 ? ' was' : 's were'} not checked.`,
    ready: 'Ready for your sale.',
  }[verdict];
  return { verdict, headline, counts: { blockers, attention, notChecked, ready: sections.length - blockers - attention - notChecked }, sections };
}
const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };

/** The groups a sale readiness check runs for this store: law packs only for the markets it sells in. */
export function saleGroups(store) {
  let markets = [];
  try { markets = JSON.parse(store?.config_json || '{}').markets || []; } catch {}
  return GROUPS.filter((g) => (SALE_GROUPS.includes(g.key) || g.locked) && (!g.markets || g.markets.some((m) => markets.includes(m)))).map((g) => g.key);
}

const ICON = { ready: '✅', attention: '🟠', blocker: '🔴', not_checked: '⚪' };
const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The email version: subject, plain text and HTML. */
export function saleEmail(r) {
  const subject = `Sale readiness for ${r.store.name}: ${r.verdict === 'ready' ? 'ready' : r.verdict === 'blocked' ? `fix ${r.counts.blockers} thing${r.counts.blockers === 1 ? '' : 's'} first` : r.verdict === 'attention' ? 'almost ready' : 'ready where checked'}`;
  const when = new Date(r.checkedAt).toUTCString().replace(':00 GMT', ' UTC');
  const text = [
    `${r.headline}`,
    `From the full check of ${r.store.url} on ${when}.`,
    '',
    ...r.sections.flatMap((s) => [
      `${ICON[s.status]} ${s.title}: ${s.label}. ${s.summary}`,
      ...s.items.map((i) => `   - ${i.title}: ${i.detail}${i.fix ? `\n     Fix: ${i.fix}` : ''}`),
      ...(s.more ? [`   - and ${s.more} more in the report`] : []),
    ]),
    '',
    `Full report with screenshots: ${r.reportUrl}`,
    `Sale readiness page: ${r.pageUrl}`,
    '',
    '— Tharam',
  ].join('\n');
  const color = { ready: '#15803d', attention: '#b45309', blocker: '#b91c1c', not_checked: '#78716c' };
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1917;max-width:640px">
<p style="font-size:13px;color:#78716c;margin:0">Sale readiness · ${escHtml(r.store.name)}</p>
<h2 style="margin:4px 0 6px">${escHtml(r.headline)}</h2>
<p style="color:#57534e;margin:0 0 16px">From the full check on ${escHtml(when)}.</p>
${r.sections.map((s) => `<div style="border:1px solid #e7e5e4;border-left:4px solid ${color[s.status]};border-radius:8px;padding:10px 14px;margin:0 0 10px">
<p style="margin:0"><b>${escHtml(s.title)}</b> · <span style="color:${color[s.status]};font-weight:600">${escHtml(s.label)}</span></p>
<p style="margin:2px 0 0;color:#57534e">${escHtml(s.summary)}</p>
${s.items.length ? `<ul style="margin:8px 0 0;padding-left:18px">${s.items.map((i) => `<li><b>${escHtml(i.title)}</b>: ${escHtml(i.detail)}${i.fix ? `<br><span style="color:#57534e">Fix: ${escHtml(i.fix)}</span>` : ''}</li>`).join('')}${s.more ? `<li>and ${s.more} more in the report</li>` : ''}</ul>` : ''}
</div>`).join('')}
<p style="margin:18px 0"><a href="${escHtml(r.reportUrl)}" style="background:#14532d;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open the full report</a></p>
<p style="color:#78716c;font-size:13px">Tharam · Run a fresh sale readiness check any time from the Sale readiness page.</p></div>`;
  return { subject, text, html };
}

const SENT = new Map(); // storeId → [times], at most 5 emails an hour per store
export async function emailSaleReadiness(store, r, to) {
  const now = Date.now();
  const recent = (SENT.get(store.id) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= 5) { const e = new Error('You have emailed this report 5 times in the last hour. Try again later.'); e.status = 429; throw e; }
  SENT.set(store.id, [...recent, now]);
  const m = saleEmail(r);
  await sendMail({ to, ...m });
  return { to, subject: m.subject };
}

/** Where the summary goes: the store's alert email, else the account email. */
export function saleRecipients(store) {
  return store.alert_email || q.userById.get(store.user_id)?.email || null;
}
