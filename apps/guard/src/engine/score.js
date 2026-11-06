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
  'cat.pricing': 'some products have pricing mistakes (a zero price or a fake discount)',
  'sec.scripts.bad': 'a script from a known malicious website is running on your store',
  'sec.redirect': 'your store is sending shoppers to another website',
  'sec.mining': "a script is using shoppers' devices to mine cryptocurrency",
  'sec.frames': 'your store loads a hidden page from a known malicious website',
  'sec.scripts.forms': 'a script is reading what shoppers type and sending it to another website',
  'sec.deface': 'your store shows a hacker\'s message instead of your shop',
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
  // Legal rule checks are reported as "rules met" and never change the health score or verdict.
  const scored = checks.filter((c) => !CATEGORIES[c.category]?.rules && !c.notice);
  const criticalFails = scored.filter((c) => c.status === 'fail' && c.severity === 'critical');
  const majorFails = scored.filter((c) => c.status === 'fail' && c.severity === 'major');
  const locked = checks.some((c) => c.id === 'fn.home' && c.status === 'warn');
  const blocked = checks.some((c) => c.id === 'fn.blocked');
  if (criticalFails.length) score = Math.min(score, 45);
  else if (majorFails.length) score = Math.min(score, 89);
  const verdict = blocked ? 'blocked' : locked ? 'locked' : criticalFails.length ? 'critical' : score < 80 || majorFails.length ? 'warning' : 'healthy';
  return { score: locked || blocked ? null : score, verdict, categories: Object.values(cats) };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function summarize(checks, verdict) {
  if (verdict === 'locked') return 'Your store is password protected. Add the storefront password to run the full suite.';
  if (verdict === 'blocked') {
    const v = checks.find((c) => c.id === 'fn.blocked')?.evidence?.vendor || 'Bot protection';
    return `${v} stopped our test browser, so your store wasn't tested. Allow Tharam in and run the check again.`;
  }
  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  if (verdict === 'critical') {
    // A hijacked checkout comes first: it means shoppers' card details may be going to someone else.
    const hijack = fails.find((f) => f.id === 'fn.checkout' && f.evidence?.offsite);
    if (hijack) return `Urgent: checkout is sending shoppers to another website (${hijack.evidence.offsite}). Their card details may be stolen.`;
    const c = fails.find((f) => f.severity === 'critical');
    return `Customers may not be able to buy: ${PROBLEM[c.id] || c.title.toLowerCase()}.`;
  }
  const journeyUntested = checks.some((c) => c.id === 'fn.platform');
  const lead = journeyUntested ? 'Your store is up.' : 'Customers can buy.';
  const tail = journeyUntested ? ' Add to cart and checkout tests are not available for this platform yet.' : '';
  if (fails.length && warns.length) return `${lead} ${plural(fails.length, 'problem', 'problems')} to fix and ${plural(warns.length, 'thing', 'things')} worth a look.${tail}`;
  if (fails.length) return `${lead} ${plural(fails.length, 'problem', 'problems')} to fix.${tail}`;
  if (warns.length) return `${lead} ${plural(warns.length, 'thing', 'things')} worth a look.${tail}`;
  return `Everything we tested works.${tail || ' Your store is in good shape.'}`;
}
