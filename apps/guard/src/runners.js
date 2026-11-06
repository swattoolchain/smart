/**
 * Runners: the machines that run checks. The main server is always one ("main"); worker machines join with a
 * one-time join token and then lease checks over an authenticated HTTPS API (src/runner-routes.js, src/worker.js).
 *
 * Part 1 scope: workers take scheduled and manual journey checks of monitored stores. Full checks, publish checks
 * and free checks stay on the main server, because they need data that lives there (visual baselines, the
 * catalog history, Shopify tokens).
 *
 * This module is the registry (database), runner credentials, and the routing rules as plain functions.
 */
import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';

db.exec(`
CREATE TABLE IF NOT EXISTS runners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'worker',          -- main | worker
  slots INTEGER NOT NULL DEFAULT 2,
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',        -- active | draining | paused | removed (credentials cleared for good)
  secret_hash TEXT,
  last_seen TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS runner_join_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  slots INTEGER NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  runner_id INTEGER
);
CREATE TABLE IF NOT EXISTS runner_leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  runner_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,                          -- assigned | leased | done | lost | cancelled
  spec_json TEXT NOT NULL,
  job_json TEXT NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  leased_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS runner_leases_run ON runner_leases(run_id);
CREATE INDEX IF NOT EXISTS runner_leases_open ON runner_leases(runner_id, state);
`);

const env = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
/** No heartbeat for this long: the runner gets no new checks and its unfinished checks move elsewhere. */
export const HEARTBEAT_TIMEOUT_MS = env('RUNNER_TIMEOUT_S', 60) * 1000;
/** A leased check that has not come back in this long is treated as lost (the worker's own limit is 6 minutes). */
export const LEASE_LIMIT_MS = env('RUNNER_LEASE_LIMIT_S', 8 * 60) * 1000;
const JOIN_TOKEN_HOURS = 24;
export const STATUSES = ['active', 'draining', 'paused'];
/** A founder removed the runner: its credentials no longer work and it never takes checks again. */
export const REMOVED = 'removed';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameHash = (a, b) => !!a && !!b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ms = (t) => (t ? new Date(t.includes('T') ? t : t.replace(' ', 'T') + 'Z').getTime() : 0);

/** Lowercase words, letters, digits and dashes only; at most 10. */
export function cleanTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
  return [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter((t) => /^[a-z0-9][a-z0-9-]{0,30}$/.test(t)))].slice(0, 10);
}
export function cleanName(name) {
  const n = String(name || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(n)) throw new Error('Use a short name: letters, digits, spaces, dots, dashes (up to 40).');
  return n;
}
export function cleanSlots(slots) {
  const n = Number(slots);
  if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error('Slots must be a whole number from 1 to 16.');
  return n;
}

const S = {
  main: db.prepare("SELECT * FROM runners WHERE kind = 'main'"),
  byId: db.prepare('SELECT * FROM runners WHERE id = ?'),
  byName: db.prepare('SELECT * FROM runners WHERE name = ?'),
  all: db.prepare("SELECT * FROM runners ORDER BY kind = 'main' DESC, id"),
  insertMain: db.prepare("INSERT INTO runners (name, kind, slots, status) VALUES ('main', 'main', ?, 'active')"),
  seen: db.prepare("UPDATE runners SET last_seen = datetime('now') WHERE id = ?"),
  tokenByHash: db.prepare('SELECT * FROM runner_join_tokens WHERE token_hash = ?'),
  insertToken: db.prepare("INSERT INTO runner_join_tokens (token_hash, name, slots, tags_json, created_by, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))"),
  useToken: db.prepare("UPDATE runner_join_tokens SET used_at = datetime('now'), runner_id = ? WHERE id = ? AND used_at IS NULL AND expires_at > datetime('now')"),
  insertRunner: db.prepare('INSERT INTO runners (name, kind, slots, tags_json, secret_hash, last_seen) VALUES (?, \'worker\', ?, ?, ?, datetime(\'now\'))'),
};

export const parseRunner = (r) => r && ({ ...r, tags: JSON.parse(r.tags_json || '[]') });

/** The main server's own row (created on first use). Its slots follow RUN_CONCURRENCY. */
export function mainRunner() {
  let r = S.main.get();
  if (!r) { S.insertMain.run(config.concurrency); r = S.main.get(); }
  if (r.slots !== config.concurrency) { db.prepare('UPDATE runners SET slots = ? WHERE id = ?').run(config.concurrency, r.id); r = S.main.get(); }
  return parseRunner(r);
}
export const runnerById = (id) => parseRunner(S.byId.get(Number(id)));
export const listRunners = () => { mainRunner(); return S.all.all().map(parseRunner); };

/** A worker is healthy while it keeps checking in. The main server is healthy while it runs. */
export function healthy(r, now = Date.now()) {
  return r.kind === 'main' || (!!r.last_seen && now - ms(r.last_seen) < HEARTBEAT_TIMEOUT_MS);
}

/** Founders create a one-time join token for a new worker. The token is shown once and stored hashed. */
export function createJoinToken({ name, slots = 2, tags = [] }, actor) {
  const n = cleanName(name);
  if (n.toLowerCase() === 'main' || S.byName.get(n)) throw new Error('A runner with this name already exists.');
  const token = `tjr_${crypto.randomBytes(24).toString('base64url')}`;
  S.insertToken.run(sha(token), n, cleanSlots(slots), JSON.stringify(cleanTags(tags)), actor || null, `+${JOIN_TOKEN_HOURS} hours`);
  return { token, name: n, expiresInHours: JOIN_TOKEN_HOURS };
}

/** A worker joins once with its token and gets its own credentials ("<id>.<secret>"). Null if the token is bad, used or expired. */
export function joinWithToken(token) {
  const t = S.tokenByHash.get(sha(token || ''));
  if (!t || t.used_at || ms(t.expires_at) <= Date.now()) return null;
  if (S.byName.get(t.name)) return null;
  const secret = crypto.randomBytes(32).toString('base64url');
  try {
    return db.transaction(() => {
      const info = S.insertRunner.run(t.name, t.slots, t.tags_json, sha(secret));
      const id = Number(info.lastInsertRowid);
      // Only one join can use the token, even if two arrive at once.
      if (S.useToken.run(id, t.id).changes !== 1) throw new Error('token used');
      return { runner: runnerById(id), credentials: `${id}.${secret}` };
    })();
  } catch { return null; }
}

/** The worker behind a request's credentials, or null. */
export function authRunner(credentials) {
  const m = /^(\d+)\.([A-Za-z0-9_-]{20,})$/.exec(String(credentials || ''));
  if (!m) return null;
  const r = S.byId.get(Number(m[1]));
  if (!r || r.kind !== 'worker' || r.status === REMOVED || !sameHash(r.secret_hash, sha(m[2]))) return null;
  return parseRunner(r);
}
export const touchRunner = (id) => S.seen.run(id);

/**
 * Founders remove a worker for good (a machine that was retired or may be compromised): its credentials are
 * cleared, so its next request is refused, and it never takes checks again. Its unfinished checks are moved
 * elsewhere by the queue (queue.js removeRunner). Returns [before, after].
 */
export function revokeRunner(id) {
  const before = runnerById(id);
  if (!before) throw new Error('Runner not found');
  if (before.kind === 'main') throw new Error('The main server cannot be removed.');
  if (before.status === REMOVED) throw new Error('This runner was already removed.');
  db.prepare('UPDATE runners SET secret_hash = NULL, status = ? WHERE id = ?').run(REMOVED, before.id);
  return [before, runnerById(id)];
}

/** Founders change a runner's status, tags and (workers only) slots. Returns [before, after]. */
export function updateRunner(id, patch) {
  const before = runnerById(id);
  if (!before) throw new Error('Runner not found');
  if (before.status === REMOVED) throw new Error('This runner was removed. To use the machine again, join it with a new token.');
  const next = { status: before.status, tags: before.tags, slots: before.slots };
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw new Error(`Status must be one of: ${STATUSES.join(', ')}.`);
    next.status = patch.status;
  }
  if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
  if (patch.slots !== undefined) {
    if (before.kind === 'main') throw new Error('The main server\'s slots come from RUN_CONCURRENCY.');
    next.slots = cleanSlots(patch.slots);
  }
  db.prepare('UPDATE runners SET status = ?, tags_json = ?, slots = ? WHERE id = ?').run(next.status, JSON.stringify(next.tags), next.slots, before.id);
  return [before, runnerById(id)];
}

// ---------------- routing (plain functions) ----------------

const REGION = { IN: 'india', DE: 'eu', AT: 'eu', EU: 'eu', UK: 'uk', US: 'us', CA: 'us', SG: 'asia', AE: 'asia', AU: 'au' };
/**
 * The runner tags a check prefers, most important first: 'sale' for stores in sale mode, the plan key
 * (e.g. 'pro'), then the regions the store sells in ('india', 'eu', 'us', …).
 */
export function wantedTags({ sale = false, plan = null, markets = [] } = {}) {
  return [...new Set([sale && 'sale', plan, ...markets.map((m) => REGION[m])].filter(Boolean))];
}

/** Workers take journey checks of monitored stores; everything else needs the main server's data. */
export function canRun(runner, job) {
  if (runner.kind === 'main') return true;
  return job.kind === 'journeys' && !!job.storeId && !job.release && !job.preview && !job.captureOnly;
}

/**
 * Picks the runner for a check. `runners`: [{ id, kind, status, slots, used, tags, healthy }].
 * Only active, healthy runners with a free slot that can run this kind of check. For each preferred tag in
 * order, the runners with that tag; if none has a free slot, any runner. Among those: most free slots
 * (the main server first on a tie, so nothing changes until workers have room).
 * `job.avoid`: a runner that lost this check before (its retry goes elsewhere when possible).
 * Pausing or draining the main server moves journey checks to workers, but never strands a check: checks only
 * the main server can run (free, full, publish) ignore its status, and so does everything while no active,
 * healthy worker exists.
 */
export function chooseRunner(job, runners) {
  const mainOnly = !canRun({ kind: 'worker' }, job);
  const anyWorker = runners.some((r) => r.kind !== 'main' && r.status === 'active' && r.healthy);
  const takes = (r) => r.status === 'active' || (r.kind === 'main' && (mainOnly || !anyWorker));
  const open = runners.filter((r) => takes(r) && r.healthy && r.slots - r.used > 0 && canRun(r, job));
  const pool = open.filter((r) => r.id !== job.avoid).length ? open.filter((r) => r.id !== job.avoid) : open;
  if (!pool.length) return null;
  const best = (list) => list.slice().sort((a, b) => (b.slots - b.used) - (a.slots - a.used) || (a.kind === 'main' ? -1 : b.kind === 'main' ? 1 : a.id - b.id))[0];
  for (const tag of job.tags || []) {
    const tagged = pool.filter((r) => r.tags.includes(tag));
    if (tagged.length) return best(tagged);
  }
  return best(pool);
}

/** Queue order when checks wait: sale-mode stores first, then paid plans, then first come first served. */
export function byPriority(a, b) {
  return (b.sale ? 1 : 0) - (a.sale ? 1 : 0) || (b.paid ? 1 : 0) - (a.paid ? 1 : 0) || (a.retry ? 0 : 1) - (b.retry ? 0 : 1) || a.seqNo - b.seqNo;
}

// ---------------- leases ----------------

export const L = {
  insert: db.prepare("INSERT INTO runner_leases (run_id, runner_id, attempt, state, spec_json, job_json) VALUES (?, ?, ?, 'assigned', ?, ?)"),
  assignedFor: db.prepare("SELECT * FROM runner_leases WHERE runner_id = ? AND state = 'assigned' ORDER BY id"),
  take: db.prepare("UPDATE runner_leases SET state = 'leased', leased_at = datetime('now') WHERE id = ? AND state = 'assigned'"),
  open: db.prepare("SELECT * FROM runner_leases WHERE state IN ('assigned', 'leased')"),
  openForRun: db.prepare("SELECT * FROM runner_leases WHERE run_id = ? AND state IN ('assigned', 'leased')"),
  forRunner: db.prepare('SELECT * FROM runner_leases WHERE run_id = ? AND runner_id = ? ORDER BY id DESC LIMIT 1'),
  finish: db.prepare("UPDATE runner_leases SET state = ?, finished_at = datetime('now') WHERE id = ? AND state IN ('assigned', 'leased')"),
  attempts: db.prepare('SELECT COUNT(*) n FROM runner_leases WHERE run_id = ?'),
  // Checks a worker must stop: cancelled by the owner, or lost (moved elsewhere after it went quiet), unless the
  // same worker holds the check again under a newer lease.
  cancelledFor: db.prepare(`SELECT DISTINCT l.run_id FROM runner_leases l WHERE l.runner_id = ? AND l.state IN ('cancelled', 'lost') AND l.finished_at > datetime('now', '-10 minutes')
    AND NOT EXISTS (SELECT 1 FROM runner_leases o WHERE o.run_id = l.run_id AND o.runner_id = l.runner_id AND o.state IN ('assigned', 'leased'))`),
  openForRunner: db.prepare("SELECT * FROM runner_leases WHERE runner_id = ? AND state IN ('assigned', 'leased')"),
  byRun: db.prepare('SELECT l.*, r.name AS runner_name FROM runner_leases l JOIN runners r ON r.id = l.runner_id WHERE l.run_id = ? ORDER BY l.id'),
  openCount: db.prepare("SELECT runner_id, COUNT(*) n FROM runner_leases WHERE state IN ('assigned', 'leased') GROUP BY runner_id"),
};
export const leaseAge = (l, now = Date.now()) => now - ms(l.leased_at || l.assigned_at);
