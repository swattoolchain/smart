/**
 * The submission check: the embedded Shopify app as a reviewer sees it, with production defaults
 * (every extra switched off, CSP in report-only), then with every extra switched on.
 * Every page must open with no script errors and no CSP reports; pages of switched-off extras must not
 * be reachable from the menus.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, shopifyOpen, shopifyToken, runAndWait, founderSession } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const SHOP = 'submission-check.myshopify.com';
const BASIC = ['', 'reports', 'publish', 'catalog', 'alerts', 'suite', 'settings', 'account', 'guide'];
const EXTRA = { sale: 'sale_report', apps: 'app_health', security: 'security_checklist', incident: 'incident_mode', sales: 'sale_plans', tests: 'custom_tests' };

describe('Submission check: the embedded app with production defaults', () => {
  let P, shop, browser;
  before(async () => {
    P = await startProduct({ env: { FEATURES_DEFAULT: '', CSP_MODE: '' } });
    shop = await shopifyOpen(P, SHOP);
    // Past the welcome steps and the tour, as a reviewer is after setting up.
    const done = await shop.patch(`/api/stores/${shop.storeId}`, { config: { onboarded: true, toured: true } });
    assert.equal(done.status, 200, done.text);
    await runAndWait(shop, shop.storeId, { kind: 'full' }, 300000);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P?.stop(); });

  async function openSection(section, problems) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${section || 'overview'}: script error: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource: the server responded with a status of 404/.test(m.text())) problems.push(`${section || 'overview'}: console: ${m.text()}`); });
    await page.exposeFunction('__cspReport', (v) => problems.push(`${section || 'overview'}: CSP would block ${v}`));
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => window.__cspReport(`${e.violatedDirective} ${e.blockedURI}`)));
    await page.route('https://cdn.shopify.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.shopify={idToken:async()=>${JSON.stringify(shopifyToken(SHOP, { expIn: 900 }))}};` }));
    await page.goto(`${P.base}/shopify${section ? '/' + section : ''}?shop=${SHOP}`);
    await page.waitForSelector('.main-inner h1', { timeout: 20000 });
    await page.waitForTimeout(800);
    return { page, ctx };
  }

  it('every page in the Shopify admin menu opens with no errors, and the menu shows only the basics', async (t) => {
    const nav = (await (await fetch(`${P.base}/shopify?shop=${SHOP}`)).text()).match(/<ui-nav-menu>[\s\S]*?<\/ui-nav-menu>/)?.[0] || '';
    for (const s of Object.keys(EXTRA)) assert.ok(!nav.includes(`/shopify/${s}"`), `no ${s} link in the Shopify menu while its feature is off`);
    const problems = [];
    for (const section of BASIC) {
      const { page, ctx } = await openSection(section, problems);
      await screenshot(t, page, `Default: ${section || 'overview'}`);
      await ctx.close();
    }
    assert.deepEqual(problems, [], problems.join('\n'));
    note(t, `menu: ${nav.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}; ${BASIC.length} pages opened with no script errors and no CSP reports`);
  });

  it('pages of switched-off extras fall back to the overview', async (t) => {
    const problems = [];
    for (const section of Object.keys(EXTRA)) {
      const { page, ctx } = await openSection(section, problems);
      const head = await page.textContent('h1').catch(() => '');
      assert.ok(!/Sale readiness|App health|Security checklist|Incident mode|Sale plans|Your tests/.test(head || ''), `${section} is hidden (got "${head}")`);
      await ctx.close();
    }
    assert.deepEqual(problems, [], problems.join('\n'));
    note(t, `${Object.keys(EXTRA).join(', ')}: each opens the overview while off`);
  });

  it('with every extra switched on, every page still opens with no errors', async (t) => {
    const founder = await founderSession(P);
    for (const f of (await founder.get('/api/admin/features')).json.features) if (f.key !== 'csp_enforce') await founder.patch(`/api/admin/features/${f.key}`, { on: true });
    const problems = [];
    for (const section of [...BASIC, ...Object.keys(EXTRA)]) {
      const { page, ctx } = await openSection(section, problems);
      if (EXTRA[section]) await screenshot(t, page, `All on: ${section}`);
      await ctx.close();
    }
    assert.deepEqual(problems, [], problems.join('\n'));
    note(t, 'all extras on: every menu page opened with no script errors and no CSP reports');
  });
});
