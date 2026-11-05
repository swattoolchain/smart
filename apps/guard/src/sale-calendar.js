/**
 * Sale calendar: the big sale days where a store sells, so the owner can plan (and rehearse) each one in time.
 * Built-in days by market, plus the owner's own days. A day is suggested 3 weeks before it starts, unless a
 * sale plan already covers it.
 *
 * Dates that follow the moon (Diwali, Navratri, Ramadan, Eid) come from a table and are marked approximate;
 * retail events whose dates are set each year by the organiser (Prime Day, Click Frenzy, Hot Sale) are
 * estimated and marked approximate too.
 */
import { db } from './db.js';
import { MARKETS } from './engine/catalog.js';

db.exec(`
CREATE TABLE IF NOT EXISTS sale_days (
  id INTEGER PRIMARY KEY,
  store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,          -- YYYY-MM-DD
  days INTEGER NOT NULL DEFAULT 1,
  every_year INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS sale_days_store ON sale_days(store_id);
`);

const DAY = 86400000;
export const SUGGEST_DAYS = 21; // suggest a plan 3 weeks ahead
const MAX_CUSTOM = 30;

// ---------- dates ----------
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const ymd = (y, m, d) => Date.UTC(y, m - 1, d);
const add = (ms, n) => ms + n * DAY;
/** The n-th weekday (0 = Sunday) of a month; n = -1 for the last one. */
export function nthWeekday(y, m, weekday, n) {
  if (n > 0) {
    const first = new Date(ymd(y, m, 1)).getUTCDay();
    return ymd(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(ymd(y, m + 1, 0)).getUTCDate();
  const wd = new Date(ymd(y, m, lastDay)).getUTCDay();
  return ymd(y, m, lastDay - ((wd - weekday + 7) % 7));
}
/** Easter Sunday (Gregorian), for Mothering Sunday in the UK. */
export function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(y, month, day);
}
// Moon-based dates (approximate; the exact day can shift by a day with the moon sighting).
const DIWALI = { 2026: '2026-11-08', 2027: '2027-10-29', 2028: '2028-10-17', 2029: '2029-11-05' };
const EID_FITR = { 2026: '2026-03-20', 2027: '2027-03-10', 2028: '2028-02-27', 2029: '2029-02-15' };
const fromTable = (t, y) => (t[y] ? new Date(t[y] + 'T00:00:00Z').getTime() : null);

const ALL = MARKETS.map((m) => m.code);
/**
 * Built-in sale days. `at(y)` gives the first day of the sale (ms, UTC midnight) or null; `days`: how long
 * the sale usually runs. `markets`: where it matters (market codes from engine/catalog.js; MX and AR are
 * shown to stores that haven't picked markets).
 */
export const SALE_DAYS = [
  { key: 'valentines', name: 'Valentine’s Day', markets: ALL, days: 8, at: (y) => ymd(y, 2, 7), note: 'Gift sales usually run in the week before 14 February.' },
  { key: 'ramadan', name: 'Ramadan and Eid sales', markets: ['AE', 'SG', 'IN', 'UK'], days: 33, approx: true, at: (y) => { const e = fromTable(EID_FITR, y); return e ? add(e, -30) : null; }, note: 'Follows the moon; Eid al-Fitr ends Ramadan.' },
  { key: 'mothering-sunday', name: 'Mother’s Day (UK)', markets: ['UK'], days: 8, at: (y) => add(easter(y), -28), note: 'Mothering Sunday, three weeks before Easter.' },
  { key: 'mothers-day', name: 'Mother’s Day', markets: ['US', 'CA', 'AU', 'IN', 'SG', 'DE', 'AT', 'EU'], days: 8, at: (y) => add(nthWeekday(y, 5, 0, 2), -7), note: 'Second Sunday of May.' },
  { key: 'hot-sale-ar', name: 'Hot Sale (Argentina)', markets: ['AR'], days: 3, approx: true, at: (y) => nthWeekday(y, 5, 1, 2), note: 'Dates are set by the organisers each year, usually in May.' },
  { key: 'eoss-summer', name: 'End of season sale (summer)', markets: ['IN', 'UK', 'DE', 'AT', 'EU'], days: 21, approx: true, at: (y) => ymd(y, 6, 20), note: 'Fashion stores clear summer stock from late June.' },
  { key: 'fathers-day', name: 'Father’s Day', markets: ['US', 'CA', 'UK', 'IN', 'SG'], days: 8, at: (y) => add(nthWeekday(y, 6, 0, 3), -7), note: 'Third Sunday of June.' },
  { key: 'prime-day', name: 'Prime Day–style sales', markets: ALL, days: 2, approx: true, at: (y) => nthWeekday(y, 7, 2, 2), note: 'Amazon announces the dates each year, usually mid-July; many stores run their own sale then.' },
  { key: 'fathers-day-au', name: 'Father’s Day (Australia)', markets: ['AU'], days: 8, at: (y) => add(nthWeekday(y, 9, 0, 1), -7), note: 'First Sunday of September.' },
  { key: 'navratri', name: 'Navratri and festive season', markets: ['IN'], days: 9, approx: true, at: (y) => { const d = fromTable(DIWALI, y); return d ? add(d, -28) : null; }, note: 'Follows the moon; the big festive sales in India start around Navratri.' },
  { key: 'diwali', name: 'Diwali', markets: ['IN', 'SG', 'AE', 'UK'], days: 6, approx: true, at: (y) => { const d = fromTable(DIWALI, y); return d ? add(d, -5) : null; }, note: 'Follows the moon; gift sales peak in the days before Diwali.' },
  { key: 'singles-day', name: 'Singles’ Day 11.11', markets: ['SG', 'AU', 'IN', 'AE'], days: 1, at: (y) => ymd(y, 11, 11), note: '11 November.' },
  { key: 'click-frenzy', name: 'Click Frenzy (Australia)', markets: ['AU'], days: 2, approx: true, at: (y) => nthWeekday(y, 11, 2, 2), note: 'Dates are set by the organisers each year, usually in November.' },
  { key: 'buen-fin', name: 'El Buen Fin (Mexico)', markets: ['MX'], days: 4, at: (y) => add(nthWeekday(y, 11, 1, 3), -3), note: 'The long weekend before the Revolution Day holiday.' },
  { key: 'black-friday', name: 'Black Friday', markets: ALL, days: 1, at: (y) => add(nthWeekday(y, 11, 4, 4), 1), note: 'The day after Thanksgiving in the US; now a sale day almost everywhere.' },
  { key: 'cyber-monday', name: 'Cyber Monday', markets: ALL, days: 1, at: (y) => add(nthWeekday(y, 11, 4, 4), 4), note: 'The Monday after Black Friday.' },
  { key: 'boxing-day', name: 'Boxing Day', markets: ['UK', 'CA', 'AU'], days: 1, at: (y) => ymd(y, 12, 26), note: '26 December.' },
  { key: 'eoss-winter', name: 'End of season sale (winter)', markets: ['IN', 'UK', 'DE', 'AT', 'EU'], days: 21, approx: true, at: (y) => ymd(y, 12, 20), note: 'Fashion stores clear winter stock from late December into January.' },
];

/**
 * Sale days from `today` (YYYY-MM-DD) over the next `horizon` days, for a store's markets (none chosen: all),
 * with the owner's own days. Each: { key, name, start, end, days, approx, custom, daysUntil, suggest, covered }.
 * `plans`: [{ startsAt, endsAt }] — a day is covered when a plan overlaps it (with 3 days' slack either side).
 */
export function upcomingDays({ today, markets = [], custom = [], plans = [], horizon = 365 } = {}) {
  const t0 = new Date(today + 'T00:00:00Z').getTime();
  const y0 = new Date(t0).getUTCFullYear();
  const want = (m) => !markets.length || m.some((x) => markets.includes(x));
  const out = [];
  const push = (d, startMs) => {
    if (startMs == null) return;
    const endMs = add(startMs, (d.days || 1) - 1);
    const daysUntil = Math.round((startMs - t0) / DAY);
    if (endMs < t0 || daysUntil > horizon) return;
    const covered = plans.some((p) => p.startsAt < add(endMs, 4) && p.endsAt > add(startMs, -3));
    // With no markets chosen, days only for markets we don't list (MX, AR) are shown but not pushed.
    const quiet = !markets.length && d.markets && !d.markets.some((m) => ALL.includes(m));
    out.push({ key: d.key, name: d.name, start: iso(startMs), end: iso(endMs), days: d.days || 1, approx: !!d.approx, custom: !!d.custom, id: d.id || null, note: d.note || null, daysUntil, covered, suggest: !covered && !quiet && daysUntil >= 0 && daysUntil <= SUGGEST_DAYS });
  };
  for (const y of [y0, y0 + 1]) for (const d of SALE_DAYS) if (want(d.markets)) push(d, d.at(y));
  for (const c of custom) {
    const [y, m, dd] = c.start_date.split('-').map(Number);
    if (c.every_year) for (const yy of [y0, y0 + 1]) { if (yy >= y) push({ key: `custom-${c.id}`, name: c.name, days: c.days, custom: true, id: c.id }, ymd(yy, m, dd)); }
    else push({ key: `custom-${c.id}`, name: c.name, days: c.days, custom: true, id: c.id }, ymd(y, m, dd));
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
}

/** Validates an owner's own sale day. Throws a readable error. */
export function cleanDay(b = {}) {
  const name = String(b.name ?? '').trim().slice(0, 60);
  if (!name) throw new Error('Give the sale day a name, for example “Store anniversary”.');
  const date = String(b.date ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || iso(ymd(+m[1], +m[2], +m[3])) !== date) throw new Error('Choose the date the sale starts.');
  const days = b.days === '' || b.days == null ? 1 : Number(b.days);
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error('A sale day lasts between 1 and 60 days.');
  return { name, date, days, everyYear: !!b.everyYear };
}

// ---------- routes ----------
const Q = {
  custom: db.prepare('SELECT * FROM sale_days WHERE store_id = ? ORDER BY start_date'),
  count: db.prepare('SELECT COUNT(*) AS n FROM sale_days WHERE store_id = ?'),
  insert: db.prepare('INSERT INTO sale_days (store_id, name, start_date, days, every_year) VALUES (?, ?, ?, ?, ?)'),
  byId: db.prepare('SELECT * FROM sale_days WHERE id = ?'),
  del: db.prepare('DELETE FROM sale_days WHERE id = ?'),
  plans: db.prepare('SELECT starts_at AS startsAt, ends_at AS endsAt FROM sale_plans WHERE store_id = ?'),
};

export function saleCalendarRoutes(app, { requireUser, ownStore, refuse }) {
  app.get('/api/stores/:id/sale-calendar', requireUser, (req, res) => {
    const s = ownStore(req, res);
    if (!s) return;
    let cfg = {};
    try { cfg = JSON.parse(s.config_json || '{}'); } catch {}
    const markets = Array.isArray(cfg.markets) ? cfg.markets : [];
    const today = iso(Date.now());
    const days = upcomingDays({ today, markets, custom: Q.custom.all(s.id), plans: Q.plans.all(s.id) });
    res.json({ today, markets, days, suggestions: days.filter((d) => d.suggest), suggestDays: SUGGEST_DAYS });
  });
  app.post('/api/stores/:id/sale-calendar', requireUser, (req, res) => {
    const s = ownStore(req, res);
    if (!s) return;
    if (Q.count.get(s.id).n >= MAX_CUSTOM) return refuse(res, `You can add up to ${MAX_CUSTOM} sale days of your own. Remove one you no longer need.`);
    let c;
    try { c = cleanDay(req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
    const id = Number(Q.insert.run(s.id, c.name, c.date, c.days, c.everyYear ? 1 : 0).lastInsertRowid);
    res.json({ id });
  });
  app.delete('/api/stores/:id/sale-calendar/:did', requireUser, (req, res) => {
    const s = ownStore(req, res);
    if (!s) return;
    const d = Q.byId.get(Number(req.params.did));
    if (!d || d.store_id !== s.id) return res.status(404).json({ error: 'Sale day not found.' });
    Q.del.run(d.id);
    res.json({ ok: true });
  });
}
