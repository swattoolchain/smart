// A/B test results in App health (T109, T106 part 4): the tools found, each test version checked (listed by the
// owner or found by Tharam) and the last result per version, on the App health page. Behind the "ab_tests" switch.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait, founderSession } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const GROUPS = ['journey.core', 'sale.abtest', 'security.scripts'];

describe('A/B test results on App health', () => {
  let P, owner, other, founder, storeId, run;
  const health = async (s = owner) => s.get(`/api/stores/${storeId}/apps`);
  before(async () => {
    P = await startProduct({ mock: { extra: 'convert' } });
    owner = await signup(P, 'ab-health@shop.test');
    other = await signup(P, 'ab-health-other@shop.test');
    founder = await founderSession(P);
    storeId = await addStore(P, owner, { runNow: false });
    run = await runAndWait(owner, storeId, { groups: GROUPS }, 300000);
  });
  after(async () => { await P?.stop(); });

  it('shows the tool found, both Convert versions as found by Tharam, and the broken one', async (t) => {
    assert.equal(run.status, 'done', run.error || '');
    const r = await health();
    assert.equal(r.status, 200, r.text);
    const ab = r.json.abTests;
    assert.ok(ab, 'A/B section is present');
    assert.deepEqual(ab.tools, ['Convert']);
    assert.equal(ab.found, 2);
    assert.equal(ab.listed, 0);
    assert.equal(ab.failing, 1);
    const orig = ab.versions.find((v) => /Original/.test(v.name));
    const sticky = ab.versions.find((v) => /Sticky buy bar/.test(v.name));
    assert.equal(orig.ok, true);
    assert.equal(orig.source, 'found');
    assert.equal(orig.tool, 'Convert');
    assert.equal(sticky.ok, false);
    assert.match(sticky.problems.join(' '), /Add to cart did nothing/);
    note(t, `Tools: ${ab.tools.join(', ')}; ${ab.found} found by Tharam, ${ab.listed} listed; ${ab.failing} failing (${sticky.name}).`);
  });

  it('keeps versions the owner listed apart from the ones Tharam found', async (t) => {
    const set = await owner.patch(`/api/stores/${storeId}`, { config: { abVariants: [{ name: 'Control', kind: 'param', value: 'ab_variant=a' }] } });
    assert.ok(set.status < 300, set.text);
    const r2 = await runAndWait(owner, storeId, { groups: GROUPS }, 300000);
    assert.equal(r2.status, 'done', r2.error || '');
    const ab = (await health()).json.abTests;
    const listed = ab.versions.filter((v) => v.source === 'listed');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'Control');
    assert.ok(ab.found >= 2, 'found versions still counted');
    note(t, `${ab.listed} listed, ${ab.found} found, ${ab.versions.length} rows in all.`);
  });

  it('is the owner’s own: other accounts are refused', async () => {
    assert.equal((await health(other)).status, 404);
  });

  it('shows the A/B tests panel on the App health page', async (t) => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
      await ctx.addCookies(owner.browserCookies());
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`${P.base}/app#/s/${storeId}/apps`);
      await p.waitForSelector('.ab-panel', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      assert.ok(await p.locator('.ab-row.bad', { hasText: 'Sticky buy bar' }).count(), 'broken version is marked');
      assert.ok(await p.locator('.ab-row.ok').count(), 'working version is marked');
      assert.match(await p.locator('.ab-panel').innerText(), /Found by Tharam/);
      await p.locator('.ab-panel').scrollIntoViewIfNeeded();
      await screenshot(t, p, 'App health: A/B tests, tool found and last result per version');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  it('is hidden while the A/B switch is off', async (t) => {
    const off = await founder.patch('/api/admin/features/ab_tests', { on: false });
    assert.equal(off.status, 200, off.text);
    try {
      const r = await health();
      assert.equal(r.status, 200);
      assert.equal(r.json.abTests, null);
    } finally { await founder.patch('/api/admin/features/ab_tests', { on: true }); }
    note(t, 'With the switch off, App health has no A/B section.');
  });
});
