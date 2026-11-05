/**
 * Security watch S12: incident mode.
 *
 * One button for "I think my store was hacked" (or something just broke badly):
 *  - shows what changed since the last healthy check (checks that broke, theme, products and prices, looks, alerts)
 *  - checks the store every few minutes (shopping checks every 10 minutes) and runs a full check at once
 *  - a recovery checklist the owner ticks off
 *  - team alerts: up to 5 extra people get the start email, every alert while it is on, and the summary at the end
 * Ends when the owner ends it, or by itself after 48 hours.
 */
import { db, q } from './db.js';
import { config } from './config.js';
import { comparePair } from './compare.js';

db.exec(`
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  ended_at TEXT,
  ended_reason TEXT,
  reason TEXT,
  contacts_json TEXT NOT NULL DEFAULT '[]',
  steps_json TEXT NOT NULL DEFAULT '{}',
  healthy_run_id INTEGER
);
CREATE INDEX IF NOT EXISTS incidents_store ON incidents(store_id, id DESC);
`);

export const INCIDENT_HOURS = 48;
export const INCIDENT_JOURNEY_MIN = 10;
export const MAX_CONTACTS = 5;
// One start per store per 7 days: incident mode goes past the plan's check interval and emails people the owner
// typed in, so it must not become a way around plan limits or a way to send mail in a loop.
export const COOLDOWN_DAYS = 7;
const HOUR = 3600 * 1000;

/** Recovery steps. `shopify` / `other`: where to do it. */
export const STEPS = [
  { key: 'password', title: 'Change your password and sign out everywhere',
    shopify: 'In Shopify admin open your account (top right) → Manage account → Security: change the password, then "Log out of all devices". Do the same for the email account you sign in with.',
    other: 'Change the password of your store admin and of the email account you sign in with, and sign out of all other devices.' },
  { key: 'two_step', title: 'Turn on two-step login for every account',
    shopify: 'Settings → Users → Security. Ask every staff member to turn it on too.',
    other: 'Turn on two-step login for your own and every staff account.' },
  { key: 'staff', title: 'Remove staff and collaborators you don\'t recognise',
    shopify: 'Settings → Users: remove anyone you don\'t know or who left, and check the permissions of everyone else. Check collaborator accounts too.',
    other: 'Remove admin accounts you don\'t recognise and limit what everyone else can change.' },
  { key: 'apps', title: 'Uninstall apps you didn\'t install or don\'t use',
    shopify: 'Settings → Apps: look at recently installed apps first.',
    other: 'Remove plugins and apps you don\'t recognise or don\'t use.' },
  { key: 'theme', title: 'Check your theme and its code',
    shopify: 'Online Store → Themes: if a theme you don\'t know is published, publish your previous one again. The changes since the last healthy check are listed in incident mode.',
    other: 'Compare your store\'s look and code with the last healthy check (listed in incident mode), and restore a backup if code was changed.' },
  { key: 'money', title: 'Check payout and payment settings',
    shopify: 'Settings → Payments and your payout bank account: make sure nothing was changed.',
    other: 'Check your payment provider and payout bank details were not changed.' },
  { key: 'prices', title: 'Check prices, products and discount codes',
    shopify: 'Products and Discounts: look for free products, odd prices or codes you didn\'t create (incident mode lists what changed).',
    other: 'Look for free products, odd prices or discount codes you didn\'t create (incident mode lists what changed).' },
  { key: 'domain', title: 'Check your domain and email settings',
    shopify: 'Settings → Domains, and where you bought your domain: two-step login on, records unchanged.',
    other: 'Where you bought your domain: two-step login on, records unchanged.' },
  { key: 'support', title: 'Tell your platform\'s support team',
    shopify: 'Contact Shopify Support (help.shopify.com) with what changed and when. They can see sign-ins and changes we can\'t.',
    other: 'Contact your platform or hosting support with what changed and when.' },
];
const STEP_KEYS = new Set(STEPS.map((s) => s.key));

const Q = {
  active: db.prepare('SELECT * FROM incidents WHERE store_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1'),
  byId: db.prepare('SELECT * FROM incidents WHERE id = ?'),
  history: db.prepare('SELECT * FROM incidents WHERE store_id = ? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 5'),
  insert: db.prepare('INSERT INTO incidents (store_id, started_at, ends_at, reason, contacts_json, healthy_run_id) VALUES (?, ?, ?, ?, ?, ?)'),
  update: db.prepare('UPDATE incidents SET contacts_json = ?, steps_json = ? WHERE id = ?'),
  end: db.prepare('UPDATE incidents SET ended_at = ?, ended_reason = ? WHERE id = ? AND ended_at IS NULL'),
  open: db.prepare('SELECT * FROM incidents WHERE ended_at IS NULL'),
  lastStart: db.prepare('SELECT started_at FROM incidents WHERE store_id = ? ORDER BY id DESC LIMIT 1'),
  lastHealthy: db.prepare("SELECT id, kind, created_at FROM runs WHERE store_id = ? AND status = 'done' AND verdict = 'healthy' AND (trigger IS NULL OR trigger != 'release') ORDER BY id DESC LIMIT 1"),
  lastHealthyFull: db.prepare("SELECT id, created_at FROM runs WHERE store_id = ? AND status = 'done' AND verdict = 'healthy' AND kind = 'full' AND (trigger IS NULL OR trigger != 'release') ORDER BY id DESC LIMIT 1"),
  latest: db.prepare("SELECT id, kind, created_at, verdict, score FROM runs WHERE store_id = ? AND status = 'done' AND result_json IS NOT NULL AND (trigger IS NULL OR trigger != 'release') ORDER BY id DESC LIMIT 1"),
  latestFull: db.prepare("SELECT id, created_at FROM runs WHERE store_id = ? AND status = 'done' AND kind = 'full' AND result_json IS NOT NULL AND (trigger IS NULL OR trigger != 'release') ORDER BY id DESC LIMIT 1"),
  runsSince: db.prepare("SELECT id, kind, status, verdict, score, created_at, finished_at FROM runs WHERE store_id = ? AND created_at >= ? AND (trigger IS NULL OR trigger != 'release') ORDER BY id DESC LIMIT 50"),
  alertsSince: db.prepare('SELECT check_id, state, title, message, created_at FROM alerts WHERE store_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 30'),
};

const iso = (ms) => new Date(ms).toISOString();
// SQLite's datetime('now') format, so it compares with runs.created_at and alerts.created_at.
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** Cleans a list of team emails. Throws a plain message when one is not an email address. */
export function cleanContacts(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) list = String(list).split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const e = String(raw || '').trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL.test(e) || e.length > 200) throw new Error(`"${String(raw).slice(0, 60)}" is not an email address.`);
    if (!out.includes(e)) out.push(e);
  }
  if (out.length > MAX_CONTACTS) throw new Error(`Add up to ${MAX_CONTACTS} people.`);
  return out;
}

export function activeIncident(storeId, now = Date.now()) {
  const r = Q.active.get(storeId);
  return r && Date.parse(r.ends_at) > now ? r : null;
}

/** Extra people to alert while incident mode is on. */
export function incidentContacts(storeId) {
  const r = activeIncident(storeId);
  return r ? JSON.parse(r.contacts_json) : [];
}

/** Short form for store lists (banner). */
export function incidentBrief(storeId) {
  const r = activeIncident(storeId);
  return r ? { id: r.id, startedAt: r.started_at, endsAt: r.ends_at } : null;
}

export function startIncident(store, { reason = '', contacts = [], now = Date.now() } = {}) {
  if (activeIncident(store.id, now)) throw Object.assign(new Error('Incident mode is already on for this store.'), { status: 409 });
  const next = nextStartAt(store.id, now);
  if (next) throw Object.assign(new Error(`Incident mode can be started once a week per store. You can start it again on ${new Date(next).toUTCString().slice(0, 22)} UTC. Your store is still checked on its usual schedule; if you need help sooner, email ${config.contactEmail}.`), { status: 429 });
  const team = cleanContacts(contacts);
  const healthy = Q.lastHealthy.get(store.id);
  const info = Q.insert.run(store.id, iso(now), iso(now + INCIDENT_HOURS * HOUR), String(reason || '').trim().slice(0, 500), JSON.stringify(team), healthy?.id ?? null);
  return Q.byId.get(Number(info.lastInsertRowid));
}

/** When incident mode may be started again (ms), or null if it may be started now. */
export function nextStartAt(storeId, now = Date.now()) {
  const last = Q.lastStart.get(storeId);
  if (!last) return null;
  const at = Date.parse(last.started_at) + COOLDOWN_DAYS * 24 * HOUR;
  return at > now ? at : null;
}

export function updateIncident(storeId, { contacts, steps } = {}) {
  const r = activeIncident(storeId);
  if (!r) throw Object.assign(new Error('Incident mode is not on for this store.'), { status: 404 });
  const team = contacts === undefined ? JSON.parse(r.contacts_json) : cleanContacts(contacts);
  const done = JSON.parse(r.steps_json);
  if (steps !== undefined) {
    if (!steps || typeof steps !== 'object' || Array.isArray(steps)) throw new Error('Steps must be a list of step: true or false.');
    for (const [k, v] of Object.entries(steps)) {
      if (!STEP_KEYS.has(k)) throw new Error(`There is no step called "${String(k).slice(0, 40)}".`);
      if (typeof v !== 'boolean') throw new Error('Say whether each step is done (true or false).');
      if (v) done[k] = done[k] || iso(Date.now()); else delete done[k];
    }
  }
  Q.update.run(JSON.stringify(team), JSON.stringify(done), r.id);
  return Q.byId.get(r.id);
}

export function endIncident(storeId, reason = 'owner', now = Date.now()) {
  const r = Q.active.get(storeId);
  if (!r) return null;
  Q.end.run(iso(now), reason, r.id);
  return Q.byId.get(r.id);
}

/** Incidents past their 48 hours end by themselves. Returns the ones it ended. */
export function expiredIncidents(now = Date.now()) {
  const out = [];
  for (const r of Q.open.all()) if (Date.parse(r.ends_at) <= now) { Q.end.run(r.ends_at, 'time', r.id); out.push(Q.byId.get(r.id)); }
  return out;
}

/** What changed since the last healthy check: broken checks, theme, products and prices, looks, alerts. */
export function changesSinceHealthy(storeId, healthyRunId = null) {
  const healthy = healthyRunId ? { id: healthyRunId } : Q.lastHealthy.get(storeId);
  const latest = Q.latest.get(storeId);
  if (!healthy) return { healthy: null, latest, note: 'There is no healthy check on record yet, so there is nothing to compare with.' };
  const h = db.prepare('SELECT id, kind, created_at FROM runs WHERE id = ?').get(healthy.id);
  if (!latest || latest.id === h.id) return { healthy: h, latest, broken: [], fixed: [], note: 'No check has run since the last healthy one yet. Incident mode starts one now.' };
  const cmp = comparePair(storeId, latest.id, h.id);
  const out = { healthy: h, latest, broken: [], theme: null, products: null, looks: [], alerts: [] };
  if (cmp) {
    out.broken = cmp.changes.new.map((x) => ({ id: x.id, title: x.title, severity: x.severity, status: x.a, detail: x.detail, fix: x.fix }));
    const ta = cmp.run.result?.theme?.name, tb = JSON.parse(db.prepare('SELECT result_json FROM runs WHERE id = ?').get(h.id).result_json || '{}').theme?.name;
    if (ta && tb && ta !== tb) out.theme = { before: tb, after: ta };
  }
  // Products, prices and looks need full checks on both sides.
  const lf = Q.latestFull.get(storeId), hf = Q.lastHealthyFull.get(storeId);
  if (lf && hf && lf.id !== hf.id && lf.id > hf.id) {
    const full = comparePair(storeId, lf.id, hf.id);
    const d = full?.catalogDiff;
    if (d && d.changes.length) out.products = { totals: d.totals, examples: d.changes.slice(0, 10).map((c) => ({ kind: c.kind, title: c.title, detail: c.detail || (c.fields || []).map((f) => `${f.label}: ${f.before ?? '–'} → ${f.after ?? '–'}`).join('; ') })) };
    out.looks = (full?.visual || []).filter((v) => v.ratio != null && v.ratio >= 5).map((v) => ({ key: v.key, ratio: v.ratio, now: v.a, before: v.b, diff: v.diff }));
  }
  out.alerts = Q.alertsSince.all(storeId, h.created_at).filter((a) => a.state === 'failing').map((a) => ({ title: a.title || a.check_id, message: a.message, at: a.created_at }));
  return out;
}

/** Everything the incident page shows. */
export function incidentView(store, { shopify = false } = {}) {
  const r = activeIncident(store.id);
  const steps = (row) => {
    const done = JSON.parse(row.steps_json);
    return STEPS.map((s) => ({ key: s.key, title: s.title, how: shopify ? s.shopify : s.other, doneAt: done[s.key] || null }));
  };
  const history = Q.history.all(store.id).map((h) => ({ id: h.id, startedAt: h.started_at, endedAt: h.ended_at, endedBy: h.ended_reason, reason: h.reason, stepsDone: Object.keys(JSON.parse(h.steps_json)).length, steps: STEPS.length }));
  if (!r) {
    const next = nextStartAt(store.id);
    return { active: null, history, steps: STEPS.map((s) => ({ key: s.key, title: s.title, how: shopify ? s.shopify : s.other })), hours: INCIDENT_HOURS, everyMinutes: INCIDENT_JOURNEY_MIN, nextStartAt: next ? iso(next) : null, cooldownDays: COOLDOWN_DAYS };
  }
  return {
    active: {
      id: r.id, startedAt: r.started_at, endsAt: r.ends_at, reason: r.reason, contacts: JSON.parse(r.contacts_json),
      steps: steps(r),
      runs: Q.runsSince.all(store.id, sqlTime(Date.parse(r.started_at))),
    },
    changes: changesSinceHealthy(store.id, r.healthy_run_id),
    history,
    hours: INCIDENT_HOURS,
    everyMinutes: INCIDENT_JOURNEY_MIN,
  };
}

// ---------- emails ----------

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
const storeName = (s) => s.name || new URL(s.url).host;
const ownerEmail = (s) => s.alert_email || q.userById.get(s.user_id)?.email;

/** Owner plus team, for incident emails. */
export function incidentRecipients(store, row) {
  return [...new Set([ownerEmail(store), ...JSON.parse(row.contacts_json)].filter(Boolean))];
}

export function startEmail(store, row, { shopify = false } = {}) {
  const name = storeName(store);
  const link = `${config.baseUrl}/app#/s/${store.id}/incident`;
  const c = changesSinceHealthy(store.id, row.healthy_run_id);
  const changed = [
    ...(c.broken || []).map((b) => `Broken since then: ${b.title}. ${b.detail}`),
    ...(c.theme ? [`Theme changed: ${c.theme.before} → ${c.theme.after}`] : []),
    ...(c.products ? [`Products changed: ${c.products.totals.changed} edited, ${c.products.totals.added} added, ${c.products.totals.removed} removed (${c.products.totals.price} with new prices)`] : []),
    ...(c.looks || []).map((l) => `Looks different: ${l.key.replace('-', ' on ')} (${l.ratio}% of the page)`),
  ];
  const since = c.healthy ? `Since the last healthy check (${c.healthy.created_at} UTC):` : c.note;
  const steps = STEPS.map((s, i) => `${i + 1}. ${s.title}. ${shopify ? s.shopify : s.other}`);
  const subject = `Incident mode is on for ${name}`;
  const text = `Incident mode is on for ${name}${row.reason ? ` (${row.reason})` : ''}.\n\nFor the next ${INCIDENT_HOURS} hours Tharam checks the store every ${INCIDENT_JOURNEY_MIN} minutes and sends every alert to everyone on this email. A full check has started now.\n\n${since}\n${changed.length ? changed.map((x) => `- ${x}`).join('\n') : c.healthy ? '- Nothing we check has changed yet.' : ''}\n\nWhat to do now:\n${steps.join('\n')}\n\nFollow along and tick off steps: ${link}\n\n— Tharam Store Guard`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1917">
<p><b>Incident mode is on for ${esc(name)}</b>${row.reason ? ` (${esc(row.reason)})` : ''}.</p>
<p>For the next ${INCIDENT_HOURS} hours Tharam checks the store every ${INCIDENT_JOURNEY_MIN} minutes and sends every alert to everyone on this email. A full check has started now.</p>
<p><b>${esc(since)}</b></p>${changed.length ? `<ul>${changed.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : c.healthy ? '<p>Nothing we check has changed yet.</p>' : ''}
<p><b>What to do now</b></p><ol>${STEPS.map((s) => `<li><b>${esc(s.title)}.</b> ${esc(shopify ? s.shopify : s.other)}</li>`).join('')}</ol>
<p><a href="${link}" style="background:#991b1b;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open incident mode</a></p></div>`;
  return { to: incidentRecipients(store, row).join(', '), subject, text, html };
}

export function endEmail(store, row) {
  const name = storeName(store);
  const done = Object.keys(JSON.parse(row.steps_json)).length;
  const hours = Math.max(1, Math.round((Date.parse(row.ended_at) - Date.parse(row.started_at)) / HOUR));
  const runs = Q.runsSince.all(store.id, sqlTime(Date.parse(row.started_at))).filter((r) => r.created_at <= sqlTime(Date.parse(row.ended_at)) && r.status === 'done');
  const latest = runs[0];
  const how = row.ended_reason === 'time' ? `ended by itself after ${INCIDENT_HOURS} hours` : 'was ended by the store owner';
  const subject = `Incident mode ended for ${name}`;
  const text = `Incident mode for ${name} ${how}.\n\nIt was on for about ${hours} hour${hours === 1 ? '' : 's'}. We ran ${runs.length} check${runs.length === 1 ? '' : 's'}${latest ? `; the latest found the store ${latest.verdict === 'healthy' ? 'healthy' : `in "${latest.verdict}" state`}` : ''}. ${done} of ${STEPS.length} recovery steps were ticked off.\n\nChecks are back to the usual schedule. Team members stop getting alerts now.\n\nReports: ${config.baseUrl}/app#/s/${store.id}/reports\n\n— Tharam Store Guard`;
  return { to: incidentRecipients(store, row).join(', '), subject, text, html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1917">${text.split('\n\n').slice(0, -1).map((p) => `<p>${esc(p)}</p>`).join('')}</div>` };
}
