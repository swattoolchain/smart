/**
 * Prospects (founder console → Prospects, behind the 'prospects' switch; founders only, never customers).
 *
 * A list of public Shopify stores worth helping. Import domains (each stored once, ever), read each store's public
 * details one store at a time and politely, run the light prospect check (src/prospect.js) and keep the top finding.
 * It runs on the Tharam server, which can reach stores. Nothing is ever sent to a store from here.
 *
 * Politeness (hard limits): TharamStoreGuard user agent, robots.txt obeyed, one visit per page, at most one request
 * a second per store, one store at a time, only when no customer check is running, and a daily cap
 * (PROSPECT_CHECKS_PER_DAY, default 300) so customer checks are never slowed.
 */
import crypto from 'node:crypto';
import express from 'express';
import { chromium } from 'playwright';
import { db, ensureColumn } from './db.js';
import { config } from './config.js';
import { audit } from './license.js';
import { sendMail } from './alerts.js';
import { isOn, requireFeature } from './features.js';
import { queueDepth } from './queue.js';
import { checkStore, parseRobots, robotsAllows, MAX_CRAWL_DELAY_MS } from './prospect.js';
import { assertPublicTarget } from './engine/browser.js';
import {
  normalizeDomain, originOf, parseList, prospectsCsv, countryCode, inEU, icpScore, findContacts, riskOf, STATUSES, STATUS_LABEL, NEVER_CONTACT,
} from './prospect-parse.js';

export const ENRICH_UA = 'TharamStoreGuard/1.0 (+https://tharam.store/bot)';
/** At most one request a second to any one store. Not configurable below this. */
export const MIN_GAP_MS = 1000;

db.exec(`CREATE TABLE IF NOT EXISTS prospects (
  domain TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'new',
  state TEXT NOT NULL DEFAULT 'queued',
  source TEXT NOT NULL DEFAULT '',
  shopify INTEGER,
  store_name TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  products INTEGER,
  myshopify TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  icp INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  finding TEXT NOT NULL DEFAULT '',
  findings_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  checked_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS prospects_state ON prospects(state);
CREATE TABLE IF NOT EXISTS prospect_blocked (
  domain TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS prospect_notice (key TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS prospect_daily (day TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);`);
// AI batch step (src/prospect-ai.js). ai_classified_at is set once per row and never cleared.
for (const [c, t] of [['ai_classified_at', 'TEXT'], ['ai_icp', 'INTEGER'], ['ai_fit', 'INTEGER'], ['ai_summary', "TEXT NOT NULL DEFAULT ''"],
  ['ai_search_terms', "TEXT NOT NULL DEFAULT '[]'"], ['draft_opener', "TEXT NOT NULL DEFAULT ''"], ['ai_batch_id', "TEXT NOT NULL DEFAULT ''"], ['ai_attempts', 'INTEGER NOT NULL DEFAULT 0']]) ensureColumn('prospects', c, t);

// Stores that were contacted, answered or asked not to be contacted are never read or checked again.
const LEFT_ALONE = "'contacted', 'replied', 'opted_out', 'do_not_contact'";
const S = {
  insert: db.prepare('INSERT OR IGNORE INTO prospects (domain, source) VALUES (?, ?)'),
  blocked: db.prepare('SELECT 1 FROM prospect_blocked WHERE domain = ?'),
  block: db.prepare('INSERT OR IGNORE INTO prospect_blocked (domain, reason) VALUES (?, ?)'),
  get: db.prepare('SELECT * FROM prospects WHERE domain = ?'),
  next: db.prepare(`SELECT domain FROM prospects WHERE state = 'queued' AND status NOT IN (${LEFT_ALONE}) ORDER BY rowid LIMIT 1`),
  waiting: db.prepare(`SELECT COUNT(*) AS n FROM prospects WHERE state = 'queued' AND status NOT IN (${LEFT_ALONE})`),
  noticed: db.prepare("SELECT 1 FROM prospect_notice WHERE key = 'idle'"),
  notice: db.prepare("INSERT OR IGNORE INTO prospect_notice (key) VALUES ('idle')"),
  wake: db.prepare("DELETE FROM prospect_notice WHERE key = 'idle'"),
  day: db.prepare('SELECT n FROM prospect_daily WHERE day = ?'),
  bump: db.prepare("INSERT INTO prospect_daily (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1"),
};
const today = () => new Date().toISOString().slice(0, 10);
export const dailyCap = () => { const n = Number(process.env.PROSPECT_CHECKS_PER_DAY); return Number.isInteger(n) && n >= 0 ? n : 300; };
export const dailyUsed = () => S.day.get(today())?.n || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- import ----------
/** Adds domains. A domain is stored once ever: known ones (any status) and blocked ones are never added again. */
export function importDomains(text, { source = 'import', actor = '' } = {}) {
  const { domains, invalid, truncated } = parseList(text);
  let added = 0, already = 0, blocked = 0;
  db.exec('BEGIN');
  try {
    for (const d of domains) {
      if (S.blocked.get(d)) { blocked++; continue; }
      if (S.insert.run(d, String(source).slice(0, 80)).changes) added++; else already++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (added) S.wake.run(); // new work: the idle message and the one-time email start over
  if (actor) audit(actor, null, 'prospects.import', { added, already, blocked, invalid, source });
  return { total: domains.length, added, already, blocked, invalid, truncated };
}

/** Never contact these domains, whether or not they are in the list yet. */
export function blockDomains(text, reason = 'do_not_contact', actor = '') {
  const { domains } = parseList(text);
  let n = 0;
  for (const d of new Set(domains)) {
    S.block.run(d, reason);
    db.prepare("UPDATE prospects SET status = ?, updated_at = datetime('now') WHERE domain = ? AND status NOT IN ('opted_out', 'do_not_contact')").run(reason, d);
    n++;
  }
  if (actor) audit(actor, null, 'prospects.block', { count: n, reason });
  return { blocked: n };
}

/** Reads one store again (a founder's choice). Never for a store that was contacted, answered or asked to be left alone. */
export function checkAgain(domain, actor = '') {
  const row = S.get.get(domain);
  if (!row) throw Object.assign(new Error('Store not found'), { code: 404 });
  if (['contacted', 'replied', ...NEVER_CONTACT].includes(row.status)) throw new Error(`This store is marked "${STATUS_LABEL[row.status]}", so it is not checked again.`);
  db.prepare("UPDATE prospects SET state = 'queued', updated_at = datetime('now') WHERE domain = ?").run(domain);
  S.wake.run();
  if (actor) audit(actor, null, 'prospects.check_again', { domain });
}

export function setStatus(domain, status, actor = '') {
  const row = S.get.get(domain);
  if (!row) throw Object.assign(new Error('Store not found'), { code: 404 });
  if (!STATUSES.includes(status)) throw new Error('Choose one of: ' + STATUSES.map((s) => STATUS_LABEL[s]).join(', '));
  if (NEVER_CONTACT.includes(row.status) && row.status !== status) throw new Error('This store asked not to be contacted. It stays that way.');
  db.prepare("UPDATE prospects SET status = ?, updated_at = datetime('now') WHERE domain = ?").run(status, domain);
  if (NEVER_CONTACT.includes(status)) S.block.run(domain, status);
  if (actor) audit(actor, null, 'prospects.status', { domain, before: row.status, after: status });
}

// ---------- list, filters and export ----------
const like = (s) => '%' + String(s).replace(/[\\%_]/g, '\\$&') + '%';
function where(f = {}) {
  const w = ['1=1'], a = [];
  if (f.country) { w.push('country = ?'); a.push(String(f.country).toUpperCase().slice(0, 2)); }
  if (f.min_products !== undefined && f.min_products !== '' && Number.isFinite(Number(f.min_products))) { w.push('products >= ?'); a.push(Number(f.min_products)); }
  if (f.has_email === '1') w.push("email != ''");
  else if (f.has_email === '0') w.push("email = ''");
  if (f.finding === 'any') w.push("finding != ''");
  else if (f.finding === 'none') w.push("state = 'done' AND finding = ''");
  else if (f.finding) { w.push("finding LIKE ? ESCAPE '\\'"); a.push(like(f.finding)); }
  if (f.status && STATUSES.includes(f.status)) { w.push('status = ?'); a.push(f.status); }
  if (f.state && ['queued', 'done', 'skipped', 'failed'].includes(f.state)) { w.push('state = ?'); a.push(f.state); }
  if (f.min_score !== undefined && f.min_score !== '' && Number.isFinite(Number(f.min_score))) { w.push('score >= ?'); a.push(Number(f.min_score)); }
  if (f.q) { w.push("(domain LIKE ? ESCAPE '\\' OR store_name LIKE ? ESCAPE '\\')"); a.push(like(f.q), like(f.q)); }
  return { sql: w.join(' AND '), args: a };
}
const safeList = (j) => { try { const a = JSON.parse(j || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const view = (r) => ({
  domain: r.domain, status: r.status, state: r.state, source: r.source, shopify: r.shopify == null ? null : !!r.shopify, store_name: r.store_name, country: r.country, city: r.city,
  currency: r.currency, products: r.products, email: r.email, phone: r.phone, icp: r.icp, score: r.score, finding: r.finding, note: r.note, checked_at: r.checked_at, added_at: r.created_at,
  ai_icp: r.ai_icp ?? null, ai_fit: r.ai_fit ?? null, ai_summary: r.ai_summary || '', ai_search_terms: safeList(r.ai_search_terms), draft_opener: r.draft_opener || '', ai_checked_at: r.ai_classified_at || null,
});

export function listProspects(filters = {}, { limit = 100, offset = 0 } = {}) {
  const { sql, args } = where(filters);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM prospects WHERE ${sql}`).get(...args).n;
  const rows = db.prepare(`SELECT * FROM prospects WHERE ${sql} ORDER BY (state = 'done') DESC, icp DESC, score DESC, rowid LIMIT ? OFFSET ?`)
    .all(...args, Math.min(Math.max(1, limit), 100000), Math.max(0, offset)).map(view);
  return { total, rows };
}

export function summary() {
  const out = summaryBase();
  // Nothing left to read: one plain line for the founder console until an import adds something new.
  out.idle = out.total > 0 && out.waiting === 0;
  out.idleMessage = out.idle ? `All ${out.total} imported stores are checked. Import more to continue.` : '';
  return out;
}
function summaryBase() {
  const by = (col) => Object.fromEntries(db.prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM prospects GROUP BY ${col}`).all().map((r) => [r.k, r.n]));
  return {
    total: db.prepare('SELECT COUNT(*) AS n FROM prospects').get().n, byStatus: by('status'), byState: by('state'),
    waiting: S.waiting.get().n, idle: false, idleMessage: '',
    checkedToday: dailyUsed(), dailyCap: dailyCap(), countries: db.prepare("SELECT country AS k, COUNT(*) AS n FROM prospects WHERE country != '' GROUP BY country ORDER BY n DESC").all(),
  };
}

// ---------- reading one store politely ----------
function bothAgentsRobots(text) {
  const a = parseRobots(text, 'TharamBot'), b = parseRobots(text, 'TharamStoreGuard');
  return { rules: [...a.rules, ...b.rules], a, b, delayMs: Math.max(a.delayMs, b.delayMs) };
}
const robotsOk = (rb, path) => robotsAllows(rb.a, path) && robotsAllows(rb.b, path);

/** A fetcher for one store: each page once, robots.txt obeyed, at least a second between requests. */
function storeFetcher(origin, log) {
  const host = new URL(origin).host.replace(/^www\./, '');
  const seen = new Set();
  let robots = { a: { rules: [] }, b: { rules: [] }, delayMs: 0 };
  let last = 0;
  const pause = async () => {
    const wait = last + Math.max(MIN_GAP_MS, robots.delayMs) - Date.now();
    if (last && wait > 0) await sleep(wait);
    last = Date.now();
  };
  const raw = async (path, { accept = 'text/html,application/json' } = {}) => {
    if (seen.has(path)) return { status: 0, text: '' };
    seen.add(path);
    let url = origin + path;
    for (let hop = 0; hop < 3; hop++) {
      await pause();
      log({ kind: 'fetch', path: hop ? url : path });
      const r = await fetch(url, { headers: { 'user-agent': ENRICH_UA, accept }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        const next = new URL(r.headers.get('location'), url);
        // Only the same store (http to https, with or without www): another address is left alone.
        if (next.host.replace(/^www\./, '') !== host) return { status: r.status, text: '', movedTo: next.host };
        await assertPublicTarget(next.origin);
        url = next.href;
        continue;
      }
      const text = r.status < 400 ? (await r.text()).slice(0, 400000) : '';
      return { status: r.status, text };
    }
    return { status: 310, text: '' };
  };
  return {
    async loadRobots() {
      const r = await raw('/robots.txt', { accept: 'text/plain' });
      if (r.status >= 500) return { error: `robots.txt answered ${r.status}` };
      if (r.status && r.status < 400) robots = bothAgentsRobots(r.text);
      if (!robotsOk(robots, '/')) return { error: 'robots.txt asks bots to stay away' };
      if (robots.delayMs > MAX_CRAWL_DELAY_MS) return { error: `robots.txt asks for a delay of ${Math.round(robots.delayMs / 1000)} s` };
      return { text: r.status > 0 && r.status < 400 ? r.text : '' };
    },
    async get(path) {
      if (!robotsOk(robots, path)) return { status: 0, text: '', skipped: true };
      return raw(path);
    },
  };
}

const TABLE_COLS = ['shopify', 'store_name', 'country', 'city', 'currency', 'products', 'myshopify', 'email', 'phone', 'icp', 'score', 'finding', 'findings_json', 'note', 'state'];
function save(domain, fields) {
  const keys = TABLE_COLS.filter((k) => k in fields);
  db.prepare(`UPDATE prospects SET ${keys.map((k) => `${k} = ?`).join(', ')}${keys.length ? ', ' : ''}checked_at = datetime('now'), updated_at = datetime('now') WHERE domain = ?`)
    .run(...keys.map((k) => fields[k]), domain);
}

/**
 * Reads one store: public details (/meta.json), its own public contact details, then the light check. Never throws.
 * `check` is the light checker (the prospect checker by default).
 */
export async function enrichProspect(domain, { browser, check = checkStore, log = () => {} } = {}) {
  const origin = originOf(domain);
  try {
    await assertPublicTarget(origin);
  } catch (e) { save(domain, { state: 'skipped', note: String(e.message).slice(0, 200) }); return 'skipped'; }
  const f = storeFetcher(origin, log);
  try {
    const rb = await f.loadRobots();
    if (rb.error) { save(domain, { state: 'skipped', note: rb.error }); return 'skipped'; }

    // 1. Public store data.
    const out = {};
    const meta = await f.get('/meta.json');
    let m = null;
    if (meta.status === 200) { try { m = JSON.parse(meta.text); } catch { m = null; } }
    if (m && typeof m === 'object' && (m.myshopify_domain || m.name)) {
      out.shopify = m.myshopify_domain ? 1 : null;
      out.store_name = String(m.name || '').slice(0, 120);
      out.country = countryCode(m.country);
      out.city = String(m.city || '').slice(0, 80);
      out.currency = String(m.currency || '').slice(0, 8);
      out.myshopify = String(m.myshopify_domain || '').toLowerCase().slice(0, 120);
      const n = Number(m.published_products_count);
      out.products = Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    }
    if (out.country && inEU(out.country)) {
      save(domain, { ...out, icp: 0, state: 'skipped', note: 'In the EU: not a market Tharam is going after yet' });
      return 'skipped';
    }

    // 2. The store's own public email and phone, from its contact pages or footer. Nothing is guessed.
    let email = '', phone = '';
    for (const p of ['/policies/contact-information', '/pages/contact-us', '/pages/contact', '/']) {
      const r = await f.get(p);
      if (!r.text) continue;
      const c = findContacts(r.text, domain, out.myshopify);
      email ||= c.email;
      phone ||= c.phone;
      if (email) break;
    }
    out.email = email; out.phone = phone;

    // 3. The light check (home, product, add to cart, checkout, zero prices, phone speed).
    const res = await check(origin, { browser, minGapMs: MIN_GAP_MS, robotsText: rb.text, log: (e) => log({ kind: 'check', ...e }) });
    if (res.status === 'not_shopify') { save(domain, { ...out, shopify: 0, state: 'skipped', note: 'Not a Shopify store' }); return 'skipped'; }
    if (res.status === 'skipped') { save(domain, { ...out, state: 'skipped', note: res.error || 'The store asks bots to stay away' }); return 'skipped'; }
    if (res.status === 'invalid') { save(domain, { ...out, state: 'skipped', note: res.error || 'Not a store address' }); return 'skipped'; }
    if (out.shopify == null) out.shopify = res.status === 'ok' && res.products != null ? 1 : null;
    const risk = riskOf(res);
    const failed = res.status === 'unreachable' || res.status === 'error';
    save(domain, {
      ...out, icp: icpScore({ country: out.country, products: out.products ?? res.products ?? 0, shopify: !!out.shopify, email }),
      products: out.products ?? res.products, finding: risk.finding, score: risk.score, findings_json: JSON.stringify(risk.findings),
      note: failed ? (res.error || 'The store did not answer') : '', state: failed && !risk.finding ? 'failed' : 'done',
    });
    return failed && !risk.finding ? 'failed' : 'done';
  } catch (e) {
    save(domain, { state: 'failed', note: String(e.message || e).slice(0, 200) });
    return 'failed';
  }
}

/** The queue is empty: the founder is emailed once (not again until an import adds new stores). */
async function tellIdle() {
  const sm = summary();
  if (!sm.idle || S.noticed.get()) return;
  S.notice.run();
  if (config.adminEmail) {
    await sendMail({ to: config.adminEmail, subject: `Prospects: all ${sm.total} stores are checked`, text: `${sm.idleMessage}\n\nOpen Founder console → Prospects to import more. Nothing more runs until an import adds a new store.` })
      .catch((e) => console.error('prospect idle mail failed', e.message));
  }
}

// ---------- the worker: one store at a time, only when no customer check is running ----------
let running = false;
const idle = () => { const d = queueDepth(); return d.waiting === 0 && d.active === 0; };

/**
 * Reads queued stores one after another until `budgetMs` or `max` is reached. Returns what happened and why it stopped.
 */
export async function enrichTick({ budgetMs = 50000, max = Infinity, check, log } = {}) {
  if (!isOn('prospects')) return { ran: 0, stopped: 'off' };
  if (running) return { ran: 0, stopped: 'busy' };
  running = true;
  let browser, ran = 0, stopped = null;
  const t0 = Date.now();
  try {
    while (ran < max) {
      if (Date.now() - t0 >= budgetMs) { stopped = 'time'; break; }
      if (!idle()) { stopped = 'customers'; break; }
      if (dailyUsed() >= dailyCap()) { stopped = 'cap'; break; }
      const next = S.next.get();
      if (!next) { stopped = 'empty'; break; }
      S.bump.run(today());
      browser ||= check ? null : await chromium.launch({ executablePath: config.chromePath || process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
      await enrichProspect(next.domain, { browser, check, log });
      ran++;
    }
    const left = S.waiting.get().n;
    if (!stopped) stopped = left === 0 ? 'empty' : 'max';
    if (left === 0) await tellIdle();
    return { ran, stopped };
  } finally {
    running = false;
    await browser?.close().catch(() => {});
  }
}

// ---------- routes ----------
const sameToken = (given, wanted) => {
  if (!given || !wanted) return false;
  const h = (x) => crypto.createHash('sha256').update(String(x)).digest();
  return crypto.timingSafeEqual(h(given), h(wanted));
};
const asFilters = (qs) => Object.fromEntries(['country', 'min_products', 'has_email', 'finding', 'status', 'state', 'min_score', 'q'].map((k) => [k, qs[k] === undefined ? undefined : String(qs[k])]).filter(([, v]) => v !== undefined));

export function prospectRoutes(app, { requireUser, isAdmin }) {
  const feature = requireFeature('prospects');
  const founder = (req, res, next) => requireUser(req, res, () => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Forbidden' })));
  const gate = [feature, founder];
  const actor = (req) => req.user.email;
  const fail = (res, e) => res.status(e.code === 404 ? 404 : 400).json({ error: e.message || String(e) });
  const textBody = express.text({ type: ['text/*'], limit: '12mb' });

  app.get('/api/admin/prospects', ...gate, (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json({ ...listProspects(asFilters(req.query), { limit, offset }), limit, offset, summary: summary(), statuses: STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s] })) });
  });

  app.get('/api/admin/prospects.csv', ...gate, (req, res) => {
    const { rows } = listProspects(asFilters(req.query), { limit: 100000 });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tharam-prospects-${today()}.csv"`);
    res.send(prospectsCsv(rows));
  });

  // For the outreach job: a founder session, or the PROSPECT_API_TOKEN of the server as a Bearer token.
  app.get('/api/admin/prospects.json', feature, (req, res, next) => {
    const given = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    if (given && sameToken(given, process.env.PROSPECT_API_TOKEN)) { req.byToken = true; return next(); }
    return founder(req, res, next);
  }, (req, res) => {
    const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 1000));
    const { total, rows } = listProspects(asFilters(req.query), { limit, offset: Math.max(0, Number(req.query.offset) || 0) });
    res.json({ generated_at: new Date().toISOString(), total, count: rows.length, prospects: rows });
  });

  app.post('/api/admin/prospects/import', ...gate, textBody, (req, res) => {
    const text = typeof req.body === 'string' ? req.body : '';
    if (!text.trim()) return res.status(400).json({ error: 'Paste some store addresses or choose a file' });
    try {
      const r = importDomains(text, { source: String(req.query.source || 'import'), actor: actor(req) });
      const extra = r.blocked ? `, ${r.blocked} on the do-not-contact list` : '';
      res.json({ ...r, message: r.added === 0 && r.total > 0 && !r.blocked ? `Nothing new: all ${r.total} were already there` : `${r.added} new, ${r.already} already there${extra}` });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/admin/prospects/do-not-contact', ...gate, textBody, (req, res) => {
    const text = typeof req.body === 'string' ? req.body : '';
    if (!text.trim()) return res.status(400).json({ error: 'Paste the addresses that must not be contacted' });
    res.json(blockDomains(text, 'do_not_contact', actor(req)));
  });

  app.patch('/api/admin/prospects/:domain', ...gate, (req, res) => {
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return res.status(400).json({ error: 'That is not a store address' });
    try { setStatus(domain, String(req.body?.status || ''), actor(req)); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });

  app.post('/api/admin/prospects/:domain/check-again', ...gate, (req, res) => {
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return res.status(400).json({ error: 'That is not a store address' });
    try { checkAgain(domain, actor(req)); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });

  // Reads a few queued stores now (the same work the server does by itself every minute).
  app.post('/api/admin/prospects/run', ...gate, async (req, res) => {
    const max = Math.min(5, Math.max(1, Number(req.body?.max) || 1));
    try { res.json({ ...(await enrichTick({ max, budgetMs: 100000 })), summary: summary() }); } catch (e) { fail(res, e); }
  });
}
