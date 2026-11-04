import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { db, q } from './db.js';
import { normalizeStoreUrl, assertPublicTarget, newContext, gotoStore, settleChallenge } from './engine/browser.js';
import { discover } from './engine/discover.js';
import { GROUPS, INTERVALS, FULL_INTERVALS, normalizeConfig } from './engine/catalog.js';
import { startRun, startScheduler, storeConfig, intervals, nextRunIn } from './scheduler.js';
import { queueDepth, cancelRun } from './queue.js';
import { liveView } from './live.js';
import { previewUrlFor, startRelease, settleRelease } from './release.js';
import { comparePair } from './compare.js';
import { approveBaseline } from './engine/visual.js';
import { sendMail, sendSlack } from './alerts.js';
import { buildComparison, reportList, SHOT_KEYS } from './compare.js';
import { aiEnabled, explainDiff } from './ai.js';
import { catalogReport } from './catalog-report.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use(
  cookieSession({
    name: 'tg',
    keys: [config.sessionSecret],
    maxAge: 30 * 24 * 3600 * 1000,
    sameSite: 'lax',
    httpOnly: true,
    secure: config.baseUrl.startsWith('https://'),
  })
);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const ip = (req) => req.ip || req.socket.remoteAddress || 'unknown';
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length < 200;

function requireUser(req, res, next) {
  const u = req.session?.uid && q.userById.get(req.session.uid);
  if (!u) return res.status(401).json({ error: 'Please log in' });
  req.user = u;
  next();
}
function ownStore(req, res) {
  const s = q.storeById.get(Number(req.params.id));
  if (!s || s.user_id !== req.user.id) {
    res.status(404).json({ error: 'Store not found' });
    return null;
  }
  return s;
}
function publicStore(s) {
  const { storefront_password, config_json, ...rest } = s;
  return { ...rest, has_password: !!storefront_password };
}
const isAdmin = (u) => !!config.adminEmail && u.email === config.adminEmail.toLowerCase();

// ---------- Public free scan ----------
app.post('/api/scan', async (req, res) => {
  let origin;
  try {
    origin = normalizeStoreUrl(req.body?.url);
    await assertPublicTarget(origin);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const cached = q.recentFreeRunForUrl.get(origin);
  if (cached) return res.json({ runId: cached.id, cached: true });
  if (q.recentFreeRunsByIp.get(ip(req)).n >= config.freeScansPerIpPerHour)
    return res.status(429).json({ error: 'You have reached the free scan limit for this hour. Create a free account to keep monitoring.' });
  const runId = startRun({ origin, kind: 'free', ip: ip(req), trigger: 'free' });
  res.json({ runId });
});

function runVisibleTo(run, req) {
  if (run.kind === 'free') return true;
  const uid = req.session?.uid;
  const store = run.store_id && q.storeById.get(run.store_id);
  return !!(uid && store && store.user_id === uid);
}

app.get('/api/runs/:id', (req, res) => {
  const run = q.runById.get(Number(req.params.id));
  if (!run || !runVisibleTo(run, req)) return res.status(404).json({ error: 'Report not found' });
  const ahead = run.status === 'queued' ? db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued') AND id < ?").get(run.id).n : 0;
  res.json({
    id: run.id,
    url: run.url,
    kind: run.kind,
    status: run.status,
    score: run.score,
    verdict: run.verdict,
    error: run.error,
    created_at: run.created_at,
    finished_at: run.finished_at,
    position: ahead,
    store_id: run.store_id,
    trigger: run.trigger,
    live: run.status === 'queued' || run.status === 'running' ? liveView(run.id) : null,
    result: run.result_json ? JSON.parse(run.result_json) : null,
  });
});

app.post('/api/leads', (req, res) => {
  const { email, runId, url, source } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
  q.insertLead.run(email.toLowerCase(), String(url || '').slice(0, 300), Number(runId) || null, String(source || 'scan').slice(0, 40));
  if (config.adminEmail) sendMail({ to: config.adminEmail, subject: `New lead: ${email}`, text: `${email}\n${url || ''}\nRun ${runId || '-'}` }).catch(() => {});
  res.json({ ok: true });
});

// Screenshots: free-scan shots are public; monitored-store shots only for the owner.
app.use('/shots/:dir', (req, res, next) => {
  const m = /^run-(\d+)$/.exec(req.params.dir);
  if (!m) return res.status(404).end();
  const run = q.runById.get(Number(m[1]));
  if (!run || !runVisibleTo(run, req)) return res.status(404).end();
  express.static(path.join(config.dataDir, 'shots', req.params.dir), { maxAge: '7d' })(req, res, next);
});

// ---------- Accounts ----------
const loginAttempts = new Map();
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name, storeUrl } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Use a password of at least 8 characters' });
  const e = email.toLowerCase();
  if (q.userByEmail.get(e)) return res.status(409).json({ error: 'An account with this email already exists. Log in instead.' });
  const hash = await bcrypt.hash(password, 10);
  const info = q.insertUser.run(e, hash, String(name || '').slice(0, 80));
  req.session.uid = Number(info.lastInsertRowid);
  // Signing up from a free-check report ("Start monitoring") adds that store with recommended settings.
  let store = null;
  if (storeUrl) {
    try {
      const origin = normalizeStoreUrl(storeUrl);
      await assertPublicTarget(origin);
      const s = q.insertStore.run(req.session.uid, origin, new URL(origin).host, null, e, null, '{}', null, 1);
      store = Number(s.lastInsertRowid);
      startRun({ storeId: store, origin, kind: 'full', trigger: 'setup' });
    } catch {
      /* the store can be added later */
    }
  }
  if (config.adminEmail) sendMail({ to: config.adminEmail, subject: `New signup: ${e}`, text: `${e}\n${storeUrl || ''}` }).catch(() => {});
  sendMail({
    to: e,
    subject: 'Welcome to Tharam Store Guard',
    text: `Hi${name ? ' ' + name : ''},\n\nThanks for joining the Store Guard beta. Add your store at ${config.baseUrl}/app, choose what to test and how often, and we'll alert you only when something breaks or recovers.\n\nReply to this email any time; it reaches the founder directly.\n\nTharam`,
  }).catch(() => {});
  res.json({ ok: true, storeId: store });
});

app.post('/api/auth/login', async (req, res) => {
  const key = ip(req);
  const a = loginAttempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60 * 1000) Object.assign(a, { n: 0, t: Date.now() });
  if (a.n >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const { email, password } = req.body || {};
  const u = isEmail(email) && q.userByEmail.get(email.toLowerCase());
  if (!u || !(await bcrypt.compare(String(password || ''), u.password_hash))) {
    a.n++;
    loginAttempts.set(key, a);
    return res.status(401).json({ error: 'Email or password is incorrect' });
  }
  loginAttempts.delete(key);
  req.session.uid = u.id;
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => {
  res.json({ user: req.user, admin: isAdmin(req.user) });
});

app.patch('/api/account', requireUser, (req, res) => {
  q.updateUserName.run(String(req.body?.name ?? '').slice(0, 80), req.user.id);
  res.json({ ok: true });
});

app.post('/api/account/password', requireUser, async (req, res) => {
  const { current, next } = req.body || {};
  const u = q.userByEmail.get(req.user.email);
  if (!(await bcrypt.compare(String(current || ''), u.password_hash))) return res.status(400).json({ error: 'Current password is incorrect' });
  if (typeof next !== 'string' || next.length < 8) return res.status(400).json({ error: 'Use a new password of at least 8 characters' });
  q.updatePassword.run(await bcrypt.hash(next, 10), u.id);
  res.json({ ok: true });
});

// ---------- Test suite catalog ----------
app.get('/api/catalog', (req, res) => {
  res.json({ groups: GROUPS, intervals: INTERVALS, fullIntervals: FULL_INTERVALS, aiEnabled: aiEnabled(), defaults: { journeyIntervalMin: config.journeyIntervalMin, fullIntervalMin: config.fullScanIntervalMin } });
});

// Looks at a store before it is added: platform, products, collections, password lock.
const discoverCounts = new Map();
async function discoverStore(origin, password) {
  const ctx = await newContext();
  try {
    const page = await ctx.newPage();
    const nav = await gotoStore(page, origin + '/', { password }).catch((e) => ({ error: e }));
    if (nav.error) return { reachable: false, error: `We couldn't open ${new URL(origin).host}. Check the address and that the store is online.` };
    const status = nav.res ? nav.res.status() : 0;
    const locked = !!nav.locked;
    const challenge = locked ? { blocked: false } : await settleChallenge(page, nav.res);
    const info = await discover(ctx.request, origin);
    return {
      blocked: challenge.blocked,
      blockedBy: challenge.vendor || null,
      reachable: challenge.blocked || (status > 0 && status < 400),
      status,
      locked,
      wrongPassword: !!nav.wrongPassword,
      platform: info.platform,
      isShopify: info.isShopify,
      productCount: info.sampleSize,
      catalog: info.catalog,
      suggested: info.products[0] ? info.products[0].handle : null,
      collections: info.collections,
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

app.post('/api/discover', requireUser, async (req, res) => {
  const k = req.user.id;
  const c = discoverCounts.get(k) || { n: 0, t: Date.now() };
  if (Date.now() - c.t > 3600 * 1000) Object.assign(c, { n: 0, t: Date.now() });
  if (++c.n > 30) return res.status(429).json({ error: 'Too many lookups this hour. Try again later.' });
  discoverCounts.set(k, c);
  let origin;
  try {
    origin = normalizeStoreUrl(req.body?.url);
    await assertPublicTarget(origin);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (q.storesByUser.all(req.user.id).some((s) => s.url === origin)) return res.status(409).json({ error: 'This store is already in your account.' });
  try {
    res.json({ origin, ...(await discoverStore(origin, req.body?.password || null)) });
  } catch (e) {
    res.status(502).json({ error: 'We could not look at this store right now. Try again in a minute.' });
  }
});

// ---------- Stores ----------
function storeView(s) {
  const cfg = storeConfig(s);
  const iv = intervals(s);
  const active = q.activeRunForStore.get(s.id);
  return {
    ...publicStore(s),
    config: { disabled: cfg.disabled || [], testProduct: cfg.testProduct || null, ...iv },
    next_run_in: s.last_run_at ? nextRunIn(s) : null,
    active_run_id: active ? active.id : null,
    failing: q.failingChecks.all(s.id),
  };
}

app.get('/api/stores', requireUser, (req, res) => {
  res.json({ stores: q.storesByUser.all(req.user.id).map(storeView), queue: queueDepth() });
});

app.get('/api/overview', requireUser, (req, res) => {
  res.json({ stores: q.storesByUser.all(req.user.id).map(storeView), alerts: q.recentAlertsForUser.all(req.user.id) });
});

app.post('/api/stores', requireUser, async (req, res) => {
  const { url, name, password, alertEmail, slack, runNow, monitoring = true, platform } = req.body || {};
  let origin;
  try {
    origin = normalizeStoreUrl(url);
    await assertPublicTarget(origin);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const mine = q.storesByUser.all(req.user.id);
  if (mine.length >= 5) return res.status(400).json({ error: 'The beta allows up to 5 stores per account.' });
  if (mine.some((s) => s.url === origin)) return res.status(409).json({ error: 'This store is already in your account.' });
  if (alertEmail && !isEmail(alertEmail)) return res.status(400).json({ error: 'Alert email is not valid' });
  if (slack && !/^https:\/\/hooks\.slack\.com\//.test(slack)) return res.status(400).json({ error: 'Slack webhook must start with https://hooks.slack.com/' });
  const cfg = normalizeConfig(req.body?.config || {});
  const info = q.insertStore.run(
    req.user.id, origin, String(name || new URL(origin).host).slice(0, 80), password || null,
    alertEmail || req.user.email, slack || null, JSON.stringify(cfg), platform ? String(platform).slice(0, 60) : null, monitoring ? 1 : 0
  );
  const id = Number(info.lastInsertRowid);
  const runId = runNow ? startRun({ storeId: id, origin, kind: 'full', password, trigger: 'setup' }) : null;
  res.json({ id, runId });
});

app.get('/api/stores/:id', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  res.json({ store: storeView(s) });
});

app.patch('/api/stores/:id', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const b = req.body || {};
  if (b.alertEmail && !isEmail(b.alertEmail)) return res.status(400).json({ error: 'Alert email is not valid' });
  if (b.slack && !/^https:\/\/hooks\.slack\.com\//.test(b.slack)) return res.status(400).json({ error: 'Slack webhook must start with https://hooks.slack.com/' });
  if (b.name !== undefined && !String(b.name).trim()) return res.status(400).json({ error: 'Give the store a name' });
  q.updateStoreSettings.run(
    b.name === undefined ? s.name : String(b.name).trim().slice(0, 80),
    b.password === undefined ? s.storefront_password : b.password || null,
    b.alertEmail === undefined ? s.alert_email : b.alertEmail || q.userById.get(s.user_id).email,
    b.slack === undefined ? s.slack_webhook : b.slack || null,
    b.monitoring === undefined ? s.monitoring : b.monitoring ? 1 : 0,
    s.id
  );
  if (b.config) q.updateStoreConfig.run(JSON.stringify(normalizeConfig(b.config, storeConfig(s))), s.id);
  res.json({ ok: true, store: storeView(q.storeById.get(s.id)) });
});

app.delete('/api/stores/:id', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  q.deleteStore.run(s.id, req.user.id);
  fs.rmSync(path.join(config.dataDir, 'baselines', `store-${s.id}`), { recursive: true, force: true });
  res.json({ ok: true });
});

app.post('/api/stores/:id/run', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  if (q.activeRunForStore.get(s.id)) return res.status(409).json({ error: 'A test is already running for this store.' });
  // A run can be limited to chosen validation groups. Anything not chosen is skipped for this run only.
  let kind = req.body?.kind === 'journeys' ? 'journeys' : 'full';
  let disabled;
  if (Array.isArray(req.body?.groups)) {
    const chosen = new Set(req.body.groups.map(String));
    for (const g of GROUPS) if (g.locked) chosen.add(g.key);
    disabled = GROUPS.filter((g) => !chosen.has(g.key)).map((g) => g.key);
    kind = GROUPS.some((g) => g.run === 'full' && chosen.has(g.key)) ? 'full' : 'journeys';
  }
  res.json({ runId: startRun({ storeId: s.id, origin: s.url, kind, password: s.storefront_password, trigger: 'manual', disabled }), kind });
});

app.post('/api/stores/:id/run/:runId/cancel', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const run = q.runById.get(Number(req.params.runId));
  if (!run || run.store_id !== s.id) return res.status(404).json({ error: 'Run not found.' });
  if (run.status !== 'queued' && run.status !== 'running') return res.status(409).json({ error: 'This test has already finished.' });
  const stopped = cancelRun(run.id);
  if (!stopped) q.cancelRun.run(run.id); // not in this process's queue (e.g. after a restart); mark it cancelled anyway
  res.json({ ok: true });
});

// ---------- Safe to publish ----------
const releaseView = (r) => {
  const sum = r.summary_json ? JSON.parse(r.summary_json) : null;
  const run = (id) => { const x = id && q.runById.get(id); return x ? { id: x.id, status: x.status, score: x.score, error: x.error, live: x.status === 'queued' || x.status === 'running' ? liveView(x.id) : null, created_at: x.created_at, finished_at: x.finished_at } : null; };
  return { id: r.id, preview_url: r.preview_url, label: r.label, status: r.status, verdict: r.verdict, created_at: r.created_at, finished_at: r.finished_at, summary: sum, runs: { live: run(r.live_run_id), draft: run(r.draft_run_id) } };
};
app.get('/api/stores/:id/releases', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  res.json({ releases: q.releasesByStore.all(s.id).map((r) => { const v = releaseView(r); delete v.runs; if (v.summary) v.summary = { headline: v.summary.headline, theme: v.summary.theme, counts: { blockers: v.summary.blockers?.length || 0, reviews: v.summary.reviews?.length || 0, fixes: v.summary.fixes?.length || 0, visual: v.summary.visualChanged || 0 }, error: v.summary.error }; return v; }) });
});
app.post('/api/stores/:id/releases', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  if (q.activeRunForStore.get(s.id)) return res.status(409).json({ error: 'A test is running for this store. Start the publish check when it finishes.' });
  let url;
  try { url = previewUrlFor(s, String(req.body?.url || '').trim()); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json({ id: startRelease(s, url, String(req.body?.label || '').trim().slice(0, 120)) });
});
app.get('/api/stores/:id/releases/:rid', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const r = q.releaseById.get(Number(req.params.rid));
  if (!r || r.store_id !== s.id) return res.status(404).json({ error: 'Publish check not found.' });
  const v = releaseView(r);
  if (r.status === 'done') {
    const cmp = comparePair(s.id, r.draft_run_id, r.live_run_id);
    if (cmp) v.compare = { areas: cmp.areas, metrics: cmp.metrics, visual: cmp.visual, timings: cmp.timings };
  }
  res.json(v);
});
app.post('/api/stores/:id/releases/:rid/cancel', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const r = q.releaseById.get(Number(req.params.rid));
  if (!r || r.store_id !== s.id) return res.status(404).json({ error: 'Publish check not found.' });
  for (const id of [r.draft_run_id, r.live_run_id]) {
    const run = id && q.runById.get(id);
    if (run && (run.status === 'queued' || run.status === 'running') && !cancelRun(id)) q.cancelRun.run(id);
  }
  settleRelease(r.id);
  res.json({ ok: true });
});

app.post('/api/stores/:id/discover', requireUser, async (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  try {
    res.json(await discoverStore(s.url, s.storefront_password));
  } catch {
    res.status(502).json({ error: 'We could not look at this store right now. Try again in a minute.' });
  }
});

app.get('/api/stores/:id/runs', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 300);
  res.json({ store: storeView(s), runs: q.runsByStore.all(s.id, limit), alerts: q.alertsByStore.all(s.id) });
});

app.post('/api/stores/:id/test-alert', requireUser, async (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const name = s.name || new URL(s.url).host;
  const text = `This is a test alert for ${name} from Tharam Store Guard. Real alerts look like this, with what broke, how to fix it, and a link to the report.\n\n${config.baseUrl}/app#/s/${s.id}`;
  const [mail, slack] = await Promise.all([
    sendMail({ to: s.alert_email, subject: `Test alert for ${name}`, text }).catch(() => false),
    s.slack_webhook ? sendSlack(s.slack_webhook, `*Test alert for ${name}*\n${text}`).catch(() => false) : Promise.resolve(null),
  ]);
  res.json({ email: mail, slack, emailConfigured: !!config.smtp.host });
});

app.get('/api/stores/:id/visual', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const run = db
    .prepare("SELECT id, result_json, finished_at FROM runs WHERE store_id = ? AND kind = 'full' AND status = 'done' ORDER BY id DESC LIMIT 1")
    .get(s.id);
  const baseDir = path.join(config.dataDir, 'baselines', `store-${s.id}`);
  const keys = SHOT_KEYS;
  const result = run ? JSON.parse(run.result_json) : null;
  const visual = result?.checks?.find((c) => c.id === 'nf.visual')?.evidence?.visual || [];
  const shotDir = run ? path.join(config.dataDir, 'shots', `run-${run.id}`) : null;
  res.json({
    runId: run?.id || null,
    checkedAt: run?.finished_at || null,
    shots: keys
      .map((k) => {
        const v = visual.find((x) => x.key === k) || {};
        const base = path.join(baseDir, `${k}.png`);
        return {
          key: k,
          status: v.status || null,
          ratio: v.ratio ?? null,
          current: shotDir && fs.existsSync(path.join(shotDir, `${k}.png`)) ? `/shots/run-${run.id}/${k}.png` : null,
          diff: shotDir && fs.existsSync(path.join(shotDir, `${k}-diff.png`)) ? `/shots/run-${run.id}/${k}-diff.png` : null,
          baseline: fs.existsSync(base) ? `/baselines/${s.id}/${k}.png?v=${Math.round(fs.statSync(base).mtimeMs)}` : null,
        };
      })
      .filter((x) => x.current || x.baseline),
  });
});

app.get('/baselines/:sid/:file', requireUser, (req, res) => {
  const s = q.storeById.get(Number(req.params.sid));
  if (!s || s.user_id !== req.user.id || !/^(home|product)-(desktop|tablet|mobile)\.png$/.test(req.params.file)) return res.status(404).end();
  res.sendFile(path.join(config.dataDir, 'baselines', `store-${s.id}`, req.params.file));
});

app.get('/api/stores/:id/reports', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  res.json({ reports: reportList(s.id) });
});

app.get('/api/stores/:id/compare', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const c = buildComparison(s.id, req.query.run ? Number(req.query.run) : null, String(req.query.base || 'prev'));
  if (!c) return res.status(404).json({ error: 'No finished reports yet' });
  res.json(c);
});

app.get('/api/stores/:id/catalog', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const data = catalogReport(s.id, req.query.run ? Number(req.query.run) : null, String(req.query.base || 'prev'));
  if (!data) return res.status(404).json({ error: 'No catalog snapshot yet. Run a full check first.' });
  res.json(data);
});

app.post('/api/stores/:id/explain-change', requireUser, async (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  if (!aiEnabled()) return res.status(400).json({ error: 'AI review is not set up on this server.' });
  const { runId, baseRunId, key } = req.body || {};
  if (!SHOT_KEYS.includes(key)) return res.status(400).json({ error: 'Unknown screenshot' });
  const own = (id) => q.runById.get(Number(id))?.store_id === s.id;
  const a = path.join(config.dataDir, 'shots', `run-${Number(runId)}`, `${key}.png`);
  const b = path.join(config.dataDir, 'shots', `run-${Number(baseRunId)}`, `${key}.png`);
  if (!own(runId) || !own(baseRunId) || !fs.existsSync(a) || !fs.existsSync(b)) return res.status(404).json({ error: 'Screenshots not found' });
  try {
    const [page, device] = key.split('-');
    res.json(await explainDiff(b, a, { page: page === 'home' ? 'homepage' : 'product page', device }));
  } catch (e) {
    res.status(502).json({ error: 'AI could not compare these screenshots right now.' });
  }
});

app.post('/api/stores/:id/approve-visual', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const run = q.runById.get(Number(req.body?.runId));
  if (!run || run.store_id !== s.id) return res.status(404).json({ error: 'Run not found' });
  const n = approveBaseline(path.join(config.dataDir, 'shots', `run-${run.id}`), path.join(config.dataDir, 'baselines', `store-${s.id}`));
  res.json({ ok: true, approved: n });
});

// ---------- Founder view ----------
app.get('/api/admin/overview', requireUser, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  res.json({
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    stores: db.prepare('SELECT COUNT(*) AS n FROM stores').get().n,
    freeScans24h: db.prepare("SELECT COUNT(*) AS n FROM runs WHERE kind='free' AND created_at > datetime('now','-1 day')").get().n,
    leads: db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 200').all(),
    recentScans: db.prepare("SELECT id, url, score, verdict, status, created_at FROM runs WHERE kind='free' ORDER BY id DESC LIMIT 100").all(),
    signups: db.prepare('SELECT u.id, u.email, u.name, u.created_at, (SELECT GROUP_CONCAT(url) FROM stores WHERE user_id=u.id) AS stores FROM users u ORDER BY id DESC LIMIT 200').all(),
    queue: queueDepth(),
  });
});

app.get('/healthz', (req, res) => res.json({ ok: true, queue: queueDepth() }));
app.get('/api/public-config', (req, res) => res.json({ calLink: config.calLink, contactEmail: config.contactEmail }));

// ---------- Website ----------
const page = (f) => (req, res) => res.sendFile(path.join(config.publicDir, f));
app.get('/', page('index.html'));
app.get('/scan/:id', page('report.html'));
app.get('/app', page('app.html'));
app.get('/privacy', page('privacy.html'));
app.get('/terms', page('terms.html'));
app.get('/bot', page('bot.html'));
app.get('/checks', page('checks.html'));
app.get('/demo', page('demo.html'));
app.use(express.static(config.publicDir, { maxAge: '1h', index: false }));
app.use((req, res) => res.status(404).sendFile(path.join(config.publicDir, '404.html')));

if (!fs.existsSync(path.join(config.publicDir, 'index.html'))) console.warn('public/index.html missing');
app.listen(config.port, () => {
  console.log(`Tharam Store Guard on ${config.baseUrl} (port ${config.port})`);
  if (process.env.DISABLE_SCHEDULER !== '1') startScheduler();
});

// Docker sends SIGTERM on redeploy; Node as PID 1 ignores it unless handled. Runs in flight are
// marked "Interrupted by restart" on the next start.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
