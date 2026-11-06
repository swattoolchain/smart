/**
 * Cross-store early warning: when the same app changes its code on many of the stores Tharam watches within
 * a short time, every store that uses the app hears about it, including stores where the update hasn't
 * arrived yet. A big app update (or a compromised app) usually rolls out to all its stores at once, so the
 * first stores to see it give the others a head start.
 *
 * Privacy: a warning says only how many stores saw the change, never which ones or whose.
 */
import { db, q } from './db.js';
import { config } from './config.js';
import { appChanges } from './app-health.js';
import { sendMail } from './alerts.js';
import { entitlements } from './license.js';

db.exec(`
CREATE TABLE IF NOT EXISTS app_code_changes (
  id INTEGER PRIMARY KEY,
  app_key TEXT NOT NULL,
  app_name TEXT,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  run_id INTEGER,
  files_json TEXT,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (app_key, store_id, run_id)
);
CREATE INDEX IF NOT EXISTS app_code_changes_app ON app_code_changes (app_key, seen_at);
CREATE TABLE IF NOT EXISTS store_apps (
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  app_key TEXT NOT NULL,
  app_name TEXT,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (store_id, app_key)
);
CREATE INDEX IF NOT EXISTS store_apps_app ON store_apps (app_key);
CREATE TABLE IF NOT EXISTS early_warnings (
  id INTEGER PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  app_key TEXT NOT NULL,
  app_name TEXT,
  stores_count INTEGER NOT NULL,
  changed_here INTEGER NOT NULL DEFAULT 0,
  emailed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS early_warnings_store ON early_warnings (store_id, created_at);
`);

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
/** How many different stores must see the change, within how many hours. One warning per app per store per cooldown. */
export const settings = () => ({
  minStores: num(process.env.EARLY_WARNING_STORES, 3),
  hours: num(process.env.EARLY_WARNING_HOURS, 24),
  cooldownHours: num(process.env.EARLY_WARNING_COOLDOWN_HOURS, 72),
  usedWithinDays: 14,
});

const Q = {
  clearApps: db.prepare('DELETE FROM store_apps WHERE store_id = ?'),
  addApp: db.prepare("INSERT OR REPLACE INTO store_apps (store_id, app_key, app_name, seen_at) VALUES (?, ?, ?, datetime('now'))"),
  addChange: db.prepare('INSERT OR IGNORE INTO app_code_changes (app_key, app_name, store_id, run_id, files_json) VALUES (?, ?, ?, ?, ?)'),
  storesChanged: db.prepare("SELECT DISTINCT store_id FROM app_code_changes WHERE app_key = ? AND seen_at >= datetime('now', ?)"),
  storesUsing: db.prepare("SELECT store_id FROM store_apps WHERE app_key = ? AND seen_at >= datetime('now', ?)"),
  recentWarning: db.prepare("SELECT id FROM early_warnings WHERE store_id = ? AND app_key = ? AND created_at >= datetime('now', ?)"),
  addWarning: db.prepare('INSERT INTO early_warnings (store_id, app_key, app_name, stores_count, changed_here) VALUES (?, ?, ?, ?, ?)'),
  markEmailed: db.prepare('UPDATE early_warnings SET emailed = 1 WHERE id = ?'),
  forStore: db.prepare(`SELECT w.app_key, w.app_name, w.stores_count, w.created_at,
    w.changed_here OR EXISTS (SELECT 1 FROM app_code_changes c WHERE c.store_id = w.store_id AND c.app_key = w.app_key AND c.seen_at >= datetime(w.created_at, ?)) AS changed_here
    FROM early_warnings w WHERE w.store_id = ? AND w.created_at >= datetime('now', ?) ORDER BY w.id DESC`),
};

const iso = (t) => (t && !t.includes('T') ? t.replace(' ', 'T') + 'Z' : t);

/**
 * Called after each finished (non publish-check) run of a store: records which apps the store uses and
 * which of them changed code, then warns every store using an app that changed on enough stores.
 * Returns the warnings created (for tests and logs).
 */
export async function earlyWarning(storeId) {
  const store = q.storeById.get(storeId);
  if (!store) return [];
  const { runId, apps, changed } = appChanges(store);
  if (!runId) return [];
  const S = settings();
  db.transaction(() => {
    Q.clearApps.run(storeId);
    for (const a of apps) Q.addApp.run(storeId, a.key, a.name);
    for (const c of changed) Q.addChange.run(c.key, c.name, storeId, runId, JSON.stringify(c.files.slice(0, 10)));
  })();

  const created = [];
  for (const c of changed) {
    const changedOn = new Set(Q.storesChanged.all(c.key, `-${S.hours} hours`).map((r) => r.store_id));
    if (changedOn.size < S.minStores) continue;
    const users = Q.storesUsing.all(c.key, `-${S.usedWithinDays} days`).map((r) => r.store_id);
    for (const sid of new Set([...users, ...changedOn])) {
      if (Q.recentWarning.get(sid, c.key, `-${S.cooldownHours} hours`)) continue;
      const here = changedOn.has(sid);
      const info = Q.addWarning.run(sid, c.key, c.name, changedOn.size, here ? 1 : 0);
      const w = { id: Number(info.lastInsertRowid), storeId: sid, appKey: c.key, appName: c.name, stores: changedOn.size, changedHere: here };
      created.push(w);
      await mailWarning(w).catch((e) => console.error('early warning mail failed', sid, e.message));
    }
  }
  return created;
}

export function warningText(w, storeName) {
  const subject = `Early warning: ${w.appName} changed its code on ${w.stores} stores`;
  const lines = [
    `${w.appName} changed its code on ${w.stores} stores we watch in the last ${settings().hours} hours. ${storeName || 'Your store'} uses ${w.appName}.`,
    w.changedHere
      ? 'The new code is already on your store. If something looks or works differently since the update, this is the likely reason.'
      : 'The new code hasn\'t reached your store yet. It may arrive soon.',
    `What to do: keep an eye on the pages where ${w.appName} shows (for example reviews, chat or upsells). We keep checking your store and will tell you if buying breaks. If it does, you can switch the app off under Online Store → Themes → Customize → App embeds, or ask the app's support.`,
  ];
  return { subject, lines };
}

async function mailWarning(w) {
  const store = q.storeById.get(w.storeId);
  if (!store) return;
  if (!entitlements(store.user_id).usable) return; // checks and alerts are stopped for this account
  let name = store.name;
  try { name ||= new URL(store.url).host; } catch {}
  const { subject, lines } = warningText(w, name);
  const link = `${config.baseUrl}/app#/s/${store.id}/apps`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const text = `${lines.join('\n\n')}\n\nApp health for ${name}: ${link}\n\n— Tharam Store Guard`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1917">
<p><b>${esc(name)}</b></p>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}
<p><a href="${link}" style="background:#14532d;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open App health</a></p>
<p style="color:#78716c;font-size:13px">Tharam Store Guard · We never tell other stores which stores use an app.</p></div>`;
  const to = store.alert_email || q.userById.get(store.user_id)?.email;
  if (await sendMail({ to, subject, text, html })) Q.markEmailed.run(w.id);
}

/** Early warnings for one store from the last 7 days, newest first, one per app. */
export function warningsFor(storeId) {
  const seen = new Set();
  // "Already on your store" also once the change reaches the store after the warning was sent.
  return Q.forStore.all(`-${settings().hours} hours`, storeId, '-7 days')
    .filter((r) => !seen.has(r.app_key) && seen.add(r.app_key))
    .map((r) => ({ appKey: r.app_key, appName: r.app_name, stores: r.stores_count, changedHere: !!r.changed_here, at: iso(r.created_at) }));
}
