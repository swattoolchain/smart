/**
 * Owner-only API for a store's own tests (src/custom-tests.js):
 *   GET  /api/stores/:id/custom-tests            the current file, its tests, the plan's limits and the version history
 *        ?version=N                              an earlier version
 *        ?download=1                             the file itself, to save
 *   PUT  /api/stores/:id/custom-tests            upload a file: JSON or YAML as the request body, or { text, format },
 *                                                or tests from the editor's form: { tests: [...], format } (written as that format)
 *   POST /api/stores/:id/custom-tests/restore    { version }: an earlier version becomes the current one (saved as a new version)
 *   POST /api/stores/:id/custom-tests/:name/try  run one test now and get a step-by-step trail with screenshots
 *        body { text } tries a test from an unsaved file (for the editor)
 */
import { storePassword } from './secret.js';
import express from 'express';
import { entitlements, blockReason, has } from './license.js';
import { aiEnabled } from './ai.js';
import { draftFromWords, cleanDescription, startPath } from './custom-tests-draft.js';
import { currentTests, testsVersion, testsHistory, saveTests, testLimits, readFile, validate, runTest, checkIdOf, fileFromTests, fileDoc, lastResults, STEPS, MAX_FILE_BYTES, MAX_STEPS } from './custom-tests.js';
import { templateList, testFromTemplate, freeName } from './custom-test-templates.js';
import { storeConfig } from './scheduler.js';

const TRIES_PER_HOUR = 30;
const drafts = new Map(); // userId -> [timestamps] of AI drafts in the last 24 hours
const drafting = new Set(); // storeIds with a draft in progress
const draftsLeft = (userId, ent) => Math.max(0, ent.limits.aiDrafts - (drafts.get(userId) || []).filter((t) => Date.now() - t < 864e5).length);
/** Whether this account can ask AI to draft tests: the server has an AI key and the plan includes AI. */
const aiDraft = (userId, ent) => (aiEnabled() && has(ent, 'ai') ? { available: true, left: draftsLeft(userId, ent), perDay: ent.limits.aiDrafts } : { available: false });
const tries = new Map(); // storeId -> [timestamps]
const trying = new Set(); // storeIds with a try in progress

const EXAMPLE = `# Your own tests for this store. Each test is a list of steps; we run them like a shopper would.
tests:
  - name: Delivery checker works
    severity: major          # critical, major or minor
    runs: full               # journeys (every shopping check) or full (the daily full check)
    device: mobile           # desktop or mobile
    steps:
      - open: "{product}"
      - fill: "#pincode"
        value: "560001"
      - click: "text=Check"
      - expect_text: ".delivery-result"
        contains: "Delivery available"
`;

/** The step library for the editor's form: what each step takes. */
const LIBRARY = Object.entries(STEPS).map(([key, d]) => ({ key, arg: d.arg, need: d.need || [], opt: d.opt || [], range: !!d.range }));

function bodyText(req, limits) {
  if (typeof req.body === 'string') return { text: req.body, format: /json/.test(req.get('content-type') || '') ? 'json' : undefined };
  const b = req.body || {};
  if (typeof b.text === 'string') return { text: b.text, format: b.format === 'json' || b.format === 'yaml' ? b.format : undefined };
  // Tests from the editor's form: written out in the format the owner uses (YAML unless the current file is JSON).
  if (Array.isArray(b.tests) && b.format) return fileFromTests(b.tests, b.format === 'json' ? 'json' : 'yaml', limits);
  // A JSON test file sent as the request body itself.
  if (Array.isArray(b) || Array.isArray(b.tests)) return { text: JSON.stringify(b, null, 2), format: 'json' };
  return { text: '' };
}

export function customTestRoutes(app, { requireUser, ownStore }) {
  app.get('/api/stores/:id/custom-tests', requireUser, (req, res) => {
    const s = ownStore(req, res);
    if (!s) return;
    const v = req.query.version != null ? Number(req.query.version) : null;
    const file = v != null ? (Number.isInteger(v) ? testsVersion(s.id, v) : null) : currentTests(s.id);
    if (v != null && !file) return res.status(404).json({ error: 'That version does not exist.' });
    if (req.query.download) {
      if (!file) return res.status(404).json({ error: 'This store has no tests file yet.' });
      const ext = file.format === 'json' ? 'json' : 'yaml';
      const host = (() => { try { return new URL(s.url).host.replace(/:/g, '-').replace(/[^\w.-]/g, ''); } catch { return 'store'; } })();
      res.set('Content-Disposition', `attachment; filename="tharam-tests-${host}-v${file.version}.${ext}"`);
      return res.type(ext === 'json' ? 'application/json' : 'text/yaml').send(file.text);
    }
    res.json({ file: file || null, limits: testLimits(entitlements(s.user_id)), ai: aiDraft(s.user_id, entitlements(s.user_id)), history: testsHistory(s.id), results: lastResults(s.id), library: LIBRARY, templates: templateList(), maxSteps: MAX_STEPS, example: EXAMPLE });
  });

  app.put('/api/stores/:id/custom-tests', requireUser, express.text({ type: ['text/*', 'application/yaml', 'application/x-yaml'], limit: MAX_FILE_BYTES + 1024 }), (req, res) => {
    const s = ownStore(req, res);
    if (!s) return;
    const limits = testLimits(entitlements(s.user_id));
    try {
      const { text, format } = bodyText(req, limits);
      const file = saveTests(s.id, req.user.id, text, { format, limits });
      res.json({ ok: true, unchanged: !!file.unchanged, file: { ...file, unchanged: undefined }, history: testsHistory(s.id) });
    } catch (e) {
      res.status(400).json({ error: e.message, problems: e.problems || [e.message] });
    }
  });

  // Describe a test in words; AI drafts the steps. The draft goes back to the editor and is never saved here.
  app.post('/api/stores/:id/custom-tests/draft', requireUser, async (req, res) => {
    const s = ownStore(req, res);
    if (!s) return;
    const ent = entitlements(s.user_id);
    const why = blockReason(ent, s.id);
    if (why) return res.status(403).json({ error: why, upgrade: true });
    if (!aiEnabled()) return res.status(404).json({ error: 'Writing tests from a description is not available.' });
    if (!has(ent, 'ai')) return res.status(403).json({ error: 'Your plan doesn’t include AI. Build the test with the steps instead, or upgrade.', upgrade: true });
    let description, start;
    try { description = cleanDescription(req.body?.description); start = startPath(req.body?.page); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (!draftsLeft(s.user_id, ent)) return res.status(429).json({ error: `Your plan includes ${ent.limits.aiDrafts} AI drafts a day, and you’ve used them. Build the test with the steps, or try again tomorrow.` });
    if (drafting.has(s.id)) return res.status(409).json({ error: 'A draft is already being written for this store. Wait for it to finish.' });
    drafting.add(s.id);
    // Counted when asked, so a failed or refused draft still uses one (each one costs an AI call).
    drafts.set(s.user_id, [...(drafts.get(s.user_id) || []).filter((t) => Date.now() - t < 864e5), Date.now()]);
    try {
      const cfg = storeConfig(s);
      const out = await draftFromWords({ store: s, testProduct: cfg.testProduct || null, description, start, limits: testLimits(ent) });
      // Written the way the file and the editor's form write tests (short targets, no internal ids).
      res.json({ ...out, test: fileDoc([out.test]).tests[0], left: draftsLeft(s.user_id, ent) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, problems: e.problems || [e.message], left: draftsLeft(s.user_id, ent) });
      console.error('[custom-tests] draft failed:', e.message);
      res.status(502).json({ error: 'The AI could not draft the test just now. Try again in a minute.', left: draftsLeft(s.user_id, ent) });
    } finally {
      drafting.delete(s.id);
    }
  });

  // Add a ready-made template (src/custom-test-templates.js) with the owner's values, as a new version of the file.
  app.post('/api/stores/:id/custom-tests/templates/:key', requireUser, (req, res) => {
    const s = ownStore(req, res);
    if (!s) return;
    const limits = testLimits(entitlements(s.user_id));
    const cur = currentTests(s.id);
    const list = cur ? fileDoc(cur.tests).tests : [];
    if (list.length >= limits.tests) return res.status(403).json({ error: `Your plan allows ${limits.tests} of your own tests per store. Delete or replace one to add this template.`, upgrade: true });
    let test;
    try { test = testFromTemplate(String(req.params.key), req.body?.values || {}); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    test.name = freeName(test.name, list);
    try {
      const { text, format } = fileFromTests([...list, test], cur?.format === 'json' ? 'json' : 'yaml', limits);
      const file = saveTests(s.id, req.user.id, text, { format, limits });
      res.json({ ok: true, name: test.name, index: list.length, file: { ...file, unchanged: undefined }, history: testsHistory(s.id) });
    } catch (e) {
      res.status(400).json({ error: e.message, problems: e.problems || [e.message] });
    }
  });

  app.post('/api/stores/:id/custom-tests/restore', requireUser, (req, res) => {
    const s = ownStore(req, res);
    if (!s) return;
    const v = Number(req.body?.version);
    const old = Number.isInteger(v) ? testsVersion(s.id, v) : null;
    if (!old) return res.status(404).json({ error: 'That version does not exist.' });
    try {
      // Saved again as a new version, so the history keeps what was current before.
      const file = saveTests(s.id, req.user.id, old.text, { format: old.format, limits: testLimits(entitlements(s.user_id)) });
      res.json({ ok: true, restored: v, unchanged: !!file.unchanged, file: { ...file, unchanged: undefined }, history: testsHistory(s.id) });
    } catch (e) {
      // An old file can be over today's plan limit.
      res.status(400).json({ error: `Version ${v} can't be used as it is: ${e.message}`, problems: e.problems || [e.message] });
    }
  });

  app.post('/api/stores/:id/custom-tests/:name/try', requireUser, express.text({ type: ['text/*'], limit: MAX_FILE_BYTES + 1024 }), async (req, res) => {
    const s = ownStore(req, res);
    if (!s) return;
    const ent = entitlements(s.user_id);
    const why = blockReason(ent, s.id);
    if (why) return res.status(403).json({ error: why, upgrade: true });
    let tests;
    // An unsaved file from the editor: as the raw body (text/plain, text/yaml) or { text }.
    if (typeof req.body === 'string') req.body = { text: req.body };
    if (typeof req.body?.text === 'string') {
      let read;
      try { read = readFile(req.body.text, req.body.format); } catch (e) { return res.status(400).json({ error: e.message, problems: [e.message] }); }
      const v = validate(read.doc, testLimits(ent));
      if (v.problems.length) return res.status(400).json({ error: v.problems.length === 1 ? v.problems[0] : `The file has ${v.problems.length} problems to fix.`, problems: v.problems });
      tests = v.tests;
    } else tests = currentTests(s.id)?.tests || [];
    const want = String(req.params.name);
    const test = tests.find((t) => t.id === want || t.id === checkIdOf(want) || t.name === want);
    if (!test) return res.status(404).json({ error: `There is no test called “${want.slice(0, 80)}”.` });
    if (trying.has(s.id)) return res.status(409).json({ error: 'A test is already being tried on this store. Wait for it to finish.' });
    const now = Date.now();
    const recent = (tries.get(s.id) || []).filter((t) => now - t < 3600e3);
    if (recent.length >= TRIES_PER_HOUR) return res.status(429).json({ error: `You’ve tried ${TRIES_PER_HOUR} tests on this store in the last hour. Try again a little later.` });
    tries.set(s.id, [...recent, now]);
    trying.add(s.id);
    try {
      const cfg = storeConfig(s);
      const r = await runTest(test, { origin: s.url, password: storePassword(s), testProduct: cfg.testProduct || null, images: true });
      res.json({ test: { name: test.name, id: test.id, severity: test.severity, device: test.device }, status: r.status, message: r.message || `All ${test.steps.length} steps worked.`, ms: r.ms, steps: r.trail });
    } catch (e) {
      res.status(500).json({ error: 'The test could not be started. Try again in a minute.' });
    } finally {
      trying.delete(s.id);
    }
  });
}
