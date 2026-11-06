/**
 * Script watch (security S1): records every script and every outside site the home, product and cart pages
 * use during a check, compares them with the previous check, and flags new scripts and known-bad sites.
 * Most app and theme changes are harmless; a new script on the product or cart page is also how card
 * skimmers and checkout hijacks arrive, so the owner hears about each new one once.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, plural } from './checks.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bad-domains.json');
let BAD = null;
/** Known-bad sites (skimmers, crypto-miners, malware drops), plus any in BAD_DOMAINS (comma separated). */
export function badDomains() {
  if (!BAD) {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(DATA, 'utf8')).domains.map((d) => d.domain); } catch {}
    BAD = [...new Set([...list, ...String(process.env.BAD_DOMAINS || '').split(',')].map((d) => d.trim().toLowerCase()).filter(Boolean))];
  }
  return BAD;
}
export const isBadHost = (host) => { const h = String(host || '').toLowerCase().replace(/:\d+$/, ''); return badDomains().some((d) => h === d || h.endsWith('.' + d)); };

const PAGES = { home: 'Home page', product: 'Product page', cart: 'Cart page' };
export function pageKind(url) {
  let p;
  try { p = new URL(url).pathname; } catch { return null; }
  if (p === '/' || p === '') return 'home';
  if (/^\/(collections\/[^/]+\/)?products\/[^/]+\/?$/.test(p)) return 'product';
  if (/^\/cart\/?$/.test(p)) return 'cart';
  return null;
}

/**
 * The same script across checks, even when its address carries a cache-buster: the query string is dropped,
 * and version folders, theme ids and long hashes in the path are replaced with *.
 */
export function scriptKey(url) {
  try {
    const u = new URL(url);
    const p = u.pathname
      .replace(/\/t\/\d+\//, '/t/*/')
      .split('/')
      .map((s) => (/^v?\d+(\.\d+)+$/.test(s) || /^[0-9a-f]{8,}$/i.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) ? '*' : s.replace(/[.-][0-9a-f]{8,}(?=\.js$)/i, '.*')))
      .join('/');
    return `${u.host}${p}`;
  } catch { return String(url).slice(0, 200); }
}

/** Starts recording on a page. Returns a function that gives the inventory recorded so far. */
export function watchScripts(page, origin) {
  const storeHost = new URL(origin).host;
  const pages = {};
  const at = (kind) => (pages[kind] ||= { scripts: new Map(), sites: new Set() });
  // App Health: a fingerprint of each outside script's content, so a change at the same address shows.
  const byRequest = new WeakMap();
  const pending = new Set();
  page.on('response', (res) => {
    const s = byRequest.get(res.request());
    if (!s || s.hash || !res.ok()) return;
    const p = res.body().then((b) => { if (!s.hash && b.length) s.hash = crypto.createHash('sha256').update(b).digest('hex').slice(0, 16); }).catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  });
  page.on('request', (req) => {
    let frameUrl;
    try { frameUrl = req.frame()?.url(); } catch { frameUrl = null; }
    const kind = pageKind(frameUrl || page.url());
    if (!kind) return;
    let u;
    try { u = new URL(req.url()); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    const rec = at(kind);
    if (u.host !== storeHost) rec.sites.add(u.host);
    if (req.resourceType() === 'script') {
      const key = scriptKey(req.url());
      if (!rec.scripts.has(key)) rec.scripts.set(key, { key, url: `${u.origin}${u.pathname}`, host: u.host, outside: u.host !== storeHost });
      const s = rec.scripts.get(key);
      if (s.outside && !s.hash) byRequest.set(req, s);
    }
  });
  const inventory = () => ({
    storeHost,
    pages: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, { scripts: [...v.scripts.values()].map((x) => ({ ...x })), sites: [...v.sites].sort() }])),
  });
  /** Waits (up to 2 s) for script fingerprints still being worked out. */
  inventory.settle = () => Promise.race([Promise.all([...pending]), new Promise((r) => setTimeout(r, 2000))]);
  return inventory;
}

const allScripts = (inv) => {
  const out = new Map();
  for (const [kind, p] of Object.entries(inv?.pages || {})) for (const s of p.scripts) if (!out.has(s.key)) out.set(s.key, { ...s, page: kind });
  return out;
};
const allSites = (inv) => new Set(Object.values(inv?.pages || {}).flatMap((p) => p.sites));

/**
 * Adds the script watch checks and returns the inventory with what is new since `previous`
 * (the inventory of the store's previous check, or null for its first).
 */
export function scriptChecks({ rec, inventory, previous = null, monitored = true }) {
  const now = allScripts(inventory);
  const sites = allSites(inventory);
  const bad = [...sites].filter(isBadHost);
  const out = { ...inventory, counts: { scripts: now.size, sites: sites.size }, added: [], addedSites: [], bad, baseline: !previous };
  if (!Object.keys(inventory.pages).length) return out; // the pages didn't load: nothing to compare

  rec.add(bad.length
    ? check('sec.scripts.bad', 'security', 'No scripts from known malicious sites', 'fail', {
      severity: 'critical',
      detail: `Your store loads code from ${bad.join(', ')}, a site known for stealing card details or mining cryptocurrency on shoppers' devices.`,
      fix: 'Find the app or theme file that adds it (Online Store → Themes → Edit code, and your apps list) and remove it now. Then change your Shopify password and check your staff accounts.',
      evidence: { sites: bad },
    })
    : check('sec.scripts.bad', 'security', 'No scripts from known malicious sites', 'pass', { severity: 'critical', detail: `${plural(sites.size, 'outside site')} checked against our list of known malicious sites.` }));

  if (!monitored) return out;
  if (!previous) {
    rec.add({ ...check('sec.scripts.new', 'security', 'No new scripts since the last check', 'pass', { severity: 'major', detail: `First record of your store's scripts: ${plural(now.size, 'script')} from ${plural(sites.size, 'outside site')}. We'll tell you when a new one appears.` }), notice: true });
    return out;
  }
  // Only pages the previous check also reached are compared (a page that failed to load last time
  // would otherwise make all its scripts look new).
  const before = allScripts(previous);
  const sitesBefore = allSites(previous);
  const reached = new Set(Object.keys(previous.pages || {}));
  out.added = [...now.values()].filter((s) => reached.has(s.page) && !before.has(s.key));
  out.addedSites = [...new Set(Object.entries(inventory.pages).filter(([k]) => reached.has(k)).flatMap(([, p]) => p.sites))].filter((h) => !sitesBefore.has(h));
  const onBuyingPages = out.added.filter((s) => s.page !== 'home');
  const list = out.added.slice(0, 5).map((s) => `${s.url} (${PAGES[s.page].toLowerCase()})`).join(', ');
  rec.add({
    ...(out.added.length
      ? check('sec.scripts.new', 'security', 'No new scripts since the last check', 'fail', {
        severity: 'major',
        detail: `${plural(out.added.length, 'new script')} since the last check${onBuyingPages.length ? `, ${onBuyingPages.length} on the product or cart page` : ''}: ${list}${out.added.length > 5 ? ', and more' : ''}.`,
        fix: 'If you just added or updated an app or theme, this is expected and there is nothing to do. If not, find what added it (your apps list, Online Store → Themes → Edit code) and remove it.',
        evidence: { scripts: out.added.map((s) => ({ url: s.url, page: s.page })), sites: out.addedSites },
      })
      : check('sec.scripts.new', 'security', 'No new scripts since the last check', 'pass', { severity: 'major', detail: `Same ${plural(now.size, 'script')} as the last check.` })),
    // A new script is news once: the next check without new scripts doesn't send a "fixed" email.
    notice: true,
  });
  return out;
}
