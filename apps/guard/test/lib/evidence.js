/**
 * Evidence for test reports: screenshots and notes attached to the test that produced them.
 * Written to test-results/evidence/, picked up by test/lib/reporter.js into report.html.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.js';

export const RESULTS = path.join(ROOT, 'test-results');
const DIR = path.join(RESULTS, 'evidence');
const INDEX = path.join(DIR, 'index.jsonl');
fs.mkdirSync(DIR, { recursive: true });

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

/** Records a note (a fact checked) against the current test. */
export function note(t, text) {
  fs.appendFileSync(INDEX, JSON.stringify({ test: t.fullName || t.name, kind: 'note', text: String(text) }) + '\n');
}

/** Saves a Playwright screenshot of `page` as evidence for the current test. */
export async function screenshot(t, page, label, opts = {}) {
  const file = `${slug(t.fullName || t.name)}--${slug(label)}.png`;
  await page.screenshot({ path: path.join(DIR, file), fullPage: !!opts.fullPage });
  fs.appendFileSync(INDEX, JSON.stringify({ test: t.fullName || t.name, kind: 'shot', file, label }) + '\n');
  return file;
}
