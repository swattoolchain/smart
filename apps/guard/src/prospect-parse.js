/**
 * Prospect list helpers that need no database: domain clean-up, list reading, public contact details,
 * ICP score and the plain-words risk score. Used by src/prospect-list.js (founder console → Prospects).
 */

export const MAX_IMPORT_ROWS = 100000;
export const STATUSES = ['new', 'drafted', 'contacted', 'replied', 'opted_out', 'do_not_contact'];
export const STATUS_LABEL = { new: 'New', drafted: 'Drafted', contacted: 'Contacted', replied: 'Replied', opted_out: 'Opted out', do_not_contact: 'Do not contact' };
/** Statuses that are final: the store is never contacted or re-added. */
export const NEVER_CONTACT = ['opted_out', 'do_not_contact'];

const LABELS = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;
const isLocalHost = (h) => process.env.ALLOW_LOCAL_TARGETS === '1' && (h === 'localhost' || h === '127.0.0.1');

/**
 * One form for every way of writing a store address: lowercase, no scheme, no "www.", no path, no port
 * (local test stores keep theirs), no trailing dot. Returns null when it is not a usable domain.
 */
export function normalizeDomain(raw) {
  let s = String(raw ?? '').trim().toLowerCase().replace(/^["'<(]+|["'>),;]+$/g, '');
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^[^@/?#]*@/, '');
  s = s.split(/[/?#\s]/)[0];
  let host = s, port = '';
  const m = /^(.*):(\d{1,5})$/.exec(s);
  if (m) { host = m[1]; port = m[2]; }
  host = host.replace(/\.+$/, '').replace(/^(www\.)+/, '');
  if (isLocalHost(host)) return port ? `${host}:${port}` : host;
  if (host.length > 253 || !LABELS.test(host)) return null;
  return host;
}

/** The address to visit for a stored domain. */
export const originOf = (domain) => `${isLocalHost(String(domain).split(':')[0]) ? 'http' : 'https'}://${domain}`;

const HEADERS = ['domain', 'domains', 'url', 'store', 'store_url', 'website', 'shop', 'hostname', 'host'];

/**
 * Reads domains from pasted text or a CSV/TXT file. With a header row (domain, url, store, website…) that column
 * is used; otherwise every word that looks like an address is taken (email addresses are not). Returns the
 * cleaned domains in order (duplicates kept: the database decides what is new) and whether the list was cut.
 */
export function parseList(text, { max = MAX_IMPORT_ROWS } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const cells = (l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
  const first = lines.find((l) => l.trim());
  let col = -1;
  let skipFirst = false;
  if (first) { col = cells(first).findIndex((h) => HEADERS.includes(h.toLowerCase())); skipFirst = col >= 0; }
  const out = [];
  let invalid = 0, truncated = false, seenFirst = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (skipFirst && !seenFirst) { seenFirst = true; continue; }
    seenFirst = true;
    const words = col >= 0 ? [cells(line)[col] || ''] : line.split(/[\s,;\t]+/).filter(Boolean);
    for (const w of words) {
      if (w.includes('@') && !/^https?:\/\//i.test(w)) continue;
      const d = normalizeDomain(w);
      if (col < 0 && !/[a-z0-9]\.[a-z0-9]/i.test(w) && !(d && isLocalHost(d.split(':')[0]))) continue;
      if (!d) { invalid++; continue; }
      if (out.length >= max) { truncated = true; break; }
      out.push(d);
    }
    if (truncated) break;
  }
  return { domains: out, invalid, truncated };
}

// ---------- country ----------
const EU = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' '));
const NAMES = { india: 'IN', 'united states': 'US', usa: 'US', 'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', england: 'GB', australia: 'AU', canada: 'CA', germany: 'DE', france: 'FR', netherlands: 'NL', spain: 'ES', italy: 'IT', ireland: 'IE', singapore: 'SG', 'united arab emirates': 'AE', 'new zealand': 'NZ' };
/** Two-letter country code from what a store publishes ("IN", "India"); '' when unknown. */
export function countryCode(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return NAMES[s.toLowerCase()] || '';
}
export const inEU = (code) => EU.has(code);

/** How well a store fits who Tharam is for (0 to 100): India first, then US, UK and Australia. */
export function icpScore({ country, products, shopify, email }) {
  let n = shopify ? 25 : 0;
  n += country === 'IN' ? 50 : ['US', 'GB', 'AU'].includes(country) ? 40 : country ? 15 : 10;
  n += products >= 10 ? 15 : products >= 1 ? 5 : 0;
  if (email) n += 10;
  return Math.min(100, n);
}

// ---------- public contact details ----------
const ROLE = /^(info|support|hello|hi|contact|care|help|sales|orders|order|shop|store|team|customercare|customer\.?care|customerservice|service|enquiries|enquiry|query|admin|mail|office)$/;
const FREE_MAIL = /(^|\.)(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|aol|proton|protonmail|rediffmail)\./;

/** True for an address that is the store's own: on its domain, or a shared role address like support@. */
export function storeOwnEmail(email, domain, myshopify = '') {
  const e = String(email || '').trim().toLowerCase();
  const m = /^([a-z0-9._%+-]+)@([a-z0-9.-]+\.[a-z]{2,})$/.exec(e);
  if (!m || /\.(png|jpe?g|gif|webp|svg|css|js)$/.test(m[2])) return false;
  const root = String(domain || '').split(':')[0].replace(/^www\./, '');
  const own = (root && (m[2] === root || m[2].endsWith('.' + root))) || (myshopify && m[2] === myshopify);
  if (own) return true;
  return ROLE.test(m[1]) && !FREE_MAIL.test(m[2] + '.');
}

/** The store's public email and phone from one of its own pages. Nothing is guessed. */
export function findContacts(html, domain, myshopify = '') {
  const page = String(html || '');
  const text = page.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  const emails = [];
  for (const m of text.matchAll(/mailto:([^"'?\s>]+)/gi)) { try { emails.push(decodeURIComponent(m[1])); } catch { emails.push(m[1]); } }
  for (const m of text.replace(/<[^>]+>/g, ' ').matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) emails.push(m[0]);
  const email = emails.find((e) => storeOwnEmail(e, domain, myshopify)) || '';
  let phone = '';
  const tel = /href=["']tel:([^"']+)["']/i.exec(text);
  const cand = tel ? decodeURIComponent(tel[1]) : (/(\+\d[\d\s().-]{8,16}\d)/.exec(text.replace(/<[^>]+>/g, ' ')) || [])[1] || '';
  const digits = cand.replace(/[^\d+]/g, '');
  const n = digits.replace(/\D/g, '').length;
  if (n >= 9 && n <= 15) phone = digits;
  return { email: email.toLowerCase(), phone };
}

// ---------- the finding, in plain words ----------
const WEIGHTS = [
  [/did not load|did not open|Could not reach/i, 100], [/Add to cart does nothing/i, 90], [/Checkout did not open|sends shoppers back/i, 85],
  [/No Add to cart|greyed out/i, 75], [/price of zero/i, 60], [/another website/i, 60], [/product page did not load/i, 50], [/slow on phones/i, 30], [/password protected/i, 5],
];
const weightOf = (text) => (WEIGHTS.find(([re]) => re.test(text)) || [0, 40])[1];

/**
 * The main finding of a light check and how much buying is at risk (0 to 100). The words are the checker's
 * own plain-language findings; the biggest problem comes first.
 */
export function riskOf(check) {
  const list = [...(check?.findings || [])].filter((f) => f && f !== 'Not a Shopify store');
  if (!list.length) return { finding: '', score: 0, findings: [] };
  const sorted = list.sort((a, b) => weightOf(b) - weightOf(a));
  const top = weightOf(sorted[0]);
  return { finding: sorted[0], score: Math.min(100, top + 5 * (sorted.length - 1)), findings: sorted };
}

// ---------- export ----------
const COLS = ['domain', 'status', 'country', 'city', 'store_name', 'products', 'email', 'phone', 'icp', 'score', 'finding', 'source', 'checked_at'];
// Store names and findings come from other websites: a cell that starts like a formula is made harmless in spreadsheets.
const cell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const prospectsCsv = (rows) => [COLS.join(','), ...rows.map((r) => COLS.map((c) => cell(r[c])).join(','))].join('\n') + '\n';

