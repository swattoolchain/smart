/**
 * Prospects: one AI step in batches (behind the 'prospects' switch; founders only).
 *
 * For candidates that were never AI-classified, one request covers many rows (not one call per row):
 *  - a checked store: a refined fit score and the top finding in plain words;
 *  - a company without an address yet (rows with a company_name, added by the registry imports): a confidence that it
 *    is a real online or retail seller, and search phrases to find its store. It never invents an address;
 *  - any row with a real finding: a one or two sentence opener in the founder's voice, written into draft_opener.
 * A big backlog goes through the Message Batches API (cheaper, not time-sensitive); a small one is answered live.
 * Without an AI key nothing happens: rows keep their mechanical score, no draft, no placeholder text.
 * A row is classified once (ai_classified_at, set once, never cleared), so a second run never touches it again.
 */
import { db } from './db.js';
import './prospect-list.js'; // creates the prospects table and the ai_* columns
import { config } from './config.js';
import { audit } from './license.js';
import { isOn, requireFeature } from './features.js';
import { aiEnabled, classifyProspects, submitProspectBatch, collectProspectBatch } from './ai.js';

export const CHUNK = 50;            // candidates per request
export const LIVE_PER_TICK = 100;   // rows answered live in one run
export const BATCH_FROM = 200;      // a backlog above this goes through the Batches API
export const BATCH_MAX_ROWS = 1000; // rows sent in one submission
export const MAX_ATTEMPTS = 3;      // after this many failed answers a row is left alone (never retried forever)
const BATCH_LIFETIME_H = 30;
const LEFT_ALONE = "'contacted', 'replied', 'opted_out', 'do_not_contact'";

db.exec(`CREATE TABLE IF NOT EXISTS prospect_ai_batch (id TEXT PRIMARY KEY, chunks_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

const hasCompany = () => db.prepare('PRAGMA table_info(prospects)').all().some((c) => c.name === 'company_name');
function eligibleSql() {
  const cond = ["(domain IS NOT NULL AND state = 'done')"];
  if (hasCompany()) cond.push("(domain IS NULL AND company_name IS NOT NULL AND company_name != '')");
  return `ai_classified_at IS NULL AND ai_batch_id = '' AND status NOT IN (${LEFT_ALONE}) AND (${cond.join(' OR ')})`;
}
export const waitingCount = () => db.prepare(`SELECT COUNT(*) AS n FROM prospects WHERE ${eligibleSql()}`).get().n;

/** What the AI is shown for one row. Only public facts we already hold; no contact details. */
export function candidateOf(r) {
  if (r.domain) {
    return { id: r.rid, kind: 'store', domain: r.domain, store_name: r.store_name || '', country: r.country || '', currency: r.currency || '', products: r.products ?? null, finding: r.finding || '', risk_score: r.score ?? 0, mechanical_fit: r.icp ?? 0 };
  }
  return { id: r.rid, kind: 'company', company_name: r.company_name || '', activity: r.activity || '', address: r.address || '', state: r.state_region || r.registered_state || '' };
}

const URL_LIKE = /https?:|www\.|[a-z0-9-]+\.[a-z]{2,}\b|@/i;
const pct = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Math.min(100, Math.round(Number(v)))) : null);
const text = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Checks one answer against what was asked. Anything not allowed is dropped, never repaired. */
export function cleanResult(raw, cand) {
  if (!raw || typeof raw !== 'object') return null;
  const isCompany = cand.kind === 'company';
  const out = {
    icp: isCompany ? null : pct(raw.icp), fit: isCompany ? pct(raw.fit) : null,
    summary: text(raw.summary, 240), search_terms: [], opener: '',
  };
  if (isCompany && Array.isArray(raw.search_terms)) out.search_terms = raw.search_terms.map((t) => text(t, 60)).filter((t) => t && !URL_LIKE.test(t)).slice(0, 4);
  const o = text(raw.opener, 400);
  const facts = JSON.stringify({ ...cand, id: undefined });
  const numbers = o.match(/\d[\d,.]*\d|\d/g) || [];
  if (o && cand.finding && !URL_LIKE.test(o) && numbers.every((n) => facts.includes(n.replace(/[.,]$/, '')))) out.opener = o; // no links, no numbers that were not given
  if (URL_LIKE.test(out.summary)) out.summary = out.summary.replace(URL_LIKE, '').trim();
  return out;
}

function apply(rows, results, why = 'live') {
  const byId = new Map((Array.isArray(results) ? results : []).filter((x) => x && x.id !== undefined).map((x) => [String(x.id), x]));
  const set = db.prepare(`UPDATE prospects SET ai_classified_at = datetime('now'), ai_batch_id = '', ai_icp = ?, ai_fit = ?, ai_summary = ?, ai_search_terms = ?,
    draft_opener = CASE WHEN draft_opener = '' THEN ? ELSE draft_opener END, updated_at = datetime('now') WHERE rowid = ? AND ai_classified_at IS NULL`);
  const miss = db.prepare(`UPDATE prospects SET ai_batch_id = '', ai_attempts = ai_attempts + 1,
    ai_classified_at = CASE WHEN ai_attempts + 1 >= ? THEN datetime('now') ELSE NULL END WHERE rowid = ? AND ai_classified_at IS NULL`);
  let done = 0, missed = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const c = candidateOf(r);
      const res = cleanResult(byId.get(String(r.rid)), c);
      if (res) { set.run(res.icp, res.fit, res.summary, JSON.stringify(res.search_terms), res.opener, r.rid); done++; } else { miss.run(MAX_ATTEMPTS, r.rid); missed++; }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { done, missed, why };
}

const rowsByIds = (ids) => db.prepare(`SELECT rowid AS rid, * FROM prospects WHERE rowid IN (${ids.map(() => '?').join(',') || 'NULL'})`).all(...ids);
const defaultAi = () => ({ enabled: aiEnabled, batchable: () => config.ai.provider === 'anthropic', classify: classifyProspects, submit: submitProspectBatch, collect: collectProspectBatch });

async function collectBatches(ai, log) {
  let applied = 0;
  for (const b of db.prepare('SELECT * FROM prospect_ai_batch ORDER BY created_at').all()) {
    const chunks = JSON.parse(b.chunks_json);
    const old = Date.now() - new Date(b.created_at.replace(' ', 'T') + 'Z').getTime() > BATCH_LIFETIME_H * 3600e3;
    let got;
    try { got = await ai.collect(b.id); } catch (e) { log?.(`batch ${b.id}: ${e.message}`); if (!old) continue; got = { done: true, results: {} }; }
    if (!got.done && !old) continue;
    for (const [cid, rowIds] of Object.entries(chunks)) applied += apply(rowsByIds(rowIds), got.results?.[cid] ?? null, 'batch').done;
    db.prepare('DELETE FROM prospect_ai_batch WHERE id = ?').run(b.id);
    db.prepare(`UPDATE prospects SET ai_batch_id = '' WHERE ai_batch_id = ? AND ai_classified_at IS NULL`).run(b.id);
  }
  return applied;
}

let running = false;
/** One run: collect finished batches, then send a bounded amount of new work. Never throws. */
export async function aiTick({ ai = defaultAi(), max = LIVE_PER_TICK, log } = {}) {
  if (!isOn('prospects')) return { ran: 0, stopped: 'off' };
  if (!ai.enabled()) return { ran: 0, stopped: 'no_key' };
  if (running) return { ran: 0, stopped: 'busy' };
  running = true;
  try {
    let ran = await collectBatches(ai, log), submitted = 0, stopped = null;
    const waiting = waitingCount();
    const open = db.prepare('SELECT COUNT(*) AS n FROM prospect_ai_batch').get().n;
    if (!waiting) stopped = open ? 'batch_running' : 'empty';
    else if (waiting > BATCH_FROM && ai.batchable()) {
      if (open) stopped = 'batch_running';
      else {
        const rows = db.prepare(`SELECT rowid AS rid, * FROM prospects WHERE ${eligibleSql()} ORDER BY (domain IS NULL), icp DESC, rowid LIMIT ?`).all(BATCH_MAX_ROWS);
        const chunks = {};
        for (let i = 0; i < rows.length; i += CHUNK) chunks[`c${i / CHUNK}`] = rows.slice(i, i + CHUNK);
        try {
          const { id } = await ai.submit(Object.fromEntries(Object.entries(chunks).map(([k, v]) => [k, v.map(candidateOf)])));
          db.exec('BEGIN');
          db.prepare('INSERT INTO prospect_ai_batch (id, chunks_json) VALUES (?, ?)').run(id, JSON.stringify(Object.fromEntries(Object.entries(chunks).map(([k, v]) => [k, v.map((r) => r.rid)]))));
          const mark = db.prepare('UPDATE prospects SET ai_batch_id = ? WHERE rowid = ?');
          for (const r of rows) mark.run(id, r.rid);
          db.exec('COMMIT');
          submitted = rows.length; stopped = 'submitted';
        } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none open */ } log?.(`batch not sent: ${e.message}`); stopped = 'error'; }
      }
    } else {
      const rows = db.prepare(`SELECT rowid AS rid, * FROM prospects WHERE ${eligibleSql()} ORDER BY (domain IS NULL), icp DESC, rowid LIMIT ?`).all(Math.max(1, Math.min(max, LIVE_PER_TICK)));
      for (let i = 0; i < rows.length; i += CHUNK) {
        const part = rows.slice(i, i + CHUNK);
        let results = null;
        try { results = (await ai.classify(part.map(candidateOf))).results; } catch (e) { log?.(`AI answer failed: ${e.message}`); }
        ran += apply(part, results).done;
      }
      stopped = waitingCount() ? 'more' : 'empty';
    }
    return { ran, submitted, stopped };
  } finally { running = false; }
}

export function aiStatus() {
  const n = (sql) => db.prepare(sql).get().n;
  return {
    enabled: aiEnabled(), waiting: waitingCount(),
    classified: n('SELECT COUNT(*) AS n FROM prospects WHERE ai_classified_at IS NOT NULL'),
    drafts: n("SELECT COUNT(*) AS n FROM prospects WHERE draft_opener != ''"),
    inBatch: n("SELECT COUNT(*) AS n FROM prospects WHERE ai_batch_id != ''"),
  };
}

export function prospectAiRoutes(app, { requireUser, isAdmin }) {
  const feature = requireFeature('prospects');
  const founder = (req, res, next) => requireUser(req, res, () => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Forbidden' })));
  app.get('/api/admin/prospects-ai', feature, founder, (req, res) => res.json(aiStatus()));
  app.post('/api/admin/prospects-ai/run', feature, founder, async (req, res) => {
    try {
      const r = await aiTick({ log: (m) => console.error('prospect AI:', m) });
      audit(req.user.email, null, 'prospects.ai_run', { ran: r.ran, stopped: r.stopped });
      res.json({ ...r, status: aiStatus() });
    } catch (e) { res.status(400).json({ error: e.message || String(e) }); }
  });
}
