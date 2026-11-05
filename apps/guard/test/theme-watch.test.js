// Theme file fingerprints (S3): every file of a Shopify store's live theme is fingerprinted on each full check;
// changed files are reported once with the changed lines; publishing a new theme starts a new record.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, shopifyOpen, shopifyToken, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';
import { diffLines } from '../src/theme-watch.js';

const find = (run, id) => run.result.checks.find((c) => c.id === id);
const mails = (P, re) => (P.log().match(new RegExp(`\\[mail skipped\\] to=[^\\n]* subject=[^\\n]*${re}`, 'g')) || []).length;
const waitMail = async (P, re, n = 1) => { const until = Date.now() + 5000; while (mails(P, re) < n && Date.now() < until) await new Promise((r) => setTimeout(r, 100)); return mails(P, re); };

const LAYOUT = '<!doctype html>\n<html>\n<head>\n{{ content_for_header }}\n</head>\n<body>\n{{ content_for_layout }}\n</body>\n</html>';
const BASE = { 'layout/theme.liquid': LAYOUT, 'sections/header.liquid': '<header>{{ shop.name }}</header>', 'assets/global.js': 'console.log(1);', 'config/settings_data.json': '{"current":{}}', 'assets/logo.png': null };

describe('Theme code changes', () => {
  let P, owner, storeId, changedRun;
  const files = (f) => P.fake.control({ themeFiles: f });
  const full = async () => {
    const r = await runAndWait(owner, storeId, { groups: ['security.theme'] });
    assert.equal(r.status, 'done', r.error || '');
    return r;
  };
  before(async () => {
    P = await startProduct();
    owner = await shopifyOpen(P, 'theme-watch.myshopify.com');
    storeId = owner.storeId;
    await files(BASE);
    // Alerts go to an address we can see in the mail log.
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { alertEmail: 'owner@theme-watch.test' })).status, 200);
  });
  after(async () => { await P?.stop(); });

  it('the first full check records every file of the live theme', async (t) => {
    const r = await full();
    const c = find(r, 'sec.theme');
    assert.equal(c?.status, 'pass', c?.detail);
    assert.equal(c.detail, 'First record of your live theme “Dawn”: 5 files. We\'ll tell you when any of them changes.');
    const rows = P.db().prepare('SELECT filename, checksum, content FROM theme_files WHERE store_id = ? ORDER BY filename').all(storeId);
    assert.equal(rows.length, 5, 'all files, across pages of the API');
    assert.ok(rows.every((x) => /^[0-9a-f]{32}$/.test(x.checksum)));
    assert.equal(rows.find((x) => x.filename === 'layout/theme.liquid').content, LAYOUT, 'text kept to show changed lines later');
    assert.equal(rows.find((x) => x.filename === 'assets/logo.png').content, null, 'images are fingerprinted, not stored');
    note(t, c.detail);
  });

  it('nothing changed: passes quietly', async () => {
    const r = await full();
    assert.equal(find(r, 'sec.theme').status, 'pass');
    assert.match(find(r, 'sec.theme').detail, /^All 5 files of “Dawn” are the same as at the last check\.$/);
  });

  it('changed, new and deleted files are reported once, with the changed lines', async (t) => {
    const { 'assets/global.js': _gone, ...rest } = BASE;
    await files({ ...rest,
      'layout/theme.liquid': LAYOUT.replace('</head>', '<script src="https://cdn.reviews-app.example/widget.js"></script>\n</head>'),
      'sections/header.liquid': '<header class="site">{{ shop.name }}</header>',
      'snippets/promo.liquid': '<p>Free shipping</p>\n<p>Over ₹999</p>',
      'assets/logo.png': null,
    });
    const r = changedRun = await full();
    const c = find(r, 'sec.theme');
    assert.equal(c.status, 'fail');
    assert.equal(c.severity, 'major');
    assert.equal(c.detail, '4 files of your live theme “Dawn” changed since the last check: layout/theme.liquid (+1 line), sections/header.liquid (+1 −1 lines), snippets/promo.liquid (added), assets/global.js (removed).');
    const byName = Object.fromEntries(c.evidence.files.map((f) => [f.filename, f]));
    assert.deepEqual(byName['layout/theme.liquid'].lines, [{ t: '+', n: 5, s: '<script src="https://cdn.reviews-app.example/widget.js"></script>' }]);
    assert.deepEqual(byName['sections/header.liquid'].lines.map((l) => l.t), ['-', '+']);
    assert.equal(byName['snippets/promo.liquid'].added, 2);
    assert.deepEqual(byName['assets/global.js'].lines, [{ t: '-', n: 1, s: 'console.log(1);' }]);
    assert.match(c.fix, /If you, your developer or an app you trust made this change, there is nothing to do/);
    assert.notEqual(r.verdict, 'critical');
    assert.equal(await waitMail(P, 'Check failed on [^\\n]*Theme code unchanged'), 1, 'one alert email');
    note(t, c.detail);
  });

  it('the report shows each changed file and its lines', async (t) => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      // Inside Shopify admin, as the store owner sees it.
      const shop = 'theme-watch.myshopify.com';
      assert.equal((await owner.patch(`/api/stores/${storeId}`, { config: { onboarded: true, toured: true } })).status, 200);
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await p.route('https://cdn.shopify.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.shopify={idToken:async()=>${JSON.stringify(shopifyToken(shop, { expIn: 600 }))}};` }));
      await p.goto(`${P.base}/shopify?shop=${shop}#/s/${storeId}/reports/${changedRun.id}`);
      await p.waitForSelector('[data-rtab=areas]', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      await p.click('[data-rtab=areas]');
      const row = p.locator('tr[data-check="sec.theme"]').first();
      await row.waitFor({ timeout: 10000 });
      assert.equal(await row.locator('.theme-diff details').count(), 4);
      assert.match(await row.textContent(), /reviews-app\.example\/widget\.js/);
      await row.scrollIntoViewIfNeeded();
      await screenshot(t, p, 'Theme code changes with the changed lines');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  it('the next check without changes passes, with no "fixed" email', async () => {
    const r = await full();
    assert.equal(find(r, 'sec.theme').status, 'pass');
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(mails(P, 'Fixed on [^\\n]*Theme code unchanged'), 0);
  });

  it('added mining or skimming code is named first, with an urgent fix', async (t) => {
    const cur = { ...BASE, 'layout/theme.liquid': LAYOUT.replace('</body>', '<script src="https://coinhive.com/lib/coinhive.min.js"></script>\n</body>') };
    delete cur['assets/global.js'];
    await files({ ...cur, 'sections/header.liquid': '<header class="site">{{ shop.name }}</header>', 'snippets/promo.liquid': '<p>Free shipping</p>\n<p>Over ₹999</p>' });
    const r = await full();
    const c = find(r, 'sec.theme');
    assert.equal(c.status, 'fail');
    assert.match(c.detail, /^The new code includes code from coinhive\.com, a site known for stealing card details or mining\. 1 file of your live theme/);
    assert.match(c.fix, /^Remove that code now/);
    note(t, `${c.detail}\nFix: ${c.fix}`);
  });

  it('if Shopify can\'t be reached the check is skipped and the record kept, so the change shows next time', async () => {
    await P.fake.control({ themeError: true });
    await files({ ...BASE });
    const r = await full();
    assert.equal(find(r, 'sec.theme').status, 'skip');
    assert.match(find(r, 'sec.theme').detail, /couldn’t read your theme files from Shopify/);
    assert.equal(r.status, 'done', 'the rest of the check still runs');
    await P.fake.control({ themeError: false });
    const r2 = await full();
    assert.equal(find(r2, 'sec.theme').status, 'fail', 'the change made while Shopify was unreachable is still reported');
  });

  it('publishing a different theme starts a new record without an alert', async () => {
    const before = mails(P, 'Theme code unchanged');
    await P.fake.control({ mainTheme: { id: 'gid://shopify/OnlineStoreTheme/333', name: 'Dawn – Black Friday' } });
    await files({ ...BASE, 'sections/sale.liquid': '<div>Sale</div>' });
    const r = await full();
    const c = find(r, 'sec.theme');
    assert.equal(c.status, 'pass');
    assert.equal(c.detail, 'You published a new theme, “Dawn – Black Friday”. We recorded its 6 files and will tell you when any of them changes.');
    assert.equal(P.db().prepare('SELECT theme_id FROM theme_watch WHERE store_id = ?').get(storeId).theme_id, '333');
    assert.equal(P.db().prepare('SELECT COUNT(*) n FROM theme_files WHERE store_id = ?').get(storeId).n, 6);
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(mails(P, 'Theme code unchanged'), before);
  });

  it('switching the group off stops it; website stores (no Shopify connection) never run it', async () => {
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { config: { disabled: ['security.theme'] } })).status, 200);
    const r = await runAndWait(owner, storeId, { kind: 'full' }); // the store's own suite, not a hand-picked one
    assert.equal(r.status, 'done', r.error || '');
    assert.equal(r.result.kind, 'full');
    assert.ok(!r.result.checks.some((c) => c.id === 'sec.theme'));
    assert.equal((await owner.patch(`/api/stores/${storeId}`, { config: { disabled: [] } })).status, 200);
    const web = await signup(P, 'theme-web@shop.test');
    const webStore = await addStore(P, web, { runNow: false });
    const w = await runAndWait(web, webStore, { groups: ['security.theme'] });
    assert.equal(w.status, 'done');
    assert.ok(!w.result.checks.some((c) => c.id === 'sec.theme'));
  });

  it('changed lines: a line-by-line comparison', () => {
    assert.deepEqual(diffLines('a\nb\nc', 'a\nb\nc'), []);
    assert.deepEqual(diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne'), [{ t: '-', n: 2, s: 'b' }, { t: '+', n: 2, s: 'B' }, { t: '+', n: 5, s: 'e' }]);
    assert.deepEqual(diffLines('x', ''), [{ t: '-', n: 1, s: 'x' }, { t: '+', n: 1, s: '' }]);
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    const d = diffLines(big, big.replace('line 1500', 'line 1500 changed'));
    assert.deepEqual(d, [{ t: '-', n: 1501, s: 'line 1500' }, { t: '+', n: 1501, s: 'line 1500 changed' }]);
  });
});
