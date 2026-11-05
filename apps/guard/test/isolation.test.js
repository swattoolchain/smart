// Data isolation: one account can never see or change another account's stores, runs or files.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startProduct, signup, shopifyOpen, addStore } from './lib/harness.js';
import { note } from './lib/evidence.js';

// Every route that takes a store id. :id is the victim's store.
const STORE_ROUTES = [
  ['get', '/api/stores/:id'], ['get', '/api/stores/:id/apps'], ['get', '/api/stores/:id/catalog'], ['get', '/api/stores/:id/compare'],
  ['get', '/api/stores/:id/environments'], ['get', '/api/stores/:id/releases'], ['get', '/api/stores/:id/reports'],
  ['get', '/api/stores/:id/runs'], ['get', '/api/stores/:id/sale-readiness'], ['get', '/api/stores/:id/scorecard'], ['get', '/api/stores/:id/shopify/themes'],
  ['get', '/api/stores/:id/visual'], ['patch', '/api/stores/:id'], ['delete', '/api/stores/:id'],
  ['post', '/api/stores/:id/approve-visual'], ['post', '/api/stores/:id/discover'], ['post', '/api/stores/:id/environments'],
  ['post', '/api/stores/:id/explain-change'], ['post', '/api/stores/:id/releases'], ['post', '/api/stores/:id/run'],
  ['post', '/api/stores/:id/sale-readiness/email'], ['post', '/api/stores/:id/test-alert'],
  ['get', '/api/stores/:id/theme/clean'], ['get', '/api/stores/:id/theme/clean/file?name=layout%2Ftheme.liquid'], ['get', '/api/stores/:id/theme/clean.zip'],
  ['get', '/api/stores/:id/export/runs.csv'], ['get', '/api/stores/:id/export/checks.csv'], ['get', '/api/stores/:id/export/products.csv'],
  ['get', '/api/stores/:id/runs/1/report.html'], ['get', '/api/stores/:id/runs/1/report.pdf'],
  ['post', '/api/stores/:id/test-alert'], ['get', '/api/stores/:id/webhook-deliveries'],
];

describe('Data isolation', () => {
  let P, alice, aliceStore, mallory, shopOwner;
  before(async () => {
    P = await startProduct();
    alice = await signup(P, 'alice@iso.test');
    aliceStore = await addStore(P, alice, { runNow: false });
    mallory = await signup(P, 'mallory@iso.test');
    shopOwner = await shopifyOpen(P, 'other-shop.myshopify.com');
  });
  after(async () => { await P.stop(); });

  const call = (s, method, url, body) => (method === 'get' ? s.get(url) : method === 'delete' ? s.del(url) : s.req(method.toUpperCase(), url, body ?? {}));
  const refused = (r) => [401, 403, 404].includes(r.status);

  for (const who of ['another website account', 'a Shopify-installed account', 'a visitor who is not logged in']) {
    it(`refuses ${who} on every store route`, async (t) => {
      const s = who.startsWith('another') ? mallory : who.startsWith('a Shopify') ? shopOwner : P.session();
      const leaks = [];
      for (const [m, u] of STORE_ROUTES) {
        const r = await call(s, m, u.replace(':id', aliceStore));
        if (!refused(r)) leaks.push(`${m.toUpperCase()} ${u} → ${r.status}`);
      }
      note(t, `${STORE_ROUTES.length} store routes tried; ${leaks.length} answered`);
      assert.deepEqual(leaks, []);
    });
  }

  it('the owner can still use their own store', async () => {
    for (const u of ['/api/stores/:id', '/api/stores/:id/runs', '/api/stores/:id/scorecard']) assert.equal((await alice.get(u.replace(':id', aliceStore))).status, 200, u);
  });

  it('store lists only show your own stores', async () => {
    const a = (await alice.get('/api/stores')).json.stores.map((s) => s.id);
    const m = (await mallory.get('/api/stores')).json.stores.map((s) => s.id);
    const sh = (await shopOwner.get('/api/stores')).json.stores.map((s) => s.id);
    assert.deepEqual(a, [aliceStore]);
    assert.deepEqual(m, []);
    assert.deepEqual(sh, [shopOwner.storeId]);
  });

  it('a run report is invisible to other accounts, and run screenshots are refused', async (t) => {
    const r = await alice.post(`/api/stores/${aliceStore}/run`, { groups: ['journey.atc'] });
    assert.equal(r.status, 200);
    const runId = r.json.runId;
    assert.equal((await alice.get(`/api/runs/${runId}`)).status, 200);
    assert.equal((await mallory.get(`/api/runs/${runId}`)).status, 404);
    assert.equal((await shopOwner.get(`/api/runs/${runId}`)).status, 404);
    assert.equal((await P.session().get(`/api/runs/${runId}`)).status, 404);
    const shot = await mallory.get(`/shots/run-${runId}/home-desktop.png`);
    assert.equal(shot.status, 404);
    note(t, `run ${runId}: owner 200; other account, Shopify account and anonymous all 404; screenshot 404`);
    await alice.post(`/api/stores/${aliceStore}/run/${runId}/cancel`);
  });

  it('a Shopify-installed account cannot add or delete stores', async () => {
    assert.ok([400, 403].includes((await shopOwner.post('/api/stores', { url: P.mock.origin })).status));
    assert.ok([400, 403].includes((await shopOwner.del(`/api/stores/${shopOwner.storeId}`)).status));
  });
});
