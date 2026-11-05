// Agency workspaces (roadmap 13, part 2): team members on one website account with roles,
// and isolation between agencies.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait, shopifyOpen } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const inviteLink = (P, email) => {
  // The mail log prints "[mail skipped] to=<email> …" followed by the text; take the newest link sent to that address.
  const parts = P.log().split('[mail skipped] to=').filter((x) => x.startsWith(email + ' '));
  const m = parts.length && parts.at(-1).match(/https?:\/\/\S+#\/join\/([\w-]+)/);
  return m ? m[1] : null;
};

describe('Team workspaces', { concurrency: 1 }, () => {
  let P, agencyA, agencyB, storeA, storeB, runA, viewer, admin, browser;
  before(async () => {
    P = await startProduct();
    agencyA = await signup(P, 'owner@agency-a.test');
    agencyB = await signup(P, 'owner@agency-b.test');
    storeA = await addStore(P, agencyA, { runNow: false, name: 'Client One' });
    storeB = await addStore(P, agencyB, { runNow: false, name: 'Client of B' });
    runA = await runAndWait(agencyA, storeA, { kind: 'journeys' });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  async function invite(owner, email, role) {
    const r = await owner.post('/api/team/invites', { email, role });
    assert.equal(r.status, 200, r.text);
    const token = inviteLink(P, email);
    assert.ok(token, 'invite email with a join link');
    return token;
  }

  it('the owner invites a viewer, who joins with their own login and sees only that account', async (t) => {
    const token = await invite(agencyA, 'viewer@people.test', 'viewer');
    viewer = await signup(P, 'viewer@people.test');
    const own = await addStore(P, viewer, { runNow: false, name: 'Viewer own store' });
    const j = await viewer.post('/api/team/join', { token });
    assert.equal(j.status, 200, j.text);
    assert.equal(j.json.workspace.role, 'viewer');
    const me = (await viewer.get('/api/me')).json;
    assert.equal(me.user.email, 'owner@agency-a.test', 'acting as the account');
    assert.deepEqual(me.member, { email: 'viewer@people.test', name: 'Test Owner', role: 'viewer' });
    assert.equal(me.admin, false);
    const stores = (await viewer.get('/api/stores')).json.stores.map((s) => s.id);
    assert.deepEqual(stores, [storeA], 'the workspace stores, not their own');
    assert.ok(!stores.includes(own));
    assert.equal((await viewer.get(`/api/runs/${runA.id}`)).status, 200, 'reports');
    const shot = runA.result.cover;
    const sr = await fetch(P.base + shot, { headers: { cookie: [...viewer.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(sr.status, 200, 'screenshots');
    assert.equal((await viewer.post('/api/team/join', { token })).status, 410, 'an invite works once');
    note(t, `viewer joined; sees stores [${stores}] of agency A, the report and its screenshots`);
  });

  it('a viewer can look but not change anything, and never sees billing or the team', async (t) => {
    const refused = [
      ['PATCH', `/api/stores/${storeA}`, { name: 'x' }], ['POST', `/api/stores/${storeA}/run`, {}], ['DELETE', `/api/stores/${storeA}`],
      ['POST', '/api/stores', { url: P.mock.origin }], ['POST', `/api/stores/${storeA}/test-alert`, {}], ['POST', `/api/stores/${storeA}/approve-visual`, { runId: runA.id }],
      ['GET', '/api/account/billing'], ['GET', '/api/team'], ['POST', '/api/team/invites', { email: 'x@y.test', role: 'admin' }],
      ['POST', '/api/account/password', { current: 'correct horse battery', next: 'new password 123' }], ['PATCH', '/api/account', { name: 'Hacked' }],
      ['POST', '/api/account/quote', {}], ['GET', '/api/account/web-access'], ['GET', '/api/admin/customers'],
    ];
    const leaks = [];
    for (const [m, u, b] of refused) { const r = await viewer.req(m, u, b); if (r.status !== 403) leaks.push(`${m} ${u} -> ${r.status}`); }
    assert.deepEqual(leaks, []);
    const st = (await agencyA.get(`/api/stores/${storeA}`)).json;
    assert.equal((st.store || st).name, 'Client One', 'nothing changed');
    for (const u of [`/api/stores/${storeA}`, `/api/stores/${storeA}/runs`, `/api/stores/${storeA}/scorecard`, '/api/overview']) assert.equal((await viewer.get(u)).status, 200, u);
    const r = await viewer.patch(`/api/stores/${storeA}`, { name: 'x' });
    assert.match(r.json.error, /view this workspace but not change it/);
    note(t, `${refused.length} changes, billing, team, profile, password and founder routes refused with 403; reading works`);
  });

  it('an admin manages stores and runs checks, but not billing, the team or the owner account', async (t) => {
    const token = await invite(agencyA, 'admin@people.test', 'admin');
    admin = await signup(P, 'admin@people.test');
    assert.equal((await admin.post('/api/team/join', { token })).status, 200);
    assert.equal((await admin.patch(`/api/stores/${storeA}`, { name: 'Client One (renamed)' })).status, 200);
    const run = await admin.post(`/api/stores/${storeA}/run`, { kind: 'journeys' });
    assert.equal(run.status, 200, run.text);
    for (const [m, u] of [['GET', '/api/account/billing'], ['GET', '/api/team'], ['POST', '/api/account/password'], ['PATCH', '/api/account'], ['POST', '/api/account/checkout'], ['DELETE', '/api/account/web-access']]) {
      assert.equal((await admin.req(m, u, m === 'GET' ? undefined : {})).status, 403, `${m} ${u}`);
    }
    const team = (await agencyA.get('/api/team')).json;
    assert.deepEqual(team.members.map((m) => [m.email, m.role]), [['viewer@people.test', 'viewer'], ['admin@people.test', 'admin']]);
    note(t, 'admin renamed a store and started a check; billing, team, profile, password, checkout and browser access refused');
  });

  it('agencies stay apart: members of A never reach B', async (t) => {
    const leaks = [];
    for (const who of [viewer, admin]) {
      for (const u of [`/api/stores/${storeB}`, `/api/stores/${storeB}/runs`, `/api/stores/${storeB}/catalog`, `/api/stores/${storeB}/export/runs.csv`]) {
        const r = await who.get(u);
        if (![403, 404].includes(r.status)) leaks.push(`${u} -> ${r.status}`);
      }
      if (![403, 404].includes((await who.patch(`/api/stores/${storeB}`, { name: 'x' })).status)) leaks.push('PATCH B');
      if ((await who.post('/api/team/switch', { accountId: (await agencyB.get('/api/me')).json.user.id })).status !== 404) leaks.push('switch into B');
    }
    assert.deepEqual(leaks, []);
    // B's owner sees nothing of A's team, and A's invite can't be used by someone else.
    assert.deepEqual((await agencyB.get('/api/team')).json.members, []);
    const token = await invite(agencyA, 'someone@else.test', 'viewer');
    const r = await agencyB.post('/api/team/join', { token });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /This invite is for someone@else.test/);
    assert.deepEqual((await agencyB.get('/api/stores')).json.stores.map((s) => s.id), [storeB]);
    note(t, 'A members refused on B stores and switching into B; invite for another email refused');
  });

  it('switching between my account and the workspace', async (t) => {
    const ws = (await viewer.get('/api/team/workspaces')).json;
    assert.equal(ws.workspaces.length, 1);
    assert.equal(ws.workspaces[0].email, 'owner@agency-a.test');
    assert.equal((await viewer.post('/api/team/switch', { accountId: null })).status, 200);
    let me = (await viewer.get('/api/me')).json;
    assert.equal(me.user.email, 'viewer@people.test');
    assert.equal(me.member, null);
    assert.equal((await viewer.get(`/api/stores/${storeA}`)).status, 404, 'own account does not see the workspace stores');
    assert.equal((await viewer.post('/api/team/switch', { accountId: ws.workspaces[0].accountId })).status, 200);
    me = (await viewer.get('/api/me')).json;
    assert.equal(me.member.role, 'viewer');
    // Logging in again always starts in your own account.
    const again = P.session();
    await again.post('/api/auth/login', { email: 'viewer@people.test', password: 'correct horse battery' });
    assert.equal((await again.get('/api/me')).json.member, null);
    note(t, 'switch to own account and back; a new login starts in the own account');
  });

  it('role changes and removal take effect on the next request', async (t) => {
    const team = (await agencyA.get('/api/team')).json;
    const adm = team.members.find((m) => m.email === 'admin@people.test');
    assert.equal((await agencyA.patch(`/api/team/members/${adm.id}`, { role: 'viewer' })).status, 200);
    assert.equal((await admin.patch(`/api/stores/${storeA}`, { name: 'again' })).status, 403, 'now a viewer');
    assert.equal((await agencyA.patch(`/api/team/members/${adm.id}`, { role: 'owner' })).status, 400, 'no other roles');
    assert.equal((await agencyB.patch(`/api/team/members/${adm.id}`, { role: 'admin' })).status, 404, "another agency can't touch A's team");
    assert.equal((await agencyB.del(`/api/team/members/${adm.id}`)).status, 404);
    assert.equal((await agencyA.del(`/api/team/members/${adm.id}`)).status, 200);
    assert.equal((await admin.get(`/api/stores/${storeA}`)).status, 404, 'removed: no access');
    assert.equal((await admin.get('/api/me')).json.user.email, 'admin@people.test', 'back in their own account');
    const sr = await fetch(P.base + runA.result.cover, { headers: { cookie: [...admin.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(sr.status, 404, 'screenshots too');
    note(t, 'admin -> viewer refused at once; removed member back in own account, report screenshots refused');
  });

  it('invites: checked, limited, revocable; website accounts only', async (t) => {
    assert.equal((await agencyA.post('/api/team/invites', { email: 'not-an-email', role: 'viewer' })).status, 400);
    assert.equal((await agencyA.post('/api/team/invites', { email: 'x@y.test', role: 'owner' })).status, 400);
    assert.equal((await agencyA.post('/api/team/invites', { email: 'owner@agency-a.test', role: 'viewer' })).status, 400);
    assert.equal((await agencyA.post('/api/team/invites', { email: 'viewer@people.test', role: 'admin' })).status, 409, 'already in the team');
    const token = await invite(agencyA, 'revoked@people.test', 'viewer');
    const inv = (await agencyA.get('/api/team')).json.invites.find((i) => i.email === 'revoked@people.test');
    assert.equal((await agencyB.del(`/api/team/invites/${inv.id}`)).status, 404);
    assert.equal((await agencyA.del(`/api/team/invites/${inv.id}`)).status, 200);
    const late = await signup(P, 'revoked@people.test');
    assert.equal((await late.post('/api/team/join', { token })).status, 410, 'revoked invite');
    for (let i = 0; (await agencyA.get('/api/team')).json.members.length + (await agencyA.get('/api/team')).json.invites.length < 10; i++) await agencyA.post('/api/team/invites', { email: `fill${i}@people.test`, role: 'viewer' });
    const over = await agencyA.post('/api/team/invites', { email: 'eleven@people.test', role: 'viewer' });
    assert.equal(over.status, 400);
    assert.match(over.json.error, /up to 10 people/);
    const shop = await shopifyOpen(P);
    assert.equal((await shop.get('/api/team')).status, 403);
    assert.equal((await shop.post('/api/team/invites', { email: 'staff@x.test', role: 'admin' })).status, 403);
    assert.equal((await shop.get('/api/me')).json.team, false);
    note(t, 'bad email/role/self refused, duplicate member 409, revoke works only for the owner, limit 10, Shopify accounts refused');
  });

  it('screens: the Team page and working in a workspace', { timeout: 90000 }, async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(agencyA.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#/account/team`);
    await p.waitForSelector('#inv', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    assert.ok((await p.locator('.team-table tr').count()) >= 2);
    await screenshot(t, p, 'Team page (owner)', { fullPage: true });
    await ctx.close();

    const v = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await v.addCookies(viewer.browserCookies());
    const vp = await v.newPage();
    vp.on('pageerror', (e) => errors.push(e.message));
    await vp.goto(`${P.base}/app#/s/${storeA}`);
    await vp.waitForSelector('#member-banner', { timeout: 20000 });
    assert.match(await vp.textContent('#member-banner'), /working in .*workspace as a viewer/);
    await vp.click('#user-btn');
    await vp.waitForSelector('.ws-item', { timeout: 10000 });
    assert.equal(await vp.locator('.ws-item').count(), 2);
    await screenshot(t, vp, 'Viewer in the agency workspace, with the workspace switcher');
    await vp.click('.ws-item:not(.on)');
    await vp.waitForFunction(() => !document.getElementById('member-banner'), null, { timeout: 15000 });
    assert.equal(await vp.locator('#member-banner').count(), 0, 'switched back to own account');
    assert.deepEqual(errors, []);
    await v.close();
  });
});
