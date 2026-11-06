// Security watch S11: owner-ticked security checklist with a score and monthly reminders.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, shopifyOpen } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-checklist-'));
const { q } = await import('../src/db.js');
const C = await import('../src/security-checklist.js');

const DAY = 24 * 3600 * 1000;
let n = 0;
function newStore({ monitoring = 1 } = {}) {
  const u = Number(q.insertUser.run(`owner${++n}@checklist.test`, 'x', 'Owner').lastInsertRowid);
  return q.storeById.get(Number(q.insertStore.run(u, `https://shop${n}.example.com`, `Shop ${n}`, null, `alerts${n}@checklist.test`, null, '{}', 'Shopify', monitoring).lastInsertRowid));
}

describe('Security checklist: the rules', () => {
  it('seven items worth 100 points; a new store starts at 0 with everything to do', (t) => {
    assert.equal(C.ITEMS.length, 7);
    assert.equal(C.ITEMS.reduce((a, i) => a + i.weight, 0), 100);
    const c = C.checklist(newStore());
    assert.equal(c.score, 0);
    assert.equal(c.grade, 'Needs work');
    assert.deepEqual(c.counts, { done: 0, todo: 7, due: 0, total: 7 });
    assert.equal(c.reminders, true, 'reminders are on by default');
    note(t, c.items.map((i) => `${i.weight} pts, every ${i.every} days: ${i.title}`).join('\n'));
  });

  it('ticking raises the score and unticking lowers it; unknown items are refused', () => {
    const s = newStore();
    assert.equal(C.tick(s.id, 'two_step', true), true);
    assert.equal(C.tick(s.id, 'app_review', true), true);
    assert.equal(C.checklist(s).score, 40);
    C.tick(s.id, 'app_review', false);
    assert.equal(C.checklist(s).score, 25);
    assert.equal(C.tick(s.id, 'drop table', true), false);
    for (const i of C.ITEMS) C.tick(s.id, i.key, true);
    const c = C.checklist(s);
    assert.equal(c.score, 100);
    assert.equal(c.grade, 'Well protected');
  });

  it('reviews come due again: staff and apps after 90 days, two-step after 180, the rest after a year', () => {
    const s = newStore();
    const t0 = Date.now();
    for (const i of C.ITEMS) C.tick(s.id, i.key, true, t0);
    const at = (days) => C.checklist(s, { now: t0 + days * DAY });
    assert.equal(at(89).score, 100);
    const d91 = at(91);
    assert.deepEqual(d91.items.filter((i) => i.state === 'due').map((i) => i.key), ['staff_review', 'app_review']);
    assert.equal(d91.score, 70);
    assert.equal(d91.grade, 'Good start');
    assert.deepEqual(at(181).items.filter((i) => i.state === 'due').map((i) => i.key), ['two_step', 'staff_review', 'app_review']);
    assert.equal(at(366).score, 0);
    // Ticking again after the review restarts the clock.
    C.tick(s.id, 'staff_review', true, t0 + 91 * DAY);
    assert.equal(C.checklist(s, { now: t0 + 92 * DAY }).items.find((i) => i.key === 'staff_review').state, 'done');
  });

  it('Shopify stores get Shopify admin steps; other stores get general steps', () => {
    const s = newStore();
    const shop = C.checklist(s, { shopify: true }).items.find((i) => i.key === 'collaborators');
    const other = C.checklist(s, { shopify: false }).items.find((i) => i.key === 'collaborators');
    assert.match(shop.how, /Settings → Users → Security → Collaborators/);
    assert.doesNotMatch(other.how, /Shopify/);
  });
});

describe('Security checklist: reminders', () => {
  it('no reminder in the first days, then one listing what is open with the steps', (t) => {
    const s = newStore();
    const now = Date.now();
    assert.equal(C.reminderFor(s, { now: now + 1 * DAY }), null, 'a new store gets a few days first');
    const m = C.reminderFor(s, { now: now + 4 * DAY, shopify: true });
    assert.equal(m.to, s.alert_email);
    assert.equal(m.subject, `Security checklist for ${s.name}: 0 of 100`);
    assert.match(m.text, /7 things are waiting/);
    assert.match(m.text, /To do: Two-step login is on for you and every staff account\n   In Shopify admin open Settings → Users → Security/);
    assert.match(m.text, /\/app#\/s\/\d+\/security/);
    assert.match(m.text, /at most once a month/);
    note(t, `${m.subject}\n\n${m.text}`);
  });

  it('sends once per store, records it, and waits 30 days before the next', async () => {
    const s = newStore();
    const start = Date.now() + 5 * DAY;
    const sent = [];
    const send = async (m) => { sent.push(m); };
    await C.sendChecklistReminders({ now: start, send });
    const mine = () => sent.filter((m) => m.to === s.alert_email);
    assert.equal(mine().length, 1);
    await C.sendChecklistReminders({ now: start + 1 * DAY, send });
    await C.sendChecklistReminders({ now: start + 29 * DAY, send });
    assert.equal(mine().length, 1, 'not again within 30 days');
    await C.sendChecklistReminders({ now: start + 31 * DAY, send });
    assert.equal(mine().length, 2);
  });

  it('a failing mail server never causes repeats', async () => {
    const s = newStore();
    const start = Date.now() + 5 * DAY;
    let tries = 0;
    const send = async (m) => { if (m.to === s.alert_email) { tries++; throw new Error('smtp down'); } };
    await C.sendChecklistReminders({ now: start, send });
    await C.sendChecklistReminders({ now: start + DAY, send });
    assert.equal(tries, 1);
  });

  it('nothing when everything is done, reminders are off, or monitoring is paused', () => {
    const later = Date.now() + 5 * DAY;
    const all = newStore();
    for (const i of C.ITEMS) C.tick(all.id, i.key, true);
    assert.equal(C.reminderFor(all, { now: later }), null);
    const off = newStore();
    C.setReminders(off.id, false);
    assert.equal(C.reminderFor(off, { now: later }), null);
    assert.equal(C.reminderFor(newStore({ monitoring: 0 }), { now: later }), null);
  });

  it('a review that came due again is named "Review again"', () => {
    const s = newStore();
    const t0 = Date.now();
    for (const i of C.ITEMS) C.tick(s.id, i.key, true, t0);
    const m = C.reminderFor(s, { now: t0 + 95 * DAY });
    assert.match(m.text, /2 things are waiting/);
    assert.match(m.text, /Review again: Staff accounts reviewed/);
    assert.match(m.text, /Review again: Installed apps reviewed/);
  });
});

describe('Security checklist: in the product', () => {
  let product, owner, storeId, shop;
  before(async () => {
    product = await startProduct();
    owner = await signup(product);
    storeId = await addStore(product, owner, { runNow: false });
    shop = await shopifyOpen(product);
  });
  after(async () => { await product?.stop(); });

  it('owner reads, ticks and unticks items, and switches reminders off and on', async (t) => {
    const url = `/api/stores/${storeId}/security-checklist`;
    let r = await owner.get(url);
    assert.equal(r.status, 200);
    assert.equal(r.json.score, 0);
    assert.doesNotMatch(r.json.items[0].how, /Shopify admin/, 'mock store is not a Shopify install');
    r = await owner.post(`${url}/two_step`, { done: true });
    assert.equal(r.json.score, 25);
    assert.equal(r.json.items[0].state, 'done');
    assert.ok(r.json.items[0].dueAt > r.json.items[0].doneAt);
    r = await owner.post(`${url}/two_step`, { done: false });
    assert.equal(r.json.score, 0);
    r = await owner.patch(url, { reminders: false });
    assert.equal(r.json.reminders, false);
    r = await owner.patch(url, { reminders: true });
    assert.equal(r.json.reminders, true);
    note(t, 'tick → 25, untick → 0, reminders off → on');
  });

  it('bad requests are refused in plain words', async () => {
    const url = `/api/stores/${storeId}/security-checklist`;
    let r = await owner.post(`${url}/not_an_item`, { done: true });
    assert.equal(r.status, 404);
    r = await owner.post(`${url}/two_step`, { done: 'yes' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /done/);
    r = await owner.patch(url, {});
    assert.equal(r.status, 400);
  });

  it("other accounts can't read or tick someone else's checklist", async () => {
    const other = await signup(product);
    assert.equal((await other.get(`/api/stores/${storeId}/security-checklist`)).status, 404);
    assert.equal((await other.post(`/api/stores/${storeId}/security-checklist/two_step`, { done: true })).status, 404);
    assert.equal((await owner.get(`/api/stores/${storeId}/security-checklist`)).json.score, 0, 'nothing changed');
    assert.equal((await product.session().get(`/api/stores/${storeId}/security-checklist`)).status, 401);
  });

  it('a Shopify store gets Shopify admin steps, and the checklist is in the Shopify admin menu', async () => {
    const r = await shop.get(`/api/stores/${shop.storeId}/security-checklist`);
    assert.equal(r.status, 200);
    assert.match(r.json.items[0].how, /In Shopify admin open Settings → Users → Security/);
    const html = await (await fetch(`${product.base}/shopify/security`)).text();
    assert.match(html, /<a href="\/shopify\/security">Security checklist<\/a>/);
  });

  it('the checklist page: tick in the browser, score and grade update (desktop and phone)', async (t) => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 1420 } });
      await ctx.addCookies(owner.browserCookies());
      const page = await ctx.newPage();
      await page.goto(`${product.base}/app#/s/${storeId}/security`);
      await page.locator('.sc-list').waitFor({ timeout: 20000 });
      assert.equal(await page.locator('a.rail-item[aria-current="page"]').innerText(), 'Security checklist');
      assert.equal(await page.locator('.sc-summary .dial b').innerText(), '0');
      for (const key of ['two_step', 'email_2fa', 'passwords', 'collaborators']) {
        await page.locator(`[data-item="${key}"] .sc-tick`).click();
        await page.locator(`[data-item="${key}"].sc-done`).waitFor();
      }
      assert.equal(await page.locator('.sc-summary .dial b').innerText(), '60');
      assert.equal(await page.locator('.sc-summary h2').innerText(), 'Good start');
      assert.match(await page.locator('[data-item="two_step"] .sc-meta').innerText(), /review again by/);
      assert.equal((await owner.get(`/api/stores/${storeId}/security-checklist`)).json.score, 60, 'saved on the server');
      await screenshot(t, page, 'security checklist, 4 of 7 done');
      await page.locator('#sc-remind').evaluate((el) => el.click());
      await page.waitForFunction(async (u) => (await (await fetch(u)).json()).reminders === false, `/api/stores/${storeId}/security-checklist`);
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true });
      await phone.addCookies(owner.browserCookies());
      const p2 = await phone.newPage();
      await p2.goto(`${product.base}/app#/s/${storeId}/security`);
      await p2.locator('.sc-list').waitFor({ timeout: 20000 });
      assert.equal(await p2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no sideways scrolling on a phone');
      await screenshot(t, p2, 'security checklist on a phone');
    } finally { await browser.close(); }
  });
});
