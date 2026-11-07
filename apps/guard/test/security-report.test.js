// Security watch S13: the monthly security report (page, PDF, email, monthly send).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { startProduct, signup, addStore } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-secreport-'));
process.env.FEATURES_DEFAULT = 'on';
const { db, q } = await import('../src/db.js');
const R = await import('../src/security-report.js');
const C = await import('../src/security-checklist.js');

const DAY = 24 * 3600 * 1000;
const NOW = Date.now();
let n = 0;
function newStore({ monitoring = 1, ageDays = 60 } = {}) {
  const u = Number(q.insertUser.run(`owner${++n}@secreport.test`, 'x', 'Owner').lastInsertRowid);
  const id = Number(q.insertStore.run(u, `https://shop${n}.example.com`, `Shop ${n}`, null, `alerts${n}@secreport.test`, null, '{}', 'Shopify', monitoring).lastInsertRowid);
  db.prepare("UPDATE stores SET created_at = ? WHERE id = ?").run(new Date(NOW - ageDays * DAY).toISOString().slice(0, 19).replace('T', ' '), id);
  return q.storeById.get(id);
}
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
/** One finished check `daysAgo` days back with the given security checks. */
function addRun(store, daysAgo, checks, kind = 'full') {
  const at = stamp(NOW - daysAgo * DAY);
  db.prepare("INSERT INTO runs (store_id, url, kind, status, result_json, created_at, finished_at) VALUES (?, ?, ?, 'done', ?, ?, ?)")
    .run(store.id, store.url, kind, JSON.stringify({ checks }), at, at);
}
const chk = (id, status, extra = {}) => ({ id, title: `Title of ${id}`, status, severity: 'major', detail: `Detail of ${id}`, fix: `Fix for ${id}`, ...extra });

describe('Monthly security report: what it says', () => {
  it('a clean month says so in plain words', (t) => {
    const s = newStore();
    for (const d of [20, 10, 2]) addRun(s, d, [chk('sec.redirect', 'pass'), chk('sec.spam', 'pass')]);
    const r = R.securityReport(s, { now: NOW });
    assert.equal(r.verdict, 'clear');
    assert.equal(r.headline, 'No security problems seen this month.');
    assert.equal(r.checksRun, 3);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.areas.map((a) => a.label).sort(), ['Redirects, hidden pages and mining', 'Spam links']);
    note(t, `${r.headline} (${r.checksRun} checks, areas: ${r.areas.map((a) => a.label).join(', ')})`);
  });

  it('a problem that went away is "fixed"; one still failing is "open"; open serious ones come first', (t) => {
    const s = newStore();
    addRun(s, 25, [chk('sec.redirect', 'fail', { severity: 'critical' }), chk('sec.spam', 'warn', { severity: 'minor' }), chk('sec.mining', 'pass')]);
    addRun(s, 15, [chk('sec.redirect', 'fail', { severity: 'critical' }), chk('sec.spam', 'warn', { severity: 'minor' }), chk('sec.mining', 'fail', { severity: 'major' })]);
    addRun(s, 5, [chk('sec.redirect', 'pass'), chk('sec.spam', 'warn', { severity: 'minor' }), chk('sec.mining', 'fail', { severity: 'major' })]);
    const r = R.securityReport(s, { now: NOW });
    assert.deepEqual(r.problems.map((p) => [p.id, p.state, p.times]), [['sec.mining', 'open', 2], ['sec.spam', 'open', 3], ['sec.redirect', 'fixed', 2]]);
    assert.deepEqual(r.counts, { found: 3, open: 2, fixed: 1, serious: 1, alerts: 0 });
    assert.equal(r.verdict, 'act');
    assert.match(r.headline, /^2 security problems are still open\. Start with the serious ones\.$/);
    const fixed = r.problems.find((p) => p.state === 'fixed');
    assert.ok(Date.parse(fixed.firstSeen) < Date.parse(fixed.lastSeen));
    note(t, r.problems.map((p) => `${p.state}: ${p.title} (${p.severity}, ${p.times} checks)`).join('\n'));
  });

  it('a problem that is no longer reported once its area was looked at again counts as fixed', () => {
    const s = newStore();
    addRun(s, 12, [chk('sec.domain.expiry', 'fail')]);
    addRun(s, 3, [chk('sec.domain.dns', 'pass')]); // same area (domain watch) ran again; the old problem is no longer reported
    const r = R.securityReport(s, { now: NOW });
    assert.equal(r.problems[0].state, 'fixed');
    assert.equal(r.verdict, 'clear');
    assert.match(r.headline, /found 1 security problem this month and it is now fixed/);
  });

  it('only the last 30 days count, and checks of the release tests do not', () => {
    const s = newStore();
    addRun(s, 45, [chk('sec.redirect', 'fail')]);
    const at = stamp(NOW - 2 * DAY);
    db.prepare("INSERT INTO runs (store_id, url, kind, status, result_json, created_at, finished_at, trigger) VALUES (?, ?, 'full', 'done', ?, ?, ?, 'release')").run(s.id, s.url, JSON.stringify({ checks: [chk('sec.spam', 'fail')] }), at, at);
    const r = R.securityReport(s, { now: NOW });
    assert.equal(r.verdict, 'nodata', 'nothing finished in the window');
    assert.equal(r.checksRun, 0);
    assert.match(r.headline, /nothing to report yet/);
    assert.deepEqual(r.problems, []);
  });

  it('shows app code changes and incidents, and the checklist score', () => {
    const s = newStore();
    addRun(s, 4, [chk('sec.spam', 'pass')]);
    db.prepare("INSERT INTO app_code_changes (app_key, app_name, store_id, run_id, files_json, seen_at) VALUES ('rev', 'Reviews Plus', ?, 1, ?, ?)").run(s.id, JSON.stringify(['a.js', 'b.js']), stamp(NOW - 6 * DAY));
    db.prepare("INSERT INTO incidents (store_id, started_at, ends_at, ended_at, reason) VALUES (?, ?, ?, ?, 'checkout looked odd')").run(s.id, stamp(NOW - 9 * DAY), stamp(NOW - 7 * DAY), stamp(NOW - 7 * DAY));
    C.tick(s.id, 'two_step', true, NOW - DAY);
    const r = R.securityReport(s, { now: NOW });
    assert.deepEqual(r.changes.appCode.map((c) => [c.app, c.files]), [['Reviews Plus', 2]]);
    assert.equal(r.changes.incidents.length, 1);
    assert.equal(r.checklist.score, 25);
    assert.equal(r.checklist.open.length, 6);
    const html = R.reportHtml(r);
    assert.match(html, /Reviews Plus changed its code on your store/);
    assert.match(html, /Incident mode was on from/);
    assert.match(html, /<b>25 of 100<\/b>/);
  });

  it('the page and email are plain words and escape store text', (t) => {
    const s = newStore();
    addRun(s, 3, [chk('sec.spam', 'fail', { title: 'Hidden links <script>alert(1)</script>', detail: 'Found "pills" links', fix: 'Remove the links' })]);
    const r = R.securityReport(s, { now: NOW });
    const html = R.reportHtml(r);
    assert.ok(!html.includes('<script>alert(1)</script>'), 'store text is escaped');
    assert.match(html, /Still open/);
    assert.match(html, /How to fix:<\/b> Remove the links/);
    const m = R.reportEmail(r);
    assert.equal(m.subject, `Security report for ${s.name}: 1 still open`);
    assert.match(m.text, /Still open: Hidden links <script>alert\(1\)<\/script>\n {3}Fix: Remove the links/);
    assert.ok(!m.html.includes('<script>alert(1)</script>'));
    assert.match(m.text, /\/app#\/s\/\d+\/securityreport/);
    assert.match(m.text, /once a month/);
    note(t, `${m.subject}\n\n${m.text}`);
  });
});

describe('Monthly security report: the monthly email', () => {
  const sender = () => { const sent = []; return { sent, send: async (m) => { sent.push(m); } }; };

  it('sends once per store per calendar month, then again next month', async () => {
    const s = newStore();
    addRun(s, 3, [chk('sec.spam', 'pass')]);
    const { sent, send } = sender();
    await R.sendMonthlyReports({ now: NOW, send });
    const mine = () => sent.filter((m) => m.to === s.alert_email);
    assert.equal(mine().length, 1);
    assert.match(mine()[0].subject, /Security report for Shop/);
    await R.sendMonthlyReports({ now: NOW + 1 * DAY, send });
    assert.equal(mine().length, 1, 'not twice in the same month');
    // Next calendar month: the 30 days still hold that check, so a new report goes out, once.
    const nextMonth = new Date(NOW); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 2);
    await R.sendMonthlyReports({ now: nextMonth.getTime(), send });
    assert.equal(mine().length, 2);
    await R.sendMonthlyReports({ now: nextMonth.getTime() + DAY, send });
    assert.equal(mine().length, 2, 'once again only once');
  });

  it('skips new stores, paused monitoring, owners who switched it off, and months with nothing to report', async () => {
    const fresh = newStore({ ageDays: 2 });
    const paused = newStore({ monitoring: 0 });
    const off = newStore();
    const empty = newStore();
    for (const s of [fresh, paused, off]) addRun(s, 3, [chk('sec.spam', 'pass')]);
    R.setMonthly(off.id, false);
    assert.equal(R.monthlyOn(off.id), false);
    assert.equal(R.monthlyOn(fresh.id), true, 'on by default');
    const { sent, send } = sender();
    await R.sendMonthlyReports({ now: NOW, send });
    for (const s of [fresh, paused, off, empty]) assert.equal(sent.filter((m) => m.to === s.alert_email).length, 0, `${s.name} gets nothing`);
  });

  it('a failing mail server never causes repeats', async () => {
    const s = newStore();
    addRun(s, 3, [chk('sec.spam', 'pass')]);
    let tries = 0;
    const send = async (m) => { if (m.to === s.alert_email) { tries++; throw new Error('smtp down'); } };
    await R.sendMonthlyReports({ now: NOW, send });
    await R.sendMonthlyReports({ now: NOW + DAY, send });
    assert.equal(tries, 1);
  });

  it('sends nothing while the feature switch is off', async () => {
    const s = newStore();
    addRun(s, 3, [chk('sec.spam', 'pass')]);
    process.env.FEATURES_DEFAULT = '';
    try {
      const { sent, send } = sender();
      assert.equal(await R.sendMonthlyReports({ now: NOW, send }), 0);
      assert.equal(sent.length, 0);
    } finally { process.env.FEATURES_DEFAULT = 'on'; }
  });
});

describe('Monthly security report: in the product', () => {
  let product, owner, storeId, writable;
  before(async () => {
    product = await startProduct();
    owner = await signup(product);
    storeId = await addStore(product, owner, { runNow: false });
    writable = new Database(path.join(product.dataDir, 'guard.db'));
    writable.pragma('busy_timeout = 5000');
    const seed = (daysAgo, checks) => {
      const at = stamp(NOW - daysAgo * DAY);
      writable.prepare("INSERT INTO runs (store_id, url, kind, status, result_json, created_at, finished_at) VALUES (?, 'http://x', 'full', 'done', ?, ?, ?)").run(storeId, JSON.stringify({ checks }), at, at);
    };
    seed(20, [chk('sec.redirect', 'fail', { severity: 'critical', title: 'Shoppers are sent to another site', detail: 'The home page sends shoppers to cheap-pills.example.' }), chk('sec.spam', 'warn', { severity: 'minor', title: 'Hidden links in page code', detail: '3 hidden links to unrelated sites.', fix: 'Ask your developer to remove them.' })]);
    seed(10, [chk('sec.redirect', 'pass'), chk('sec.spam', 'warn', { severity: 'minor', title: 'Hidden links in page code', detail: '3 hidden links to unrelated sites.', fix: 'Ask your developer to remove them.' })]);
  });
  after(async () => { writable?.close(); await product?.stop(); });

  it('the owner reads the report, prints it, downloads the PDF and emails it', async (t) => {
    const base = `/api/stores/${storeId}/security-report`;
    let r = await owner.get(base);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.verdict, 'watch');
    assert.deepEqual(r.json.problems.map((p) => [p.title, p.state]), [['Hidden links in page code', 'open'], ['Shoppers are sent to another site', 'fixed']]);
    assert.equal(r.json.monthly, true);
    assert.ok(r.json.recipient);
    assert.ok(r.json.checklist, 'checklist is part of it while that feature is on');
    const html = await owner.get(`${base}.html`);
    assert.equal(html.status, 200);
    assert.match(html.text, /Monthly security report/);
    assert.match(html.text, /Shoppers are sent to another site/);
    const pdf = await fetch(`${product.base}${base}.pdf`, { headers: { cookie: owner.browserCookies().map((c) => `${c.name}=${c.value}`).join('; ') } });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-type'), /application\/pdf/);
    assert.match(pdf.headers.get('content-disposition'), /tharam-.*-security-report-\d{4}-\d{2}-\d{2}\.pdf/);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
    const mail = await owner.post(`${base}/email`, {});
    assert.equal(mail.status, 200, mail.text);
    assert.ok(mail.json.to);
    assert.match(mail.json.subject, /Security report for .*: 1 still open/);
    note(t, `report: ${r.json.headline}; PDF ${bytes.length} bytes; emailed to ${mail.json.to}`);
  });

  it('the monthly email can be switched off and on; bad input is refused in plain words', async () => {
    const base = `/api/stores/${storeId}/security-report`;
    assert.equal((await owner.patch(base, { monthly: false })).json.monthly, false);
    assert.equal((await owner.get(base)).json.monthly, false);
    assert.equal((await owner.patch(base, { monthly: true })).json.monthly, true);
    const bad = await owner.patch(base, { monthly: 'yes' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /true or false/);
  });

  it("other accounts and signed-out visitors can't read, print, download or email it", async () => {
    const other = await signup(product);
    const base = `/api/stores/${storeId}/security-report`;
    for (const [m, u, body] of [['get', base], ['get', `${base}.html`], ['get', `${base}.pdf`], ['post', `${base}/email`, {}], ['patch', base, { monthly: false }]]) {
      assert.equal((await other[m](u, body)).status, 404, `${m} ${u} for another account`);
      assert.equal((await product.session()[m](u, body)).status, 401, `${m} ${u} signed out`);
    }
    assert.equal((await owner.get(base)).json.monthly, true, 'nothing changed');
  });

  it('the report page: problems, fixed items, print, PDF and email buttons (desktop and phone)', async (t) => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
      await ctx.addCookies(owner.browserCookies());
      const page = await ctx.newPage();
      await page.goto(`${product.base}/app#/s/${storeId}/securityreport`);
      await page.locator('.sc-list').waitFor({ timeout: 20000 });
      assert.equal(await page.locator('a.rail-item[aria-current="page"]').innerText(), 'Security report');
      assert.match(await page.locator('h2').first().innerText(), /1 small security issue is still open/);
      assert.equal(await page.locator('.sc-item').count(), 2);
      assert.equal(await page.locator('.sc-item.sc-done').count(), 1);
      assert.match(await page.locator('.sc-item.sc-todo .sc-how').innerText(), /Ask your developer to remove them/);
      assert.equal(await page.locator('a:has-text("Download PDF")').count(), 1);
      await screenshot(t, page, 'monthly security report');
      await page.locator('#sr-email').click();
      await page.locator('.toast, [role="status"]').filter({ hasText: 'Sent to' }).first().waitFor({ timeout: 10000 });
      await page.locator('#sr-monthly').evaluate((el) => el.click());
      await page.waitForFunction(async (u) => (await (await fetch(u)).json()).monthly === false, `/api/stores/${storeId}/security-report`);
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true });
      await phone.addCookies(owner.browserCookies());
      const p2 = await phone.newPage();
      await p2.goto(`${product.base}/app#/s/${storeId}/securityreport`);
      await p2.locator('.sc-list').waitFor({ timeout: 20000 });
      assert.equal(await p2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no sideways scrolling on a phone');
      await screenshot(t, p2, 'monthly security report on a phone');
    } finally { await browser.close(); }
  });
});
