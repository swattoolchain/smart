// Security watch S12: incident mode — one button, changes since the last healthy check, checks every
// 10 minutes, a recovery checklist, team alerts, ends after 48 hours.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-incident-'));
const { db, q } = await import('../src/db.js');
const I = await import('../src/incident.js');
const { intervals } = await import('../src/scheduler.js');
const { handleAlerts } = await import('../src/alerts.js');

const HOUR = 3600 * 1000;
let n = 0;
function newStore() {
  const u = Number(q.insertUser.run(`owner${++n}@incident.test`, 'x', 'Owner').lastInsertRowid);
  return q.storeById.get(Number(q.insertStore.run(u, `https://shop${n}.example.com`, `Shop ${n}`, null, `owner${n}@incident.test`, null, '{}', 'Shopify', 1).lastInsertRowid));
}
const check = (id, title, status, extra = {}) => ({ id, category: 'functional', title, status, severity: 'critical', detail: `${title}: ${status}`, ...extra });
function seedRun(store, { kind = 'journeys', verdict, checks, theme, at }) {
  const id = Number(q.insertRun.run(store.id, store.url, kind, null, 'schedule').lastInsertRowid);
  q.finishRun.run(verdict === 'healthy' ? 100 : 40, verdict, JSON.stringify({ kind, checks, theme: { name: theme }, categories: [], summary: '' }), id);
  if (at) db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(at, id);
  return id;
}

describe('Incident mode: the rules', () => {
  it('team emails are cleaned, deduplicated and limited to 5', () => {
    assert.deepEqual(I.cleanContacts('Dev@Example.com, partner@example.com; dev@example.com'), ['dev@example.com', 'partner@example.com']);
    assert.deepEqual(I.cleanContacts(['', ' a@b.co ']), ['a@b.co']);
    assert.deepEqual(I.cleanContacts(undefined), []);
    assert.throws(() => I.cleanContacts('not-an-email'), /"not-an-email" is not an email address/);
    assert.throws(() => I.cleanContacts('a@b.co,c@d.co,e@f.co,g@h.co,i@j.co,k@l.co'), /up to 5/);
  });

  it('starts once, ticks steps, ends; a second start while on is refused', () => {
    const s = newStore();
    const row = I.startIncident(s, { reason: 'Prices changed by themselves', contacts: 'dev@example.com' });
    assert.equal(Date.parse(row.ends_at) - Date.parse(row.started_at), 48 * HOUR);
    assert.throws(() => I.startIncident(s), /already on/);
    I.updateIncident(s.id, { steps: { password: true, staff: true } });
    assert.throws(() => I.updateIncident(s.id, { steps: { nope: true } }), /no step called "nope"/);
    assert.throws(() => I.updateIncident(s.id, { steps: { password: 'yes' } }), /true or false/);
    I.updateIncident(s.id, { steps: { staff: false } });
    const v = I.incidentView(s, { shopify: true });
    assert.deepEqual(v.active.steps.filter((x) => x.doneAt).map((x) => x.key), ['password']);
    assert.match(v.active.steps[0].how, /Log out of all devices/);
    assert.deepEqual(v.active.contacts, ['dev@example.com']);
    const ended = I.endIncident(s.id);
    assert.equal(ended.ended_reason, 'owner');
    assert.equal(I.activeIncident(s.id), null);
    assert.equal(I.incidentView(s).history.length, 1);
    assert.throws(() => I.updateIncident(s.id, { steps: { password: true } }), /not on/);
  });

  it('can be started once a week per store, so it never becomes a way around the plan or a mail loop', () => {
    const s = newStore();
    const t0 = Date.now();
    I.startIncident(s, { now: t0, contacts: 'dev@example.com' });
    I.endIncident(s.id, 'owner', t0 + 60000);
    assert.throws(() => I.startIncident(s, { now: t0 + 120000 }), (e) => e.status === 429 && /once a week per store/.test(e.message));
    assert.throws(() => I.startIncident(s, { now: t0 + 6.9 * 24 * HOUR }), /once a week/);
    assert.ok(I.nextStartAt(s.id, t0 + 120000));
    assert.equal(I.nextStartAt(s.id, t0 + 7 * 24 * HOUR + 1), null);
    assert.ok(I.startIncident(s, { now: t0 + 7 * 24 * HOUR + 1 }), 'allowed again after 7 days');
    assert.ok(I.startIncident(newStore()), 'other stores are not affected');
  });

  it('checks every 10 minutes while on, back to the plan afterwards', () => {
    const s = newStore();
    const normal = intervals(s);
    assert.ok(normal.journeyIntervalMin >= 60);
    I.startIncident(s);
    const on = intervals(s);
    assert.equal(on.journeyIntervalMin, 10);
    assert.equal(on.incident, true);
    assert.equal(on.fullIntervalMin, normal.fullIntervalMin);
    I.endIncident(s.id);
    assert.equal(intervals(s).journeyIntervalMin, normal.journeyIntervalMin);
  });

  it('ends by itself after 48 hours', () => {
    const s = newStore();
    const t0 = Date.now();
    I.startIncident(s, { now: t0 });
    assert.equal(I.expiredIncidents(t0 + 47 * HOUR).filter((r) => r.store_id === s.id).length, 0);
    const done = I.expiredIncidents(t0 + 49 * HOUR).filter((r) => r.store_id === s.id);
    assert.equal(done.length, 1);
    assert.equal(done[0].ended_reason, 'time');
    const mail = I.endEmail(s, done[0]);
    assert.match(mail.text, /ended by itself after 48 hours/);
  });

  it('what changed since the last healthy check: broken checks, theme and alerts', (t) => {
    const s = newStore();
    seedRun(s, { verdict: 'healthy', theme: 'Dawn', checks: [check('fn.atc', 'Add to cart works', 'pass'), check('fn.checkout', 'Checkout opens', 'pass')], at: '2026-11-04 08:00:00' });
    q.insertAlert.run(s.id, 'fn.atc', 'failing', 'Customers can\'t add products to the cart.', 'Add to cart works');
    seedRun(s, { verdict: 'critical', theme: 'Dawn (copy) by unknown', checks: [check('fn.atc', 'Add to cart works', 'fail', { fix: 'Check apps installed today' }), check('fn.checkout', 'Checkout opens', 'pass')] });
    const c = I.changesSinceHealthy(s.id);
    assert.equal(c.healthy.created_at, '2026-11-04 08:00:00');
    assert.deepEqual(c.broken.map((b) => b.id), ['fn.atc']);
    assert.equal(c.broken[0].fix, 'Check apps installed today');
    assert.deepEqual(c.theme, { before: 'Dawn', after: 'Dawn (copy) by unknown' });
    assert.equal(c.alerts[0].title, 'Add to cart works');
    const row = I.startIncident(s, { contacts: ['dev@example.com'] });
    const mail = I.startEmail(s, row, { shopify: true });
    assert.equal(mail.to, `${s.alert_email}, dev@example.com`);
    assert.match(mail.subject, /^Incident mode is on for Shop \d+$/);
    assert.match(mail.text, /Broken since then: Add to cart works/);
    assert.match(mail.text, /Theme changed: Dawn → Dawn \(copy\) by unknown/);
    assert.match(mail.text, /1\. Change your password and sign out everywhere/);
    assert.match(mail.text, /every 10 minutes/);
    note(t, mail.text);
  });

  it('no healthy check yet: says so plainly', () => {
    const s = newStore();
    seedRun(s, { verdict: 'critical', theme: 'Dawn', checks: [check('fn.atc', 'Add to cart works', 'fail')] });
    const c = I.changesSinceHealthy(s.id);
    assert.equal(c.healthy, null);
    assert.match(c.note, /no healthy check on record yet/);
  });

  it('while it is on, every alert also goes to the team; after it ends, only to the owner', async () => {
    const s = newStore();
    const logs = [];
    const orig = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    try {
      I.startIncident(s, { contacts: 'dev@example.com, partner@example.com' });
      await handleAlerts(s.id, 1, { checks: [check('fn.atc', 'Add to cart works', 'fail')] });
      I.endIncident(s.id);
      await handleAlerts(s.id, 2, { checks: [check('fn.atc', 'Add to cart works', 'pass')] });
    } finally { console.log = orig; }
    const mails = logs.filter((l) => l.startsWith('[mail skipped]'));
    assert.equal(mails.length, 2);
    assert.match(mails[0], new RegExp(`to=${s.alert_email}, dev@example.com, partner@example.com subject=Urgent: Check failed`));
    assert.match(mails[1], new RegExp(`to=${s.alert_email} subject=Fixed on`));
  });
});

describe('Incident mode: in the product', () => {
  let product, owner, storeId, browser;
  const url = () => `/api/stores/${storeId}/incident`;
  before(async () => {
    product = await startProduct();
    owner = await signup(product);
    storeId = await addStore(product, owner, { runNow: false });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  });
  after(async () => { await browser?.close(); await product?.stop(); });

  async function open(hash, viewport = { width: 1280, height: 1100 }) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addCookies(owner.browserCookies());
    const page = await ctx.newPage();
    await page.goto(`${product.base}/app#${hash}`);
    return page;
  }

  it('off: the page explains it and shows the recovery steps', async (t) => {
    await runAndWait(owner, storeId, { kind: 'journeys' });
    const r = await owner.get(url());
    assert.equal(r.status, 200);
    assert.equal(r.json.active, null);
    assert.equal(r.json.steps.length, 9);
    const page = await open(`/s/${storeId}/incident`);
    await page.locator('#inc-form').waitFor({ timeout: 20000 });
    assert.match(await page.locator('.lede-sm').innerText(), /every 10 minutes/);
    await screenshot(t, page, 'incident mode, before starting');
    await page.context().close();
  });

  it('bad input and paused stores are refused in plain words', async () => {
    let r = await owner.post(url(), { contacts: 'dev@example' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not an email address/);
    r = await owner.patch(url(), { steps: { password: true } });
    assert.equal(r.status, 404);
    r = await owner.post(`${url()}/end`, {});
    assert.equal(r.status, 404);
    await owner.patch(`/api/stores/${storeId}`, { monitoring: false });
    r = await owner.post(url(), {});
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Monitoring is paused/);
    await owner.patch(`/api/stores/${storeId}`, { monitoring: true });
    assert.equal((await owner.get(url())).json.active, null, 'nothing started');
  });

  it('start from the page: full check at once, email to owner and team, checks every 10 minutes', async (t) => {
    const mark = product.log().length;
    const page = await open(`/s/${storeId}/incident`);
    await page.locator('#inc-reason').fill('Strange app installed overnight');
    await page.locator('#inc-team').fill('dev@agency.test, Partner@Shop.test');
    await page.locator('#inc-go').click();
    await page.locator('.inc-on').waitFor({ timeout: 20000 });
    const r = await owner.get(url());
    assert.equal(r.json.active.reason, 'Strange app installed overnight');
    assert.deepEqual(r.json.active.contacts, ['dev@agency.test', 'partner@shop.test']);
    const first = r.json.active.runs.at(-1);
    assert.ok(first, 'a check started');
    const runRow = (await owner.get(`/api/runs/${first.id}`)).json;
    assert.equal(runRow.kind, 'full');
    assert.equal(runRow.trigger, 'incident');
    await new Promise((res) => setTimeout(res, 300));
    const log = product.log().slice(mark);
    assert.match(log, new RegExp(`\\[mail skipped\\] to=${owner.email}, dev@agency.test, partner@shop.test subject=Incident mode is on for Mock Store`));
    assert.match(log, /Since the last healthy check/);
    const st = (await owner.get(`/api/stores/${storeId}`)).json.store;
    assert.equal(st.config.journeyIntervalMin, 10);
    assert.equal(st.config.incident, true);
    assert.ok(st.incident.endsAt);
    assert.equal((await owner.post(url(), {})).status, 409, 'already on');
    assert.equal(await page.locator('a.rail-item[aria-current="page"] .badge').innerText(), 'On');
    note(t, log.split('\n').filter((l) => /mail skipped/.test(l)).join('\n'));
    await page.context().close();
  });

  it('recovery steps are ticked on the page and saved; the team can be changed', async (t) => {
    const page = await open(`/s/${storeId}/incident`);
    await page.locator('.inc-on').waitFor({ timeout: 20000 });
    for (const key of ['password', 'two_step', 'staff']) {
      await page.locator(`[data-step="${key}"] .sc-tick`).click();
      await page.locator(`[data-step="${key}"].sc-done`).waitFor();
    }
    let r = await owner.get(url());
    assert.deepEqual(r.json.active.steps.filter((x) => x.doneAt).map((x) => x.key), ['password', 'two_step', 'staff']);
    r = await owner.patch(url(), { contacts: ['dev@agency.test'] });
    assert.deepEqual(r.json.active.contacts, ['dev@agency.test']);
    await page.reload();
    await page.locator('.inc-on').waitFor({ timeout: 20000 });
    assert.match(await page.locator('.inc-on .figures').innerText(), /3 of 9/);
    await screenshot(t, page, 'incident mode on: changes, checklist, team');
    const phone = await open(`/s/${storeId}/incident`, { width: 390, height: 844 });
    await phone.locator('.inc-on').waitFor({ timeout: 20000 });
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no sideways scrolling on a phone');
    await screenshot(t, phone, 'incident mode on a phone');
    await phone.context().close();
    await page.context().close();
  });

  it('other pages show the incident banner', async (t) => {
    const page = await open(`/s/${storeId}/alerts`);
    const banner = page.locator('.notice.incident-n');
    await banner.waitFor({ timeout: 20000 });
    assert.match(await banner.innerText(), /Incident mode is on/);
    await screenshot(t, page, 'incident banner on the alerts page');
    await page.context().close();
  });

  it("other accounts can't see, change or end someone else's incident", async () => {
    const other = await signup(product);
    assert.equal((await other.get(url())).status, 404);
    assert.equal((await other.patch(url(), { steps: { apps: true } })).status, 404);
    assert.equal((await other.post(`${url()}/end`, {})).status, 404);
    assert.ok((await owner.get(url())).json.active, 'still on');
  });

  it('end: summary email to owner and team, schedule back to normal, listed as an earlier incident', async () => {
    // Let the incident's full check finish first so the store is quiet.
    const until = Date.now() + 240000;
    while (Date.now() < until && (await owner.get(`/api/stores/${storeId}`)).json.store.active_run_id) await new Promise((res) => setTimeout(res, 1000));
    const mark = product.log().length;
    const r = await owner.post(`${url()}/end`, {});
    assert.equal(r.status, 200);
    assert.equal(r.json.active, null);
    assert.equal(r.json.history.length, 1);
    assert.equal(r.json.history[0].stepsDone, 3);
    await new Promise((res) => setTimeout(res, 300));
    const log = product.log().slice(mark);
    assert.match(log, new RegExp(`to=${owner.email}, dev@agency.test subject=Incident mode ended for Mock Store`));
    assert.match(log, /was ended by the store owner/);
    assert.match(log, /3 of 9 recovery steps/);
    const st = (await owner.get(`/api/stores/${storeId}`)).json.store;
    assert.notEqual(st.config.journeyIntervalMin, 10);
    assert.equal(st.incident, null);
  });

  it('starting again within a week is refused, with the date it is possible again', async (t) => {
    const mark = product.log().length;
    const r = await owner.post(url(), { contacts: 'someone@else.test', reason: 'again' });
    assert.equal(r.status, 429);
    assert.match(r.json.error, /once a week per store\. You can start it again on/);
    await new Promise((res) => setTimeout(res, 300));
    assert.doesNotMatch(product.log().slice(mark), /\[mail skipped\]/, 'no email sent');
    assert.equal((await owner.get(url())).json.active, null);
    const page = await open(`/s/${storeId}/incident`);
    await page.locator('#inc-wait').waitFor({ timeout: 20000 });
    assert.equal(await page.locator('#inc-go').isDisabled(), true);
    await screenshot(t, page, 'incident mode, used this week');
    await page.context().close();
  });
});
