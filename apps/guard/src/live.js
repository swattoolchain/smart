/**
 * Live progress for queued and running tests, so the app can show what a test is doing right now.
 * In memory on purpose: a run never outlives the process (unfinished runs are marked interrupted on restart).
 */
export const live = new Map(); // runId -> { phase, disabled, kind, rec, startedAt }

/** Phases in the order a run moves through them. `run` says which kinds of run include the phase. */
export const PHASES = [
  { key: 'open', label: 'Opening your store', run: ['journeys', 'full'] },
  { key: 'journey', label: 'Shopping like a customer', run: ['journeys', 'full'] },
  { key: 'quality', label: 'Speed, SEO, accessibility and links', run: ['full'], groups: ['speed', 'seo', 'a11y', 'links', 'policies'] },
  { key: 'regional', label: 'Laws where you sell', run: ['full'], groups: ['law.de', 'law.cookies', 'access.law', 'law.us'] },
  { key: 'visual', label: 'Comparing screenshots', run: ['full'], groups: ['visual'] },
  { key: 'catalog', label: 'Checking every product', run: ['full'], groups: ['catalog'] },
  { key: 'domain', label: 'Domain, certificate and email records', run: ['full'], groups: ['security.domain'] },
  { key: 'ai', label: 'AI review', run: ['full'], groups: ['ai.visual'] },
];

export function liveView(runId) {
  const p = live.get(runId);
  if (!p) return null;
  const checks = p.rec?.checks || [];
  const count = (s) => checks.filter((c) => c.status === s).length;
  return {
    phase: p.phase,
    disabled: p.disabled || [],
    steps: (p.rec?.steps || []).slice(-40),
    counts: { pass: count('pass'), warn: count('warn'), fail: count('fail') },
    problems: checks.filter((c) => c.status === 'fail').slice(0, 5).map((c) => ({ title: c.title, severity: c.severity })),
  };
}
