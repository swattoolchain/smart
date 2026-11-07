/**
 * The Shopify app: Tharam inside Shopify admin.
 *
 * - Install and login use Shopify's session tokens (no cookies) and token exchange for an
 *   expiring offline access token, refreshed before it expires. Tokens are stored encrypted.
 * - A shop gets its own Tharam account and store on first open; nobody types an address or password.
 * - The plan comes from Shopify billing (managed pricing) and is synced into the Tharam licence.
 * - Webhooks: uninstall, privacy (compliance) topics, theme and product changes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { purgeStoreFiles } from './purge.js';
import { db, q } from './db.js';
import { ensureLicense, updateLicense, listPlans, getPlan, audit, setting } from './license.js';
import { seal, open } from './secret.js';
import { sendMail } from './alerts.js';
import { startRemovalWatch, endRemovalWatch, purgeRemovalWatch } from './removal-watch.js';

const S = config.shopify;
export const shopifyEnabled = () => !!(S.apiKey && S.apiSecret);
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
export const validShop = (s) => typeof s === 'string' && SHOP_RE.test(s.toLowerCase());
const adminBase = (shop) => S.adminBase ? `${S.adminBase.replace(/\/$/, '')}/${shop}` : `https://${shop}`;

db.exec(`
CREATE TABLE IF NOT EXISTS shopify_shops (
  shop TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  refresh_expires_at INTEGER,
  scopes TEXT,
  plan_name TEXT,
  billing_synced_at INTEGER,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  uninstalled_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS shopify_shops_user ON shopify_shops(user_id);
`);
if (!db.prepare('PRAGMA table_info(shopify_shops)').all().some((c) => c.name === 'billing_error_since')) db.exec('ALTER TABLE shopify_shops ADD COLUMN billing_error_since INTEGER');
if (!db.prepare('PRAGMA table_info(shopify_shops)').all().some((c) => c.name === 'dev_store')) db.exec('ALTER TABLE shopify_shops ADD COLUMN dev_store INTEGER');
const Q = {
  get: db.prepare('SELECT * FROM shopify_shops WHERE shop = ?'),
  byUser: db.prepare('SELECT * FROM shopify_shops WHERE user_id = ? AND uninstalled_at IS NULL'),
  byStore: db.prepare('SELECT * FROM shopify_shops WHERE store_id = ? AND uninstalled_at IS NULL'),
  upsertTokens: db.prepare(`INSERT INTO shopify_shops (shop, access_token, refresh_token, expires_at, refresh_expires_at, scopes) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at,
      refresh_expires_at = excluded.refresh_expires_at, scopes = excluded.scopes, uninstalled_at = NULL, updated_at = datetime('now')`),
  link: db.prepare("UPDATE shopify_shops SET user_id = ?, store_id = ?, updated_at = datetime('now') WHERE shop = ?"),
  uninstall: db.prepare("UPDATE shopify_shops SET uninstalled_at = datetime('now'), access_token = NULL, refresh_token = NULL, expires_at = NULL, updated_at = datetime('now') WHERE shop = ?"),
  plan: db.prepare('UPDATE shopify_shops SET plan_name = ?, billing_synced_at = ? WHERE shop = ?'),
  installed: db.prepare('SELECT * FROM shopify_shops WHERE uninstalled_at IS NULL AND access_token IS NOT NULL'),
  remove: db.prepare('DELETE FROM shopify_shops WHERE shop = ?'),
  // A refresh only updates an installed shop; it must never bring an uninstalled one back.
  refreshed: db.prepare("UPDATE shopify_shops SET access_token = ?, refresh_token = ?, expires_at = ?, refresh_expires_at = ?, updated_at = datetime('now') WHERE shop = ? AND uninstalled_at IS NULL"),
  syncFail: db.prepare('UPDATE shopify_shops SET billing_error_since = COALESCE(billing_error_since, ?) WHERE shop = ?'),
  syncOk: db.prepare('UPDATE shopify_shops SET billing_error_since = NULL WHERE shop = ?'),
};

// Stored tokens are encrypted with AES-256-GCM (src/secret.js).

// ---------- session tokens (JWT, HS256, signed with the app secret) ----------
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
/** Verifies a Shopify session token. Returns { shop, userId, sid } or throws. */
export function verifySessionToken(token) {
  if (!shopifyEnabled()) throw new Error('Shopify app is not configured');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed session token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  if (header.alg !== 'HS256') throw new Error('Unexpected token algorithm');
  const expected = b64url(crypto.createHmac('sha256', S.apiSecret).update(`${parts[0]}.${parts[1]}`).digest());
  const a = Buffer.from(expected), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Bad session token signature');
  const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const now = Math.floor(Date.now() / 1000);
  if (p.aud !== S.apiKey) throw new Error('Session token is for another app');
  if (typeof p.exp !== 'number' || p.exp < now - 5) throw new Error('Session token expired');
  if (typeof p.nbf === 'number' && p.nbf > now + 5) throw new Error('Session token not yet valid');
  const shop = new URL(p.dest).hostname.toLowerCase();
  if (!validShop(shop)) throw new Error('Session token has no valid shop');
  if (p.iss && new URL(p.iss).hostname.toLowerCase() !== shop) throw new Error('Session token issuer does not match shop');
  return { shop, userId: p.sub || null, sid: p.sid || null };
}

/** Verifies a webhook's HMAC (base64 of HMAC-SHA256 over the raw body). */
export function verifyWebhook(rawBody, hmac) {
  if (!shopifyEnabled() || !hmac) return false;
  const digest = crypto.createHmac('sha256', S.apiSecret).update(rawBody).digest('base64');
  const a = Buffer.from(digest), b = Buffer.from(String(hmac));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- access tokens ----------
async function tokenRequest(shop, params) {
  const r = await fetch(`${adminBase(shop)}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: S.apiKey, client_secret: S.apiSecret, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Shopify token request failed (${r.status}${j.error ? `: ${j.error}` : ''})`);
  return j;
}
function saveTokens(shop, j) {
  const now = Date.now();
  Q.upsertTokens.run(shop, seal(j.access_token), seal(j.refresh_token || null), j.expires_in ? now + j.expires_in * 1000 : null,
    j.refresh_token_expires_in ? now + j.refresh_token_expires_in * 1000 : null, j.scope || null);
}
/** Swaps a session token for an expiring offline access token. */
export async function exchangeToken(shop, idToken) {
  const j = await tokenRequest(shop, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: idToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token', requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token', expiring: 1,
  });
  saveTokens(shop, j);
}
const refreshing = new Map(); // one refresh per shop at a time: refresh tokens rotate
export async function accessToken(shop) {
  const row = Q.get.get(shop);
  if (!row || row.uninstalled_at || !row.access_token) throw new Error('Shop is not installed');
  if (!row.expires_at || row.expires_at - Date.now() > 5 * 60e3) return open(row.access_token);
  if (refreshing.has(shop)) return refreshing.get(shop);
  const p = (async () => {
    try {
      const rt = open(row.refresh_token);
      if (!rt) throw new Error('No refresh token; the merchant must open the app again');
      const j = await tokenRequest(shop, { grant_type: 'refresh_token', refresh_token: rt });
      const now = Date.now();
      const done = Q.refreshed.run(seal(j.access_token), seal(j.refresh_token || null), j.expires_in ? now + j.expires_in * 1000 : null, j.refresh_token_expires_in ? now + j.refresh_token_expires_in * 1000 : null, shop);
      if (!done.changes) throw new Error('Shop was uninstalled');
      return j.access_token;
    } finally { refreshing.delete(shop); }
  })();
  refreshing.set(shop, p);
  return p;
}
/** Runs a GraphQL Admin API query for a shop. */
export async function gql(shop, query, variables = {}) {
  const token = await accessToken(shop);
  const r = await fetch(`${adminBase(shop)}/admin/api/${S.apiVersion}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error(`Shopify API error (${r.status}): ${JSON.stringify(j.errors || j).slice(0, 200)}`);
  return j.data;
}

// ---------- the shop's Tharam account and store ----------
const EU = new Set(['BE', 'BG', 'CZ', 'DK', 'EE', 'IE', 'GR', 'ES', 'FR', 'HR', 'IT', 'CY', 'LV', 'LT', 'LU', 'HU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SI', 'SK', 'FI', 'SE']);
const marketOf = (cc) => (cc === 'GB' ? 'UK' : EU.has(cc) ? 'EU' : ['US', 'DE', 'AT', 'IN', 'SG', 'AU', 'CA', 'AE'].includes(cc) ? cc : null);

const opening = new Map(); // one first-open per shop at a time

/**
 * Called when the app opens in Shopify admin. Makes sure the shop is installed (token exchange) and has
 * its own Tharam account and store. Returns { userId, storeId, created }.
 */
export function ensureShop(shop, idToken, opts = {}) {
  if (opening.has(shop)) return opening.get(shop);
  const p = ensureShopOnce(shop, idToken, opts).finally(() => opening.delete(shop));
  opening.set(shop, p);
  return p;
}
async function ensureShopOnce(shop, idToken, { startRun, isPublic } = {}) {
  let row = Q.get.get(shop);
  const reinstall = !!row?.uninstalled_at;
  let healthy = row && !row.uninstalled_at && row.access_token;
  // A stored token that can't be used or refreshed is replaced with a fresh one from this session.
  if (healthy) { try { await accessToken(shop); } catch { healthy = false; } }
  if (!healthy) { await exchangeToken(shop, idToken); row = Q.get.get(shop); }

  if (reinstall && row.user_id && q.userById.get(row.user_id)) {
    // Coming back after an uninstall: switch checks back on and restore a usable plan.
    // A Shopify subscription, if they choose one again, is applied by the billing sync right after.
    db.prepare('UPDATE stores SET monitoring = 1 WHERE user_id = ?').run(row.user_id);
    const signup = getPlan(setting('signup_plan')) || getPlan('beta');
    updateLicense('shopify', row.user_id, { plan_key: signup.key, seats: 1, status: signup.kind === 'trial' ? 'trial' : 'active', billing: 'custom', price_override: null, expires_at: null });
    endRemovalWatch(shop);
    audit('shopify', row.user_id, 'note', { text: `Reinstalled from Shopify (${shop})` });
  }
  if (row.user_id && q.userById.get(row.user_id) && row.store_id && q.storeById.get(row.store_id)) return { userId: row.user_id, storeId: row.store_id, created: false };

  const data = await gql(shop, `{ shop { name email contactEmail currencyCode myshopifyDomain primaryDomain { url } billingAddress { countryCodeV2 } plan { partnerDevelopment } } }`);
  const info = data.shop;
  row = Q.get.get(shop); // re-read after the network call
  if (row.user_id && q.userById.get(row.user_id) && row.store_id && q.storeById.get(row.store_id)) return { userId: row.user_id, storeId: row.store_id, created: false };
  db.prepare('UPDATE shopify_shops SET dev_store = ? WHERE shop = ?').run(info.plan?.partnerDevelopment ? 1 : 0, shop);
  // Each shop has its own account, identified by its myshopify domain; it signs in only through Shopify.
  let userId = row.user_id && q.userById.get(row.user_id) ? row.user_id : null;
  if (!userId) {
    const existing = q.userByEmail.get(shop);
    userId = existing ? existing.id : Number(q.insertUser.run(shop, `shopify:${crypto.randomBytes(24).toString('hex')}`, String(info.name || shop).slice(0, 80)).lastInsertRowid);
    ensureLicense(userId, 'shopify');
  }
  let url = (info.primaryDomain?.url || `https://${shop}`).replace(/\/$/, '');
  if (isPublic) { try { await isPublic(new URL(url).origin); } catch { url = `https://${shop}`; } }
  const m = marketOf(info.billingAddress?.countryCodeV2);
  // New shops start with the welcome flow; nothing is tested until the owner starts the first check.
  const cfg = { markets: m ? [m] : [], currency: info.currencyCode || null, onboarded: false, toured: false };
  const storeId = Number(q.insertStore.run(userId, url, String(info.name || shop).slice(0, 80), null, info.contactEmail || info.email || null, null, JSON.stringify(cfg), 'Shopify', 1).lastInsertRowid);
  Q.link.run(userId, storeId, shop);
  audit('shopify', userId, 'note', { text: `Installed from Shopify (${shop})` });
  return { userId, storeId, created: true };
}

export const shopForUser = (userId) => Q.byUser.get(userId) || null;
export const shopForStore = (storeId) => Q.byStore.get(storeId) || null;
export const storeHandle = (shop) => shop.replace(/\.myshopify\.com$/, '');
export const pricingUrl = (shop) => `https://admin.shopify.com/store/${storeHandle(shop)}/charges/${S.appHandle}/pricing_plans`;

// ---------- billing: Shopify-managed plans mapped to Tharam plans ----------
/** Finds the Tharam plan for a Shopify plan name ("Growth", "Growth yearly", "growth-monthly"...). */
function planForShopifyName(name) {
  const n = String(name || '').toLowerCase();
  return listPlans().find((p) => p.kind === 'paid' && n.includes(p.key)) || listPlans().find((p) => p.kind === 'paid' && n.includes(p.name.toLowerCase())) || null;
}
/** Reads the shop's active subscription from Shopify and updates the Tharam licence to match. */
export async function syncBilling(shop, { force = false } = {}) {
  const row = Q.get.get(shop);
  if (!row?.user_id || row.uninstalled_at) return null;
  if (!force && row.billing_synced_at && Date.now() - row.billing_synced_at < 10 * 60e3) return row.plan_name;
  const d = await gql(shop, '{ currentAppInstallation { activeSubscriptions { name status test trialDays currentPeriodEnd } } }');
  // Test charges are free. They only count on development stores (which can't sell), so a test charge
  // can never unlock a paid plan for a live store.
  const sub = (d.currentAppInstallation?.activeSubscriptions || []).find((x) => x.status === 'ACTIVE' && (!x.test || row.dev_store || config.shopify.allowTestCharges)) || null;
  const lic = ensureLicense(row.user_id, 'shopify');
  if (sub) {
    const plan = planForShopifyName(sub.name);
    if (plan) {
      updateLicense('shopify', row.user_id, { plan_key: plan.key, seats: 1, status: 'active', billing: 'shopify', currency: 'USD', price_override: null, expires_at: null });
    } else console.error('Shopify plan has no matching Tharam plan', shop, sub.name);
  } else if (lic.billing === 'shopify' && getPlan(lic.plan_key)?.kind === 'paid') {
    // They had a Shopify-billed plan and it's no longer active (cancelled, declined or frozen).
    updateLicense('shopify', row.user_id, { status: 'cancelled' });
  }
  Q.plan.run(sub?.name || null, Date.now(), shop);
  return sub?.name || null;
}

// ---------- native data ----------
/** Unpublished themes the merchant can check before publishing. */
export async function draftThemes(shop) {
  const d = await gql(shop, '{ themes(first: 25, roles: [UNPUBLISHED, DEVELOPMENT]) { nodes { id name role updatedAt } } }');
  return (d.themes?.nodes || []).map((t) => ({ id: String(t.id).split('/').pop(), name: t.name, role: t.role, updatedAt: t.updatedAt }));
}
/** Active discount codes with their percentage, for the discount code check. */
export async function activeCodes(shop) {
  const d = await gql(shop, `{ codeDiscountNodes(first: 10, query: "status:active") { nodes { codeDiscount {
    ... on DiscountCodeBasic { title codes(first: 2) { nodes { code } } customerGets { value { ... on DiscountPercentage { percentage } } } }
    ... on DiscountCodeBxgy { title codes(first: 2) { nodes { code } } }
    ... on DiscountCodeFreeShipping { title codes(first: 2) { nodes { code } } } } } } }`);
  const out = [];
  for (const n of d.codeDiscountNodes?.nodes || []) {
    const cd = n.codeDiscount || {};
    const pct = cd.customerGets?.value?.percentage;
    for (const c of cd.codes?.nodes || []) out.push({ code: c.code, percent: typeof pct === 'number' ? Math.round(pct * 1000) / 10 : null, fromShopify: true });
  }
  return out;
}

// ---------- uninstall and privacy ----------
export function uninstalled(shop) {
  const row = Q.get.get(shop);
  // Shopify may deliver the same webhook more than once: only the first one (while installed) counts.
  const wasInstalled = !!row && !row.uninstalled_at;
  Q.uninstall.run(shop);
  if (!row?.user_id) return;
  db.prepare('UPDATE stores SET monitoring = 0 WHERE user_id = ?').run(row.user_id);
  try { updateLicense('shopify', row.user_id, { status: 'cancelled' }); } catch (e) { console.error('licence on uninstall', e); }
  audit('shopify', row.user_id, 'note', { text: `Uninstalled from Shopify (${shop})` });
  if (wasInstalled) {
    try { startRemovalWatch(shop, row.user_id, q.storesByUser.all(row.user_id), removalRecipients(row.user_id)); } catch (e) { console.error('removal watch', shop, e.message); }
  }
  if (wasInstalled) removalAlarm(shop, row.user_id).catch((e) => console.error('removal alarm', shop, e.message));
}

const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
/** Who hears that Tharam was removed: the confirmed browser-access email and every store's alert email. */
export function removalRecipients(userId) {
  const u = q.userById.get(userId);
  const all = [u?.login_email, ...q.storesByUser.all(userId).map((s) => s.alert_email)];
  const seen = new Set();
  return all.filter((e) => isEmail(e) && !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()));
}

/**
 * S16 removal alarm: someone who takes over a Shopify admin often removes monitoring first. Tell the
 * owner straight away, outside Shopify, in one email.
 */
export async function removalAlarm(shop, userId) {
  const to = removalRecipients(userId);
  if (!to.length) return false;
  const name = q.storesByUser.all(userId)[0]?.name || shop;
  const when = new Date().toUTCString().replace('GMT', 'UTC');
  const admin = `https://admin.shopify.com/store/${storeHandle(shop)}`;
  const text = [
    `Tharam was removed from your store ${name} (${shop}) on ${when}.`,
    '',
    "If this wasn't you, your admin may be compromised.",
    '',
    'What to do now:',
    `1. Sign in to Shopify admin (${admin}) and change your password.`,
    '2. Check Settings > Users and permissions for staff you don\'t know, and remove them.',
    '3. Check Apps for apps you didn\'t install, and remove them.',
    '4. Turn on two-step login for every staff account.',
    '5. Add Tharam again from the Shopify App Store so your store is watched again.',
    '',
    "If it was you, there's nothing to do. Your store is no longer checked. Shopify asks us to delete your store's data 48 hours after the app is removed; add Tharam again before then to keep your history.",
    '',
    'Tharam',
  ].join('\n');
  await sendMail({ to: to.join(', '), subject: `Tharam was removed from ${name}`, text });
  audit('shopify', userId, 'note', { text: `Removal alarm emailed to ${to.join(', ')}` });
  return true;
}
/** shop/redact: 48 hours after uninstall, Shopify asks us to delete the shop's data. */
export function redactShop(shop) {
  const row = Q.get.get(shop);
  if (row?.uninstalled_at == null && row?.access_token) return false; // reinstalled since; keep
  purgeRemovalWatch(shop);
  if (row?.user_id) {
    // Shopify's shop/redact: every file and row for this shop goes (screenshots, approved looks, product snapshots).
    for (const s of q.storesByUser.all(row.user_id)) purgeStoreFiles(s.id);
    audit('shopify', null, 'note', { text: `Deleted all data for ${shop} (shop/redact)` });
    db.prepare('DELETE FROM users WHERE id = ?').run(row.user_id);
  }
  Q.remove.run(shop);
  return true;
}

/**
 * Daily: keep plans in step with Shopify for every installed shop. If we can't reach a shop's billing for a
 * week (for example its token stopped working), a Shopify-billed plan is paused until the merchant opens
 * the app again, which repairs the connection and re-reads the plan.
 */
export async function syncAllBilling() {
  for (const r of Q.installed.all()) {
    try { await syncBilling(r.shop, { force: true }); Q.syncOk.run(r.shop); }
    catch (e) {
      console.error('billing sync failed', r.shop, e.message);
      Q.syncFail.run(Date.now(), r.shop);
      const row = Q.get.get(r.shop);
      if (row?.user_id && row.billing_error_since && Date.now() - row.billing_error_since > 7 * 864e5) {
        const lic = ensureLicense(row.user_id, 'shopify');
        if (lic.billing === 'shopify' && lic.status === 'active') {
          updateLicense('shopify', row.user_id, { status: 'suspended' });
          audit('shopify', row.user_id, 'note', { text: 'Paused: Shopify billing could not be checked for 7 days. Opening the app reconnects it.' });
        }
      }
    }
  }
}
