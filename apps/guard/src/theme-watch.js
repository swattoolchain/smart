/**
 * Theme file fingerprints (security S3). On each full check of a Shopify store, every file of the live theme is
 * fingerprinted (Shopify's MD5 checksum) through the Admin API (read_themes). Changes since the last check are
 * reported once, with the lines that changed, so the owner notices code they didn't add (a hacked staff account
 * or app editing theme.liquid is how most skimmers and redirects get in).
 * Publishing a different theme is not a change: the new live theme simply becomes the new record.
 *
 * The last-seen text of each file is kept (theme_files) so the next check can show changed lines.
 */
import { db } from './db.js';
import { gql } from './shopify.js';
import { check, plural } from './engine/checks.js';
import { isBadHost } from './engine/scripts.js';
import { MINER_RE } from './engine/hijack.js';

db.exec(`
CREATE TABLE IF NOT EXISTS theme_watch (
  store_id INTEGER PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  theme_id TEXT NOT NULL,
  theme_name TEXT,
  files INTEGER,
  checked_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS theme_files (
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  checksum TEXT,
  size INTEGER,
  content TEXT,
  PRIMARY KEY (store_id, filename)
);
`);

const TEXT = /\.(liquid|js|mjs|css|scss|json|svg|txt|html?)$/i;
const MAX_TEXT = 400_000;
const MAX_FILES_SHOWN = 10;
const MAX_LINES_SHOWN = 30;

/** The live theme and every file's fingerprint. */
export async function liveTheme(shop) {
  const d = await gql(shop, '{ themes(first: 1, roles: [MAIN]) { nodes { id name updatedAt } } }');
  const theme = d.themes?.nodes?.[0];
  if (!theme) return null;
  const files = [];
  let after = null;
  for (let page = 0; page < 40; page++) {
    const r = await gql(shop, `query($id: ID!, $after: String) { theme(id: $id) { files(first: 250, after: $after) { nodes { filename checksumMd5 size } pageInfo { hasNextPage endCursor } } } }`, { id: theme.id, after });
    const f = r.theme?.files;
    for (const n of f?.nodes || []) files.push({ filename: n.filename, checksum: n.checksumMd5 || null, size: Number(n.size) || 0 });
    if (!f?.pageInfo?.hasNextPage) break;
    after = f.pageInfo.endCursor;
  }
  return { id: String(theme.id).split('/').pop(), gid: theme.id, name: theme.name, files };
}

/** The text of the given files (text files under 400 KB only). */
export async function fileBodies(shop, gid, names) {
  const out = new Map();
  const want = names.filter((n) => TEXT.test(n));
  for (let i = 0; i < want.length; i += 50) {
    const batch = want.slice(i, i + 50);
    const r = await gql(shop, `query($id: ID!, $names: [String!]) { theme(id: $id) { files(first: 50, filenames: $names) { nodes { filename size body { ... on OnlineStoreThemeFileBodyText { content } } } } } }`, { id: gid, names: batch });
    for (const n of r.theme?.files?.nodes || []) {
      const c = n.body?.content;
      if (typeof c === 'string' && c.length <= MAX_TEXT) out.set(n.filename, c);
    }
  }
  return out;
}

/**
 * Line changes between two texts: [{ t: '+'|'-', n: line number, s: text }]. A proper line-by-line comparison
 * for normal files; for very large ones, the lines that appear or disappear.
 */
export function diffLines(a = '', b = '') {
  const A = a.split('\n'), B = b.split('\n');
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const x = A.slice(s, ea), y = B.slice(s, eb);
  const out = [];
  if (x.length * y.length > 4_000_000) {
    const inA = new Set(x), inB = new Set(y);
    x.forEach((l, i) => { if (!inB.has(l)) out.push({ t: '-', n: s + i + 1, s: l }); });
    y.forEach((l, i) => { if (!inA.has(l)) out.push({ t: '+', n: s + i + 1, s: l }); });
    return out;
  }
  // Longest common subsequence over the changed middle.
  const m = x.length, n = y.length;
  const L = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && x[i] === y[j]) { i++; j++; }
    else if (i < m && (j === n || L[i + 1][j] >= L[i][j + 1])) { out.push({ t: '-', n: s + i + 1, s: x[i] }); i++; }
    else { out.push({ t: '+', n: s + j + 1, s: y[j] }); j++; }
  }
  return out;
}

const hostsIn = (text) => [...String(text).matchAll(/(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase());
/** What makes an added line dangerous: code from a known-bad site, or mining code. */
function danger(lines) {
  for (const l of lines) {
    const bad = hostsIn(l.s).find(isBadHost);
    if (bad) return `code from ${bad}, a site known for stealing card details or mining`;
    const m = MINER_RE.exec(l.s);
    if (m) return `cryptocurrency mining code (“${m[0]}”)`;
  }
  return null;
}

/**
 * Compares the live theme with the last record. Returns { checks, commit, summary }: commit() saves the new
 * record and must be called only once the check run is saved, so an interrupted run reports the change next time.
 * `fetchTheme` / `fetchBodies` can be swapped in tests.
 */
export async function themeWatch({ storeId, shop, fetchTheme = liveTheme, fetchBodies = fileBodies }) {
  const theme = await fetchTheme(shop);
  if (!theme) return { checks: [check('sec.theme', 'security', 'Theme code unchanged', 'skip', { severity: 'major', detail: 'We couldn’t find a published theme in your store.' })], commit: () => {}, summary: null };
  const prev = db.prepare('SELECT * FROM theme_watch WHERE store_id = ?').get(storeId);
  const rows = new Map(db.prepare('SELECT filename, checksum, size, content FROM theme_files WHERE store_id = ?').all(storeId).map((r) => [r.filename, r]));
  const now = new Map(theme.files.map((f) => [f.filename, f]));
  const fresh = !prev || prev.theme_id !== theme.id;

  const added = [], removed = [], changed = [];
  if (!fresh) {
    for (const f of theme.files) {
      const old = rows.get(f.filename);
      if (!old) added.push(f.filename);
      else if (f.checksum ? f.checksum !== old.checksum : f.size !== old.size) changed.push(f.filename);
    }
    for (const name of rows.keys()) if (!now.has(name)) removed.push(name);
  }
  // Text is fetched for everything on a new record, otherwise only for what changed.
  const bodies = await fetchBodies(shop, theme.gid, fresh ? theme.files.map((f) => f.filename) : [...added, ...changed]);

  const files = [];
  for (const name of [...changed, ...added, ...removed]) {
    const kind = changed.includes(name) ? 'changed' : added.includes(name) ? 'added' : 'removed';
    const before = rows.get(name)?.content ?? null, after = bodies.get(name) ?? null;
    let lines = [];
    if (kind === 'changed' && before != null && after != null) lines = diffLines(before, after);
    else if (kind === 'added' && after != null) lines = after.split('\n').map((s, i) => ({ t: '+', n: i + 1, s }));
    else if (kind === 'removed' && before != null) lines = before.split('\n').map((s, i) => ({ t: '-', n: i + 1, s }));
    files.push({ filename: name, change: kind, added: lines.filter((l) => l.t === '+').length, removed: lines.filter((l) => l.t === '-').length, text: TEXT.test(name), lines });
  }

  const checks = [];
  if (fresh) {
    checks.push({ ...check('sec.theme', 'security', 'Theme code unchanged', 'pass', {
      severity: 'major',
      detail: prev
        ? `You published a new theme, “${theme.name}”. We recorded its ${plural(theme.files.length, 'file')} and will tell you when any of them changes.`
        : `First record of your live theme “${theme.name}”: ${plural(theme.files.length, 'file')}. We'll tell you when any of them changes.`,
    }), notice: true });
  } else if (!files.length) {
    checks.push({ ...check('sec.theme', 'security', 'Theme code unchanged', 'pass', { severity: 'major', detail: `All ${plural(theme.files.length, 'file')} of “${theme.name}” are the same as at the last check.` }), notice: true });
  } else {
    const risky = danger(files.flatMap((f) => f.lines.filter((l) => l.t === '+')));
    const say = (f) => `${f.filename} (${f.change === 'changed' ? `${f.added ? `+${f.added}` : ''}${f.added && f.removed ? ' ' : ''}${f.removed ? `−${f.removed}` : ''}${f.added + f.removed === 1 ? ' line' : f.added || f.removed ? ' lines' : 'changed'}` : f.change})`;
    checks.push({ ...check('sec.theme', 'security', 'Theme code unchanged', 'fail', {
      severity: 'major',
      detail: `${risky ? `The new code includes ${risky}. ` : ''}${plural(files.length, 'file')} of your live theme “${theme.name}” changed since the last check: ${files.slice(0, 5).map(say).join(', ')}${files.length > 5 ? ', and more' : ''}.`,
      fix: risky
        ? 'Remove that code now (Online Store → Themes → ⋯ → Edit code), then change your Shopify password, turn on two-step login and check your staff accounts and apps.'
        : 'If you, your developer or an app you trust made this change, there is nothing to do. If not, open Online Store → Themes → ⋯ → Edit code, undo the change (each file has older versions), then change your Shopify password and check your staff accounts.',
      evidence: {
        theme: theme.name,
        files: files.slice(0, MAX_FILES_SHOWN).map((f) => ({ ...f, lines: f.lines.slice(0, MAX_LINES_SHOWN).map((l) => ({ ...l, s: l.s.slice(0, 300) })), more: Math.max(0, f.lines.length - MAX_LINES_SHOWN) })),
        moreFiles: Math.max(0, files.length - MAX_FILES_SHOWN),
      },
    }), notice: true });
  }

  const commit = () => {
    const keep = (name) => { const b = bodies.get(name); return b !== undefined ? b : rows.get(name)?.content ?? null; };
    const upsert = db.prepare(`INSERT INTO theme_files (store_id, filename, checksum, size, content) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(store_id, filename) DO UPDATE SET checksum = excluded.checksum, size = excluded.size, content = excluded.content`);
    db.transaction(() => {
      // A different theme replaces the record; within one theme, only files that are gone are removed.
      const gone = fresh ? [...rows.keys()].filter((n) => !now.has(n)) : removed;
      for (const n of gone) db.prepare('DELETE FROM theme_files WHERE store_id = ? AND filename = ?').run(storeId, n);
      for (const f of theme.files) upsert.run(storeId, f.filename, f.checksum, f.size, fresh ? bodies.get(f.filename) ?? null : keep(f.filename));
      db.prepare(`INSERT INTO theme_watch (store_id, theme_id, theme_name, files, checked_at) VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(store_id) DO UPDATE SET theme_id = excluded.theme_id, theme_name = excluded.theme_name, files = excluded.files, checked_at = excluded.checked_at`).run(storeId, theme.id, theme.name, theme.files.length);
    })();
  };
  return { checks, commit, summary: { theme: { id: theme.id, name: theme.name }, files: theme.files.length, fresh, changed: files.length } };
}
