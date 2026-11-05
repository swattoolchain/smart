// The check engine against the mock store: a healthy store passes, and each breakage is caught.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './lib/harness.js';
import { note } from './lib/evidence.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ALLOW_LOCAL_TARGETS = '1';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-engine-'));
const { runScan } = await import('../src/engine/index.js');
const { getBrowser } = await import('../src/engine/browser.js');

const check = (r, id) => r.checks.find((c) => c.id === id);
const cases = [
  { name: 'a healthy store passes and checkout opens', breaks: '', expect: (r) => r.verdict !== 'critical' && check(r, 'fn.checkout')?.status === 'pass' },
  { name: 'broken Add to cart is caught', breaks: 'atc', expect: (r) => check(r, 'fn.atc')?.status === 'fail' },
  { name: 'broken checkout is caught', breaks: 'checkout', expect: (r) => check(r, 'fn.checkout')?.status === 'fail' },
  { name: 'broken search is caught', breaks: 'search', expect: (r) => check(r, 'fn.search')?.status === 'fail' },
  { name: 'JavaScript errors are reported', breaks: 'jserror', expect: (r) => check(r, 'nf.jserrors')?.status !== 'pass' },
  { name: 'a password-protected store is reported as locked', breaks: 'password', expect: (r) => r.verdict === 'locked' },
  { name: 'bot protection is reported as blocked, not as failures', breaks: 'cloudflare', expect: (r) => r.verdict === 'blocked' && !r.checks.some((c) => c.status === 'fail') },
  { name: 'the storefront password unlocks the store', breaks: 'password', password: 'letmein', expect: (r) => check(r, 'fn.atc')?.status === 'pass' },
];

describe('Check engine', { concurrency: 1 }, () => {
  after(async () => { (await getBrowser()).close(); });
  for (const [i, c] of cases.entries()) {
    it(c.name, { timeout: 180000 }, async (t) => {
      const mock = await startMock({ breaks: c.breaks });
      try {
        const r = await runScan({ runId: `engine-test-${i}-${Date.now()}`, origin: mock.origin, kind: 'journeys', password: c.password });
        note(t, `verdict ${r.verdict}, score ${r.score}; ${r.checks.filter((x) => x.status === 'fail').map((x) => x.id).join(', ') || 'no failures'}`);
        assert.ok(c.expect(r), `unexpected result: verdict=${r.verdict} checks=${r.checks.map((x) => `${x.id}:${x.status}`).join(' ')}`);
      } finally { mock.stop(); }
    });
  }
});
