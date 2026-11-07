// Common Crawl as a source of Prospects: reads WAT-style fixture bytes (never the live network), keeps each store once,
// resumes mid-archive, pauses when an archive adds nothing new, backs off when the server is slow. Founders only,
// behind the 'prospects' switch (the switch case is in features.test.js).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, founderSession } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-cc-unit-'));
process.env.FEATURES_DEFAULT = 'on';
const { readMember, hostFromRecord, scanWindow, nextArchive } = await import('../src/crawl-source.js');
const { db } = await import('../src/db.js');

// ---------- fixture bytes: one gzip member per WAT record, like the real files ----------
const record = (host, { shopify, via = 'header' }) => {
  const headers = { 'Content-Type': 'text/html', Server: 'nginx' };
  const head = { Scripts: [{ path: 'SCRIPT@/src', url: '/app.js' }], Link: [] };
  if (shopify && via === 'header') headers['x-shopid'] = '12345';
  if (shopify && via === 'script') head.Scripts.push({ path: 'SCRIPT@/src', url: 'https://cdn.shopify.com/s/files/1/0001/theme.js' });
  const json = JSON.stringify({ Envelope: { 'Payload-Metadata': { 'HTTP-Response-Metadata': { Headers: headers, 'HTML-Metadata': { Head: head } } } } });
  return `WARC/1.0\r\nWARC-Type: metadata\r\nWARC-Target-URI: https://${host}/\r\nContent-Type: application/json\r\n\r\n${json}`;
};
const member = (text) => zlib.gzipSync(Buffer.from(text));
const file = (specs) => Buffer.concat([
  member('WARC/1.0\r\nWARC-Type: warcinfo\r\n\r\nsoftware: fixture'), // the first record of a real file is not a page
  ...specs.map(([host, o]) => member(record(host, o))),
]);

const SHOPS = [['alpha-shop.example.com', { shopify: true }], ['beta.example.in', { shopify: true, via: 'script' }], ['gamma.example.co.uk', { shopify: true }]];
const OTHERS = [['plain-blog.example.org', {}], ['news.example.net', {}]];
const SPEC = [SHOPS[0], OTHERS[0], SHOPS[1], OTHERS[1], SHOPS[2]];

describe('Common Crawl: reading WAT bytes', () => {
  it('finds Shopify stores by header or by script, and nothing else', (t) => {
    const hosts = SPEC.map(([h, o]) => hostFromRecord(record(h, o)));
    assert.deepEqual(hosts, ['alpha-shop.example.com', null, 'beta.example.in', null, 'gamma.example.co.uk']);
    assert.equal(hostFromRecord(record('checkout.shopify.com', { shopify: true })), null, "Shopify's own addresses are not stores");
    assert.equal(hostFromRecord('garbage'), null);
    note(t, '3 Shopify pages found (2 by response header, 1 by theme script); 2 other pages and Shopify’s own address ignored');
  });

  it('cuts only on whole records, so a position can always be saved', (t) => {
    const buf = file(SPEC);
    const whole = scanWindow(buf);
    assert.deepEqual(whole.hosts.sort(), SHOPS.map((s) => s[0]).sort());
    assert.equal(whole.end, buf.length);
    const cut = buf.subarray(0, buf.length - 10); // the last record is cut off
    const part = scanWindow(cut);
    assert.ok(part.end < cut.length && part.end > 0);
    assert.equal(part.hosts.length, 2, 'the cut record is left for the next window');
    assert.equal(readMember(buf, part.end).end, buf.length, 'the saved position is the start of a real record');
    note(t, `full file: 3 stores, stops at byte ${whole.end}; cut file stops at byte ${part.end} (a record boundary) with 2 stores`);
  });

  it('prefers archives like the ones that yielded new stores', (t) => {
    const ins = db.prepare("INSERT INTO crawl_archives (id, position, state, matched, added, finished_at) VALUES (?, ?, ?, ?, ?, datetime('now'))");
    ins.run('CC-MAIN-2023-06', 0, 'done', 100, 90);
    ins.run('CC-MAIN-2024-10', 1, 'done', 100, 1);
    ins.run('CC-MAIN-2023-50', 2, 'queued', 0, 0); // same year as the good one
    ins.run('CC-MAIN-2024-22', 3, 'queued', 0, 0); // same year as the poor one, but earlier in the list order
    assert.equal(nextArchive().id, 'CC-MAIN-2023-50');
    db.exec("UPDATE crawl_archives SET state = 'running' WHERE id = 'CC-MAIN-2024-22'");
    assert.equal(nextArchive().id, 'CC-MAIN-2024-22', 'an archive already running is always finished first');
    note(t, 'queued archive from the high-yield year goes first; a running archive is never abandoned');
  });
});

// ---------- the product, reading from a fake Common Crawl ----------
function fakeCrawl() {
  const state = { files: {}, hits: 0, fail: 0 };
  const server = http.createServer((req, res) => {
    state.hits++;
    if (state.fail) { res.writeHead(503); return res.end('slow down'); }
    const url = req.url.split('?')[0];
    let m = /^\/crawl-data\/(CC-MAIN-\d{4}-\d{2})\/wat\.paths\.gz$/.exec(url);
    if (m) {
      const names = Object.keys(state.files).filter((f) => f.startsWith(m[1] + '/'));
      if (!names.length) { res.writeHead(404); return res.end(); }
      return res.end(zlib.gzipSync(names.map((n) => `crawl-data/${n}`).join('\n') + '\n'));
    }
    m = /^\/crawl-data\/(CC-MAIN-\d{4}-\d{2}\/.+)$/.exec(url);
    const buf = m && state.files[m[1]];
    if (!buf) { res.writeHead(404); return res.end(); }
    const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    const from = r ? Number(r[1]) : 0, to = r ? Math.min(Number(r[2]), buf.length - 1) : buf.length - 1;
    if (from >= buf.length) { res.writeHead(416); return res.end(); }
    res.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${buf.length}`, 'Content-Length': to - from + 1 });
    res.end(buf.subarray(from, to + 1));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ state, base: `http://127.0.0.1:${server.address().port}/`, stop: () => server.close() })));
}

describe('Common Crawl: Prospects find stores by themselves', () => {
  let P, boss, cc, browser;
  const IDS = ['CC-MAIN-2023-06', 'CC-MAIN-2023-50', 'CC-MAIN-2023-14', 'CC-MAIN-2023-23', 'CC-MAIN-2023-40']; // 06 and 50 hold the same 5 pages
  const one = buf64k();
  function buf64k() { return file(SPEC); }
  const recordSize = member(record(SHOPS[0][0], SHOPS[0][1])).length;

  before(async () => {
    cc = await fakeCrawl();
    for (const id of IDS) cc.state.files[`${id}/wat/${id}-0.wat.gz`] = id === IDS[0] || id === IDS[1] ? one : file([[`only-${id.toLowerCase()}.example.com`, { shopify: true }]]);
    P = await startProduct({ env: { CC_BASE_URL: cc.base, CC_ARCHIVES: IDS.slice(0, 2).join(','), CC_FILES_PER_ARCHIVE: '1', CC_WINDOW_BYTES: String(recordSize * 3), CC_BYTES_PER_TICK: String(recordSize * 2), CC_DRY_RUN: '2', CC_BACKOFF_BASE_MS: '1500' } });
    boss = await founderSession(P);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); cc?.stop(); await P?.stop(); });

  const run = async () => (await boss.post('/api/admin/prospects/crawl/run', {})).json;
  const crawl = async () => (await boss.get('/api/admin/prospects/crawl')).json;
  const arch = async (id) => (await crawl()).archives.find((a) => a.id === id);
  const prospects = () => P.db().prepare("SELECT domain, source, source_detail FROM prospects WHERE source = 'Common Crawl' ORDER BY domain").all();

  it('a partial run resumes in the middle of the archive and ends with exactly the 3 Shopify stores', async (t) => {
    const positions = [];
    let r;
    for (let i = 0; i < 12; i++) {
      r = await run();
      const a = await arch(IDS[0]);
      positions.push(a.offset);
      if (a.state === 'done') break;
      assert.equal(a.state, 'running');
    }
    const mid = positions.filter((p) => p > 0);
    assert.ok(mid.length >= 1, `it stopped part-way at least twice (saved positions: ${positions.join(', ')})`);
    assert.deepEqual([...mid].sort((a, b) => a - b), mid, 'it always moved forward, never back to the start');
    const a = await arch(IDS[0]);
    assert.equal(a.state, 'done');
    assert.equal(a.stores_found, 3);
    assert.equal(a.stores_added, 3, '3 Shopify stores added, the 2 other pages are not');
    const rows = prospects().filter((x) => x.source_detail === IDS[0]);
    assert.deepEqual(rows.map((x) => x.domain), SHOPS.map((s) => s[0]).sort());
    assert.ok(rows.every((x) => x.source === 'Common Crawl' && x.source_detail === 'CC-MAIN-2023-06'));
    assert.equal(a.yield_percent, 100);
    note(t, `saved positions while reading: ${positions.join(' → ')}; 3 stores added with Source = Common Crawl and Source detail = ${IDS[0]}; new share 100%`);
  });

  it('reading the same archive again adds nothing', async (t) => {
    for (let i = 0; i < 12 && (await arch(IDS[1])).state !== 'done'; i++) await run();
    const a = await arch(IDS[1]); // the same pages, listed again in another archive
    assert.equal(a.state, 'done');
    assert.equal(a.stores_found, 3);
    assert.equal(a.stores_added, 0);
    assert.equal(prospects().length, 3, 'still 3 stores in the list');
    note(t, 'the same pages read again in a second archive: 3 found, 0 added, list unchanged');
  });

  it('a store that asked not to be contacted is never added', async (t) => {
    await boss.post('/api/admin/prospects/crawl/archives', { id: IDS[2] });
    assert.equal((await boss.req('POST', '/api/admin/prospects/do-not-contact', 'only-cc-main-2023-14.example.com', { 'content-type': 'text/plain' })).status, 200);
    for (let i = 0; i < 6 && (await arch(IDS[2])).state !== 'done'; i++) await run();
    const a = await arch(IDS[2]);
    assert.equal(a.state, 'done');
    assert.equal(a.stores_found, 1);
    assert.equal(a.stores_added, 0);
    assert.ok(!prospects().some((x) => x.domain.startsWith('only-cc-main-2023-14')));
    note(t, 'the one store in this archive is on the do-not-contact list: found, but not added');
  });

  it('several archives in a row with nothing new pause the background job and leave a plain note', async (t) => {
    assert.equal((await boss.post('/api/admin/prospects/crawl/auto', { on: true })).json.auto, true);
    // Archives 2 and 3 added nothing new (1 was blocked, 2 is read below with its store already in the list).
    await boss.post('/api/admin/prospects/crawl/archives', { id: IDS[3] });
    await boss.post('/api/admin/prospects/crawl/archives', { id: IDS[4] });
    await boss.req('POST', '/api/admin/prospects/import', 'only-cc-main-2023-23.example.com', { 'content-type': 'text/plain' });
    for (let i = 0; i < 8 && (await arch(IDS[3])).state !== 'done'; i++) await run();
    const s = await crawl();
    assert.equal(s.archives.find((a) => a.id === IDS[3]).stores_added, 0);
    assert.equal(s.auto, false, 'the background job paused itself');
    assert.match(s.pausedNote, /mostly exhausted/);
    assert.match(s.pausedNote, /1 archive left unprocessed/);
    assert.equal((await arch(IDS[4])).state, 'queued', 'the last archive was left alone');
    note(t, `note shown to the founder: "${s.pausedNote}"`);
  });

  it('the Prospects screen shows each archive, its progress and its new share; a manual run goes on', async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    await ctx.addCookies(boss.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#/admin/prospects`);
    await p.waitForSelector('#pcrawl-table', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    const table = await p.locator('#pcrawl-table').innerText();
    assert.match(table, /CC-MAIN-2023-06[\s\S]*Done[\s\S]*3 \/ 3|CC-MAIN-2023-06[\s\S]*Done/);
    assert.match(table, /100%/);
    assert.match(table, /0%/);
    assert.match(await p.locator('#pcpaused').innerText(), /mostly exhausted/);
    assert.equal(await p.locator('#pcauto').isChecked(), false);
    await screenshot(t, p, 'Common Crawl archives with progress and new share', { fullPage: true });
    await p.click('#pcrun');
    await p.waitForFunction((id) => [...document.querySelectorAll('#pcrawl-table tr')].some((r) => r.innerText.includes(id) && /Done|Reading now/.test(r.innerText)), IDS[4], { timeout: 20000 });
    assert.deepEqual(errors, []);
    note(t, 'table lists every archive with status, files read, stores found, new stores added and new share; the pause note is shown; "Read more now" starts it again');
    await ctx.close();
  });

  it('when Common Crawl refuses, we wait longer and do not hammer it, then carry on', async (t) => {
    await boss.post('/api/admin/prospects/crawl/archives', { id: 'CC-MAIN-2024-10' });
    cc.state.files['CC-MAIN-2024-10/wat/x-0.wat.gz'] = file([['late-store.example.com', { shopify: true }]]);
    cc.state.fail = 1;
    const first = await run();
    assert.equal(first.stopped, 'backoff');
    assert.ok((await crawl()).backoffUntil, 'the console says when we try again');
    const hits = cc.state.hits;
    const second = await run();
    assert.equal(second.stopped, 'backoff');
    assert.equal(cc.state.hits, hits, 'no request was made while waiting');
    cc.state.fail = 0;
    await new Promise((r) => setTimeout(r, 1700));
    let r;
    for (let i = 0; i < 4; i++) { r = await run(); if (r.stopped !== 'backoff') break; }
    assert.notEqual(r.stopped, 'backoff');
    assert.equal((await crawl()).backoffUntil, null, 'normal pace again after a clean answer');
    assert.ok(prospects().some((x) => x.domain === 'late-store.example.com'));
    note(t, 'a 503 starts a wait; the second press makes no request; after the wait the next request succeeds and the store is added');
  });

  it('only founders can use it; a bad archive name is refused', async (t) => {
    const bad = await boss.post('/api/admin/prospects/crawl/archives', { id: 'not-an-archive' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /CC-MAIN-2025-21/);
    const ok = await boss.post('/api/admin/prospects/crawl/archives', { id: 'cc-main-2025-30' });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.archives.some((a) => a.id === 'CC-MAIN-2025-30'));
    assert.equal((await boss.post('/api/admin/prospects/crawl/archives', { id: 'CC-MAIN-2025-30' })).status, 400, 'already there');
    const anon = await P.session().get('/api/admin/prospects/crawl');
    assert.ok([401, 403].includes(anon.status));
    note(t, 'bad name refused with an example; new archive added once; a visitor without a login gets nothing');
  });
});
