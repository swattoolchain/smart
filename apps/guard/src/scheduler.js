import cron from 'node-cron';
import { config } from './config.js';
import { db, q } from './db.js';
import { enqueue } from './queue.js';

function minutesSince(ts) {
  if (!ts) return Infinity;
  return (Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 60000;
}

export function startRun({ storeId, origin, kind, password, ip = null }) {
  const info = q.insertRun.run(storeId || null, origin, kind, ip);
  const runId = Number(info.lastInsertRowid);
  enqueue({ runId, origin, kind, password, storeId });
  return runId;
}

/** Every 5 minutes, queue monitoring runs for stores that are due. */
export function startScheduler() {
  cron.schedule('*/5 * * * *', () => {
    for (const s of q.monitoredStores.all()) {
      if (q.activeRunForStore.get(s.id)) continue;
      const failingCritical = s.last_status === 'critical';
      const dueFull = minutesSince(s.last_full_at) >= config.fullScanIntervalMin;
      // Re-check failing stores sooner so recoveries (and confirmations) arrive quickly.
      const interval = failingCritical ? Math.min(30, config.journeyIntervalMin) : config.journeyIntervalMin;
      const dueJourney = minutesSince(s.last_run_at) >= interval;
      if (dueFull) startRun({ storeId: s.id, origin: s.url, kind: 'full', password: s.storefront_password });
      else if (dueJourney) startRun({ storeId: s.id, origin: s.url, kind: 'journeys', password: s.storefront_password });
    }
    // Keep the database and screenshot folder from growing forever: free scans older than 30 days are pruned.
    db.prepare("DELETE FROM runs WHERE kind = 'free' AND created_at < datetime('now', '-30 days')").run();
  });
  console.log(`scheduler on: journeys every ${config.journeyIntervalMin}m, full scan every ${config.fullScanIntervalMin}m`);
}
