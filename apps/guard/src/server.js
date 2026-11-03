import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { db, q } from './db.js';
import { normalizeStoreUrl, assertPublicTarget } from './engine/browser.js';
import { startRun, startScheduler } from './scheduler.js';
import { queueDepth } from './queue.js';
import { approveBaseline } from './engine/visual.js';
import { sendMail } from './alerts.js';

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
  const { storefront_password, ...rest } = s;
  return { ...rest, has_password: !!storefront_password };
}

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
  const runId = startRun({ origin, kind: 'free', ip: ip(req) });
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
  let store = null;
  if (storeUrl) {
    try {
      const origin = normalizeStoreUrl(storeUrl);
      await assertPublicTarget(origin);
      const s = q.insertStore.run(req.session.uid, origin, new URL(origin).host, null, e, null);
      store = Number(s.lastInsertRowid);
      startRun({ storeId: store, origin, kind: 'full' });
    } catch {
      /* store can be added later */
    }
  }
  if (config.adminEmail) sendMail({ to: config.adminEmail, subject: `New signup: ${e}`, text: `${e}\n${storeUrl || ''}` }).catch(() => {});
  sendMail({
    to: e,
    subject: 'Welcome to Tharam Store Guard',
    text: `Hi${name ? ' ' + name : ''},\n\nStore Guard is now watching your store. We test your shopping journey, speed, SEO and more on a schedule, and alert you only when something breaks or recovers.\n\nDashboard: ${config.baseUrl}/app\n\nReply to this email any time; it reaches the founder directly.\n\n— Tharam`,
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
  res.json({ user: req.user, admin: !!config.adminEmail && req.user.email === config.adminEmail.toLowerCase() });
});

// ---------- Stores ----------
app.get('/api/stores', requireUser, (req, res) => {
  res.json({ stores: q.storesByUser.all(req.user.id).map(publicStore), queue: queueDepth() });
});

app.post('/api/stores', requireUser, async (req, res) => {
  const { url, password, alertEmail, slack } = req.body || {};
  let origin;
  try {
    origin = normalizeStoreUrl(url);
    await assertPublicTarget(origin);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (q.storesByUser.all(req.user.id).length >= 5) return res.status(400).json({ error: 'The beta allows up to 5 stores per account.' });
  if (alertEmail && !isEmail(alertEmail)) return res.status(400).json({ error: 'Alert email is not valid' });
  const info = q.insertStore.run(req.user.id, origin, new URL(origin).host, password || null, alertEmail || req.user.email, slack || null);
  const id = Number(info.lastInsertRowid);
  const runId = startRun({ storeId: id, origin, kind: 'full', password });
  res.json({ id, runId });
});

app.patch('/api/stores/:id', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const b = req.body || {};
  if (b.alertEmail && !isEmail(b.alertEmail)) return res.status(400).json({ error: 'Alert email is not valid' });
  if (b.slack && !/^https:\/\/hooks\.slack\.com\//.test(b.slack)) return res.status(400).json({ error: 'Slack webhook must start with https://hooks.slack.com/' });
  q.updateStoreSettings.run(
    b.name ?? s.name,
    b.password === undefined ? s.storefront_password : b.password || null,
    b.alertEmail ?? s.alert_email,
    b.slack === undefined ? s.slack_webhook : b.slack || null,
    b.monitoring === undefined ? s.monitoring : b.monitoring ? 1 : 0,
    s.id
  );
  res.json({ ok: true });
});

app.delete('/api/stores/:id', requireUser, (req, res) => {
  q.deleteStore.run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

app.post('/api/stores/:id/run', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  if (q.activeRunForStore.get(s.id)) return res.status(409).json({ error: 'A test is already running for this store.' });
  const kind = req.body?.kind === 'journeys' ? 'journeys' : 'full';
  res.json({ runId: startRun({ storeId: s.id, origin: s.url, kind, password: s.storefront_password }) });
});

app.get('/api/stores/:id/runs', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  res.json({ store: publicStore(s), runs: q.runsByStore.all(s.id, 50), alerts: q.alertsByStore.all(s.id) });
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
  if (!config.adminEmail || req.user.email !== config.adminEmail.toLowerCase()) return res.status(403).json({ error: 'Forbidden' });
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

// ---------- Website ----------
const page = (f) => (req, res) => res.sendFile(path.join(config.publicDir, f));
app.get('/', page('index.html'));
app.get('/scan/:id', page('report.html'));
app.get('/app', page('app.html'));
app.get('/privacy', page('privacy.html'));
app.get('/terms', page('terms.html'));
app.get('/bot', page('bot.html'));
app.use(express.static(config.publicDir, { maxAge: '1h', index: false }));
app.use((req, res) => res.status(404).sendFile(path.join(config.publicDir, '404.html')));

if (!fs.existsSync(path.join(config.publicDir, 'index.html'))) console.warn('public/index.html missing');
app.listen(config.port, () => {
  console.log(`Tharam Store Guard on ${config.baseUrl} (port ${config.port})`);
  if (process.env.DISABLE_SCHEDULER !== '1') startScheduler();
});
