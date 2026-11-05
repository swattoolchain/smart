// Website accounts: sign up, log in, log out, and the rules around them.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startProduct, signup, FOUNDER } from './lib/harness.js';
import { note } from './lib/evidence.js';

describe('Website accounts', () => {
  let P;
  before(async () => { P = await startProduct(); });
  after(async () => { await P.stop(); });

  it('signs up, sees itself, logs out and logs back in', async (t) => {
    const s = await signup(P, 'alice@shop.test');
    const me = await s.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.user.email, 'alice@shop.test');
    assert.equal(me.json.user.password_hash, undefined, 'password hash must never be sent to the browser');
    assert.equal((await s.post('/api/auth/logout')).status, 200);
    assert.equal((await s.get('/api/me')).status, 401);
    const again = P.session();
    assert.equal((await again.post('/api/auth/login', { email: 'alice@shop.test', password: s.password })).status, 200);
    assert.equal((await again.get('/api/me')).json.user.email, 'alice@shop.test');
    note(t, 'signup → /api/me → logout (401) → login again');
  });

  it('refuses a wrong password, a duplicate email, a short password and a bad email', async () => {
    await signup(P, 'bob@shop.test');
    const s = P.session();
    assert.equal((await s.post('/api/auth/login', { email: 'bob@shop.test', password: 'wrong password' })).status, 401);
    assert.equal((await s.post('/api/auth/signup', { email: 'bob@shop.test', password: 'another password' })).status, 409);
    assert.equal((await s.post('/api/auth/signup', { email: 'new@shop.test', password: 'short' })).status, 400);
    assert.equal((await s.post('/api/auth/signup', { email: 'not-an-email', password: 'long enough pw' })).status, 400);
  });

  it('does not let anyone sign up with the founder email', async () => {
    const r = await P.session().post('/api/auth/signup', { email: FOUNDER, password: 'trying to get in' });
    assert.equal(r.status, 403);
  });

  it('keeps the founder console closed to customers', async () => {
    const s = await signup(P);
    for (const u of ['/api/admin/billing', '/api/admin/customers', '/api/admin/plans', '/api/admin/audit']) {
      const r = await s.get(u);
      assert.ok([401, 403, 404].includes(r.status), `${u} answered ${r.status}`);
    }
  });

  it('blocks repeated wrong passwords from one address', async () => {
    await signup(P, 'carol@shop.test');
    const s = P.session();
    let last;
    for (let i = 0; i < 11; i++) last = await s.post('/api/auth/login', { email: 'carol@shop.test', password: `wrong ${i}` });
    assert.equal(last.status, 429);
  });
});
