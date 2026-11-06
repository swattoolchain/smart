// Alerts: one email when a check breaks and one when it is fixed, never repeated while it stays broken;
// Slack messages in Slack's webhook format (only on plans with Slack); the test alert; changing the alert email.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait, ROOT } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const fail = (id, title, severity = 'major', extra = {}) => ({ id, category: 'functional', title, status: 'fail', severity, detail: `${title} is broken.`, fix: 'Do the fix.', ...extra });
const pass = (id, title, severity = 'major') => ({ id, category: 'functional', title, status: 'pass', severity, detail: 'Fine.', fix: '' });

describe('Alert rules', () => {
  // The alert logic in-process, against its own database, with Slack and email captured.
  let q, handleAlerts, sendSlack, updateLicense, ensureLicense, storeId, userId;
  const slack = [];
  const mail = [];
  let realFetch, realLog;
  before(async () => {
    realFetch = globalThis.fetch;
    realLog = console.log;
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-alerts-'));
    process.env.SMTP_HOST = '';
    process.env.MAIL_DEBUG = '1';
    process.env.BASE_URL = 'http://tharam.test';
    ({ q } = await import('../src/db.js'));
    ({ handleAlerts, sendSlack } = await import('../src/alerts.js'));
    ({ updateLicense, ensureLicense } = await import('../src/license.js'));
    userId = Number(q.insertUser.run('rules@shop.test', 'x', 'Rules').lastInsertRowid);
    ensureLicense(userId);
    storeId = Number(q.insertStore.run(userId, 'https://kaveri.example', 'Kaveri Handlooms', null, 'alerts@kaveri.example', 'https://hooks.slack.com/services/T000/B000/XXXX', '{}', 'Shopify', 1).lastInsertRowid);
    globalThis.fetch = async (url, opts) => { slack.push({ url, opts, body: JSON.parse(opts.body) }); return { ok: true }; };
    console.log = (...a) => { const s = a.join(' '); const m = /^\[mail skipped\] to=(\S*) subject=(.*)$/.exec(s); if (m) mail.push({ to: m[1], subject: m[2], text: '' }); else if (mail.length && !mail.at(-1).text) mail.at(-1).text = s; else realLog(...a); };
  });
  after(() => { if (realFetch) globalThis.fetch = realFetch; if (realLog) console.log = realLog; });
  const reset = () => { slack.length = 0; mail.length = 0; };
  const alerts = () => q.alertsByStore.all(storeId);

  it('a check that breaks sends one email and one Slack message, with the fix and the report link', async (t) => {
    reset();
    await handleAlerts(storeId, 11, { kind: 'journeys', checks: [fail('fn.search', 'Search returns products'), pass('fn.atc', 'Add to cart works', 'critical')] });
    assert.equal(mail.length, 1);
    assert.equal(mail[0].to, 'alerts@kaveri.example');
    assert.equal(mail[0].subject, 'Check failed on Kaveri Handlooms: Search returns products');
    assert.match(mail[0].text, /🔴 Search returns products: Search returns products is broken\.\n {3}Fix: Do the fix\./);
    assert.match(mail[0].text, /Full report with screenshots: http:\/\/tharam\.test\/app#\/s\/\d+\/reports\/11/);
    assert.equal(slack.length, 1);
    assert.equal(slack[0].url, 'https://hooks.slack.com/services/T000/B000/XXXX');
    assert.equal(slack[0].opts.method, 'POST');
    assert.equal(slack[0].opts.headers['Content-Type'], 'application/json');
    assert.deepEqual(Object.keys(slack[0].body), ['text'], 'Slack incoming webhooks take {"text": …}');
    assert.match(slack[0].body.text, /^\*Check failed on Kaveri Handlooms: Search returns products\*\n🔴 Search returns products/);
    assert.equal(alerts()[0].state, 'failing');
    note(t, `email “${mail[0].subject}”; Slack: ${JSON.stringify(slack[0].body).slice(0, 160)}…`);
  });

  it('while it stays broken, nothing is sent again', async () => {
    reset();
    const before = alerts().length;
    for (const runId of [12, 13]) await handleAlerts(storeId, runId, { kind: 'journeys', checks: [fail('fn.search', 'Search returns products')] });
    assert.equal(mail.length, 0);
    assert.equal(slack.length, 0);
    assert.equal(alerts().length, before);
  });

  it('when it is fixed, one “Fixed” email is sent', async (t) => {
    reset();
    await handleAlerts(storeId, 14, { kind: 'journeys', checks: [pass('fn.search', 'Search returns products')] });
    assert.equal(mail.length, 1);
    assert.equal(mail[0].subject, 'Fixed on Kaveri Handlooms: Search returns products');
    assert.match(mail[0].text, /🟢 Recovered: Search returns products/);
    assert.equal(slack.length, 1);
    assert.equal(alerts()[0].state, 'recovered');
    reset();
    await handleAlerts(storeId, 15, { kind: 'journeys', checks: [pass('fn.search', 'Search returns products')] });
    assert.equal(mail.length, 0, 'not repeated either');
    note(t, mail.length ? '' : '“Fixed on Kaveri Handlooms: Search returns products”, sent once');
  });

  it('a critical failure is marked urgent, and several failures go in one email', async (t) => {
    reset();
    await handleAlerts(storeId, 16, { kind: 'journeys', checks: [fail('fn.atc', 'Add to cart works', 'critical'), fail('fn.cart', 'Cart shows items')] });
    assert.equal(mail.length, 1);
    assert.equal(mail[0].subject, 'Urgent: Check failed on Kaveri Handlooms: Add to cart works (+1 more)');
    assert.match(mail[0].text, /Add to cart works[\s\S]*Cart shows items/);
    await handleAlerts(storeId, 17, { kind: 'journeys', checks: [pass('fn.atc', 'Add to cart works', 'critical'), pass('fn.cart', 'Cart shows items')] });
    assert.equal(mail[1].subject, 'Fixed on Kaveri Handlooms: Add to cart works, Cart shows items');
    note(t, `${mail[0].subject} / ${mail[1].subject}`);
  });

  it('warnings, minor failures and skipped checks never alert', async () => {
    reset();
    await handleAlerts(storeId, 18, { kind: 'full', checks: [
      { ...fail('nf.seo.title', 'Page titles'), severity: 'minor' },
      { ...fail('fn.search', 'Search returns products'), status: 'warn' },
      { ...fail('fn.variant', 'Variants'), status: 'skip' },
    ] });
    assert.equal(mail.length, 0);
    assert.equal(slack.length, 0);
  });

  it('a failure whose check was switched off is closed quietly', async () => {
    await handleAlerts(storeId, 19, { kind: 'journeys', checks: [fail('fn.search', 'Search returns products')] });
    q.updateStoreConfig.run(JSON.stringify({ disabled: ['journey.search'] }), storeId);
    reset();
    await handleAlerts(storeId, 20, { kind: 'journeys', checks: [pass('fn.atc', 'Add to cart works', 'critical')] });
    assert.equal(q.getCheckState.get(storeId, 'fn.search').status, 'ok');
    assert.equal(mail.length, 0, 'no “Fixed” email for a check that was switched off');
    q.updateStoreConfig.run('{}', storeId);
  });

  it('Slack is used only on plans that include it, and only for Slack webhook addresses', async () => {
    updateLicense('test', userId, { plan_key: 'starter' });
    reset();
    await handleAlerts(storeId, 21, { kind: 'journeys', checks: [fail('fn.search', 'Search returns products')] });
    assert.equal(mail.length, 1, 'email still sent');
    assert.equal(slack.length, 0, 'no Slack on Starter');
    updateLicense('test', userId, { plan_key: 'beta' });
    assert.equal(await sendSlack('https://evil.example/hook', 'x'), false);
    assert.equal(await sendSlack(null, 'x'), false);
    assert.equal(slack.length, 0);
  });
});

/** Restarts the product's mock store on the same address with different breakages (the store "gets fixed"). */
async function restartMock(P, breaks) {
  P.mock.stop();
  await new Promise((r) => setTimeout(r, 300));
  const child = spawn(process.execPath, ['test/mock-store.js'], { cwd: ROOT, env: { ...process.env, MOCK_PORT: String(P.mock.port), MOCK_BREAK: breaks, MOCK_EXTRA: '' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${P.mock.origin}/products.json`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  P.mock.stop = () => { try { child.kill('SIGTERM'); } catch {} };
}

describe('Alerts from real checks', () => {
  let P, owner, storeId, browser;
  const mails = () => [...P.log().matchAll(/\[mail skipped\] to=(\S*) subject=(.*)/g)].map((m) => ({ to: m[1], subject: m[2].trim() })).filter((m) => /Mock Store/.test(m.subject));
  before(async () => {
    P = await startProduct({ mock: { breaks: 'search' } });
    owner = await signup(P, 'alerts@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('broken search: one email to the alert address', { timeout: 300000 }, async (t) => {
    const run = await runAndWait(owner, storeId, { kind: 'journeys' }, 280000);
    assert.equal(run.result.checks.find((c) => c.id === 'fn.search').status, 'fail');
    await new Promise((r) => setTimeout(r, 300));
    const m = mails();
    assert.equal(m.length, 1, JSON.stringify(m));
    assert.deepEqual(m[0], { to: 'alerts@shop.test', subject: 'Check failed on Mock Store: Search returns products' });
    assert.match(P.log(), /🔴 Search returns products:/);
    note(t, `${m[0].to}: ${m[0].subject}`);
  });

  it('the alert email can be changed, and a bad address is refused', async () => {
    const bad = await owner.patch(`/api/stores/${storeId}`, { alertEmail: 'not-an-email' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Alert email is not valid/);
    const ok = await owner.patch(`/api/stores/${storeId}`, { alertEmail: 'team@shop.test' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.store.alert_email, 'team@shop.test');
    const slack = await owner.patch(`/api/stores/${storeId}`, { slack: 'https://example.com/hook' });
    assert.equal(slack.status, 400);
    assert.match(slack.json.error, /hooks\.slack\.com/);
  });

  it('still broken on the next check: no second email', { timeout: 300000 }, async () => {
    await runAndWait(owner, storeId, { kind: 'journeys' }, 280000);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(mails().length, 1);
  });

  it('search fixed: one “Fixed” email, to the new address', { timeout: 300000 }, async (t) => {
    await restartMock(P, '');
    const run = await runAndWait(owner, storeId, { kind: 'journeys' }, 280000);
    assert.equal(run.result.checks.find((c) => c.id === 'fn.search').status, 'pass');
    await new Promise((r) => setTimeout(r, 300));
    const m = mails();
    assert.equal(m.length, 2, JSON.stringify(m));
    assert.deepEqual(m[1], { to: 'team@shop.test', subject: 'Fixed on Mock Store: Search returns products' });
    const hist = (await owner.get(`/api/stores/${storeId}/runs?limit=1`)).json.alerts;
    assert.deepEqual(hist.map((a) => a.state), ['recovered', 'failing']);
    note(t, `${m[1].to}: ${m[1].subject}`);
  });

  it('the test alert goes to the saved address and says email is not set up yet', async (t) => {
    const r = await owner.post(`/api/stores/${storeId}/test-alert`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { email: false, slack: null, webhook: null, emailConfigured: false });
    assert.match(P.log(), /\[mail skipped\] to=team@shop\.test subject=Test alert for Mock Store/);
    assert.match(P.log(), /This is a test alert for Mock Store from Tharam Store Guard/);
    const other = await signup(P, 'alerts-other@shop.test');
    assert.ok([403, 404].includes((await other.post(`/api/stores/${storeId}/test-alert`)).status));
    note(t, JSON.stringify(r.json));
  });

  it('the Alerts page shows the history and where alerts go', async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    const quiet = () => p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    await p.goto(`${P.base}/app#/s/${storeId}/alerts`);
    await p.waitForSelector('text=Alert history', { timeout: 20000 });
    await quiet();
    assert.match(await p.textContent('.main-inner'), /Nothing is broken right now/);
    assert.equal(await p.locator('.sev.fail:has-text("Broke")').count(), 1);
    assert.equal(await p.locator('.sev.ok:has-text("Fixed")').count(), 1);
    await screenshot(t, p, 'Alert history');
    await p.goto(`${P.base}/app#/s/${storeId}/alerts/channels`);
    await p.waitForSelector('#test-alert', { timeout: 20000 });
    await quiet();
    assert.equal(await p.inputValue('#ae'), 'team@shop.test');
    await p.click('#test-alert');
    await p.waitForFunction(() => document.querySelector('#test-result')?.textContent.trim().length > 0, null, { timeout: 10000 });
    assert.match(await p.textContent('#test-result'), /Email sending is not set up on this server yet/);
    await screenshot(t, p, 'Where alerts go, after a test alert');
    assert.deepEqual(errors, []);
  });
});
