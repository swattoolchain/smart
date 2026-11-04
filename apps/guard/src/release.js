/**
 * Safe to publish: runs the test suite on a draft theme and on the live theme side by side,
 * then compares them and gives one verdict.
 */
import { q } from './db.js';
import { comparePair } from './compare.js';
import { startRun, storeConfig } from './scheduler.js';

const SKIP = ['catalog', 'ai.copy', 'ai.visual']; // the catalog is the same for both themes

/** Accepts a Shopify preview link for this store. Returns the URL to open, or throws a merchant-readable error. */
export function previewUrlFor(store, input) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input); } catch { throw new Error('Paste the full preview link, starting with https://'); }
  const host = u.hostname.toLowerCase();
  const storeHost = new URL(store.url).hostname.toLowerCase();
  if (host.endsWith('.shopifypreview.com')) return u.toString();
  if (host === storeHost || host.endsWith('.myshopify.com')) {
    if (!u.searchParams.get('preview_theme_id')) throw new Error('This is a link to your live store. Use the draft theme\'s Share preview link (it contains preview_theme_id or ends in shopifypreview.com).');
    return u.toString();
  }
  throw new Error(`This link isn't for ${storeHost}. Use the Share preview link from this store's Shopify admin.`);
}

export function startRelease(store, url, label) {
  const info = q.insertRelease.run(store.id, url, label || null);
  const id = Number(info.lastInsertRowid);
  const disabled = [...new Set([...(storeConfig(store).disabled || []), ...SKIP])];
  const common = { storeId: store.id, origin: store.url, kind: 'full', password: store.storefront_password, trigger: 'release', disabled, captureOnly: true, release: id };
  const liveId = startRun({ ...common });
  const draftId = startRun({ ...common, preview: { url } });
  q.setReleaseRuns.run(liveId, draftId, id);
  return id;
}

const BLOCK = new Set(['critical', 'major']);

/** Turns a draft-vs-live comparison into a verdict and the lists the merchant needs. */
export function judge(cmp) {
  const item = (x) => ({ id: x.id, title: x.title, status: x.a, severity: x.severity, detail: x.detail, liveDetail: x.prevDetail, fix: x.fix, evidence: x.evidence || null });
  const breaks = cmp.changes.new.map(item);
  const blockers = breaks.filter((x) => x.status === 'fail' && BLOCK.has(x.severity));
  const reviews = breaks.filter((x) => !blockers.includes(x));
  const fixes = cmp.changes.fixed.map(item);
  const visual = cmp.visual.filter((v) => v.ratio != null).map((v) => ({ key: v.key, ratio: v.ratio }));
  const visualChanged = visual.filter((v) => v.ratio > 5);
  const slower = cmp.metrics.filter((m) => m.trend === 'worse');
  const verdict = blockers.length ? 'blocked' : reviews.length || visualChanged.length || slower.length ? 'review' : 'safe';
  const n = (k, one, many = one + 's') => `${k} ${k === 1 ? one : many}`;
  const headline = verdict === 'blocked'
    ? `${n(blockers.length, 'thing')} that work${blockers.length === 1 ? 's' : ''} on your live store ${blockers.length === 1 ? 'breaks' : 'break'} on the draft.`
    : verdict === 'review'
      ? [reviews.length && n(reviews.length, 'new warning'), visualChanged.length && `${n(visualChanged.length, 'page')} look${visualChanged.length === 1 ? 's' : ''} different`, slower.length && `${n(slower.length, 'speed measure')} got worse`].filter(Boolean).join(', ') + '. Nothing is broken.'
      : 'Everything that works on your live store also works on the draft.';
  return { verdict, headline, blockers, reviews, fixes, visual, visualChanged: visualChanged.length, slower: slower.map((m) => ({ page: m.page, name: m.name, unit: m.unit, live: m.b, draft: m.a })) };
}

/** Called when either run of a publish check ends. Finishes the check once both have. */
export function settleRelease(releaseId) {
  const r = q.releaseById.get(releaseId);
  if (!r || r.status !== 'running') return;
  const live = q.runById.get(r.live_run_id), draft = q.runById.get(r.draft_run_id);
  if (!live || !draft) return;
  const open = (x) => x.status === 'queued' || x.status === 'running';
  if (open(live) || open(draft)) return;
  if (live.status === 'cancelled' || draft.status === 'cancelled') return q.finishRelease.run('cancelled', null, null, releaseId);
  if (live.status !== 'done' || draft.status !== 'done') {
    const why = (draft.status !== 'done' ? draft.error : live.error) || 'A test could not finish.';
    return q.finishRelease.run('error', null, JSON.stringify({ error: why }), releaseId);
  }
  const dres = JSON.parse(draft.result_json);
  const preview = (dres.checks || []).find((c) => c.id === 'fn.preview');
  if (preview?.status === 'fail') return q.finishRelease.run('error', null, JSON.stringify({ error: preview.detail }), releaseId);
  const cmp = comparePair(r.store_id, draft.id, live.id);
  const j = judge(cmp);
  j.theme = { draft: dres.theme || null, live: JSON.parse(live.result_json).theme || null };
  j.scores = { draft: draft.score, live: live.score };
  q.finishRelease.run('done', j.verdict, JSON.stringify(j), releaseId);
}
