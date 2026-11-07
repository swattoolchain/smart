/**
 * Incident mode: "Close your store to shoppers now".
 *
 * When a hack is confirmed, the quickest way to stop it hurting customers is Shopify's own password page.
 * Tharam only helps (read-only, no new Shopify permissions):
 *  - a direct link to Shopify admin > Online Store > Preferences > Password protection,
 *  - a ready-made message for the password page, and a reminder to switch it off after recovery,
 *  - a plain check, every few minutes while incident mode is on, that the storefront really shows the password page.
 *
 * The check is a plain web request (no browser). It resolves the host once, refuses private addresses (egress.js)
 * and connects to exactly that address, follows at most 3 redirects on the same host, and reads at most 200 KB.
 */
import http from 'node:http';
import https from 'node:https';
import { db, ensureColumn } from './db.js';
import { resolvePublic } from './egress.js';
import './incident.js'; // creates the incidents table

ensureColumn('incidents', 'closed_state', 'TEXT');
ensureColumn('incidents', 'closed_checked_at', 'TEXT');
ensureColumn('incidents', 'closed_since', 'TEXT');

export const CLOSED_CHECK_MINUTES = 4;
export const PASSWORD_PAGE_MESSAGE = "We're preparing something special for you. Back very soon.";
const TIMEOUT_MS = Number(process.env.CLOSED_CHECK_TIMEOUT_MS || 8000);
const MAX_BYTES = 200 * 1024;

/** Where to switch the password page on, and what to say on it. */
export function closeStoreInfo(store, { shopify = false, shop = null } = {}) {
  const host = new URL(store.url).host;
  const handle = shop && /\.myshopify\.com$/i.test(shop) ? shop.replace(/\.myshopify\.com$/i, '') : null;
  const adminUrl = handle ? `https://admin.shopify.com/store/${handle}/online_store/preferences` : `https://${shop || host}/admin/online_store/preferences`;
  return {
    adminUrl,
    message: PASSWORD_PAGE_MESSAGE,
    steps: shopify
      ? [
        'Open Online Store → Preferences in Shopify admin (the button below does this).',
        'Scroll down to "Password protection" and tick "Restrict access to visitors with the password".',
        `Paste the message below into "Message to your visitors", choose a password only you know, and save.`,
        'Come back here: we check every few minutes that shoppers now see the password page.',
        'After you have recovered the store, untick the same box so shoppers can buy again.',
      ]
      : [
        'Switch on your platform\'s maintenance or password page so shoppers cannot use the store.',
        'Use the message below on that page.',
        'After you have recovered the store, switch it off again so shoppers can buy.',
      ],
    reminder: 'Remember to switch the password page off after you have recovered the store. While it is on, nobody can buy.',
  };
}

/** True when a storefront answer is Shopify's password page. */
export function looksLikePasswordPage({ path = '', body = '' } = {}) {
  if (/^\/password\/?$/.test(path)) return true;
  return /<form[^>]+action=["'][^"']*\/password["']/i.test(body) || /name=["']form_type["'][^>]*value=["']storefront_password["']/i.test(body);
}

function get(url, ip) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      host: ip, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET', servername: u.hostname, timeout: TIMEOUT_MS,
      headers: { host: u.host, 'user-agent': 'Tharam-StoreGuard/1.0 (store closed check)', accept: 'text/html' },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= MAX_BYTES) chunks.push(c); else res.destroy(); });
      const done = () => resolve({ status: res.statusCode, location: res.headers.location || '', body: Buffer.concat(chunks).toString('utf8') });
      res.on('end', done);
      res.on('close', done);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** Opens the storefront like a shopper and says what it sees: 'closed' (password page), 'open', or 'unknown'. */
export async function probeStorefront(origin) {
  try {
    let url = new URL('/', origin).toString();
    const first = new URL(url).hostname;
    for (let hop = 0; hop < 4; hop++) {
      const u = new URL(url);
      if (u.hostname !== first) return { state: 'unknown', reason: 'The store sent shoppers to another address.' };
      const ip = await resolvePublic(u.hostname);
      const r = await get(url, ip);
      if (r.status >= 300 && r.status < 400 && r.location) { url = new URL(r.location, url).toString(); continue; }
      const path = new URL(url).pathname;
      if (r.status >= 500) return { state: 'unknown', reason: 'The store did not answer properly.' };
      return { state: looksLikePasswordPage({ path, body: r.body }) ? 'closed' : 'open' };
    }
    return { state: 'unknown', reason: 'The store kept redirecting.' };
  } catch (e) {
    return { state: 'unknown', reason: e.private ? 'The store address points to a private network.' : 'We could not open the store.' };
  }
}

const S = {
  save: db.prepare('UPDATE incidents SET closed_state = ?, closed_checked_at = ?, closed_since = ? WHERE id = ?'),
  open: db.prepare('SELECT * FROM incidents WHERE ended_at IS NULL'),
  byStore: db.prepare('SELECT * FROM incidents WHERE store_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1'),
  store: db.prepare('SELECT * FROM stores WHERE id = ?'),
};

/** Checks the storefront for one open incident row and saves the answer. Returns the answer. */
export async function checkClosed(row, store) {
  const r = await probeStorefront(store.url);
  const now = new Date().toISOString();
  const since = r.state === 'closed' ? (row.closed_state === 'closed' && row.closed_since ? row.closed_since : now) : null;
  S.save.run(r.state, now, since, row.id);
  return { ...r, checkedAt: now, since };
}

/** What the screens show for the closed check. */
export function closedView(storeId) {
  const row = S.byStore.get(storeId);
  if (!row || Date.parse(row.ends_at) <= Date.now()) return { on: false, state: null, checkedAt: null, since: null };
  return { on: true, state: row.closed_state || null, checkedAt: row.closed_checked_at || null, since: row.closed_since || null };
}

/** Scheduler: every few minutes, look at stores in incident mode. */
export async function dueClosedChecks(now = Date.now()) {
  for (const row of S.open.all()) {
    if (Date.parse(row.ends_at) <= now) continue;
    if (row.closed_checked_at && now - Date.parse(row.closed_checked_at) < CLOSED_CHECK_MINUTES * 60000) continue;
    const store = S.store.get(row.store_id);
    if (!store) continue;
    await checkClosed(row, store).catch((e) => console.error('closed check failed', e));
  }
}

const lastManual = new Map();
/** Owner pressed "Check now". At most one every 15 seconds per store. */
export async function checkNow(store) {
  const row = S.byStore.get(store.id);
  const t = lastManual.get(store.id) || 0;
  if (Date.now() - t < 15000) throw Object.assign(new Error('Please wait a few seconds before checking again.'), { status: 429 });
  lastManual.set(store.id, Date.now());
  if (row) return { ...(await checkClosed(row, store)) };
  return { ...(await probeStorefront(store.url)), checkedAt: new Date().toISOString() };
}
