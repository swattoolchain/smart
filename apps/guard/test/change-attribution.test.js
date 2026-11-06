// Change attribution (roadmap 4): when a check newly breaks, the failure names the scripts and outside sites that
// appeared since it last worked, in the report, the alert email and Slack.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const find = (run, id) => run.result.checks.find((c) => c.id === id);
const inv = (pages) => ({ pages: Object.fromEntries(Object.entries(pages).map(([k, scripts]) => [k, { scripts: scripts.map((u) => ({ key: u.replace(/^https?:\/\//, ''), url: u, host: new URL(u).host, outside: !u.includes('store.example') })), sites: [...new Set(scripts.map((u) => new URL(u).host).filter((h) => h !== 'store.example'))] }])) });

describe('Change attribution rules', () => {
  let db, q, attributeFailures, addedSince, storeId;
  before(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-attr-'));
    ({ db, q } = await import('../src/db.js'));
    ({ attributeFailures, addedSince } = await import('../src/attribution.js'));
    const uid = Number(q.insertUser.run('attr@shop.test', 'x', 'A').lastInsertRowid);
    storeId = Number(q.insertStore.run(uid, 'https://store.example', 'S', null, null, null, '{}', 'Shopify', 1).lastInsertRowid);
  });
  const theme = 'https://store.example/assets/theme.js';
  const popup = 'https://apps.example/upsell.js';
  const chk = (id, status, severity = 'critical') => ({ id, title: id, status, severity, detail: `${id} is ${status}.`, fix: 'Fix it.' });
  const saveRun = (checks, scripts) => Number(db.prepare("INSERT INTO runs (store_id, url, kind, status, trigger, seq, result_json) VALUES (?, 'https://store.example', 'journeys', 'done', 'schedule', (SELECT COALESCE(MAX(seq),0)+1 FROM runs WHERE store_id = ?), ?)")
    .run(storeId, storeId, JSON.stringify({ checks, scripts })).lastInsertRowid);

  it('only scripts on pages both checks reached count as new, each listed once with its pages', () => {
    const then = inv({ home: [theme], product: [theme] });
    const now = inv({ home: [theme, popup], product: [theme, popup], cart: [theme, 'https://other.example/x.js'] });
    assert.deepEqual(addedSince(then, now), { scripts: [{ url: popup, host: 'apps.example', pages: ['home', 'product'] }], sites: ['apps.example'] });
    assert.deepEqual(addedSince(now, now), { scripts: [], sites: [] });
  });

  it('a newly broken check names what appeared since it last worked; others are left alone', (t) => {
    const good = saveRun([chk('fn.atc', 'pass'), chk('fn.search', 'pass', 'major')], inv({ home: [theme], product: [theme] }));
    saveRun([chk('fn.atc', 'pass')], null); // a later check without a script record doesn't hide the good one
    q.upsertCheckState.run(storeId, 'fn.search', 'failing'); // already broken and alerted: not attributed again
    const runId = good + 10;
    const result = {
      scripts: inv({ home: [theme, popup], product: [theme, popup] }),
      checks: [chk('fn.atc', 'fail'), chk('fn.search', 'fail', 'major'), chk('fn.pdp', 'fail'), chk('nf.speed', 'fail', 'minor'), chk('sec.scripts.new', 'fail', 'major')],
    };
    assert.equal(attributeFailures(storeId, runId, result), 1);
    const atc = result.checks[0];
    assert.equal(atc.detail, `fn.atc is fail. This started after this script appeared: ${popup} (home and product pages). It last worked in check #2.`);
    assert.match(atc.fix, /^Check the new script first: switch off or undo the app or theme change that added it, then run a check again\. Fix it\.$/);
    assert.deepEqual(atc.changes, { sinceRunId: good + 1, sinceSeq: 2, since: atc.changes.since, scripts: [{ url: popup, host: 'apps.example', pages: ['home', 'product'] }], sites: ['apps.example'] });
    assert.equal(result.checks[1].changes, undefined, 'already failing');
    assert.equal(result.checks[2].changes, undefined, 'never worked before');
    assert.equal(result.checks[3].changes, undefined, 'minor problems are not attributed');
    assert.equal(result.checks[4].changes, undefined, 'script watch itself is not attributed');
    note(t, atc.detail);
  });

  it('no new scripts, or no script record: nothing is added', () => {
    const same = { scripts: inv({ home: [theme], product: [theme] }), checks: [chk('fn.atc', 'fail')] };
    assert.equal(attributeFailures(storeId, 999, same), 0);
    assert.equal(same.checks[0].detail, 'fn.atc is fail.');
    assert.equal(attributeFailures(storeId, 999, { scripts: null, checks: [chk('fn.atc', 'fail')] }), 0);
  });
});

describe('Change attribution end to end', () => {
  let P, owner, storeId, broke;
  const toggle = (qs) => fetch(`${P.mock.origin}/__extra?${qs}`).then((r) => r.json());
  const journeys = async () => { const r = await runAndWait(owner, storeId, { kind: 'journeys' }); assert.equal(r.status, 'done', r.error || ''); return r; };
  before(async () => {
    P = await startProduct();
    owner = await signup(P, 'attribution@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
  });
  after(async () => { await toggle('atcscript=0').catch(() => {}); await P?.stop(); });

  it('a pop-up script that breaks Add to cart is named in the failure', async (t) => {
    const ok = await journeys();
    assert.equal(find(ok, 'fn.atc').status, 'pass');
    await toggle('atcscript=1');
    broke = await journeys();
    const c = find(broke, 'fn.atc');
    assert.equal(c.status, 'fail');
    assert.equal(c.severity, 'critical');
    assert.match(c.detail, /This started after this script appeared: http:\/\/127\.0\.0\.1:\d+\/apps\/upsell-popup\.js \(home, product and cart pages\)\. It last worked in check #1\.$/);
    assert.match(c.fix, /^Check the new script first/);
    assert.equal(c.changes.sinceSeq, 1);
    assert.deepEqual(c.changes.scripts.map((s) => s.url.replace(/:\d+/, '')), ['http://127.0.0.1/apps/upsell-popup.js']);
    note(t, c.detail);
  });

  it('the alert email (sent after the confirming re-check) carries the same sentence', async (t) => {
    // A newly critical failure is re-checked a minute later before alerting.
    const re = /🔴 [^\n]*This started after this script appeared: http:\/\/127\.0\.0\.1:\d+\/apps\/upsell-popup\.js/;
    const until = Date.now() + 200000;
    while (!re.test(P.log()) && Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
    assert.match(P.log(), re);
    assert.match(P.log(), /\[mail skipped\] to=attribution@shop\.test subject=Urgent: Check failed on Mock Store/);
    // Wait for the confirming check to be saved before starting another.
    while (P.db().prepare("SELECT COUNT(*) AS n FROM runs WHERE store_id = ? AND status IN ('queued','running')").get(storeId).n && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
    note(t, P.log().match(re)[0]);
  });

  it('while it stays broken, later checks do not repeat it', async () => {
    const r = await journeys();
    const c = find(r, 'fn.atc');
    assert.equal(c.status, 'fail');
    assert.ok(!/This started after/.test(c.detail), c.detail);
    assert.equal(c.changes, undefined);
  });

  it('the report shows which script it started after', async (t) => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      await ctx.addCookies(owner.browserCookies());
      const p = await ctx.newPage();
      await p.goto(`${P.base}/app#/s/${storeId}/reports/${broke.id}`);
      await p.waitForSelector('[data-rtab]', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      const line = p.locator('#changes .started-after').first();
      await line.waitFor({ timeout: 10000 });
      assert.match(await line.textContent(), /^Started after: upsell-popup\.js from 127\.0\.0\.1:\d+ New script$/);
      assert.ok(await line.isVisible());
      await screenshot(t, p, 'Report naming the script', { fullPage: false });
    } finally { await browser.close(); }
  });
});
