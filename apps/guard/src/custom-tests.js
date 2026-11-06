/**
 * Your tests: store-specific tests the owner writes as a file (JSON or YAML), next to the built-in checks.
 *
 * Nothing the owner uploads is run as code. A file is a list of tests; each test is a list of steps from a
 * fixed step library (open, click, fill, add to cart, expect ...). Our own step runner carries them out in the
 * same test browser as the shopping journey, on the store's own address only, and stops before payment.
 *
 * Every saved file is kept as a numbered version (custom_tests table); saving never deletes an older version.
 */
import { db } from './db.js';
import { readFile, validate, MAX_STEPS } from './engine/custom.js';

export * from './engine/custom.js';

db.exec(`
CREATE TABLE IF NOT EXISTS custom_tests (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  format TEXT NOT NULL,          -- json | yaml
  source TEXT NOT NULL,          -- the file exactly as the owner saved it
  tests_json TEXT NOT NULL,      -- the checked, normalised tests
  saved_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (store_id, version)
);
`);

const S = {
  current: db.prepare('SELECT * FROM custom_tests WHERE store_id = ? ORDER BY version DESC LIMIT 1'),
  version: db.prepare('SELECT * FROM custom_tests WHERE store_id = ? AND version = ?'),
  history: db.prepare("SELECT version, format, saved_by, created_at, json_array_length(tests_json) AS tests FROM custom_tests WHERE store_id = ? ORDER BY version DESC LIMIT 100"),
  insert: db.prepare('INSERT INTO custom_tests (store_id, version, format, source, tests_json, saved_by) VALUES (?, (SELECT COALESCE(MAX(version), 0) + 1 FROM custom_tests WHERE store_id = ?), ?, ?, ?, ?)'),
};

// ---------- Saving and versions ----------

/** The plan's limits for a store's own tests. */
export function testLimits(ent) {
  return { tests: ent?.limits?.customTests ?? 5, steps: Math.min(ent?.limits?.customSteps ?? MAX_STEPS, MAX_STEPS) };
}

const view = (row) => row && { version: row.version, format: row.format, text: row.source, tests: JSON.parse(row.tests_json), savedAt: row.created_at };
export const currentTests = (storeId) => view(S.current.get(storeId));
export const testsVersion = (storeId, version) => view(S.version.get(storeId, version));
export const testsHistory = (storeId) => S.history.all(storeId).map((r) => ({ version: r.version, format: r.format, tests: r.tests, savedAt: r.created_at }));

/** Saves a new version (unless the text is unchanged). Throws { problems } when the file has mistakes. */
export function saveTests(storeId, userId, text, { format, limits } = {}) {
  const read = readFile(text, format);
  const { tests, problems } = validate(read.doc, limits);
  if (problems.length) { const e = new Error(problems.length === 1 ? problems[0] : `The file has ${problems.length} problems to fix.`); e.problems = problems; throw e; }
  const cur = S.current.get(storeId);
  if (cur && cur.source === String(text) && cur.format === read.format) return { ...view(cur), unchanged: true };
  S.insert.run(storeId, storeId, read.format, String(text), JSON.stringify(tests), userId ?? null);
  return view(S.current.get(storeId));
}

/** The tests a scheduled check runs: switched on, right kind of check, within the plan's limit. */
export function testsForRun(storeId, kind, ent) {
  if (kind === 'free') return [];
  const cur = currentTests(storeId);
  if (!cur) return [];
  const lim = testLimits(ent);
  return cur.tests.slice(0, lim.tests).filter((t) => t.enabled && (kind === 'full' || t.runs === 'journeys') && t.steps.length <= lim.steps);
}

