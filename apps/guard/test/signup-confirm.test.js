// Website sign-ups confirm their email before the account works (T103, security audit #4: account pre-claim).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, confirmEmail, confirmToken, shopifyOpen } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function tokenFor(P, email) {
  for (let i = 0; i < 40; i++) { const t = confirmToken(P, email); if (t) return t; await wait(50); }
  return null;
}

describe('Confirming the email on sign-up', () => {
  let P, browser;
  before(async () => {
    P = await startProduct();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('a new account can only see itself until the emailed link is opened', async (t) => {
    const s = await signup(P, 'fresh@shop.test', 'correct horse battery', { confirm: false });
    const me = await s.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.user.email_confirmed, 0);
    const add = await s.post('/api/stores', { url: P.mock.origin, name: 'Mine' });
    assert.equal(add.status, 403);
    assert.match(add.json.error, /Confirm your email/);
    assert.equal((await s.get('/api/stores')).status, 403);
    const login = await P.session().post('/api/auth/login', { email: 'fresh@shop.test', password: 'correct horse battery' });
    assert.equal(login.status, 401);
    assert.match(login.json.error, /Confirm your email first/);
    const r = await confirmEmail(P, s);
    assert.equal(r.verified, true);
    assert.equal((await s.get('/api/me')).json.user.email_confirmed, 1);
    assert.equal((await s.post('/api/stores', { url: P.mock.origin, name: 'Mine', runNow: false })).status, 200);
    assert.equal((await P.session().post('/api/auth/login', { email: 'fresh@shop.test', password: 'correct horse battery' })).status, 200);
    assert.match(P.log(), /to=fresh@shop\.test subject=Welcome to Tharam/);
    note(t, 'unconfirmed: /api/me 200, add store 403, password login 401 → link opened → stores 200, login 200, welcome email sent');
  });

  it('nobody can claim someone else\'s email: the mailbox owner\'s link wins and ends the other session', async (t) => {
    const attacker = await signup(P, 'victim@shop.test', 'attacker password 1', { confirm: false });
    const attackerToken = await tokenFor(P, 'victim@shop.test');
    // The real owner signs up later with their own password: allowed, because the first sign-up was never confirmed.
    const owner = await signup(P, 'victim@shop.test', 'owners own password', { confirm: false });
    const ownerToken = await tokenFor(P, 'victim@shop.test');
    assert.notEqual(ownerToken, attackerToken);
    assert.equal((await attacker.get('/api/me')).status, 401, 'the earlier sign-up session ended');
    // The owner opens their link: their password applies.
    assert.equal((await owner.post('/api/auth/link/verify', { token: ownerToken })).status, 200);
    assert.equal((await P.session().post('/api/auth/login', { email: 'victim@shop.test', password: 'attacker password 1' })).status, 401);
    assert.equal((await P.session().post('/api/auth/login', { email: 'victim@shop.test', password: 'owners own password' })).status, 200);
    // Old links are dead, and the address can't be signed up again now.
    assert.equal((await P.session().post('/api/auth/link/verify', { token: attackerToken })).status, 400);
    assert.equal((await P.session().post('/api/auth/link/verify', { token: ownerToken })).status, 400, 'a link works once');
    assert.equal((await P.session().post('/api/auth/signup', { email: 'victim@shop.test', password: 'third try pw' })).status, 409);
    note(t, 'unconfirmed sign-up replaced by a later one; only the opened link sets the password; earlier session 401; links single-use; then 409');
  });

  it('a sign-in link to a never-confirmed account confirms it', async () => {
    await signup(P, 'linker@shop.test', 'whatever password', { confirm: false });
    assert.equal((await P.session().post('/api/auth/link', { email: 'linker@shop.test' })).status, 200);
    let token = null;
    for (let i = 0; i < 40 && !token; i++) { token = (P.log().split('[mail skipped] ').filter((b) => b.startsWith('to=linker@shop.test ') && /sign-in link/.test(b)).map((b) => /#\/signin\/([\w-]+)/.exec(b)?.[1]).at(-1)) || null; if (!token) await wait(50); }
    const s = P.session();
    assert.equal((await s.post('/api/auth/link/verify', { token })).status, 200);
    assert.equal((await s.get('/api/me')).json.user.email_confirmed, 1);
    assert.equal((await s.get('/api/stores')).status, 200);
  });

  it('the store from a free-check report is added once the email is confirmed', async () => {
    const s = P.session();
    assert.equal((await s.post('/api/auth/signup', { email: 'fromreport@shop.test', password: 'report password', storeUrl: P.mock.origin })).status, 200);
    assert.equal(P.db().prepare('SELECT COUNT(*) AS n FROM stores s JOIN users u ON u.id = s.user_id WHERE u.email = ?').get('fromreport@shop.test').n, 0, 'nothing added before confirming');
    s.email = 'fromreport@shop.test';
    await confirmEmail(P, s);
    let stores = [];
    for (let i = 0; i < 40 && !stores.length; i++) { stores = (await s.get('/api/stores')).json?.stores || []; if (!stores.length) await wait(100); }
    assert.equal(stores.length, 1);
    assert.equal(stores[0].url, P.mock.origin);
  });

  it('resends the link, keeps limits, and leaves Shopify accounts alone', async () => {
    const s = await signup(P, 'resend@shop.test', 'resend password', { confirm: false });
    const first = await tokenFor(P, 'resend@shop.test');
    const r = await s.post('/api/account/confirm/resend', {});
    assert.equal(r.status, 200, r.text);
    let second = first;
    for (let i = 0; i < 40 && second === first; i++) { await wait(50); second = confirmToken(P, 'resend@shop.test'); }
    assert.notEqual(second, first);
    assert.equal((await s.post('/api/auth/link/verify', { token: second })).status, 200);
    assert.equal((await P.session().post('/api/auth/login', { email: 'resend@shop.test', password: 'resend password' })).status, 200, 'the resent link keeps the chosen password');
    // Three links per address per 15 minutes.
    const x = await signup(P, 'limit@shop.test', 'limit password', { confirm: false });
    await x.post('/api/account/confirm/resend', {});
    await x.post('/api/account/confirm/resend', {});
    assert.equal((await x.post('/api/account/confirm/resend', {})).status, 429);
    const shop = await shopifyOpen(P);
    assert.equal((await shop.get('/api/stores')).status, 200, 'accounts from a Shopify install need no confirmation');
  });

  it('shows a "Confirm your email" screen after signing up in the browser', async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#signup`);
    await p.fill('#name', 'Asha');
    await p.fill('#email', 'screen@shop.test');
    await p.fill('#password', 'screen password');
    await p.click('#auth button[type=submit]');
    await p.waitForSelector('text=Confirm your email', { timeout: 15000 });
    assert.match(await p.textContent('.auth-card'), /screen@shop\.test/);
    await screenshot(t, p, 'confirm your email');
    await p.click('#resend');
    await p.waitForSelector('.toast', { timeout: 5000 });
    // Opening the link from the email (a new tab) signs this browser in.
    const token = await tokenFor(P, 'screen@shop.test');
    const p2 = await ctx.newPage();
    p2.on('pageerror', (e) => errors.push(e.message));
    await p2.goto(`${P.base}/app#/signin/${token}`);
    await p2.waitForSelector('text=email is confirmed', { timeout: 15000 });
    await screenshot(t, p2, 'after confirming');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});
