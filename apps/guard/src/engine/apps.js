/**
 * App Health: which app or service each storefront script, file and outside site belongs to, and what
 * those files cost a shopper on a phone. The names come from apps.json (plus APP_NAMES in the environment);
 * apps served from Shopify's app extension folders are named from the folder itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageKind } from './scripts.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'apps.json');
let MAP = null;
/** [{ host, name, kind }] longest host first, so a specific entry wins over a general one. */
export function appMap() {
  if (!MAP) {
    let apps = [];
    try { apps = JSON.parse(fs.readFileSync(DATA, 'utf8')).apps; } catch {}
    const rows = apps.flatMap((a) => a.hosts.map((h) => ({ host: h.toLowerCase(), name: a.name, kind: a.kind })));
    for (const pair of String(process.env.APP_NAMES || '').split(',')) {
      const [h, ...name] = pair.split('=');
      if (h?.trim() && name.join('=').trim()) rows.push({ host: h.trim().toLowerCase(), name: name.join('=').trim(), kind: 'app' });
    }
    MAP = rows.sort((a, b) => b.host.length - a.host.length);
  }
  return MAP;
}
export const resetAppMap = () => { MAP = null; };

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** "judge-me-reviews-260" → "Judge Me Reviews" */
const fromHandle = (h) => h.replace(/-v?\d+(\.\d+)*$/, '').split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'Shopify app';
/** example.co.uk → example.co.uk, cdn.widgets.example.com → example.com */
function siteOf(host) {
  const parts = host.split('.');
  if (parts.length <= 2 || /^\d+$/.test(parts.at(-1))) return host;
  const n = parts.at(-1).length === 2 && parts.at(-2).length <= 3 ? 3 : 2;
  return parts.slice(-n).join('.');
}

/**
 * Who a URL belongs to: { key, name, kind } where kind is theme | app | tracking | service | shopify | tharam | unknown.
 * `storeHost` is the store's own host (with port, as in URL.host).
 */
export function appFor(url, storeHost) {
  let u;
  try { u = new URL(url); } catch { return { key: 'unknown', name: 'Unknown', kind: 'unknown' }; }
  const host = u.host.toLowerCase();
  const bare = u.hostname.toLowerCase();
  // App blocks and embeds: /extensions/<id>/<handle>-<version>/… on Shopify's CDN or the store's own /cdn/shop/.
  const ext = /\/extensions\/([0-9a-f-]{8,})\/([^/]+)\//i.exec(u.pathname);
  if (ext && (host === storeHost || bare.endsWith('shopify.com') || bare.endsWith('shopifycdn.net'))) return { key: `ext:${ext[1].toLowerCase()}`, name: fromHandle(ext[2]), kind: 'app' };
  // The theme: the store's own files and its theme folder on Shopify's CDN.
  if (host === storeHost || (bare === 'cdn.shopify.com' && /\/t\/\d+\/assets\//.test(u.pathname))) return { key: 'theme', name: 'Your theme', kind: 'theme' };
  const hit = appMap().find((m) => bare === m.host || bare.endsWith('.' + m.host) || host === m.host);
  if (hit) return { key: slug(hit.name), name: hit.name, kind: hit.kind };
  const site = siteOf(bare);
  return { key: `site:${site}${u.port && /^\d+(\.\d+){3}$|^localhost$/.test(bare) ? ':' + u.port : ''}`, name: site, kind: 'unknown' };
}

/**
 * Records what each file costs on the phone page (bytes over the network, and how long it took) while the
 * speed check loads the home and product pages. Returns stop(): an async function that detaches and gives
 * { pages, files: [{ url, page, type, bytes, ms }] } (biggest first, capped).
 */
export function watchCost(page) {
  const files = new Map();
  const pending = new Set();
  const seen = new Set();
  const onDone = (req) => {
    let frameUrl;
    try { frameUrl = req.frame()?.url(); } catch { frameUrl = null; }
    const kind = pageKind(frameUrl || page.url());
    if (!kind || kind === 'cart') return;
    let u;
    try { u = new URL(req.url()); } catch { return; }
    if (!/^https?:$/.test(u.protocol) || req.resourceType() === 'document' && req.frame() === page.mainFrame()) return;
    seen.add(kind);
    const p = req.sizes().then((s) => {
      const t = req.timing();
      const key = `${kind}|${u.origin}${u.pathname}`;
      const f = files.get(key) || { url: `${u.origin}${u.pathname}`, page: kind, type: req.resourceType(), bytes: 0, ms: 0, count: 0 };
      f.bytes += Math.max(0, (s.responseBodySize || 0) + (s.responseHeadersSize || 0));
      f.ms += t && t.responseEnd > 0 ? Math.round(t.responseEnd) : 0;
      f.count += 1;
      files.set(key, f);
    }).catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  };
  page.on('requestfinished', onDone);
  return async () => {
    page.off('requestfinished', onDone);
    await Promise.race([Promise.all([...pending]), new Promise((r) => setTimeout(r, 2000))]);
    return { pages: [...seen].sort(), files: [...files.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 200) };
  };
}

/** The script that threw, from an error's stack: the first web address in it. */
export function errorSource(e) {
  const m = /(https?:\/\/[^\s)]+?)(?::\d+){1,2}\)?(?:\s|$)/.exec(String(e?.stack || ''));
  if (!m) return null;
  try { const u = new URL(m[1]); return `${u.origin}${u.pathname}`; } catch { return null; }
}
