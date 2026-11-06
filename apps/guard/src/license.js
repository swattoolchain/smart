/**
 * Plans, licences and payments. This is the one place that decides what a customer may use.
 *
 * Model
 *  - A plan says what each store gets (features and limits) and its price per store, per month or year.
 *  - Every account has exactly one licence: a plan, a number of store seats, a status and an expiry date.
 *  - Price = plan price per store × seats (or a custom price agreed with the customer).
 *  - Recording a payment extends the expiry by the periods paid and reactivates the licence.
 *  - Every change is written to an append-only audit log.
 *
 * States (computed, never trusted from the client)
 *  trial / active  usable until expires_at (null = no expiry)
 *  grace           an active licence past expiry, still usable for `grace_days` so a late payment never stops a store
 *  expired         past expiry (trials have no grace): read-only, no tests run
 *  suspended       stopped by the founder: read-only
 *  cancelled       ended: read-only
 */
import { db } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tagline TEXT,
  kind TEXT NOT NULL DEFAULT 'paid',          -- paid | free | trial
  prices_json TEXT NOT NULL DEFAULT '{}',     -- {"USD":{"month":1900,"year":19000}} minor units, per store
  features_json TEXT NOT NULL DEFAULT '[]',
  limits_json TEXT NOT NULL DEFAULT '{}',     -- journeyMinInterval, fullMinInterval, environments, maxStores
  public INTEGER NOT NULL DEFAULT 1,
  highlight INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan_key TEXT NOT NULL REFERENCES plans(key),
  seats INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',      -- trial | active | suspended | cancelled
  billing TEXT NOT NULL DEFAULT 'month',      -- month | year | custom
  currency TEXT NOT NULL DEFAULT 'USD',
  price_override INTEGER,                     -- minor units per billing period for the whole licence
  starts_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  grace_days INTEGER,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,                    -- minor units
  currency TEXT NOT NULL,
  method TEXT NOT NULL,                       -- bank | upi | card | razorpay | stripe | shopify | other
  reference TEXT,
  period TEXT NOT NULL,                       -- month | year
  periods INTEGER NOT NULL DEFAULT 1,
  covers_from TEXT NOT NULL,
  covers_to TEXT NOT NULL,
  note TEXT,
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id, id DESC);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  actor TEXT NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS audit_user ON audit(user_id, id DESC);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS license_notices (license_id INTEGER, kind TEXT, expires_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (license_id, kind, expires_at));
`);
// The audit log is append-only, even for the founder.
db.exec(`CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
DROP TRIGGER IF EXISTS audit_no_replace;
CREATE TRIGGER audit_no_replace BEFORE INSERT ON audit WHEN NEW.id > 0 AND NEW.id <= (SELECT IFNULL(MAX(id), 0) FROM audit) BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE UNIQUE INDEX IF NOT EXISTS payments_reference ON payments(reference) WHERE reference IS NOT NULL;`);

/** What a plan can include. Each feature switches validation groups or product areas on. */
export const FEATURES = [
  { key: 'journeys', label: 'Shopping checks: search, product, add to cart, checkout', groups: ['journey.core', 'journey.collection', 'journey.search', 'journey.variant', 'journey.checkout', 'errors.js', 'sale.discount'], always: true },
  { key: 'quality', label: 'Speed, Google, mobile, accessibility and broken links', groups: ['speed', 'seo', 'a11y', 'links', 'policies'] },
  { key: 'catalog', label: 'Product and price checks on every product', groups: ['catalog'] },
  { key: 'visual', label: 'Design change detection with screenshots', groups: ['visual'] },
  { key: 'publish', label: 'Safe to publish: check a theme before it goes live' },
  { key: 'environments', label: 'Saved staging environments, checked daily' },
  { key: 'pipeline', label: 'Deploy pipeline checks (GitHub and others)' },
  { key: 'regional', label: 'Laws where you sell (Germany, EU, UK, US)', groups: ['law.de', 'law.cookies', 'access.law', 'law.us'] },
  { key: 'ai', label: 'AI that looks at your store like a shopper', groups: ['ai.visual', 'ai.copy'] },
  { key: 'slack', label: 'Slack alerts' },
];
const FEATURE_KEYS = FEATURES.map((f) => f.key);
export function featureOfGroup(group) {
  return FEATURES.find((f) => f.groups?.includes(group))?.key || null;
}

const ALL = FEATURE_KEYS;
const DEFAULT_PLANS = [
  { key: 'beta', name: 'Beta', tagline: 'Everything, free while we’re in beta.', kind: 'free', prices: {}, features: ALL,
    limits: { journeyMinInterval: 60, fullMinInterval: 720, environments: 10, maxStores: 5 }, public: 1, highlight: 1, sort: 0 },
  { key: 'trial', name: 'Free trial', tagline: 'Everything in Pro for 14 days.', kind: 'trial', prices: {}, features: ALL,
    limits: { journeyMinInterval: 60, fullMinInterval: 720, environments: 3, maxStores: 3 }, public: 0, highlight: 0, sort: 1 },
  { key: 'starter', name: 'Starter', tagline: 'Know when customers can’t buy.', kind: 'paid',
    prices: { USD: { month: 1900, year: 19000 }, EUR: { month: 1900, year: 19000 }, INR: { month: 149900, year: 1499000 } },
    features: ['journeys', 'quality'], limits: { journeyMinInterval: 1440, fullMinInterval: 1440, environments: 0, maxStores: null }, public: 1, highlight: 0, sort: 2 },
  { key: 'growth', name: 'Growth', tagline: 'Change your store without breaking it.', kind: 'paid',
    prices: { USD: { month: 4900, year: 49000 }, EUR: { month: 4500, year: 45000 }, INR: { month: 399900, year: 3999000 } },
    features: ['journeys', 'quality', 'catalog', 'visual', 'publish', 'environments', 'regional', 'slack'], limits: { journeyMinInterval: 60, fullMinInterval: 1440, environments: 3, maxStores: null }, public: 1, highlight: 0, sort: 3 },
  { key: 'pro', name: 'Pro', tagline: 'For busy stores and teams that ship often.', kind: 'paid',
    prices: { USD: { month: 9900, year: 99000 }, EUR: { month: 8900, year: 89000 }, INR: { month: 799900, year: 7999000 } },
    features: ALL, limits: { journeyMinInterval: 30, fullMinInterval: 720, environments: 10, maxStores: null }, public: 1, highlight: 0, sort: 4 },
];
const DEFAULT_SETTINGS = { browser_hour_cost: '0.01', cost_currency: 'EUR', signup_plan: 'beta', trial_days: '14', grace_days: '7', payment_note: 'To pay or upgrade, write to hello@tharam.store. We accept bank transfer, UPI and cards, and send an invoice for every payment.' };

const insPlan = db.prepare('INSERT OR IGNORE INTO plans (key, name, tagline, kind, prices_json, features_json, limits_json, public, highlight, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
for (const p of DEFAULT_PLANS) insPlan.run(p.key, p.name, p.tagline, p.kind, JSON.stringify(p.prices), JSON.stringify(p.features), JSON.stringify(p.limits), p.public, p.highlight, p.sort);
const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

const S = {
  plan: db.prepare('SELECT * FROM plans WHERE key = ?'),
  plans: db.prepare('SELECT * FROM plans ORDER BY sort, key'),
  lic: db.prepare('SELECT * FROM licenses WHERE user_id = ?'),
  licById: db.prepare('SELECT * FROM licenses WHERE id = ?'),
  insLic: db.prepare('INSERT INTO licenses (user_id, plan_key, seats, status, billing, currency, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  setting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  putSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  audit: db.prepare('INSERT INTO audit (actor, user_id, action, detail_json) VALUES (?, ?, ?, ?)'),
  storeIds: db.prepare('SELECT id FROM stores WHERE user_id = ? ORDER BY id'),
  user: db.prepare('SELECT id, email, name FROM users WHERE id = ?'),
};

export const setting = (k) => S.setting.get(k)?.value ?? DEFAULT_SETTINGS[k] ?? null;
export function setSetting(actor, k, v) {
  if (!(k in DEFAULT_SETTINGS)) throw new Error('Unknown setting');
  const before = setting(k);
  S.putSetting.run(k, String(v));
  audit(actor, null, 'setting.change', { key: k, before, after: String(v) });
}
export function audit(actor, userId, action, detail) {
  S.audit.run(String(actor), userId ?? null, action, detail ? JSON.stringify(detail) : null);
}

export function parsePlan(row) {
  if (!row) return null;
  return { key: row.key, name: row.name, tagline: row.tagline, kind: row.kind, prices: JSON.parse(row.prices_json), features: JSON.parse(row.features_json).filter((f) => FEATURE_KEYS.includes(f)),
    limits: JSON.parse(row.limits_json), public: !!row.public, highlight: !!row.highlight, active: !!row.active, sort: row.sort };
}
export const getPlan = (key) => parsePlan(S.plan.get(key));
export const listPlans = () => S.plans.all().map(parsePlan);

// ---------- dates ----------
const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const toMs = (s) => (s ? new Date(s.replace(' ', 'T') + (s.length <= 19 ? 'Z' : '')).getTime() : null);
const toSql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
function addPeriods(ms, period, n) {
  const d = new Date(ms);
  if (period === 'year') d.setUTCFullYear(d.getUTCFullYear() + n);
  else if (period === 'day') d.setUTCDate(d.getUTCDate() + n);
  else {
    const day = d.getUTCDate();
    d.setUTCMonth(d.getUTCMonth() + n);
    if (d.getUTCDate() < day) d.setUTCDate(0); // 31 Jan + 1 month = 28/29 Feb, not 3 Mar
  }
  return d.getTime();
}

/** Makes sure an account has a licence. New accounts get the signup plan from settings. */
export function ensureLicense(userId, actor = 'system') {
  let l = S.lic.get(userId);
  if (l) return l;
  const planKey = getPlan(setting('signup_plan'))?.key || 'beta';
  const plan = getPlan(planKey);
  const trial = plan.kind === 'trial';
  const expires = trial ? toSql(addPeriods(Date.now(), 'day', Number(setting('trial_days')) || 14)) : null;
  const seats = plan.limits.maxStores || 1;
  S.insLic.run(userId, planKey, seats, trial ? 'trial' : 'active', plan.kind === 'paid' ? 'month' : 'custom', 'USD', expires);
  l = S.lic.get(userId);
  audit(actor, userId, 'license.create', { plan: planKey, seats, status: l.status, expires_at: expires });
  return l;
}
// Every existing account gets a licence on its current plan (the beta).
for (const u of db.prepare('SELECT u.id FROM users u LEFT JOIN licenses l ON l.user_id = u.id WHERE l.id IS NULL').all()) ensureLicense(u.id, 'migration');

/** Grace days for a licence: its own value, else the setting, else 7. Never NaN. */
function graceDays(l) {
  if (Number.isInteger(l.grace_days) && l.grace_days >= 0) return l.grace_days;
  const n = Number(setting('grace_days'));
  return Number.isInteger(n) && n >= 0 && n <= 90 ? n : 7;
}

export function stateOf(l, now = Date.now()) {
  if (l.status === 'suspended' || l.status === 'cancelled') return l.status;
  const exp = toMs(l.expires_at);
  if (exp == null || now <= exp) return l.status === 'trial' ? 'trial' : 'active';
  if (l.status === 'trial') return 'expired';
  const grace = graceDays(l) * 864e5;
  return now <= exp + grace ? 'grace' : 'expired';
}
const USABLE = new Set(['trial', 'active', 'grace']);

/**
 * Everything the app needs to know about what this account may do. Computed fresh on every call:
 * the database is the only source of truth.
 */
export function entitlements(userId) {
  const l = ensureLicense(userId);
  // A licence whose plan has gone missing gets nothing beyond the basic shopping checks until it is fixed.
  const plan = getPlan(l.plan_key) || { key: l.plan_key, name: 'Unknown plan', kind: 'free', features: ['journeys'], limits: { journeyMinInterval: 1440, fullMinInterval: 10080, environments: 0, maxStores: 1 }, prices: {} };
  const state = stateOf(l);
  const usable = USABLE.has(state);
  const maxStores = plan.limits.maxStores == null ? l.seats : Math.min(l.seats, plan.limits.maxStores);
  const storeIds = S.storeIds.all(userId).map((r) => r.id);
  const covered = new Set(storeIds.slice(0, maxStores));
  const features = new Set(usable ? plan.features : []);
  features.add('journeys');
  const exp = toMs(l.expires_at);
  return {
    license: l, plan, state, usable, features, maxStores, storesUsed: storeIds.length, covered,
    limits: { journeyMinInterval: plan.limits.journeyMinInterval || 60, fullMinInterval: plan.limits.fullMinInterval || 720, environments: plan.limits.environments ?? 0, manualRunsPerDay: plan.limits.manualRunsPerDay || 20 },
    daysLeft: exp == null ? null : Math.ceil((exp - Date.now()) / 864e5),
  };
}
export const has = (ent, feature) => ent.usable && ent.features.has(feature);
/** Only a store's first N environments (by age) are covered by the plan, like store seats. */
export function envAllowed(ent, storeId, envId) {
  if (!has(ent, 'environments')) return false;
  const ids = db.prepare('SELECT id FROM environments WHERE store_id = ? ORDER BY id').all(storeId).map((r) => r.id);
  return ids.slice(0, ent.limits.environments).includes(envId);
}
/** "Growth and Pro": the public plans that include a feature, for upgrade messages. */
export function plansWith(feature) {
  const names = listPlans().filter((p) => p.active && p.public && p.kind === 'paid' && p.features.includes(feature)).map((p) => p.name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || 'a higher';
}
export function notIncluded(feature, what) {
  const n = listPlans().filter((p) => p.active && p.public && p.kind === 'paid' && p.features.includes(feature)).length;
  return `${what} ${n ? `is included in the ${plansWith(feature)} plan${n > 1 ? 's' : ''}` : 'is not included in your plan'}.`;
}

/** Validation groups this account's plan doesn't include. Added to every run's skipped groups. */
export function lockedGroups(ent) {
  const out = [];
  for (const f of FEATURES) if (f.groups && !ent.features.has(f.key)) out.push(...f.groups);
  return out;
}
/** Why a store can't be tested right now, in the owner's words; null when it can. */
export function blockReason(ent, storeId) {
  if (!ent.usable) return ent.state === 'trial' || ent.state === 'expired' ? (ent.license.status === 'trial' ? 'Your free trial has ended. Choose a plan to keep your stores checked.' : 'Your plan has expired. Renew it to keep your stores checked.') : ent.state === 'suspended' ? 'Your account is paused. Contact us to turn it back on.' : 'Your plan has ended. Choose a plan to start again.';
  if (storeId != null && !ent.covered.has(storeId)) return `Your plan covers ${ent.maxStores} store${ent.maxStores === 1 ? '' : 's'}. Add a store to your plan, or remove another store, to check this one.`;
  return null;
}

/** The licence as the customer sees it. */
export function licenseView(userId) {
  const e = entitlements(userId);
  const l = e.license;
  const price = priceOf(l, e.plan);
  return {
    plan: { key: e.plan.key, name: e.plan.name, kind: e.plan.kind, tagline: e.plan.tagline }, state: e.state, usable: e.usable, status: l.status,
    seats: l.seats, maxStores: e.maxStores, storesUsed: e.storesUsed, expires_at: l.expires_at, daysLeft: e.daysLeft, billing: l.billing, currency: l.currency,
    price, features: [...e.features], limits: e.limits, coveredStores: [...e.covered], note: setting('payment_note'),
    graceEnds: e.state === 'grace' ? toSql(toMs(l.expires_at) + graceDays(l) * 864e5) : null,
  };
}

/** Amount per billing period for the whole licence, in minor units; null when free or not priced in that currency. */
export function priceOf(l, plan = getPlan(l.plan_key)) {
  if (l.price_override != null) return { amount: l.price_override, currency: l.currency, period: l.billing, custom: true };
  if (plan.kind !== 'paid') return null;
  const p = plan.prices[l.currency];
  const period = l.billing === 'year' ? 'year' : 'month';
  if (!p?.[period]) return null;
  return { amount: p[period] * l.seats, currency: l.currency, period, perStore: p[period], custom: false };
}
/** Monthly recurring revenue of one licence, minor units, or 0. Only paying, usable licences count. */
export function mrrOf(l) {
  const state = stateOf(l);
  if (!['active', 'grace'].includes(state)) return 0;
  const p = priceOf(l);
  if (!p) return 0;
  return Math.round(p.period === 'year' ? p.amount / 12 : p.period === 'month' ? p.amount : p.amount);
}

// ---------- founder actions (all audited, all validated) ----------
const STATUSES = ['trial', 'active', 'suspended', 'cancelled'];
const CURRENCIES = ['USD', 'EUR', 'INR', 'GBP', 'AUD', 'CAD', 'SGD', 'AED'];
const BILLING = ['month', 'year', 'custom', 'shopify'];
/** A real calendar date (2027-02-31 is refused), optionally with a time. */
const isDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(s)) return false;
  const full = s.length === 10 ? s + ' 23:59:59' : s.length === 16 ? s + ':00' : s;
  const ms = toMs(full);
  return !Number.isNaN(ms) && toSql(ms) === full;
};

export function updateLicense(actor, userId, input) {
  const before = ensureLicense(userId);
  const next = { ...before };
  if (input.plan_key !== undefined) {
    const p = getPlan(String(input.plan_key));
    if (!p) throw new Error('Unknown plan');
    next.plan_key = p.key;
  }
  if (input.seats !== undefined) {
    const n = Number(input.seats);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('Stores must be a whole number from 1 to 1000');
    next.seats = n;
  }
  if (input.status !== undefined) { if (!STATUSES.includes(input.status)) throw new Error('Unknown status'); next.status = input.status; }
  if (input.billing !== undefined) { if (!BILLING.includes(input.billing)) throw new Error('Unknown billing period'); next.billing = input.billing; }
  if (input.currency !== undefined) { if (!CURRENCIES.includes(input.currency)) throw new Error('Unknown currency'); next.currency = input.currency; }
  if (next.currency !== before.currency && next.price_override != null && input.price_override === undefined) throw new Error('This licence has a custom price in ' + before.currency + '. Set the custom price again in ' + next.currency + ', or clear it.');
  if (input.price_override !== undefined) {
    if (input.price_override === null || input.price_override === '') next.price_override = null;
    else { const n = Math.round(Number(input.price_override)); if (!Number.isFinite(n) || n < 0) throw new Error('Custom price must be zero or more'); next.price_override = n; }
  }
  if (input.expires_at !== undefined) {
    if (input.expires_at === null || input.expires_at === '') next.expires_at = null;
    else { const s = String(input.expires_at).trim(); if (!isDate(s)) throw new Error('Expiry must be a date like 2027-01-31'); next.expires_at = s.length === 10 ? s + ' 23:59:59' : s.length === 16 ? s + ':00' : s; }
  }
  if (input.grace_days !== undefined) {
    if (input.grace_days === null || input.grace_days === '') next.grace_days = null;
    else { const n = Number(input.grace_days); if (!Number.isInteger(n) || n < 0 || n > 90) throw new Error('Grace days must be 0 to 90'); next.grace_days = n; }
  }
  if (input.notes !== undefined) next.notes = String(input.notes || '').slice(0, 2000) || null;
  const plan = getPlan(next.plan_key);
  if (plan.limits.maxStores != null && next.seats > plan.limits.maxStores) throw new Error(`${plan.name} allows up to ${plan.limits.maxStores} stores`);
  const changed = Object.keys(next).filter((k) => next[k] !== before[k] && k !== 'updated_at');
  if (!changed.length) return before;
  db.transaction(() => {
    db.prepare(`UPDATE licenses SET plan_key = ?, seats = ?, status = ?, billing = ?, currency = ?, price_override = ?, expires_at = ?, grace_days = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(next.plan_key, next.seats, next.status, next.billing, next.currency, next.price_override, next.expires_at, next.grace_days, next.notes, before.id);
    audit(actor, userId, 'license.update', Object.fromEntries(changed.map((k) => [k, { before: before[k], after: next[k] }])));
  })();
  return S.licById.get(before.id);
}

/**
 * Records a payment and extends the licence. Paying for n periods extends from the current expiry
 * (or from today if it has already lapsed), sets the licence active and reactivates suspended or expired accounts.
 * The paid plan and the number of stores paid for are stated with every payment, so a free or trial
 * account can never carry its free seat count into a paid plan.
 */
export const recordPayment = db.transaction((actor, userId, input) => {
  const l = ensureLicense(userId);
  if (input.amount === '' || input.amount === null || input.amount === undefined || !Number.isFinite(Number(input.amount))) throw new Error('Enter the amount received');
  const amount = Math.round(Number(input.amount));
  if (amount < 0) throw new Error('Amount must be zero or more');
  const note = String(input.note || '').trim().slice(0, 500) || null;
  if (amount === 0 && !note) throw new Error('A zero payment needs a note saying why (for example a free month)');
  const currency = String(input.currency || l.currency);
  if (!CURRENCIES.includes(currency)) throw new Error('Unknown currency');
  const method = String(input.method || 'other');
  if (!['bank', 'upi', 'card', 'razorpay', 'stripe', 'shopify', 'cash', 'other'].includes(method)) throw new Error('Unknown payment method');
  const period = input.period === 'year' ? 'year' : 'month';
  const periods = Number(input.periods ?? 1);
  if (!Number.isInteger(periods) || periods < 1 || periods > 36) throw new Error('Periods must be 1 to 36');
  // References are compared without case or spaces, across all methods: one bank UTR is one payment.
  const reference = String(input.reference || '').replace(/\s+/g, '').toUpperCase().slice(0, 200) || null;
  if (reference && db.prepare('SELECT 1 FROM payments WHERE reference = ?').get(reference)) throw new Error('A payment with this reference is already recorded');
  // Without a reference, the same amount for the same customer within 10 minutes is almost always a double click.
  if (!reference && !input.confirmDuplicate && db.prepare("SELECT 1 FROM payments WHERE user_id = ? AND amount = ? AND currency = ? AND created_at > datetime('now', '-10 minutes')").get(userId, amount, currency))
    throw new Error('The same payment was recorded a few minutes ago. Add a reference, or confirm it is a second payment.');

  const plan = getPlan(String(input.plan_key || l.plan_key));
  if (!plan) throw new Error('Unknown plan');
  if (plan.kind !== 'paid') throw new Error('Payments are for paid plans. Choose the plan that was paid for.');
  const seats = input.seats === undefined || input.seats === '' ? null : Number(input.seats);
  const curPlan = getPlan(l.plan_key);
  if (seats == null && curPlan?.kind !== 'paid') throw new Error('Say how many stores were paid for');
  const newSeats = seats ?? l.seats;
  if (!Number.isInteger(newSeats) || newSeats < 1 || newSeats > 1000) throw new Error('Stores must be a whole number from 1 to 1000');
  if (plan.limits.maxStores != null && newSeats > plan.limits.maxStores) throw new Error(`${plan.name} allows up to ${plan.limits.maxStores} stores`);

  const now = Date.now();
  const exp = toMs(l.expires_at);
  // Paying during the grace period continues from the old expiry (no free days); after it lapses fully, from today.
  const graceMs = graceDays(l) * 864e5;
  const from = exp != null && (exp > now || (l.status !== 'trial' && now - exp <= graceMs)) ? exp : now;
  const to = addPeriods(from, period, periods);
  const billing = l.billing === 'custom' && l.price_override != null ? 'custom' : period;
  const override = currency === l.currency ? l.price_override : null;
  db.prepare('INSERT INTO payments (license_id, user_id, amount, currency, method, reference, period, periods, covers_from, covers_to, note, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(l.id, userId, amount, currency, method, reference, period, periods, toSql(from), toSql(to), note, String(actor));
  db.prepare("UPDATE licenses SET status = 'active', expires_at = ?, billing = ?, currency = ?, plan_key = ?, seats = ?, price_override = ?, updated_at = datetime('now') WHERE id = ?")
    .run(toSql(to), billing, currency, plan.key, newSeats, override, l.id);
  audit(actor, userId, 'payment.record', { amount, currency, method, reference, period, periods, note,
    plan_before: l.plan_key, plan: plan.key, seats_before: l.seats, seats: newSeats, billing_before: l.billing, billing,
    currency_before: l.currency, expires_before: l.expires_at, expires_after: toSql(to), status_before: l.status });
  return S.licById.get(l.id);
});

export function savePlan(actor, key, input, { create = false } = {}) {
  const before = S.plan.get(key);
  if (create && before) throw new Error('A plan with this key exists');
  if (!create && !before) throw new Error('Unknown plan');
  if (create && !/^[a-z][a-z0-9-]{1,30}$/.test(key)) throw new Error('Plan key: lowercase letters, numbers and dashes');
  const cur = before ? parsePlan(before) : { name: '', tagline: '', kind: 'paid', prices: {}, features: ['journeys'], limits: {}, public: false, highlight: false, active: true, sort: 10 };
  const name = String(input.name ?? cur.name).trim().slice(0, 40);
  if (!name) throw new Error('Name the plan');
  const kind = input.kind ?? cur.kind;
  if (!['paid', 'free', 'trial'].includes(kind)) throw new Error('Unknown plan kind');
  const features = input.features ? [...new Set(['journeys', ...input.features.filter((f) => FEATURE_KEYS.includes(f))])] : cur.features;
  const prices = {};
  for (const [c, p] of Object.entries(input.prices ?? cur.prices)) {
    if (!CURRENCIES.includes(c)) continue;
    const m = p?.month === '' || p?.month == null ? null : Math.round(Number(p.month));
    const y = p?.year === '' || p?.year == null ? null : Math.round(Number(p.year));
    if ((m != null && !(m >= 0)) || (y != null && !(y >= 0))) throw new Error(`Prices in ${c} must be zero or more`);
    if (m != null || y != null) prices[c] = { ...(m != null && { month: m }), ...(y != null && { year: y }) };
  }
  if (kind === 'paid' && !Object.keys(prices).length) throw new Error('A paid plan needs at least one price');
  // Limits not sent keep their current values.
  const L = { ...cur.limits, ...(input.limits || {}) };
  const int = (v, lo, hi, label) => { if (v === null || v === '' || v === undefined) return null; const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${label} must be ${lo} to ${hi}`); return n; };
  const limits = {
    journeyMinInterval: int(L.journeyMinInterval, 30, 1440, 'Shopping checks interval') ?? 60,
    fullMinInterval: int(L.fullMinInterval, 720, 10080, 'Full check interval') ?? 1440,
    environments: int(L.environments, 0, 50, 'Environments') ?? 0,
    maxStores: int(L.maxStores, 1, 1000, 'Max stores'),
    manualRunsPerDay: int(L.manualRunsPerDay, 1, 500, 'Tests you can start per store per day') ?? 20,
  };
  const bool = (v, d, label) => { if (v === undefined) return d; if (v === true || v === 1 || v === '1' || v === 'true') return true; if (v === false || v === 0 || v === '0' || v === 'false') return false; throw new Error(`${label} must be true or false`); };
  const pub = bool(input.public, cur.public, 'Public'), hl = bool(input.highlight, cur.highlight, 'Highlight'), act = bool(input.active, cur.active, 'Available');
  if (!create && key === setting('signup_plan') && (kind === 'paid' || !act)) throw new Error('New signups start on this plan. Choose another plan for new signups in Settings first.');
  const row = [name, String(input.tagline ?? cur.tagline ?? '').slice(0, 120), kind, JSON.stringify(prices), JSON.stringify(features), JSON.stringify(limits),
    pub ? 1 : 0, hl ? 1 : 0, act ? 1 : 0, int(input.sort ?? cur.sort, 0, 999, 'Order') ?? 0];
  db.transaction(() => {
    if (create) db.prepare('INSERT INTO plans (name, tagline, kind, prices_json, features_json, limits_json, public, highlight, active, sort, key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...row, key);
    else db.prepare("UPDATE plans SET name = ?, tagline = ?, kind = ?, prices_json = ?, features_json = ?, limits_json = ?, public = ?, highlight = ?, active = ?, sort = ?, updated_at = datetime('now') WHERE key = ?").run(...row, key);
    audit(actor, null, create ? 'plan.create' : 'plan.update', { key, before: before ? parsePlan(before) : null, after: getPlan(key) });
  })();
  return getPlan(key);
}

/** Licences that need a reminder: 7 days and 1 day before expiry, and on expiry. Each is sent once per expiry date. */
export function dueNotices() {
  const out = [];
  for (const l of db.prepare("SELECT * FROM licenses WHERE expires_at IS NOT NULL AND status IN ('trial','active')").all()) {
    const days = (toMs(l.expires_at) - Date.now()) / 864e5;
    const kind = days <= 0 ? (stateOf(l) === 'expired' ? 'expired' : 'grace') : days <= 1 ? 'd1' : days <= 7 ? 'd7' : null;
    if (!kind) continue;
    if (db.prepare('SELECT 1 FROM license_notices WHERE license_id = ? AND kind = ? AND expires_at = ?').get(l.id, kind, l.expires_at)) continue;
    out.push({ license: l, kind, user: S.user.get(l.user_id) });
  }
  return out;
}

/** Marks a reminder as sent, once the email has gone out. */
export function markNotice(l, kind) {
  db.prepare('INSERT OR IGNORE INTO license_notices (license_id, kind, expires_at) VALUES (?, ?, ?)').run(l.id, kind, l.expires_at);
}

export { CURRENCIES, sqlNow };

// ---------- online checkout (website customers) ----------
db.exec(`CREATE TABLE IF NOT EXISTS checkouts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  order_id TEXT UNIQUE,
  plan_key TEXT NOT NULL,
  seats INTEGER NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',   -- created | paid | failed
  payment_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);`);

const PERIOD_DAYS = { month: 30, year: 365 };
/**
 * What a plan change or renewal costs and what it gives. Renewing the same plan continues from the current
 * end date. Changing plan, stores or billing period starts today, and unused paid time on the current plan
 * (same currency) is turned into extra days on the new one, so nobody pays twice.
 */
export function quote(userId, input) {
  const l = ensureLicense(userId);
  const plan = getPlan(String(input.plan_key || ''));
  if (!plan || plan.kind !== 'paid' || !plan.active || !plan.public) throw new Error('Choose one of the plans on the pricing page');
  const period = input.period === 'year' ? 'year' : 'month';
  const currency = String(input.currency || l.currency || 'USD');
  const unit = plan.prices[currency]?.[period];
  if (unit == null) throw new Error(`${plan.name} isn’t offered ${period === 'year' ? 'yearly' : 'monthly'} in ${currency}`);
  const seats = Number(input.seats);
  const ent = entitlements(userId);
  if (!Number.isInteger(seats) || seats < 1 || seats > 1000) throw new Error('Choose how many stores, from 1 to 1000');
  if (plan.limits.maxStores != null && seats > plan.limits.maxStores) throw new Error(`${plan.name} covers up to ${plan.limits.maxStores} stores`);
  if (seats < ent.storesUsed) throw new Error(`You have ${ent.storesUsed} stores. Remove some first, or choose at least ${ent.storesUsed}.`);
  const amount = unit * seats;
  const now = Date.now();
  const exp = toMs(l.expires_at);
  const state = stateOf(l);
  const curPlan = getPlan(l.plan_key);
  if (l.status === 'suspended') throw new Error('Your account is paused. Contact us to turn it back on.');
  // Paid time can't be carried across currencies, so currency changes wait for the end of the current period.
  if (curPlan?.kind === 'paid' && exp != null && exp - now > 864e5 && ['active', 'grace'].includes(state) && currency !== l.currency) throw new Error(`Your plan is paid in ${l.currency} until ${toSql(exp).slice(0, 10)}. Choose ${l.currency}, or contact us to switch currency.`);
  const same = curPlan?.key === plan.key && l.seats === seats && l.billing === period && l.currency === currency && curPlan.kind === 'paid';
  let from = now, kind = curPlan?.kind === 'paid' ? 'change' : 'new', creditDays = 0;
  if (same && exp != null && (exp > now || state === 'grace')) { from = exp; kind = 'renew'; }
  else if (curPlan?.kind === 'paid' && ['active', 'grace'].includes(state) && exp != null && exp > now && l.currency === currency) {
    const cur = priceOf(l, curPlan);
    if (cur && cur.period !== 'custom') {
      const curDays = PERIOD_DAYS[cur.period] || 30;
      const remainingValue = cur.amount * ((exp - now) / (curDays * 864e5));
      creditDays = Math.max(0, Math.floor(remainingValue / (amount / PERIOD_DAYS[period])));
    }
  }
  const to = addPeriods(from, period, 1) + creditDays * 864e5;
  return { plan: { key: plan.key, name: plan.name }, seats, period, currency, amount, kind, creditDays, from: toSql(from), to: toSql(to) };
}

export function createCheckout(userId, qt, provider) {
  const id = Number(db.prepare('INSERT INTO checkouts (user_id, provider, plan_key, seats, period, currency, amount) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, provider, qt.plan.key, qt.seats, qt.period, qt.currency, qt.amount).lastInsertRowid);
  return id;
}
export const setCheckoutOrder = (id, orderId) => db.prepare('UPDATE checkouts SET order_id = ? WHERE id = ?').run(orderId, id);
export const checkoutByOrder = (orderId) => db.prepare('SELECT * FROM checkouts WHERE order_id = ?').get(orderId);

/**
 * Applies a paid checkout exactly once: records the payment and updates the licence, using a fresh quote
 * so the dates are right even if the payment took a while. Returns the licence, or null if already applied.
 */
export const applyCheckout = db.transaction((orderId, paymentId, paidAmount, paidCurrency, provider) => {
  const ck = checkoutByOrder(orderId);
  if (!ck) throw new Error('Unknown order');
  if (ck.status === 'paid') return null;
  if (Number(paidAmount) !== ck.amount || paidCurrency !== ck.currency) throw new Error(`Paid amount ${paidAmount} ${paidCurrency} does not match the order (${ck.amount} ${ck.currency})`);
  const won = db.prepare("UPDATE checkouts SET status = 'paid', payment_id = ?, paid_at = datetime('now') WHERE id = ? AND status != 'paid'").run(paymentId, ck.id);
  if (!won.changes) return null;
  const l = ensureLicense(ck.user_id);
  let qt;
  try { qt = quote(ck.user_id, { plan_key: ck.plan_key, seats: ck.seats, period: ck.period, currency: ck.currency }); }
  catch {
    // Paid is paid: never refuse money already taken, and never lose time already paid for.
    const base = Math.max(Date.now(), toMs(l.expires_at) || 0);
    qt = { from: toSql(base), to: toSql(addPeriods(base, ck.period, 1)), creditDays: 0, kind: 'fallback' };
    audit(provider, ck.user_id, 'note', { text: `Online payment applied without a fresh quote (plan or stores changed since checkout). Please review.` });
  }
  const ref = String(paymentId).replace(/\s+/g, '').toUpperCase();
  db.prepare('INSERT INTO payments (license_id, user_id, amount, currency, method, reference, period, periods, covers_from, covers_to, note, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
    .run(l.id, ck.user_id, ck.amount, ck.currency, provider, ref, ck.period, qt.from, qt.to, qt.creditDays ? `Includes ${qt.creditDays} days credit from the previous plan` : null, provider);
  db.prepare("UPDATE licenses SET plan_key = ?, seats = ?, status = 'active', billing = ?, currency = ?, price_override = NULL, expires_at = ?, updated_at = datetime('now') WHERE id = ?")
    .run(ck.plan_key, ck.seats, ck.period, ck.currency, qt.to, l.id);
  audit(provider, ck.user_id, 'payment.record', { amount: ck.amount, currency: ck.currency, method: provider, reference: ref, period: ck.period, periods: 1,
    plan_before: l.plan_key, plan: ck.plan_key, seats_before: l.seats, seats: ck.seats, expires_before: l.expires_at, expires_after: qt.to, status_before: l.status, credit_days: qt.creditDays, online: true });
  return S.licById.get(l.id);
});
