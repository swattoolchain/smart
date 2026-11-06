import { config } from './config.js';
import { db, q } from './db.js';
import { runScan } from './engine/index.js';
import { MIN_GAP_HOURS } from './engine/traffic.js';
import { handleAlerts } from './alerts.js';
import { storeConfig } from './scheduler.js';
import { live } from './live.js';
import { settleRelease } from './release.js';
import { effectiveDisabled } from './engine/catalog.js';
import { shopForStore, activeCodes } from './shopify.js';
import { entitlements, lockedGroups, blockReason, has } from './license.js';

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

/**
 * The sale traffic test runs at most every MIN_GAP_HOURS per store, whichever machine runs the check. The main
 * server keeps the time in the database and claims the slot before the check starts (one atomic update, so two
 * checks at once can't both take it). Returns what to tell the check: { lastAt } when it must skip, else {}.
 */
export function claimTrafficSlot(storeId, now = Date.now()) {
  const at = new Date(now).toISOString();
  const cutoff = new Date(now - MIN_GAP_HOURS * 3600e3).toISOString();
  const r = db.prepare('UPDATE stores SET traffic_last_at = ? WHERE id = ? AND (traffic_last_at IS NULL OR traffic_last_at <= ?)').run(at, storeId, cutoff);
  if (r.changes) return {};
  return { lastAt: db.prepare('SELECT traffic_last_at AS t FROM stores WHERE id = ?').get(storeId)?.t || at };
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
    if (store && !ownPassword) password = store.storefront_password || password;
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
    const off = planDisabled(store, cfg, disabled);
    // Sale traffic (opt-in): claim the store's 6-hour slot here, on the main server, only when the test will run.
    const traffic = store && kind === 'full' && !release && !preview && cfg.saleTraffic && !off.includes('sale.traffic')
      ? { shoppers: cfg.saleTrafficShoppers, ...claimTrafficSlot(store.id) } : null;
    const result = await Promise.race([
      // A hand-picked selection overrides the store's suite for this run only.
      runScan({ runId, origin, kind, password, storeId, disabled: off, testProduct: cfg.testProduct || null, discountCodes: codes, signal: controller.signal, progress: live.get(runId), preview, captureOnly, traffic }),
      hardLimit,
    ]);
    // Steps swallow their own errors, so a stopped run can still "finish". Never save or alert on it.
    if (controller.signal.aborted) throw new Error(timedOut ? 'timeout' : 'cancelled');
    q.finishRun.run(result.score, result.verdict, JSON.stringify(result), runId);
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
