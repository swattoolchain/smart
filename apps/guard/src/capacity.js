/**
 * Capacity: how busy the check machine is, for the founder console, and an email to the founder when it is
 * time to add a worker. Read-only: nothing here changes schedules or runs.
 *
 *   browser minutes  time a check had a browser open (started_at → finished_at, or now while running)
 *   slots            RUN_CONCURRENCY checks at once; peak = most checks running at the same moment
 *   late starts      scheduled checks: started_at minus the time the check was due (due_at, else created_at)
 *   duration         started_at → finished_at, by kind of check (queue wait is not included)
 *
 * Runs from before started_at existed have no start time and are left out of these numbers.
 */
import fs from 'node:fs';
import os from 'node:os';
import { config } from './config.js';
import { db } from './db.js';
import { sendMail } from './alerts.js';
import { ensureLicense, getPlan } from './license.js';

export const LATE_MIN = 10; // a scheduled check starting more than this many minutes late counts as late
export const BUSY_PCT = 60; // slot use above this, averaged over the last hour, counts as busy
const REALERT_MS = 6 * 3600e3; // after an alert, the same alert is not sent again for 6 hours even if it clears and returns

db.exec(`CREATE TABLE IF NOT EXISTS capacity_alerts (
  kind TEXT PRIMARY KEY,          -- late | busy
  active INTEGER NOT NULL DEFAULT 0,
  since TEXT,
  last_sent_at TEXT,
  detail TEXT
)`);

const ms = (s) => (s ? new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z')).getTime() : null);
export const sqlTime = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
const day = (t) => new Date(t).toISOString().slice(0, 10);
const round1 = (n) => Math.round(n * 10) / 10;

/** Nearest-rank percentile of a list of numbers (null for an empty list). */
export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

/** Most intervals open at the same moment. An interval ending exactly when another starts doesn't overlap it. */
export function peakOverlap(intervals) {
  const ev = [];
  for (const [a, b] of intervals) if (b > a) ev.push([a, 1], [b, -1]);
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0, peak = 0;
  for (const [, d] of ev) { cur += d; peak = Math.max(peak, cur); }
  return peak;
}

const KIND = { free: 'Free website check', journeys: 'Shopping check', full: 'Full check' };
const kindLabel = (r) => (r.trigger === 'release' ? 'Safe to publish' : KIND[r.kind] || r.kind);

function planNamer() {
  const cache = new Map();
  return (userId) => {
    if (!userId) return 'Free website checks';
    if (!cache.has(userId)) {
      let name = 'Unknown';
      try { const l = ensureLicense(userId); name = getPlan(l.plan_key)?.name || l.plan_key; } catch {}
      cache.set(userId, name);
    }
    return cache.get(userId);
  };
}

/** Runs that had a browser open at any point since `from`, plus everything still queued or running. */
function runsSince(from) {
  return db.prepare(`SELECT r.id, r.kind, r.trigger, r.status, r.created_at, r.started_at, r.finished_at, r.due_at, s.user_id
      FROM runs r LEFT JOIN stores s ON s.id = r.store_id
      WHERE r.status IN ('queued','running') OR COALESCE(r.finished_at, r.started_at, r.created_at) >= ?`).all(sqlTime(from));
}

/** Browser time of a run as [start, end] in ms, or null if it never started. Running checks count up to now. */
function span(r, now) {
  const a = ms(r.started_at);
  if (a == null) return null;
  const b = ms(r.finished_at) ?? (r.status === 'running' ? now : null);
  return b == null ? null : [a, Math.max(a, Math.min(b, now))];
}

/** Minutes a scheduled check started after it was due (never negative). */
function lateness(r) {
  const s = ms(r.started_at);
  const due = ms(r.due_at) ?? ms(r.created_at);
  return s == null || due == null ? null : Math.max(0, (s - due) / 60000);
}

/** Average share of slots in use over [from, to], from the runs' browser time. */
function slotUse(spans, from, to, slots) {
  let busy = 0;
  for (const [a, b] of spans) busy += Math.max(0, Math.min(b, to) - Math.max(a, from));
  return (busy / ((to - from) * slots)) * 100;
}

function machine() {
  const m = { rssMb: Math.round(process.memoryUsage().rss / 1048576), memTotalMb: Math.round(os.totalmem() / 1048576), memFreeMb: Math.round(os.freemem() / 1048576), load1: round1(os.loadavg()[0]), cpus: os.cpus().length };
  m.memUsedPct = Math.round((1 - m.memFreeMb / m.memTotalMb) * 100);
  try {
    const st = fs.statfsSync(config.dataDir);
    const total = st.blocks * st.bsize, free = st.bavail * st.bsize;
    Object.assign(m, { diskTotalGb: round1(total / 1073741824), diskFreeGb: round1(free / 1073741824), diskUsedPct: Math.round((1 - free / total) * 100) });
  } catch {}
  return m;
}

/** Late scheduled checks: started in the last hour more than LATE_MIN late, or still waiting more than LATE_MIN after they were due. */
function lateNow(runs, now) {
  const started = runs.filter((r) => r.trigger === 'schedule' && ms(r.started_at) >= now - 3600e3).map((r) => lateness(r)).filter((x) => x > LATE_MIN);
  const waiting = runs.filter((r) => r.trigger === 'schedule' && r.status === 'queued' && (now - (ms(r.due_at) ?? ms(r.created_at))) / 60000 > LATE_MIN);
  const worst = Math.max(0, ...started, ...waiting.map((r) => (now - (ms(r.due_at) ?? ms(r.created_at))) / 60000));
  return { started: started.length, waiting: waiting.length, worstMin: Math.round(worst) };
}

/**
 * Everything the Capacity page shows. `queue` is the in-process queue ({ waiting, active }), passed in so this
 * module never starts checks itself.
 */
export function capacityReport({ now = Date.now(), days = 7, queue = { waiting: 0, active: 0 } } = {}) {
  const slots = config.concurrency;
  const dayStart = new Date(day(now) + 'T00:00:00Z').getTime();
  const from = dayStart - (days - 1) * 864e5;
  const runs = runsSince(from);
  const plan = planNamer();
  const spans = [];
  const dayList = Array.from({ length: days }, (_, i) => day(from + i * 864e5)).reverse();
  const minutes = Object.fromEntries(dayList.map((d) => [d, { date: d, total: 0, byPlan: {}, checks: 0 }]));
  const plans = new Set();
  const durations = {};
  const late = [];
  for (const r of runs) {
    const sp = span(r, now);
    if (sp) {
      spans.push(sp);
      // Browser minutes go to the day the check started on (UTC).
      const d = minutes[day(sp[0])];
      if (d && sp[0] >= from) {
        const m = (sp[1] - sp[0]) / 60000;
        const p = plan(r.user_id);
        plans.add(p);
        d.total += m; d.byPlan[p] = (d.byPlan[p] || 0) + m; d.checks++;
      }
      if (r.finished_at && r.status !== 'cancelled' && sp[0] >= from) (durations[kindLabel(r)] ||= []).push((sp[1] - sp[0]) / 1000);
    }
    if (r.trigger === 'schedule' && ms(r.started_at) >= from) late.push(lateness(r));
  }
  for (const d of Object.values(minutes)) { d.total = round1(d.total); for (const k in d.byPlan) d.byPlan[k] = round1(d.byPlan[k]); }
  const peaks = dayList.map((d) => {
    const a = new Date(d + 'T00:00:00Z').getTime(), b = Math.min(a + 864e5, now);
    const peak = peakOverlap(spans.map(([x, y]) => [Math.max(x, a), Math.min(y, b)]));
    return { date: d, peak, pct: Math.round((peak / slots) * 100) };
  });
  const oldest = db.prepare("SELECT MIN(created_at) AS t FROM runs WHERE status = 'queued'").get().t;
  const lastHour = Math.round(slotUse(spans, now - 3600e3, now, slots));
  return {
    now: sqlTime(now), days, slots, thresholds: { lateMin: LATE_MIN, busyPct: BUSY_PCT },
    queue: { waiting: queue.waiting, active: queue.active, oldestWaitingMin: oldest ? Math.max(0, Math.round((now - ms(oldest)) / 60000)) : null },
    browserMinutes: { days: dayList.map((d) => minutes[d]), plans: [...plans].sort(), total: round1(Object.values(minutes).reduce((n, d) => n + d.total, 0)) },
    slotUse: { lastHourPct: lastHour, peaks, peak: Math.max(0, ...peaks.map((p) => p.peak)) },
    lateStarts: {
      count: late.length,
      medianMin: late.length ? round1(percentile(late, 50)) : null,
      p95Min: late.length ? round1(percentile(late, 95)) : null,
      overLimit: late.filter((x) => x > LATE_MIN).length,
      now: lateNow(runs, now),
    },
    durations: Object.entries(durations).map(([kind, v]) => ({ kind, count: v.length, medianSec: Math.round(percentile(v, 50)), p95Sec: Math.round(percentile(v, 95)), avgSec: Math.round(v.reduce((a, b) => a + b, 0) / v.length) }))
      .sort((a, b) => b.count - a.count),
    machine: machine(),
    alerts: db.prepare('SELECT * FROM capacity_alerts ORDER BY kind').all(),
  };
}

const ALERT_TEXT = {
  late: (d, r) => ({
    subject: '[capacity] Scheduled checks are starting late',
    text: `${d.started ? `${d.started} scheduled check${d.started === 1 ? '' : 's'} started more than ${LATE_MIN} minutes late in the last hour` : ''}${d.started && d.waiting ? ', and ' : ''}${d.waiting ? `${d.waiting} scheduled check${d.waiting === 1 ? ' is' : 's are'} still waiting more than ${LATE_MIN} minutes after ${d.waiting === 1 ? 'it was' : 'they were'} due` : ''}. The longest wait was ${d.worstMin} minutes.\n\n`
      + `Right now: ${r.queue.active} of ${r.slots} check slots busy, ${r.queue.waiting} waiting. Slot use over the last hour: ${r.slotUse.lastHourPct}%.\n\n`
      + `Stores are being checked less often than they pay for. Time to add a worker, or raise RUN_CONCURRENCY if the machine has room (memory used: ${r.machine.memUsedPct}%).\n\n`
      + `Capacity page: ${config.baseUrl}/app#/admin/capacity\n\nYou won't get this email again while it stays this way.`,
  }),
  busy: (d, r) => ({
    subject: `[capacity] Check slots ${d.pct}% busy for the last hour`,
    text: `On average ${d.pct}% of the ${r.slots} check slots were in use over the last hour (alert above ${BUSY_PCT}%). At this level a few more stores, or a sale, will make scheduled checks start late.\n\n`
      + `Right now: ${r.queue.active} of ${r.slots} busy, ${r.queue.waiting} waiting. Late starts in the last 7 days: median ${r.lateStarts.medianMin ?? 0} min, p95 ${r.lateStarts.p95Min ?? 0} min.\n\n`
      + `Plan a worker before the next busy period. Memory used: ${r.machine.memUsedPct}%${r.machine.diskFreeGb != null ? `, disk free: ${r.machine.diskFreeGb} GB` : ''}.\n\n`
      + `Capacity page: ${config.baseUrl}/app#/admin/capacity\n\nYou won't get this email again while it stays this way.`,
  }),
};

/**
 * Called by the scheduler every 5 minutes. Emails the founder once when a condition starts; nothing more while
 * it lasts. When it clears it re-arms, but the same alert is not repeated within 6 hours of the last one.
 * Returns the alerts sent, for tests and logs.
 */
export async function checkCapacityAlerts({ now = Date.now(), queue = { waiting: 0, active: 0 } } = {}) {
  const r = capacityReport({ now, queue });
  const ln = r.lateStarts.now;
  const conds = {
    late: ln.started + ln.waiting > 0 ? ln : null,
    busy: r.slotUse.lastHourPct > BUSY_PCT ? { pct: r.slotUse.lastHourPct } : null,
  };
  const get = db.prepare('SELECT * FROM capacity_alerts WHERE kind = ?');
  const put = db.prepare(`INSERT INTO capacity_alerts (kind, active, since, last_sent_at, detail) VALUES (@kind, @active, @since, @last_sent_at, @detail)
    ON CONFLICT(kind) DO UPDATE SET active = excluded.active, since = excluded.since, last_sent_at = excluded.last_sent_at, detail = excluded.detail`);
  const sent = [];
  for (const [kind, d] of Object.entries(conds)) {
    const prev = get.get(kind) || { kind, active: 0, since: null, last_sent_at: null, detail: null };
    if (!d) { if (prev.active) put.run({ ...prev, active: 0 }); continue; }
    if (prev.active) continue; // still going: already told
    const row = { kind, active: 1, since: sqlTime(now), last_sent_at: prev.last_sent_at, detail: JSON.stringify(d) };
    if (!prev.last_sent_at || now - ms(prev.last_sent_at) >= REALERT_MS) {
      const m = ALERT_TEXT[kind](d, r);
      if (config.adminEmail) await sendMail({ to: config.adminEmail, ...m }).catch((e) => console.error('capacity alert mail failed', e.message));
      row.last_sent_at = sqlTime(now);
      sent.push({ kind, ...m });
    }
    put.run(row);
  }
  return sent;
}
