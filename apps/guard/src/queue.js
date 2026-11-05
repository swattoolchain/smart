import { config } from './config.js';
import { db, q } from './db.js';
import { storePassword } from './secret.js';
import { runScan } from './engine/index.js';
import { handleAlerts } from './alerts.js';
import { storeConfig } from './scheduler.js';
import { live } from './live.js';
import { settleRelease } from './release.js';
import { effectiveDisabled } from './engine/catalog.js';
import { shopForStore, activeCodes } from './shopify.js';
import { themeWatch } from './theme-watch.js';
import { check } from './engine/checks.js';
import { entitlements, lockedGroups, blockReason, has } from './license.js';
import { attributeFailures } from './attribution.js';

/** Groups switched off for this run: the store's choices, markets, and anything the owner's plan doesn't include. */
function planDisabled(store, cfg, picked) {
  const base = effectiveDisabled(cfg, picked);
  if (!store) return base;
  return [...new Set([...base, ...lockedGroups(entitlements(store.user_id))])];
}

const waiting = [];
const running = new Map(); // runId -> AbortController
let active = 0;

/** Adds a run to the in-process queue. Runs execute with limited concurrency to keep the VM healthy. */
export function enqueue(job) {
  // Resolve what this run will test now, so a queued run can already show its plan.
  const store = job.storeId ? q.storeById.get(job.storeId) : null;
  const disabled = planDisabled(store, store ? storeConfig(store) : {}, job.disabled);
  live.set(job.runId, { phase: 'queued', kind: job.kind, disabled, rec: null });
  waiting.push(job);
  pump();
}

export function queueDepth() {
  return { waiting: waiting.length, active };
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
  const controller = running.get(runId);
  if (controller) {
    controller.abort();
    return true;
  }
  return false;
}

function pump() {
  while (active < config.concurrency && waiting.length) {
    const job = waiting.shift();
    active++;
    execute(job)
      .catch((e) => console.error('run failed', job.runId, e))
      .finally(() => {
        active--;
        running.delete(job.runId);
        live.delete(job.runId);
        pump();
      });
  }
}

async function execute({ runId, origin, kind, password, ownPassword, storeId, confirmed, disabled, preview, captureOnly, release }) {
  const controller = new AbortController();
  running.set(runId, controller);
  q.setRunRunning.run(runId);
  let timer;
  let timedOut = false;
  // At the limit, also close the browser so a stuck run doesn't keep working in the background.
  const hardLimit = new Promise((_, rej) => (timer = setTimeout(() => { timedOut = true; controller.abort(); rej(new Error('The test took longer than 6 minutes, so we stopped it. Your store may be very slow right now.')); }, 6 * 60 * 1000)));
  try {
    // Use the store's latest settings (test suite, test product, password) at the moment the run starts.
    const store = storeId ? q.storeById.get(storeId) : null;
    if (storeId && !store) throw new Error('Store was removed');
    // The licence is checked again here, at the moment the run starts: every way of starting a test passes through this line.
    if (store) {
      const ent = entitlements(store.user_id);
      const why = blockReason(ent, store.id) || (release && !has(ent, 'publish') ? 'Safe to publish is not included in your plan.' : null);
      if (why) throw new Error(why);
    }
    const cfg = store ? storeConfig(store) : {};
    // A staging environment brings its own password; everything else uses the live store's latest one.
    if (store && !ownPassword) password = storePassword(store) || password;
    // Shopify stores: the store's active discount codes are picked up automatically, alongside any typed in.
    let codes = cfg.discountCodes || [];
    const link = store ? shopForStore(store.id) : null;
    if (link && kind === 'full') {
      try {
        const live = await Promise.race([activeCodes(link.shop), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))]);
        const seen = new Set(codes.map((c) => c.code.toUpperCase()));
        codes = [...codes, ...live.filter((c) => !seen.has(c.code.toUpperCase()))].slice(0, 5);
      } catch (e) { console.error('discount codes from Shopify', link.shop, e.message); }
    }
    // Theme file fingerprints (Shopify stores, full checks): read through the Admin API, saved only once the run is.
    let theme = null;
    const runDisabled = planDisabled(store, cfg, disabled);
    if (link && kind === 'full' && !release && !preview && !runDisabled.includes('security.theme')) {
      try {
        theme = await Promise.race([themeWatch({ storeId, shop: link.shop }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 90000))]);
      } catch (e) {
        console.error('theme files from Shopify', link.shop, e.message);
        theme = { checks: [check('sec.theme', 'security', 'Theme code unchanged', 'skip', { severity: 'major', detail: 'We couldn’t read your theme files from Shopify this time. We’ll try again on the next full check.' })], commit: () => {} };
      }
    }
    const result = await Promise.race([
      // A hand-picked selection overrides the store's suite for this run only.
      runScan({ runId, origin, kind, password, storeId, disabled: runDisabled, extraChecks: theme?.checks || [], testProduct: cfg.testProduct || null, discountCodes: codes, signal: controller.signal, progress: live.get(runId), preview, captureOnly, previousScripts: storeId && !release ? previousScripts(storeId, runId) : null }),
      hardLimit,
    ]);
    // Steps swallow their own errors, so a stopped run can still "finish". Never save or alert on it.
    if (controller.signal.aborted) throw new Error(timedOut ? 'timeout' : 'cancelled');
    // A check that just broke: name the scripts that appeared since it last worked (report, email, Slack).
    if (storeId && !release) { try { attributeFailures(storeId, runId, result); } catch (e) { console.error('change attribution failed', runId, e.message); } }
    q.finishRun.run(result.score, result.verdict, JSON.stringify(result), runId);
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
  } catch (e) {
    if (controller.signal.aborted && !timedOut) q.cancelRun.run(runId);
    else q.failRun.run(String(e.message || e).slice(0, 300), runId);
  } finally {
    clearTimeout(timer);
    if (release) { try { settleRelease(release); } catch (e) { console.error('release settle failed', release, e); } }
  }
}

/** The script inventory of the store's latest finished check before this one (any kind), or null. */
function previousScripts(storeId, runId) {
  const rows = db.prepare("SELECT result_json FROM runs WHERE store_id = ? AND id < ? AND status = 'done' AND (trigger IS NULL OR trigger != 'release') AND result_json LIKE '%\"scripts\":{%' ORDER BY id DESC LIMIT 5").all(storeId, runId);
  for (const row of rows) {
    try { const s = JSON.parse(row.result_json).scripts; if (s?.pages && Object.keys(s.pages).length) return { pages: s.pages }; } catch {}
  }
  return null;
}
