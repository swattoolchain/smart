// CSV exports and the printable / PDF report (roadmap 13, part 1): runs, checks and products as CSV,
// a report carrying the store's name, all for the store owner only.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait, shopifyOpen } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

/** Minimal CSV parser for assertions (quoted cells, doubled quotes, CRLF). */
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const objects = (rows) => rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]])));

describe('Exports and printable report', { concurrency: 1 }, () => {
  let P, owner, other, storeId, run, browser;
  const raw = async (s, url) => fetch(P.base + url, { headers: { cookie: [...s.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  before(async () => {
    P = await startProduct();
    owner = await signup(P, 'exports@shop.test');
    other = await signup(P, 'exports-other@shop.test');
    storeId = await addStore(P, owner, { runNow: false, name: 'Kaveri Handlooms' });
    run = await runAndWait(owner, storeId, { kind: 'full', groups: ['catalog'] });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('CSV cells are safe for Excel: formulas stay text, commas and quotes are quoted', async (t) => {
    process.env.DATA_DIR = P.dataDir;
    const { csvCell, toCsv } = await import('../src/export.js');
    assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
    assert.equal(csvCell('+91 98'), "'+91 98");
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvCell(-5), '-5', 'real negative numbers stay numbers');
    assert.equal(csvCell('a, b'), '"a, b"');
    assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
    assert.equal(csvCell(null), '');
    const csv = toCsv([{ label: 'A', key: 'a' }], [{ a: '₹1,499' }]);
    assert.ok(csv.startsWith('﻿'), 'byte-order mark for Excel');
    note(t, 'formula prefixes =, +, -, @ escaped with an apostrophe; RFC 4180 quoting; UTF-8 BOM');
  });

  it('exports the history of checks as CSV', async (t) => {
    assert.equal(run.status, 'done', run.error || '');
    const r = await raw(owner, `/api/stores/${storeId}/export/runs.csv?days=30`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="tharam-localhost-\d+-checks-history-\d{4}-\d{2}-\d{2}\.csv"/);
    const text = await r.text();
    const rows = objects(parseCsv(text.replace(/^﻿/, '')));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]['Type'], 'Full check');
    assert.equal(rows[0]['Score'], String(run.score));
    assert.equal(rows[0]['Checks run'], String(run.result.checks.length));
    assert.match(rows[0]['Started (UTC)'], /^\d{4}-\d{2}-\d{2}T/);
    note(t, `${parseCsv(text)[0].join(' | ')}\n${Object.values(rows[0]).join(' | ')}`);
  });

  it('exports every check of a report as CSV', async (t) => {
    const r = await raw(owner, `/api/stores/${storeId}/export/checks.csv?run=${run.id}`);
    assert.equal(r.status, 200);
    const rows = objects(parseCsv((await r.text()).replace(/^﻿/, '')));
    assert.equal(rows.length, run.result.checks.length);
    const pricing = rows.find((x) => x['Check id'] === 'cat.pricing');
    assert.equal(pricing['Result'], 'Fail');
    assert.match(pricing['What we found'], /Brass Diya Set/);
    assert.ok(pricing['How to fix'].length > 10);
    const latest = await raw(owner, `/api/stores/${storeId}/export/checks.csv`);
    assert.equal(latest.status, 200, 'latest report when no run is given');
    note(t, `${rows.length} checks; e.g. ${pricing['Check']}: ${pricing['Result']}`);
  });

  it('exports every product with its problems as CSV', async (t) => {
    const r = await raw(owner, `/api/stores/${storeId}/export/products.csv`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /-products-/);
    const rows = objects(parseCsv((await r.text()).replace(/^﻿/, '')));
    assert.equal(rows.length, 3);
    const diya = rows.find((x) => x['Handle'] === 'brass-diya');
    assert.equal(diya['Lowest price'], '0');
    assert.ok(Number(diya['Problems']) >= 2, diya['Problems']);
    assert.match(diya['What to fix'], /zero/i);
    assert.equal(diya['Currency'], 'INR');
    assert.match(diya['Link'], /\/products\/brass-diya$/);
    const kurta = rows.find((x) => x['Handle'] === 'cotton-kurta');
    assert.equal(kurta['Variants'], '3');
    assert.equal(kurta['Highest price'], '1599');
    note(t, rows.map((x) => `${x['Product']}: ${x['Problems']} problems`).join('; '));
  });

  it('the printable report carries the store name, problems and fixes, and loads nothing from outside', async (t) => {
    const r = await raw(owner, `/api/stores/${storeId}/runs/${run.id}/report.html`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await r.text();
    assert.match(html, /<h1>Kaveri Handlooms<\/h1>/);
    assert.match(html, /What needs fixing/);
    assert.match(html, /How to fix:/);
    assert.ok(!/(src|href)="https?:/.test(html), 'no outside resources');
    const ctx = await browser.newContext({ viewport: { width: 900, height: 1200 } });
    const p = await ctx.newPage();
    await p.setContent(html);
    await screenshot(t, p, 'Printable report', { fullPage: true });
    await ctx.close();
    note(t, `${html.length} bytes, self-contained`);
  });

  it('the PDF report downloads', { timeout: 60000 }, async (t) => {
    const r = await raw(owner, `/api/stores/${storeId}/runs/${run.id}/report.pdf`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.match(r.headers.get('content-disposition'), /filename="tharam-localhost-\d+-report-\d+-\d{4}-\d{2}-\d{2}\.pdf"/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(buf.length > 5000, `${buf.length} bytes`);
    note(t, `PDF ${buf.length} bytes, ${(buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length} page(s)`);
  });

  it('only the owner can export, and only their own reports', async (t) => {
    const shop = await shopifyOpen(P);
    const urls = [`/api/stores/${storeId}/export/runs.csv`, `/api/stores/${storeId}/export/checks.csv?run=${run.id}`, `/api/stores/${storeId}/export/products.csv`, `/api/stores/${storeId}/runs/${run.id}/report.html`, `/api/stores/${storeId}/runs/${run.id}/report.pdf`];
    for (const u of urls) {
      assert.equal((await raw(other, u)).status, 404, `other account: ${u}`);
      assert.equal((await shop.get(u)).status, 404, `Shopify account: ${u}`);
      assert.equal((await fetch(P.base + u)).status, 401, `signed out: ${u}`);
    }
    // The other account's own store can't be used to read this store's report.
    const otherStore = await addStore(P, other, { runNow: false });
    assert.equal((await raw(other, `/api/stores/${otherStore}/export/checks.csv?run=${run.id}`)).status, 404);
    assert.equal((await raw(other, `/api/stores/${otherStore}/runs/${run.id}/report.pdf`)).status, 404);
    assert.equal((await raw(other, `/api/stores/${otherStore}/export/products.csv?run=${run.id}`)).status, 404);
    assert.equal((await raw(other, `/api/stores/${otherStore}/export/products.csv`)).status, 404, 'no full check yet');
    note(t, `${urls.length} export links refused for another account, a Shopify account and signed-out visitors; a report id can't be borrowed through another store`);
  });

  it('the app offers the exports where people look for them', { timeout: 90000 }, async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    const quiet = () => p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    await p.goto(`${P.base}/app#/s/${storeId}/runs/${run.id}`);
    await p.waitForSelector('[data-download$="report.pdf"]', { timeout: 20000 });
    await quiet();
    const [pdf] = await Promise.all([p.waitForEvent('download'), p.click('[data-download$="report.pdf"]')]);
    assert.match(pdf.suggestedFilename(), /^tharam-localhost-\d+-report-\d+-.*\.pdf$/);
    await p.locator('.export-row').scrollIntoViewIfNeeded();
    await screenshot(t, p, 'Report: Download PDF, Print and Checks as CSV');
    await p.goto(`${P.base}/app#/s/${storeId}/runs`);
    await p.waitForSelector('[data-download*="runs.csv"]', { timeout: 20000 });
    await quiet();
    const [csv] = await Promise.all([p.waitForEvent('download'), p.click('[data-download*="runs.csv"]')]);
    assert.match(csv.suggestedFilename(), /checks-history.*\.csv$/);
    await screenshot(t, p, 'Runs: Export CSV');
    await p.goto(`${P.base}/app#/s/${storeId}/catalog`);
    await p.waitForSelector('[data-download*="products.csv"]', { timeout: 20000 });
    await quiet();
    const [prod] = await Promise.all([p.waitForEvent('download'), p.click('[data-download*="products.csv"]')]);
    assert.match(prod.suggestedFilename(), /products.*\.csv$/);
    await screenshot(t, p, 'Catalog: Export products');
    assert.deepEqual(errors, []);
    note(t, [pdf, csv, prod].map((d) => d.suggestedFilename()).join(', '));
    await ctx.close();
  });
});
