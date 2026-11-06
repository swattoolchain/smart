// Your tests, part 2: the test editor in the app (list with on/off, duplicate and delete; step builder; file tab;
// upload and download; Try it now with a screenshot of each step; version history and restore; help with examples).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait, shopifyOpen, shopifyToken } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';
import { parseYaml } from '../src/yaml-lite.js';

const FILE = `# Uploaded from my computer
tests:
  - name: Saree price is right
    severity: critical
    runs: journeys
    steps:
      - open: /products/silk-saree
      - expect_price: ".price"
        equals: 8999
`;

describe('Your tests: the test editor', () => {
  let P, owner, storeId, mallory, browser, tmp;
  const api = (u) => `/api/stores/${storeId}/custom-tests${u || ''}`;
  const current = async () => (await owner.get(api())).json;
  async function page(hash, { width = 1280, height = 900 } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    p.errors = [];
    p.on('pageerror', (e) => p.errors.push(e.message));
    await p.goto(`${P.base}/app#/s/${storeId}/tests${hash || ''}`);
    await p.waitForSelector('h1', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask').forEach((x) => x.remove()));
    return p;
  }

  before(async () => {
    P = await startProduct({ mock: { extra: 'pincheck' } });
    owner = await signup(P, 'editor@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    mallory = await signup(P, 'mallory@editor.test');
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-editor-'));
  });
  after(async () => { await browser?.close(); await P.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('with no tests yet, the page offers a new test, examples and upload; the side menu has Your tests', async (t) => {
    const p = await page();
    await p.waitForSelector('text=No tests of your own yet');
    assert.equal(await p.locator('#side a[href$="/tests"]').innerText(), 'Your tests');
    assert.equal(await p.locator('#side a[href$="/tests"]').getAttribute('aria-current'), 'page');
    assert.match(await p.locator('.page-head').innerText(), /0 of 10 tests on your plan/);
    await screenshot(t, p, 'Your tests: empty');
    assert.deepEqual(p.errors, []);
    await p.context().close();
  });

  it('a test built in the form is tried before saving (a screenshot of each step), then saved as YAML', async (t) => {
    const p = await page('/edit/new');
    await p.fill('#yt-name', 'Delivery checker works');
    await p.selectOption('#yt-sev', 'major');
    await p.selectOption('#yt-dev', 'mobile');
    await p.fill('#yt-fix', 'Check the delivery app.');
    // Step 1 is "Open a page: {product}". Add three more.
    const addStep = async (kind, fields) => {
      await p.click('#yt-add');
      const last = p.locator('.yt-step').last();
      await last.locator('[data-f=kind]').selectOption(kind);
      const step = p.locator('.yt-step').last();
      for (const [f, v] of Object.entries(fields)) await step.locator(`[data-f="${f}"]`).fill(v);
    };
    await addStep('fill', { arg: '#pincode', value: '560001' });
    await addStep('click', { arg: 'text=Check' });
    await addStep('expect_text', { arg: '.delivery-result', contains: 'Delivery available' });
    assert.equal(await p.locator('.yt-step').count(), 4);
    // Reorder with the arrows: move step 4 up and back down.
    await p.click('[data-up="3"]');
    assert.equal(await p.locator('.yt-step').nth(2).locator('[data-f=kind]').inputValue(), 'expect_text');
    await p.click('[data-down="2"]');
    assert.equal(await p.locator('.yt-step').nth(3).locator('[data-f=kind]').inputValue(), 'expect_text');
    // Drag and drop moves a step too: drag step 2 onto step 3, then back.
    await p.locator('.yt-step').nth(1).dragTo(p.locator('.yt-step').nth(2));
    assert.equal(await p.locator('.yt-step').nth(2).locator('[data-f=kind]').inputValue(), 'fill', 'dragged step 2 to place 3');
    await p.locator('.yt-step').nth(2).dragTo(p.locator('.yt-step').nth(1));
    assert.equal(await p.locator('.yt-step').nth(1).locator('[data-f=kind]').inputValue(), 'fill');
    await screenshot(t, p, 'Step builder: a new test', { fullPage: true });

    await p.click('#yt-try');
    await p.waitForSelector('.yt-try', { timeout: 90000 });
    assert.match(await p.locator('.yt-try-head').innerText(), /Worked[\s\S]*All 4 steps worked/);
    assert.equal(await p.locator('.yt-shots figure').count(), 4);
    assert.equal(await p.locator('.yt-shots img').count(), 4, 'a screenshot for each step');
    await p.locator('.yt-try').scrollIntoViewIfNeeded();
    await screenshot(t, p, 'Try it now from the form (not saved yet)', { fullPage: true });
    assert.equal((await current()).file, null, 'trying does not save');

    await p.click('#yt-save');
    await p.waitForSelector('table.yt-list', { timeout: 15000 });
    const d = await current();
    assert.equal(d.file.version, 1);
    assert.equal(d.file.format, 'yaml');
    assert.deepEqual(d.file.tests[0], {
      name: 'Delivery checker works', id: 'custom.delivery-checker-works', severity: 'major', runs: 'full', device: 'mobile', enabled: true, fix: 'Check the delivery app.',
      steps: [{ open: '{product}' }, { fill: { css: '#pincode' }, value: '560001' }, { click: { text: 'Check' } }, { expect_text: { css: '.delivery-result' }, contains: 'Delivery available' }],
    });
    // The saved file is readable YAML, written in the short forms a person would type.
    assert.match(d.file.text, /- fill: "#pincode"\n {8}value: "560001"\n {6}- click: "text=Check"/);
    assert.deepEqual(parseYaml(d.file.text).tests[0].steps[2], { click: 'text=Check' });
    assert.deepEqual(p.errors, []);
    note(t, `built in the form, tried (4 steps, 4 screenshots), saved as v1:\n${d.file.text}`);
    await p.context().close();
  });

  it('the form shows the same plain messages as the file, and saves nothing on a mistake', async (t) => {
    const p = await page('/edit/0');
    await p.click('#yt-add');
    await p.locator('.yt-step').last().locator('[data-f=kind]').selectOption('fill');
    await p.locator('.yt-step').last().locator('[data-f=arg]').fill('#pincode');
    await p.click('#yt-save');
    await p.waitForSelector('#yt-err .notice');
    assert.match(await p.locator('#yt-err').innerText(), /step 5: “fill” also needs “value:”/);
    await screenshot(t, p, 'Step builder: a mistake explained');
    assert.equal((await current()).file.version, 1, 'nothing saved');
    // API: tests from the form with a mistake are refused the same way.
    const bad = await owner.req('PUT', api(), { tests: [{ name: 'x', steps: [{ tap: '#a' }] }], format: 'yaml' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.problems[0], /“tap” is not a step we know/);
    note(t, 'form: "step 5: fill also needs value:"; API refuses form tests with the same messages');
    await p.context().close();
  });

  it('the list shows each test with its last result and run time; on/off, duplicate and delete each save a new version', async (t) => {
    const run = await runAndWait(owner, storeId, { groups: ['custom', 'policies'] });
    assert.equal(run.status, 'done', run.error || '');
    const d0 = await current();
    assert.equal(d0.results['custom.delivery-checker-works'].status, 'pass');
    assert.ok(d0.results['custom.delivery-checker-works'].ms > 0, 'run time recorded');
    const p = await page();
    await p.waitForSelector('table.yt-list');
    const row = p.locator('table.yt-list tbody tr').first();
    assert.match(await row.innerText(), /Delivery checker works[\s\S]*Major · daily full check · mobile · 4 steps[\s\S]*Passed[\s\S]*took \d+\.\d s/);

    await p.click('[data-dup="0"]');
    await p.waitForSelector('text=Delivery checker works (copy)');
    let d = await current();
    assert.equal(d.file.version, 2);
    assert.deepEqual(d.file.tests.map((x) => x.name), ['Delivery checker works', 'Delivery checker works (copy)']);
    assert.deepEqual(d.file.tests[1].steps, d.file.tests[0].steps, 'the copy has the same steps');

    await p.locator('[data-toggle="1"]').click({ force: true });
    await p.waitForFunction(() => document.querySelectorAll('table.yt-list tr.off').length === 1);
    d = await current();
    assert.equal(d.file.version, 3);
    assert.equal(d.file.tests[1].enabled, false);
    assert.match(d.file.text, /enabled: false/);
    await screenshot(t, p, 'Your tests: list with last result, one test off');

    await p.click('[data-del="1"]');
    await p.click('dialog.confirm button[value=yes]');
    await p.waitForFunction(() => !document.body.innerText.includes('(copy)'));
    d = await current();
    assert.equal(d.file.version, 4);
    assert.deepEqual(d.file.tests.map((x) => x.name), ['Delivery checker works']);
    assert.equal(d.history.length, 4, 'deleting keeps every earlier version');
    assert.equal((await owner.get(api('?version=3'))).json.file.tests.length, 2, 'the deleted test is still in version 3');

    // Try it now from the list.
    await p.click('[data-try="0"]');
    await p.waitForSelector('#yt-try-0 .yt-try', { timeout: 90000 });
    assert.equal(await p.locator('#yt-try-0 .yt-shots img').count(), 4);
    await screenshot(t, p, 'Try it now from the list', { fullPage: true });
    assert.deepEqual(p.errors, []);
    note(t, `last result from run ${run.id}: pass in ${d0.results['custom.delivery-checker-works'].ms} ms; duplicate v2, off v3, delete v4 (history ${d.history.length})`);
    await p.context().close();
  });

  it('upload and download round trip; the File tab saves with the same checks', async (t) => {
    const p = await page();
    const up = path.join(tmp, 'my-tests.yaml');
    fs.writeFileSync(up, FILE);
    await p.setInputFiles('#yt-file', up);
    await p.waitForSelector('text=Saree price is right', { timeout: 15000 });
    let d = await current();
    assert.equal(d.file.version, 5);
    assert.equal(d.file.text, FILE, 'saved exactly as uploaded, comments and all');

    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#yt-download')]);
    assert.match(dl.suggestedFilename(), /^tharam-tests-.+-v5\.yaml$/);
    const got = fs.readFileSync(await dl.path(), 'utf8');
    assert.equal(got, FILE, 'download is byte for byte what was uploaded');

    // A file with mistakes is refused, nothing saved, and the problems are listed.
    const bad = path.join(tmp, 'bad.yaml');
    fs.writeFileSync(bad, 'tests:\n  - name: Oops\n    steps:\n      - click:\n      - fly: "#x"\n');
    await p.setInputFiles('#yt-file', bad);
    await p.waitForSelector('dialog .yt-problems');
    assert.match(await p.locator('dialog').innerText(), /step 1: “click” needs a target[\s\S]*step 2: “fly” is not a step we know/);
    await screenshot(t, p, 'Upload refused: the mistakes listed');
    await p.click('dialog [data-close]');
    assert.equal((await current()).file.version, 5);

    // File tab: edit the text and save.
    await p.goto(`${P.base}/app#/s/${storeId}/tests/file`);
    await p.waitForSelector('#yt-text');
    assert.equal(await p.inputValue('#yt-text'), FILE);
    await p.fill('#yt-text', FILE.replace('equals: 8999', 'equals: 8990'));
    await p.click('#yt-save');
    await p.waitForFunction(() => /version 6/i.test(document.body.innerText));
    d = await current();
    assert.equal(d.file.tests[0].steps[1].equals, 8990);
    await p.fill('#yt-text', 'tests:\n\t- name: x\n');
    await p.click('#yt-save');
    await p.waitForSelector('#yt-err .notice');
    assert.match(await p.locator('#yt-err').innerText(), /Line 2: use spaces, not tabs/);
    await screenshot(t, p, 'File tab: a mistake explained');
    assert.equal((await current()).file.version, 6);
    // A JSON file stays JSON when edited in the form.
    const json = { tests: [{ name: 'Home opens', steps: [{ open: '/' }, { expect_visible: 'h1' }] }] };
    assert.equal((await owner.req('PUT', api(), JSON.stringify(json, null, 2), { 'content-type': 'application/json' })).status, 200);
    const j = await owner.req('PUT', api(), { tests: [{ name: 'Home opens', device: 'mobile', steps: [{ open: '/' }, { expect_visible: 'h1' }] }], format: 'json' });
    assert.equal(j.json.file.format, 'json');
    assert.equal(JSON.parse(j.json.file.text).tests[0].device, 'mobile');
    note(t, 'uploaded v5, downloaded identical; bad upload refused; File tab saved v6; JSON stays JSON');
    await p.context().close();
  });

  it('History lists every version; restoring an old one saves it as the newest', async (t) => {
    const before = await current();
    const p = await page('/history');
    await p.waitForSelector('[data-restore="1"]');
    assert.equal(await p.locator('tbody tr').count(), before.history.length);
    await p.click('[data-view="1"]');
    await p.waitForSelector('#yt-view pre');
    assert.match(await p.locator('#yt-view').innerText(), /Version 1[\s\S]*Delivery checker works/);
    await p.click('[data-restore="1"]');
    await p.click('dialog.confirm button[value=yes]');
    await p.waitForFunction((n) => document.querySelectorAll('tbody tr').length === n, before.history.length + 1);
    const d = await current();
    assert.equal(d.file.version, before.file.version + 1);
    assert.equal(d.file.text, (await owner.get(api('?version=1'))).json.file.text, 'the restored file is version 1, exactly');
    assert.equal(d.history.length, before.history.length + 1, 'nothing was removed from the history');
    await screenshot(t, p, 'History after restoring version 1', { fullPage: true });
    assert.equal((await owner.post(api('/restore'), { version: 999 })).status, 404);
    assert.deepEqual(p.errors, []);
    note(t, `restored v1 as v${d.file.version}; ${d.history.length} versions kept`);
    await p.context().close();
  });

  it('Help explains the steps with three worked examples that can be added in one click', async (t) => {
    const p = await page('/help');
    await p.waitForSelector('.yt-example');
    assert.equal(await p.locator('.yt-example').count(), 3);
    assert.match(await p.locator('.main-inner').innerText(), /Example 1: Delivery checker[\s\S]*Example 2: Size guide opens[\s\S]*Example 3: Two in the cart/);
    await screenshot(t, p, 'Help and examples', { fullPage: true });
    // Each example is a valid test.
    await p.locator('[data-ex="1"]').click();
    await p.waitForSelector('#yt-form');
    assert.equal(await p.inputValue('#yt-name'), 'Size guide opens');
    const d = await current();
    assert.ok(d.file.tests.some((x) => x.name === 'Size guide opens'));
    note(t, '3 examples; "Size guide opens" added and opened in the editor');
    await p.context().close();
  });

  it('works inside Shopify admin with no extra login: menu item, list, download', async (t) => {
    const shop = 'editor-embedded.myshopify.com';
    const s = await shopifyOpen(P, shop);
    // An owner who has finished the welcome steps.
    assert.equal((await s.patch(`/api/stores/${s.storeId}`, { config: { onboarded: true, toured: true } })).status, 200);
    const put = await s.req('PUT', `/api/stores/${s.storeId}/custom-tests`, FILE, { 'content-type': 'text/yaml' });
    assert.equal(put.status, 200, put.text);
    const html = await (await fetch(`${P.base}/shopify?shop=${shop}`)).text();
    assert.match(html, /<ui-nav-menu>.*<a href="\/shopify\/tests">Your tests<\/a>/);
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 }, acceptDownloads: true });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.route('https://cdn.shopify.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.shopify={idToken:async()=>${JSON.stringify(shopifyToken(shop, { expIn: 600 }))}};` }));
    await p.goto(`${P.base}/shopify/tests?shop=${shop}`);
    await p.waitForSelector('table.yt-list', { timeout: 20000 });
    assert.match(location(p), new RegExp(`#/s/${s.storeId}/tests$`));
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask').forEach((x) => x.remove()));
    assert.match(await p.locator('table.yt-list').innerText(), /Saree price is right/);
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#yt-download')]);
    assert.equal(fs.readFileSync(await dl.path(), 'utf8'), FILE, 'download works with the Shopify session (no cookies)');
    await screenshot(t, p, 'Your tests inside Shopify admin');
    assert.deepEqual(errors, []);
    note(t, 'embedded: /shopify/tests opens the list; download uses the session token');
    await ctx.close();
  });

  it('other accounts are refused', async (t) => {
    const r = [
      await mallory.get(api()),
      await mallory.req('PUT', api(), { tests: [{ name: 'x', steps: [{ open: '/' }] }], format: 'yaml' }),
      await mallory.post(api('/restore'), { version: 1 }),
      await mallory.get(api('?version=1&download=1')),
    ];
    assert.deepEqual(r.map((x) => x.status), [404, 404, 404, 404]);
    const d = await current();
    assert.ok(!d.file.tests.some((x) => x.name === 'x'), 'nothing changed');
    note(t, 'GET, PUT from the form, restore and download: 404 for another account');
  });
});

const location = (p) => p.url();
