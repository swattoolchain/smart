// Security watch S17: recovery packet — one tap to reset the Shopify password, and a ready-to-send message
// to Shopify Support with what changed and when.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, shopifyOpen, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-packet-'));
const { db, q } = await import('../src/db.js');
const I = await import('../src/incident.js');
const { recoveryPacket, SHOPIFY_HELP } = await import('../src/recovery-packet.js');

let n = 0;
function newStore() {
  const u = Number(q.insertUser.run(`owner${++n}@packet.test`, 'x', 'Owner').lastInsertRowid);
  return q.storeById.get(Number(q.insertStore.run(u, `https://shop${n}.example.com`, `Shop ${n}`, null, null, null, '{}', 'Shopify', 1).lastInsertRowid));
}
const check = (id, title, status) => ({ id, category: 'functional', title, status, severity: 'critical', detail: `${title}: ${status}` });
function seedRun(store, { verdict, checks, theme, at }) {
  const id = Number(q.insertRun.run(store.id, store.url, 'journeys', null, 'schedule').lastInsertRowid);
  q.finishRun.run(verdict === 'healthy' ? 100 : 40, verdict, JSON.stringify({ kind: 'journeys', checks, theme: { name: theme }, categories: [], summary: '' }), id);
  db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(at, id);
  return id;
}

describe('Recovery packet: the message', () => {
  it('says what changed and when, oldest first, with what the owner already did', (t) => {
    const s = newStore();
    seedRun(s, { verdict: 'healthy', theme: 'Dawn', checks: [check('fn.atc', 'Add to cart works', 'pass')], at: '2026-11-04 08:00:00' });
    q.insertAlert.run(s.id, 'fn.atc', 'failing', "Customers can't add products to the cart.", 'Add to cart works');
    db.prepare("UPDATE alerts SET created_at = '2026-11-04 09:30:00' WHERE store_id = ?").run(s.id);
    seedRun(s, { verdict: 'critical', theme: 'Dawn (copy)', checks: [check('fn.atc', 'Add to cart works', 'fail')], at: '2026-11-04 09:30:00' });
    I.startIncident(s, { reason: 'Prices changed by themselves' });
    I.updateIncident(s.id, { steps: { password: true, staff: true } });
    const p = recoveryPacket(s, { shopify: true });
    assert.equal(p.message.subject, `Possible unauthorized access to shop${n}.example.com`);
    const text = p.message.text;
    assert.match(text, /^Hello Shopify Support,/);
    assert.match(text, /Account email: owner\d+@packet.test/);
    const i1 = text.indexOf('2026-11-04 08:00 UTC: Last check where everything worked');
    const i2 = text.indexOf("2026-11-04 09:30 UTC: Alert: Add to cart works. Customers can't add products to the cart.");
    const i3 = text.indexOf('I switched on incident mode: Prices changed by themselves');
    assert.ok(i1 > 0 && i2 > i1 && i3 > i2, 'timeline oldest first');
    assert.match(text, /- Add to cart works: Add to cart works: fail/);
    assert.match(text, /The published theme changed from "Dawn" to "Dawn \(copy\)"/);
    assert.match(text, /What I have done so far:\n- Change your password and sign out everywhere\n- Remove staff and collaborators you don't recognise/);
    assert.equal(p.reset.url, `https://shop${n}.example.com/admin`);
    assert.equal(p.reset.help, SHOPIFY_HELP.resetPassword);
    assert.equal(p.support.url, SHOPIFY_HELP.support);
    note(t, `${p.message.subject}\n\n${text}`);
  });

  it('no history yet: still a useful message, said plainly', () => {
    const s = newStore();
    const p = recoveryPacket(s, { shopify: true });
    assert.match(p.message.text, /I have no monitoring history before this happened/);
    assert.match(p.message.text, /no healthy check on record yet/);
    assert.match(p.message.text, /Nothing yet: I am contacting you first/);
  });

  it('stores not on Shopify get general wording and no Shopify links', () => {
    const s = newStore();
    const p = recoveryPacket(s, { shopify: false });
    assert.match(p.message.text, /^Hello Support team,/);
    assert.equal(p.support, null);
    assert.equal(p.reset.help, null);
    assert.doesNotMatch(p.reset.steps.join(' '), /Shopify/);
  });
});

describe('Recovery packet: in the product', () => {
  let product, owner, storeId, shop;
  before(async () => {
    product = await startProduct();
    owner = await signup(product);
    storeId = await addStore(product, owner, { runNow: false });
    shop = await shopifyOpen(product, 'packet-shop.myshopify.com');
  });
  after(async () => { await product?.stop(); });

  it('the packet and its download are the owner\'s only', async () => {
    await runAndWait(owner, storeId, { kind: 'journeys' });
    const r = await owner.get(`/api/stores/${storeId}/recovery-packet`);
    assert.equal(r.status, 200);
    assert.match(r.json.message.text, /Last check where everything worked|Latest check/);
    const d = await owner.get(`/api/stores/${storeId}/recovery-packet.txt`);
    assert.equal(d.status, 200);
    assert.match(d.headers.get('content-type'), /text\/plain/);
    assert.match(d.headers.get('content-disposition'), /attachment; filename="recovery-localhost-\d+\.txt"/);
    assert.match(d.text, /^Subject: Possible unauthorized access to localhost:\d+\n\nHello/);
    const other = await signup(product);
    assert.equal((await other.get(`/api/stores/${storeId}/recovery-packet`)).status, 404);
    assert.equal((await other.get(`/api/stores/${storeId}/recovery-packet.txt`)).status, 404);
    assert.equal((await product.session().get(`/api/stores/${storeId}/recovery-packet`)).status, 401);
  });

  it('Shopify install: reset link goes to the shop\'s own admin sign-in', async () => {
    const r = await shop.get(`/api/stores/${shop.storeId}/recovery-packet`);
    assert.equal(r.status, 200);
    assert.equal(r.json.reset.url, 'https://packet-shop.myshopify.com/admin');
    assert.match(r.json.message.text, /\(packet-shop.myshopify.com\)|packet-shop.myshopify.com/);
    assert.equal(r.json.support.url, SHOPIFY_HELP.support);
  });

  it('on the incident page: reset button, message, copy and download', async (t) => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 1300 } });
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: product.base });
      await ctx.addCookies(owner.browserCookies());
      const page = await ctx.newPage();
      await page.goto(`${product.base}/app#/s/${storeId}/incident`);
      const box = page.locator('#inc-packet');
      await box.locator('#rp-text').waitFor({ timeout: 20000 });
      assert.match(await page.locator('#rp-reset').getAttribute('href'), /^https:\/\/localhost:\d+\/admin$/);
      assert.equal(await page.locator('#rp-reset').getAttribute('target'), '_blank');
      assert.match(await page.locator('#rp-text').inputValue(), /What happened and when \(times in UTC\):/);
      await page.locator('#rp-copy').click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      assert.match(copied, /^Subject: Possible unauthorized access to localhost:\d+\n\nHello/);
      // Download is built in the page from the loaded packet (no plain link to a signed-in route), so it also works
      // inside Shopify admin, where the embedded app has no cookie and a link would carry no session token.
      assert.equal(await page.locator('#rp-download').getAttribute('href'), null);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#rp-download').click()]);
      assert.match(dl.suggestedFilename(), /^recovery-localhost-\d+\.txt$/);
      const saved = fs.readFileSync(await dl.path(), 'utf8');
      assert.equal(saved, `${copied}\n`, 'the file holds the same message as the copy button');
      await box.scrollIntoViewIfNeeded();
      await screenshot(t, page, 'recovery packet on the incident page');
      note(t, copied);
    } finally { await browser.close(); }
  });
});
