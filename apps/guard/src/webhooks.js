/**
 * Webhook alerts: the same alerts as email and Slack, posted as JSON to an address the store owner chooses
 * (Zapier, Make, Microsoft Teams, Discord, or their own system). One webhook per store.
 *
 * Formats
 *   json     our own payload (event, store, run, failing and recovered checks, text), for Zapier/Make/your code
 *   teams    a Microsoft Teams message (Adaptive Card), for a Teams "When a webhook request is received" workflow
 *   discord  a Discord message ({ content }), mentions switched off
 *   auto     picked from the address (discord.com → discord, Teams/Power Automate → teams, else json)
 *
 * Every request is signed: X-Tharam-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the
 * store's webhook secret>. Receivers should check it and refuse old timestamps.
 *
 * Delivery: up to 4 attempts (now, then after 1, 5 and 30 minutes) on network errors, timeouts, 408, 429 and 5xx.
 * Other answers (e.g. 404, 410) stop at once. Redirects are not followed. Every delivery is recorded so the owner
 * can see what happened. Retries waiting when the server restarts are not resumed.
 */
import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { assertPublicTarget } from './engine/browser.js';

db.exec(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL,
  delivery_id TEXT NOT NULL,
  event TEXT NOT NULL,
  host TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | delivered | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  last_code INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_store ON webhook_deliveries(store_id, id);`);

export const FORMATS = ['auto', 'json', 'teams', 'discord'];
const BASE_MS = Number(process.env.WEBHOOK_RETRY_MS || 60000);
export const RETRY_DELAYS = [0, 1, 5, 30].map((m) => m * BASE_MS);
const TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 10000);

const D = {
  insert: db.prepare('INSERT INTO webhook_deliveries (store_id, delivery_id, event, host) VALUES (?, ?, ?, ?)'),
  update: db.prepare("UPDATE webhook_deliveries SET status = ?, attempts = ?, last_code = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?"),
  list: db.prepare('SELECT delivery_id, event, host, status, attempts, last_code, last_error, created_at, updated_at FROM webhook_deliveries WHERE store_id = ? ORDER BY id DESC LIMIT ?'),
};

/** The store's webhook settings ({ url, format, secret }) or null. */
export function webhookOf(store) {
  try { const w = JSON.parse(store?.webhook_json || 'null'); return w?.url ? w : null; } catch { return null; }
}
export const newSecret = () => `whsec_${crypto.randomBytes(24).toString('base64url')}`;

/** The format actually used for an address. */
export function resolveFormat(url, format = 'auto') {
  if (format && format !== 'auto') return format;
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  if (/(^|\.)discord(app)?\.com$/.test(host)) return 'discord';
  if (/(^|\.)webhook\.office\.com$|(^|\.)logic\.azure\.com$|(^|\.)powerplatform\.com$|(^|\.)powerautomate\.com$/.test(host)) return 'teams';
  return 'json';
}

/** Checks an address the owner typed. Throws a plain message. Returns the cleaned address. */
export async function checkWebhookUrl(raw) {
  const s = String(raw || '').trim();
  let u;
  try { u = new URL(s); } catch { throw new Error('Enter the full webhook address, starting with https://'); }
  const local = process.env.ALLOW_LOCAL_TARGETS === '1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('Webhook addresses must start with https://');
  if (u.username || u.password) throw new Error('Remove the user name and password from the webhook address.');
  if (s.length > 500) throw new Error('This webhook address is too long.');
  try { await assertPublicTarget(u.origin); } catch { throw new Error('We can only send to public addresses. This one points to a private network or doesn\'t exist.'); }
  return u.toString();
}

/** Signature header value for a body. */
export function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/**
 * The alert as data. `failing` / `recovered`: [{ id, title, severity, detail, fix }].
 */
export function payloadFor({ event, store, runId = null, failing = [], recovered = [], subject, text, deliveryId }) {
  const name = store.name || new URL(store.url).host;
  return {
    event, id: deliveryId, createdAt: new Date().toISOString(),
    store: { id: store.id, name, url: store.url, dashboardUrl: `${config.baseUrl}/app#/s/${store.id}` },
    run: runId ? { id: runId, reportUrl: `${config.baseUrl}/app#/s/${store.id}/reports/${runId}` } : null,
    summary: subject,
    failing: failing.map((c) => ({ id: c.id, title: c.title, severity: c.severity || null, detail: c.detail || '', fix: c.fix || '' })),
    recovered: recovered.map((c) => ({ id: c.id, title: c.title })),
    text,
  };
}

/** The request body for a format. */
export function bodyFor(format, p) {
  if (format === 'discord') {
    const content = `**${p.summary}**\n${p.text}`;
    return { username: 'Tharam', content: content.length > 2000 ? content.slice(0, 1990) + '…' : content, allowed_mentions: { parse: [] } };
  }
  if (format === 'teams') {
    const link = p.run?.reportUrl || p.store.dashboardUrl;
    return {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
          body: [
            { type: 'TextBlock', text: p.summary, weight: 'Bolder', size: 'Medium', wrap: true },
            ...p.failing.map((c) => ({ type: 'TextBlock', text: `🔴 ${c.title}: ${c.detail}${c.fix ? `\n\nFix: ${c.fix}` : ''}`, wrap: true })),
            ...p.recovered.map((c) => ({ type: 'TextBlock', text: `🟢 Recovered: ${c.title}`, wrap: true })),
            ...(!p.failing.length && !p.recovered.length ? [{ type: 'TextBlock', text: p.text, wrap: true }] : []),
          ],
          actions: [{ type: 'Action.OpenUrl', title: p.run ? 'Open report' : 'Open Tharam', url: link }],
        },
      }],
    };
  }
  return p;
}

const retryable = (code) => code === 408 || code === 429 || code >= 500;

/** One attempt. Returns { ok, code, error }. */
async function attempt(url, secret, event, deliveryId, json) {
  try {
    await assertPublicTarget(new URL(url).origin); // checked again on every attempt (addresses can change)
  } catch { return { ok: false, code: null, error: 'The address now points to a private network.', permanent: true }; }
  try {
    const r = await fetch(url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', 'user-agent': 'Tharam-Webhooks/1', 'x-tharam-event': event, 'x-tharam-delivery': deliveryId, 'x-tharam-signature': sign(secret, json) },
      body: json,
    });
    if (r.status >= 200 && r.status < 300) return { ok: true, code: r.status };
    return { ok: false, code: r.status, error: r.status >= 300 && r.status < 400 ? 'The address redirected; we don\'t follow redirects.' : `Answered ${r.status}`, permanent: !retryable(r.status) };
  } catch (e) {
    return { ok: false, code: null, error: e.name === 'TimeoutError' ? `No answer in ${Math.round(TIMEOUT_MS / 1000)} s` : 'Could not connect' };
  }
}

/**
 * Sends one event to the store's webhook. Resolves after the first attempt with its outcome; retries continue in
 * the background (unless `retry: false`). Returns null when the store has no webhook.
 */
export async function deliver(store, { event, runId, failing, recovered, subject, text }, { retry = true } = {}) {
  const w = webhookOf(store);
  if (!w) return null;
  const deliveryId = crypto.randomUUID();
  const format = resolveFormat(w.url, w.format);
  const json = JSON.stringify(bodyFor(format, payloadFor({ event, store, runId, failing, recovered, subject, text, deliveryId })));
  const row = Number(D.insert.run(store.id, deliveryId, event, new URL(w.url).host).lastInsertRowid);
  let n = 0;
  const go = async () => {
    n++;
    const r = await attempt(w.url, w.secret, event, deliveryId, json);
    const last = r.ok || r.permanent || !retry || n >= RETRY_DELAYS.length;
    D.update.run(r.ok ? 'delivered' : last ? 'failed' : 'pending', n, r.code ?? null, r.ok ? null : r.error, row);
    if (!last) setTimeout(() => go().catch((e) => console.error('webhook retry', e.message)), RETRY_DELAYS[n]).unref?.();
    return r;
  };
  const first = await go();
  return { ok: first.ok, code: first.code ?? null, error: first.ok ? null : first.error, deliveryId, format, retrying: !first.ok && !first.permanent && retry };
}

/** Latest deliveries for the store's Alerts page. */
export const recentDeliveries = (storeId, limit = 20) => D.list.all(storeId, limit);
