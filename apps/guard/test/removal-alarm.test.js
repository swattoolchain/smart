// S16 removal alarm: when Tharam is removed from a Shopify store, the owner is emailed straight away
// (confirmed browser-access email and alert email), once, and reinstalling still works.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { startProduct, shopifyOpen, lastMailLink, shopifyHmac } from './lib/harness.js';
import { note } from './lib/evidence.js';

const SUBJECT = /\[mail skipped\] to=([^\n]*) subject=Tharam was removed from ([^\n]*)/g;
const alarms = (P) => [...P.log().matchAll(SUBJECT)].map((m) => ({ to: m[1], store: m[2] }));
const wait = async (fn, ms = 5000) => { const until = Date.now() + ms; while (!fn() && Date.now() < until) await new Promise((r) => setTimeout(r, 100)); return fn(); };

describe('Removal alarm', () => {
  let P;
  before(async () => { P = await startProduct(); });
  after(async () => { await P?.stop(); });

  const webhook = (topic, shop, body = {}) => {
    const raw = JSON.stringify(body);
    return fetch(`${P.base}/shopify/webhooks`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-hmac-sha256': shopifyHmac(raw) } });
  };
  async function confirmBrowserEmail(s, email) {
    assert.equal((await s.post('/api/account/web-access', { email })).status, 200);
    const tok = lastMailLink(P).split('#/signin/')[1];
    assert.equal((await P.session().post('/api/auth/link/verify', { token: tok })).status, 200);
  }

  it('the uninstall webhook sends one email to the browser-access and alert emails', async (t) => {
    const shop = 'alarm.myshopify.com';
    const s = await shopifyOpen(P, shop);
    await confirmBrowserEmail(s, 'owner@alarm.test');
    const before = alarms(P).length;
    assert.equal((await webhook('app/uninstalled', shop, { domain: shop })).status, 200);
    assert.ok(await wait(() => alarms(P).length > before), 'alarm sent');
    const mine = alarms(P).slice(before);
    assert.equal(mine.length, 1, 'exactly one email');
    // The alert email comes from the shop's contact email at install (fake Shopify: hello@testshop.example).
    assert.deepEqual(mine[0].to.split(', ').sort(), ['hello@testshop.example', 'owner@alarm.test']);
    assert.equal(mine[0].store, 'Test Shop');
    const log = P.log();
    const body = log.slice(log.lastIndexOf('subject=Tharam was removed from'));
    assert.match(body, /Tharam was removed from your store Test Shop \(alarm\.myshopify\.com\)/);
    assert.match(body, /If this wasn't you, your admin may be compromised\./);
    assert.match(body, /change your password/);
    assert.match(body, /https:\/\/admin\.shopify\.com\/store\/alarm/);
    assert.ok(P.db().prepare("SELECT 1 FROM audit WHERE action = 'note' AND detail_json LIKE '%Removal alarm emailed%'").get(), 'recorded in the history');
    // Checks stop, as before.
    assert.equal(P.db().prepare('SELECT monitoring FROM stores WHERE id = ?').get(s.storeId).monitoring, 0);
    note(t, `One email to ${mine[0].to}: "${body.split('\n').slice(1, 4).join(' ').trim()}"`);
  });

  it('a repeated uninstall webhook does not send a second email', async () => {
    const before = alarms(P).length;
    assert.equal((await webhook('app/uninstalled', 'alarm.myshopify.com')).status, 200);
    assert.equal((await webhook('app/uninstalled', 'alarm.myshopify.com')).status, 200);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(alarms(P).length, before);
  });

  it('reinstalling within minutes still works, and a later removal alarms again', async (t) => {
    const s = await shopifyOpen(P, 'alarm.myshopify.com');
    const st = (await s.get('/api/stores')).json.stores;
    assert.equal(st.length, 1, 'same single store');
    assert.equal(st[0].id, s.storeId);
    assert.equal(P.db().prepare('SELECT monitoring FROM stores WHERE id = ?').get(s.storeId).monitoring, 1, 'checks back on');
    assert.ok(['active', 'trial'].includes((await s.get('/api/me')).json.license.state), 'usable plan restored');
    assert.equal((await s.get('/api/account/web-access')).json.email, 'owner@alarm.test', 'browser email kept');
    const before = alarms(P).length;
    await webhook('app/uninstalled', 'alarm.myshopify.com');
    assert.ok(await wait(() => alarms(P).length === before + 1));
    note(t, 'Reinstall: same store, checks on, plan restored, browser email kept; next removal alarmed again');
  });

  it('an unconfirmed browser email is not used; no email at all when there is no address', async () => {
    const shop = 'pending.myshopify.com';
    const s = await shopifyOpen(P, shop);
    assert.equal((await s.post('/api/account/web-access', { email: 'notyet@pending.test' })).status, 200); // link never opened
    let before = alarms(P).length;
    await webhook('app/uninstalled', shop);
    assert.ok(await wait(() => alarms(P).length > before));
    assert.equal(alarms(P).at(-1).to, 'hello@testshop.example');

    // No alert email and no browser access: nothing to send, nothing breaks.
    const shop2 = 'silent.myshopify.com';
    const s2 = await shopifyOpen(P, shop2);
    // Since #26 an owner can no longer save a non-address, but a store saved earlier can still hold the shop domain
    // (an empty alert email used to fall back to the account's name). That older data is set up directly here.
    const rw = new Database(path.join(P.dataDir, 'guard.db'), { fileMustExist: true });
    try { rw.prepare('UPDATE stores SET alert_email = ? WHERE id = ?').run(shop2, s2.storeId); } finally { rw.close(); }
    assert.equal(P.db().prepare('SELECT alert_email FROM stores WHERE id = ?').get(s2.storeId).alert_email, shop2);
    before = alarms(P).length;
    assert.equal((await webhook('app/uninstalled', shop2)).status, 200);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(alarms(P).length, before);
    assert.equal(P.db().prepare('SELECT monitoring FROM stores WHERE id = ?').get(s2.storeId).monitoring, 0, 'uninstall still handled');
  });

  it('a forged uninstall webhook changes nothing and sends nothing', async () => {
    const shop = 'forged-removal.myshopify.com';
    const s = await shopifyOpen(P, shop);
    const before = alarms(P).length;
    const raw = '{}';
    const r = await fetch(`${P.base}/shopify/webhooks`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-shopify-topic': 'app/uninstalled', 'x-shopify-shop-domain': shop, 'x-shopify-hmac-sha256': shopifyHmac(raw, 'wrong-secret') } });
    assert.equal(r.status, 401);
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(alarms(P).length, before);
    assert.equal(P.db().prepare('SELECT monitoring FROM stores WHERE id = ?').get(s.storeId).monitoring, 1);
  });
});
