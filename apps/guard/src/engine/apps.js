/**
 * App Health: which app or service each storefront script, file and outside site belongs to, and what
 * those files cost a shopper on a phone. The names come from apps.json (plus APP_NAMES in the environment);
 * apps served from Shopify's app extension folders are named from the folder itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageKind } from './scripts.js';
import { check } from './checks.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'apps.json');
let MAP = null;
let WIDGETS = null;
const readApps = () => { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')).apps; } catch { return []; } };
/** [{ host, name, kind }] longest host first, so a specific entry wins over a general one. */
export function appMap() {
  if (!MAP) {
    const apps = readApps();
    const rows = apps.flatMap((a) => a.hosts.map((h) => ({ host: h.toLowerCase(), name: a.name, kind: a.kind })));
    for (const pair of String(process.env.APP_NAMES || '').split(',')) {
      const [h, ...name] = pair.split('=');
      if (h?.trim() && name.join('=').trim()) rows.push({ host: h.trim().toLowerCase(), name: name.join('=').trim(), kind: 'app' });
    }
    MAP = rows.sort((a, b) => b.host.length - a.host.length);
  }
  return MAP;
}
export const resetAppMap = () => { MAP = null; WIDGETS = null; };

const PAGE_KINDS = ['home', 'product', 'cart'];
/**
 * What apps draw for shoppers: appKey → { name, selector, pages|null } (pages null = every page the app loads on).
 * From apps.json, plus APP_WIDGETS in the environment: 'Name=selector@product+cart;Other=selector'.
 */
export function widgetMap() {
  if (!WIDGETS) {
    WIDGETS = new Map();
    for (const a of readApps()) if (a.widget?.selector) WIDGETS.set(slug(a.name), { name: a.name, selector: a.widget.selector, pages: a.widget.pages || null });
    for (const pair of String(process.env.APP_WIDGETS || '').split(';')) {
      const i = pair.indexOf('=');
      if (i < 1) continue;
      const name = pair.slice(0, i).trim();
      const [selector, pages] = pair.slice(i + 1).split('@');
      if (!name || !selector?.trim()) continue;
      const pg = pages ? pages.split('+').map((x) => x.trim()).filter((x) => PAGE_KINDS.includes(x)) : [];
      WIDGETS.set(slug(name), { name, selector: selector.trim(), pages: pg.length ? pg : null });
    }
  }
  return WIDGETS;
}

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

/**
 * Widget watch: on every store page the journey opens, notes which known app widgets become visible to a
 * shopper (polled for 10 s after the page starts, so widgets drawn late still count). Only looks; never clicks.
 * Returns a function that gives { home: [appKey…], product: [...], cart: [...] }.
 */
export async function watchWidgets(page) {
  const list = [...widgetMap().entries()].map(([key, w]) => ({ key, selector: w.selector }));
  const seen = {};
  if (!list.length) return () => seen;
  await page.exposeBinding('__tharamWidget', (source, i) => {
    let url;
    try { url = source.frame.url(); } catch { return; }
    const kind = pageKind(url);
    const w = list[i];
    if (!kind || !w) return;
    (seen[kind] ||= new Set()).add(w.key);
  });
  await page.addInitScript((selectors) => {
    if (window.top !== window) return;
    const found = new Set();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
    };
    const scan = () => {
      selectors.forEach((sel, i) => {
        if (found.has(i)) return;
        let els = [];
        try { els = document.querySelectorAll(sel); } catch { found.add(i); return; }
        for (const el of els) if (visible(el)) { found.add(i); try { window.__tharamWidget(i); } catch {} break; }
      });
    };
    let n = 0;
    const timer = setInterval(() => { if (document.body) scan(); if (++n >= 40 || found.size === selectors.length) clearInterval(timer); }, 250);
    addEventListener('load', scan);
  }, list.map((w) => w.selector));
  return () => Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [...v].sort()]));
}

/**
 * Apps with a known widget that loaded on a page where the widget should show, but it never became visible.
 * `inventory` is the script watch record of this check, `seen` what watchWidgets saw.
 * Returns { checked: [{ key, name, pages }], missing: [{ key, name, pages: [pages where it's missing] }] }.
 */
export function missingWidgets(inventory, seen = {}) {
  const widgets = widgetMap();
  const host = inventory?.storeHost || '';
  const loads = new Map(); // appKey → Set(pages it loads on)
  for (const [kind, p] of Object.entries(inventory?.pages || {})) {
    for (const s of p.scripts) {
      const a = appFor(s.url, host);
      if (!widgets.has(a.key)) continue;
      if (!loads.has(a.key)) loads.set(a.key, new Set());
      loads.get(a.key).add(kind);
    }
  }
  const checked = [];
  const missing = [];
  for (const [key, pages] of loads) {
    const w = widgets.get(key);
    const expected = [...pages].filter((pg) => !w.pages || w.pages.includes(pg)).sort();
    if (!expected.length) continue;
    checked.push({ key, name: w.name, pages: expected });
    const gone = expected.filter((pg) => !(seen[pg] || []).includes(key));
    if (gone.length) missing.push({ key, name: w.name, pages: gone });
  }
  return { checked, missing };
}

const PAGE_NAMES = { home: 'home page', product: 'product page', cart: 'cart page' };
const pagesText = (pages) => { const n = pages.map((p) => PAGE_NAMES[p] || p); return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : n[0]; };

/** The widget check (Script watch group): a notice, so it never changes the score or sends a "fixed" email. */
export function widgetCheck(rec, result) {
  if (!result.checked.length) return;
  const title = 'App widgets show for shoppers';
  if (!result.missing.length) {
    rec.add({ ...check('sec.scripts.widgets', 'functional', title, 'pass', { severity: 'major', detail: `${result.checked.map((a) => a.name).join(', ')}: ${result.checked.length > 1 ? 'their widgets show' : 'its widget shows'} where ${result.checked.length > 1 ? 'they load' : 'it loads'}.` }), notice: true });
    return;
  }
  const list = result.missing.map((a) => `${a.name} loads on the ${pagesText(a.pages)}, but shoppers don't see its widget there`).join('. ');
  rec.add({
    ...check('sec.scripts.widgets', 'functional', title, 'fail', {
      severity: 'major',
      detail: `${list}.`,
      fix: 'Open the page and look for it. If it is missing, check the app is switched on in Online Store → Themes → Customize → App embeds and that its block is still on the page, then contact the app\'s support. If you removed the widget on purpose, there is nothing to do.',
      evidence: { missing: result.missing },
    }),
    notice: true,
  });
}
