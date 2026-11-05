import { db, q } from './db.js';
import { runScan } from './engine/index.js';
import { handleAlerts } from './alerts.js';
import { storeConfig, saleActive } from './scheduler.js';
import { live } from './live.js';
import { settleRelease } from './release.js';
import { effectiveDisabled } from './engine/catalog.js';
import { shopForStore, activeCodes } from './shopify.js';
import { themeWatch } from './theme-watch.js';
import { check } from './engine/checks.js';
import { scoreChecks, summarize } from './engine/score.js';
import { entitlements, lockedGroups, blockReason, has } from './license.js';
import { aiEnabled } from './ai.js';
import { fullCheckInputs } from './runner-files.js';
import { usesAi, mainRunner, listRunners, healthy, chooseRunner, byPriority, wantedTags, L, leaseAge, LEASE_LIMIT_MS } from './runners.js';

/** Groups switched off for this run: the store's choices, markets, and anything the owner's plan doesn't include. */
function planDisabled(store, cfg, picked) {
  const base = effectiveDisabled(cfg, picked);
  if (!store) return base;
  return [...new Set([...base, ...lockedGroups(entitlements(store.user_id))])];
}

const waiting = [];
const running = new Map(); // runId -> { controller, job }  (checks on this server)
const remote = new Map(); // runId -> { job, runnerId, theme } (checks handed to a worker, or being prepared for one)
let active = 0;
let seq = 0;

/** What the router needs to know about a check, worked out once when it is queued. */
function routingInfo(store) {
  if (!store) return { sale: false, paid: false, tags: [] };
  const cfg = storeConfig(store);
  let plan = null;
  try { plan = entitlements(store.user_id).plan; } catch {}
  const paid = plan?.kind === 'paid';
  const sale = saleActive(cfg);
  return { sale, paid, tags: wantedTags({ sale, plan: paid ? plan.key : null, markets: cfg.markets || [] }) };
}

/**
 * Adds a run to the queue. The router (src/runners.js) hands it to the main server or to a worker;
 * with no workers, everything runs here as before.
 */
export function enqueue(job) {
  // Resolve what this run will test now, so a queued run can already show its plan.
  const store = job.storeId ? q.storeById.get(job.storeId) : null;
  const disabled = planDisabled(store, store ? storeConfig(store) : {}, job.disabled);
  live.set(job.runId, { phase: 'queued', kind: job.kind, disabled, rec: null });
  // A full check with AI review stays on the main server (the AI key never goes to workers).
  const needsAi = usesAi(job.kind, disabled, aiEnabled());
  Object.assign(job, routingInfo(store), { seqNo: ++seq, needsAi });
  waiting.push(job);
  pump();
}

/** `active`: checks running on this server; `remote`: checks on workers. */
export function queueDepth() {
  return { waiting: waiting.length, active, remote: remote.size };
}

/** Stops a queued or running test. Returns true if it was cancelled here. */
export function cancelRun(runId) {
  runId = Number(runId);
  const i = waiting.findIndex((j) => j.runId === runId);
  if (i !== -1) {
    const [job] = waiting.splice(i, 1);
    live.delete(runId);
    q.cancelRun.run(runId);
    if (job.release) settleRelease(job.release);
    return true;
  }
  const local = running.get(runId);
  if (local) {
    local.controller.abort();
    return true;
  }
  if (remote.has(runId)) {
    // The worker hears about it on its next check-in and stops; whatever it sends back afterwards is refused.
    for (const l of L.openForRun.all(runId)) L.finish.run('cancelled', l.id);
    remote.delete(runId);
    live.delete(runId);
    q.cancelRun.run(runId);
    setImmediate(pump);
    return true;
  }
  return false;
}

/** Every runner with its checks in use right now and whether it is healthy. */
export function runnerStates(now = Date.now()) {
  const main = mainRunner();
  const onWorkers = new Map();
  for (const x of remote.values()) onWorkers.set(x.runnerId, (onWorkers.get(x.runnerId) || 0) + 1);
  return listRunners().map((r) => ({ ...r, used: r.id === main.id ? active : onWorkers.get(r.id) || 0, healthy: healthy(r, now) }));
}

/** One check per store at a time (publish checks compare live and draft side by side, so they are exempt). */
function storeBusy(job) {
  if (!job.storeId || job.release) return false;
  for (const x of running.values()) if (x.job.storeId === job.storeId && !x.job.release) return true;
  for (const x of remote.values()) if (x.job.storeId === job.storeId && !x.job.release) return true;
  return false;
}

let pumping = false;
/** Hands waiting checks to runners with a free slot, most urgent first. */
export function pump() {
  if (pumping) return;
  pumping = true;
  try {
    recoverLost();
    if (!waiting.length) return;
    const states = runnerStates();
    const main = states.find((r) => r.kind === 'main');
    for (const job of waiting.slice().sort(byPriority)) {
      if (storeBusy(job)) continue;
      const r = chooseRunner(job, states);
      if (!r) continue;
      waiting.splice(waiting.indexOf(job), 1);
      r.used++;
      if (r.id === main.id) startLocal(job);
      else assignRemote(job, r);
    }
  } finally { pumping = false; }
}

function startLocal(job) {
  active++;
  const runningNow = execute(job);
  runningNow
    .catch((e) => console.error('run failed', job.runId, e))
    .finally(() => {
      active--;
      running.delete(job.runId);
      live.delete(job.runId);
      pump();
    });
}

/**
 * Everything a runner needs to run a check, worked out on the main server at the moment the check starts:
 * the store's latest settings, the licence (checked again here: every way of starting a test passes through
 * this line), the password and discount codes.
 */
async function prepare(job) {
  const { runId, kind, storeId, disabled, preview, captureOnly, release } = job;
  let { password } = job;
  const store = storeId ? q.storeById.get(storeId) : null;
  if (storeId && !store) throw new Error('Store was removed');
  if (store) {
    const ent = entitlements(store.user_id);
    const why = blockReason(ent, store.id) || (release && !has(ent, 'publish') ? 'Safe to publish is not included in your plan.' : null);
    if (why) throw new Error(why);
  }
  const cfg = store ? storeConfig(store) : {};
  // A staging environment brings its own password; everything else uses the live store's latest one.
  if (store && !job.ownPassword) password = store.storefront_password || password;
  // Shopify stores: the store's active discount codes are picked up automatically, alongside any typed in.
  let codes = cfg.discountCodes || [];
  const link = store ? shopForStore(store.id) : null;
  if (link && kind === 'full') {
    try {
      const fromShopify = await Promise.race([activeCodes(link.shop), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))]);
      const seen = new Set(codes.map((c) => c.code.toUpperCase()));
      codes = [...codes, ...fromShopify.filter((c) => !seen.has(c.code.toUpperCase()))].slice(0, 5);
    } catch (e) { console.error('discount codes from Shopify', link.shop, e.message); }
  }
  return {
    runId, origin: job.origin, kind, password, storeId,
    // A hand-picked selection overrides the store's suite for this run only.
    disabled: planDisabled(store, cfg, disabled),
    testProduct: cfg.testProduct || null, discountCodes: codes, preview: preview || null, captureOnly: !!captureOnly,
    // Script watch compares with the store's last check (read here, so a worker gets it in the spec).
    previousScripts: storeId && !release ? previousScripts(storeId, runId) : null,
  };
}

const THEME_SKIPPED = 'We couldn’t read your theme files from Shopify this time. We’ll try again on the next full check.';
const themeSkipped = () => ({ checks: [check('sec.theme', 'security', 'Theme code unchanged', 'skip', { severity: 'major', detail: THEME_SKIPPED })], commit: () => {} });

/**
 * Theme file fingerprints (Shopify stores, full checks). Read through the Admin API, so always on the main server:
 * the Shopify token never goes to a worker. Never rejects: if Shopify can't be reached in time the check is skipped
 * with a plain note and the record is kept, so the change is reported next time. Returns null when it doesn't apply.
 */
function readTheme(job, spec, limitMs = 90000) {
  const { storeId, kind, release, preview } = job;
  if (!storeId || kind !== 'full' || release || preview || (spec.disabled || []).includes('security.theme')) return null;
  const link = shopForStore(storeId);
  if (!link) return null;
  let timer;
  return Promise.race([
    themeWatch({ storeId, shop: link.shop }),
    new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('timeout')), limitMs))),
  ]).catch((e) => {
    console.error('theme files from Shopify', link.shop, e.message);
    return themeSkipped();
  }).finally(() => clearTimeout(timer));
}

/**
 * A check that ran on a worker: the theme checks (made here on the main server) join its result, and the score
 * is worked out again the same way the engine does. A check that could not finish gets none, like on the main server.
 */
export function withExtraChecks(result, checks) {
  if (!checks?.length || !result || result.error || !Array.isArray(result.checks)) return result;
  const all = [...result.checks.filter((c) => !checks.some((x) => x.id === c.id)), ...checks];
  const { score, verdict, categories } = scoreChecks(all);
  return { ...result, checks: all, score, verdict, categories, summary: summarize(all, verdict) };
}

/** Saves a finished check and does what follows it: store status, the confirming re-check, alerts. */
async function settle(job, result, theme = null) {
  const { runId, origin, kind, password, storeId, confirmed, release } = job;
  q.finishRun.run(result.score, result.verdict, JSON.stringify(result), runId);
  // The new theme record is saved only once the check is, so an interrupted check reports the change next time.
  if (theme && (result.checks || []).some((c) => c.id === 'sec.theme' && c.status !== 'skip')) { try { theme.commit(); } catch (e) { console.error('theme record save failed', storeId, e); } }
  // Publish-check runs (live and draft) never change the store's status and never alert.
  if (storeId && !release) {
    q.updateStoreAfterRun.run(result.verdict, result.score, storeId);
    // Only trust platform detection when the store actually loaded; an outage looks like an unknown platform.
    if (result.platform && (result.checks || []).some((c) => c.id === 'fn.home' && c.status === 'pass')) q.updateStorePlatform.run(result.platform.label, storeId);
    if (kind === 'full') q.markFullScan.run(storeId);
    // A critical check that just started failing is re-tested once before alerting,
    // so a one-off network blip never wakes a merchant up.
    const newlyCritical = (result.checks || []).some(
      (c) => c.status === 'fail' && c.severity === 'critical' && q.getCheckState.get(storeId, c.id)?.status !== 'failing'
    );
    if (newlyCritical && !confirmed) {
      setTimeout(() => {
        const info = q.insertRun.run(storeId, origin, 'journeys', null, 'confirm');
        enqueue({ runId: Number(info.lastInsertRowid), origin, kind: 'journeys', password, storeId, confirmed: true });
      }, 60 * 1000);
    } else {
      await handleAlerts(storeId, runId, result).catch((e) => console.error('alerts failed', e));
    }
  }
}

function settleReleaseOf(job) {
  if (job.release) { try { settleRelease(job.release); } catch (e) { console.error('release settle failed', job.release, e); } }
}

async function execute(job) {
  const { runId, kind } = job;
  const controller = new AbortController();
  running.set(runId, { controller, job });
  q.setRunRunning.run(runId);
  let timer;
  let timedOut = false;
  // At the limit, also close the browser so a stuck run doesn't keep working in the background.
  const hardLimit = new Promise((_, rej) => (timer = setTimeout(() => { timedOut = true; controller.abort(); rej(new Error('The test took longer than 6 minutes, so we stopped it. Your store may be very slow right now.')); }, 6 * 60 * 1000)));
  try {
    const spec = await prepare(job);
    const theme = await readTheme(job, spec);
    const result = await Promise.race([
      runScan({ ...spec, kind, extraChecks: theme?.checks || [], signal: controller.signal, progress: live.get(runId) }),
      hardLimit,
    ]);
    // Steps swallow their own errors, so a stopped run can still "finish". Never save or alert on it.
    if (controller.signal.aborted) throw new Error(timedOut ? 'timeout' : 'cancelled');
    await settle(job, result, theme);
  } catch (e) {
    if (controller.signal.aborted && !timedOut) q.cancelRun.run(runId);
    else q.failRun.run(String(e.message || e).slice(0, 300), runId);
  } finally {
    clearTimeout(timer);
    settleReleaseOf(job);
  }
}

// ---------------- checks on workers ----------------

// The lease keeps the job (without the password, which only the spec carries) so a finished check can still be
// saved after a main server restart.
const jobJson = (job) => JSON.stringify({ ...job, password: undefined });

/** Reserves a slot on the worker, prepares the check and leaves it for the worker's next check-in. */
function assignRemote(job, runner) {
  remote.set(job.runId, { job, runnerId: runner.id });
  prepare(job).then((spec) => {
    if (!remote.has(job.runId)) return; // cancelled meanwhile
    // A full check: which baselines and catalog snapshot the worker should fetch before it starts.
    if (spec.kind === 'full' && spec.storeId) spec.inputs = fullCheckInputs(spec.storeId, spec.runId);
    // Theme files are read here, on the main server, while the worker runs; they join the result when it comes back.
    const theme = readTheme(job, spec);
    if (theme) remote.get(job.runId).theme = theme;
    const attempt = L.attempts.get(job.runId).n + 1;
    L.insert.run(job.runId, runner.id, attempt, JSON.stringify(spec), jobJson(job));
  }).catch((e) => {
    remote.delete(job.runId);
    live.delete(job.runId);
    q.failRun.run(String(e.message || e).slice(0, 300), job.runId);
    settleReleaseOf(job);
    pump();
  });
}

/** A worker checks in: it gets the checks assigned to it, and the ones it should stop. */
export function workerCheckIn(runner, runningIds = []) {
  const ids = new Set(runningIds.map(Number));
  // Checks this worker holds but says it isn't running (it restarted): lost, and retried.
  for (const l of L.open.all()) {
    if (l.runner_id === runner.id && l.state === 'leased' && !ids.has(l.run_id) && leaseAge(l) > 15000) lose(l, 'The server running it restarted.');
  }
  pump();
  const jobs = [];
  for (const l of L.assignedFor.all(runner.id)) {
    if (L.take.run(l.id).changes !== 1) continue;
    q.setRunRunning.run(l.run_id);
    const p = live.get(l.run_id);
    if (p) p.phase = 'open';
    jobs.push(JSON.parse(l.spec_json));
  }
  const cancel = L.cancelledFor.all(runner.id).map((r) => r.run_id).filter((id) => ids.has(id));
  return { jobs, cancel };
}

/** The job behind a lease (from memory, or from the lease record after a main server restart). */
function jobOf(l) {
  return remote.get(l.run_id)?.job || { ...JSON.parse(l.job_json), password: JSON.parse(l.spec_json).password };
}

/**
 * A worker sends back a finished check. Accepted once, only from the worker that holds the lease;
 * a check that was cancelled, or moved to another runner, is refused (so a check never counts twice).
 */
export async function workerComplete(runner, runId, { result, error }) {
  const l = L.forRunner.get(Number(runId), runner.id);
  if (!l || l.state !== 'leased' || L.finish.run('done', l.id).changes !== 1) return false;
  const job = jobOf(l);
  const reading = remote.get(l.run_id)?.theme;
  remote.delete(l.run_id);
  live.delete(l.run_id);
  try {
    if (error) {
      if (error === 'cancelled') q.cancelRun.run(l.run_id);
      else q.failRun.run(String(error).slice(0, 300), l.run_id);
    } else {
      // Theme fingerprints need the Shopify token, so they are made here. Usually already read while the worker
      // ran; after a main server restart they are read now, with a shorter limit (the worker is waiting for the reply).
      const theme = await (reading || readTheme(job, JSON.parse(l.spec_json), 40000));
      await settle(job, withExtraChecks(result, theme?.checks), theme);
    }
  } finally {
    settleReleaseOf(job);
    setImmediate(pump);
  }
  return true;
}

/** Is this worker holding this check right now? (Screenshots are accepted only then.) */
export function holdsLease(runner, runId) {
  const l = L.forRunner.get(Number(runId), runner.id);
  return !!l && l.state === 'leased';
}

/** Progress from a worker, for the live view. */
export function workerProgress(runner, runId, progress = {}) {
  const p = live.get(Number(runId));
  if (!p || !holdsLease(runner, runId)) return;
  if (typeof progress.phase === 'string') p.phase = progress.phase.slice(0, 20);
  if (Array.isArray(progress.checks)) p.rec = { checks: progress.checks.slice(0, 200), steps: Array.isArray(progress.steps) ? progress.steps.slice(-40) : [] };
}

/**
 * A lease whose worker went quiet (no check-in for RUNNER_TIMEOUT_S), or that never came back, is retried once
 * on another runner; the second time the check fails with a plain message.
 */
function lose(l, why) {
  if (L.finish.run('lost', l.id).changes !== 1) return;
  const job = jobOf(l);
  remote.delete(l.run_id);
  if (L.attempts.get(l.run_id).n < 2) {
    q.requeueRun.run(l.run_id);
    const p = live.get(l.run_id);
    if (p) { p.phase = 'queued'; p.rec = null; } else live.set(l.run_id, { phase: 'queued', kind: job.kind, disabled: [], rec: null });
    waiting.push(Object.assign(job, { avoid: l.runner_id, retry: true, seqNo: job.seqNo ?? ++seq }));
  } else {
    live.delete(l.run_id);
    q.failRun.run(`We couldn't finish this check: ${why} We tried twice. The next scheduled check will run as usual.`.slice(0, 300), l.run_id);
    settleReleaseOf(job);
  }
}

function recoverLost(now = Date.now()) {
  const byId = new Map(listRunners().map((r) => [r.id, r]));
  for (const l of L.open.all()) {
    const r = byId.get(l.runner_id);
    if (!r || !healthy(r, now)) lose(l, 'The server running it stopped responding.');
    else if (l.state === 'leased' && leaseAge(l, now) > LEASE_LIMIT_MS) lose(l, 'It took far too long.');
  }
}

// Workers that go quiet are noticed even when nothing else happens.
const healthTimer = setInterval(() => { try { pump(); } catch (e) { console.error('runner health', e); } }, 5000);
healthTimer.unref?.();

/** The script inventory of the store's latest finished check before this one (any kind), or null. */
function previousScripts(storeId, runId) {
  const rows = db.prepare("SELECT result_json FROM runs WHERE store_id = ? AND id < ? AND status = 'done' AND (trigger IS NULL OR trigger != 'release') AND result_json LIKE '%\"scripts\":{%' ORDER BY id DESC LIMIT 5").all(storeId, runId);
  for (const row of rows) {
    try { const s = JSON.parse(row.result_json).scripts; if (s?.pages && Object.keys(s.pages).length) return { pages: s.pages }; } catch {}
  }
  return null;
}
