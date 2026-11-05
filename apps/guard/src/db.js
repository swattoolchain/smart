import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'shots'), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'baselines'), { recursive: true });

export const db = new Database(path.join(config.dataDir, 'guard.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  plan TEXT NOT NULL DEFAULT 'beta',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  name TEXT,
  storefront_password TEXT,
  alert_email TEXT,
  slack_webhook TEXT,
  monitoring INTEGER NOT NULL DEFAULT 1,
  last_status TEXT,
  last_score INTEGER,
  last_run_at TEXT,
  last_full_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,           -- free | journeys | full
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | error | cancelled
  score INTEGER,
  verdict TEXT,                 -- healthy | warning | critical
  result_json TEXT,
  error TEXT,
  requester_ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_store ON runs(store_id, id DESC);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  store_url TEXT,
  run_id INTEGER,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  check_id TEXT NOT NULL,
  state TEXT NOT NULL,          -- failing | recovered
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  preview_url TEXT NOT NULL,
  label TEXT,
  live_run_id INTEGER,
  draft_run_id INTEGER,
  status TEXT NOT NULL DEFAULT 'running', -- running | done | error | cancelled
  verdict TEXT,                           -- safe | review | blocked
  summary_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS releases_store ON releases(store_id, id DESC);
CREATE TABLE IF NOT EXISTS environments (
  id INTEGER PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- theme (a Shopify theme preview link) | store (a separate staging store or site)
  url TEXT NOT NULL,
  password TEXT,
  auto TEXT NOT NULL DEFAULT 'off',       -- off | daily
  token TEXT UNIQUE,                      -- lets a deploy pipeline start a check without logging in
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS environments_store ON environments(store_id, id);
CREATE TABLE IF NOT EXISTS check_state (
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  check_id TEXT NOT NULL,
  status TEXT NOT NULL,
  since TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (store_id, check_id)
);
`);

// Lightweight migrations for columns added after launch.
function ensureColumn(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
ensureColumn('stores', 'config_json', "TEXT NOT NULL DEFAULT '{}'");
ensureColumn('stores', 'platform', 'TEXT');
ensureColumn('runs', 'trigger', 'TEXT');
ensureColumn('alerts', 'title', 'TEXT');
ensureColumn('releases', 'environment_id', 'INTEGER');
// Numbers people see (#1, #2, ...) count per store, never across all customers.
ensureColumn('runs', 'seq', 'INTEGER');
ensureColumn('releases', 'seq', 'INTEGER');
db.exec(`UPDATE runs SET seq = (SELECT COUNT(*) FROM runs r2 WHERE r2.store_id = runs.store_id AND r2.id <= runs.id AND (r2.trigger IS NULL OR r2.trigger != 'release')) WHERE seq IS NULL AND store_id IS NOT NULL AND (trigger IS NULL OR trigger != 'release');
UPDATE releases SET seq = (SELECT COUNT(*) FROM releases r2 WHERE r2.store_id = releases.store_id AND r2.id <= releases.id) WHERE seq IS NULL;`);
ensureColumn('releases', 'trigger', "TEXT NOT NULL DEFAULT 'manual'");
// Browser access for accounts created by a Shopify install, and "sign out everywhere".
ensureColumn('users', 'login_email', 'TEXT');
ensureColumn('users', 'session_epoch', 'INTEGER NOT NULL DEFAULT 0');
// Capacity: when a check actually got a browser (queue wait = started_at - created_at), and when a scheduled check was due.
ensureColumn('runs', 'started_at', 'TEXT');
ensureColumn('runs', 'due_at', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_login_email ON users(login_email) WHERE login_email IS NOT NULL');

export const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, email, name, plan, created_at, login_email FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)'),
  storesByUser: db.prepare('SELECT * FROM stores WHERE user_id = ? ORDER BY id'),
  storeById: db.prepare('SELECT * FROM stores WHERE id = ?'),
  insertStore: db.prepare(
    'INSERT INTO stores (user_id, url, name, storefront_password, alert_email, slack_webhook, config_json, platform, monitoring) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  updateStoreConfig: db.prepare('UPDATE stores SET config_json = ? WHERE id = ?'),
  updateStorePlatform: db.prepare('UPDATE stores SET platform = ? WHERE id = ?'),
  updatePassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  updateUserName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
  failingChecks: db.prepare("SELECT check_id, since FROM check_state WHERE store_id = ? AND status = 'failing'"),
  recentAlertsForUser: db.prepare('SELECT a.*, s.name AS store_name, s.url AS store_url FROM alerts a JOIN stores s ON s.id = a.store_id WHERE s.user_id = ? ORDER BY a.id DESC LIMIT 20'),
  updateStoreSettings: db.prepare(
    'UPDATE stores SET name = ?, storefront_password = ?, alert_email = ?, slack_webhook = ?, monitoring = ? WHERE id = ?'
  ),
  deleteStore: db.prepare('DELETE FROM stores WHERE id = ? AND user_id = ?'),
  monitoredStores: db.prepare('SELECT * FROM stores WHERE monitoring = 1'),
  insertRun: { run: (storeId, url, kind, ip, trigger) => db.prepare(`INSERT INTO runs (store_id, url, kind, requester_ip, trigger, seq) VALUES (?, ?, ?, ?, ?, CASE WHEN ? IS NULL OR ? = 'release' THEN NULL ELSE (SELECT COALESCE(MAX(seq), 0) + 1 FROM runs WHERE store_id = ? AND (trigger IS NULL OR trigger != 'release')) END)`).run(storeId, url, kind, ip, trigger, storeId, trigger, storeId) },
  runById: db.prepare('SELECT * FROM runs WHERE id = ?'),
  runsByStore: db.prepare(
    "SELECT id, seq, kind, status, score, verdict, trigger, error, created_at, finished_at, json_array_length(result_json, '$.checks') AS checks FROM runs WHERE store_id = ? AND (trigger IS NULL OR trigger != 'release') ORDER BY id DESC LIMIT ?"
  ),
  setRunRunning: db.prepare("UPDATE runs SET status = 'running', started_at = datetime('now') WHERE id = ?"),
  setRunDue: db.prepare('UPDATE runs SET due_at = ? WHERE id = ?'),
  finishRun: db.prepare(
    "UPDATE runs SET status = 'done', score = ?, verdict = ?, result_json = ?, finished_at = datetime('now') WHERE id = ?"
  ),
  failRun: db.prepare("UPDATE runs SET status = 'error', error = ?, finished_at = datetime('now') WHERE id = ?"),
  cancelRun: db.prepare("UPDATE runs SET status = 'cancelled', error = 'Stopped by you', finished_at = datetime('now') WHERE id = ?"),
  recentFreeRunsByIp: db.prepare(
    "SELECT COUNT(*) AS n FROM runs WHERE kind = 'free' AND requester_ip = ? AND created_at > datetime('now', '-1 hour')"
  ),
  recentFreeRunForUrl: db.prepare(
    "SELECT * FROM runs WHERE kind = 'free' AND url = ? AND status IN ('queued','running','done') AND created_at > datetime('now', '-1 hour') ORDER BY id DESC LIMIT 1"
  ),
  activeRunForStore: db.prepare(
    "SELECT id FROM runs WHERE store_id = ? AND status IN ('queued','running') LIMIT 1"
  ),
  updateStoreAfterRun: db.prepare(
    "UPDATE stores SET last_status = ?, last_score = ?, last_run_at = datetime('now') WHERE id = ?"
  ),
  markFullScan: db.prepare("UPDATE stores SET last_full_at = datetime('now') WHERE id = ?"),
  insertLead: db.prepare('INSERT INTO leads (email, store_url, run_id, source) VALUES (?, ?, ?, ?)'),
  getCheckState: db.prepare('SELECT * FROM check_state WHERE store_id = ? AND check_id = ?'),
  upsertCheckState: db.prepare(
    "INSERT INTO check_state (store_id, check_id, status, since) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(store_id, check_id) DO UPDATE SET status = excluded.status, since = datetime('now')"
  ),
  insertAlert: db.prepare('INSERT INTO alerts (store_id, check_id, state, message, title) VALUES (?, ?, ?, ?, ?)'),
  alertsByStore: db.prepare('SELECT * FROM alerts WHERE store_id = ? ORDER BY id DESC LIMIT 30'),
  insertRelease: db.prepare('INSERT INTO releases (store_id, preview_url, label, environment_id, trigger, seq) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM releases WHERE store_id = ?))'),
  envsByStore: db.prepare('SELECT * FROM environments WHERE store_id = ? ORDER BY id'),
  envById: db.prepare('SELECT * FROM environments WHERE id = ?'),
  envByToken: db.prepare('SELECT * FROM environments WHERE token = ?'),
  insertEnv: db.prepare('INSERT INTO environments (store_id, name, kind, url, password, auto, token) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updateEnv: db.prepare('UPDATE environments SET name = ?, kind = ?, url = ?, password = ?, auto = ? WHERE id = ?'),
  setEnvToken: db.prepare('UPDATE environments SET token = ? WHERE id = ?'),
  deleteEnv: db.prepare('DELETE FROM environments WHERE id = ?'),
  autoEnvs: db.prepare("SELECT e.* FROM environments e JOIN stores s ON s.id = e.store_id WHERE e.auto = 'daily' AND s.monitoring = 1"),
  lastReleaseForEnv: db.prepare('SELECT * FROM releases WHERE environment_id = ? ORDER BY id DESC LIMIT 1'),
  setReleaseRuns: db.prepare('UPDATE releases SET live_run_id = ?, draft_run_id = ? WHERE id = ?'),
  releaseById: db.prepare('SELECT * FROM releases WHERE id = ?'),
  releasesByStore: db.prepare('SELECT * FROM releases WHERE store_id = ? ORDER BY id DESC LIMIT 50'),
  finishRelease: db.prepare("UPDATE releases SET status = ?, verdict = ?, summary_json = ?, finished_at = datetime('now') WHERE id = ?"),
  staleReleases: db.prepare("UPDATE releases SET status = 'error', finished_at = datetime('now') WHERE status = 'running'"),
  staleRuns: db.prepare("UPDATE runs SET status = 'error', error = 'Interrupted by restart' WHERE status IN ('queued','running')"),
};

// Runs that were in flight when the process stopped will never finish.
q.staleRuns.run();
q.staleReleases.run();
