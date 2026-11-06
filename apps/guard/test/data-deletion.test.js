// Deleting a store or redacting a shop removes everything, and ids are never reused (audit #3, T89).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startProduct, signup, addStore, runAndWait, shopifyOpen, shopifyHmac, SHOPIFY } from './lib/harness.js';
import { note } from './lib/evidence.js';

const exists = (P, ...p) => fs.existsSync(path.join(P.dataDir, ...p));

describe('Data deletion', () => {
  let P;
  before(async () => { P = await startProduct(); });
  after(async () => { await P.stop(); });

  it('deleting a store removes its screenshots, approved looks and product snapshots', async (t) => {
    const owner = await signup(P, 'deleter@shop.test');
    const id = await addStore(P, owner, { runNow: false });
    const run = await runAndWait(owner, id, { kind: 'full' }, 300000);
    assert.equal(run.status, 'done');
    assert.ok(exists(P, 'shots', `run-${run.id}`), 'screenshots exist before');
    const before = ['baselines', 'catalog'].filter((d) => exists(P, d, `store-${id}`));
    assert.equal((await owner.del(`/api/stores/${id}`)).status, 200);
    assert.equal(exists(P, 'shots', `run-${run.id}`), false);
    assert.equal(exists(P, 'baselines', `store-${id}`), false);
    assert.equal(exists(P, 'catalog', `store-${id}`), false);
    note(t, `store ${id}: screenshots of run ${run.id} and ${before.join(', ') || 'no other folders'} removed`);
  });

  it('a new store and a new free scan never get a deleted store\'s ids or screenshots', async (t) => {
    const owner = await signup(P, 'reuse@shop.test');
    const id = await addStore(P, owner, { runNow: false });
    const run = await runAndWait(owner, id, { kind: 'journeys' });
    // Simulate a screenshot folder left behind by older versions.
    fs.mkdirSync(path.join(P.dataDir, 'shots', `run-${run.id + 1}`), { recursive: true });
    fs.writeFileSync(path.join(P.dataDir, 'shots', `run-${run.id + 1}`, 'old.png'), 'old');
    await owner.del(`/api/stores/${id}`);
    const scan = await P.session().post('/api/scan', { url: P.mock.origin });
    assert.equal(scan.status, 200, scan.text);
    // Free scans answer with a random report link; the run number behind it is in the database.
    const scanRun = /^\d+$/.test(String(scan.json.runId)) ? Number(scan.json.runId) : P.db().prepare('SELECT id FROM runs WHERE public_id = ?').get(scan.json.runId).id;
    assert.ok(scanRun > run.id, `free scan got run ${scanRun}, deleted run was ${run.id}`);
    assert.equal(exists(P, 'shots', `run-${scanRun}`, 'old.png'), false, 'a new run starts with an empty folder');
    const id2 = await addStore(P, owner, { runNow: false });
    assert.ok(id2 > id, `new store got id ${id2}, deleted store was ${id}`);
    note(t, `deleted store ${id} / run ${run.id}; next free scan run ${scanRun}; next store ${id2}`);
  });

  it('Shopify shop/redact removes the shop\'s account, stores and every file', async (t) => {
    const shop = 'redact-me.myshopify.com';
    const s = await shopifyOpen(P, shop);
    const run = await runAndWait(s, s.storeId, { kind: 'full' }, 300000);
    assert.ok(exists(P, 'shots', `run-${run.id}`));
    const send = (topic) => { const raw = JSON.stringify({ shop_domain: shop }); return fetch(`${P.base}/shopify/webhooks`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-hmac-sha256': shopifyHmac(raw, SHOPIFY.secret) } }); };
    await send('app/uninstalled');
    await new Promise((r) => setTimeout(r, 300));
    await send('shop/redact');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(exists(P, 'shots', `run-${run.id}`), false);
    assert.equal(exists(P, 'baselines', `store-${s.storeId}`), false);
    assert.equal(exists(P, 'catalog', `store-${s.storeId}`), false);
    assert.equal(P.db().prepare('SELECT COUNT(*) n FROM users WHERE email = ?').get(shop).n, 0);
    assert.equal(P.db().prepare('SELECT COUNT(*) n FROM stores WHERE id = ?').get(s.storeId).n, 0);
    note(t, `shop/redact: account, store ${s.storeId}, run ${run.id} screenshots, looks and product snapshots gone`);
  });
});
