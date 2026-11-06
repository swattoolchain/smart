// Your tests, part 4 (T85): ready-made templates for common store features. Each is a test in the file format with
// blanks the owner can fill in (defaults suit most themes); added in one click from Your tests → Templates.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startMock, startProduct, signup, addStore } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';
import { parseYaml } from '../src/yaml-lite.js';

process.env.ALLOW_LOCAL_TARGETS = '1';
process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-templates-'));
const { TEMPLATES, testFromTemplate, templateValues, checkTemplates, freeName, templateList } = await import('../src/custom-test-templates.js');
const { validate, runTest } = await import('../src/engine/custom.js');
const { getBrowser } = await import('../src/engine/browser.js');

const checked = (test) => { const v = validate({ tests: [test] }, { tests: 1 }); assert.deepEqual(v.problems, []); return v.tests[0]; };

describe('Test templates: the gallery', () => {
  it('has the features owners asked for, and every template passes the file rules with its defaults', (t) => {
    assert.deepEqual(TEMPLATES.map((x) => x.key), ['pincode', 'cod', 'size-guide', 'store-locator', 'gift-card', 'subscription', 'reviews', 'wishlist', 'newsletter', 'chat', 'switcher']);
    assert.deepEqual(checkTemplates(), []);
    for (const x of TEMPLATES) {
      assert.ok(x.why.length > 40 && x.fill.length, `${x.key} explains itself and has blanks`);
      assert.ok(x.fill.every((f) => f.kind === 'flag' || f.default), `${x.key}: every blank has a default`);
    }
    note(t, TEMPLATES.map((x) => `${x.title}: ${x.fill.map((f) => f.label).join(', ')}`).join(' | '));
  });

  it('fills in the owner\'s values, and keeps defaults for blanks left empty', () => {
    const tst = testFromTemplate('pincode', { pincode: '400001', result: '' });
    assert.deepEqual(tst.steps, [{ open: '{product}' }, { fill: '#pincode', value: '400001' }, { click: 'text=Check' }, { expect_text: '.delivery-result', contains: 'Delivery available' }]);
    assert.equal(tst.runs, 'full');
    assert.equal(testFromTemplate('cod', { words: 'COD available' }).steps[1].expect_visible, 'text=COD available');
  });

  it('the newsletter template only looks at the form unless the owner ticks the box', () => {
    assert.deepEqual(testFromTemplate('newsletter').steps.map((s) => Object.keys(s)[0]), ['open', 'expect_visible']);
    const real = testFromTemplate('newsletter', { submit: true });
    assert.deepEqual(real.steps.map((s) => Object.keys(s)[0]), ['open', 'fill', 'click', 'expect_visible']);
    assert.equal(real.steps[1].value, 'tharam-test@example.com');
    assert.equal(testFromTemplate('newsletter').submitSteps, undefined, 'the inner list never reaches the file');
  });

  it('refuses values that would break the file, with a plain message; unknown templates are 404', () => {
    const tpl = TEMPLATES[0];
    assert.throws(() => templateValues(tpl, { pincode: '5600\n01' }), /must be on one line/);
    assert.throws(() => templateValues(tpl, { field: '[[x]]' }), /can’t contain \[\[/);
    assert.throws(() => templateValues(tpl, { ok: 'x'.repeat(300) }), /too long/);
    assert.throws(() => testFromTemplate('nope'), (e) => e.status === 404);
  });

  it('a second copy gets its own name; the app gets each template with its steps', () => {
    assert.equal(freeName('Size guide opens', [{ name: 'Size guide opens' }]), 'Size guide opens (2)');
    assert.equal(freeName('Size guide opens', []), 'Size guide opens');
    const list = templateList();
    assert.equal(list.length, TEMPLATES.length);
    assert.ok(list.every((x) => x.test.steps.length && x.fill.length));
  });
});

describe('Test templates on a store', { concurrency: 1 }, () => {
  after(async () => { (await getBrowser()).close(); });

  it('the delivery checker, size guide, cash on delivery and a real newsletter sign-up work on a store that has them', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'pincheck,features' });
    try {
      for (const [key, values] of [['pincode', {}], ['size-guide', { link: 'text=Size guide' }], ['cod', {}], ['newsletter', { submit: true }], ['reviews', {}], ['wishlist', {}]]) {
        const r = await runTest(checked(testFromTemplate(key, values)), { origin: mock.origin });
        note(t, `${key}: ${r.status}${r.message ? `: ${r.message}` : ''}`);
        assert.equal(r.status, 'pass', `${key}: ${r.message}`);
      }
    } finally { mock.stop(); }
  });

  it('the same templates fail on a store without those features, at the right step', { timeout: 180000 }, async (t) => {
    const mock = await startMock({ extra: 'pincheck', breaks: 'pincode' });
    try {
      const pin = await runTest(checked(testFromTemplate('pincode')), { origin: mock.origin });
      note(t, `pincode (broken delivery app): ${pin.status}: ${pin.message}`);
      assert.equal(pin.status, 'fail');
      assert.equal(pin.failedStep, 4);
      const size = await runTest(checked(testFromTemplate('size-guide')), { origin: mock.origin });
      note(t, `size guide (none on the page): ${size.status}: ${size.message}`);
      assert.equal(size.status, 'fail');
      assert.equal(size.failedStep, 2);
    } finally { mock.stop(); }
  });
});

describe('Test templates in the product', () => {
  let P, owner, mallory, storeId, browser;
  before(async () => {
    P = await startProduct({ mock: { extra: 'pincheck,features' } });
    owner = await signup(P, 'templates@shop.test');
    mallory = await signup(P, 'mallory@templates.test');
    storeId = await addStore(P, owner, { runNow: false });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  async function page(hash) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    p.errors = [];
    p.on('pageerror', (e) => p.errors.push(e.message));
    await p.goto(`${P.base}/app#/s/${storeId}/tests${hash}`);
    await p.waitForSelector('h1', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask').forEach((x) => x.remove()));
    return p;
  }

  it('adding a template saves it as a new version of the file, with the owner\'s values', async (t) => {
    const g = await owner.get(`/api/stores/${storeId}/custom-tests`);
    assert.equal(g.json.templates.length, TEMPLATES.length);
    const r = await owner.post(`/api/stores/${storeId}/custom-tests/templates/pincode`, { values: { pincode: '560034' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.name, 'Delivery checker works');
    assert.equal(r.json.index, 0);
    const again = await owner.post(`/api/stores/${storeId}/custom-tests/templates/pincode`, { values: {} });
    assert.equal(again.json.name, 'Delivery checker works (2)', 'a second copy gets its own name');
    const file = (await owner.get(`/api/stores/${storeId}/custom-tests`)).json.file;
    assert.equal(file.version, 2);
    assert.equal(file.format, 'yaml');
    const doc = parseYaml(file.text);
    assert.equal(doc.tests[0].steps[1].value, '560034');
    assert.equal(doc.tests[1].steps[1].value, '560001');
    note(t, `saved file v${file.version}:\n${file.text}`);
  });

  it('bad values, unknown templates, other accounts and the plan limit are refused plainly', async () => {
    const bad = await owner.post(`/api/stores/${storeId}/custom-tests/templates/cod`, { values: { words: 'two\nlines' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /must be on one line/);
    assert.equal((await owner.post(`/api/stores/${storeId}/custom-tests/templates/teleport`, {})).status, 404);
    assert.equal((await mallory.post(`/api/stores/${storeId}/custom-tests/templates/cod`, {})).status, 404);
    assert.equal((await P.session().post(`/api/stores/${storeId}/custom-tests/templates/cod`, {})).status, 401);
    const limit = (await owner.get(`/api/stores/${storeId}/custom-tests`)).json.limits.tests;
    let last;
    for (let i = 3; i <= limit; i++) last = await owner.post(`/api/stores/${storeId}/custom-tests/templates/reviews`, {});
    assert.equal(last.status, 200);
    const over = await owner.post(`/api/stores/${storeId}/custom-tests/templates/reviews`, {});
    assert.equal(over.status, 403);
    assert.match(over.json.error, /Your plan allows \d+ of your own tests per store/);
    // Back to two tests for the screens below.
    const cur = (await owner.get(`/api/stores/${storeId}/custom-tests`)).json.file;
    assert.equal((await owner.post(`/api/stores/${storeId}/custom-tests/restore`, { version: 2 })).status, 200);
    assert.equal((await owner.get(`/api/stores/${storeId}/custom-tests`)).json.file.tests.length, 2, `restored from v${cur.version}`);
  });

  it('Your tests → Templates: fill in a blank and add in one click; the editor opens on the new test', { timeout: 120000 }, async (t) => {
    const p = await page('/templates');
    await p.waitForSelector('.yt-tpl', { timeout: 20000 });
    assert.equal(await p.locator('.yt-tpl').count(), TEMPLATES.length);
    const card = p.locator('.yt-tpl[data-tpl="size-guide"]');
    await card.locator('summary').click();
    await card.locator('[data-v=link]').fill('text=Size guide');
    await card.scrollIntoViewIfNeeded();
    await screenshot(t, p, 'Your tests: templates');
    await card.locator('[data-add]').click();
    await p.waitForSelector('#yt-name', { timeout: 15000 });
    assert.equal(await p.inputValue('#yt-name'), 'Size guide opens');
    assert.equal(await p.inputValue('.yt-step >> nth=1 >> [data-f=arg]'), 'text=Size guide');
    await p.click('#yt-try');
    await p.waitForSelector('#yt-try-out .yt-try, #yt-try-out .notice', { timeout: 90000 });
    assert.match(await p.locator('#yt-try-out').innerText(), /Worked/);
    await screenshot(t, p, 'Template added and tried');
    assert.equal((await owner.get(`/api/stores/${storeId}/custom-tests`)).json.file.tests.length, 3);
    assert.deepEqual(p.errors, []);
    await p.context().close();
  });

  it('the empty Your tests page points to the templates', async () => {
    const other = await signup(P, 'empty@templates.test');
    const sid = await addStore(P, other, { runNow: false });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(other.browserCookies());
    const p = await ctx.newPage();
    await p.goto(`${P.base}/app#/s/${sid}/tests`);
    await p.waitForSelector('text=No tests of your own yet', { timeout: 20000 });
    assert.equal(await p.locator('a', { hasText: 'Start from a template' }).getAttribute('href'), `#/s/${sid}/tests/templates`);
    await ctx.close();
  });
});
