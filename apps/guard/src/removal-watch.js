/**
 * Security watch S16, part 2: keep watching the storefront after Tharam is removed.
 *
 * Someone who takes over a Shopify admin often removes security apps first. When app/uninstalled arrives
 * (the removal alarm email goes out at the same moment) we keep looking at the storefront from outside, the
 * way a free check does, every 30 minutes until Shopify's shop/redact arrives (about 48 hours later). If the
 * checks show checkout going to another site, card-reading or known-bad scripts, shoppers sent away, hidden
 * pages, mining, or prices at zero, the owner's confirmed emails hear about it.
 *
 * It uses no Shopify API (the access token is gone) and only public pages. shop/redact ends it at once and
 * deletes every run and screenshot it made. Reinstalling ends it too. Feature switch: removal_watch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { isOn } from './features.js';
import { audit } from './license.js';
import { sendMail } from './alerts.js';

db.exec(`CREATE TABLE IF NOT EXISTS removal_watch (
  id INTEGER PRIMARY KEY,
  shop TEXT NOT NULL,
  user_id INTEGER,
  store_name TEXT,
  url TEXT NOT NULL,
  emails_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ends_at TEXT NOT NULL,
  ended_at TEXT,
  ended_reason TEXT,
  last_run_id INTEGER,
  last_run_at TEXT,
  evaluated_run_id INTEGER,
  zero_base INTEGER,
  runs INTEGER NOT NULL DEFAULT 0,
  alerted_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS removal_watch_shop ON removal_watch(shop);`);

/** Shopify sends shop/redact about 48 hours after removal; if it never arrives we stop on our own after 72. */
export const WATCH_HOURS = 72;
export const WATCH_EVERY_MIN = Number(process.env.REMOVAL_WATCH_EVERY_MIN ?? 28); // ticks come every 5 minutes: runs land 30 minutes apart

const S = {
  active: db.prepare('SELECT * FROM removal_watch WHERE ended_at IS NULL'),
  activeForShop: db.prepare('SELECT * FROM removal_watch WHERE shop = ? AND ended_at IS NULL'),
  forShop: db.prepare('SELECT * FROM removal_watch WHERE shop = ?'),
  insert: db.prepare("INSERT INTO removal_watch (shop, user_id, store_name, url, emails_json, ends_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))"),
  end: db.prepare("UPDATE removal_watch SET ended_at = datetime('now'), ended_reason = ? WHERE id = ? AND ended_at IS NULL"),
  ran: db.prepare("UPDATE removal_watch SET last_run_id = ?, last_run_at = datetime('now'), runs = runs + 1 WHERE id = ?"),
  evaluated: db.prepare('UPDATE removal_watch SET evaluated_run_id = ?, alerted_json = ? WHERE id = ?'),
  base: db.prepare('UPDATE removal_watch SET zero_base = ? WHERE id = ?'),
  lastReal: db.prepare("SELECT result_json FROM runs WHERE store_id = ? AND status = 'done' AND result_json LIKE '%nf.catalog%' ORDER BY id DESC LIMIT 1"),
  run: db.prepare('SELECT id, status, result_json FROM runs WHERE id = ?'),
  delRuns: db.prepare("DELETE FROM runs WHERE trigger = 'removal_watch' AND url = ?"),
  watchRuns: db.prepare("SELECT id FROM runs WHERE trigger = 'removal_watch' AND url = ?"),
  delShop: db.prepare('DELETE FROM removal_watch WHERE shop = ?'),
};

const minutesSince = (ts) => (ts ? (Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 60000 : Infinity);
const expired = (w) => new Date(w.ends_at.replace(' ', 'T') + 'Z').getTime() <= Date.now();

/** Starts watching every store of the account the shop belonged to. `emails` = who hears about problems. */
export function startRemovalWatch(shop, userId, stores, emails) {
  if (!isOn('removal_watch') || !userId) return 0;
  let n = 0;
  for (const st of stores || []) {
    if (!st?.url) continue;
    let base = null;
    try { const r = S.lastReal.get(st.id); if (r) base = zeroCount(JSON.parse(r.result_json)); } catch {}
    const id = Number(S.insert.run(shop, userId, st.name || shop, st.url, JSON.stringify(emails || []), `+${WATCH_HOURS} hours`).lastInsertRowid);
    if (base != null) S.base.run(base, id);
    n++;
  }
  if (n) audit('shopify', userId, 'note', { text: `Watching the storefront from outside after removal (${shop}) until Shopify asks us to delete the data` });
  return n;
}

/** The app was added again: the normal checks take over. */
export function endRemovalWatch(shop, reason = 'reinstalled') {
  for (const w of S.activeForShop.all(shop)) S.end.run(reason, w.id);
}

/** shop/redact: stop at once and delete everything the watch made (runs, screenshots, its own rows). */
export function purgeRemovalWatch(shop) {
  for (const w of S.forShop.all(shop)) {
    for (const r of S.watchRuns.all(w.url)) fs.rmSync(path.join(config.dataDir, 'shots', `run-${r.id}`), { recursive: true, force: true });
    S.delRuns.run(w.url);
  }
  S.delShop.run(shop);
}

/** What a finished outside check says is wrong, in the owner's words. Keys never change (they stop repeat emails). */
const PROBLEMS = [
  { id: 'fn.checkout', key: 'checkout', say: 'Checkout sends customers to another website.' },
  { id: 'sec.redirect', key: 'redirect', say: 'Shoppers are being sent to another website.' },
  { id: 'sec.scripts.forms', key: 'cardscripts', say: 'A script is reading what shoppers type into your forms, such as card details.' },
  { id: 'sec.scripts.bad', key: 'badscript', say: 'Your pages load a script from a website known for stealing card details.' },
  { id: 'sec.frames', key: 'frames', say: 'Your pages show hidden content from other websites.' },
  { id: 'sec.mining', key: 'mining', say: 'Your pages run cryptocurrency mining code.' },
  { id: 'nf.catalog', key: 'prices', say: 'More products are priced at zero than before.', zero: true },
];

/** How many products a catalog check found priced at zero ("1 priced at 0"). */
export function zeroCount(result) {
  const c = (result?.checks || []).find((x) => x.id === 'nf.catalog');
  return Number(/(\d+) priced at 0/.exec(c?.detail || '')?.[1] || 0);
}

/**
 * `zeroBefore`: products priced at zero when we last looked before the removal. Some stores really give things away,
 * so only more of them than before counts. Without a number (first look) prices are not judged yet.
 */
export function problemsIn(result, { zeroBefore = null } = {}) {
  const out = new Map();
  for (const c of result?.checks || []) {
    const p = PROBLEMS.find((x) => x.id === c.id);
    if (!p || c.status !== 'fail' || out.has(p.key)) continue;
    if (p.zero && !(zeroBefore != null && zeroCount(result) > zeroBefore)) continue;
    out.set(p.key, { key: p.key, say: p.say, detail: c.detail || '' });
  }
  return [...out.values()];
}

export function alertMail(w, problems) {
  const to = JSON.parse(w.emails_json || '[]');
  const text = [
    `Tharam was removed from ${w.store_name}, and we are still looking at your store from outside. Just now we saw:`,
    '',
    ...problems.map((p) => `- ${p.say}${p.detail ? ` (${p.detail})` : ''}`),
    '',
    'If you did not make these changes, act now:',
    '1. Sign in to Shopify admin and change your password. Sign out of all devices.',
    '2. Remove staff and apps you do not know (Settings > Users and permissions, and Settings > Apps).',
    '3. Check Online Store > Themes for a theme or code you did not add.',
    '4. Contact Shopify Support and tell them your store may be compromised.',
    '',
    'We only look at your public store pages, and we stop and delete these checks when Shopify asks us to delete your data. Add Tharam again from the Shopify App Store to get the full checks back.',
    '',
    'Tharam',
  ].join('\n');
  return { to: to.join(', '), subject: `Your store ${w.store_name} may have been tampered with`, text };
}

/** Looks at a finished outside check and emails anything new (each kind of problem once). */
async function evaluate(w) {
  if (!w.last_run_id || w.last_run_id === w.evaluated_run_id) return;
  const run = S.run.get(w.last_run_id);
  if (!run || !['done', 'error', 'cancelled'].includes(run.status)) return;
  let alerted = {};
  try { alerted = JSON.parse(w.alerted_json || '{}'); } catch {}
  if (run.status === 'done' && run.result_json) {
    let result = null;
    try { result = JSON.parse(run.result_json); } catch {}
    if (w.zero_base == null && result) { w.zero_base = zeroCount(result); S.base.run(w.zero_base, w.id); }
    const fresh = problemsIn(result, { zeroBefore: w.zero_base }).filter((p) => !alerted[p.key]);
    if (fresh.length) {
      for (const p of fresh) alerted[p.key] = new Date().toISOString();
      const mail = alertMail(w, fresh);
      if (mail.to) await sendMail(mail).catch((e) => console.error('removal watch mail', w.shop, e.message));
      audit('shopify', w.user_id, 'note', { text: `Storefront watch after removal: ${fresh.map((p) => p.say).join(' ')}` });
    }
  }
  S.evaluated.run(run.id, JSON.stringify(alerted), w.id);
}

/** Called every 5 minutes by the scheduler. `startRun` is passed in (the scheduler owns it). */
export async function removalWatchTick({ startRun, busy = () => false } = {}) {
  if (!isOn('removal_watch')) return;
  for (const w of S.active.all()) {
    if (expired(w)) { S.end.run('time', w.id); continue; }
    try { await evaluate(w); } catch (e) { console.error('removal watch evaluate', e); }
    const last = w.last_run_id ? S.run.get(w.last_run_id) : null;
    if (last && ['queued', 'running'].includes(last.status)) continue;
    if (minutesSince(w.last_run_at) < WATCH_EVERY_MIN) continue;
    try {
      const id = startRun({ origin: w.url, kind: 'free', trigger: 'removal_watch' });
      S.ran.run(id, w.id);
    } catch (e) { if (!busy(e)) console.error('removal watch run', w.shop, e.message); }
  }
}
