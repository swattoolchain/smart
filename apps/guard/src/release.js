/**
 * Safe to publish: runs the test suite on a draft theme and on the live theme side by side,
 * then compares them and gives one verdict.
 */
import { q } from './db.js';
import { seal, readSecret, storePassword } from './secret.js';
import { comparePair } from './compare.js';
import { startRun, storeConfig } from './scheduler.js';
import { config } from './config.js';
import { effectiveDisabled } from './engine/catalog.js';
import { entitlements, has, blockReason, envAllowed } from './license.js';
import { sendMail, sendSlack } from './alerts.js';

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

/** Accepts a separate staging store or site (another domain, often password-protected). */
export function stagingUrlFor(store, input) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input); } catch { throw new Error('Enter the full address, starting with https://'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Enter a web address starting with https://');
  if (u.host.toLowerCase() === new URL(store.url).host.toLowerCase() && !u.searchParams.get('preview_theme_id')) throw new Error('This is your live store. Enter the address of the staging store or site.');
  // Tests open pages by path from the site's root, so keep only the origin.
  return u.origin;
}

/** Validates an environment as the merchant entered it. Returns the clean fields or throws a readable error. */
export function cleanEnvironment(store, input = {}, base = {}) {
  const name = String(input.name ?? base.name ?? '').trim().slice(0, 60);
  if (!name) throw new Error('Give this environment a name, such as Staging.');
  const kind = (input.kind ?? base.kind) === 'store' ? 'store' : 'theme';
  const raw = String(input.url ?? base.url ?? '').trim();
  if (!raw) throw new Error(kind === 'theme' ? 'Paste the theme preview link.' : 'Enter the staging address.');
  const url = kind === 'theme' ? previewUrlFor(store, raw) : stagingUrlFor(store, raw);
  // An empty password field keeps the saved one; "clear" removes it.
  let password = base.password || null;
  if (input.password !== undefined && input.password !== '') password = input.password === null ? null : seal(String(input.password).slice(0, 200));
  if (kind === 'theme') password = null; // theme previews use the live store's password
  const auto = (input.auto ?? base.auto) === 'daily' ? 'daily' : 'off';
  return { name, kind, url, password, auto };
}

/**
 * Starts a publish check: the live store and the candidate (a theme preview or a staging environment)
 * are tested side by side with the same suite. Returns the check's id.
 */
export function startRelease(store, { url, label, env = null, trigger = 'manual' }) {
  const info = q.insertRelease.run(store.id, url, label || null, env?.id || null, trigger, store.id);
  const id = Number(info.lastInsertRowid);
  const disabled = [...new Set([...effectiveDisabled(storeConfig(store)), ...SKIP])];
  const common = { storeId: store.id, origin: store.url, kind: 'full', password: storePassword(store), trigger: 'release', disabled, captureOnly: true, release: id };
  const liveId = startRun({ ...common });
  const draftId = env?.kind === 'store'
    ? startRun({ ...common, origin: url, password: readSecret(env.password), ownPassword: true })
    : startRun({ ...common, preview: { url } });
  q.setReleaseRuns.run(liveId, draftId, id);
  return id;
}

const BLOCK = new Set(['critical', 'major']);

/** Turns a draft-vs-live comparison into a verdict and the lists the merchant needs. */
export function judge(cmp, where = 'the draft') {
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
    ? `${n(blockers.length, 'thing')} that work${blockers.length === 1 ? 's' : ''} on your live store ${blockers.length === 1 ? 'breaks' : 'break'} on ${where}.`
    : verdict === 'review'
      ? [reviews.length && n(reviews.length, 'new warning'), visualChanged.length && `${n(visualChanged.length, 'page')} look${visualChanged.length === 1 ? 's' : ''} different`, slower.length && `${n(slower.length, 'speed measure')} got worse`].filter(Boolean).join(', ') + '. Nothing is broken.'
      : `Everything that works on your live store also works on ${where}.`;
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
  const env = r.environment_id ? q.envById.get(r.environment_id) : null;
  const j = judge(cmp, env ? env.name : 'the draft');
  j.theme = { draft: dres.theme || null, live: JSON.parse(live.result_json).theme || null };
  j.scores = { draft: draft.score, live: live.score };
  q.finishRelease.run('done', j.verdict, JSON.stringify(j), releaseId);
  // Checks nobody is watching (daily, or started by a deploy pipeline) tell the owner when something needs a look.
  if (r.trigger !== 'manual' && j.verdict !== 'safe') notifyRelease(r, j).catch((e) => console.error('release notify failed', releaseId, e));
}

async function notifyRelease(r, j) {
  const store = q.storeById.get(r.store_id);
  if (!store) return;
  const env = r.environment_id ? q.envById.get(r.environment_id) : null;
  const name = store.name || new URL(store.url).host;
  const where = env?.name || 'your draft';
  const link = `${config.baseUrl}/app#/s/${store.id}/publish/${r.id}`;
  const subject = j.verdict === 'blocked' ? `Don't publish ${where} yet: ${name}` : `Review ${where} before publishing: ${name}`;
  const items = [...j.blockers, ...j.reviews].slice(0, 6).map((x) => `• ${x.title}: ${x.detail}`);
  const text = `${j.headline}\n\n${items.join('\n')}\n\nSide-by-side report: ${link}\n\n— Tharam`;
  const e = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1917"><p><b>${e(name)} · ${e(where)}</b></p><p>${e(j.headline)}</p>
<ul>${items.map((l) => `<li>${e(l.slice(2))}</li>`).join('')}</ul>
<p><a href="${link}" style="background:#14532d;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open the side-by-side report</a></p></div>`;
  const to = store.alert_email || q.userById.get(store.user_id)?.email;
  const slack = has(entitlements(store.user_id), 'slack') ? store.slack_webhook : null;
  await Promise.allSettled([sendMail({ to, subject, text, html }), sendSlack(slack, `*${subject}*\n${text}`)]);
}

/** Once a day, check environments that asked for it. Runs from the scheduler. */
export function dueEnvironmentChecks() {
  for (const env of q.autoEnvs.all()) {
    const store = q.storeById.get(env.store_id);
    if (!store || !store.last_run_at || q.activeRunForStore.get(store.id)) continue;
    const ent = entitlements(store.user_id);
    if (!envAllowed(ent, store.id, env.id) || blockReason(ent, store.id)) continue;
    const last = q.lastReleaseForEnv.get(env.id);
    if (last && (last.status === 'running' || Date.now() - new Date(last.created_at.replace(' ', 'T') + 'Z').getTime() < 23.5 * 3600e3)) continue;
    startRelease(store, { url: env.url, label: `Daily check of ${env.name}`, env, trigger: 'schedule' });
    return; // one at a time keeps the queue fair; the next one starts in 5 minutes
  }
}
