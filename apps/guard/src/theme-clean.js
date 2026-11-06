/**
 * Clean theme copies and guided restore (security S4). Read-only: Tharam never writes to the store's theme
 * (one-click restore is a separate decision, T47, because it needs the write_themes permission).
 *
 * The first clean full check (theme read, no security check failed) keeps the theme record of theme watch
 * (theme_files) as the store's clean copy. After that the clean copy never moves forward on its own: a changed or
 * newly published theme becomes the clean copy only when the owner confirms the change ("I made this change").
 * A later clean check only refreshes the copy when the theme matches it file for file (for example after the owner
 * pasted the clean version back). The three copies before the current one are kept.
 * When a theme file changes, the owner can copy or download the clean version of each file, or the whole clean
 * copy as a .zip, and paste it back in Shopify's code editor, step by step.
 */
import zlib from 'node:zlib';
import { db } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS theme_clean (
  store_id INTEGER PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  theme_id TEXT NOT NULL,
  theme_name TEXT,
  run_id INTEGER,
  files INTEGER,
  saved_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS theme_clean_files (
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  checksum TEXT,
  size INTEGER,
  content TEXT,
  PRIMARY KEY (store_id, filename)
);
CREATE TABLE IF NOT EXISTS theme_clean_old (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  theme_id TEXT, theme_name TEXT, run_id INTEGER, files INTEGER, saved_at TEXT, confirmed_by TEXT,
  replaced_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS theme_clean_old_files (
  old_id INTEGER NOT NULL REFERENCES theme_clean_old(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  checksum TEXT,
  size INTEGER,
  content TEXT,
  PRIMARY KEY (old_id, filename)
);
`);
{
  const cols = db.prepare('PRAGMA table_info(theme_clean)').all().map((c) => c.name);
  if (!cols.includes('confirmed_by')) db.exec('ALTER TABLE theme_clean ADD COLUMN confirmed_by TEXT'); // 'first check' | 'owner'
}
export const KEEP_OLD = 3;

/**
 * Is this finished check a clean one? The theme was read and is unchanged (or is a first record or a newly
 * published theme), and no security check failed or needs a look.
 */
export function isClean(result) {
  const checks = result?.checks || [];
  const theme = checks.find((c) => c.id === 'sec.theme');
  if (!theme || theme.status !== 'pass' || result.error) return false;
  return !checks.some((c) => c.category === 'security' && (c.status === 'fail' || c.status === 'warn'));
}

/** Copies the current theme record (theme watch) as the store's clean copy. Returns true when saved. */
export function saveCleanCopy(storeId, runId, confirmedBy = 'first check') {
  const rec = db.prepare('SELECT * FROM theme_watch WHERE store_id = ?').get(storeId);
  if (!rec) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM theme_clean_files WHERE store_id = ?').run(storeId);
    db.prepare('INSERT INTO theme_clean_files (store_id, filename, checksum, size, content) SELECT store_id, filename, checksum, size, content FROM theme_files WHERE store_id = ?').run(storeId);
    db.prepare(`INSERT INTO theme_clean (store_id, theme_id, theme_name, run_id, files, saved_at, confirmed_by) VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(store_id) DO UPDATE SET theme_id = excluded.theme_id, theme_name = excluded.theme_name, run_id = excluded.run_id, files = excluded.files, saved_at = excluded.saved_at, confirmed_by = excluded.confirmed_by`)
      .run(storeId, rec.theme_id, rec.theme_name, runId, rec.files, confirmedBy);
  })();
  return true;
}

/** Whether the theme as last seen is the clean copy, file for file (same theme, same checksums, nothing added or gone). */
export function matchesClean(storeId) {
  const c = db.prepare('SELECT theme_id FROM theme_clean WHERE store_id = ?').get(storeId);
  const now = db.prepare('SELECT theme_id FROM theme_watch WHERE store_id = ?').get(storeId);
  if (!c || !now || c.theme_id !== now.theme_id) return false;
  const a = db.prepare('SELECT filename, checksum, size FROM theme_clean_files WHERE store_id = ? ORDER BY filename').all(storeId);
  const b = db.prepare('SELECT filename, checksum, size FROM theme_files WHERE store_id = ? ORDER BY filename').all(storeId);
  return a.length === b.length && a.every((f, i) => f.filename === b[i].filename && (f.checksum || b[i].checksum ? f.checksum === b[i].checksum : f.size === b[i].size));
}

/** Moves the current clean copy to the older copies, keeping the newest KEEP_OLD. */
function archive(storeId) {
  const c = db.prepare('SELECT * FROM theme_clean WHERE store_id = ?').get(storeId);
  if (!c) return;
  const id = Number(db.prepare('INSERT INTO theme_clean_old (store_id, theme_id, theme_name, run_id, files, saved_at, confirmed_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(storeId, c.theme_id, c.theme_name, c.run_id, c.files, c.saved_at, c.confirmed_by).lastInsertRowid);
  db.prepare('INSERT INTO theme_clean_old_files (old_id, filename, checksum, size, content) SELECT ?, filename, checksum, size, content FROM theme_clean_files WHERE store_id = ?').run(id, storeId);
  const drop = db.prepare('SELECT id FROM theme_clean_old WHERE store_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?').all(storeId, KEEP_OLD);
  for (const d of drop) { db.prepare('DELETE FROM theme_clean_old_files WHERE old_id = ?').run(d.id); db.prepare('DELETE FROM theme_clean_old WHERE id = ?').run(d.id); }
}

/**
 * Saves the clean copy after a finished check. Only two cases, and only when the check was clean:
 * there is no clean copy yet (the first one), or the theme matches the clean copy file for file (a refresh).
 * A changed or newly published theme never replaces the clean copy here: the owner confirms it (confirmChange).
 * Never throws.
 */
export function afterCheck(storeId, runId, result) {
  try {
    if (!isClean(result)) return false;
    const has = db.prepare('SELECT 1 FROM theme_clean WHERE store_id = ?').get(storeId);
    if (!has) return saveCleanCopy(storeId, runId, 'first check');
    if (!matchesClean(storeId)) return false;
    db.prepare("UPDATE theme_clean SET run_id = ?, saved_at = datetime('now') WHERE store_id = ?").run(runId, storeId);
    return true;
  } catch (e) { console.error('clean theme copy failed', storeId, e); return false; }
}

/**
 * The owner confirms the theme as it is now ("I made this change"): it becomes the clean copy, and the copy it
 * replaces is kept with the older copies. Returns false when there is nothing to confirm.
 */
export function confirmChange(storeId) {
  const rec = db.prepare('SELECT 1 FROM theme_watch WHERE store_id = ?').get(storeId);
  if (!rec) return false;
  if (matchesClean(storeId)) return false;
  const lastRun = db.prepare("SELECT id FROM runs WHERE store_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1").get(storeId)?.id ?? null;
  db.transaction(() => { archive(storeId); saveCleanCopy(storeId, lastRun, 'owner'); })();
  return true;
}

/**
 * The clean copy and how each file compares with the theme as last seen:
 * same | changed (differs now) | missing (gone from the theme now). Files in the theme now but not in the clean
 * copy are listed as `added`. Null when there is no clean copy yet.
 */
export function cleanView(storeId) {
  const c = db.prepare('SELECT * FROM theme_clean WHERE store_id = ?').get(storeId);
  if (!c) return null;
  const now = db.prepare('SELECT theme_id FROM theme_watch WHERE store_id = ?').get(storeId);
  const cur = new Map(db.prepare('SELECT filename, checksum, size FROM theme_files WHERE store_id = ?').all(storeId).map((r) => [r.filename, r]));
  const sameTheme = now?.theme_id === c.theme_id;
  const files = db.prepare('SELECT filename, checksum, size, content IS NOT NULL AS stored FROM theme_clean_files WHERE store_id = ? ORDER BY filename').all(storeId).map((f) => {
    const n = cur.get(f.filename);
    const state = !sameTheme ? 'other-theme' : !n ? 'missing' : (f.checksum ? f.checksum !== n.checksum : f.size !== n.size) ? 'changed' : 'same';
    return { filename: f.filename, size: f.size, stored: !!f.stored, state };
  });
  const names = new Set(files.map((f) => f.filename));
  const added = sameTheme ? [...cur.keys()].filter((n) => !names.has(n)).sort() : [];
  const pending = !sameTheme || added.length > 0 || files.some((f) => f.state !== 'same');
  const older = db.prepare('SELECT theme_name, saved_at, replaced_at, files, confirmed_by FROM theme_clean_old WHERE store_id = ? ORDER BY id DESC').all(storeId)
    .map((o) => ({ themeName: o.theme_name, savedAt: o.saved_at, replacedAt: o.replaced_at, files: o.files, confirmedBy: o.confirmed_by }));
  return { themeId: c.theme_id, themeName: c.theme_name, runId: c.run_id, savedAt: c.saved_at, confirmedBy: c.confirmed_by || 'first check', sameTheme, files, added, pending, older };
}

/** One file of the clean copy (text files only), or null. */
export function cleanFile(storeId, filename) {
  const r = db.prepare('SELECT filename, content FROM theme_clean_files WHERE store_id = ? AND filename = ?').get(storeId, String(filename));
  return r && r.content != null ? r : null;
}

/** Every stored text file of the clean copy as a .zip (folders as in the theme: layout/, sections/, …). */
export function cleanZip(storeId) {
  const rows = db.prepare('SELECT filename, content FROM theme_clean_files WHERE store_id = ? AND content IS NOT NULL ORDER BY filename').all(storeId);
  return zip(rows.map((r) => ({ name: r.filename, data: Buffer.from(r.content, 'utf8') })));
}

/** A minimal .zip writer (deflate), so no new dependency is needed. */
export function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  // 1980-01-01 00:00 in DOS time: the files' dates don't matter here, and a fixed date keeps the file reproducible.
  const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const packed = zlib.deflateRawSync(e.data);
    const crc = zlib.crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(e.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
