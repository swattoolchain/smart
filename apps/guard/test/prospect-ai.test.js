// Prospects: the AI batch step (T123). New candidates are scored and given an opener in batches, once each.
// A fake AI stands in for the real one (live messages and the Message Batches API); no test calls an outside service.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Database from 'better-sqlite3';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, founderSession, freePort } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.FEATURES_DEFAULT = 'on';
const { cleanResult, candidateOf } = await import('../src/prospect-ai.js');

const FINDING = "Customers can't add this product to the cart";
/** What the fake AI answers for one candidate. It also tries things it must not be allowed to do. */
function answer(c) {
  if (c.kind === 'company') return { id: c.id, icp: null, fit: 72, summary: 'Looks like a real online seller (a guess).', search_terms: [`${c.company_name} Bengaluru`, 'acme-saris.in', 'https://acme.example'], opener: 'I looked at your company.' };
  if (/lying/.test(c.domain)) return { id: c.id, icp: 80, summary: 'Cart is broken.', opener: 'Your cart loses 37% of buyers, see https://x.example.' };
  return { id: c.id, icp: 85, summary: c.finding || 'Nothing wrong found.', opener: `I shopped your store like a customer and found this: ${c.finding || ''}`.trim() };
}
async function startFakeAi() {
  const port = await freePort();
  const st = { live: 0, liveSizes: [], batches: {}, batchPosts: 0, ended: false, keys: [], prompts: [] };
  const server = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const send = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
    const reqOf = (body) => JSON.parse(body.messages[0].content.map?.((x) => x.text).join('') ?? body.messages[0].content).candidates;
    st.keys.push(req.headers['x-api-key']);
    if (req.method === 'POST' && req.url === '/v1/messages') {
      const body = JSON.parse(b); const cands = reqOf(body);
      st.live++; st.liveSizes.push(cands.length); st.prompts.push(body.system);
      return send({ content: [{ type: 'text', text: JSON.stringify({ results: cands.map(answer) }) }], usage: { input_tokens: 1, output_tokens: 1 } });
    }
    if (req.method === 'POST' && req.url === '/v1/messages/batches') {
      const body = JSON.parse(b); const id = `msgbatch_${++st.batchPosts}`;
      st.batches[id] = body.requests.map((r) => ({ custom_id: r.custom_id, cands: reqOf(r.params) }));
      return send({ id, processing_status: 'in_progress' });
    }
    const m = /^\/v1\/messages\/batches\/([\w]+)(\/results)?$/.exec(req.url);
    if (m && req.method === 'GET') {
      if (!m[2]) return send({ id: m[1], processing_status: st.ended ? 'ended' : 'in_progress', results_url: `http://localhost:${port}/v1/messages/batches/${m[1]}/results` });
      return send(st.batches[m[1]].map((r) => JSON.stringify({ custom_id: r.custom_id, result: { type: 'succeeded', message: { content: [{ type: 'text', text: JSON.stringify({ results: r.cands.map(answer) }) }] } } })).join('\n'));
    }
    send({ error: { message: 'not found' } }, 404);
  });
  await new Promise((r) => server.listen(port, r));
  return { base: `http://localhost:${port}`, st, stop: () => server.close() };
}

const seed = (db, rows) => {
  const ins = db.prepare("INSERT INTO prospects (domain, source, state, status, finding, icp, score, store_name, country, products, company_name, activity) VALUES (@domain, 'test', @state, @status, @finding, @icp, 40, @store_name, 'IN', 12, @company_name, @activity)");
  for (const r of rows) ins.run({ domain: null, state: 'done', status: 'new', finding: '', icp: 50, store_name: '', company_name: '', activity: '', ...r });
};

describe('Prospects AI step: scoring, openers, company rows', () => {
  let P, boss, ai, db;
  before(async () => {
    ai = await startFakeAi();
    P = await startProduct({ env: { AI_API_KEY: 'test-ai-key', AI_BASE_URL: ai.base } });
    boss = await founderSession(P);
    db = new Database(path.join(P.dataDir, 'guard.db'));
    db.exec("ALTER TABLE prospects ADD COLUMN company_name TEXT NOT NULL DEFAULT ''"); // added by the registry imports (T121)
    db.exec("ALTER TABLE prospects ADD COLUMN activity TEXT NOT NULL DEFAULT ''");
    seed(db, [
      { domain: 'broken.example.com', finding: FINDING, icp: 70, store_name: 'Broken Store' },
      { domain: 'fine.example.com', finding: '', icp: 60 },
      { domain: 'lying.example.com', finding: FINDING, icp: 55 },
      { domain: 'queued.example.com', state: 'queued' },
      { domain: 'optout.example.com', status: 'opted_out', finding: FINDING },
      { company_name: 'Acme Saris Pvt Ltd', activity: 'Retail sale of textiles via internet' },
      { company_name: 'Quiet Holdings Ltd', activity: 'Holding company' },
    ]);
  });
  after(async () => { db?.close(); await P?.stop(); ai?.stop(); });
  const row = (where) => db.prepare(`SELECT * FROM prospects WHERE ${where}`).get();
  const run = async () => (await boss.post('/api/admin/prospects-ai/run', {})).json;

  it('one request scores and drafts a mixed batch of store and company rows', async (t) => {
    const r = await run();
    assert.deepEqual([r.ran, r.stopped], [5, 'empty']);
    assert.equal(ai.st.live, 1, 'five candidates, one request');
    assert.deepEqual(ai.st.liveSizes, [5]);
    assert.ok(ai.st.keys.every((k) => k === 'test-ai-key'));
    const broken = row("domain = 'broken.example.com'");
    assert.equal(broken.ai_icp, 85);
    assert.match(broken.draft_opener, /found this: Customers can't add this product to the cart/);
    assert.equal(broken.icp, 70, 'the plain score is left as it was');
    assert.ok(broken.ai_classified_at);
    const fine = row("domain = 'fine.example.com'");
    assert.equal(fine.draft_opener, '', 'no finding, no opener');
    assert.equal(fine.ai_summary, 'Nothing wrong found.');
    const lying = row("domain = 'lying.example.com'");
    assert.equal(lying.draft_opener, '', 'an opener with a number or link that was not given is dropped');
    assert.equal(lying.ai_icp, 80, 'the score is still kept');
    const co = row("company_name = 'Acme Saris Pvt Ltd'");
    assert.equal(co.ai_fit, 72);
    assert.deepEqual(JSON.parse(co.ai_search_terms), ['Acme Saris Pvt Ltd Bengaluru'], 'a made-up address or link is never kept');
    assert.equal(co.draft_opener, '', 'a company has no finding, so no opener');
    assert.equal(co.domain, null, 'no address is invented');
    for (const d of ['queued.example.com', 'optout.example.com']) assert.equal(row(`domain = '${d}'`).ai_classified_at, null, `${d} is left alone`);
    note(t, 'store with finding: score 85 + opener; no finding: no opener; invented number/link: opener dropped; company: fit 72, one clean search phrase, no address; queued and opted-out rows untouched');
  });

  it('a second run touches nothing that was already classified', async (t) => {
    const calls = ai.st.live;
    const r = await run();
    assert.deepEqual([r.ran, r.stopped], [0, 'empty']);
    assert.equal(ai.st.live, calls, 'no new request');
    // The store that was still being read is picked up once it is checked; the others are not asked again.
    db.prepare("UPDATE prospects SET state = 'done', finding = ? WHERE domain = 'queued.example.com'").run(FINDING);
    const r2 = await run();
    assert.equal(r2.ran, 1);
    assert.deepEqual(ai.st.liveSizes.slice(-1), [1]);
    assert.equal(row("domain = 'optout.example.com'").ai_classified_at, null);
    note(t, 'second run: 0 rows, 0 requests; a newly checked store is the only one sent next time');
  });

  it('a big backlog goes through the batch service, and its answers are applied when it ends', async (t) => {
    db.exec('BEGIN');
    for (let i = 0; i < 230; i++) seed(db, [{ domain: `bulk${i}.example.com`, finding: FINDING, icp: 40 }]);
    db.exec('COMMIT');
    const live = ai.st.live;
    const r = await run();
    assert.deepEqual([r.submitted, r.stopped], [230, 'submitted']);
    assert.equal(ai.st.live, live, 'no live requests for the backlog');
    assert.equal(Object.values(ai.st.batches)[0].length, 5, '230 rows in chunks of 50');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM prospects WHERE ai_batch_id != ''").get().n, 230);
    assert.equal((await boss.get('/api/admin/prospects-ai')).json.inBatch, 230);
    const again = await run();
    assert.equal(again.stopped, 'batch_running', 'nothing more is sent while the batch is open');
    assert.equal(ai.st.batchPosts, 1);
    ai.st.ended = true;
    const done = await run();
    assert.equal(done.ran, 230);
    const s = (await boss.get('/api/admin/prospects-ai')).json;
    assert.deepEqual([s.inBatch, s.waiting], [0, 0]);
    assert.match(row("domain = 'bulk7.example.com'").draft_opener, /found this/);
    note(t, '230 rows: one batch of 5 chunks, none live; while open nothing new is sent; when it ends all 230 are classified');
  });

  it('shows the openers in the founder console', async (t) => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addCookies(boss.browserCookies());
      const p = await ctx.newPage();
      await p.goto(`${P.base}/app#/admin/prospects`);
      await p.waitForSelector('#pai');
      assert.match(await p.textContent('#pai'), /read by AI/);
      await p.waitForSelector('.popener');
      assert.match(await p.textContent('.popener'), /I shopped your store like a customer/);
      await screenshot(t, p, 'Prospects with AI openers', { fullPage: true });
      note(t, 'the console shows how many rows the AI read and each row\'s draft opener');
    } finally { await browser.close(); }
  });
});

describe('Prospects AI step: answers are checked', () => {
  it('only what was asked and allowed is kept', () => {
    const store = candidateOf({ rid: 1, domain: 'a.example.com', finding: FINDING, score: 40, icp: 50, products: 12 });
    const ok = cleanResult({ icp: 140, fit: 50, summary: 'x', search_terms: ['a b'], opener: 'I found that 12 products matter.' }, store);
    assert.equal(ok.icp, 100, 'scores are held between 0 and 100');
    assert.equal(ok.fit, null, 'a store has no company fit');
    assert.deepEqual(ok.search_terms, []);
    assert.match(ok.opener, /12 products/, 'a number that is in the facts is fine');
    assert.equal(cleanResult({ opener: 'We saw 99 problems.' }, store).opener, '', 'a number that was not given is dropped');
    assert.equal(cleanResult({ opener: 'See shop.example.com now' }, store).opener, '', 'no links');
    assert.equal(cleanResult('nonsense', store), null);
    const co = candidateOf({ rid: 2, domain: null, company_name: 'Acme', activity: 'Retail' });
    assert.equal(co.kind, 'company');
    assert.equal(cleanResult({ fit: 'high', icp: 90, search_terms: ['Acme Pune', 'acme.com', 'a'.repeat(100)] }, co).fit, null);
    assert.deepEqual(cleanResult({ search_terms: ['Acme Pune', 'acme.com', 'www.acme', 'x@y.in'] }, co).search_terms, ['Acme Pune']);
  });
});

describe('Prospects AI step: without an AI key', () => {
  let P, boss, db;
  before(async () => {
    P = await startProduct();
    boss = await founderSession(P);
    db = new Database(path.join(P.dataDir, 'guard.db'));
    db.prepare("INSERT INTO prospects (domain, state, finding, icp) VALUES ('nokey.example.com', 'done', ?, 60)").run(FINDING);
  });
  after(async () => { db?.close(); await P?.stop(); });

  it('does nothing, cleanly: the row keeps its plain score and gets no draft', async (t) => {
    const r = (await boss.post('/api/admin/prospects-ai/run', {})).json;
    assert.deepEqual([r.ran, r.stopped], [0, 'no_key']);
    assert.equal(r.status.enabled, false);
    const row = db.prepare("SELECT * FROM prospects WHERE domain = 'nokey.example.com'").get();
    assert.deepEqual([row.ai_classified_at, row.draft_opener, row.ai_icp, row.icp], [null, '', null, 60]);
    const list = (await boss.get('/api/admin/prospects')).json.rows[0];
    assert.equal(list.draft_opener, '');
    note(t, 'no key: stopped "no_key", nothing written, plain score 60 kept');
  });

  it('is hidden while the prospects switch is off', async () => {
    await boss.patch('/api/admin/features/prospects', { on: false });
    assert.equal((await boss.get('/api/admin/prospects-ai')).status, 404);
    assert.equal((await boss.post('/api/admin/prospects-ai/run', {})).status, 404);
    await boss.patch('/api/admin/features/prospects', { on: true });
  });
});
