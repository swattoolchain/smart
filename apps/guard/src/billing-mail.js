/** Emails about the customer's plan: reminders before expiry, on expiry, and a receipt for every payment. */
import { config } from './config.js';
import { sendMail } from './alerts.js';
import { dueNotices, getPlan, setting, markNotice } from './license.js';

export const money = (minor, currency) => {
  try { return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100); }
  catch { return `${(minor / 100).toFixed(2)} ${currency}`; }
};
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const day = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const wrap = (lines, cta) => `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#1c1917">${lines.map((l) => `<p>${l}</p>`).join('')}
${cta ? `<p><a href="${cta[1]}" style="background:#3346d3;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${cta[0]}</a></p>` : ''}<p style="color:#78716c;font-size:13px">Tharam</p></div>`;

export async function sendLicenseNotices() {
  for (const { license: l, kind, user } of dueNotices()) {
    if (!user) continue;
    const plan = getPlan(l.plan_key);
    const trial = l.status === 'trial';
    const what = trial ? 'Your free trial' : `Your ${plan?.name || ''} plan`;
    const link = `${config.baseUrl}/app#/account/billing`;
    const note = setting('payment_note');
    const subject = {
      d7: `${what} ends on ${day(l.expires_at)}`,
      d1: `${what} ends tomorrow`,
      grace: `${what} has expired: your store checks continue for a few more days`,
      expired: trial ? 'Your free trial has ended' : 'Your plan has expired and store checks have stopped',
    }[kind];
    const body = {
      d7: `${what} ends on <b>${day(l.expires_at)}</b>. ${trial ? 'Choose a plan to keep your stores checked.' : 'Renew it to keep your stores checked without a gap.'}`,
      d1: `${what} ends tomorrow. After that, scheduled checks and alerts stop.`,
      grace: `${what} expired on ${day(l.expires_at)}. We keep checking your stores for a few more days so nothing is missed while you renew.`,
      expired: 'Scheduled checks and alerts have stopped. Your reports and settings are kept, and everything starts again as soon as you renew.',
    }[kind];
    const text = `${body.replace(/<[^>]+>/g, '')}\n\n${note}\n\nYour plan: ${link}\n\n— Tharam`;
    try { await sendMail({ to: user.email, subject, text, html: wrap([body, esc(note)], ['See your plan', link]) }); markNotice(l, kind); }
    catch (e) { console.error('notice mail failed; will retry', e); continue; }
    if (config.adminEmail) sendMail({ to: config.adminEmail, subject: `[licence] ${user.email}: ${kind}`, text: `${user.email} · ${plan?.name} · expires ${l.expires_at}` }).catch(() => {});
  }
}

export async function sendReceipt(user, payment, license) {
  const plan = getPlan(license.plan_key);
  const lines = [
    `Thank you. We received <b>${money(payment.amount, payment.currency)}</b> for Tharam ${plan?.name || ''} (${license.seats} store${license.seats === 1 ? '' : 's'}).`,
    `Your plan is active until <b>${day(license.expires_at)}</b>.`,
    payment.reference ? `Reference: ${esc(payment.reference)}` : '',
  ].filter(Boolean);
  await sendMail({
    to: user.email, subject: `Payment received: Tharam ${plan?.name || ''}, active until ${day(license.expires_at)}`,
    text: lines.join('\n').replace(/<[^>]+>/g, '') + `\n\n${config.baseUrl}/app#/account/billing\n\n— Tharam`,
    html: wrap(lines, ['See your plan', `${config.baseUrl}/app#/account/billing`]),
  });
}
