// Storefront and staging passwords are stored encrypted (AES-256-GCM, like Shopify tokens), never sent
// back by the API, and still open password-protected stores. Old plain-text rows are encrypted in place.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait, ROOT } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const TOKEN_KEY = 'test-token-key-for-store-passwords';
const PW = 'letmein'; // the mock store's password (MOCK_BREAK=password)
const SEALED = /^v1:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]*={0,2}$/;

/** Runs code against the product's database in a separate process, the way the server starts up. */
function inProduct(P, code, env = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATA_DIR: P.dataDir, TOKEN_KEY, ALLOW_LOCAL_TARGETS: '1', ...env },
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return { out: JSON.parse(r.stdout.trim().split('\n').pop()), log: r.stdout + r.stderr };
}
const decrypt = (P, value, env) => inProduct(P, `import('./src/secret.js').then((m) => console.log(JSON.stringify(m.readSecret(${JSON.stringify(value)}))))`, env).out;
const check = (run, id) => run.result?.checks?.find((c) => c.id === id);

describe('Store passwords', () => {
  let P, owner, storeId, rw;
  const stored = (id = storeId) => P.db().prepare('SELECT storefront_password AS v FROM stores WHERE id = ?').get(id).v;
  before(async () => {
    P = await startProduct({ env: { TOKEN_KEY }, mock: { breaks: 'password' } });
    owner = await signup(P, 'locked@shop.test');
    storeId = await addStore(P, owner, { runNow: false, password: PW });
    rw = new Database(path.join(P.dataDir, 'guard.db'));
  });
  after(async () => { try { rw?.close(); } catch {} await P?.stop(); });

  it('a new store password is stored encrypted, not as typed', async (t) => {
    const v = stored();
    assert.ok(v, 'password saved');
    assert.match(v, SEALED);
    assert.ok(!v.includes(PW), 'plain password not in the database');
    assert.equal(decrypt(P, v), PW, 'opens with the server key');
    // Two stores with the same password don't share a stored value (random IV).
    const other = await signup(P, 'locked2@shop.test');
    const id2 = await addStore(P, other, { runNow: false, password: PW });
    assert.notEqual(stored(id2), v);
    note(t, `Stored as ${v.slice(0, 32)}… (AES-256-GCM, v1 format shared with Shopify tokens)`);
  });

  it('the password is never sent back by the API or shown on screen', async (t) => {
    for (const u of [`/api/stores/${storeId}`, '/api/stores', '/api/overview']) {
      const r = await owner.get(u);
      assert.equal(r.status, 200, u);
      assert.ok(!r.text.includes(PW), `${u} leaks the password`);
      assert.ok(!r.text.includes(stored()), `${u} leaks the encrypted value`);
    }
    assert.equal((await owner.get(`/api/stores/${storeId}`)).json.store.has_password, true);
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addCookies(owner.browserCookies());
      const p = await ctx.newPage();
      await p.goto(`${P.base}/app#/s/${storeId}/settings`);
      await p.waitForSelector('.main-inner h1', { timeout: 20000 });
      await p.waitForTimeout(800);
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      const html = await p.content();
      const values = await p.$$eval('input', (els) => els.map((e) => e.value));
      assert.ok(!html.includes(PW) && !values.includes(PW), 'password not in the page');
      await screenshot(t, p, 'Store settings: password saved, not shown', { fullPage: true });
    } finally { await browser.close(); }
  });

  it('checks still unlock the password-protected store', async (t) => {
    const run = await runAndWait(owner, storeId, { kind: 'journeys' });
    assert.equal(run.status, 'done', run.error || '');
    assert.notEqual(run.verdict, 'locked', 'store was unlocked');
    assert.equal(check(run, 'fn.atc')?.status, 'pass');
    note(t, `Journeys on the locked mock store: verdict ${run.verdict}, add to cart ${check(run, 'fn.atc')?.status}`);
  });

  it('changing, keeping and clearing the password', async (t) => {
    const before1 = stored();
    // Saving other settings without a password keeps it exactly.
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { name: 'Locked shop' })).status, 200);
    assert.equal(stored(), before1);
    // A wrong password is stored encrypted too, and the store reports as locked.
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { password: 'wrong-one' })).status, 200);
    assert.match(stored(), SEALED);
    assert.equal(decrypt(P, stored()), 'wrong-one');
    const locked = await runAndWait(owner, storeId, { kind: 'journeys' });
    assert.equal(locked.verdict, 'locked');
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { password: PW })).status, 200);
    assert.notEqual(stored(), before1, 'fresh encryption on every save');
    assert.equal(decrypt(P, stored()), PW);
    // An empty password clears it.
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { password: '' })).status, 200);
    assert.equal(stored(), null);
    assert.equal((await owner.get(`/api/stores/${storeId}`)).json.store.has_password, false);
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { password: PW })).status, 200);
    note(t, 'Kept on unrelated saves, wrong password -> locked, re-encrypted on change, cleared with an empty value');
  });

  it('old plain-text passwords are encrypted in place at startup, without losing them', async (t) => {
    // A store and an environment saved before encryption existed.
    const legacy = await signup(P, 'legacy@shop.test');
    const legacyStore = await addStore(P, legacy, { runNow: false });
    rw.prepare('UPDATE stores SET storefront_password = ? WHERE id = ?').run(PW, legacyStore);
    const envId = Number(rw.prepare("INSERT INTO environments (store_id, name, kind, url, password, auto, token) VALUES (?, 'Old staging', 'store', 'http://127.0.0.1:1', 'stage:pass', 'off', 'tg_legacy')").run(legacyStore).lastInsertRowid);
    // Not yet migrated: the running server still opens the store with it.
    const before = await runAndWait(legacy, legacyStore, { kind: 'journeys' });
    assert.notEqual(before.verdict, 'locked', 'plain-text row still works before migration');

    const otherSealed = stored();
    const count = () => P.db().prepare('SELECT (SELECT COUNT(*) FROM stores) + (SELECT COUNT(*) FROM environments) AS n').get().n;
    const rowsBefore = count();
    const { log } = inProduct(P, "import('./src/db.js').then(() => console.log('{}'))");
    assert.match(log, /Encrypted 2 stored passwords/);
    const v = stored(legacyStore);
    assert.match(v, SEALED);
    assert.equal(decrypt(P, v), PW);
    const ev = rw.prepare('SELECT password FROM environments WHERE id = ?').get(envId).password;
    assert.match(ev, SEALED);
    assert.equal(decrypt(P, ev), 'stage:pass');
    assert.equal(stored(), otherSealed, 'already encrypted rows untouched');
    assert.equal(count(), rowsBefore, 'no rows lost');
    // Running it again changes nothing.
    const again = inProduct(P, "import('./src/db.js').then(() => console.log('{}'))");
    assert.doesNotMatch(again.log, /Encrypted/);
    assert.equal(stored(legacyStore), v);
    // The running server opens the migrated store.
    const afterRun = await runAndWait(legacy, legacyStore, { kind: 'journeys' });
    assert.notEqual(afterRun.verdict, 'locked');
    assert.equal(check(afterRun, 'fn.atc')?.status, 'pass');
    note(t, 'One store and one environment in plain text: both encrypted in place, decrypt to the original, second start changes nothing, checks still unlock');
  });

  it('with another key, a stored password is unreadable and nothing crashes', () => {
    assert.equal(decrypt(P, stored(), { TOKEN_KEY: 'a-different-key' }), null);
    assert.equal(decrypt(P, 'plain-old-password'), 'plain-old-password', 'unmigrated value read as is');
  });

  it('staging environment passwords are encrypted too, and used for publish checks', async (t) => {
    const stagingUrl = P.mock.origin.replace('localhost', '127.0.0.1');
    const r = await owner.post(`/api/stores/${storeId}/environments`, { name: 'Staging', kind: 'store', url: stagingUrl, password: PW });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.hasPassword, true);
    assert.ok(!r.text.includes(PW));
    const ev = () => P.db().prepare('SELECT password FROM environments WHERE id = ?').get(r.json.id).password;
    const sealed = ev();
    assert.match(sealed, SEALED);
    assert.equal(decrypt(P, sealed), PW);
    // Editing without a password keeps the saved one.
    assert.equal((await owner.patch(`/api/stores/${storeId}/environments/${r.json.id}`, { name: 'Staging 2' })).status, 200);
    assert.equal(ev(), sealed);
    const list = await owner.get(`/api/stores/${storeId}/environments`);
    assert.ok(!list.text.includes(PW) && !list.text.includes(sealed));
    // A publish check against the password-protected staging store gets past its password page.
    const rel = await owner.post(`/api/stores/${storeId}/releases`, { environmentId: r.json.id });
    assert.equal(rel.status, 200, rel.text);
    const row = P.db().prepare('SELECT live_run_id, draft_run_id FROM releases WHERE id = ?').get(rel.json.id);
    const until = Date.now() + 300000;
    let draft;
    while (Date.now() < until) {
      draft = (await owner.get(`/api/runs/${row.draft_run_id}`)).json;
      if (['done', 'error', 'cancelled'].includes(draft.status)) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    assert.equal(draft.status, 'done', draft.error || draft.status);
    assert.notEqual(draft.verdict, 'locked', 'staging store unlocked with its own password');
    note(t, `Staging password stored encrypted; publish check ${rel.json.id}: staging run ${draft.id} verdict ${draft.verdict}`);
  });
});
