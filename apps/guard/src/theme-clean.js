/**
 * Clean theme copies and guided restore (security S4). Read-only: Tharam never writes to the store's theme
 * (one-click restore is a separate decision, T47, because it needs the write_themes permission).
 *
 * After a full check where the theme code is unchanged and no security check failed, the theme record kept by
 * theme watch (theme_files) is copied as the store's clean copy. When a theme file later changes, the owner can
 * copy or download the clean version of each file, or the whole clean copy as a .zip, and paste it back in
 * Shopify's code editor, step by step.
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
`);

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
export function saveCleanCopy(storeId, runId) {
  const rec = db.prepare('SELECT * FROM theme_watch WHERE store_id = ?').get(storeId);
  if (!rec) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM theme_clean_files WHERE store_id = ?').run(storeId);
    db.prepare('INSERT INTO theme_clean_files (store_id, filename, checksum, size, content) SELECT store_id, filename, checksum, size, content FROM theme_files WHERE store_id = ?').run(storeId);
    db.prepare(`INSERT INTO theme_clean (store_id, theme_id, theme_name, run_id, files, saved_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(store_id) DO UPDATE SET theme_id = excluded.theme_id, theme_name = excluded.theme_name, run_id = excluded.run_id, files = excluded.files, saved_at = excluded.saved_at`)
      .run(storeId, rec.theme_id, rec.theme_name, runId, rec.files);
  })();
  return true;
}

/** Saves the clean copy after a finished check, if the check was clean. Never throws. */
export function afterCheck(storeId, runId, result) {
  try { return isClean(result) ? saveCleanCopy(storeId, runId) : false; } catch (e) { console.error('clean theme copy failed', storeId, e); return false; }
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
  return { themeId: c.theme_id, themeName: c.theme_name, runId: c.run_id, savedAt: c.saved_at, sameTheme, files, added };
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
