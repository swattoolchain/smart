/**
 * Security watch S8: the store's domain, its security certificate, and its domain and email records.
 *
 * - sec.domain.cert   the padlock certificate is valid and not about to run out
 * - sec.domain.expiry the domain name's registration is not about to run out (public RDAP data)
 * - sec.domain.dns    address, name server, mail server, SPF and DMARC records unchanged since the last check
 *                     (a notice: told once, never "recovered")
 * - sec.domain.email  SPF and DMARC exist, so others can't easily send email as the store
 *
 * Shopify's own address (*.myshopify.com) is looked after by Shopify, so stores without their own domain
 * are skipped. Lookups go through `lookups()`; tests point FAKE_DOMAIN_DATA at a JSON file instead of the
 * internet (never in production).
 */
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import net from 'node:net';
import { Resolver } from 'node:dns/promises';
import { config } from '../config.js';
import { check, shortErr } from './checks.js';

export const CERT_FAIL_DAYS = 14; // certificate: alert two weeks ahead
export const CERT_WARN_DAYS = 30;
export const DOMAIN_FAIL_DAYS = 30; // domain registration: alert a month ahead (renewals can take days)
export const DOMAIN_WARN_DAYS = 60;

const DAY = 24 * 3600 * 1000;
const SHOPIFY_IPS = /^23\.227\.38\.\d+$/;
const SHOPIFY_CNAME = /(^|\.)myshopify\.com$|(^|\.)shopify\.com$/;

// Two-part public suffixes common for stores; enough to find the registered name without a full list.
const TWO_PART = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in',
  'co.nz', 'org.nz', 'com.sg', 'com.my', 'co.za', 'com.br', 'com.mx', 'com.ar', 'co.jp', 'ne.jp', 'or.jp', 'com.cn', 'com.hk', 'com.tw',
  'co.kr', 'com.tr', 'co.il', 'com.pk', 'com.bd', 'com.ng', 'co.ke', 'com.ph', 'co.id', 'co.th', 'com.vn', 'com.eg', 'com.sa', 'ae.org',
]);

/** "shop.example.co.uk" → "example.co.uk". null for addresses that have no registered name (IPs, localhost). */
export function registeredDomain(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!host || net.isIP(host) || !host.includes('.')) return null;
  const parts = host.split('.');
  const two = parts.slice(-2).join('.');
  return parts.length >= 3 && TWO_PART.has(two) ? parts.slice(-3).join('.') : two;
}

export const isShopifyHost = (host) => /\.myshopify\.com$/i.test(host || '');

// ---------- lookups (real internet, or a test file) ----------

const empty = (e) => ['ENODATA', 'ENOTFOUND', 'ENONAME', 'NOTFOUND', 'NODATA'].includes(e?.code);

function realLookups() {
  const r = new Resolver({ timeout: 5000, tries: 2 });
  const q = async (fn) => { try { return await fn(); } catch (e) { if (empty(e)) return []; throw e; } };
  return {
    async dns(name, type) {
      if (type === 'A') return q(() => r.resolve4(name));
      if (type === 'AAAA') return q(() => r.resolve6(name));
      if (type === 'CNAME') return q(() => r.resolveCname(name));
      if (type === 'NS') return q(() => r.resolveNs(name));
      if (type === 'MX') return (await q(() => r.resolveMx(name))).map((m) => `${m.priority} ${m.exchange}`);
      if (type === 'TXT') return (await q(() => r.resolveTxt(name))).map((chunks) => chunks.join(''));
      return [];
    },
    cert(host) {
      return new Promise((resolve, reject) => {
        const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 10000 }, () => {
          const c = sock.getPeerCertificate();
          const out = c && c.valid_to ? { validTo: new Date(c.valid_to).toISOString(), issuer: c.issuer?.O || c.issuer?.CN || '', trusted: sock.authorized, error: sock.authorized ? '' : String(sock.authorizationError || '') } : null;
          sock.end();
          resolve(out);
        });
        sock.on('timeout', () => { sock.destroy(); reject(new Error('timed out')); });
        sock.on('error', reject);
      });
    },
    async rdap(domain) {
      const base = (process.env.RDAP_BASE || 'https://rdap.org').replace(/\/$/, '');
      const res = await fetch(`${base}/domain/${encodeURIComponent(domain)}`, { headers: { accept: 'application/rdap+json' }, signal: AbortSignal.timeout(10000) });
      if (res.status === 404) return { expires: null, known: false };
      if (!res.ok) throw new Error(`registry answered ${res.status}`);
      const j = await res.json();
      const ev = (j.events || []).find((e) => /expiration/i.test(e.eventAction || ''));
      return { expires: ev?.eventDate ? new Date(ev.eventDate).toISOString() : null, known: true, registrar: registrarOf(j) };
    },
  };
}

function registrarOf(j) {
  const ent = (j.entities || []).find((e) => (e.roles || []).includes('registrar'));
  const fn = ent?.vcardArray?.[1]?.find((x) => x[0] === 'fn');
  return fn ? String(fn[3]) : '';
}

/**
 * Test stand-in: a JSON file read on every lookup, so a test can change the "internet" between checks.
 * { host, dns: { name: { A: [], CNAME: [], NS: [], MX: [], TXT: [] } }, certs: { host: { validTo, issuer, trusted } },
 *   rdap: { domain: { expires } }, down: ['dns' | 'cert' | 'rdap'] }
 */
function fakeLookups(file) {
  const data = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const down = (k) => { if ((data().down || []).includes(k)) throw Object.assign(new Error('lookup timed out'), { code: 'ETIMEOUT' }); };
  return {
    host: () => data().host || null,
    async dns(name, type) { down('dns'); return data().dns?.[name]?.[type] || []; },
    async cert(host) { down('cert'); return data().certs?.[host] || null; },
    async rdap(domain) { down('rdap'); const d = data().rdap?.[domain]; return d ? { known: true, expires: d.expires || null, registrar: d.registrar || '' } : { known: false, expires: null }; },
  };
}

export function lookups() {
  const file = process.env.FAKE_DOMAIN_DATA;
  if (file && process.env.NODE_ENV !== 'production') return fakeLookups(file);
  return realLookups();
}

// ---------- records ----------

const norm = (s) => String(s).trim().toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' ');
const uniqSorted = (a) => [...new Set((a || []).map(norm))].sort();

/** The records we watch for a store address. Throws if the name servers couldn't be asked. */
export async function readRecords(host, L = lookups()) {
  const apex = registeredDomain(host);
  const [a, aaaa, cname, ns, mx, txt, dmarc] = await Promise.all([
    L.dns(host, 'A'), L.dns(host, 'AAAA'), L.dns(host, 'CNAME'),
    L.dns(apex, 'NS'), L.dns(apex, 'MX'), L.dns(apex, 'TXT'), L.dns(`_dmarc.${apex}`, 'TXT'),
  ]);
  const spf = (txt || []).filter((t) => /^v=spf1\b/i.test(String(t).trim())).map(norm);
  const dm = (dmarc || []).filter((t) => /^v=dmarc1\b/i.test(String(t).trim())).map(norm);
  return { host, apex, address: uniqSorted([...(a || []), ...(aaaa || [])]), cname: uniqSorted(cname), ns: uniqSorted(ns), mx: uniqSorted(mx), spf, dmarc: dm };
}

const policyOf = (dmarc) => (/(?:^|;)\s*p\s*=\s*(\w+)/i.exec(dmarc?.[0] || '') || [])[1]?.toLowerCase() || null;
const STRENGTH = { reject: 3, quarantine: 2, none: 1 };
const onShopify = (r) => r.cname.some((c) => SHOPIFY_CNAME.test(c)) || r.address.some((x) => SHOPIFY_IPS.test(x));
const list = (a) => (a && a.length ? a.join(', ') : 'none');

/**
 * What changed between two record sets, in words a store owner understands.
 * Each change: { what, before, after, serious }.
 */
export function compareRecords(now, prev) {
  if (!prev || prev.host !== now.host) return [];
  const out = [];
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  // The store's address: CNAME is what counts when there is one; plain addresses may rotate, so only
  // a complete switch (no address in common) is reported.
  const wasShopify = onShopify(prev), isShopify = onShopify(now);
  if (wasShopify && !isShopify) {
    out.push({ what: 'Your store address no longer points to Shopify', before: list(prev.cname.length ? prev.cname : prev.address), after: list(now.cname.length ? now.cname : now.address), serious: true });
  } else if (!same(prev.cname, now.cname) && (prev.cname.length || now.cname.length)) {
    out.push({ what: 'Where your store address points changed', before: list(prev.cname), after: list(now.cname), serious: !isShopify });
  } else if (!now.cname.length && prev.address.length && now.address.length && !now.address.some((x) => prev.address.includes(x)) && !(wasShopify && isShopify)) {
    out.push({ what: 'The server behind your store address changed', before: list(prev.address), after: list(now.address), serious: true });
  }
  if (!same(prev.ns, now.ns) && prev.ns.length) out.push({ what: 'Your domain moved to different name servers (whoever runs these controls your domain)', before: list(prev.ns), after: list(now.ns), serious: true });
  if (!same(prev.mx, now.mx)) out.push({ what: 'Where email to your domain is delivered changed', before: list(prev.mx), after: list(now.mx), serious: true });
  if (!same(prev.spf, now.spf)) out.push({ what: 'Who may send email as your domain (SPF) changed', before: list(prev.spf), after: list(now.spf), serious: /[+?]all\b/.test(now.spf.join(' ')) });
  if (!same(prev.dmarc, now.dmarc)) {
    const weaker = (STRENGTH[policyOf(now.dmarc)] || 0) < (STRENGTH[policyOf(prev.dmarc)] || 0);
    out.push({ what: weaker ? 'Protection against fake emails from your domain (DMARC) was weakened' : 'Your DMARC email record changed', before: list(prev.dmarc), after: list(now.dmarc), serious: weaker });
  }
  return out;
}

/** Plain-language problems with the email records themselves (not changes). */
export function emailProblems(r) {
  const out = [];
  if (!r.spf.length) out.push('No SPF record: nothing tells mailboxes which servers may send email as your domain.');
  else if (r.spf.length > 1) out.push(`${r.spf.length} SPF records: mailboxes ignore all of them when there is more than one.`);
  else if (/\+all\b/.test(r.spf[0])) out.push('Your SPF record ends in "+all", which lets anyone send email as your domain.');
  if (!r.dmarc.length) out.push('No DMARC record: fake emails using your domain are not blocked or reported.');
  return out;
}

// ---------- the check ----------

const daysLeft = (iso, now) => Math.floor((new Date(iso).getTime() - now) / DAY);
const day = (iso) => new Date(iso).toISOString().slice(0, 10);

export function snapshotFile(storeId) {
  return path.join(config.dataDir, 'domain', `store-${storeId}.json`);
}

function readSnapshot(storeId) {
  try { return JSON.parse(fs.readFileSync(snapshotFile(storeId), 'utf8')); } catch { return null; }
}

function saveSnapshot(storeId, data) {
  const f = snapshotFile(storeId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 1));
}

/** The address shoppers end up on: Shopify stores usually move from *.myshopify.com to their own domain. */
async function shopperHost(request, origin) {
  try {
    const res = await request.get(origin + '/', { timeout: 15000 });
    return new URL(res.url()).hostname;
  } catch {
    return new URL(origin).hostname;
  }
}

export async function runDomain({ rec, request, origin, storeId, on = () => true, now = Date.now(), L = lookups() }) {
  let host = L.host?.() || (await shopperHost(request, origin));
  host = String(host).toLowerCase();
  const ids = ['sec.domain.cert', 'sec.domain.expiry', 'sec.domain.dns', 'sec.domain.email'];
  if (isShopifyHost(host) || !registeredDomain(host)) {
    // Nothing to watch: Shopify renews its own address and certificate.
    const detail = isShopifyHost(host)
      ? `Your store uses its Shopify address (${host}). Shopify looks after that domain and its certificate.`
      : `Your store address (${host}) has no domain name to watch.`;
    for (const id of ids) rec.add(check(id, 'security', TITLES[id], 'skip', { severity: 'minor', detail }));
    return null;
  }
  const apex = registeredDomain(host);
  const snap = readSnapshot(storeId) || {};

  // 1. Certificate (the padlock).
  try {
    const c = await L.cert(host);
    if (!c?.validTo) {
      rec.add(check('sec.domain.cert', 'security', TITLES['sec.domain.cert'], 'fail', { severity: 'major', detail: `${host} did not show a security certificate. Shoppers see a "Not secure" warning.`, fix: 'In Shopify admin open Settings → Domains and check your domain shows as connected with SSL. If not, follow Shopify\'s steps to reconnect it.' }));
    } else {
      const left = daysLeft(c.validTo, now);
      const ev = { host, validTo: c.validTo, issuer: c.issuer || '', daysLeft: left };
      const fix = 'Shopify renews certificates by itself while your domain points to Shopify. In Shopify admin open Settings → Domains: if the domain shows an error or "SSL pending", fix its records with your domain provider as Shopify describes.';
      if (left < 0) rec.add(check('sec.domain.cert', 'security', TITLES['sec.domain.cert'], 'fail', { severity: 'major', detail: `The security certificate for ${host} ran out on ${day(c.validTo)}. Browsers warn shoppers that your store is not safe.`, evidence: ev, fix }));
      else if (c.trusted === false) rec.add(check('sec.domain.cert', 'security', TITLES['sec.domain.cert'], 'fail', { severity: 'major', detail: `Browsers don't trust the security certificate for ${host}${c.error ? ` (${c.error})` : ''}. Shoppers see a warning.`, evidence: ev, fix }));
      else if (left <= CERT_FAIL_DAYS) rec.add(check('sec.domain.cert', 'security', TITLES['sec.domain.cert'], 'fail', { severity: 'major', detail: `The security certificate for ${host} runs out in ${left} day${left === 1 ? '' : 's'} (${day(c.validTo)}) and has not been renewed yet.`, evidence: ev, fix }));
      else if (left <= CERT_WARN_DAYS) rec.add(check('sec.domain.cert', 'security', TITLES['sec.domain.cert'], 'warn', { severity: 'minor', detail: `The security certificate for ${host} runs out on ${day(c.validTo)} (${left} days). It is usually renewed automatically about a month before; we'll tell you if it isn't.`, evidence: ev }));
      else rec.add(check('sec.domain.cert', 'security', TITLES['sec.domain.cert'], 'pass', { severity: 'minor', detail: `Valid until ${day(c.validTo)} (${left} days)${c.issuer ? `, issued by ${c.issuer}` : ''}.`, evidence: ev }));
    }
  } catch (e) {
    rec.add(check('sec.domain.cert', 'security', TITLES['sec.domain.cert'], 'skip', { severity: 'minor', detail: `We couldn't read the certificate for ${host} this time (${shortErr(e)}). We'll try again on the next full check.` }));
  }

  // 2. Domain registration.
  try {
    const d = await L.rdap(apex);
    if (!d.expires) {
      rec.add(check('sec.domain.expiry', 'security', TITLES['sec.domain.expiry'], 'skip', { severity: 'minor', detail: `The registry for ${apex} doesn't publish renewal dates, so we can't watch them. Check auto-renew is on where you bought the domain.` }));
    } else {
      const left = daysLeft(d.expires, now);
      const ev = { domain: apex, expires: d.expires, daysLeft: left, registrar: d.registrar || '' };
      const where = d.registrar ? ` at ${d.registrar}` : ' where you bought it';
      const fix = `Sign in${where}, renew ${apex} and turn on auto-renew. Check the card on file is still valid.`;
      if (left < 0) rec.add(check('sec.domain.expiry', 'security', TITLES['sec.domain.expiry'], 'fail', { severity: 'major', detail: `Your domain ${apex} ran out on ${day(d.expires)}. Unless it is renewed, your store and email stop working at that address and someone else can buy it.`, evidence: ev, fix }));
      else if (left <= DOMAIN_FAIL_DAYS) rec.add(check('sec.domain.expiry', 'security', TITLES['sec.domain.expiry'], 'fail', { severity: 'major', detail: `Your domain ${apex} runs out in ${left} day${left === 1 ? '' : 's'} (${day(d.expires)}). If it lapses, your store and email stop working at that address.`, evidence: ev, fix }));
      else if (left <= DOMAIN_WARN_DAYS) rec.add(check('sec.domain.expiry', 'security', TITLES['sec.domain.expiry'], 'warn', { severity: 'minor', detail: `Your domain ${apex} runs out on ${day(d.expires)} (${left} days). Make sure auto-renew is on.`, evidence: ev, fix }));
      else rec.add(check('sec.domain.expiry', 'security', TITLES['sec.domain.expiry'], 'pass', { severity: 'minor', detail: `${apex} is registered until ${day(d.expires)} (${left} days).`, evidence: ev }));
    }
  } catch (e) {
    rec.add(check('sec.domain.expiry', 'security', TITLES['sec.domain.expiry'], 'skip', { severity: 'minor', detail: `We couldn't ask the registry about ${apex} this time (${shortErr(e)}).` }));
  }

  // 3 and 4. Records.
  let records = null;
  try { records = await readRecords(host, L); } catch (e) {
    const detail = `We couldn't read the records for ${apex} this time (${shortErr(e)}). We'll compare them on the next full check.`;
    rec.add(check('sec.domain.dns', 'security', TITLES['sec.domain.dns'], 'skip', { severity: 'minor', detail }));
    rec.add(check('sec.domain.email', 'security', TITLES['sec.domain.email'], 'skip', { severity: 'minor', detail }));
  }
  if (records) {
    const prev = snap.records && snap.records.host === host ? snap.records : null;
    const changes = compareRecords(records, prev);
    const seriousOnes = changes.filter((c) => c.serious);
    const ev = { host, apex, records, changes };
    const notice = (c) => Object.assign(c, { notice: true });
    if (!prev) rec.add(notice(check('sec.domain.dns', 'security', TITLES['sec.domain.dns'], 'pass', { severity: 'minor', detail: `Saved the records for ${apex} (store address, name servers, mail servers, SPF and DMARC). From the next full check we'll tell you when any of them change.`, evidence: ev })));
    else if (!changes.length) rec.add(notice(check('sec.domain.dns', 'security', TITLES['sec.domain.dns'], 'pass', { severity: 'minor', detail: `No changes to the records for ${apex} since the last check.`, evidence: ev })));
    else {
      const words = changes.map((c) => `${c.what}: ${c.before} → ${c.after}.`).join(' ');
      rec.add(notice(check('sec.domain.dns', 'security', TITLES['sec.domain.dns'], seriousOnes.length ? 'fail' : 'warn', {
        severity: seriousOnes.length ? 'major' : 'minor',
        detail: `Records for ${apex} changed since the last check. ${words}`,
        evidence: ev,
        fix: 'If you or your developer made this change, there is nothing to do. If not, sign in where you bought your domain now, change the password, turn on two-step login and put back the old records (the ones before the arrow).',
      })));
    }
    const probs = emailProblems(records);
    const seriousEmail = probs.some((p) => /\+all/.test(p));
    if (!probs.length) rec.add(check('sec.domain.email', 'security', TITLES['sec.domain.email'], 'pass', { severity: 'minor', detail: `${apex} has SPF and a DMARC policy (${policyOf(records.dmarc) || 'set'}).` }));
    else rec.add(check('sec.domain.email', 'security', TITLES['sec.domain.email'], seriousEmail ? 'fail' : 'warn', {
      severity: seriousEmail ? 'major' : 'minor',
      detail: probs.join(' ') + ' Fake order or payment emails "from your store" are an easy way to trick your customers.',
      fix: `With your email provider's help, add one SPF record listing the services that send your email (Shopify, your mailbox, newsletters) ending in "~all" or "-all", and a DMARC record at _dmarc.${apex} such as "v=DMARC1; p=quarantine".`,
    }));
    saveSnapshot(storeId, { at: new Date(now).toISOString(), records });
  }
  return { host, apex };
}

export const TITLES = {
  'sec.domain.cert': 'Security certificate (padlock) is valid',
  'sec.domain.expiry': 'Domain name stays registered',
  'sec.domain.dns': 'Domain and email records unchanged',
  'sec.domain.email': 'Email records protect your domain',
};
