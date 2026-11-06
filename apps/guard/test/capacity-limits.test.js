// Capacity limits (T104, security audit #7): store lookups share a small browser pool (one per account),
// and the waiting line for checks is capped, with free checks limited to a small share of it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startProduct, signup, addStore } from './lib/harness.js';
import { note } from './lib/evidence.js';
import { withLookupSlot } from '../src/lookups.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Capacity limits', () => {
  it('the lookup pool never runs more than its size and hands slots over in order', async (t) => {
    let now = 0, peak = 0;
    const job = (ms) => async () => { now++; peak = Math.max(peak, now); await wait(ms); now--; return ms; };
    const out = await Promise.all([1, 2, 3, 4, 5].map((i) => withLookupSlot(`acct${i}`, job(40))));
    assert.deepEqual(out, [40, 40, 40, 40, 40]);
    assert.equal(peak, 2, 'default pool of 2');
    // One per account: a second lookup for the same account while one runs is refused.
    const first = withLookupSlot('same', job(60));
    await assert.rejects(withLookupSlot('same', job(1)), (e) => e.status === 429 && /already looking/.test(e.message));
    await first;
    assert.equal(await withLookupSlot('same', job(1)), 1, 'free again afterwards');
    note(t, '5 lookups with a pool of 2: peak 2, all finished; same account twice at once → 429');
  });

  describe('on a busy server', () => {
    let P;
    // No checks start (concurrency 0), so the waiting line fills: room for 3 checks, 2 of them free checks.
    before(async () => {
      P = await startProduct({ env: { RUN_CONCURRENCY: '0', RUN_QUEUE_MAX: '3', FREE_QUEUE_MAX: '2', LOOKUP_CONCURRENCY: '1', LOOKUP_QUEUE_MAX: '0' } });
    });
    after(async () => { await P.stop(); });

    it('caps the waiting line, with a smaller share for free checks', async (t) => {
      const a = await signup(P, 'busy-a@shop.test');
      const b = await signup(P, 'busy-b@shop.test');
      const c = await signup(P, 'busy-c@shop.test');
      const [sa, sb, sc] = [await addStore(P, a, { runNow: false }), await addStore(P, b, { runNow: false }), await addStore(P, c, { runNow: false })];
      assert.equal((await a.post(`/api/stores/${sa}/run`, { kind: 'journeys' })).status, 200, 'queued (1)');
      const free1 = await P.session().post('/api/scan', { url: P.mock.origin });
      assert.equal(free1.status, 200, `free check queued (2): ${free1.text}`);
      const free2 = await P.session().post('/api/scan', { url: P.mock.origin.replace('localhost', '127.0.0.1') });
      assert.equal(free2.status, 503, 'free checks may use only 2 places');
      assert.match(free2.json.error, /Try your free check again in a few minutes/);
      assert.equal((await b.post(`/api/stores/${sb}/run`, { kind: 'journeys' })).status, 200, 'paid check still fits (3)');
      const runsBefore = P.db().prepare('SELECT COUNT(*) AS n FROM runs').get().n;
      const full = await c.post(`/api/stores/${sc}/run`, { kind: 'journeys' });
      assert.equal(full.status, 503);
      assert.equal(full.json.busy, true);
      assert.match(full.json.error, /very busy/);
      assert.equal(P.db().prepare('SELECT COUNT(*) AS n FROM runs').get().n, runsBefore, 'nothing saved for a refused check');
      // Adding a store still works when the line is full; its first check just isn't started.
      const add = await c.post('/api/stores', { url: P.mock.origin.replace('localhost', '127.0.0.1'), name: 'Second', runNow: true });
      assert.equal(add.status, 200, add.text);
      assert.equal(add.json.runId, null);
      // Stopping a waiting check makes room again.
      const queued = P.db().prepare("SELECT id FROM runs WHERE store_id = ? AND status = 'queued'").get(sa).id;
      assert.equal((await a.post(`/api/stores/${sa}/run/${queued}/cancel`)).status, 200);
      assert.equal((await c.post(`/api/stores/${sc}/run`, { kind: 'journeys' })).status, 200, 'room after a cancel');
      note(t, 'line of 3 (2 free): paid 200, free 200, free 503, paid 200, paid 503 (no run saved), add store 200 without a run, cancel → paid 200');
    });

    it('looks at one store per account at a time, and a few across everyone', async (t) => {
      const x = await signup(P, 'look-x@shop.test');
      const y = await signup(P, 'look-y@shop.test');
      const [rx, ry] = await Promise.all([x.post('/api/discover', { url: P.mock.origin }), y.post('/api/discover', { url: P.mock.origin })]);
      const codes = [rx.status, ry.status].sort();
      assert.deepEqual(codes, [200, 503], `one lookup at a time across accounts: ${rx.text} / ${ry.text}`);
      const busy = rx.status === 503 ? rx : ry;
      assert.match(busy.json.error, /very busy/);
      const [s1, s2] = await Promise.all([x.post('/api/discover', { url: P.mock.origin }), x.post('/api/discover', { url: P.mock.origin })]);
      const own = [s1, s2].map((r) => r.status).sort();
      assert.deepEqual(own, [200, 429], 'one lookup per account');
      assert.match([s1, s2].find((r) => r.status === 429).json.error, /already looking at a store for you/);
      const ok = await y.post('/api/discover', { url: P.mock.origin });
      assert.equal(ok.status, 200, 'free again when nothing else runs');
      assert.equal(ok.json.isShopify, true);
      note(t, `two accounts at once → ${codes.join('/')}; same account twice → ${own.join('/')}; then 200`);
    });
  });
});
