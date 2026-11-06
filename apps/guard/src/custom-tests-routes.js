/**
 * Owner-only API for a store's own tests (src/custom-tests.js):
 *   GET  /api/stores/:id/custom-tests            the current file, its tests, the plan's limits and the version history
 *        ?version=N                              an earlier version
 *        ?download=1                             the file itself, to save
 *   PUT  /api/stores/:id/custom-tests            upload a file: JSON or YAML as the request body, or { text, format }
 *   POST /api/stores/:id/custom-tests/:name/try  run one test now and get a step-by-step trail with screenshots
 *        body { text } tries a test from an unsaved file (for the editor)
 */
import express from 'express';
import { entitlements, blockReason } from './license.js';
import { currentTests, testsVersion, testsHistory, saveTests, testLimits, readFile, validate, runTest, checkIdOf, MAX_FILE_BYTES } from './custom-tests.js';
import { storeConfig } from './scheduler.js';

const TRIES_PER_HOUR = 30;
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

function bodyText(req) {
  if (typeof req.body === 'string') return { text: req.body, format: /json/.test(req.get('content-type') || '') ? 'json' : undefined };
  const b = req.body || {};
  if (typeof b.text === 'string') return { text: b.text, format: b.format === 'json' || b.format === 'yaml' ? b.format : undefined };
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
    res.json({ file: file || null, limits: testLimits(entitlements(s.user_id)), history: testsHistory(s.id), example: EXAMPLE });
  });

  app.put('/api/stores/:id/custom-tests', requireUser, express.text({ type: ['text/*', 'application/yaml', 'application/x-yaml'], limit: MAX_FILE_BYTES + 1024 }), (req, res) => {
    const s = ownStore(req, res);
    if (!s) return;
    const { text, format } = bodyText(req);
    try {
      const file = saveTests(s.id, req.user.id, text, { format, limits: testLimits(entitlements(s.user_id)) });
      res.json({ ok: true, unchanged: !!file.unchanged, file: { ...file, unchanged: undefined }, history: testsHistory(s.id) });
    } catch (e) {
      res.status(400).json({ error: e.message, problems: e.problems || [e.message] });
    }
  });

  app.post('/api/stores/:id/custom-tests/:name/try', requireUser, async (req, res) => {
    const s = ownStore(req, res);
    if (!s) return;
    const ent = entitlements(s.user_id);
    const why = blockReason(ent, s.id);
    if (why) return res.status(403).json({ error: why, upgrade: true });
    let tests;
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
      const r = await runTest(test, { origin: s.url, password: s.storefront_password, testProduct: cfg.testProduct || null, images: true });
      res.json({ test: { name: test.name, id: test.id, severity: test.severity, device: test.device }, status: r.status, message: r.message || `All ${test.steps.length} steps worked.`, ms: r.ms, steps: r.trail });
    } catch (e) {
      res.status(500).json({ error: 'The test could not be started. Try again in a minute.' });
    } finally {
      trying.delete(s.id);
    }
  });
}
