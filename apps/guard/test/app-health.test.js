// App Health (T22): one row per app or service on the storefront: pages it loads on, what it costs on a phone,
// script errors it causes, code changes, outside sites it talks to, apps that stopped loading, and Tharam's own
// footprint. Built from the script watch records of recent checks.
// Part 2 (T63): app widgets that should show but don't, and app code that changed at the same address.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const APP_NAMES = 'reviews-app.localhost=Star Reviews,chat-app.localhost=Live Chat,chat-api.localhost=Live Chat';
const APP_WIDGETS = 'Star Reviews=.reviews-widget';
process.env.APP_NAMES = APP_NAMES;
process.env.APP_WIDGETS = APP_WIDGETS;
const { appFor, errorSource, resetAppMap, widgetMap, missingWidgets } = await import('../src/engine/apps.js');

const QUICK = ['journey.core', 'journey.checkout', 'security.scripts', 'errors.js'];
const app = (d, name) => d.apps.find((a) => a.name === name);

async function openPage(P, owner, storeId, fn) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#/s/${storeId}/apps`);
    await p.waitForSelector('.main-inner h1, .main-inner h2', { timeout: 20000 });
    await p.waitForFunction(() => document.querySelector('.app-us'), null, { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    await fn(p);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

describe('App Health', () => {
  let P, owner, other, storeId;
  const toggle = (q) => fetch(`${P.mock.origin}/__extra?${q}`).then((r) => r.json());
  const health = async () => { const r = await owner.get(`/api/stores/${storeId}/apps`); assert.equal(r.status, 200, r.text); return r.json; };
  const check = async (body) => { const r = await runAndWait(owner, storeId, body); assert.equal(r.status, 'done', r.error || ''); return r; };
  before(async () => {
    P = await startProduct({ env: { APP_NAMES, APP_WIDGETS }, mock: { extra: 'apps' } });
    owner = await signup(P, 'apps@shop.test');
    other = await signup(P, 'someone-else@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
  });
  after(async () => { await P?.stop(); });

  it('names apps from their address, Shopify app folders, the theme and the APP_NAMES setting', () => {
    resetAppMap();
    const store = 'shop.example';
    assert.deepEqual(appFor('https://static.klaviyo.com/onsite/js/klaviyo.js', store), { key: 'klaviyo', name: 'Klaviyo', kind: 'app' });
    assert.equal(appFor('https://connect.facebook.net/en_US/fbevents.js', store).name, 'Meta (Facebook) pixel');
    assert.equal(appFor('https://www.googletagmanager.com/gtag/js', store).kind, 'tracking');
    const ext = appFor('https://cdn.shopify.com/extensions/0193a1b2-aaaa-bbbb-cccc-123456789abc/judge-me-reviews-260/assets/widget.js', store);
    assert.deepEqual(ext, { key: 'ext:0193a1b2-aaaa-bbbb-cccc-123456789abc', name: 'Judge Me Reviews', kind: 'app' });
    assert.equal(appFor('https://shop.example/cdn/shop/extensions/0193a1b2-aaaa-bbbb-cccc-123456789abc/judge-me-reviews-261/assets/x.js', store).key, ext.key, 'same app across versions and CDNs');
    assert.equal(appFor('https://shop.example/cdn/shop/t/12/assets/global.js', store).kind, 'theme');
    assert.equal(appFor('https://cdn.shopify.com/s/files/1/0001/t/12/assets/global.js', store).kind, 'theme');
    assert.equal(appFor('https://cdn.shopify.com/shopifycloud/portable-wallets/latest/app.js', store).name, 'Shopify');
    assert.deepEqual(appFor('https://widgets.unknownapp.io/w.js', store), { key: 'site:unknownapp.io', name: 'unknownapp.io', kind: 'unknown' });
    assert.equal(appFor('https://cdn.example.co.uk/a.js', store).name, 'example.co.uk');
    assert.equal(appFor('http://reviews-app.localhost:4100/apps/reviews.js', store).name, 'Star Reviews', 'APP_NAMES');
    assert.equal(appFor('http://chat-api.localhost:4100/ping.gif', store).key, appFor('http://chat-app.localhost:4100/apps/chat.js', store).key, 'two hosts, one app');
    assert.equal(appFor('https://tharam.store/x.js', store).kind, 'tharam');
    assert.equal(errorSource({ stack: 'TypeError: x\n    at reviewsInit (http://reviews-app.localhost:4100/apps/reviews.js?shop=1:1:60123)' }), 'http://reviews-app.localhost:4100/apps/reviews.js');
    assert.equal(errorSource({ stack: 'TypeError: x\n    at <anonymous>:1:5' }), null);
  });

  it('before any check: an empty page that still shows Tharam adds nothing to the store', async (t) => {
    const d = await health();
    assert.equal(d.runId, null);
    assert.deepEqual(d.apps, []);
    assert.equal(d.tharam.scripts, 0);
    await openPage(P, owner, storeId, async (p) => {
      assert.match(await p.textContent('.main-inner'), /No apps recorded yet/);
      assert.match(await p.textContent('.app-us'), /No code on your store/);
      await screenshot(t, p, 'App health before the first check');
    });
  });

  it('a check lists each app with its pages, phone cost and outside sites; Tharam has no footprint', async (t) => {
    const r = await check({ groups: [...QUICK, 'speed'] });
    const d = await health();
    const reviews = app(d, 'Star Reviews');
    const chat = app(d, 'Live Chat');
    assert.ok(reviews && chat, JSON.stringify(d.apps.map((a) => a.name)));
    assert.deepEqual(reviews.pages, ['cart', 'home', 'product']);
    assert.deepEqual(chat.pages, ['home'], 'the chat app only loads on the home page');
    assert.equal(reviews.kind, 'app');
    assert.ok(reviews.phone.bytes > 55000 && reviews.phone.bytes < 90000, `reviews script is ~60 KB per page on the phone (got ${reviews.phone.bytes})`);
    assert.deepEqual(Object.keys(reviews.phone.byPage).sort(), ['home', 'product'], 'measured on the phone home and product pages');
    assert.ok(reviews.phone.slowS >= 0.2);
    assert.ok(chat.sites.some((h) => h.startsWith('chat-api.localhost')), 'the chat app talks to its own server');
    assert.ok(d.apps.some((a) => a.kind === 'theme'), 'the theme has its own row');
    assert.equal(reviews.status, 'ok');
    assert.equal(d.compared, false);
    assert.ok(d.phone && d.phone.pages.includes('home'));
    assert.equal(d.totals.errors, 0);
    assert.ok(d.totals.phoneBytes >= reviews.phone.bytes);
    assert.equal(d.tharam.scripts, 0);
    assert.equal(d.tharam.bytes, 0);
    assert.equal(d.tharam.visits7d, 1);
    assert.deepEqual(reviews.widget, { pages: ['cart', 'home', 'product'], missingOn: [] }, 'the reviews widget was seen on every page the app loads on');
    assert.equal(chat.widget, null, 'no known widget for the chat app: not checked');
    const w = r.result.checks.find((c) => c.id === 'sec.scripts.widgets');
    assert.equal(w?.status, 'pass');
    assert.equal(w.notice, true);
    assert.deepEqual(reviews.changes.updated, []);
    note(t, `Apps: ${d.apps.map((a) => `${a.name} (${a.pages.join('/')}, ${a.phone.bytes} bytes on phone)`).join('; ')}`);
  });

  it('a script error and new code are traced to the app that caused them', async (t) => {
    await toggle('appsbug=1&appsupdate=1');
    try {
      const r = await check({ groups: QUICK });
      const js = r.result.checks.find((c) => c.id === 'nf.jserrors');
      assert.notEqual(js.status, 'pass', 'the error shows in the normal JavaScript errors check too');
      const d = await health();
      const reviews = app(d, 'Star Reviews');
      assert.equal(reviews.status, 'errors');
      assert.ok(reviews.errors.length >= 1);
      assert.match(reviews.errors[0].message, /reading 'load'/);
      assert.match(reviews.errors[0].source, /reviews-app\.localhost:\d+\/apps\/reviews\.js$/);
      assert.ok(reviews.changes.added.some((u) => u.endsWith('/apps/reviews-photos.js')), 'new script file from the app');
      assert.ok(reviews.changes.lastChangedAt, 'last code change dated');
      assert.equal(app(d, 'Live Chat').status, 'ok');
      assert.equal(app(d, 'Live Chat').errors.length, 0, 'other apps are not blamed');
      assert.ok(reviews.phone.bytes > 0, 'phone cost kept from the last full check');
      assert.equal(d.compared, true);
      assert.equal(d.apps[0].name, 'Star Reviews', 'apps causing errors come first');
      await openPage(P, owner, storeId, async (p) => {
        const row = p.locator('tr.app-row[data-app="star-reviews"]');
        assert.match(await row.textContent(), /Causing errors/);
        assert.match(await p.textContent('.notice'), /Star Reviews.*causing script errors/);
        assert.match(await p.textContent('.apps-table'), /reviews-photos\.js/);
        assert.match(await p.textContent('.app-us'), /No code on your store/);
        await screenshot(t, p, 'App health with an app causing errors', { fullPage: true });
      });
      note(t, `Star Reviews: ${reviews.errors[0].message}; new code ${reviews.changes.added.join(', ')}`);
    } finally { await toggle('appsbug=0&appsupdate=0'); }
  });

  it('an app that stops loading is flagged as missing', async (t) => {
    await toggle('apps=0');
    try {
      await check({ groups: QUICK });
      const d = await health();
      for (const name of ['Star Reviews', 'Live Chat']) {
        const a = app(d, name);
        assert.equal(a?.status, 'missing', name);
        assert.ok(a.lastSeenAt);
      }
      assert.equal(app(d, 'Live Chat').pages.join(), 'home');
      await openPage(P, owner, storeId, async (p) => {
        assert.match(await p.textContent('.notice'), /stopped loading/);
        assert.equal(await p.locator('tr.app-row.status-missing').count(), 2);
        await screenshot(t, p, 'App health with apps that stopped loading', { fullPage: true });
      });
      note(t, 'Both apps disappeared from the store: shown as "Stopped loading" with where they used to run');
    } finally { await toggle('apps=1'); }
  });

  it('back to normal: the apps return as new, nothing is missing', async () => {
    await check({ groups: QUICK });
    const d = await health();
    assert.equal(app(d, 'Star Reviews').status, 'new');
    assert.ok(!d.apps.some((a) => a.status === 'missing' || a.status === 'errors'));
    assert.equal(d.tharam.visits7d, 4);
  });

  it('knows which apps draw a widget, and on which pages it should show', () => {
    resetAppMap();
    const w = widgetMap();
    assert.equal(w.get('judge-me-reviews').name, 'Judge.me Reviews');
    assert.deepEqual(w.get('judge-me-reviews').pages, ['product'], 'review stars are expected on product pages only');
    assert.equal(w.get('intercom').pages, null, 'a chat bubble is expected wherever the app loads');
    assert.equal(w.get('star-reviews').selector, '.reviews-widget', 'APP_WIDGETS setting');
    const inv = (pages) => ({ storeHost: 'shop.example', pages: Object.fromEntries(pages.map((p) => [p, { scripts: [{ key: 'k', url: 'https://cdn.judge.me/widget.js' }], sites: [] }])) });
    assert.deepEqual(missingWidgets(inv(['home', 'product']), { product: ['judge-me-reviews'] }).missing, [], 'not expected on the home page');
    assert.deepEqual(missingWidgets(inv(['home', 'product']), {}).missing, [{ key: 'judge-me-reviews', name: 'Judge.me Reviews', pages: ['product'] }]);
    assert.deepEqual(missingWidgets(inv(['home']), {}), { checked: [], missing: [] }, 'loads only on the home page: nothing to check');
    assert.deepEqual(missingWidgets({ storeHost: 'shop.example', pages: { product: { scripts: [{ key: 'x', url: 'https://static.klaviyo.com/k.js' }], sites: [] } } }, {}).checked, [], 'apps without a known widget are not checked');
  });

  it('new code at the same address is reported as a code change, with no new-script alert', async (t) => {
    await toggle('appscode=1');
    try {
      const r = await check({ groups: QUICK });
      assert.equal(r.result.checks.find((c) => c.id === 'sec.scripts.new').status, 'pass', 'same files: no new script');
      const d = await health();
      const reviews = app(d, 'Star Reviews');
      assert.equal(reviews.status, 'changed');
      assert.equal(reviews.changes.updated.length, 1);
      assert.match(reviews.changes.updated[0], /reviews-app\.localhost:\d+\/apps\/reviews\.js$/);
      assert.deepEqual(reviews.changes.added, []);
      assert.equal(reviews.changes.lastChangedAt, d.checkedAt, 'last code change is this check');
      assert.equal(app(d, 'Live Chat').status, 'ok', 'the chat app did not change');
      assert.deepEqual(app(d, 'Live Chat').changes.updated, []);
      await openPage(P, owner, storeId, async (p) => {
        const row = p.locator('tr.app-row[data-app="star-reviews"]');
        assert.match(await row.textContent(), /Code changed/);
        assert.match(await p.textContent('.apps-table'), /Code updated at the same address: .*reviews\.js/);
        await screenshot(t, p, 'App health: app code changed at the same address', { fullPage: true });
      });
      note(t, `Star Reviews changed ${reviews.changes.updated.join(', ')} without a new file name: shown as "Code changed"`);
    } finally { await toggle('appscode=0'); }
  });

  it('an app that loads but whose widget shoppers don\'t see is flagged "Widget missing"', async (t) => {
    await toggle('appsnowidget=1');
    try {
      const r = await check({ groups: QUICK });
      const c = r.result.checks.find((x) => x.id === 'sec.scripts.widgets');
      assert.equal(c.status, 'fail');
      assert.equal(c.severity, 'major');
      assert.equal(c.notice, true, 'a notice: the score is unchanged');
      assert.match(c.detail, /Star Reviews loads on the cart page, home page and product page, but shoppers don't see its widget/);
      assert.match(c.fix, /App embeds/);
      const d = await health();
      const reviews = app(d, 'Star Reviews');
      assert.equal(reviews.status, 'widget');
      assert.deepEqual(reviews.widget.missingOn, ['cart', 'home', 'product']);
      assert.equal(d.apps[0].name, 'Star Reviews', 'listed first');
      assert.equal(app(d, 'Live Chat').status, 'ok');
      await openPage(P, owner, storeId, async (p) => {
        assert.match(await p.locator('tr.app-row[data-app="star-reviews"]').textContent(), /Widget missing/);
        assert.match(await p.textContent('.notice'), /Star Reviews loads, but shoppers don't see its widget/);
        assert.match(await p.textContent('.apps-table'), /shoppers don't see its widget there/);
        await screenshot(t, p, 'App health with a missing app widget', { fullPage: true });
      });
      note(t, c.detail);
    } finally { await toggle('appsnowidget=0'); }
    const r = await check({ groups: QUICK });
    assert.equal(r.result.checks.find((x) => x.id === 'sec.scripts.widgets').status, 'pass', 'widget back: the check passes again');
    assert.deepEqual(app(await health(), 'Star Reviews').widget.missingOn, []);
  });

  it('other accounts and signed-out visitors are refused', async () => {
    assert.ok([403, 404].includes((await other.get(`/api/stores/${storeId}/apps`)).status));
    assert.ok([401, 403].includes((await P.session().get(`/api/stores/${storeId}/apps`)).status));
  });
});
