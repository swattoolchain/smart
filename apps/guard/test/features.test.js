/**
 * Feature switches in the founder console: extras start off, founders turn them on or off for
 * everyone, the server enforces it (menus, check groups, routes), and every change is audited.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, founderSession, addStore } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const LAW_GROUPS = ['law.de', 'law.cookies', 'access.law', 'law.us'];

async function waitDone(s, runId) {
  for (let i = 0; i < 120; i++) {
    const g = (await s.get(`/api/runs/${runId}`)).json;
    if (['done', 'error', 'cancelled'].includes(g?.status)) return g;
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe('Feature switches', () => {
  let P, founder, owner, browser;
  // The real defaults: the harness normally turns every feature on.
  before(async () => {
    P = await startProduct({ env: { FEATURES_DEFAULT: '', CSP_MODE: '' } });
    founder = await founderSession(P);
    owner = await signup(P);
  });
  after(async () => { await browser?.close(); await P?.stop(); });

  it('extras start off: hidden from the browser, the test suite and the run', async (t) => {
    const me = (await owner.get('/api/me')).json;
    assert.ok(Array.isArray(me.features), 'the app learns which features are on');
    assert.ok(!me.features.includes('laws'));
    const groups = (await owner.get('/api/catalog')).json.groups.map((g) => g.key);
    for (const g of LAW_GROUPS) assert.ok(!groups.includes(g), `${g} is not offered while the feature is off`);

    // Even if the browser asks for the groups, the run skips them.
    const storeId = await addStore(P, owner, { runNow: false });
    const r = await owner.post(`/api/stores/${storeId}/run`, { groups: [...groups, ...LAW_GROUPS] });
    assert.equal(r.status, 200, r.text);
    const g = (await owner.get(`/api/runs/${r.json.runId}`)).json;
    const skipped = g.live?.disabled ?? g.result?.skippedGroups;
    for (const k of LAW_GROUPS) assert.ok(skipped.includes(k), `${k} skipped while the feature is off`);
    await owner.post(`/api/stores/${storeId}/run/${r.json.runId}/cancel`);
    await waitDone(owner, r.json.runId);
    note(t, 'laws off by default: not in /api/me features, not in the catalog, skipped by the run even when asked for');
  });

  it('every extra starts off, so a fresh install shows the simple product', async (t) => {
    const list = (await founder.get('/api/admin/features')).json.features;
    assert.ok(list.length >= 20, `all extras have a switch (${list.length})`);
    const on = list.filter((f) => !f.core && f.on).map((f) => f.key);
    assert.deepEqual(on, [], 'no extra is on by default');
    const me = (await owner.get('/api/me')).json.features;
    assert.deepEqual(me.filter((k) => !list.find((f) => f.key === k)?.core), []);
    note(t, `${list.length} switches, all extras off by default: ${list.map((f) => f.key).join(', ')}`);
  });

  it('page-content blocking (CSP) starts in report-only, and the switch turns blocking on and off', async (t) => {
    const h = async () => (await fetch(`${P.base}/app`)).headers;
    let hd = await h();
    assert.ok(hd.get('content-security-policy-report-only'), 'report-only policy by default');
    assert.match(hd.get('content-security-policy') || '', /^frame-ancestors /, 'framing is enforced anyway');
    await founder.patch('/api/admin/features/csp_enforce', { on: true });
    hd = await h();
    assert.equal(hd.get('content-security-policy-report-only'), null);
    assert.match(hd.get('content-security-policy') || '', /script-src/, 'the full policy is enforced');
    await founder.patch('/api/admin/features/csp_enforce', { on: false });
    assert.ok((await h()).get('content-security-policy-report-only'), 'back to report-only');
    note(t, 'CSP: report-only by default; the founder switch enforces it and turns it back off, no deploy needed');
  });

  it('only founders can see or change the switches', async (t) => {
    assert.equal((await owner.get('/api/admin/features')).status, 403);
    assert.equal((await owner.patch('/api/admin/features/laws', { on: true })).status, 403);
    const anon = P.session();
    assert.equal((await anon.patch('/api/admin/features/laws', { on: true })).status, 401);
    assert.ok(!(await owner.get('/api/me')).json.features.includes('laws'), 'nothing changed');

    const list = (await founder.get('/api/admin/features')).json.features;
    const laws = list.find((f) => f.key === 'laws');
    assert.ok(laws && laws.on === false && laws.core === false && laws.label);
    assert.equal((await founder.patch('/api/admin/features/nope', { on: true })).status, 404, 'unknown feature');
    assert.equal((await founder.patch('/api/admin/features/laws', { on: 'yes' })).status, 400, 'on must be true or false');
    note(t, 'customers 403, signed-out 401, unknown key 404, bad value 400');
  });

  it('turning a feature on shows it to every customer, and the change is audited', async (t) => {
    const r = await founder.patch('/api/admin/features/laws', { on: true });
    assert.equal(r.status, 200, r.text);
    assert.ok((await owner.get('/api/me')).json.features.includes('laws'));
    const groups = (await owner.get('/api/catalog')).json.groups.map((g) => g.key);
    for (const g of LAW_GROUPS) assert.ok(groups.includes(g), `${g} offered once on`);
    const audit = (await founder.get('/api/admin/audit')).json.audit.find((a) => a.action === 'feature.change' && JSON.parse(a.detail_json).key === 'laws');
    assert.ok(audit, 'audited');
    assert.deepEqual(JSON.parse(audit.detail_json), { key: 'laws', label: 'Laws where you sell', before: false, after: true });
    assert.equal(audit.actor, founder.email);

    // Off again: hidden again; turning it off twice adds no extra audit row.
    await founder.patch('/api/admin/features/laws', { on: false });
    await founder.patch('/api/admin/features/laws', { on: false });
    assert.ok(!(await owner.get('/api/me')).json.features.includes('laws'));
    const rows = (await founder.get('/api/admin/audit')).json.audit.filter((a) => a.action === 'feature.change' && JSON.parse(a.detail_json).key === 'laws');
    assert.equal(rows.length, 2);
    note(t, 'on: visible to customers and in the catalog; audit row with before/after and actor; repeat off is not re-audited');
  });

  it('security watch checks are not offered or run while their switches are off', async (t) => {
    const groups = (await owner.get('/api/catalog')).json.groups.map((g) => g.key);
    for (const g of ['security.scripts', 'security.hijack', 'security.theme']) assert.ok(!groups.includes(g), `${g} hidden`);
    await founder.patch('/api/admin/features/script_watch', { on: true });
    const after = (await owner.get('/api/catalog')).json.groups.map((g) => g.key);
    assert.ok(after.includes('security.scripts') && !after.includes('security.hijack'), 'only the switched-on watch appears');
    await founder.patch('/api/admin/features/script_watch', { on: false });
    note(t, 'security.scripts / hijack / theme hidden by default; turning script watch on shows only that group');
  });

  it('the monthly security report is hidden and refused while off, and works once on', async (t) => {
    const storeId = (await owner.get('/api/stores')).json.stores[0].id;
    const base = `/api/stores/${storeId}/security-report`;
    assert.ok(!(await owner.get('/api/me')).json.features.includes('security_report'));
    for (const [m, u, body] of [['get', base], ['get', `${base}.html`], ['get', `${base}.pdf`], ['post', `${base}/email`, {}], ['patch', base, { monthly: false }]]) {
      assert.equal((await owner[m](u, body)).status, 404, `${m} ${u} refused while off`);
    }
    const nav = (await P.session().get('/shopify?shop=x.myshopify.com')).text;
    if (nav.includes('<ui-nav-menu>')) assert.ok(!nav.includes('/shopify/securityreport'), 'no Security report link in Shopify admin');
    await founder.patch('/api/admin/features/security_report', { on: true });
    assert.equal((await owner.get(base)).status, 200, 'answers once on');
    assert.ok((await owner.get('/api/me')).json.features.includes('security_report'));
    await founder.patch('/api/admin/features/security_report', { on: false });
    note(t, 'off: every security report route 404; on: the report answers; off again: hidden');
  });

  it('sale readiness and webhook alerts answer "not found" while off, and work once on', async (t) => {
    const storeId = (await owner.get('/api/stores')).json.stores[0].id;
    const off = await owner.get(`/api/stores/${storeId}/sale-readiness`);
    assert.equal(off.status, 404); assert.equal(off.json.error, 'Not found');
    assert.equal((await owner.post(`/api/stores/${storeId}/sale-readiness/email`, {})).status, 404);
    assert.equal((await owner.get(`/api/stores/${storeId}/webhook-deliveries`)).status, 404);
    const set = await owner.patch(`/api/stores/${storeId}`, { webhook: { url: 'https://hooks.zapier.com/hooks/catch/1/abc', format: 'json' } });
    assert.equal(set.status, 400, 'a webhook cannot be saved while the feature is off');
    assert.match(set.json.error, /not available/);

    // The Shopify admin menu leaves out switched-off pages.
    const shop = P.session();
    const nav = (await shop.get('/shopify?shop=x.myshopify.com')).text;
    if (nav.includes('<ui-nav-menu>')) assert.ok(!nav.includes('/shopify/sale'), 'no Sale readiness link in Shopify admin');

    await founder.patch('/api/admin/features/sale_report', { on: true });
    await founder.patch('/api/admin/features/webhooks', { on: true });
    const sr = await owner.get(`/api/stores/${storeId}/sale-readiness`);
    assert.notEqual(sr.json?.error, 'Not found', 'the sale readiness route answers once on');
    assert.equal((await owner.get(`/api/stores/${storeId}/webhook-deliveries`)).status, 200);
    const nav2 = (await shop.get('/shopify?shop=x.myshopify.com')).text;
    if (nav2.includes('<ui-nav-menu>')) assert.ok(nav2.includes('/shopify/sale'), 'Sale readiness link back in Shopify admin');
    await founder.patch('/api/admin/features/sale_report', { on: false });
    await founder.patch('/api/admin/features/webhooks', { on: false });
    note(t, 'off: sale readiness and webhook routes 404, saving a webhook refused, Shopify menu without the link; on: routes answer again');
  });

  it('screens: the founder console Features tab, and store settings without the extra', async (t) => {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addCookies(founder.browserCookies());
    const page = await ctx.newPage();
    await page.goto(`${P.base}/app#/admin/features`);
    await page.getByText('Laws where you sell').waitFor();
    await screenshot(t, page, 'Founder console: feature switches');
    await page.locator('input[name=feat][value=laws]').check({ force: true });
    await page.getByText('Laws where you sell is on').waitFor();
    assert.ok((await owner.get('/api/me')).json.features.includes('laws'), 'the switch in the console turned it on');
    await page.locator('input[name=feat][value=laws]').uncheck({ force: true });
    await page.getByText('Laws where you sell is off').waitFor();

    const octx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await octx.addCookies(owner.browserCookies());
    const op = await octx.newPage();
    const storeId = (await owner.get('/api/stores')).json.stores[0].id;
    await op.goto(`${P.base}/app#/s/${storeId}/settings`);
    await op.getByText('Store details').waitFor();
    assert.equal(await op.getByText('Where you sell').count(), 0, 'market setting hidden while the feature is off');
    await screenshot(t, op, 'Store settings with the laws feature off');
    note(t, 'console switch changes the feature for customers; store settings hide "Where you sell" while it is off');
  });
});
