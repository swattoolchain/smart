import nodemailer from 'nodemailer';
import { config } from './config.js';
import { q } from './db.js';

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
      changes.push({ c, state: now === 'failing' ? 'failing' : 'recovered' });
    }
  }
  if (!changes.length) return;

  const link = `${config.baseUrl}/app#/runs/${runId}`;
  const failing = changes.filter((x) => x.state === 'failing');
  const recovered = changes.filter((x) => x.state === 'recovered');
  for (const x of changes) q.insertAlert.run(storeId, x.c.id, x.state, x.c.detail);

  const name = store.name || new URL(store.url).host;
  const lines = [
    ...failing.map((x) => `🔴 ${x.c.title}: ${x.c.detail}${x.c.fix ? `\n   Fix: ${x.c.fix}` : ''}`),
    ...recovered.map((x) => `🟢 Recovered: ${x.c.title}`),
  ];
  const subject = failing.length
    ? `${failing.some((x) => x.c.severity === 'critical') ? 'URGENT: ' : ''}${failing[0].c.title} failing on ${name}`
    : `Recovered on ${name}: ${recovered.map((x) => x.c.title).join(', ')}`;
  const text = `${lines.join('\n\n')}\n\nFull report with screenshots: ${link}\n\n— Tharam Store Guard`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1917">
<p><b>${name}</b></p>${lines.map((l) => `<p style="white-space:pre-wrap">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('')}
<p><a href="${link}" style="background:#14532d;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open report with screenshots</a></p>
<p style="color:#78716c;font-size:13px">Tharam Store Guard · You get alerts only when something changes.</p></div>`;

  const to = store.alert_email || q.userById.get(store.user_id)?.email;
  await Promise.allSettled([sendMail({ to, subject, text, html }), sendSlack(store.slack_webhook, `*${subject}*\n${text}`)]);
}
