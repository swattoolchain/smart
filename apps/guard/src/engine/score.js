import { CATEGORIES } from './checks.js';

const PENALTY = {
  fail: { critical: 100, major: 45, minor: 20 },
  warn: { critical: 30, major: 15, minor: 6 },
};

const PROBLEM = {
  'fn.home': 'your store is not loading',
  'fn.pdp': 'product pages are broken',
  'fn.atc': 'the Add to cart button is broken',
  'fn.cart': 'the cart page is not showing items',
  'fn.checkout': 'checkout does not open',
  'nf.seo.noindex.home': 'your homepage is hidden from Google',
  'nf.seo.noindex.product': 'product pages are hidden from Google',
};

export function scoreChecks(checks) {
  const cats = {};
  for (const [key, c] of Object.entries(CATEGORIES))
    cats[key] = { key, label: c.label, weight: c.weight, score: 100, counts: { pass: 0, warn: 0, fail: 0, skip: 0 }, tested: false };
  for (const c of checks) {
    const cat = cats[c.category];
    if (!cat) continue;
    cat.counts[c.status] = (cat.counts[c.status] || 0) + 1;
    if (c.status !== 'skip') cat.tested = true;
    const p = PENALTY[c.status]?.[c.severity] || 0;
    cat.score = Math.max(0, cat.score - p);
  }
  let total = 0,
    weight = 0;
  for (const cat of Object.values(cats)) {
    if (!cat.tested) continue;
    total += cat.score * cat.weight;
    weight += cat.weight;
  }
  let score = weight ? Math.round(total / weight) : 0;
  const criticalFails = checks.filter((c) => c.status === 'fail' && c.severity === 'critical');
  const majorFails = checks.filter((c) => c.status === 'fail' && c.severity === 'major');
  const locked = checks.some((c) => c.id === 'fn.home' && c.status === 'warn');
  if (criticalFails.length) score = Math.min(score, 45);
  else if (majorFails.length) score = Math.min(score, 89);
  const verdict = locked ? 'locked' : criticalFails.length ? 'critical' : score < 80 || majorFails.length ? 'warning' : 'healthy';
  return { score: locked ? null : score, verdict, categories: Object.values(cats) };
}

export function summarize(checks, verdict) {
  if (verdict === 'locked') return 'Your store is password protected. Add the storefront password to run the full suite.';
  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  if (verdict === 'critical') {
    const c = fails.find((f) => f.severity === 'critical');
    return `Customers may not be able to buy: ${PROBLEM[c.id] || c.title.toLowerCase()}.`;
  }
  if (fails.length || warns.length) return `Customers can buy, but we found ${fails.length} problem(s) and ${warns.length} warning(s) to fix.`;
  return 'Everything we tested works. Your store is in good shape.';
}
