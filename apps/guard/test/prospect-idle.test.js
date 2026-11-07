// Prospects stop when there is nothing new: each store is read once, the founder is told once, and only a new
// store wakes the work again. Stores that were contacted, answered or opted out are never read again.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, startMock, founderSession } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.ALLOW_LOCAL_TARGETS = '1';
const host = (m) => new URL(m.origin).host;
const reqs = async (m) => (await (await fetch(`${m.origin}/__requests`)).json()).requests.length;

describe('Prospects stop when there is nothing new', () => {
  let P, boss, eu1, eu2, browser;
  before(async () => {
    P = await startProduct();
    boss = await founderSession(P);
    eu1 = await startMock({ extra: 'meta-eu' }); // EU stores are read quickly (public details only)
    eu2 = await startMock({ extra: 'meta-eu' });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); eu1?.stop(); eu2?.stop(); await P?.stop(); });

  const imp = (body) => boss.req('POST', '/api/admin/prospects/import', body, { 'content-type': 'text/plain' });
  const run = async (max = 5) => (await boss.post('/api/admin/prospects/run', { max })).json;
  const mails = () => (P.log().match(/subject=Prospects: all \d+ stores are checked/g) || []).length;
  const sum = async () => (await boss.get('/api/admin/prospects')).json.summary;
  const row = (d) => P.db().prepare('SELECT * FROM prospects WHERE domain = ?').get(d);

  it('everything is read once, then the work goes idle, says so, and emails the founder once', async (t) => {
    const a = host(eu1), b = `127.0.0.1:${eu1.port}`;
    assert.equal((await imp(`${a}\n${b}`)).json.added, 2);
    assert.equal((await sum()).idle, false);
    const first = await run();
    assert.deepEqual([first.ran, first.stopped], [2, 'empty']);
    const s = await sum();
    assert.equal(s.idle, true);
    assert.equal(s.idleMessage, 'All 2 imported stores are checked. Import more to continue.');
    assert.equal(mails(), 1, 'the founder is emailed once');
    // Nothing left: later runs read nothing and say nothing more.
    const seen = await reqs(eu1);
    const again = await run();
    assert.deepEqual([again.ran, again.stopped], [0, 'empty']);
    assert.equal(mails(), 1);
    assert.equal(await reqs(eu1), seen, 'no store was visited again');
    note(t, `read 2 stores once; message "${s.idleMessage}"; one email; a second run visits nothing`);
  });

  it('an import with nothing new says so and starts nothing; a new store wakes the work for exactly that one', async (t) => {
    const a = host(eu1);
    const same = (await imp(`https://www.${a}/\n${a}`)).json;
    assert.equal(same.added, 0);
    assert.equal(same.message, 'Nothing new: all 2 were already there');
    assert.equal((await sum()).idle, true, 'still idle');
    assert.equal((await run()).ran, 0);
    assert.equal(mails(), 1);
    const c = host(eu2);
    const n = (await imp(`${a}\n${c}`)).json;
    assert.equal(n.message, '1 new, 1 already there');
    assert.equal((await sum()).idle, false, 'awake again');
    const before = await reqs(eu1), beforeNew = await reqs(eu2);
    const r = await run();
    assert.deepEqual([r.ran, r.stopped], [1, 'empty']);
    assert.equal(await reqs(eu1), before, 'the old stores were not touched');
    assert.ok(await reqs(eu2) > beforeNew, 'the new store was read');
    assert.equal(row(c).state, 'skipped');
    assert.equal((await sum()).idleMessage, 'All 3 imported stores are checked. Import more to continue.');
    assert.equal(mails(), 2, 'one more email, for the new round');
    note(t, 'identical import: "Nothing new: all 2 were already there", nothing started; 1 new store: exactly 1 read, then idle again with one more email');
  });

  it('stores that were contacted, answered or opted out are never checked again; "Check again" is a founder\'s choice', async (t) => {
    const a = host(eu1), b = `127.0.0.1:${eu1.port}`, c = host(eu2);
    const path = (d) => `/api/admin/prospects/${encodeURIComponent(d)}`;
    await boss.patch(path(a), { status: 'contacted' });
    await boss.patch(path(b), { status: 'replied' });
    await boss.patch(path(c), { status: 'opted_out' });
    for (const d of [a, b, c]) {
      const r = await boss.post(`${path(d)}/check-again`);
      assert.equal(r.status, 400, d);
      assert.match(r.json.error, /not checked again/);
      assert.notEqual(row(d).state, 'queued');
    }
    // Even if one were queued, the reader skips it.
    await boss.patch(path(a), { status: 'contacted' });
    assert.equal((await run()).ran, 0);
    // A store that is only new or drafted can be checked again, once, on purpose.
    const d = `localhost:${eu2.port}`.replace('localhost', '127.0.0.1');
    await imp(d);
    assert.equal((await run()).ran, 1);
    assert.equal((await boss.patch(path(d), { status: 'drafted' })).status, 200);
    assert.equal((await boss.post(`${path(d)}/check-again`)).status, 200);
    assert.equal(row(d).state, 'queued');
    const before = await reqs(eu2);
    assert.equal((await run()).ran, 1);
    assert.ok(await reqs(eu2) > before);
    assert.equal((await boss.post('/api/admin/prospects/nobody.example.com/check-again')).status, 404);
    note(t, 'contacted, replied and opted-out stores refuse "Check again" and are never read; a drafted store can be read again on purpose');
  });

  it('the Prospects screen shows the idle line and a Check again button', async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(boss.browserCookies());
    const p = await ctx.newPage();
    await p.goto(`${P.base}/app#/admin/prospects`);
    await p.waitForSelector('#ptable', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    assert.match(await p.locator('#pidle').innerText(), /^All \d+ imported stores are checked\. Import more to continue\.$/);
    assert.ok(await p.locator('button.pagain').count() >= 1);
    await screenshot(t, p, 'Idle message and Check again', { fullPage: true });
    await ctx.close();
  });
});
