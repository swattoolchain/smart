// Incident mode: "Close your store to shoppers now" (Shopify's own password page).
// Tharam shows a link, a ready message and a reminder, then checks every few minutes that shoppers see the password page.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, startMock, signup, addStore } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-closed-'));
process.env.FEATURES_DEFAULT = 'on';
process.env.ALLOW_LOCAL_TARGETS = '1';
const { q } = await import('../src/db.js');
const I = await import('../src/incident.js');
const C = await import('../src/store-closed.js');

let n = 0;
const newStore = (url) => {
  const u = Number(q.insertUser.run(`owner${++n}@closed.test`, 'x', 'Owner').lastInsertRowid);
  return q.storeById.get(Number(q.insertStore.run(u, url, `Shop ${n}`, null, `owner${n}@closed.test`, null, '{}', 'Shopify', 1).lastInsertRowid));
};

describe('Close your store: the rules', () => {
  it('links to Shopify admin password protection and gives the ready message', () => {
    const s = newStore('https://shop-a.example.com');
    const withShop = C.closeStoreInfo(s, { shopify: true, shop: 'shop-a.myshopify.com' });
    assert.equal(withShop.adminUrl, 'https://admin.shopify.com/store/shop-a/online_store/preferences');
    assert.equal(withShop.message, "We're preparing something special for you. Back very soon.");
    assert.match(withShop.steps.join(' '), /Password protection/);
    assert.match(withShop.steps.at(-1), /untick/);
    assert.match(withShop.reminder, /switch the password page off/);
    assert.equal(C.closeStoreInfo(s, { shopify: true }).adminUrl, 'https://shop-a.example.com/admin/online_store/preferences');
  });

  it('knows the password page from a normal page', () => {
    assert.equal(C.looksLikePasswordPage({ path: '/password', body: '' }), true);
    assert.equal(C.looksLikePasswordPage({ path: '/', body: '<form action="/password" method="post"></form>' }), true);
    assert.equal(C.looksLikePasswordPage({ path: '/', body: '<h1>Our shop</h1><a href="/cart">Cart</a>' }), false);
  });
});

describe('Close your store: the storefront check', () => {
  let open, closed;
  before(async () => { open = await startMock({}); closed = await startMock({ breaks: 'password' }); });
  after(async () => { open?.stop(); closed?.stop(); });

  it('a password-protected storefront is closed, a normal one is open', async (t) => {
    assert.equal((await C.probeStorefront(closed.origin)).state, 'closed');
    assert.equal((await C.probeStorefront(open.origin)).state, 'open');
    note(t, 'mock store with MOCK_BREAK=password: closed. Normal mock store: open.');
  });

  it('an address that does not answer is "unknown", never closed', async () => {
    assert.equal((await C.probeStorefront('http://localhost:9')).state, 'unknown');
  });

  it('while incident mode is on the scheduler check saves what it sees, and notices when the store closes', async (t) => {
    const s = newStore(open.origin);
    I.startIncident(s, {});
    await C.dueClosedChecks();
    assert.deepEqual({ ...C.closedView(s.id), checkedAt: null }, { on: true, state: 'open', checkedAt: null, since: null });
    // The owner switches the password page on: a store that now answers with it (same incident, next check).
    const row = (await import('../src/db.js')).db.prepare('SELECT * FROM incidents WHERE store_id = ?').get(s.id);
    const r = await C.checkClosed(row, { ...s, url: closed.origin });
    assert.equal(r.state, 'closed');
    const v = C.closedView(s.id);
    assert.equal(v.state, 'closed');
    assert.ok(v.since, 'knows since when');
    note(t, `open at first, then closed since ${v.since}`);
    // Not checked again before the interval has passed.
    const before = C.closedView(s.id).checkedAt;
    await C.dueClosedChecks();
    assert.equal(C.closedView(s.id).checkedAt, before);
    // Ended incidents are left alone.
    I.endIncident(s.id);
    assert.equal(C.closedView(s.id).on, false);
  });
});

describe('Close your store: in the product', () => {
  let product, owner, storeId, browser;
  const url = () => `/api/stores/${storeId}/incident`;
  before(async () => {
    product = await startProduct({ env: { ALLOW_LOCAL_TARGETS: '1' } });
    owner = await signup(product);
    storeId = await addStore(product, owner, { runNow: false });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  });
  after(async () => { await browser?.close(); await product?.stop(); });
  const open = async (hash) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1300 } });
    await ctx.addCookies(owner.browserCookies());
    const page = await ctx.newPage();
    await page.goto(`${product.base}/app#${hash}`);
    return page;
  };

  it('before incident mode starts, the page and the recovery packet lead with "Close your store"', async (t) => {
    const d = (await owner.get(url())).json;
    assert.equal(d.closeStore.message, "We're preparing something special for you. Back very soon.");
    assert.match(d.closeStore.adminUrl, /online_store\/preferences$/);
    assert.equal(d.closeStore.on, false);
    const p = (await owner.get(`/api/stores/${storeId}/recovery-packet`)).json;
    assert.equal(p.closeStore.adminUrl, d.closeStore.adminUrl);
    const page = await open(`/s/${storeId}/incident`);
    await page.locator('#cs-panel').waitFor({ timeout: 20000 });
    assert.match(await page.locator('#cs-panel h2').innerText(), /Close your store to shoppers now/);
    assert.equal(await page.locator('#cs-open').getAttribute('href'), d.closeStore.adminUrl);
    assert.equal(await page.locator('#cs-msg').inputValue(), d.closeStore.message);
    await page.locator('#rp-close').waitFor({ timeout: 20000 });
    assert.match(await page.locator('.rp-close h3').innerText(), /1\. Close your store/);
    await screenshot(t, page, 'incident page: close your store first, then the packet');
    await page.context().close();
  });

  it('with incident mode on, "Check now" says what shoppers see', async (t) => {
    let r = await owner.post(url(), { reason: 'Hack confirmed' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.closeStore.on, true);
    const page = await open(`/s/${storeId}/incident`);
    await page.locator('#cs-check').waitFor({ timeout: 20000 });
    await page.locator('#cs-check').click();
    await page.locator('#cs-state').waitFor({ timeout: 20000 });
    await page.waitForFunction(() => /still open to shoppers/.test(document.querySelector('#cs-state')?.innerText || ''), null, { timeout: 20000 });
    assert.equal((await owner.get(url())).json.closeStore.state, 'open');
    await screenshot(t, page, 'incident on: store still open to shoppers');
    await page.context().close();
    r = await owner.post(`${url()}/closed-check`, {});
    assert.equal(r.status, 429, 'checking again straight away is slowed down');
    assert.match(r.json.error, /wait a few seconds/);
  });

  it("other accounts and signed-out visitors can't run the check", async () => {
    const other = await signup(product);
    assert.equal((await other.post(`${url()}/closed-check`, {})).status, 404);
    const anon = await fetch(`${product.base}${url()}/closed-check`, { method: 'POST' });
    assert.equal(anon.status, 401);
  });
});
