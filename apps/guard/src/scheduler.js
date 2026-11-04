import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { config } from './config.js';
import { db, q } from './db.js';
import { enqueue } from './queue.js';

export function minutesSince(ts) {
  if (!ts) return Infinity;
  return (Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 60000;
}

export function storeConfig(store) {
  try {
    return JSON.parse(store.config_json || '{}');
  } catch {
    return {};
  }
}

export function intervals(store) {
  const cfg = storeConfig(store);
  return {
    journeyIntervalMin: cfg.journeyIntervalMin || config.journeyIntervalMin,
    fullIntervalMin: cfg.fullIntervalMin || config.fullScanIntervalMin,
  };
}

/** When the next scheduled test will run, in minutes from now (null if monitoring is paused). */
export function nextRunIn(store) {
  if (!store.monitoring) return null;
  const { journeyIntervalMin, fullIntervalMin } = intervals(store);
  const failing = store.last_status === 'critical';
  const j = (failing ? Math.min(30, journeyIntervalMin) : journeyIntervalMin) - minutesSince(store.last_run_at);
  const f = fullIntervalMin - minutesSince(store.last_full_at);
  return Math.max(0, Math.round(Math.min(j, f)));
}

export function startRun({ storeId, origin, kind, password, ip = null, trigger = 'manual' }) {
  const info = q.insertRun.run(storeId || null, origin, kind, ip, trigger);
  const runId = Number(info.lastInsertRowid);
  enqueue({ runId, origin, kind, password, storeId });
  return runId;
}

/** Every 5 minutes, queue monitoring runs for stores that are due. */
export function startScheduler() {
  cron.schedule('*/5 * * * *', () => {
    for (const s of q.monitoredStores.all()) {
      if (q.activeRunForStore.get(s.id)) continue;
      // Stores are never tested before their first (owner-started) check.
      if (!s.last_run_at) continue;
      const { journeyIntervalMin, fullIntervalMin } = intervals(s);
      const failingCritical = s.last_status === 'critical';
      const dueFull = minutesSince(s.last_full_at) >= fullIntervalMin;
      // Re-check failing stores sooner so recoveries arrive quickly.
      const interval = failingCritical ? Math.min(30, journeyIntervalMin) : journeyIntervalMin;
      const dueJourney = minutesSince(s.last_run_at) >= interval;
      if (dueFull) startRun({ storeId: s.id, origin: s.url, kind: 'full', password: s.storefront_password, trigger: 'schedule' });
      else if (dueJourney) startRun({ storeId: s.id, origin: s.url, kind: 'journeys', password: s.storefront_password, trigger: 'schedule' });
    }
    pruneOldRuns();
  });
  console.log(`scheduler on: default journeys every ${config.journeyIntervalMin}m, full every ${config.fullScanIntervalMin}m`);
}

/** Retention: free scans 30 days, journey runs 30 days, full checks 90 days. Screenshots go with their runs. */
function pruneOldRuns() {
  const old = db
    .prepare(
      `SELECT id FROM runs WHERE (kind IN ('free','journeys') AND created_at < datetime('now','-30 days'))
       OR (kind = 'full' AND created_at < datetime('now','-90 days')) LIMIT 500`
    )
    .all();
  for (const r of old) {
    fs.rmSync(path.join(config.dataDir, 'shots', `run-${r.id}`), { recursive: true, force: true });
    const catDir = path.join(config.dataDir, 'catalog');
    if (fs.existsSync(catDir)) for (const d of fs.readdirSync(catDir)) fs.rmSync(path.join(catDir, d, `run-${r.id}.json`), { force: true });
    db.prepare('DELETE FROM runs WHERE id = ?').run(r.id);
  }
}
