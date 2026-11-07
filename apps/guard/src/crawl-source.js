/**
 * Common Crawl as a source of Shopify stores for Prospects (founder console → Prospects; behind the 'prospects'
 * switch; founders only).
 *
 * Common Crawl is a free, public web archive (no login). Each crawl has a list of WAT files: one small record per
 * page with its response headers and the scripts and links in its head. A page with a Shopify signal gives us a
 * store address, which goes into the same Prospects list (kept once, ever; opted-out stores are never added).
 *
 * Method (the simplest that works in Node without new packages): read WAT files with HTTP byte ranges, a window at a
 * time. Every WAT record is its own gzip member, so we walk the members ourselves and always stop on a member
 * boundary. The saved position (file number and byte offset) is therefore exact, and a stopped run resumes in the
 * middle of an archive. The columnar index (parquet) was left out: it needs a parquet reader and has no Shopify signal.
 *
 * Not brute force: per archive only CC_FILES_PER_ARCHIVE WAT files (default 200), spread evenly across the archive,
 * are read, and each tick reads at most CC_BYTES_PER_TICK (default 48 MB). The archive list is CC_ARCHIVES (oldest
 * first); the next one is chosen by how well similar archives (same year) yielded new stores.
 *
 * Self-tuning (plain rules): yield = new stores / stores found, per archive. A run of low-yield archives pauses the
 * background job with a note for the founder. Slow or refusing servers get longer and longer waits.
 */
import zlib from 'node:zlib';
import { db } from './db.js';
import { isOn, requireFeature } from './features.js';
import { audit } from './license.js';
import { queueDepth } from './queue.js';
import { importDomains } from './prospect-list.js';

export const SOURCE = 'Common Crawl';
const ARCHIVE_ID = /^CC-MAIN-\d{4}-\d{2}$/;
const DEFAULT_ARCHIVES = ['CC-MAIN-2023-06', 'CC-MAIN-2023-14', 'CC-MAIN-2023-23', 'CC-MAIN-2023-40', 'CC-MAIN-2023-50', 'CC-MAIN-2024-10', 'CC-MAIN-2024-22', 'CC-MAIN-2024-33', 'CC-MAIN-2024-42', 'CC-MAIN-2024-51', 'CC-MAIN-2025-08', 'CC-MAIN-2025-21'];

const num = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= 0 ? n : dflt; };
export const settings = () => ({
  baseUrl: (process.env.CC_BASE_URL || 'https://data.commoncrawl.org/').replace(/\/?$/, '/'),
  bytesPerTick: num('CC_BYTES_PER_TICK', 48 * 1024 * 1024),
  window: num('CC_WINDOW_BYTES', 8 * 1024 * 1024),
  filesPerArchive: Math.max(1, num('CC_FILES_PER_ARCHIVE', 200)),
  dryYield: num('CC_DRY_YIELD', 0.02), // below this share of new stores an archive counts as dry
  dryRun: Math.max(1, num('CC_DRY_RUN', 3)), // this many dry archives in a row pause the background job
  backoffBaseMs: num('CC_BACKOFF_BASE_MS', 30000),
  backoffMaxMs: num('CC_BACKOFF_MAX_MS', 3600000),
});

db.exec(`CREATE TABLE IF NOT EXISTS crawl_archives (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued',
  files_total INTEGER NOT NULL DEFAULT 0,
  file_idx INTEGER NOT NULL DEFAULT 0,
  file_offset INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  bytes_read INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS crawl_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');`);

const kvGet = (k, d = '') => db.prepare('SELECT value FROM crawl_kv WHERE key = ?').get(k)?.value ?? d;
const kvSet = (k, v) => db.prepare('INSERT INTO crawl_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
const yearOf = (id) => id.slice(8, 12);
const yieldOf = (a) => (a.matched > 0 ? a.added / a.matched : 0);

// ---------- archives ----------
export function ensureArchives() {
  const list = (process.env.CC_ARCHIVES ? process.env.CC_ARCHIVES.split(/[\s,]+/) : DEFAULT_ARCHIVES).filter((x) => ARCHIVE_ID.test(x));
  const ins = db.prepare('INSERT OR IGNORE INTO crawl_archives (id, position) VALUES (?, ?)');
  list.forEach((id, i) => ins.run(id, i));
}

/** Founder adds a newer archive. It also wakes a paused job: there is something new to read. */
export function addArchive(id, actor = '') {
  id = String(id || '').trim().toUpperCase();
  if (!ARCHIVE_ID.test(id)) throw new Error('An archive name looks like CC-MAIN-2025-21');
  const pos = (db.prepare('SELECT MAX(position) AS m FROM crawl_archives').get().m ?? -1) + 1;
  const r = db.prepare('INSERT OR IGNORE INTO crawl_archives (id, position) VALUES (?, ?)').run(id, pos);
  if (!r.changes) throw new Error('That archive is already in the list');
  kvSet('paused_note', '');
  if (actor) audit(actor, null, 'prospects.crawl_archive', { id });
  return { id };
}

/** Next archive to read: the one already running, otherwise the queued one most like the archives that yielded well. */
export function nextArchive() {
  const running = db.prepare("SELECT * FROM crawl_archives WHERE state = 'running' ORDER BY position LIMIT 1").get();
  if (running) return running;
  const queued = db.prepare("SELECT * FROM crawl_archives WHERE state = 'queued' ORDER BY position").all();
  if (!queued.length) return null;
  const done = db.prepare("SELECT * FROM crawl_archives WHERE state = 'done'").all();
  if (!done.length) return queued[0]; // nothing learned yet: oldest first
  const avg = (rows) => rows.reduce((s, r) => s + yieldOf(r), 0) / rows.length;
  const overall = avg(done);
  const score = (a) => { const same = done.filter((d) => yearOf(d.id) === yearOf(a.id)); return same.length ? avg(same) : overall; };
  return queued.map((a) => ({ a, s: score(a) })).sort((x, y) => y.s - x.s || x.a.position - y.a.position)[0].a;
}

// ---------- reading WAT bytes ----------
/** Reads the first complete gzip member at `pos`. Returns null if the bytes end before the member does. */
export function readMember(buf, pos) {
  if (pos + 18 > buf.length || buf[pos] !== 0x1f || buf[pos + 1] !== 0x8b || buf[pos + 2] !== 8) return null;
  const flg = buf[pos + 3];
  let p = pos + 10;
  if (flg & 4) { if (p + 2 > buf.length) return null; p += 2 + buf.readUInt16LE(p); }
  if (flg & 8) { while (p < buf.length && buf[p] !== 0) p++; p++; }
  if (flg & 16) { while (p < buf.length && buf[p] !== 0) p++; p++; }
  if (flg & 2) p += 2;
  if (p >= buf.length) return null;
  try {
    const out = zlib.inflateRawSync(buf.subarray(p), { info: true });
    const end = p + out.engine.bytesWritten + 8;
    if (end > buf.length) return null;
    return { data: out.buffer, end };
  } catch { return null; }
}

const SHOPIFY_HEADER = /^(x-shopid|x-shopify-[a-z-]+|x-sorting-hat-[a-z-]+)$/i;
const SHOPIFY_LINK = /cdn\.shopify\.com|\.myshopify\.com\/|shopifycloud\.com/i;
const NOT_A_STORE = /(^|\.)(shopify\.com|shopifycdn\.com|shopifycloud\.com|shopifysvc\.com)$/;

/** One WAT record (WARC headers, blank line, JSON) → the store's host, or null if the page has no Shopify signal. */
export function hostFromRecord(text) {
  const cut = text.indexOf('\r\n\r\n');
  if (cut < 0) return null;
  const head = text.slice(0, cut);
  if (!/^WARC-Type:\s*metadata/im.test(head)) return null;
  const uri = /^WARC-Target-URI:\s*(\S+)/im.exec(head)?.[1];
  if (!uri) return null;
  let host;
  try { host = new URL(uri).hostname.toLowerCase(); } catch { return null; }
  if (!host || NOT_A_STORE.test(host)) return null;
  let j;
  try { j = JSON.parse(text.slice(cut + 4)); } catch { return null; }
  const meta = j?.Envelope?.['Payload-Metadata']?.['HTTP-Response-Metadata'];
  const headers = Object.keys(meta?.Headers || {});
  const h = meta?.['HTML-Metadata']?.Head || {};
  const urls = [...(h.Scripts || []), ...(h.Link || [])].map((x) => String(x?.url || ''));
  const signal = host.endsWith('.myshopify.com') || headers.some((k) => SHOPIFY_HEADER.test(k)) || urls.some((u) => SHOPIFY_LINK.test(u));
  return signal ? host : null;
}

/** All Shopify hosts in the bytes. `end` is where the last complete record stopped. */
export function scanWindow(buf) {
  const hosts = new Set();
  let pos = 0;
  for (;;) {
    const m = readMember(buf, pos);
    if (!m) break;
    const host = hostFromRecord(m.data.toString('utf8'));
    if (host) hosts.add(host);
    pos = m.end;
  }
  return { hosts: [...hosts], end: pos };
}

// ---------- fetching, with backoff ----------
export class CrawlRefused extends Error {}
async function fetchBytes(url, headers = {}, fetchFn = fetch) {
  let res;
  try { res = await fetchFn(url, { headers: { 'User-Agent': 'TharamStoreGuard/1.0 (+https://tharam.store/bot)', ...headers }, signal: AbortSignal.timeout(60000) }); }
  catch (e) { throw new CrawlRefused(`Common Crawl did not answer (${e.message})`); }
  if (res.status === 416) return { status: 416, buf: Buffer.alloc(0), total: null };
  if (res.status === 404) throw Object.assign(new Error('Common Crawl has no such file'), { missing: true });
  if (res.status === 429 || res.status >= 500) throw new CrawlRefused(`Common Crawl answered ${res.status}`);
  if (!res.ok) throw new Error(`Common Crawl answered ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')?.[1]) || null;
  return { status: res.status, buf, total };
}

const backoffUntil = () => Number(kvGet('backoff_until', '0')) || 0;
function slowDown(now) {
  const s = settings(), n = Number(kvGet('backoff_n', '0')) + 1;
  kvSet('backoff_n', n);
  kvSet('backoff_until', now + Math.min(s.backoffMaxMs, s.backoffBaseMs * 2 ** (n - 1)));
}
function pace() { kvSet('backoff_n', 0); kvSet('backoff_until', 0); }

const pathsCache = new Map();
async function watPaths(id, fetchFn) {
  if (pathsCache.has(id)) return pathsCache.get(id);
  const { buf } = await fetchBytes(`${settings().baseUrl}crawl-data/${id}/wat.paths.gz`, {}, fetchFn);
  const all = zlib.gunzipSync(buf).toString('utf8').split('\n').map((x) => x.trim()).filter(Boolean);
  pathsCache.set(id, all);
  return all;
}
/** The WAT files we read: evenly spread across the archive, at most `filesPerArchive`. */
const sample = (all, cap) => { const stride = Math.max(1, Math.floor(all.length / cap)); return Array.from({ length: Math.min(cap, Math.ceil(all.length / stride)) }, (_, i) => all[i * stride]); };

// ---------- one tick ----------
let running = false;

/** Checks whether the background job should pause: several archives in a row with almost nothing new. */
function maybePause() {
  const s = settings();
  const last = db.prepare("SELECT * FROM crawl_archives WHERE state = 'done' ORDER BY finished_at DESC, rowid DESC LIMIT ?").all(s.dryRun);
  if (last.length < s.dryRun || !last.every((a) => yieldOf(a) < s.dryYield)) return false;
  const left = db.prepare("SELECT COUNT(*) AS n FROM crawl_archives WHERE state = 'queued'").get().n;
  kvSet('auto', '0');
  kvSet('paused_note', `This source is mostly exhausted: the last ${s.dryRun} archives added almost nothing new. ${left} archive${left === 1 ? '' : 's'} left unprocessed. It starts again when you press "Read more now" or add a newer archive.`);
  return true;
}

/**
 * Reads up to `bytes` of WAT data, resuming where the last run stopped. `manual` ignores the background switch and the
 * "customers first" rule; it never ignores a back-off.
 */
export async function crawlTick({ bytes = settings().bytesPerTick, fetchFn, manual = false, now = Date.now() } = {}) {
  if (!isOn('prospects')) return { stopped: 'off', added: 0, bytes: 0 };
  if (running) return { stopped: 'busy', added: 0, bytes: 0 };
  if (!manual && kvGet('auto', '0') !== '1') return { stopped: 'paused', added: 0, bytes: 0 };
  if (backoffUntil() > now) return { stopped: 'backoff', added: 0, bytes: 0, until: backoffUntil() };
  running = true;
  const s = settings();
  let read = 0, added = 0, stopped = null;
  try {
    ensureArchives();
    if (manual) kvSet('paused_note', '');
    while (read < bytes) {
      if (!manual) { const d = queueDepth(); if (d.waiting || d.active) { stopped = 'customers'; break; } }
      const a = nextArchive();
      if (!a) { stopped = 'empty'; break; }
      let files;
      try { files = sample(await watPaths(a.id, fetchFn), s.filesPerArchive); }
      catch (e) {
        if (e.missing) { db.prepare("UPDATE crawl_archives SET state = 'failed', note = ?, updated_at = datetime('now') WHERE id = ?").run('Common Crawl has no list of files for this archive.', a.id); continue; }
        throw e;
      }
      if (a.state === 'queued') db.prepare("UPDATE crawl_archives SET state = 'running', files_total = ?, updated_at = datetime('now') WHERE id = ?").run(files.length, a.id);
      let idx = a.file_idx, off = a.file_offset;
      while (read < bytes && idx < files.length) {
        const from = off, want = s.window;
        const r = await fetchBytes(`${s.baseUrl}${files[idx]}`, { Range: `bytes=${from}-${from + want - 1}` }, fetchFn);
        pace();
        let fileDone = r.status === 416;
        if (!fileDone) {
          const { hosts, end } = scanWindow(r.buf);
          const atEnd = r.total ? from + r.buf.length >= r.total : r.buf.length < want;
          if (end === 0 && !atEnd) { fileDone = true; } // one record bigger than the window: leave this file
          else {
            const imp = hosts.length ? importDomains(hosts.join('\n'), { source: SOURCE, detail: a.id }) : { added: 0 };
            added += imp.added;
            db.prepare("UPDATE crawl_archives SET matched = matched + ?, added = added + ?, bytes_read = bytes_read + ?, updated_at = datetime('now') WHERE id = ?").run(hosts.length, imp.added, end, a.id);
            off = from + end; read += r.buf.length;
            if (atEnd && end === r.buf.length) fileDone = true;
            else if (atEnd) fileDone = true; // a cut-off last record: nothing more to read
          }
        }
        if (fileDone) { idx++; off = 0; }
        db.prepare("UPDATE crawl_archives SET file_idx = ?, file_offset = ?, updated_at = datetime('now') WHERE id = ?").run(idx, off, a.id);
      }
      if (idx >= files.length) {
        db.prepare("UPDATE crawl_archives SET state = 'done', finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(a.id);
        if (maybePause()) { stopped = 'dry'; break; }
      }
    }
    return { stopped: stopped || 'budget', added, bytes: read };
  } catch (e) {
    if (e instanceof CrawlRefused) { slowDown(now); return { stopped: 'backoff', added, bytes: read, error: e.message, until: backoffUntil() }; }
    throw e;
  } finally { running = false; }
}

// ---------- what the console shows ----------
export function crawlSummary() {
  ensureArchives();
  const rows = db.prepare('SELECT * FROM crawl_archives ORDER BY position').all();
  const until = backoffUntil();
  return {
    auto: kvGet('auto', '0') === '1',
    pausedNote: kvGet('paused_note'),
    backoffUntil: until > Date.now() ? new Date(until).toISOString() : null,
    archives: rows.map((a) => ({
      id: a.id, state: a.state, files_done: Math.min(a.file_idx, a.files_total), files_total: a.files_total, offset: a.file_offset,
      stores_found: a.matched, stores_added: a.added, yield_percent: a.matched ? Math.round((a.added / a.matched) * 1000) / 10 : null, note: a.note,
    })),
  };
}

export function crawlRoutes(app, { requireUser, isAdmin }) {
  const feature = requireFeature('prospects');
  const founder = (req, res, next) => requireUser(req, res, () => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Forbidden' })));
  const gate = [feature, founder];
  app.get('/api/admin/prospects/crawl', ...gate, (req, res) => res.json(crawlSummary()));
  app.post('/api/admin/prospects/crawl/run', ...gate, async (req, res) => {
    try { res.json({ ...(await crawlTick({ manual: true })), ...crawlSummary() }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/prospects/crawl/auto', ...gate, (req, res) => {
    const on = !!req.body?.on;
    kvSet('auto', on ? '1' : '0'); if (on) kvSet('paused_note', '');
    audit(req.user.email, null, 'prospects.crawl_auto', { on });
    res.json(crawlSummary());
  });
  app.post('/api/admin/prospects/crawl/archives', ...gate, (req, res) => {
    try { addArchive(req.body?.id, req.user.email); res.json(crawlSummary()); } catch (e) { res.status(400).json({ error: e.message }); }
  });
}
