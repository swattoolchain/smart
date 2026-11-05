// Abuse limits: crafted input can't slow the server, and email-sending routes can't be used to spam (T88).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startProduct, signup, addStore } from './lib/harness.js';
import { note } from './lib/evidence.js';

describe('Abuse limits', () => {
  let P;
  before(async () => { P = await startProduct({ env: { SIGNUPS_PER_IP_PER_HOUR: '3', LEADS_PER_IP_PER_HOUR: '3', TEST_ALERTS_PER_STORE_PER_HOUR: '2' } }); });
  after(async () => { await P.stop(); });

  it('a huge crafted email is refused at once, everywhere (no ReDoS)', async (t) => {
    const evil = 'a@' + 'a.'.repeat(24000) + '@';
    const times = [];
    for (const [u, body] of [['/api/auth/login', { email: evil, password: 'x' }], ['/api/leads', { email: evil }], ['/api/auth/link', { email: evil }]]) {
      const t0 = Date.now();
      const r = await P.session().post(u, body);
      times.push(Date.now() - t0);
      assert.ok([400, 401, 413].includes(r.status), `${u} answered ${r.status}`);
    }
    note(t, `answer times: ${times.join(' ms, ')} ms (the old check took ~2,350 ms per request)`);
    assert.ok(Math.max(...times) < 300, `too slow: ${times}`);
    const h = await fetch(P.base + '/healthz');
    assert.equal(h.status, 200);
  });

  it('normal emails are still accepted', async () => {
    for (const e of ['owner@shop.in', 'first.last+tag@sub.example.co.uk', 'x@y.io']) assert.equal((await P.session().post('/api/leads', { email: e })).status, 200, e);
    for (const bad of ['no-at-sign', 'a@b', 'a@b.c', 'two@@x.io', 'sp ace@x.io']) assert.equal((await P.session().post('/api/leads', { email: bad })).status, 400, bad);
    const s = P.session();
    assert.equal((await s.post('/api/auth/signup', { email: 'first.last+tag@sub.example.co.uk', password: 'long enough pw' })).status, 200);
  });

  it('sign-ups from one address are limited', async () => {
    let last;
    for (let i = 0; i < 4; i++) last = await P.session().post('/api/auth/signup', { email: `many${i}@spam.test`, password: 'long enough pw' });
    assert.equal(last.status, 429);
  });

  it('leads from one address are limited', async () => {
    let last;
    for (let i = 0; i < 5; i++) last = await P.session().post('/api/leads', { email: `lead${i}@spam.test` });
    assert.equal(last.status, 429);
  });

  it('test alerts per store are limited', async () => {
    const Q = await startProduct({ env: { TEST_ALERTS_PER_STORE_PER_HOUR: '2' } });
    try {
      const owner = await signup(Q, 'alerts@limit.test');
      const id = await addStore(Q, owner, { runNow: false });
      const codes = [];
      for (let i = 0; i < 3; i++) codes.push((await owner.post(`/api/stores/${id}/test-alert`)).status);
      assert.deepEqual(codes, [200, 200, 429]);
    } finally { await Q.stop(); }
  });
});
