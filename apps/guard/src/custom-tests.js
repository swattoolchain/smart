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
import { readFile, validate, MAX_STEPS, STEPS } from './engine/custom.js';

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


// ---------- Writing a file from the editor's form ----------

/** A target back in its short written form: "#id", "text=Check" or "role=button:Check". */
function targetText(t) {
  if (!t || typeof t !== 'object') return t;
  if (t.text) return `text=${t.text}`;
  if (t.role) return `role=${t.role}${t.name ? `:${t.name}` : ''}`;
  // A selector that would read as text= or role= keeps its long form.
  return /^(text|role)=/i.test(t.css) ? { css: t.css } : t.css;
}
const rangeValue = (r) => (r && typeof r === 'object' && Object.keys(r).length === 1 && r.equals != null ? r.equals : r);

/** Checked tests as a plain file document: { tests: [...] }, with only the settings that differ from the defaults. */
export function fileDoc(tests) {
  return {
    tests: tests.map((t) => ({
      name: t.name,
      severity: t.severity,
      runs: t.runs,
      device: t.device,
      ...(t.enabled === false && { enabled: false }),
      ...(t.fix && { fix: t.fix }),
      steps: t.steps.map((s) => {
        const out = {};
        for (const [k, v] of Object.entries(s)) {
          const def = STEPS[k];
          out[k] = def?.arg === 'target' ? targetText(v) : def?.arg === 'range' ? rangeValue(v) : v;
        }
        return out;
      }),
    })),
  };
}

const yamlScalar = (v) => (typeof v === 'string' ? (/^[a-z]+$/.test(v) && !/^(true|false|null)$/.test(v) ? v : JSON.stringify(v)) : v === null || v === undefined ? 'null' : String(v));
const yamlFlow = (v) => (v && typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${k}: ${yamlScalar(x)}`).join(', ')} }` : yamlScalar(v));

/** The same document as YAML that src/yaml-lite.js reads back exactly (text is always quoted). */
export function toYaml(doc, header = '# Your own tests for this store. Saved from the test editor in Tharam.') {
  const out = [header, 'tests:'];
  for (const t of doc.tests) {
    const keys = Object.keys(t).filter((k) => k !== 'steps');
    keys.forEach((k, i) => out.push(`${i ? '    ' : '  - '}${k}: ${yamlScalar(t[k])}`));
    out.push('    steps:');
    for (const s of t.steps) {
      Object.entries(s).forEach(([k, v], i) => out.push(`${i ? '        ' : '      - '}${k}: ${yamlFlow(v)}`));
    }
  }
  return out.join('\n') + '\n';
}

/** Turns tests from the editor's form into file text in the given format. Throws { problems } on mistakes. */
export function fileFromTests(list, format, limits) {
  const { tests, problems } = validate({ tests: list }, limits);
  if (problems.length) { const e = new Error(problems.length === 1 ? problems[0] : `The tests have ${problems.length} problems to fix.`); e.problems = problems; throw e; }
  const doc = fileDoc(tests);
  return format === 'json' ? { text: JSON.stringify(doc, null, 2) + '\n', format: 'json' } : { text: toYaml(doc), format: 'yaml' };
}

// ---------- Last results, for the editor's list ----------

const recentRuns = db.prepare("SELECT id, kind, finished_at, result_json FROM runs WHERE store_id = ? AND status = 'done' AND result_json LIKE '%\"custom.%' ORDER BY id DESC LIMIT 30");

/** The latest result of each of the store's own tests: { [checkId]: { status, detail, runId, kind, at, ms } }. */
export function lastResults(storeId) {
  const out = {};
  for (const run of recentRuns.all(storeId)) {
    let res;
    try { res = JSON.parse(run.result_json); } catch { continue; }
    for (const c of res?.checks || []) {
      if (c.category !== 'custom' || out[c.id] || c.status === 'skip') continue;
      const steps = c.evidence?.steps || [];
      out[c.id] = { status: c.status, detail: c.detail || '', runId: run.id, kind: run.kind, at: run.finished_at, ms: steps.reduce((n, s) => n + (s.ms || 0), 0) || null };
    }
  }
  return out;
}
