// Your tests, part 3 (T84): the owner describes a test in words; AI opens the store page and drafts the steps in the
// test file format. The draft goes to the editor; nothing is saved until the owner saves. A fake AI stands in for the
// real one, so these tests never call an outside service.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, freePort } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';
import { startPath, cleanDescription } from '../src/custom-tests-draft.js';

const GOOD = { name: 'Delivery checker works', severity: 'major', device: 'desktop', steps: [{ open: '{product}' }, { fill: '#pincode', value: '560001' }, { click: '#pin-btn' }, { expect_text: '.delivery-result', contains: 'Delivery available' }], note: 'It uses pincode 560001; change it to one you deliver to.' };

/** A stand-in for the AI's messages API. Its answer depends on the owner's words; it remembers what it was sent. */
async function startFakeAi() {
  const port = await freePort();
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let b = '';
    for await (const c of req) b += c;
    const body = JSON.parse(b || '{}');
    const text = (body.messages?.[0]?.content || []).map((c) => c.text || '').join('\n');
    seen.push({ path: req.url, key: req.headers['x-api-key'], text, system: body.system });
    let answer = GOOD;
    if (/nonsense/.test(text)) answer = { name: 'Teleport', steps: [{ open: '{product}' }, { teleport: '#pincode' }, { click: '' }] };
    if (/impossible/.test(text)) answer = { name: '', steps: [], note: 'The store has no wishlist button on this page.' };
    if (/broken/.test(text)) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'overloaded' } })); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: `Here is the test:\n${JSON.stringify(answer)}` }], usage: { input_tokens: 10, output_tokens: 10 } }));
  });
  await new Promise((r) => server.listen(port, r));
  return { base: `http://localhost:${port}`, seen, stop: () => server.close() };
}

describe('Describe a test in words: the owner\'s input', () => {
  it('the start page is the test product, or a page of the store', () => {
    assert.equal(startPath(''), '{product}');
    assert.equal(startPath('{product}'), '{product}');
    assert.equal(startPath('/pages/contact'), '/pages/contact');
    assert.equal(startPath('https://shop.example/pages/faq?x=1'), '/pages/faq?x=1', 'a full link keeps only the page');
    assert.throws(() => startPath('//evil.example/x'), /Start the page with “\/”/);
    assert.throws(() => startPath('pages/contact'), /Start the page with “\/”/);
  });

  it('the description must say enough, and not too much', () => {
    assert.equal(cleanDescription('  Enter pincode 560001\n and check delivery  '), 'Enter pincode 560001 and check delivery');
    assert.throws(() => cleanDescription('test'), /Describe the test in a sentence or two/);
    assert.throws(() => cleanDescription('x'.repeat(700)), /under 600 characters/);
  });
});

describe('Describe a test in words: without an AI key', () => {
  let P, owner, storeId;
  before(async () => {
    P = await startProduct({ mock: { extra: 'pincheck' } });
    owner = await signup(P, 'noai@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
  });
  after(async () => { await P.stop(); });

  it('the feature is hidden and the draft route is not there', async (t) => {
    const g = await owner.get(`/api/stores/${storeId}/custom-tests`);
    assert.deepEqual(g.json.ai, { available: false });
    const r = await owner.post(`/api/stores/${storeId}/custom-tests/draft`, { description: 'Enter pincode 560001 and check delivery is available' });
    assert.equal(r.status, 404);
    note(t, `no AI key: ai=${JSON.stringify(g.json.ai)}, draft ${r.status} ${r.json.error}`);
  });
});

describe('Describe a test in words: AI drafts the steps', () => {
  let P, ai, owner, mallory, storeId, browser;
  before(async () => {
    ai = await startFakeAi();
    P = await startProduct({ mock: { extra: 'pincheck' }, env: { AI_API_KEY: 'fake-ai-key', AI_BASE_URL: ai.base, AI_PROVIDER: 'anthropic' } });
    owner = await signup(P, 'aidraft@shop.test');
    mallory = await signup(P, 'mallory@aidraft.test');
    storeId = await addStore(P, owner, { runNow: false });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); ai.stop(); });

  it('the AI gets an outline of the real page and its draft comes back as valid steps; nothing is saved', { timeout: 120000 }, async (t) => {
    const before = (await owner.get(`/api/stores/${storeId}/custom-tests`)).json;
    assert.equal(before.ai.available, true);
    const r = await owner.post(`/api/stores/${storeId}/custom-tests/draft`, { description: 'Enter pincode 560001 on a product page and check it says delivery available' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.test.name, 'Delivery checker works');
    assert.equal(r.json.test.runs, 'full');
    assert.deepEqual(r.json.test.steps.map((s) => Object.keys(s)[0]), ['open', 'fill', 'click', 'expect_text']);
    assert.match(r.json.note, /pincode 560001/);
    assert.equal(r.json.left, before.ai.left - 1, 'one draft used');
    const sent = ai.seen.at(-1);
    assert.equal(sent.key, 'fake-ai-key');
    assert.match(sent.text, /Enter pincode 560001 on a product page/);
    assert.match(sent.text, /Address: \/products\/cotton-kurta/);
    assert.match(sent.text, /Field: input.*#pincode.*label “Delivery pincode”/);
    assert.match(sent.text, /Button: “Check” #pin-btn/);
    assert.match(sent.system, /never invent selectors/);
    const afterGet = (await owner.get(`/api/stores/${storeId}/custom-tests`)).json;
    assert.equal(afterGet.file, null, 'nothing is saved by drafting');
    note(t, `draft: ${r.json.test.steps.length} steps; outline sent:\n${sent.text.split('The page outline:')[1].trim().split('\n').slice(0, 12).join('\n')}`);
  });

  it('an AI answer that breaks the test rules is refused politely; so is one that says it can\'t be done', { timeout: 120000 }, async (t) => {
    const bad = await owner.post(`/api/stores/${storeId}/custom-tests/draft`, { description: 'Do some nonsense with the pincode box please' });
    assert.equal(bad.status, 422);
    assert.match(bad.json.error, /didn't follow the test rules, so we didn't use it/);
    const no = await owner.post(`/api/stores/${storeId}/custom-tests/draft`, { description: 'Add to wishlist, which is impossible here' });
    assert.equal(no.status, 422);
    assert.match(no.json.error, /We couldn't draft this test: The store has no wishlist button on this page/);
    const down = await owner.post(`/api/stores/${storeId}/custom-tests/draft`, { description: 'Check the size guide opens, AI is broken now' });
    assert.equal(down.status, 502);
    assert.match(down.json.error, /could not draft the test just now/);
    note(t, `${bad.json.error} | ${no.json.error} | ${down.json.error}`);
  });

  it('bad input, other accounts and signed-out visitors are refused', async () => {
    const short = await owner.post(`/api/stores/${storeId}/custom-tests/draft`, { description: 'pincode' });
    assert.equal(short.status, 400);
    assert.match(short.json.error, /Describe the test in a sentence or two/);
    const off = await owner.post(`/api/stores/${storeId}/custom-tests/draft`, { description: 'Check the contact form shows a thank you', page: '//evil.example/steal' });
    assert.equal(off.status, 400);
    assert.equal((await mallory.post(`/api/stores/${storeId}/custom-tests/draft`, { description: 'Enter pincode 560001 and check delivery is available' })).status, 404);
    assert.equal((await P.session().post(`/api/stores/${storeId}/custom-tests/draft`, { description: 'Enter pincode 560001 and check delivery is available' })).status, 401);
  });

  it('in the editor: describe, draft, try it now and save', { timeout: 180000 }, async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    p.errors = [];
    p.on('pageerror', (e) => p.errors.push(e.message));
    await p.goto(`${P.base}/app#/s/${storeId}/tests/edit/new`);
    await p.waitForSelector('#yt-desc', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask').forEach((x) => x.remove()));
    await p.fill('#yt-desc', 'Enter pincode 560001 on a product page and check it says delivery available');
    await p.click('#yt-draft');
    await p.waitForSelector('#yt-ai-out .ok-n', { timeout: 60000 });
    assert.match(await p.locator('#yt-ai-out').innerText(), /Draft ready: 4 steps\. Check them, press Try it now, then save\. It uses pincode 560001/);
    assert.equal(await p.inputValue('#yt-name'), 'Delivery checker works');
    assert.equal(await p.locator('.yt-step').count(), 4);
    assert.equal(await p.inputValue('.yt-step >> nth=1 >> [data-f=arg]'), '#pincode');
    await screenshot(t, p, 'New test: steps drafted from a description');
    await p.evaluate(() => scrollTo(0, 0));
    await p.waitForTimeout(400);
    await screenshot(t, p, 'New test: describe it in words (AI)');
    await p.click('#yt-try');
    await p.waitForSelector('#yt-try-out .yt-try, #yt-try-out .notice', { timeout: 90000 });
    assert.match(await p.locator('#yt-try-out').innerText(), /Worked/);
    await p.click('#yt-save');
    await p.waitForFunction(() => !location.hash.includes('/edit/'), null, { timeout: 15000 });
    const saved = (await owner.get(`/api/stores/${storeId}/custom-tests`)).json.file;
    assert.equal(saved.tests[0].name, 'Delivery checker works');
    assert.equal(saved.tests[0].steps.length, 4);
    assert.deepEqual(p.errors, []);
    await ctx.close();
  });

  it('the editor for an existing test does not offer drafting', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    await p.goto(`${P.base}/app#/s/${storeId}/tests/edit/0`);
    await p.waitForSelector('#yt-name', { timeout: 20000 });
    assert.equal(await p.locator('#yt-desc').count(), 0);
    await ctx.close();
  });
});
