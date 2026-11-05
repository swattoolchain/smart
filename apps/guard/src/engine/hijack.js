/**
 * Store hijack watch (security S2): shoppers sent to another website, hidden frames from outside sites,
 * and cryptocurrency mining on shoppers' devices. These are the classic signs of a hacked storefront:
 * injected code that redirects visitors to scam pages, loads invisible pages from other sites, or uses
 * the shopper's phone to mine coins.
 *
 * Recording runs in the check's own browser contexts while the normal shopping journey happens, plus one
 * extra visit: the home page on a phone, arriving from a Google search (hacked stores often redirect only
 * those visitors, so the owner, who types the address on a laptop, never sees it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, plural } from './checks.js';
import { isBadHost, pageKind } from './scripts.js';

const BAD_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bad-domains.json');
let MINING_HOSTS = null;
const miningHosts = () => {
  if (!MINING_HOSTS) {
    try { MINING_HOSTS = JSON.parse(fs.readFileSync(BAD_FILE, 'utf8')).domains.filter((d) => /mining/.test(d.kind)).map((d) => d.domain); } catch { MINING_HOSTS = []; }
  }
  return MINING_HOSTS;
};
const bare = (host) => String(host || '').toLowerCase().replace(/:\d+$/, '');
const under = (host, list) => { const h = bare(host); return list.some((d) => h === d || h.endsWith('.' + d)); };

/** Shopify's own addresses: checkout, Shop Pay, accounts, previews. Never "another website". */
const SHOPIFY = ['shopify.com', 'shop.app', 'myshopify.com', 'shopifypreview.com', 'shopifycdn.com', 'shopifycloud.com'];
/**
 * Services that commonly put a hidden frame on stores (tags, pixels, payments, captchas, chat). A hidden frame
 * from one of these is normal; from anywhere else it is worth a look.
 */
const TRUSTED_FRAMES = [...SHOPIFY, 'google.com', 'googletagmanager.com', 'doubleclick.net', 'googlesyndication.com', 'gstatic.com', 'google-analytics.com',
  'youtube.com', 'youtube-nocookie.com', 'vimeo.com', 'facebook.com', 'facebook.net', 'tiktok.com', 'pinterest.com', 'snapchat.com', 'bing.com',
  'klaviyo.com', 'paypal.com', 'stripe.com', 'stripe.network', 'razorpay.com', 'klarna.com', 'afterpay.com', 'recaptcha.net', 'hcaptcha.com',
  'cloudflare.com', 'hotjar.com', 'criteo.com', 'criteo.net', 'intercom.io', 'zendesk.com', 'tidio.co', 'gorgias.chat', 'judge.me', 'yotpo.com'];

const GENERIC = new Set(['www', 'shop', 'store', 'com', 'net', 'org', 'co', 'io', 'app', 'online', 'localhost', 'biz', 'info', 'site']);
const brand = (host) => bare(host).split('.').filter((l) => l.length > 2 && !GENERIC.has(l) && !/^\d+$/.test(l));
/** example.com, www.example.com and example.de are the same business; other names are another website. */
export function sameBusiness(a, b) {
  const x = bare(a).replace(/^www\./, ''), y = bare(b).replace(/^www\./, '');
  if (x === y) return true;
  const bx = brand(x);
  return brand(y).some((l) => bx.includes(l));
}
/** True when sending a shopper to `host` takes them away from the store and Shopify. */
export function isOffSite(host, storeHost) {
  if (!host) return false;
  return !sameBusiness(host, storeHost) && !under(host, SHOPIFY);
}

/** Code that only cryptocurrency miners contain (CoinHive and its clones, CryptoLoot, CoinImp, Monero pools). */
export const MINER_RE = /\b(CoinHive\.(Anonymous|User|Token)|coinhive\.min\.js|CRLT\.Anonymous|CryptoLoot|CoinImp|Client\.Anonymous\(|deepMiner|webminepool|cryptonight|stratum\+tcp|minero\.cc|monero[-_ ]?miner)/i;
/** Mining pools talk over WebSockets on well-known ports or paths. */
export const POOL_RE = /(stratum|xmr|monero|minexmr|nanopool|supportxmr|hashvault|[:/](3333|5555|7777|14444|45560|45700)\b)/i;

// Runs in every frame before the page's own code: notes WebSocket and Worker use, and (top frame only)
// lists hidden frames and miner code once the page has loaded. Reports through the __tharamWatch binding.
const INIT = `(() => {
  if (window.__tharamWatchOn) return; window.__tharamWatchOn = true;
  const MINER = ${MINER_RE.toString()};
  const send = (kind, data) => { try { window.__tharamWatch && window.__tharamWatch(Object.assign({ kind: kind, url: location.href }, data)); } catch (e) {} };
  for (const name of ['WebSocket', 'Worker', 'SharedWorker']) {
    const Orig = window[name];
    if (typeof Orig !== 'function') continue;
    try { window[name] = new Proxy(Orig, { construct(t, args, nt) { send('open', { what: name, target: String(args[0]).slice(0, 300) }); return Reflect.construct(t, args, nt); } }); } catch (e) {}
  }
  if (window !== window.top) return;
  const scan = () => {
    try {
      const frames = [];
      for (const f of document.querySelectorAll('iframe, frame')) {
        const src = f.src || '';
        if (!/^https?:/.test(src)) continue;
        const r = f.getBoundingClientRect(), cs = getComputedStyle(f);
        const how = cs.display === 'none' || (r.width === 0 && r.height === 0) ? 'not shown at all'
          : cs.visibility === 'hidden' ? 'set to invisible'
          : Number(cs.opacity) === 0 ? 'fully transparent'
          : r.width <= 3 || r.height <= 3 ? Math.round(r.width) + ' × ' + Math.round(r.height) + ' pixels'
          : r.right <= 0 || r.bottom <= 0 || r.left >= Math.max(innerWidth, document.documentElement.scrollWidth) + 500 ? 'placed off the screen' : null;
        if (how) frames.push({ src: src.slice(0, 300), how: how });
      }
      let inline = '';
      for (const s of document.scripts) if (!s.src && s.textContent) inline += s.textContent.slice(0, 200000) + '\\n';
      const m = MINER.exec(inline);
      const globals = ['CoinHive', 'CoinImp', 'CRLT', 'deepMiner', 'WMP'].filter((g) => { try { return typeof window[g] !== 'undefined'; } catch (e) { return false; } });
      send('scan', { frames: frames, inline: m ? m[0] : null, globals: globals });
    } catch (e) {}
  };
  document.addEventListener('DOMContentLoaded', () => setTimeout(scan, 300));
  window.addEventListener('load', () => setTimeout(scan, 1000));
})();`;

/**
 * Starts recording in the given browser contexts (call before the journey). Returns
 * { probe(page), result() }: probe makes the phone-from-Google visit; result gives what was recorded.
 */
export async function watchHijack({ contexts, origin, shot }) {
  const storeHost = new URL(origin).host;
  const redirects = new Map(); // to-address → { from, to, page, device, screenshot }
  const frames = new Map(); // frame address → { src, host, how, page }
  const mining = new Map(); // signal → { signal, where, page }
  const scanned = new Set();
  const bodies = [];
  const seenScripts = new Set();
  const addMining = (signal, where, page) => { const k = `${signal}|${where}`; if (!mining.has(k)) mining.set(k, { signal, where, page }); };

  const attach = (page, device) => {
    page.on('request', (req) => {
      try {
        let u; try { u = new URL(req.url()); } catch { return; }
        if (!/^(https?|wss?):$/.test(u.protocol)) return;
        // Any contact with a known mining site counts, whatever the page.
        if (under(u.host, miningHosts())) addMining(`Talks to ${bare(u.host)}, a known cryptocurrency mining site`, `${u.origin}${u.pathname}`.slice(0, 200), pageKind(req.frame()?.url() || page.url()) || 'other');
        if (!req.isNavigationRequest() || req.frame() !== page.mainFrame() || !isOffSite(u.host, storeHost)) return;
        // Who started this navigation: the first request of a redirect chain carries the page it came from.
        let first = req; while (first.redirectedFrom()) first = first.redirectedFrom();
        const ref = first.headers().referer || '';
        let from; try { from = new URL(ref); } catch { return; } // typed/our own visits carry no store referer
        if (from.host !== storeHost && !sameBusiness(from.host, storeHost)) return;
        // Cart and checkout are the checkout test's job (checkout opening on Shopify's own address is normal).
        if (/^\/(cart|checkouts?|account|password)\b/.test(from.pathname)) return;
        const to = `${u.origin}${u.pathname}`.slice(0, 200);
        if (!redirects.has(to)) redirects.set(to, { from: `${from.origin}${from.pathname}`.slice(0, 200), to, host: bare(u.host), page: pageKind(from.href) || 'other', device, screenshot: null });
      } catch {}
    });
    page.on('load', () => {
      let host; try { host = new URL(page.url()).host; } catch { return; }
      if (!isOffSite(host, storeHost)) return;
      const r = [...redirects.values()].find((x) => !x.screenshot && x.host === bare(host));
      if (r) r.screenshot = shot(page, `redirect-${device}`).catch(() => null);
    });
    page.on('response', (res) => {
      try {
        const req = res.request();
        if (req.resourceType() !== 'script' || res.status() !== 200 || seenScripts.size >= 150) return;
        const url = res.url();
        if (seenScripts.has(url)) return;
        seenScripts.add(url);
        if (Number(res.headers()['content-length'] || 0) > 3_000_000) return;
        const where = pageKind(req.frame()?.url() || page.url()) || 'other';
        bodies.push(res.text().then((t) => { const m = MINER_RE.exec(t.slice(0, 3_000_000)); if (m) addMining(`Mining code (“${m[0]}”)`, url.split('?')[0].slice(0, 200), where); }).catch(() => {}));
      } catch {}
    });
  };

  for (const { ctx, device } of contexts) {
    await ctx.exposeBinding('__tharamWatch', ({ frame }, data) => {
      try {
        const kind = pageKind(data?.url || frame?.url());
        if (data?.kind === 'open') {
          let t; try { t = new URL(data.target, data.url); } catch { return; }
          if (POOL_RE.test(data.target) || under(t.host, miningHosts())) addMining(`Opens a ${data.what === 'WebSocket' ? 'connection' : 'background worker'} to a mining pool`, String(data.target).slice(0, 200), kind || 'other');
        } else if (data?.kind === 'scan') {
          let host; try { host = new URL(data.url).host; } catch { return; }
          if (host !== storeHost && !sameBusiness(host, storeHost)) return;
          scanned.add(`${device}:${new URL(data.url).pathname}`);
          for (const f of data.frames || []) {
            let h; try { h = new URL(f.src).host; } catch { continue; }
            if (sameBusiness(h, storeHost) || under(h, TRUSTED_FRAMES)) continue;
            const key = f.src.split('?')[0];
            if (!frames.has(key)) frames.set(key, { src: key.slice(0, 200), host: bare(h), how: f.how, page: kind || 'other', bad: isBadHost(h) });
          }
          if (data.inline) addMining(`Mining code (“${data.inline}”)`, 'code written into the page', kind || 'other');
          for (const g of data.globals || []) addMining(`A mining program (${g}) is running`, 'the page', kind || 'other');
        }
      } catch {}
    });
    await ctx.addInitScript({ content: INIT });
    for (const p of ctx.pages()) attach(p, device);
    ctx.on('page', (p) => attach(p, device));
  }

  return {
    /** One home-page visit on a phone, arriving from a Google search. */
    async probe(ctx) {
      const p = await ctx.newPage();
      try {
        await p.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000, referer: 'https://www.google.com/' });
        await p.waitForTimeout(2500);
        await p.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
      } catch {} finally { await p.close().catch(() => {}); }
    },
    async result() {
      await Promise.race([Promise.allSettled(bodies), new Promise((r) => setTimeout(r, 4000))]);
      const rs = [...redirects.values()];
      for (const r of rs) r.screenshot = r.screenshot ? await r.screenshot : null;
      return { storeHost, redirects: rs, frames: [...frames.values()], mining: [...mining.values()], pages: scanned.size };
    },
  };
}

const PAGE = { home: 'home page', product: 'product page', cart: 'cart page', other: 'store' };

/** Adds the three checks from what was recorded. */
export function hijackChecks({ rec, found }) {
  const { redirects, frames, mining } = found;
  const r0 = redirects[0];
  rec.add(redirects.length
    ? check('sec.redirect', 'security', 'Shoppers stay on your store', 'fail', {
      severity: 'critical',
      detail: `Your ${PAGE[r0.page]} sent ${r0.device === 'phone' ? 'a phone shopper arriving from Google' : 'our shopper'} to another website: ${r0.to}${redirects.length > 1 ? ` (and ${plural(redirects.length - 1, 'other address', 'other addresses')}: ${redirects.slice(1, 4).map((r) => r.host).join(', ')})` : ''}. Hacked stores do this to send shoppers to scam pages, often only on phones so the owner doesn't notice.`,
      fix: 'Look for code you did not add in Online Store → Themes → Edit code (theme.liquid first) and in recently installed apps, and remove it. Then change your Shopify password, turn on two-step login, and check your staff accounts.',
      evidence: { screenshot: r0.screenshot, redirects: redirects.map(({ from, to, page, device }) => ({ from, to, page, device })) },
    })
    : check('sec.redirect', 'security', 'Shoppers stay on your store', 'pass', { severity: 'critical', detail: 'No page sent shoppers to another website, including a phone shopper arriving from Google.' }));

  const bad = frames.filter((f) => f.bad);
  const fl = (list) => list.slice(0, 4).map((f) => `${f.src} (${PAGE[f.page]}, ${f.how})`).join('; ');
  rec.add(frames.length
    ? check('sec.frames', 'security', 'No hidden pages from other websites', 'fail', {
      severity: bad.length ? 'critical' : 'major',
      detail: bad.length
        ? `Your store loads a hidden page from a site known for stealing card details or mining: ${fl(bad)}.`
        : `Your store loads ${plural(frames.length, 'hidden page')} from another website that shoppers can't see: ${fl(frames)}${frames.length > 4 ? ', and more' : ''}. Hackers use hidden pages to run code on your shoppers' devices. Some apps use them too.`,
      fix: bad.length
        ? 'Remove it now: find it in Online Store → Themes → Edit code (search for the address) or in your apps. Then change your Shopify password and check your staff accounts.'
        : 'If you know the app that adds it, there is nothing to do. If you don’t, search for the address in Online Store → Themes → Edit code and remove it.',
      evidence: { frames: frames.map(({ src, page, how }) => ({ src, page, how })) },
    })
    : check('sec.frames', 'security', 'No hidden pages from other websites', 'pass', { severity: 'major', detail: 'No hidden pages from unknown websites on your home, product and cart pages.' }));

  const where = (m) => `${m.where} (${PAGE[m.page]})`;
  rec.add(mining.length
    ? check('sec.mining', 'security', 'No cryptocurrency mining', 'fail', {
      severity: 'critical',
      detail: `Your store makes shoppers' devices mine cryptocurrency for someone else. This slows phones down and drains batteries. Found: ${mining.slice(0, 4).map((m) => `${m.signal}: ${where(m)}`).join('; ')}.`,
      fix: 'Remove the code now: search for it in Online Store → Themes → Edit code and check recently installed apps. Then change your Shopify password and check your staff accounts.',
      evidence: { signals: mining },
    })
    : check('sec.mining', 'security', 'No cryptocurrency mining', 'pass', { severity: 'critical', detail: 'No mining code, mining programs or connections to mining pools.' }));
  return found;
}
