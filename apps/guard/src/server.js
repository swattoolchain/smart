import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { db, q } from './db.js';
import { normalizeStoreUrl, assertPublicTarget, newContext, gotoStore, settleChallenge } from './engine/browser.js';
import { discover } from './engine/discover.js';
import { GROUPS, INTERVALS, FULL_INTERVALS, MARKETS, normalizeConfig } from './engine/catalog.js';
import { startRun, startScheduler, storeConfig, intervals, nextRunIn, saleActive } from './scheduler.js';
import { queueDepth, cancelRun, queueRoom } from './queue.js';
import { withLookupSlot } from './lookups.js';
import { liveView } from './live.js';
import { scorecard, weekBuyability } from './scorecard.js';
import crypto from 'node:crypto';
import { entitlements, has, blockReason, licenseView, ensureLicense, notIncluded, plansWith, FEATURES, envAllowed, listPlans } from './license.js';
import { adminRoutes } from './admin.js';
import { enabledKeys, checkOn, isOn, requireFeature } from './features.js';
import * as shopify from './shopify.js';
import { shopifyRoutes, shopifyWebhook } from './shopify-routes.js';
import { paymentRoutes, razorpayWebhook } from './payments.js';
import { purgeStoreFiles } from './purge.js';
import { webAccessRoutes, sessionValid, sessionEpoch, bumpSessionEpoch, emailTaken } from './web-access.js';
import { previewUrlFor, startRelease, settleRelease, cleanEnvironment } from './release.js';
import { comparePair } from './compare.js';
import * as site from './site/pages.js';
import { pluginRoutes } from './wp-plugin.js';
import { approveBaseline } from './engine/visual.js';
import { seal, storePassword } from './secret.js';
import { sendMail, sendSlack } from './alerts.js';
import { webhookOf, resolveFormat, checkWebhookUrl, newSecret, FORMATS as WEBHOOK_FORMATS, deliver as deliverWebhook, recentDeliveries } from './webhooks.js';
import { buildComparison, reportList, SHOT_KEYS } from './compare.js';
import { aiEnabled, explainDiff } from './ai.js';
import { catalogReport } from './catalog-report.js';
import { saleReadiness, emailSaleReadiness, saleRecipients, saleGroups } from './sale-readiness.js';
import { appHealth } from './app-health.js';
import { runnerRoutes } from './runner-routes.js';
import { runsCsv, checksCsv, productsCsv, reportHtml, reportPdf, runFor, exportName } from './export.js';
import { teamRoutes, membership, memberMay, teamAllowed, redactForViewer } from './team.js';
import * as themeClean from './theme-clean.js';
import { checklist as securityChecklist, tick as tickSecurity, setReminders as setSecurityReminders, isItem as isSecurityItem } from './security-checklist.js';
import { recoveryPacket } from './recovery-packet.js';
import { incidentView, startIncident, updateIncident, endIncident, incidentBrief, startEmail as incidentStartEmail, endEmail as incidentEndEmail } from './incident.js';
import { warningsFor } from './early-warning.js';
import { cspMiddleware, cspReportRoute } from './csp.js';
import { salePlanRoutes } from './sale-plans.js';
import { saleLiveRoutes } from './sale-live.js';
import { saleCalendarRoutes } from './sale-calendar-routes.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
// Webhooks need the raw body to check their signatures, so they are registered before the JSON parser.
app.post('/shopify/webhooks', express.raw({ type: '*/*', limit: '1mb' }), shopifyWebhook);
app.post('/api/payments/razorpay/webhook', express.raw({ type: '*/*', limit: '200kb' }), razorpayWebhook);
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
  // The Shopify app runs inside Shopify admin; everything else may only be framed by ourselves.
  // The Content-Security-Policy below carries the matching frame-ancestors rule.
  if (!isShopifyPath(req.path)) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(cspMiddleware({
  frameAncestors: (req) => {
    if (!isShopifyPath(req.path)) return "'self'";
    const shop = String(req.query.shop || '').toLowerCase();
    return `https://admin.shopify.com${shopify.validShop(shop) ? ` https://${shop}` : ''}`;
  },
}));
cspReportRoute(app, express);

function isShopifyPath(p) { return p === '/shopify' || p.startsWith('/shopify/'); }

const ip = (req) => req.ip || req.socket.remoteAddress || 'unknown';
// Length first, and a pattern with no overlapping parts, so a huge or crafted input can never be slow (ReDoS).
const isEmail = (s) => typeof s === 'string' && s.length < 200 && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[^\s@.]{2,}$/.test(s);

// Simple per-key limits for routes that send email or create accounts, so nobody can use them to spam.
const hits = new Map();
function overLimit(key, max, windowMs = 3600e3) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 50000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return false;
}
const LIMITS = {
  signup: Number(process.env.SIGNUPS_PER_IP_PER_HOUR || 5),
  leads: Number(process.env.LEADS_PER_IP_PER_HOUR || 10),
  testAlerts: Number(process.env.TEST_ALERTS_PER_STORE_PER_HOUR || 5),
};
const tooMany = (res, what) => res.status(429).json({ error: `Too many ${what}. Try again in an hour.` });

function requireUser(req, res, next) {
  // Inside Shopify admin there are no cookies: every request carries a Shopify session token.
  const auth = req.get('authorization') || '';
  if (/^Bearer\s+ey/i.test(auth) && shopify.shopifyEnabled() && !req.path.startsWith('/api/gate')) {
    try {
      const { shop } = shopify.verifySessionToken(auth.replace(/^Bearer\s+/i, ''));
      const link = db.prepare('SELECT user_id FROM shopify_shops WHERE shop = ? AND uninstalled_at IS NULL').get(shop);
      const u = link?.user_id && q.userById.get(link.user_id);
      if (!u) return res.status(401).json({ error: 'Open Tharam from your Shopify admin again.', reauth: true });
      req.user = u; req.shop = shop;
      return next();
    } catch (e) {
      return res.status(401).json({ error: 'Your Shopify session has expired. Reload the page.', reauth: true });
    }
  }
  const u = req.session?.uid && q.userById.get(req.session.uid);
  if (!u) return res.status(401).json({ error: 'Please log in' });
  // Signed out everywhere, or the Shopify app was uninstalled: this browser session no longer counts.
  const v = sessionValid(req, u.id);
  if (!v.ok) { req.session = null; return res.status(401).json({ error: v.error || 'Please log in' }); }
  req.user = u;
  // Working in someone else's workspace as a team member: act as that account, within the member's role.
  if (req.session.acct) {
    const m = membership(req.session.acct, u.id);
    const acc = m && teamAllowed(req.session.acct) && q.userById.get(req.session.acct);
    if (!acc) { delete req.session.acct; return next(); } // removed from the team: back to their own account
    if (!memberMay(m.role, req.method, req.path)) return res.status(403).json({ error: m.role === 'viewer' ? 'You can view this workspace but not change it. Ask the account owner for admin access.' : 'Only the account owner can do this.', role: m.role });
    req.member = { user: u, role: m.role, accountId: acc.id };
    req.user = acc;
    // Viewers see reports, never credentials: gate keys, the Slack webhook address, signing secrets.
    if (m.role === 'viewer') { const json = res.json.bind(res); res.json = (body) => json(redactForViewer(body)); }
  }
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
  const { storefront_password, config_json, webhook_json, ...rest } = s;
  return { ...rest, has_password: !!storefront_password, incident: incidentBrief(s.id) };
}
// ADMIN_EMAIL may list several founders, separated by commas.
const ADMINS = new Set(String(config.adminEmail || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
const isAdmin = (u) => !!u && ADMINS.has(String(u.email).toLowerCase());
/** Refuses with a plain message when the account's plan doesn't allow something. */
function refuse(res, message, code = 403) { res.status(code).json({ error: message, upgrade: true }); }

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
  if (cached) return res.json({ runId: cached.public_id, cached: true });
  if (q.recentFreeRunsByIp.get(ip(req)).n >= config.freeScansPerIpPerHour)
    return res.status(429).json({ error: 'You have reached the free scan limit for this hour. Create a free account to keep monitoring.' });
  if (!queueRoom({ free: true })) return res.status(503).json({ error: 'We’re checking a lot of stores right now. Try your free check again in a few minutes.', busy: true });
  const id = startRun({ origin, kind: 'free', ip: ip(req), trigger: 'free' });
  const publicId = crypto.randomBytes(16).toString('hex');
  q.setPublicId.run(publicId, id);
  // The report link is random: /scan/<publicId>. The run number is never shown for free checks.
  res.json({ runId: publicId });
});

/** The signed-in user: a login cookie on the website, or a Shopify session token inside Shopify admin. */
function currentUserId(req) {
  if (req.session?.uid) {
    if (!sessionValid(req, req.session.uid).ok) return null;
    // A team member sees the workspace they are working in (screenshots, reports), and only while still a member.
    if (req.session.acct) return membership(req.session.acct, req.session.uid) && teamAllowed(req.session.acct) ? req.session.acct : req.session.uid;
    return req.session.uid;
  }
  const auth = req.get('authorization') || '';
  if (/^Bearer\s+ey/i.test(auth) && shopify.shopifyEnabled()) {
    try {
      const { shop } = shopify.verifySessionToken(auth.replace(/^Bearer\s+/i, ''));
      return db.prepare('SELECT user_id FROM shopify_shops WHERE shop = ? AND uninstalled_at IS NULL').get(shop)?.user_id || null;
    } catch { return null; }
  }
  return null;
}
// Images inside Shopify admin can't send a session token, so their links carry a short-lived signature
// for that exact file. Links are signed only for the signed-in shop's own runs and stores, and the
// signature is accepted only when serving that image.
const fileSig = (file, exp) => crypto.createHmac('sha256', config.sessionSecret).update(`file:${file}:${exp}`).digest('base64url').slice(0, 32);
const validFileSig = (file, t) => { const m = /^([\w-]{32})\.(\d{10})$/.exec(String(t || '')); return !!m && Number(m[2]) > Date.now() / 1000 && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(fileSig(file, Number(m[2])))); };
function signFiles(obj, userId) {
  const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
  const owns = new Map();
  const ownsRun = (id) => { if (!owns.has(`r${id}`)) { const r = q.runById.get(id); const st = r?.store_id && q.storeById.get(r.store_id); owns.set(`r${id}`, !!st && st.user_id === userId); } return owns.get(`r${id}`); };
  const ownsStore = (id) => { if (!owns.has(`s${id}`)) owns.set(`s${id}`, q.storeById.get(id)?.user_id === userId); return owns.get(`s${id}`); };
  return JSON.parse(JSON.stringify(obj), (k, v) => {
    if (typeof v !== 'string') return v;
    let m = /^(\/shots\/run-(\d+)\/[\w.-]+)$/.exec(v);
    if (m && ownsRun(Number(m[2]))) return `${m[1]}?t=${fileSig(m[1], exp)}.${exp}`;
    m = /^(\/baselines\/(\d+)\/[\w.-]+)(\?v=\d+)?$/.exec(v);
    if (m && ownsStore(Number(m[2]))) return `${m[1]}?${m[3] ? m[3].slice(1) + '&' : ''}t=${fileSig(m[1], exp)}.${exp}`;
    return v;
  });
}
app.use((req, res, next) => {
  // Only for Shopify session requests; the signed-in user is checked when the response is sent.
  if (/^Bearer\s+ey/i.test(req.get('authorization') || '')) {
    const json = res.json.bind(res);
    res.json = (body) => { const uid = req.user?.id || currentUserId(req); return json(uid ? signFiles(body, uid) : body); };
  }
  next();
});
function runVisibleTo(run, req) {
  // Free checks are opened only by their random link (see /api/runs/:id); their screenshots by signed links.
  if (run.kind === 'free') return false;
  const uid = currentUserId(req);
  const store = run.store_id && q.storeById.get(run.store_id);
  return !!(uid && store && store.user_id === uid);
}

/** A free check's screenshots, signed for this answer only (the report page asks again every few seconds while it runs). */
function signFreeShots(obj, runId) {
  const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
  const re = new RegExp(`^/shots/run-${runId}/[\\w.-]+$`);
  return JSON.parse(JSON.stringify(obj), (k, v) => (typeof v === 'string' && re.test(v) ? `${v}?t=${fileSig(v, exp)}.${exp}` : v));
}

app.get('/api/runs/:id', (req, res) => {
  const key = String(req.params.id);
  const byLink = /^[a-f0-9]{32}$/.test(key);
  const run = byLink ? q.runByPublicId.get(key) : /^\d{1,12}$/.test(key) ? q.runById.get(Number(key)) : null;
  if (!run || !(byLink || runVisibleTo(run, req))) return res.status(404).json({ error: 'Report not found' });
  if (byLink) {
    const result = run.result_json ? signFreeShots(JSON.parse(run.result_json), run.id) : null;
    return res.json({
      id: run.public_id, url: run.url, kind: run.kind, status: run.status, score: run.score, verdict: run.verdict, error: run.error,
      created_at: run.created_at, finished_at: run.finished_at,
      position: run.status === 'queued' ? db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued') AND id < ?").get(run.id).n : 0,
      live: run.status === 'queued' || run.status === 'running' ? signFreeShots(liveView(run.id), run.id) : null,
      result,
    });
  }
  const ahead = run.status === 'queued' ? db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued') AND id < ?").get(run.id).n : 0;
  res.json({
    id: run.id,
    seq: run.seq,
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
  if (overLimit(`lead:${ip(req)}`, LIMITS.leads)) return tooMany(res, 'requests from this address');
  // Reports send their random link; it is stored as the run it belongs to.
  const leadRun = /^[a-f0-9]{32}$/.test(String(runId || '')) ? q.runByPublicId.get(String(runId))?.id || null : null;
  q.insertLead.run(email.toLowerCase(), String(url || '').slice(0, 300), leadRun, String(source || 'scan').slice(0, 40));
  if (config.adminEmail) sendMail({ to: config.adminEmail, subject: `New lead: ${email}`, text: `${email}\n${url || ''}\nRun ${runId || '-'}` }).catch(() => {});
  res.json({ ok: true });
});

// Screenshots: free-scan shots are public; monitored-store shots only for the owner.
app.use('/shots/:dir', (req, res, next) => {
  const m = /^run-(\d+)$/.exec(req.params.dir);
  if (!m) return res.status(404).end();
  const run = q.runById.get(Number(m[1]));
  if (!run) return res.status(404).end();
  const file = `/shots/${req.params.dir}${req.path}`;
  if (!runVisibleTo(run, req) && !(/^\/[\w.-]+$/.test(req.path) && validFileSig(file, req.query.t))) return res.status(404).end();
  express.static(path.join(config.dataDir, 'shots', req.params.dir), { maxAge: '7d' })(req, res, next);
});

// ---------- Accounts ----------
const loginAttempts = new Map();
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name, storeUrl } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Use a password of at least 8 characters' });
  const e = email.toLowerCase();
  if (q.userByEmail.get(e) || emailTaken(e)) return res.status(409).json({ error: 'An account with this email already exists. Log in instead.' });
  // Founder accounts get console access by email, so they are created on the server (scripts/create-user.js), never by signing up.
  if (ADMINS.has(e)) return res.status(403).json({ error: 'This email can’t be used to sign up here.' });
  if (overLimit(`signup:${ip(req)}`, LIMITS.signup)) return tooMany(res, 'sign-ups from this address');
  const hash = await bcrypt.hash(password, 10);
  const info = q.insertUser.run(e, hash, String(name || '').slice(0, 80));
  req.session.uid = Number(info.lastInsertRowid);
  delete req.session.acct; // a fresh login starts in the person's own account
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
  // Accounts created by a Shopify install have no password, and sign in from Shopify or with a link.
  const v = sessionValid({ session: { ep: sessionEpoch(u.id) } }, u.id);
  if (!v.ok) return res.status(401).json({ error: v.error || 'Email or password is incorrect' });
  loginAttempts.delete(key);
  req.session.uid = u.id;
  delete req.session.acct; // a fresh login starts in the person's own account
  req.session.ep = sessionEpoch(u.id);
  res.json({ ok: true });
});

// Logging out ends every browser session of the account, not just this one, so a cookie copied
// from another computer stops working too. Inside Shopify admin nothing changes (no cookies there).
app.post('/api/auth/logout', (req, res) => {
  const uid = req.session?.uid;
  if (uid && sessionValid(req, uid).ok) bumpSessionEpoch(uid);
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => {
  const member = req.member ? { email: req.member.user.email, name: req.member.user.name, role: req.member.role } : null;
  // Founder access belongs to the person, never to a workspace they visit.
  res.json({ user: req.user, member, admin: !req.member && isAdmin(req.user), license: licenseView(req.user.id), team: !req.member && isOn('teams') && teamAllowed(req.user.id), features: enabledKeys() });
});
teamRoutes(app, { requireUser });

// The customer's own plan and payment history.
app.get('/api/account/billing', requireUser, (req, res) => {
  res.json({ license: licenseView(req.user.id), payments: db.prepare('SELECT id, amount, currency, method, reference, period, periods, covers_from, covers_to, created_at FROM payments WHERE user_id = ? ORDER BY id DESC').all(req.user.id) });
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
  // A new password signs out every other browser; this one stays signed in.
  const ep = bumpSessionEpoch(u.id);
  if (req.session?.uid === u.id) req.session.ep = ep;
  res.json({ ok: true });
});

// ---------- Test suite catalog ----------
app.get('/api/catalog', (req, res) => {
  res.json({ groups: GROUPS.filter((g) => checkOn(g.key)), markets: MARKETS, features: FEATURES.map((f) => ({ key: f.key, label: f.label, groups: f.groups || [], plans: plansWith(f.key) })), intervals: INTERVALS, fullIntervals: FULL_INTERVALS, aiEnabled: aiEnabled(), defaults: { journeyIntervalMin: config.journeyIntervalMin, fullIntervalMin: config.fullScanIntervalMin } });
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

/** 30 store lookups per account per hour, counted for new and existing stores alike. */
function countLookup(k) {
  const c = discoverCounts.get(k) || { n: 0, t: Date.now() };
  if (Date.now() - c.t > 3600 * 1000) Object.assign(c, { n: 0, t: Date.now() });
  discoverCounts.set(k, c);
  return ++c.n <= 30;
}
app.post('/api/discover', requireUser, async (req, res) => {
  if (!countLookup(req.user.id)) return res.status(429).json({ error: 'Too many lookups this hour. Try again later.' });
  let origin;
  try {
    origin = normalizeStoreUrl(req.body?.url);
    await assertPublicTarget(origin);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (q.storesByUser.all(req.user.id).some((s) => s.url === origin)) return res.status(409).json({ error: 'This store is already in your account.' });
  try {
    res.json({ origin, ...(await withLookupSlot(req.user.id, () => discoverStore(origin, req.body?.password || null))) });
  } catch (e) {
    if (e.code === 'QUEUE_FULL') return res.status(e.status).json({ error: e.message, busy: true });
    res.status(502).json({ error: 'We could not look at this store right now. Try again in a minute.' });
  }
});

// ---------- Stores ----------
function storeView(s) {
  const cfg = storeConfig(s);
  const iv = intervals(s);
  const active = q.activeRunForStore.get(s.id);
  const ent = entitlements(s.user_id);
  return {
    ...publicStore(s),
    blocked: blockReason(ent, s.id),
    config: { onboarded: cfg.onboarded !== false, toured: cfg.toured !== false, disabled: cfg.disabled || [], markets: cfg.markets || [], discountCodes: cfg.discountCodes || [], priceRules: cfg.priceRules || [], abVariants: cfg.abVariants || [], saleUntil: saleActive(cfg) ? cfg.saleUntil : null, testProduct: cfg.testProduct || null, dailySales: cfg.dailySales || null, currency: cfg.currency || null, failureVideo: !!cfg.failureVideo, saleTraffic: !!cfg.saleTraffic, saleTrafficShoppers: cfg.saleTrafficShoppers || 3, ...iv },
    buyability_week: weekBuyability(s.id),
    next_run_in: s.last_run_at ? nextRunIn(s) : null,
    active_run_id: active ? active.id : null,
    failing: q.failingChecks.all(s.id),
    // Owner only (storeView is only ever sent to the store's owner): the signing secret is needed to check signatures.
    webhook: webhookOf(s) ? { url: webhookOf(s).url, format: webhookOf(s).format || 'auto', sendsAs: resolveFormat(webhookOf(s).url, webhookOf(s).format), secret: webhookOf(s).secret } : null,
  };
}

app.get('/api/stores', requireUser, (req, res) => {
  const sh = shopify.shopForUser(req.user.id);
  res.json({ stores: q.storesByUser.all(req.user.id).map(storeView), queue: queueDepth(), license: { ...licenseView(req.user.id), shopify: sh ? { shop: sh.shop, pricingUrl: shopify.pricingUrl(sh.shop) } : null } });
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
  // A Shopify-installed account checks its own Shopify store only; the store is set up by the app.
  if (shopify.shopForUser(req.user.id)) return refuse(res, 'This account checks your Shopify store. To check another store, install Tharam on that store too.');
  const mine = q.storesByUser.all(req.user.id);
  const ent = entitlements(req.user.id);
  if (!ent.usable) return refuse(res, blockReason(ent));
  if (mine.length >= ent.maxStores) return refuse(res, `Your plan covers ${ent.maxStores} store${ent.maxStores === 1 ? '' : 's'}, and all are in use. Add a store to your plan to add another.`);
  if (slack && !has(ent, 'slack')) return refuse(res, notIncluded('slack', 'Slack alerts') + ' Leave the Slack field empty, or upgrade.');
  if (mine.some((s) => s.url === origin)) return res.status(409).json({ error: 'This store is already in your account.' });
  if (alertEmail && !isEmail(alertEmail)) return res.status(400).json({ error: 'Alert email is not valid' });
  if (slack && !/^https:\/\/hooks\.slack\.com\//.test(slack)) return res.status(400).json({ error: 'Slack webhook must start with https://hooks.slack.com/' });
  if (Array.isArray(req.body?.config?.priceRules) && req.body.config.priceRules.length > ent.limits.priceRules) return refuse(res, `Your plan includes ${ent.limits.priceRules} price rules per store.`);
  let cfg;
  try { cfg = normalizeConfig(req.body?.config || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
  const info = q.insertStore.run(
    req.user.id, origin, String(name || new URL(origin).host).slice(0, 80), seal(password || null),
    alertEmail || req.user.email, slack || null, JSON.stringify(cfg), platform ? String(platform).slice(0, 60) : null, monitoring ? 1 : 0
  );
  const id = Number(info.lastInsertRowid);
  // A full waiting line doesn't stop the store being added; its first check can be started again later.
  let runId = null;
  if (runNow) { try { runId = startRun({ storeId: id, origin, kind: 'full', password, trigger: 'setup' }); } catch (e) { if (e.code !== 'QUEUE_FULL') throw e; } }
  res.json({ id, runId });
});

app.get('/api/stores/:id', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  res.json({ store: storeView(s) });
});

/**
 * Where alerts go when the owner clears the alert email. Website accounts: their account email. Shopify accounts
 * sign in as their myshopify domain, which is not an address: use the confirmed browser-access email, else the
 * shop's contact email from Shopify, else nothing (the caller asks for one).
 */
async function fallbackAlertEmail(store) {
  const user = q.userById.get(store.user_id);
  const shop = shopify.shopForStore(store.id) || shopify.shopForUser(store.user_id);
  if (!shop) return user && isEmail(user.email) ? user.email : null;
  if (user?.login_email && isEmail(user.login_email)) return user.login_email;
  if (shop.uninstalled_at) return null;
  try {
    const d = await shopify.gql(shop.shop, '{ shop { email contactEmail } }');
    return [d.shop?.contactEmail, d.shop?.email].find((e) => e && isEmail(e)) || null;
  } catch { return null; }
}

app.patch('/api/stores/:id', requireUser, async (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const b = req.body || {};
  // Webhook alerts: { url, format } to set, null or '' to remove; webhookSecret: 'new' makes a new signing secret.
  let hook;
  if (b.webhook !== undefined || b.webhookSecret !== undefined) {
    if (!isOn('webhooks')) return res.status(400).json({ error: 'Webhook alerts are not available.' });
    const cur = webhookOf(s);
    if (b.webhook === null || b.webhook === '' || (b.webhook && !String(b.webhook.url || '').trim())) hook = null;
    else if (b.webhook) {
      if (!has(entitlements(req.user.id), 'slack')) return refuse(res, notIncluded('slack', 'Webhook alerts'));
      const format = b.webhook.format || 'auto';
      if (!WEBHOOK_FORMATS.includes(format)) return res.status(400).json({ error: `Choose a format: ${WEBHOOK_FORMATS.join(', ')}` });
      let url;
      try { url = await checkWebhookUrl(b.webhook.url); } catch (e) { return res.status(400).json({ error: e.message }); }
      hook = { url, format, secret: cur?.secret || newSecret() };
    } else hook = cur;
    if (b.webhookSecret !== undefined) {
      if (b.webhookSecret !== 'new') return res.status(400).json({ error: 'webhookSecret can only be "new"' });
      if (!hook) return res.status(400).json({ error: 'Add a webhook address first.' });
      hook = { ...hook, secret: newSecret() };
    }
  }
  if (b.alertEmail && !isEmail(b.alertEmail)) return res.status(400).json({ error: 'Alert email is not valid' });
  // Clearing the alert email falls back to an address that can receive mail (never a myshopify domain).
  let alertEmail = b.alertEmail === undefined ? s.alert_email : b.alertEmail || null;
  if (b.alertEmail !== undefined && !b.alertEmail) {
    alertEmail = await fallbackAlertEmail(s);
    if (!alertEmail) return res.status(400).json({ error: 'Enter an email address for alerts. We need one to tell you when something breaks.' });
  }
  if (b.slack && !/^https:\/\/hooks\.slack\.com\//.test(b.slack)) return res.status(400).json({ error: 'Slack webhook must start with https://hooks.slack.com/' });
  if (b.name !== undefined && !String(b.name).trim()) return res.status(400).json({ error: 'Give the store a name' });
  const ent = entitlements(req.user.id);
  if (b.slack && b.slack !== s.slack_webhook && !has(ent, 'slack')) return refuse(res, notIncluded('slack', 'Slack alerts'));
  if (b.config?.journeyIntervalMin && Number(b.config.journeyIntervalMin) < ent.limits.journeyMinInterval) return refuse(res, 'Your plan doesn\'t include checks this often. Choose a longer interval or upgrade.');
  if (b.config?.fullIntervalMin && Number(b.config.fullIntervalMin) < ent.limits.fullMinInterval) return refuse(res, 'Your plan doesn\'t include full checks this often.');
  if (Array.isArray(b.config?.priceRules) && b.config.priceRules.filter((r) => r && (r.product || r.price)).length > ent.limits.priceRules) return refuse(res, `Your plan includes ${ent.limits.priceRules} price rule${ent.limits.priceRules === 1 ? '' : 's'} per store. Remove one, or upgrade to add more.`);
  q.updateStoreSettings.run(
    b.name === undefined ? s.name : String(b.name).trim().slice(0, 80),
    b.password === undefined ? s.storefront_password : seal(b.password || null),
    alertEmail,
    b.slack === undefined ? s.slack_webhook : b.slack || null,
    b.monitoring === undefined ? s.monitoring : b.monitoring ? 1 : 0,
    s.id
  );
  if (b.config) {
    let next;
    try { next = normalizeConfig(b.config, storeConfig(s)); } catch (e) { return res.status(400).json({ error: e.message }); }
    q.updateStoreConfig.run(JSON.stringify(next), s.id);
  }
  if (hook !== undefined) db.prepare('UPDATE stores SET webhook_json = ? WHERE id = ?').run(hook ? JSON.stringify(hook) : null, s.id);
  res.json({ ok: true, store: storeView(q.storeById.get(s.id)) });
});

app.delete('/api/stores/:id', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  if (shopify.shopForStore(s.id)) return res.status(400).json({ error: 'This is the store Tharam was installed on. To stop checking it, uninstall Tharam from your Shopify admin.' });
  // Files first (they are found through the store's runs), then the rows.
  purgeStoreFiles(s.id);
  q.deleteStore.run(s.id, req.user.id);
  res.json({ ok: true });
});

// ---------- Clean theme copy and guided restore (read-only; Shopify stores) ----------
app.get('/api/stores/:id/theme/clean', requireUser, requireFeature('theme_watch'), (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  res.json({ clean: themeClean.cleanView(s.id) });
});

app.get('/api/stores/:id/theme/clean/file', requireUser, requireFeature('theme_watch'), (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const f = themeClean.cleanFile(s.id, String(req.query.name || '').slice(0, 300));
  if (!f) return res.status(404).json({ error: 'This file isn’t in the clean copy.' });
  res.json(f);
});

// The owner confirms a theme change they made: the theme as it is now becomes the clean copy (the old one is kept).
app.post('/api/stores/:id/theme/clean/confirm', requireUser, requireFeature('theme_watch'), (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  if (!themeClean.cleanView(s.id)) return res.status(404).json({ error: 'There is no clean copy of your theme yet.' });
  if (!themeClean.confirmChange(s.id)) return res.status(409).json({ error: 'Your theme already matches the clean copy. There is nothing to confirm.' });
  res.json({ clean: themeClean.cleanView(s.id) });
});

app.get('/api/stores/:id/theme/clean.zip', requireUser, requireFeature('theme_watch'), (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const v = themeClean.cleanView(s.id);
  if (!v) return res.status(404).json({ error: 'There is no clean copy of your theme yet.' });
  const name = `${String(v.themeName || 'theme').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'theme'}-clean-${String(v.savedAt).slice(0, 10)}.zip`;
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  res.send(themeClean.cleanZip(s.id));
});

// ---------- Security checklist (S11): the owner ticks off what they did; reviews come due again ----------
const securityView = (s) => securityChecklist(s, { shopify: !!shopify.shopForStore(s.id) || /shopify/i.test(s.platform || '') });
app.get('/api/stores/:id/security-checklist', requireUser, requireFeature('security_checklist'), (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  res.json(securityView(s));
});
app.post('/api/stores/:id/security-checklist/:item', requireUser, requireFeature('security_checklist'), (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  if (!isSecurityItem(req.params.item)) return res.status(404).json({ error: 'There is no such item on the checklist.' });
  if (typeof req.body?.done !== 'boolean') return res.status(400).json({ error: 'Say whether it is done (true or false).' });
  tickSecurity(s.id, req.params.item, req.body.done);
  res.json(securityView(s));
});
app.patch('/api/stores/:id/security-checklist', requireUser, requireFeature('security_checklist'), (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  if (typeof req.body?.reminders !== 'boolean') return res.status(400).json({ error: 'Say whether reminders are on (true or false).' });
  setSecurityReminders(s.id, req.body.reminders);
  res.json(securityView(s));
});

// ---------- Incident mode (S12): one button when the store may be hacked or badly broken ----------
const onShopify = (s) => !!shopify.shopForStore(s.id) || /shopify/i.test(s.platform || '');
app.get('/api/stores/:id/incident', requireUser, requireFeature('incident_mode'), (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  res.json(incidentView(s, { shopify: onShopify(s) }));
});
app.post('/api/stores/:id/incident', requireUser, requireFeature('incident_mode'), async (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const why = blockReason(entitlements(s.user_id), s.id);
  if (why) return refuse(res, why);
  if (!s.monitoring) return res.status(400).json({ error: 'Monitoring is paused for this store. Switch it on under Monitoring first, so we can check the store every few minutes.' });
  let row;
  try { row = startIncident(s, { reason: req.body?.reason, contacts: req.body?.contacts }); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  // A full check right away, unless one is already running.
  const runId = q.activeRunForStore.get(s.id) ? null : startRun({ storeId: s.id, origin: s.url, kind: 'full', password: storePassword(s), trigger: 'incident' });
  sendMail(incidentStartEmail(s, row, { shopify: onShopify(s) })).catch((e) => console.error('incident email failed', e));
  res.json({ ...incidentView(s, { shopify: onShopify(s) }), runId });
});
app.patch('/api/stores/:id/incident', requireUser, requireFeature('incident_mode'), (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  try { updateIncident(s.id, { contacts: req.body?.contacts, steps: req.body?.steps }); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  res.json(incidentView(s, { shopify: onShopify(s) }));
});
app.post('/api/stores/:id/incident/end', requireUser, requireFeature('incident_mode'), (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const row = endIncident(s.id, 'owner');
  if (!row) return res.status(404).json({ error: 'Incident mode is not on for this store.' });
  sendMail(incidentEndEmail(s, row)).catch((e) => console.error('incident email failed', e));
  res.json(incidentView(s, { shopify: onShopify(s) }));
});

// Recovery packet (S17): password reset link and a ready-to-send message to Shopify Support.
app.get('/api/stores/:id/recovery-packet', requireUser, requireFeature('incident_mode'), (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  res.json(recoveryPacket(s, { shopify: onShopify(s) }));
});
app.get('/api/stores/:id/recovery-packet.txt', requireUser, requireFeature('incident_mode'), (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const p = recoveryPacket(s, { shopify: onShopify(s) });
  res.set('Content-Disposition', `attachment; filename="recovery-${p.store.host.replace(/[^a-z0-9.-]/gi, '-')}.txt"`).type('text/plain; charset=utf-8').send(`Subject: ${p.message.subject}\n\n${p.message.text}\n`);
});

app.get('/api/stores/:id/scorecard', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  res.json(scorecard(s));
});

app.post('/api/stores/:id/run', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const entRun = entitlements(s.user_id);
  const why = blockReason(entRun, s.id);
  if (why) return refuse(res, why);
  if (q.activeRunForStore.get(s.id)) return res.status(409).json({ error: 'A test is already running for this store.' });
  const today = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE store_id = ? AND trigger = 'manual' AND created_at > datetime('now', '-1 day')").get(s.id).n;
  if (today >= entRun.limits.manualRunsPerDay) return refuse(res, `You’ve started ${today} tests for this store in the last 24 hours, the most your plan allows. Scheduled checks keep running.`, 429);
  // A run can be limited to chosen validation groups. Anything not chosen is skipped for this run only.
  let kind = req.body?.kind === 'journeys' ? 'journeys' : 'full';
  let disabled;
  if (Array.isArray(req.body?.groups)) {
    const chosen = new Set(req.body.groups.map(String));
    for (const g of GROUPS) if (g.locked) chosen.add(g.key);
    disabled = GROUPS.filter((g) => !chosen.has(g.key)).map((g) => g.key);
    kind = GROUPS.some((g) => g.run === 'full' && chosen.has(g.key)) ? 'full' : 'journeys';
  }
  res.json({ runId: startRun({ storeId: s.id, origin: s.url, kind, password: storePassword(s), trigger: 'manual', disabled }), kind });
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
  const env = r.environment_id ? q.envById.get(r.environment_id) : null;
  return { id: r.id, seq: r.seq, preview_url: r.preview_url, label: r.label, status: r.status, verdict: r.verdict, trigger: r.trigger, environment: env ? { id: env.id, name: env.name, kind: env.kind } : null, created_at: r.created_at, finished_at: r.finished_at, summary: sum, runs: { live: run(r.live_run_id), draft: run(r.draft_run_id) } };
};
app.get('/api/stores/:id/releases', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  res.json({ releases: q.releasesByStore.all(s.id).map((r) => { const v = releaseView(r); delete v.runs; if (v.summary) v.summary = { headline: v.summary.headline, theme: v.summary.theme, counts: { blockers: v.summary.blockers?.length || 0, reviews: v.summary.reviews?.length || 0, fixes: v.summary.fixes?.length || 0, visual: v.summary.visualChanged || 0 }, error: v.summary.error }; return v; }) });
});
app.post('/api/stores/:id/releases', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const ent = entitlements(s.user_id);
  if (blockReason(ent, s.id)) return refuse(res, blockReason(ent, s.id));
  if (!has(ent, 'publish')) return refuse(res, notIncluded('publish', 'Safe to publish'));
  if (req.body?.environmentId && !envAllowed(ent, s.id, Number(req.body.environmentId))) return refuse(res, has(ent, 'environments') ? `Your plan covers ${ent.limits.environments} environment${ent.limits.environments === 1 ? '' : 's'} per store. Remove one to check this one.` : notIncluded('environments', 'Saved environments'));
  if (q.activeRunForStore.get(s.id)) return res.status(409).json({ error: 'A test is running for this store. Start the publish check when it finishes.' });
  const label = String(req.body?.label || '').trim().slice(0, 120);
  if (req.body?.environmentId) {
    const env = q.envById.get(Number(req.body.environmentId));
    if (!env || env.store_id !== s.id) return res.status(404).json({ error: 'Environment not found.' });
    return res.json({ id: startRelease(s, { url: env.url, label, env }) });
  }
  let url;
  // From the Shopify app: a draft theme picked from the store's own theme list.
  const themeId = req.body?.themeId ? String(req.body.themeId) : null;
  if (themeId && !/^\d{1,20}$/.test(themeId)) return res.status(400).json({ error: 'Unknown theme' });
  try { url = themeId ? `${s.url.replace(/\/$/, '')}/?preview_theme_id=${themeId}` : previewUrlFor(s, String(req.body?.url || '').trim()); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json({ id: startRelease(s, { url, label: label || (req.body?.themeName ? String(req.body.themeName).slice(0, 120) : '') }) });
});

// ---------- Environments (staging themes and stores) and release gates ----------
const newToken = () => 'tg_' + crypto.randomBytes(18).toString('base64url');
const envView = (e) => {
  const last = q.lastReleaseForEnv.get(e.id);
  return { id: e.id, name: e.name, kind: e.kind, url: e.url, hasPassword: !!e.password, auto: e.auto, token: e.token, created_at: e.created_at,
    last: last ? { id: last.id, status: last.status, verdict: last.verdict, created_at: last.created_at, trigger: last.trigger } : null };
};
async function checkEnvTarget(env) {
  if (env.kind === 'store') await assertPublicTarget(new URL(env.url).origin);
}
app.get('/api/stores/:id/environments', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  res.json({ environments: q.envsByStore.all(s.id).map(envView) });
});
app.post('/api/stores/:id/environments', requireUser, async (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const ent = entitlements(s.user_id);
  if (!has(ent, 'environments')) return refuse(res, notIncluded('environments', 'Saved environments'));
  if (q.envsByStore.all(s.id).length >= ent.limits.environments) return refuse(res, `Your plan allows ${ent.limits.environments} environment${ent.limits.environments === 1 ? '' : 's'} per store.`);
  let e;
  try { e = cleanEnvironment(s, req.body || {}); await checkEnvTarget(e); } catch (x) { return res.status(400).json({ error: x.message }); }
  const info = q.insertEnv.run(s.id, e.name, e.kind, e.url, e.password, e.auto, newToken());
  res.json(envView(q.envById.get(Number(info.lastInsertRowid))));
});
const ownEnv = (req, res) => {
  const s = ownStore(req, res);
  if (!s) return null;
  const env = q.envById.get(Number(req.params.eid));
  if (!env || env.store_id !== s.id) { res.status(404).json({ error: 'Environment not found.' }); return null; }
  return { s, env };
};
app.patch('/api/stores/:id/environments/:eid', requireUser, async (req, res) => {
  const o = ownEnv(req, res);
  if (!o) return;
  if (!has(entitlements(o.s.user_id), 'environments')) return refuse(res, notIncluded('environments', 'Saved environments'));
  let e;
  try { e = cleanEnvironment(o.s, req.body || {}, o.env); await checkEnvTarget(e); } catch (x) { return res.status(400).json({ error: x.message }); }
  q.updateEnv.run(e.name, e.kind, e.url, e.password, e.auto, o.env.id);
  res.json(envView(q.envById.get(o.env.id)));
});
app.delete('/api/stores/:id/environments/:eid', requireUser, (req, res) => {
  const o = ownEnv(req, res);
  if (!o) return;
  q.deleteEnv.run(o.env.id);
  res.json({ ok: true });
});
app.post('/api/stores/:id/environments/:eid/token', requireUser, (req, res) => {
  const o = ownEnv(req, res);
  if (!o) return;
  q.setEnvToken.run(newToken(), o.env.id);
  res.json(envView(q.envById.get(o.env.id)));
});

// A deploy pipeline (GitHub Actions, Bitbucket, a script) starts a publish check with the environment's key,
// then polls for the verdict and stops the deploy when it is "blocked".
const gateView = (r) => {
  const sum = r.summary_json ? JSON.parse(r.summary_json) : null;
  const done = r.status !== 'running';
  return { id: r.id, status: r.status, verdict: r.verdict, pass: r.status === 'done' ? r.verdict !== 'blocked' : null, done,
    headline: sum?.headline || sum?.error || (done ? null : 'Testing live and candidate side by side'),
    blockers: (sum?.blockers || []).map((x) => ({ title: x.title, detail: x.detail })), report: `${config.baseUrl}/app#/s/${r.store_id}/publish/${r.id}` };
};
const gateEnv = (req, res) => {
  const t = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '') || String(req.params.token || '');
  const env = t ? q.envByToken.get(t) : null;
  if (!env) { res.status(401).json({ error: 'Unknown key. Copy it again from Safe to publish → Environments.' }); return null; }
  const store = q.storeById.get(env.store_id);
  if (!store) { res.status(404).json({ error: 'Store not found.' }); return null; }
  const ent = entitlements(store.user_id);
  const why = blockReason(ent, store.id) || (!has(ent, 'pipeline') ? notIncluded('pipeline', 'Deploy pipeline checks') : !envAllowed(ent, store.id, env.id) ? 'This environment is beyond what your plan covers.' : null);
  if (why) { res.status(402).json({ error: why }); return null; }
  return { env, store };
};
app.post(['/api/gate', '/api/gate/:token'], async (req, res) => {
  const g = gateEnv(req, res);
  if (!g) return;
  // A pipeline may send a fresh preview link for the theme it just pushed.
  let url = g.env.url;
  if (req.body?.url) {
    try { url = cleanEnvironment(g.store, { url: req.body.url }, g.env).url; await checkEnvTarget({ ...g.env, url }); } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  const running = q.lastReleaseForEnv.get(g.env.id);
  if (running?.status === 'running') return res.json(gateView(running));
  if (q.activeRunForStore.get(g.store.id)) return res.status(409).json({ error: 'A test is already running for this store. Try again in a few minutes.' });
  const label = String(req.body?.label || req.body?.commit || '').trim().slice(0, 120) || `Deploy check of ${g.env.name}`;
  const id = startRelease(g.store, { url, label, env: { ...g.env, url }, trigger: 'ci' });
  res.status(202).json(gateView(q.releaseById.get(id)));
});
app.get(['/api/gate/:token/:rid', '/api/gate/check/:rid'], (req, res) => {
  const g = gateEnv(req, res);
  if (!g) return;
  const r = q.releaseById.get(Number(req.params.rid));
  if (!r || r.environment_id !== g.env.id) return res.status(404).json({ error: 'Check not found.' });
  res.json(gateView(r));
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
  if (!entitlements(s.user_id).usable) return refuse(res, blockReason(entitlements(s.user_id)));
  if (!countLookup(req.user.id)) return res.status(429).json({ error: 'Too many lookups this hour. Try again later.' });
  try {
    res.json(await withLookupSlot(req.user.id, () => discoverStore(s.url, storePassword(s))));
  } catch (e) {
    if (e.code === 'QUEUE_FULL') return res.status(e.status).json({ error: e.message, busy: true });
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
  if (overLimit(`test-alert:${s.id}`, LIMITS.testAlerts)) return tooMany(res, 'test alerts for this store');
  const name = s.name || new URL(s.url).host;
  const text = `This is a test alert for ${name} from Tharam Store Guard. Real alerts look like this, with what broke, how to fix it, and a link to the report.\n\n${config.baseUrl}/app#/s/${s.id}`;
  const chat = has(entitlements(s.user_id), 'slack');
  const [mail, slack, webhook] = await Promise.all([
    sendMail({ to: s.alert_email, subject: `Test alert for ${name}`, text }).catch(() => false),
    s.slack_webhook && chat ? sendSlack(s.slack_webhook, `*Test alert for ${name}*\n${text}`).catch(() => false) : Promise.resolve(null),
    chat && isOn('webhooks') ? deliverWebhook(s, { event: 'test', subject: `Test alert for ${name}`, text }, { retry: false }).catch(() => ({ ok: false, error: 'Could not send' })) : Promise.resolve(null),
  ]);
  res.json({ email: mail, slack, webhook, emailConfigured: !!config.smtp.host });
});

app.get('/api/stores/:id/webhook-deliveries', requireUser, requireFeature('webhooks'), (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  res.json({ deliveries: recentDeliveries(s.id, 20) });
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

app.get('/baselines/:sid/:file', (req, res) => {
  const s = q.storeById.get(Number(req.params.sid));
  if (!s || !/^(home|product)-(desktop|tablet|mobile)\.png$/.test(req.params.file)) return res.status(404).end();
  // The owner's login, or (inside Shopify admin) a signed link for this exact file.
  if (currentUserId(req) !== s.user_id && !validFileSig(`/baselines/${s.id}/${req.params.file}`, req.query.t)) return res.status(404).end();
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

// Sale readiness: one report before a sale, from the latest full check (or ?run=), and as an email.
app.get('/api/stores/:id/sale-readiness', requireUser, requireFeature('sale_report'), (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const r = saleReadiness(s, req.query.run ? Number(req.query.run) || -1 : null);
  if (!r) return res.status(404).json({ error: 'No full check yet. Run a sale readiness check first.', groups: saleGroups(s), recipient: saleRecipients(s) });
  res.json({ ...r, groups: saleGroups(s), recipient: saleRecipients(s) });
});

app.post('/api/stores/:id/sale-readiness/email', requireUser, requireFeature('sale_report'), async (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const r = saleReadiness(s, req.body?.run ? Number(req.body.run) || -1 : null);
  if (!r) return res.status(404).json({ error: 'No full check yet. Run a sale readiness check first.' });
  const to = saleRecipients(s);
  if (!to) return res.status(400).json({ error: 'Add an alert email under Alerts first.' });
  try { res.json(await emailSaleReadiness(s, r, to)); } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'The email could not be sent. Try again in a minute.' }); }
});

// App Health: every app and service seen on the storefront, from the latest checks.
app.get('/api/stores/:id/apps', requireUser, requireFeature('app_health'), (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  res.json({ ...appHealth(s), earlyWarnings: warningsFor(s.id) });
});

// ---------- Exports: CSV and printable / PDF report (owner only) ----------
const sendFile = (res, name, type, body) => { res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); res.send(body); };
app.get('/api/stores/:id/export/runs.csv', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  sendFile(res, exportName(s, 'checks-history'), 'text/csv; charset=utf-8', runsCsv(s, req.query.days));
});
app.get('/api/stores/:id/export/checks.csv', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const run = runFor(s, req.query.run);
  if (!run || !run.result_json) return res.status(404).json({ error: 'Report not found' });
  sendFile(res, exportName(s, `check-${run.seq ?? run.id}`), 'text/csv; charset=utf-8', checksCsv(s, run));
});
app.get('/api/stores/:id/export/products.csv', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  if (req.query.run && !runFor(s, req.query.run)) return res.status(404).json({ error: 'Report not found' });
  const out = productsCsv(s, req.query.run);
  if (!out) return res.status(404).json({ error: 'No product list yet. Run a full check first.' });
  sendFile(res, exportName(s, 'products'), 'text/csv; charset=utf-8', out.csv);
});
app.get('/api/stores/:id/runs/:runId/report.html', requireUser, (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const run = runFor(s, req.params.runId);
  if (!run || !run.result_json) return res.status(404).json({ error: 'Report not found' });
  res.set({ 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
  res.type('html').send(reportHtml(s, run, { autoPrint: req.query.print === '1' }));
});
app.get('/api/stores/:id/runs/:runId/report.pdf', requireUser, async (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  const run = runFor(s, req.params.runId);
  if (!run || !run.result_json) return res.status(404).json({ error: 'Report not found' });
  try {
    sendFile(res, exportName(s, `report-${run.seq ?? run.id}`, 'pdf'), 'application/pdf', await reportPdf(s, run));
  } catch (e) {
    console.error('pdf export failed', e.message);
    res.status(503).json({ error: 'The PDF could not be made right now. Try again in a minute, or use Print instead.' });
  }
});

app.post('/api/stores/:id/explain-change', requireUser, async (req, res) => {
  const s = ownStore(req, res);
  if (!s) return;
  if (!aiEnabled()) return res.status(400).json({ error: 'AI review is not set up on this server.' });
  const entAi = entitlements(s.user_id);
  if (blockReason(entAi, s.id)) return refuse(res, blockReason(entAi, s.id));
  if (!has(entAi, 'ai')) return refuse(res, notIncluded('ai', 'AI review'));
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

// ---------- Sale plans and the sale rehearsal ----------
// Sale plans, go-live checks and the sale calendar answer only while the feature is switched on.
app.use(['/api/stores/:id/sale-plans', '/api/stores/:id/sale-calendar'], requireFeature('sale_plans'));
salePlanRoutes(app, { requireUser, ownStore, refuse });
saleLiveRoutes(app, { requireUser, ownStore, refuse });
saleCalendarRoutes(app, { requireUser, ownStore, refuse });

// ---------- Founder console: customers, licences, payments, plans ----------
adminRoutes(app, { requireUser, isAdmin });
runnerRoutes(app, { requireUser, isAdmin });

// ---------- Founder view ----------
app.get('/api/admin/overview', requireUser, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  res.json({
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    stores: db.prepare('SELECT COUNT(*) AS n FROM stores').get().n,
    freeScans24h: db.prepare("SELECT COUNT(*) AS n FROM runs WHERE kind='free' AND created_at > datetime('now','-1 day')").get().n,
    leads: db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 200').all(),
    recentScans: db.prepare("SELECT id, public_id, url, score, verdict, status, created_at FROM runs WHERE kind='free' ORDER BY id DESC LIMIT 100").all(),
    signups: db.prepare('SELECT u.id, u.email, u.name, u.created_at, (SELECT GROUP_CONCAT(url) FROM stores WHERE user_id=u.id) AS stores FROM users u ORDER BY id DESC LIMIT 200').all(),
    queue: queueDepth(),
  });
});

// Public plans and prices, for the in-app plan picker (same data as the pricing page).
app.get('/api/public/plans', (req, res) => {
  res.json({ plans: listPlans().filter((p) => p.public && p.active).map(({ key, name, tagline, kind, prices, highlight, limits }) => ({ key, name, tagline, kind, prices, highlight, maxStores: limits.maxStores })) });
});

app.get('/healthz', (req, res) => res.json({ ok: true, queue: queueDepth() }));
app.get('/api/public-config', (req, res) => res.json({ calLink: config.calLink, contactEmail: config.contactEmail }));

// ---------- Website ----------
const page = (f) => (req, res) => res.sendFile(path.join(config.publicDir, f));
// ---------- Website (server-rendered from src/site) ----------
const html = (render) => (req, res) => {
  const out = render(req);
  if (!out) return res.status(404).type('html').send(site.legacy(config.publicDir, '404.html', { title: 'Page not found', noindex: true }));
  res.set('Cache-Control', 'public, max-age=300').type('html').send(out);
};
const old = (file, opts) => html(() => site.legacy(config.publicDir, file, opts));
pluginRoutes(app);
app.get('/', html(() => site.home()));
app.get('/de', html(() => site.deHome()));
app.get('/fr', html(() => site.frHome()));
app.get('/es', html(() => site.esHome()));
app.get('/commerce-assurance', html(() => site.category()));
app.get('/features', html(() => site.productIndex()));
app.get('/features/:slug', html((req) => site.product(req.params.slug)));
app.get(['/product', '/product/:slug'], (req, res) => res.redirect(301, req.params.slug ? `/features/${req.params.slug}` : '/features'));
app.get('/platforms', html(() => site.platformIndex()));
app.get('/platforms/:slug', html((req) => site.platform(req.params.slug)));
app.get('/marketplaces', html(() => site.marketIndex()));
app.get('/marketplaces/:slug', html((req) => site.market(req.params.slug)));
app.get('/pricing', html(() => site.pricing()));
app.get('/managed', html(() => site.managed()));
app.get(['/sale-ready', '/black-friday'], html(() => site.saleReady()));
app.get('/scan/:id', old('report.html', { title: 'Store check report', noindex: true }));
const appHtml = fs.readFileSync(path.join(config.publicDir, 'app.html'), 'utf8').replace(/(\/assets\/[\w./-]+\.(?:css|js))"/g, `$1?v=${site.VERSION}"`);
app.get('/app', (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(appHtml));
shopifyRoutes(app, { requireUser, appHtml });
paymentRoutes(app, { requireUser });
webAccessRoutes(app, { requireUser, isEmail, admins: ADMINS });
app.get('/privacy', old('privacy.html', { path: '/privacy' }));
app.get('/terms', old('terms.html', { path: '/terms' }));
app.get('/bot', old('bot.html', { path: '/bot' }));
app.get('/checks', old('checks.html', { path: '/checks' }));
app.get('/demo', old('demo.html', { path: '/demo' }));
app.use(express.static(config.publicDir, { maxAge: '1h', index: false }));
app.use((req, res) => res.status(404).type('html').send(site.legacy(config.publicDir, '404.html', { title: 'Page not found', noindex: true })));
// A full waiting line anywhere (manual checks, publish checks, Shopify app actions): a plain "busy" answer.
app.use((err, req, res, next) => {
  if (err?.code !== 'QUEUE_FULL') return next(err);
  res.status(err.status || 503).json({ error: err.message, busy: true });
});

app.listen(config.port, () => {
  console.log(`Tharam Store Guard on ${config.baseUrl} (port ${config.port})`);
  if (process.env.DISABLE_SCHEDULER !== '1') startScheduler();
});

// Docker sends SIGTERM on redeploy; Node as PID 1 ignores it unless handled. Runs in flight are
// marked "Interrupted by restart" on the next start.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
