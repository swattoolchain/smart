/**
 * The runner API: workers join with a one-time token, check in (heartbeat + new checks + checks to stop),
 * upload screenshots and send results back. Founders manage runners in the console.
 *
 * Worker requests carry "Authorization: Runner <id>.<secret>". Every worker route is refused without it, and a
 * worker can only touch checks it currently holds.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { audit } from './license.js';
import { createJoinToken, joinWithToken, authRunner, touchRunner, updateRunner, runnerById, L } from './runners.js';
import { workerCheckIn, workerComplete, workerProgress, holdsLease, runnerStates, currentChecks } from './queue.js';
import { runnerReport, recentRuns } from './usage.js';

export const RUNNER_TYPE = 'application/vnd.tharam.runner+json';

function worker(req, res, next) {
  const m = /^Runner\s+(\S+)$/i.exec(req.get('authorization') || '');
  const r = m && authRunner(m[1]);
  if (!r) return res.status(401).json({ error: 'Unknown runner' });
  req.runner = r;
  next();
}

export function runnerRoutes(app, { requireUser, isAdmin }) {
  const big = express.json({ type: RUNNER_TYPE, limit: '20mb' });
  const small = express.json({ type: RUNNER_TYPE, limit: '2mb' });

  // ---- workers ----
  app.post('/api/runner/join', small, (req, res) => {
    const joined = joinWithToken(String(req.body?.token || ''));
    if (!joined) return res.status(401).json({ error: 'This join token is wrong, expired or already used. Ask for a new one in the founder console.' });
    audit(`runner:${joined.runner.name}`, null, 'runner.join', { runner: joined.runner.name, slots: joined.runner.slots, tags: joined.runner.tags });
    res.status(201).json({ id: joined.runner.id, name: joined.runner.name, slots: joined.runner.slots, tags: joined.runner.tags, credentials: joined.credentials });
  });

  app.post('/api/runner/check-in', small, worker, (req, res) => {
    const body = req.body || {};
    // The check-in is the heartbeat: a worker that stops checking in gets no new checks.
    touchRunner(req.runner.id);
    const runningIds = Array.isArray(body.running) ? body.running.map(Number).filter(Number.isInteger) : [];
    for (const [id, p] of Object.entries(body.progress || {})) workerProgress(req.runner, id, p || {});
    const { jobs, cancel } = workerCheckIn(req.runner, runningIds);
    const me = runnerById(req.runner.id);
    res.json({ name: me.name, slots: me.slots, status: me.status, jobs, cancel });
  });

  app.post('/api/runner/runs/:id/shots/:file', express.raw({ type: 'image/png', limit: '10mb' }), worker, (req, res) => {
    const runId = Number(req.params.id);
    if (!/^[\w.-]{1,80}\.png$/.test(req.params.file)) return res.status(400).json({ error: 'Bad file name' });
    if (!holdsLease(req.runner, runId)) return res.status(409).json({ error: 'This check is not yours (any more).' });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 8 || body.readUInt32BE(0) !== 0x89504e47) return res.status(400).json({ error: 'Not a PNG image' });
    const dir = path.join(config.dataDir, 'shots', `run-${runId}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, req.params.file), body);
    res.json({ ok: true });
  });

  app.post('/api/runner/runs/:id/complete', big, worker, async (req, res) => {
    const { result, error } = req.body || {};
    if (!error && (!result || typeof result !== 'object' || !Array.isArray(result.checks))) return res.status(400).json({ error: 'Send a result with checks, or an error' });
    const ok = await workerComplete(req.runner, req.params.id, { result, error: error ? String(error) : null });
    if (!ok) return res.status(409).json({ error: 'This check is not yours (any more): it was stopped, or moved to another runner.' });
    res.json({ ok: true });
  });

  // ---- founders ----
  const admin = (req, res, next) => requireUser(req, res, () => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Forbidden' })));

  app.get('/api/admin/runners', admin, (req, res) => {
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
    const stats = new Map(runnerReport({ days, states: runnerStates(), current: currentChecks() }).map((r) => [r.id, r]));
    const runners = runnerStates().map((r) => {
      const st = stats.get(r.id) || {};
      return {
        id: r.id, name: r.name, kind: r.kind, slots: r.slots, used: r.used, tags: r.tags, status: r.status, healthy: r.healthy, lastSeen: r.kind === 'main' ? null : r.last_seen, createdAt: r.created_at,
        current: st.current || [], today: st.today || null, totals: st.totals || null, days: st.days || [],
      };
    });
    res.json({ days, runners, recent: recentRuns({ limit: 30 }) });
  });

  /** The latest checks with the runner that ran them, wait and duration (optionally one runner's). */
  app.get('/api/admin/runs', admin, (req, res) => {
    res.json({ runs: recentRuns({ limit: req.query.limit, runnerId: req.query.runner || null }) });
  });

  app.post('/api/admin/runners/join-tokens', admin, (req, res) => {
    try {
      const t = createJoinToken(req.body || {}, req.user.email);
      audit(req.user.email, null, 'runner.token', { name: t.name, slots: req.body?.slots, tags: req.body?.tags });
      res.status(201).json(t);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.patch('/api/admin/runners/:id', admin, (req, res) => {
    try {
      const [before, after] = updateRunner(req.params.id, req.body || {});
      audit(req.user.email, null, 'runner.update', { runner: after.name, before: { status: before.status, tags: before.tags, slots: before.slots }, after: { status: after.status, tags: after.tags, slots: after.slots } });
      res.json({ id: after.id, name: after.name, status: after.status, tags: after.tags, slots: after.slots });
    } catch (e) { res.status(/not found/i.test(e.message) ? 404 : 400).json({ error: e.message }); }
  });

  /** Which runner ran a check (founders only; store owners never see runner names). */
  app.get('/api/admin/runs/:id/leases', admin, (req, res) => {
    res.json({ leases: L.byRun.all(Number(req.params.id)).map((l) => ({ runner: l.runner_name, attempt: l.attempt, state: l.state, assignedAt: l.assigned_at, leasedAt: l.leased_at, finishedAt: l.finished_at })) });
  });
}
