// Cross-store early warning (T42): when the same app changes its code on many of the stores we watch within a
// short time, every store using that app is warned (once), including stores the update hasn't reached yet.
// Warnings never say which other stores (or whose) saw the change, only how many.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const APP_NAMES = 'reviews-app.localhost=Star Reviews,chat-app.localhost=Live Chat,chat-api.localhost=Live Chat';
const QUICK = ['journey.core', 'journey.checkout', 'security.scripts', 'errors.js'];

describe('Cross-store early warning', () => {
  let P;
  const shops = []; // { owner, storeId }
  const toggle = (q) => fetch(`${P.mock.origin}/__extra?${q}`).then((r) => r.json());
  const check = async (s) => { const r = await runAndWait(s.owner, s.storeId, { groups: QUICK }); assert.equal(r.status, 'done', r.error || ''); return r; };
  const health = async (s) => { const r = await s.owner.get(`/api/stores/${s.storeId}/apps`); assert.equal(r.status, 200, r.text); return r.json; };
  const mails = (email) => P.log().split('\n').filter((l) => l.includes('[mail skipped]') && l.includes(`to=${email}`) && l.includes('Early warning'));

  before(async () => {
    P = await startProduct({ env: { APP_NAMES, EARLY_WARNING_STORES: '3', EARLY_WARNING_HOURS: '24' }, mock: { extra: 'apps' } });
    for (const name of ['a', 'b', 'c', 'd']) {
      const owner = await signup(P, `early-${name}@shop.test`);
      shops.push({ name, owner, storeId: await addStore(P, owner, { runNow: false }) });
    }
  });
  after(async () => { await toggle('appscode=0').catch(() => {}); await P?.stop(); });

  it('first checks record each store\'s apps; nothing has changed, so no warning', async () => {
    for (const s of shops) await check(s);
    for (const s of shops) {
      const d = await health(s);
      assert.deepEqual(d.earlyWarnings, []);
      assert.ok(d.apps.some((a) => a.name === 'Star Reviews'));
    }
  });

  it('the same app changing on fewer stores than the threshold raises no warning', async (t) => {
    await toggle('appscode=1');
    await check(shops[0]);
    await check(shops[1]);
    for (const s of shops) assert.deepEqual((await health(s)).earlyWarnings, [], `store ${s.name}`);
    assert.equal((await health(shops[0])).apps.find((a) => a.name === 'Star Reviews').status, 'changed', 'App health still shows the change on the store itself');
    note(t, 'Star Reviews changed on 2 stores (threshold 3): no early warning yet.');
  });

  it('when it changes on enough stores, every store using the app is warned, including ones the update hasn\'t reached', async (t) => {
    await check(shops[2]);
    for (const s of shops.slice(0, 3)) {
      const w = (await health(s)).earlyWarnings;
      assert.equal(w.length, 1, `store ${s.name}: ${JSON.stringify(w)}`);
      assert.equal(w[0].appName, 'Star Reviews');
      assert.equal(w[0].stores, 3);
      assert.equal(w[0].changedHere, true, 'the new code is already on this store');
    }
    const d = await health(shops[3]);
    assert.equal(d.earlyWarnings.length, 1, 'store d uses the app but has not been checked since: warned ahead of time');
    assert.equal(d.earlyWarnings[0].changedHere, false);
    assert.ok(!d.earlyWarnings.some((w) => w.appName === 'Live Chat'), 'only the app that changed');
    // One email per store owner, to that owner only.
    for (const s of shops) assert.equal(mails(s.owner.email).length, 1, `one email to ${s.owner.email}`);
    const dMail = P.log().split('\n').filter((l) => l.includes(`to=${shops[3].owner.email}`) && l.includes('Early warning'))[0];
    assert.match(dMail, /subject=Early warning: Star Reviews changed its code on 3 stores/);
    assert.match(P.log(), /hasn't reached your store yet/);
    note(t, `Store d (not yet updated) was warned: ${JSON.stringify(d.earlyWarnings[0])}`);
  });

  it('warnings never reveal which other stores or accounts saw the change', async () => {
    for (const s of shops) {
      const body = JSON.stringify((await health(s)).earlyWarnings);
      for (const other of shops.filter((x) => x !== s)) assert.ok(!body.includes(other.owner.email) && !body.includes(`"storeId":${other.storeId}`), 'no other store or owner in the response');
      assert.doesNotMatch(body, /store_id|storeId|email|url/i);
    }
    const r = await shops[0].owner.get(`/api/stores/${shops[3].storeId}/apps`);
    assert.ok([403, 404].includes(r.status), 'another account\'s App health stays private');
  });

  it('a store is warned once per app: later changes in the same wave don\'t send it again', async () => {
    await check(shops[3]); // the update now reaches store d too: 4 stores changed
    for (const s of shops) {
      assert.equal((await health(s)).earlyWarnings.length, 1, `store ${s.name}`);
      assert.equal(mails(s.owner.email).length, 1, `still one email to ${s.owner.email}`);
    }
    assert.equal((await health(shops[3])).earlyWarnings[0].changedHere, true, 'store d now has the new code too');
  });

  it('App health shows the early warning at the top and marks the app', async (t) => {
    const s = shops[3];
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      await ctx.addCookies(s.owner.browserCookies());
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`${P.base}/app#/s/${s.storeId}/apps`);
      await p.waitForSelector('.notice.early-warning', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      const text = await p.textContent('.notice.early-warning');
      assert.match(text, /Early warning: Star Reviews changed its code on 3 stores we watch/);
      assert.match(text, /already on your store/);
      assert.match(await p.locator('tr.app-row', { hasText: 'Star Reviews' }).textContent(), /Changed on many stores/);
      await screenshot(t, p, 'App health with a cross-store early warning', { fullPage: true });
      assert.deepEqual(errors, []);
      note(t, text.trim());
    } finally { await browser.close(); }
  });
});
