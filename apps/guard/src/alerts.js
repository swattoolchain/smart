import nodemailer from 'nodemailer';
import { config } from './config.js';
import { q } from './db.js';
import { groupOf, effectiveDisabled } from './engine/catalog.js';
import { entitlements, has } from './license.js';

let transport = null;
function mailer() {
  if (!config.smtp.host) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
}

export async function sendMail({ to, subject, text, html }) {
  const t = mailer();
  if (!t || !to) {
    console.log(`[mail skipped] to=${to} subject=${subject}`);
    if (process.env.NODE_ENV !== 'production' && process.env.MAIL_DEBUG) console.log(text);
    return false;
  }
  await t.sendMail({ from: config.smtp.from, to, subject, text, html });
  return true;
}

export async function sendSlack(webhook, text) {
  if (!webhook || !/^https:\/\/hooks\.slack\.com\//.test(webhook)) return false;
  const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  return r.ok;
}

/**
 * Sends alerts only when a check changes state (pass → fail, or fail → pass),
 * so merchants are not spammed with the same problem every run.
 * Failures in critical checks are confirmed by the scheduler's retry before alerting.
 */
export async function handleAlerts(storeId, runId, result) {
  const store = q.storeById.get(storeId);
  if (!store) return;
  const changes = [];
  for (const c of result.checks || []) {
    if (c.status === 'skip') continue;
    const bad = c.status === 'fail' && (c.severity === 'critical' || c.severity === 'major');
    const now = bad ? 'failing' : 'ok';
    const prev = q.getCheckState.get(storeId, c.id);
    if (!prev) {
      q.upsertCheckState.run(storeId, c.id, now);
      if (bad) changes.push({ c, state: 'failing' });
      continue;
    }
    if (prev.status !== now) {
      q.upsertCheckState.run(storeId, c.id, now);
      // Notices (like a new script) are news once; they don't "recover".
      if (now === 'failing' || !c.notice) changes.push({ c, state: now === 'failing' ? 'failing' : 'recovered' });
    }
  }
  // A failure whose check no longer runs (switched off in the suite, or replaced by a better check) can never
  // recover by itself. Close it quietly on a full check rather than leaving it "broken" forever.
  const ran = new Set((result.checks || []).map((c) => c.id));
  const skipped = new Set(result.skippedGroups || []);
  let suiteOff = new Set();
  try { suiteOff = new Set(effectiveDisabled(JSON.parse(store.config_json || '{}'))); } catch {}
  for (const row of q.failingChecks.all(storeId)) {
    if (ran.has(row.check_id)) continue;
    const g = groupOf(row.check_id);
    if (!g) continue;
    if (suiteOff.has(g) || (result.kind === 'full' && !skipped.has(g))) q.upsertCheckState.run(storeId, row.check_id, 'ok');
  }
  if (!changes.length) return;

  const link = `${config.baseUrl}/app#/s/${storeId}/reports/${runId}`;
  const failing = changes.filter((x) => x.state === 'failing');
  const recovered = changes.filter((x) => x.state === 'recovered');
  for (const x of changes) q.insertAlert.run(storeId, x.c.id, x.state, x.c.detail, x.c.title);

  const name = store.name || new URL(store.url).host;
  const lines = [
    ...failing.map((x) => `🔴 ${x.c.title}: ${x.c.detail}${x.c.fix ? `\n   Fix: ${x.c.fix}` : ''}`),
    ...recovered.map((x) => `🟢 Recovered: ${x.c.title}`),
  ];
  const subject = failing.length
    ? `${failing.some((x) => x.c.severity === 'critical') ? 'Urgent: ' : ''}Check failed on ${name}: ${failing[0].c.title}${failing.length > 1 ? ` (+${failing.length - 1} more)` : ''}`
    : `Fixed on ${name}: ${recovered.map((x) => x.c.title).join(', ')}`;
  const text = `${lines.join('\n\n')}\n\nFull report with screenshots: ${link}\n\n— Tharam Store Guard`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1917">
<p><b>${name}</b></p>${lines.map((l) => `<p style="white-space:pre-wrap">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('')}
<p><a href="${link}" style="background:#14532d;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open report with screenshots</a></p>
<p style="color:#78716c;font-size:13px">Tharam Store Guard · You get alerts only when something changes.</p></div>`;

  const to = store.alert_email || q.userById.get(store.user_id)?.email;
  const slack = has(entitlements(store.user_id), 'slack') ? store.slack_webhook : null;
  await Promise.allSettled([sendMail({ to, subject, text, html }), sendSlack(slack, `*${subject}*\n${text}`)]);
}
