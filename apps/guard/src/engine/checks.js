/** Shared helpers for building check results. */

export const CATEGORIES = {
  functional: { label: 'Shopping journey', weight: 50 },
  performance: { label: 'Speed', weight: 15 },
  seo: { label: 'SEO', weight: 10 },
  accessibility: { label: 'Accessibility', weight: 10 },
  reliability: { label: 'Errors & visuals', weight: 12 },
  trust: { label: 'Catalog & products', weight: 10 },
  // The owner's own store-specific tests (src/custom-tests.js).
  custom: { label: 'Your tests', weight: 10 },
  // Shown as "rules met", not as a score: legal rules don't change whether customers can buy.
  compliance: { label: 'Legal and compliance', weight: 0, rules: true },
};

export function check(id, category, title, status, { severity = 'major', detail = '', evidence = null, fix = '' } = {}) {
  return { id, category, title, status, severity, detail, evidence, fix };
}

export class Recorder {
  constructor() {
    this.checks = [];
    this.steps = [];
  }
  add(c) {
    this.checks.push(c);
    return c;
  }
  step(text) {
    this.steps.push({ at: Date.now(), text });
  }
}

export function shortErr(e) {
  return String(e && e.message ? e.message : e)
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .slice(0, 220);
}

/** "1 issue", "3 issues". */
export function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}
