// Security audit mediums (T95): sessions end on logout and password change, free reports open only by a
// random link, store names can't inject HTML into alert emails, and the report lightbox builds elements.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';
import { escHtml } from '../src/html.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Security audit mediums', () => {
  let P, browser;
  before(async () => {
    P = await startProduct({ mock: { breaks: 'atc' }, env: { MAIL_DEBUG_HTML: '1' } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('logging out ends the account\'s other browser sessions too', async (t) => {
    const a = await signup(P, 'logout-all@shop.test');
    const b = P.session();
    assert.equal((await b.post('/api/auth/login', { email: a.email, password: a.password })).status, 200);
    assert.equal((await b.get('/api/me')).status, 200, 'second browser signed in');
    assert.equal((await a.post('/api/auth/logout')).status, 200);
    assert.equal((await a.get('/api/me')).status, 401);
    assert.equal((await b.get('/api/me')).status, 401, 'the other browser is signed out too');
    const c = P.session();
    assert.equal((await c.post('/api/auth/login', { email: a.email, password: a.password })).status, 200);
    assert.equal((await c.get('/api/me')).status, 200, 'signing in again works');
    note(t, 'two browsers signed in; logout in one → both answer 401; a fresh login works');
  });

  it('changing the password signs out other browsers but keeps this one', async (t) => {
    const a = await signup(P, 'pw-change@shop.test');
    const b = P.session();
    await b.post('/api/auth/login', { email: a.email, password: a.password });
    assert.equal((await b.get('/api/me')).status, 200);
    const r = await a.post('/api/account/password', { current: a.password, next: 'a brand new password' });
    assert.equal(r.status, 200, r.text);
    assert.equal((await a.get('/api/me')).status, 200, 'the browser that changed it stays signed in');
    assert.equal((await b.get('/api/me')).status, 401, 'the other browser is signed out');
    assert.equal((await P.session().post('/api/auth/login', { email: a.email, password: a.password })).status, 401, 'old password refused');
    assert.equal((await P.session().post('/api/auth/login', { email: a.email, password: 'a brand new password' })).status, 200);
    // A wrong current password changes nothing and signs nobody out.
    assert.equal((await a.post('/api/account/password', { current: 'wrong', next: 'another password 2' })).status, 400);
    assert.equal((await a.get('/api/me')).status, 200);
    note(t, 'password change → this browser 200, other browser 401, old password 401, new password 200');
  });

  it('free check reports open only by their random link, screenshots only by signed links', async (t) => {
    const start = await P.session().post('/api/scan', { url: P.mock.origin });
    assert.equal(start.status, 200, start.text);
    const link = start.json.runId;
    assert.match(String(link), /^[a-f0-9]{32}$/, 'the report id is a random 32-character link, not a number');
    let run;
    for (let i = 0; i < 240; i++) {
      run = (await P.session().get(`/api/runs/${link}`)).json;
      if (run && ['done', 'error'].includes(run.status)) break;
      await wait(1000);
    }
    assert.equal(run.status, 'done', run.error || '');
    assert.equal(run.id, link, 'the report never shows the run number');
    const num = P.db().prepare('SELECT id FROM runs WHERE public_id = ?').get(link).id;
    assert.equal((await P.session().get(`/api/runs/${num}`)).status, 404, 'the numbered address is refused');
    assert.equal((await P.session().get(`/api/runs/${'0'.repeat(32)}`)).status, 404, 'a made-up link is refused');
    // The same store checked again within the hour gives the same random link.
    assert.equal((await P.session().post('/api/scan', { url: P.mock.origin })).json.runId, link);

    const shots = JSON.stringify(run.result).match(new RegExp(`/shots/run-${num}/[\\w.-]+\\?t=[\\w-]+\\.\\d+`, 'g')) || [];
    assert.ok(shots.length > 0, 'screenshots come with a signature');
    const signed = await fetch(P.base + shots[0]);
    assert.equal(signed.status, 200, 'signed screenshot opens');
    const bare = await fetch(P.base + shots[0].split('?')[0]);
    assert.equal(bare.status, 404, 'the same screenshot without its signature is refused');
    const other = await fetch(P.base + shots[0].replace(/\?t=[\w-]+/, '?t=' + 'A'.repeat(32)));
    assert.equal(other.status, 404, 'a forged signature is refused');

    // Leads from the report keep pointing at the right check.
    assert.equal((await P.session().post('/api/leads', { email: 'lead@shop.test', runId: link, url: P.mock.origin, source: 'report' })).status, 200);
    assert.equal(P.db().prepare('SELECT run_id FROM leads WHERE email = ?').get('lead@shop.test').run_id, num);

    // The report page in a browser, and the screenshot lightbox (built from elements, not HTML).
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/scan/${link}`);
    await p.waitForSelector('img.shot', { timeout: 30000 });
    await screenshot(t, p, 'free report by random link', { fullPage: true });
    const img = p.locator('img.shot').first();
    await img.scrollIntoViewIfNeeded();
    await p.waitForFunction(() => { const i = document.querySelector('img.shot'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15000 });
    const alt = await img.getAttribute('alt');
    await img.click();
    await p.waitForSelector('.lightbox img');
    assert.equal(await p.locator('.lightbox img').getAttribute('alt'), alt);
    assert.equal(await p.locator('.lightbox *').count(), 1, 'the lightbox holds just the image');
    await screenshot(t, p, 'screenshot lightbox');
    assert.deepEqual(errors, []);
    await ctx.close();
    note(t, `report ${link}: number ${num} → 404; screenshot signed 200, unsigned 404, forged 404; lead stored against run ${num}`);
  });

  it('a store name can\'t add HTML to alert emails', async (t) => {
    assert.equal(escHtml(`<img src=x onerror="alert('1')"> & Co`), '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt; &amp; Co');
    const owner = await signup(P, 'alert-name@shop.test');
    const evil = '<img src=x onerror=alert(1)> Shop & Co';
    const storeId = await addStore(P, owner, { name: evil, runNow: false });
    const run = await runAndWait(owner, storeId, {}, 300000);
    assert.equal(run.status, 'done', run.error || '');
    let html = null;
    for (let i = 0; i < 90 && !html; i++) {
      html = (P.log().match(/\[mail html\] [^\n]*/g) || []).find((l) => l.includes('Shop &amp; Co')) || null;
      if (!html) await wait(1000);
    }
    assert.ok(html, 'an alert email was sent for the broken Add to cart');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; Shop &amp; Co'), 'store name shown as text');
    assert.ok(!html.includes('<img src=x'), 'no tag from the store name in the email');
    note(t, `store named ${JSON.stringify(evil)} → alert email shows it escaped`);
  });
});
