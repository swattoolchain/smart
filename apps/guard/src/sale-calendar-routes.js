/** Sale calendar routes and the owner's own sale days (see sale-calendar.js for the days themselves). */
import { db } from './db.js';
import { upcomingDays, cleanDay, SUGGEST_DAYS } from './sale-calendar.js';
import './sale-plans.js'; // the sale_plans table

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

const MAX_CUSTOM = 30;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
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
