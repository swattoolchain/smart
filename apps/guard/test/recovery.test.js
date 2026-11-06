// Recovery console (T40, S14): an optional recovery code, and tharam.store/recover (emailed link + code → read-only session).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, shopifyOpen, shopifyHmac, SHOPIFY, confirmEmail } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const SUBJECT = 'Get back into your Tharam reports';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Recovery console', () => {
  let P, browser;
  before(async () => {
    P = await startProduct({ env: { RECOVER_START_PER_IP: '1000', RECOVER_LINKS_PER_EMAIL: '1000', RECOVER_VERIFY_PER_IP: '1000' } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  // The recovery mails sent so far, newest last: { to, token }.
  const mails = () => P.log().split('[mail skipped] ').filter((b) => new RegExp(`subject=${SUBJECT}`).test(b.split('\n')[0]))
    .map((b) => ({ to: /^to=(.*?) subject=/.exec(b)[1], token: /#\/recover\/([\w-]+)/.exec(b)?.[1] }));
  async function mailAfter(count) { for (let i = 0; i < 40; i++) { if (mails().length > count) return mails().at(-1); await wait(50); } return null; }
  /** Asks for a link and returns its token (or null when no mail was sent). */
  async function ask(email) {
    const before = mails().length;
    const r = await P.session().post('/api/recover/start', { email });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    await wait(150);
    return mails().length > before ? mails().at(-1) : null;
  }
  const writable = () => new Database(path.join(P.dataDir, 'guard.db'));

  it('the owner makes a recovery code: shown once, only a hash is kept, a new one replaces it', async (t) => {
    const s = await signup(P);
    assert.equal((await P.session().get('/api/account/recovery')).status, 401, 'signed-out visitors can not');
    assert.deepEqual((await s.get('/api/account/recovery')).json.hasCode, false);
    const a = await s.post('/api/account/recovery/code');
    assert.equal(a.status, 200);
    assert.match(a.json.code, /^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}$/);
    const state = (await s.get('/api/account/recovery')).json;
    assert.equal(state.hasCode, true);
    assert.ok(!JSON.stringify(state).includes(a.json.code), 'the code is never shown again');
    const row = P.db().prepare('SELECT code_hash FROM recovery_codes').get();
    assert.ok(row && !row.code_hash.includes(a.json.code.replace(/-/g, '')), 'only a hash is stored');
    const b = await s.post('/api/account/recovery/code');
    assert.notEqual(b.json.code, a.json.code);
    assert.equal(b.json.replaced, true);
    assert.equal((await s.del('/api/account/recovery/code')).status, 200);
    assert.equal((await s.get('/api/account/recovery')).json.hasCode, false);
    note(t, 'code format XXXX-XXXX-XXXX-XXXX; hash only in the database; never returned again; new code replaces; removing works; signed-out 401');
  });

  it('the link goes to the account email, never the store alert email, and the answer never reveals who has an account', async (t) => {
    const s = await signup(P, 'owner-a@shop.test');
    await addStore(P, s, { alertEmail: 'attacker@evil.test', runNow: false });
    assert.equal(await ask('owner-a@shop.test'), null, 'no code yet: no mail, same answer');
    await s.post('/api/account/recovery/code');
    assert.equal(await ask('nobody@shop.test'), null, 'unknown email: no mail, same answer');
    assert.equal(await ask('attacker@evil.test'), null, 'a store alert email is not an account email');
    const m = await ask('owner-a@shop.test');
    assert.ok(m?.token, 'a link was sent');
    assert.equal(m.to, 'owner-a@shop.test');
    assert.ok(!P.log().includes('to=attacker@evil.test'));
    assert.match((await P.session().get('/recover')).headers.get('location') || '', /\/app#\/recover$/, '/recover opens the recovery page');
    note(t, 'no code, unknown email, alert email → no mail but the same {ok:true}; real account → one mail to the account email only');
  });

  it('the link alone is not enough: the code is needed too, and the session is read-only', async (t) => {
    const owner = await signup(P, 'owner-b@shop.test');
    const storeId = await addStore(P, owner, { alertEmail: 'owner-b@shop.test', runNow: false });
    const other = await signup(P, 'other-b@shop.test');
    const otherStore = await addStore(P, other, { runNow: false });
    const { code } = (await owner.post('/api/account/recovery/code')).json;
    const m = await ask('owner-b@shop.test');

    const r = P.session();
    assert.equal((await r.post('/api/recover/verify', { token: m.token })).status, 401, 'no code');
    const wrong = await r.post('/api/recover/verify', { token: m.token, code: 'AAAA-AAAA-AAAA-AAAA' });
    assert.equal(wrong.status, 401);
    assert.match(wrong.json.error, /3 tries left/);
    assert.equal((await r.post('/api/recover/verify', { token: 'x'.repeat(43), code })).status, 400, 'unknown link');
    assert.equal((await r.get('/api/stores')).status, 401, 'nothing opened yet');

    const ok = await r.post('/api/recover/verify', { token: m.token, code: code.toLowerCase().replace(/-/g, ' ') });
    assert.equal(ok.status, 200, 'the code may be typed in lower case, with spaces');
    assert.equal((await P.session().post('/api/recover/verify', { token: m.token, code })).status, 400, 'a link works once');

    // What a recovery session can read:
    const me = (await r.get('/api/me')).json;
    assert.equal(me.recovery, true);
    assert.equal(me.user.email, 'owner-b@shop.test');
    assert.equal(me.admin, false);
    const stores = (await r.get('/api/stores')).json.stores;
    assert.deepEqual(stores.map((s) => s.id), [storeId], 'only the owner\'s stores');
    assert.equal((await r.get(`/api/stores/${storeId}/incident`)).status, 200);
    assert.equal((await r.get(`/api/stores/${storeId}/recovery-packet`)).status, 200);
    assert.equal((await r.get(`/api/stores/${storeId}/reports`)).status, 200);
    assert.equal((await r.get(`/api/stores/${storeId}/runs?limit=10`)).status, 200);
    assert.equal((await r.get(`/api/stores/${otherStore}/incident`)).status, 404, 'another account\'s store');
    // What it can not do:
    for (const [method, url, body] of [
      ['post', '/api/stores', { url: P.mock.origin }], ['post', `/api/stores/${storeId}/run`, {}], ['post', `/api/stores/${storeId}/incident`, { reason: 'x' }],
      ['patch', '/api/account', { name: 'Hacker' }], ['post', '/api/account/password', { current: 'a', next: 'bbbbbbbbb' }],
      ['get', '/api/account/billing'], ['get', '/api/account/recovery'], ['post', '/api/account/recovery/code', {}],
      ['del', `/api/stores/${storeId}`], ['get', '/api/team'], ['get', '/api/admin/features'],
    ]) {
      const x = await r[method](url, body);
      assert.ok([401, 403].includes(x.status), `${method} ${url} is refused (${x.status})`);
    }
    assert.equal((await owner.get('/api/me')).json.user.name, 'Test Owner', 'nothing changed');
    assert.match(P.log(), /subject=Your Tharam account was opened in recovery mode/, 'the owner is told');
    await r.post('/api/auth/logout');
    assert.equal((await r.get('/api/stores')).status, 401, 'logging out ends it');
    note(t, 'link without code 401; no code or a wrong code 401 (each counts as a try, "3 tries left"); right code (any case) 200; link single use; reads: me, own stores, incident, recovery packet; refused: add/run/incident start/profile/password/billing/code/delete/team/founder; other account\'s store 404; owner emailed');
  });

  it('five wrong codes lock recovery for a while, even for the right code', async (t) => {
    const owner = await signup(P, 'owner-c@shop.test');
    const { code } = (await owner.post('/api/account/recovery/code')).json;
    const m = await ask('owner-c@shop.test');
    const r = P.session();
    for (let i = 0; i < 4; i++) assert.equal((await r.post('/api/recover/verify', { token: m.token, code: 'BBBB-BBBB-BBBB-BBBB' })).status, 401);
    const fifth = await r.post('/api/recover/verify', { token: m.token, code: 'BBBB-BBBB-BBBB-BBBB' });
    assert.equal(fifth.status, 429);
    assert.match(fifth.json.error, /30 minutes/);
    assert.equal((await r.post('/api/recover/verify', { token: m.token, code })).status, 400, 'the open link was cancelled');
    assert.equal(await ask('owner-c@shop.test'), null, 'no new link while locked');
    note(t, '4 × 401, the 5th 429; open link cancelled; right code and new links refused while locked');
  });

  it('links expire, and a new code ends open recovery sessions and old links', async (t) => {
    const owner = await signup(P, 'owner-d@shop.test');
    const first = (await owner.post('/api/account/recovery/code')).json.code;
    const m1 = await ask('owner-d@shop.test');
    const h = writable(); h.prepare('UPDATE recovery_links SET expires_at = ?').run(Date.now() - 1000); h.close();
    assert.equal((await P.session().post('/api/recover/verify', { token: m1.token, code: first })).status, 400, 'an expired link');

    const m2 = await ask('owner-d@shop.test');
    const r = P.session();
    assert.equal((await r.post('/api/recover/verify', { token: m2.token, code: first })).status, 200);
    assert.equal((await r.get('/api/stores')).status, 200);
    const m3 = await ask('owner-d@shop.test');
    const second = (await owner.post('/api/account/recovery/code')).json.code;
    assert.equal((await r.get('/api/stores')).status, 401, 'the open session ended with the old code');
    assert.equal((await P.session().post('/api/recover/verify', { token: m3.token, code: second })).status, 400, 'links asked for under the old code are dead');
    const m4 = await ask('owner-d@shop.test');
    assert.equal((await P.session().post('/api/recover/verify', { token: m4.token, code: first })).status, 401, 'the old code no longer works');
    assert.equal((await P.session().post('/api/recover/verify', { token: m4.token, code: second })).status, 200);
    note(t, 'expired link 400; new code: open session 401, old links 400, old code 401, new code 200');
  });

  it('a Shopify store can recover after uninstall, to the confirmed browser email, until its data is deleted', async (t) => {
    const shop = 'lost-store.myshopify.com';
    const embedded = await shopifyOpen(P, shop);
    // The browser-access email, confirmed from its link.
    assert.equal((await embedded.post('/api/account/web-access', { email: 'owner-shopify@shop.test' })).status, 200);
    const link = /#\/signin\/([\w-]+)/.exec(P.log().split('[mail skipped] ').filter((b) => b.startsWith('to=owner-shopify@shop.test')).at(-1))[1];
    assert.equal((await P.session().post('/api/auth/link/verify', { token: link })).status, 200);
    const { code } = (await embedded.post('/api/account/recovery/code')).json;
    assert.ok(code, 'made inside Shopify admin, with no extra login');

    const webhook = (topic, body = {}) => { const raw = JSON.stringify(body); return fetch(`${P.base}/shopify/webhooks`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-hmac-sha256': shopifyHmac(raw, SHOPIFY.secret) } }); };
    assert.equal((await webhook('app/uninstalled')).status, 200);
    assert.equal((await embedded.get('/api/stores')).status, 401, 'uninstalled: Shopify access is gone');
    assert.equal((await P.session().post('/api/auth/link', { email: 'owner-shopify@shop.test' })).status, 200);

    const m = await ask('owner-shopify@shop.test');
    assert.ok(m?.token, 'recovery works after uninstall');
    assert.equal(m.to, 'owner-shopify@shop.test', 'the shop domain is not a mailbox; the confirmed browser email is used');
    const r = P.session();
    assert.equal((await r.post('/api/recover/verify', { token: m.token, code })).status, 200);
    assert.equal((await r.get('/api/stores')).status, 200, 'reports are readable');
    assert.equal((await r.get('/api/stores')).json.stores.length, 1);
    assert.equal((await r.patch('/api/account', { name: 'x' })).status, 403);

    const m2 = await ask('owner-shopify@shop.test');
    assert.equal((await webhook('shop/redact', { shop_domain: shop })).status, 200);
    assert.equal((await r.get('/api/stores')).status, 401, 'after shop/redact the account is gone');
    assert.equal((await P.session().post('/api/recover/verify', { token: m2.token, code })).status, 400);
    assert.equal(await ask('owner-shopify@shop.test'), null, 'and no new links');
    note(t, 'made inside Shopify; after uninstall: link to the browser email, code → read-only reports; after shop/redact: session 401, old link 400, no new link');
  });

  it('screens: the recover page, Account > Security, and the recovery banner', async (t) => {
    const owner = await signup(P, 'owner-e@shop.test');
    await addStore(P, owner, { alertEmail: 'owner-e@shop.test', runNow: false });
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.addCookies(owner.browserCookies());
    const page = await ctx.newPage();
    await page.goto(`${P.base}/app#/account/security`);
    await page.getByRole('button', { name: 'Make a recovery code' }).click();
    await page.waitForSelector('#rc-code');
    const shown = (await page.textContent('#rc-code')).trim();
    assert.match(shown, /^[2-9A-Z]{4}(-[2-9A-Z]{4}){3}$/);
    await screenshot(t, page, 'Account > Security with the code shown once');
    await ctx.close();

    const anon = await browser.newContext({ viewport: { width: 1200, height: 700 } });
    const p2 = await anon.newPage();
    await p2.goto(`${P.base}/recover`);
    await p2.waitForSelector('#rs');
    await screenshot(t, p2, 'The recover page asks for the email');
    await p2.fill('#email', 'owner-e@shop.test');
    await p2.click('#rs button');
    await p2.waitForSelector('text=Check your email');
    const m = await mailAfter(mails().length - 1);
    await p2.goto(`${P.base}/app#/recover/${m.token}`);
    await p2.waitForSelector('#rv');
    await screenshot(t, p2, 'The link asks for the recovery code');
    await p2.fill('#rc', shown);
    await p2.click('#rv button');
    await p2.waitForSelector('#rec-banner');
    await p2.waitForSelector('text=Run validations', { timeout: 10000 });
    await screenshot(t, p2, 'Recovery mode: read-only, with the banner');
    await anon.close();
    note(t, 'Security tab shows the code once; /recover → email → link → code → banner "Recovery mode"');
  });
});

describe('Recovery console limits', () => {
  let P;
  before(async () => { P = await startProduct(); });
  after(async () => { await P.stop(); });

  it('asking for links is limited per email and per address', async (t) => {
    const s = await signup(P, 'limit@shop.test');
    await s.post('/api/account/recovery/code');
    for (let i = 0; i < 3; i++) assert.equal((await P.session().post('/api/recover/start', { email: 'limit@shop.test' })).status, 200);
    const fourth = await P.session().post('/api/recover/start', { email: 'limit@shop.test' });
    assert.equal(fourth.status, 429);
    assert.match(fourth.json.error, /15 minutes/);
    let last;
    for (let i = 0; i < 8; i++) last = await P.session().post('/api/recover/start', { email: `x${i}@shop.test` });
    assert.equal(last.status, 429, 'ten requests from one address in 15 minutes is the limit');
    note(t, '3 links per email then 429; 10 requests per address then 429');
  });

  it('bad input is refused plainly', async () => {
    const r = await P.session().post('/api/recover/start', { email: 'nope' });
    assert.ok([400, 429].includes(r.status));
    assert.equal((await P.session().post('/api/recover/verify', { token: 12345, code: 'x' })).status, 400);
  });
});
