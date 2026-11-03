import { config } from './config.js';
import { q } from './db.js';
import { runScan } from './engine/index.js';
import { handleAlerts } from './alerts.js';

const waiting = [];
let active = 0;

/** Adds a run to the in-process queue. Runs execute with limited concurrency to keep the VM healthy. */
export function enqueue(job) {
  waiting.push(job);
  pump();
}

export function queueDepth() {
  return { waiting: waiting.length, active };
}

function pump() {
  while (active < config.concurrency && waiting.length) {
    const job = waiting.shift();
    active++;
    execute(job)
      .catch((e) => console.error('run failed', job.runId, e))
      .finally(() => {
        active--;
        pump();
      });
  }
}

async function execute({ runId, origin, kind, password, storeId, confirmed }) {
  q.setRunRunning.run(runId);
  let timer;
  const hardLimit = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('Scan took too long (over 6 minutes)')), 6 * 60 * 1000)));
  try {
    const result = await Promise.race([runScan({ runId, origin, kind, password, storeId }), hardLimit]);
    q.finishRun.run(result.score, result.verdict, JSON.stringify(result), runId);
    if (storeId) {
      q.updateStoreAfterRun.run(result.verdict, result.score, storeId);
      if (kind === 'full') q.markFullScan.run(storeId);
      // A critical check that just started failing is re-tested once before alerting,
      // so a one-off network blip never wakes a merchant up.
      const newlyCritical = (result.checks || []).some(
        (c) => c.status === 'fail' && c.severity === 'critical' && q.getCheckState.get(storeId, c.id)?.status !== 'failing'
      );
      if (newlyCritical && !confirmed) {
        setTimeout(() => {
          const info = q.insertRun.run(storeId, origin, 'journeys', null);
          enqueue({ runId: Number(info.lastInsertRowid), origin, kind: 'journeys', password, storeId, confirmed: true });
        }, 60 * 1000);
      } else {
        await handleAlerts(storeId, runId, result).catch((e) => console.error('alerts failed', e));
      }
    }
  } catch (e) {
    q.failRun.run(String(e.message || e).slice(0, 300), runId);
  } finally {
    clearTimeout(timer);
  }
}
