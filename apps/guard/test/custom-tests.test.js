// Your tests: store-specific tests written as a file (JSON or YAML), checked, versioned, tried on demand,
// and run inside scheduled checks with results and alerts like the built-in checks.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, startMock, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

// A delivery (pincode) checker on the mock store's product pages (MOCK_EXTRA=pincheck): 5xxxxx is served.
const GOOD = `# Our own tests
tests:
  - name: Delivery checker works
    severity: major
    runs: full
    steps:
      - open: "{product}"
      - fill: "#pincode"
        value: "560001"
      - click: "text=Check"
      - expect_text: ".delivery-result"
        contains: "Delivery available"
  - name: Product can be added and the cart total is right
    severity: critical
    runs: journeys
    device: mobile
    steps:
      - open: /products/silk-saree
      - expect_price: ".price"
        equals: 8999
      - add_to_cart: true
      - expect_cart_items: 1
      - expect_cart_total: { min: 8999, max: 8999 }
      - open_cart: true
      - expect_count: "a[href*='/products/silk-saree']"
        min: 1
      - expect_no_errors: true
`;

const FAILING = `tests:
  - name: Delivery to Delhi
    severity: major
    runs: journeys
    fix: Check the delivery app's pincode list.
    steps:
      - open: "{product}"
      - fill: "#pincode"
        value: "110001"
      - click: "role=button:Check"
      - expect_text: ".delivery-result"
        contains: "Delivery available"
`;

const put = (s, id, body, type) => s.req('PUT', `/api/stores/${id}/custom-tests`, body, type ? { 'content-type': type } : {});

describe('Your tests (store-specific tests)', () => {
  let P, owner, storeId, mallory, browser;
  before(async () => {
    P = await startProduct({ mock: { extra: 'pincheck' } });
    owner = await signup(P, 'yours@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    mallory = await signup(P, 'mallory@yours.test');
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('a file with mistakes is refused with plain messages, and nothing is saved', async (t) => {
    const bad = `tests:
  - name: Broken one
    severity: urgent
    steps:
      - open: "https://other-site.example/"
      - click:
      - fill: "#pincode"
      - expect_price: ".price"
      - tap: "#x"
      - open: "{coupon}"
`;
    const r = await put(owner, storeId, bad, 'text/yaml');
    assert.equal(r.status, 400);
    const p = r.json.problems;
    const has = (re) => assert.ok(p.some((x) => re.test(x)), `expected a problem like ${re}; got:\n${p.join('\n')}`);
    has(/severity is critical, major or minor/);
    has(/step 1: tests stay on your own store/);
    has(/step 2: “click” needs a target/);
    has(/step 3: “fill” also needs “value:”/);
    has(/step 4: “expect_price” needs “equals:”/);
    has(/step 5: “tap” is not a step we know/);
    has(/step 6: “\{coupon\}” is not a value we know/);
    note(t, `${p.length} problems, for example: ${p[1]}`);
    const yamlErr = await put(owner, storeId, 'tests:\n  - name: x\n\tsteps: []\n', 'text/yaml');
    assert.equal(yamlErr.status, 400);
    assert.match(yamlErr.json.error, /Line 3: use spaces, not tabs/);
    const jsonErr = await put(owner, storeId, { text: '{"tests": [', format: 'json' });
    assert.equal(jsonErr.status, 400);
    assert.match(jsonErr.json.error, /not valid JSON/);
    const g = await owner.get(`/api/stores/${storeId}/custom-tests`);
    assert.equal(g.json.file, null);
    assert.equal(g.json.history.length, 0);
    assert.ok(g.json.example.includes('tests:'), 'an example file is offered');
  });

  it('a YAML file is saved as version 1 and downloads exactly as uploaded', async (t) => {
    const r = await put(owner, storeId, GOOD, 'text/yaml');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.file.version, 1);
    assert.equal(r.json.file.format, 'yaml');
    assert.deepEqual(r.json.file.tests.map((x) => x.id), ['custom.delivery-checker-works', 'custom.product-can-be-added-and-the-cart-total-is-right']);
    assert.deepEqual(r.json.file.tests[0].steps[2], { click: { text: 'Check' } });
    const d = await owner.get(`/api/stores/${storeId}/custom-tests?download=1`);
    assert.equal(d.status, 200);
    assert.match(d.headers.get('content-disposition'), /attachment; filename="tharam-tests-localhost-\d+-v1\.yaml"/);
    assert.equal(d.text, GOOD);
    note(t, `saved v1 with ${r.json.file.tests.length} tests; download is byte-for-byte the upload`);
  });

  it('every saved version is kept; saving the same file again adds nothing', async (t) => {
    const json = { tests: [{ name: 'Home has a search box', runs: 'journeys', steps: [{ open: '/' }, { expect_visible: 'a[href="/search"]' }] }] };
    const r2 = await put(owner, storeId, json);
    assert.equal(r2.status, 200, r2.text);
    assert.equal(r2.json.file.version, 2);
    assert.equal(r2.json.file.format, 'json');
    const same = await put(owner, storeId, json);
    assert.equal(same.json.unchanged, true);
    assert.equal(same.json.file.version, 2);
    const r3 = await put(owner, storeId, GOOD, 'text/yaml');
    assert.equal(r3.json.file.version, 3);
    const g = await owner.get(`/api/stores/${storeId}/custom-tests`);
    assert.deepEqual(g.json.history.map((h) => [h.version, h.format, h.tests]), [[3, 'yaml', 2], [2, 'json', 1], [1, 'yaml', 2]]);
    const v2 = await owner.get(`/api/stores/${storeId}/custom-tests?version=2`);
    assert.equal(v2.json.file.tests[0].name, 'Home has a search box');
    assert.equal((await owner.get(`/api/stores/${storeId}/custom-tests?version=9`)).status, 404);
    note(t, `history: ${g.json.history.map((h) => `v${h.version} (${h.format}, ${h.tests} tests)`).join(', ')}`);
  });

  it('limits: tests per plan, 25 steps per test, and only pages of the store itself', async (t) => {
    const g = await owner.get(`/api/stores/${storeId}/custom-tests`);
    assert.deepEqual(g.json.limits, { tests: 10, steps: 25 });
    const many = { tests: Array.from({ length: 11 }, (_, i) => ({ name: `Test ${i + 1}`, steps: [{ open: '/' }] })) };
    const r1 = await put(owner, storeId, many);
    assert.equal(r1.status, 400);
    assert.match(r1.json.error, /Your plan allows 10 of your own tests per store\. This file has 11/);
    const long = { tests: [{ name: 'Long', steps: Array.from({ length: 26 }, () => ({ open: '/' })) }] };
    const r2 = await put(owner, storeId, long);
    assert.equal(r2.status, 400);
    assert.match(r2.json.error, /has 26 steps; a test can have at most 25/);
    const off = await put(owner, storeId, { tests: [{ name: 'Elsewhere', steps: [{ open: '//evil.example/x' }] }] });
    assert.equal(off.status, 400);
    assert.match(off.json.error, /tests stay on your own store/);
    const g2 = await owner.get(`/api/stores/${storeId}/custom-tests`);
    assert.equal(g2.json.file.version, 3, 'refused files never become a version');
    note(t, '11 tests refused (plan allows 10), 26 steps refused (max 25), outside address refused; still on v3');
  });

  it('Try it now runs one test with a step-by-step trail and a screenshot of each step', async (t) => {
    const r = await owner.post(`/api/stores/${storeId}/custom-tests/${encodeURIComponent('Delivery checker works')}/try`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'pass', JSON.stringify(r.json.steps.map(({ image, ...x }) => x)));
    assert.equal(r.json.steps.length, 4);
    assert.match(r.json.steps[0].text, /^Open \/products\/[\w-]+$/);
    assert.deepEqual(r.json.steps.slice(1).map((s) => s.text), ['Type “560001” into “#pincode”', 'Click the text “Check”', 'Check “.delivery-result” says “Delivery available”']);
    assert.ok(r.json.steps.every((s) => s.status === 'pass' && /^data:image\/jpeg;base64,/.test(s.image)));
    // Show the trail as the owner would see it: each step and what the page looked like.
    const pg = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await pg.setContent(`<body style="font:14px system-ui;margin:16px"><h3>Try it now: ${r.json.test.name} — ${r.json.status}</h3><div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">${r.json.steps.map((s) => `<figure style="margin:0"><figcaption>${s.n}. ${s.text} · ${s.status} · ${s.ms} ms</figcaption><img src="${s.image}" style="width:100%;border:1px solid #ccc"></figure>`).join('')}</div></body>`);
    await screenshot(t, pg, 'Try it now trail', { fullPage: true });
    await pg.close();
    const by = await owner.post(`/api/stores/${storeId}/custom-tests/custom.delivery-checker-works/try`);
    assert.equal(by.json.status, 'pass', 'a test can also be named by its check id');
    assert.equal((await owner.post(`/api/stores/${storeId}/custom-tests/nope/try`)).status, 404);
    note(t, `pass in ${r.json.ms} ms: ${r.json.steps.map((s) => `${s.n}. ${s.text}`).join(' → ')}`);
  });

  it('a failing expectation is caught at its step, with the reason in plain words', async (t) => {
    const r = await owner.post(`/api/stores/${storeId}/custom-tests/${encodeURIComponent('Delivery to Delhi')}/try`, { text: FAILING });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'fail');
    const last = r.json.steps.at(-1);
    assert.equal(last.n, 4);
    assert.equal(last.status, 'fail');
    assert.match(r.json.message, /^Step 4 \(Check “\.delivery-result” says “Delivery available”\): “\.delivery-result” says “Sorry, we do not deliver to 110001”, not “Delivery available”\.$/);
    assert.ok(last.image, 'screenshot of the failed step');
    note(t, r.json.message);
  });

  it('a test that leaves the store is stopped', async (t) => {
    const text = 'tests:\n  - name: Partner link\n    steps:\n      - open: "{product}"\n      - click: "#partner-link"\n      - expect_visible: h1\n';
    const r = await owner.post(`/api/stores/${storeId}/custom-tests/Partner%20link/try`, { text });
    assert.equal(r.json.status, 'fail');
    assert.equal(r.json.steps.length, 2);
    assert.match(r.json.message, /Step 2 .*it left your store and opened 127\.0\.0\.1:\d+\. Tests stay on your own store/);
    note(t, r.json.message);
  });

  it('a full check runs the tests and reports them under Your tests; a failure has a screenshot and sends an alert', async (t) => {
    const file = GOOD + FAILING.replace(/^tests:\n/, '');
    const s = await put(owner, storeId, file, 'text/yaml');
    assert.equal(s.status, 200, s.text);
    const run = await runAndWait(owner, storeId, { groups: ['custom', 'policies'] });
    assert.equal(run.status, 'done', run.error || '');
    const res = run.result;
    const mine = res.checks.filter((c) => c.category === 'custom');
    assert.deepEqual(mine.map((c) => [c.id, c.status]), [
      ['custom.delivery-checker-works', 'pass'],
      ['custom.product-can-be-added-and-the-cart-total-is-right', 'pass'],
      ['custom.delivery-to-delhi', 'fail'],
    ]);
    const bad = mine[2];
    assert.equal(bad.severity, 'major');
    assert.equal(bad.fix, "Check the delivery app's pincode list.");
    assert.match(bad.evidence.screenshot, new RegExp(`^/shots/run-${run.id}/\\d+-yours-delivery-to-delhi\\.png$`));
    assert.equal((await owner.get(bad.evidence.screenshot)).status, 200, 'the owner can open the screenshot');
    assert.equal((await mallory.get(bad.evidence.screenshot)).status, 404, 'nobody else can');
    assert.equal(bad.evidence.steps.length, 4);
    const area = res.categories.find((c) => c.key === 'custom');
    assert.equal(area.label, 'Your tests');
    assert.equal(area.tested, true);
    const alert = P.db().prepare("SELECT * FROM alerts WHERE store_id = ? AND check_id = 'custom.delivery-to-delhi'").get(storeId);
    assert.equal(alert?.state, 'failing');
    assert.match(P.log(), /Check failed on Mock Store: Delivery to Delhi/);
    // The report in the app: "Your tests" area, the failed step and its screenshot button.
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const pg = await ctx.newPage();
    await pg.goto(`${P.base}/app#/s/${storeId}/reports/${run.id}`);
    await pg.waitForSelector('.rtabs button', { timeout: 20000 });
    await pg.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    const tab = pg.locator('.rtabs button').filter({ hasText: /areas|checks/i }).first();
    if (await tab.count()) await tab.click();
    const sec = pg.locator('details.area').filter({ hasText: 'Your tests' }).first();
    await sec.waitFor({ timeout: 10000 });
    await sec.evaluate((e) => { e.open = true; });
    assert.match(await sec.innerText(), /Delivery to Delhi[\s\S]*Step 4/);
    await sec.scrollIntoViewIfNeeded();
    await screenshot(t, pg, 'Report: Your tests area');
    await ctx.close();
    note(t, `run ${run.id} (${res.kind}): ${mine.map((c) => `${c.title} ${c.status}`).join('; ')}; alert '${alert.title}' recorded`);
  });

  it('a shopping check (journeys) runs only the tests marked "runs: journeys"', async (t) => {
    const run = await runAndWait(owner, storeId, { groups: ['custom'] });
    assert.equal(run.status, 'done', run.error || '');
    assert.equal(run.result.kind, 'journeys');
    const ids = run.result.checks.filter((c) => c.category === 'custom').map((c) => c.id);
    assert.deepEqual(ids, ['custom.product-can-be-added-and-the-cart-total-is-right', 'custom.delivery-to-delhi']);
    note(t, `journeys check ran: ${ids.join(', ')}`);
  });

  it('switching "Your tests" off in the test suite skips them', async () => {
    const run = await runAndWait(owner, storeId, { groups: ['journey.core'] });
    assert.equal(run.status, 'done', run.error || '');
    assert.equal(run.result.checks.filter((c) => c.category === 'custom').length, 0);
  });

  it('other accounts and visitors are refused', async (t) => {
    const urls = [
      ['GET', `/api/stores/${storeId}/custom-tests`], ['GET', `/api/stores/${storeId}/custom-tests?download=1`],
      ['PUT', `/api/stores/${storeId}/custom-tests`], ['POST', `/api/stores/${storeId}/custom-tests/Delivery%20checker%20works/try`],
    ];
    for (const [m, u] of urls) {
      assert.equal((await mallory.req(m, u, m === 'GET' ? undefined : { text: GOOD })).status, 404, `${m} ${u} (other account)`);
      assert.equal((await P.session().req(m, u, m === 'GET' ? undefined : { text: GOOD })).status, 401, `${m} ${u} (visitor)`);
    }
    const g = await owner.get(`/api/stores/${storeId}/custom-tests`);
    assert.equal(g.json.history.length, 4, 'nothing was saved by anyone else');
    note(t, `${urls.length} routes: other account 404, visitor 401`);
  });
});

describe('Your tests: the step runner and file reader', () => {
  let custom, mock, getBrowser;
  before(async () => {
    process.env.ALLOW_LOCAL_TARGETS = '1';
    process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-custom-'));
    custom = await import('../src/engine/custom.js');
    ({ getBrowser } = await import('../src/engine/browser.js'));
    mock = await startMock({ extra: 'pincheck' });
  });
  after(async () => { mock?.stop(); (await getBrowser()).close(); });

  it('a test is stopped at its time limit', async (t) => {
    const { tests } = custom.validate({ tests: [{ name: 'Slow', steps: [{ open: '/' }, { wait_for: '#never-there', timeout: 30 }] }] });
    const started = Date.now();
    const r = await custom.runTest(tests[0], { origin: mock.origin, timeMs: 4000 });
    const took = Date.now() - started;
    assert.equal(r.status, 'fail');
    assert.ok(took < 9000, `stopped after ${took} ms`);
    assert.match(r.message, /took longer than 4 seconds in total, so we stopped it/);
    note(t, `${r.message} (${took} ms)`);
  });

  it('a pincode that is refused by a broken delivery app fails the test', async () => {
    const broken = await startMock({ extra: 'pincheck', breaks: 'pincode' });
    try {
      const { tests } = custom.validate(custom.readFile(GOOD).doc);
      const r = await custom.runTest(tests[0], { origin: broken.origin });
      assert.equal(r.status, 'fail');
      assert.equal(r.failedStep, 4);
    } finally { broken.stop(); }
  });

  it('reads JSON and the YAML a test file needs, and prices in any common format', () => {
    const y = custom.readFile('tests:\n  - name: "A: quoted name" # comment\n    enabled: false\n    steps:\n      - open: /\n      - expect_count: ".card"\n        min: 2\n      - expect_cart_total: { equals: 12.5 }\n      - click: [1, 2]\n').doc;
    assert.deepEqual(y, { tests: [{ name: 'A: quoted name', enabled: false, steps: [{ open: '/' }, { expect_count: '.card', min: 2 }, { expect_cart_total: { equals: 12.5 } }, { click: [1, 2] }] }] });
    assert.equal(custom.readFile('{"tests": []}').format, 'json');
    assert.throws(() => custom.readFile('tests:\n  - name: x\n    steps: &a\n'), /Line 3: anchors/);
    assert.throws(() => custom.readFile('tests:\n  - name: |\n      text\n'), /Line 2: multi-line text blocks/);
    assert.throws(() => custom.readFile('   '), /The file is empty/);
    assert.throws(() => custom.readFile('x'.repeat(101 * 1024)), /larger than 100 KB/);
    for (const [s, n] of [['₹1,499.00', 1499], ['1.499,00 €', 1499], ['Rs. 999', 999], ['$12.50', 12.5], ['1 299,95 kr', 1299.95], ['From 2,500', 2500]]) assert.equal(custom.parsePrice(s), n, s);
    const v = custom.validate({ tests: [{ name: 'Dup', steps: [{ open: '/' }] }, { name: 'dup', steps: [{ open: '/' }] }] });
    assert.match(v.problems.join('\n'), /Test 2 \(“dup”\): another test \(test 1\) has the same name/);
  });
});
