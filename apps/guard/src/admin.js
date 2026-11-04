/** Founder console API: customers, licences, payments, plans, settings and the audit log. Admins only. */
import { db, q } from './db.js';
import {
  FEATURES, CURRENCIES, listPlans, getPlan, savePlan, entitlements, licenseView, updateLicense, recordPayment,
  stateOf, mrrOf, priceOf, ensureLicense, setting, setSetting, audit, blockReason,
} from './license.js';
import { sendReceipt } from './billing-mail.js';

const SETTINGS = ['signup_plan', 'trial_days', 'grace_days', 'payment_note'];

export function adminRoutes(app, { requireUser, isAdmin }) {
  const admin = (req, res, next) => requireUser(req, res, () => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Forbidden' })));
  const actor = (req) => req.user.email;
  const fail = (res, e) => res.status(400).json({ error: e.message || String(e) });
  const user = (req, res) => {
    const u = q.userById.get(Number(req.params.uid));
    if (!u) { res.status(404).json({ error: 'Customer not found' }); return null; }
    return u;
  };

  function customerRows() {
    const rows = db.prepare(`SELECT u.id, u.email, u.name, u.created_at,
        (SELECT COUNT(*) FROM stores s WHERE s.user_id = u.id) AS stores,
        (SELECT MAX(r.created_at) FROM runs r JOIN stores s ON s.id = r.store_id WHERE s.user_id = u.id) AS last_run,
        (SELECT MAX(p.created_at) FROM payments p WHERE p.user_id = u.id) AS last_payment
      FROM users u ORDER BY u.id DESC`).all();
    return rows.map((r) => {
      const l = ensureLicense(r.id);
      const plan = getPlan(l.plan_key);
      return { ...r, license_id: l.id, plan: plan?.name || l.plan_key, plan_key: l.plan_key, plan_kind: plan?.kind, seats: l.seats, status: l.status, state: stateOf(l), expires_at: l.expires_at,
        currency: l.currency, billing: l.billing, mrr: mrrOf(l), price: priceOf(l, plan) };
    });
  }

  app.get('/api/admin/billing', admin, (req, res) => {
    const rows = customerRows();
    const by = (k) => rows.filter((r) => r.state === k).length;
    const mrr = {};
    for (const r of rows) if (r.mrr) mrr[r.currency] = (mrr[r.currency] || 0) + r.mrr;
    const rev30 = db.prepare("SELECT currency, SUM(amount) AS amount, COUNT(*) AS n FROM payments WHERE created_at > datetime('now', '-30 days') GROUP BY currency").all();
    const soon = rows.filter((r) => r.expires_at && ['active', 'trial', 'grace'].includes(r.state) && new Date(r.expires_at.replace(' ', 'T') + 'Z') - Date.now() < 14 * 864e5)
      .sort((a, b) => a.expires_at.localeCompare(b.expires_at));
    const plans = {};
    for (const r of rows) plans[r.plan] = (plans[r.plan] || 0) + 1;
    res.json({
      counts: { customers: rows.length, paying: rows.filter((r) => r.mrr > 0).length, trial: by('trial'), active: by('active'), grace: by('grace'), expired: by('expired'), suspended: by('suspended'), cancelled: by('cancelled') },
      mrr, rev30, expiringSoon: soon.slice(0, 50), plans,
      recentPayments: db.prepare('SELECT p.*, u.email FROM payments p JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT 10').all(),
    });
  });

  app.get('/api/admin/customers', admin, (req, res) => {
    let rows = customerRows();
    const qs = String(req.query.q || '').trim().toLowerCase();
    if (qs) rows = rows.filter((r) => r.email.toLowerCase().includes(qs) || (r.name || '').toLowerCase().includes(qs));
    if (req.query.state) rows = rows.filter((r) => r.state === req.query.state);
    if (req.query.plan) rows = rows.filter((r) => r.plan_key === req.query.plan);
    res.json({ customers: rows });
  });

  app.get('/api/admin/customers/:uid', admin, (req, res) => {
    const u = user(req, res);
    if (!u) return;
    const ent = entitlements(u.id);
    res.json({
      user: u, license: { ...ent.license, state: ent.state, mrr: mrrOf(ent.license), price: priceOf(ent.license, ent.plan) }, view: licenseView(u.id),
      stores: q.storesByUser.all(u.id).map((s) => ({ id: s.id, url: s.url, name: s.name, platform: s.platform, monitoring: s.monitoring, last_status: s.last_status, last_run_at: s.last_run_at, blocked: blockReason(ent, s.id) })),
      payments: db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC').all(u.id),
      audit: db.prepare('SELECT * FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(u.id),
    });
  });

  app.patch('/api/admin/customers/:uid/license', admin, (req, res) => {
    const u = user(req, res);
    if (!u) return;
    try { updateLicense(actor(req), u.id, req.body || {}); res.json({ ok: true, view: licenseView(u.id) }); } catch (e) { fail(res, e); }
  });

  app.post('/api/admin/customers/:uid/payments', admin, async (req, res) => {
    const u = user(req, res);
    if (!u) return;
    let l;
    try { l = recordPayment(actor(req), u.id, req.body || {}); } catch (e) { return fail(res, e); }
    const p = db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(u.id);
    if (req.body?.sendReceipt !== false) sendReceipt(u, p, l).catch((e) => console.error('receipt failed', e));
    res.json({ ok: true, view: licenseView(u.id), payment: p });
  });

  app.post('/api/admin/customers/:uid/note', admin, (req, res) => {
    const u = user(req, res);
    if (!u) return;
    const text = String(req.body?.text || '').trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'Write a note' });
    audit(actor(req), u.id, 'note', { text });
    res.json({ ok: true });
  });

  app.get('/api/admin/plans', admin, (req, res) => {
    const used = Object.fromEntries(db.prepare('SELECT plan_key, COUNT(*) AS n FROM licenses GROUP BY plan_key').all().map((r) => [r.plan_key, r.n]));
    res.json({ plans: listPlans().map((p) => ({ ...p, customers: used[p.key] || 0 })), features: FEATURES.map(({ key, label, always }) => ({ key, label, always: !!always })), currencies: CURRENCIES });
  });
  app.post('/api/admin/plans', admin, (req, res) => {
    try { res.json({ plan: savePlan(actor(req), String(req.body?.key || ''), req.body || {}, { create: true }) }); } catch (e) { fail(res, e); }
  });
  app.patch('/api/admin/plans/:key', admin, (req, res) => {
    try { res.json({ plan: savePlan(actor(req), req.params.key, req.body || {}) }); } catch (e) { fail(res, e); }
  });

  app.get('/api/admin/payments', admin, (req, res) => {
    res.json({ payments: db.prepare('SELECT p.*, u.email FROM payments p JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT 500').all() });
  });
  app.get('/api/admin/audit', admin, (req, res) => {
    res.json({ audit: db.prepare('SELECT a.*, u.email FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 500').all() });
  });
  app.get('/api/admin/settings', admin, (req, res) => {
    res.json({ settings: Object.fromEntries(SETTINGS.map((k) => [k, setting(k)])), plans: listPlans().map((p) => ({ key: p.key, name: p.name, kind: p.kind })) });
  });
  app.patch('/api/admin/settings', admin, (req, res) => {
    try {
      const b = req.body || {};
      const clean = {};
      if (b.signup_plan !== undefined) {
        const p = getPlan(String(b.signup_plan));
        if (!p || !p.active || p.kind === 'paid') throw new Error('New signups must start on an available free or trial plan');
        clean.signup_plan = p.key;
      }
      const int = (v, lo, hi, label) => { const n = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN; if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${label} must be a whole number from ${lo} to ${hi}`); return String(n); };
      if (b.trial_days !== undefined) clean.trial_days = int(b.trial_days, 1, 90, 'Trial days');
      if (b.grace_days !== undefined) clean.grace_days = int(b.grace_days, 0, 90, 'Grace days');
      if (b.payment_note !== undefined) { const t = String(b.payment_note).trim(); if (!t) throw new Error('Write how customers can pay'); clean.payment_note = t.slice(0, 2000); }
      for (const [k, v] of Object.entries(clean)) if (v !== setting(k)) setSetting(actor(req), k, v);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
}
