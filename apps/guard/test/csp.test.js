// Content-Security-Policy: every page type sends one, and every page still works under it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { startProduct, signup, shopifyOpen, shopifyToken } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';
import { inlineScriptHashes, policy } from '../src/csp.js';

const directives = (h) => Object.fromEntries(String(h || '').split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [k, ...v] = x.split(/\s+/); return [k, v]; }));

describe('Content-Security-Policy', () => {
  let P, owner, browser;
  before(async () => {
    P = await startProduct();
    owner = await signup(P, 'csp@shop.test');
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  /** A page that records every policy violation and script error. */
  async function open(url, { cookies = [], shop } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    if (cookies.length) await ctx.addCookies(cookies);
    const p = await ctx.newPage();
    p.violations = []; p.errors = [];
    await p.exposeFunction('__cspViolation', (v) => p.violations.push(v));
    await p.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => window.__cspViolation(`${e.violatedDirective} ${e.blockedURI}`)));
    p.on('pageerror', (e) => p.errors.push(e.message));
    p.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) p.violations.push(m.text()); });
    if (shop) await p.route('https://cdn.shopify.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.shopify={idToken:async()=>${JSON.stringify(shopifyToken(shop, { expIn: 600 }))}};` }));
    const res = await p.goto(P.base + url);
    p.csp = res.headers()['content-security-policy'];
    return p;
  }

  it('inline scripts are allowed by their exact hash, script tags with src are not hashed', () => {
    const html = '<script>a()</script><script src="/x.js"></script><script type="module">b()</script>';
    const want = (s) => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;
    assert.deepEqual(inlineScriptHashes(html), [want('a()'), want('b()')]);
    const d = directives(policy({ kind: 'site', hashes: [want('a()')] }));
    assert.ok(d['script-src'].includes(want('a()')));
    assert.ok(!d['script-src'].includes("'unsafe-inline'") && !d['script-src'].includes("'unsafe-eval'"));
    assert.deepEqual(d['object-src'], ["'none'"]);
    assert.deepEqual(d['script-src-attr'], ["'none'"]);
  });

  it('every page type sends a policy with no unsafe scripts', async (t) => {
    const s = await shopifyOpen(P, 'csp-headers.myshopify.com');
    const pages = ['/', '/de', '/pricing', '/features', '/checks', '/demo', '/privacy', '/scan/1', '/app', '/no-such-page', '/shopify?shop=csp-headers.myshopify.com'];
    for (const u of pages) {
      const r = await fetch(P.base + u);
      const d = directives(r.headers.get('content-security-policy'));
      assert.ok(d['script-src'], `${u} has a script policy`);
      assert.ok(!d['script-src'].includes("'unsafe-inline'"), `${u}: no unsafe-inline scripts`);
      assert.deepEqual(d['default-src'], ["'self'"], u);
      assert.deepEqual(d['base-uri'], ["'self'"], u);
      if (u.startsWith('/shopify')) {
        assert.deepEqual(d['frame-ancestors'], ['https://admin.shopify.com', 'https://csp-headers.myshopify.com'], 'Shopify admin and the shop may frame the app');
        assert.ok(d['script-src'].includes('https://cdn.shopify.com'), 'App Bridge allowed');
        assert.equal(r.headers.get('x-frame-options'), null);
      } else {
        assert.deepEqual(d['frame-ancestors'], ["'self'"], u);
        assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN', u);
      }
    }
    // A shop name that isn't a Shopify shop is not added to frame-ancestors.
    const bad = directives((await fetch(`${P.base}/shopify?shop=evil.example.com`)).headers.get('content-security-policy'));
    assert.deepEqual(bad['frame-ancestors'], ['https://admin.shopify.com']);
    // API answers carry the strict policy too.
    const api = directives((await s.get('/api/me')).headers.get('content-security-policy'));
    assert.deepEqual(api['script-src'], ["'self'"]);
    note(t, `${pages.length} page types checked: script-src without unsafe-inline, frame-ancestors per page type`);
  });

  it('website pages run their own scripts with no violations', async (t) => {
    for (const u of ['/', '/de', '/pricing', '/features', '/checks', '/demo', '/privacy', '/scan/999999', '/no-such-page']) {
      const p = await open(u);
      await p.waitForLoadState('networkidle');
      assert.deepEqual(p.violations, [], `${u}: ${p.violations.join(', ')}`);
      assert.deepEqual(p.errors, [], `${u}: ${p.errors.join(', ')}`);
      if (u === '/') {
        // The free-check form is wired by the inline site script.
        await p.click('#check-form button');
        assert.match(await p.textContent('#check-err'), /Enter your store address/);
        await screenshot(t, p, 'Home: free check form still answers under the policy');
      }
      if (u === '/pricing') {
        const before = await p.textContent('.price .pp');
        await p.locator('input[name=bill][value=y]').check({ force: true });
        assert.notEqual(await p.textContent('.price .pp'), before, 'monthly/yearly switch works');
        await screenshot(t, p, 'Pricing: yearly switch works under the policy');
      }
      if (u === '/scan/999999') {
        await p.waitForSelector('text=Report not found');
        await screenshot(t, p, 'Free check report page runs its script');
      }
      if (u === '/demo') await screenshot(t, p, 'Demo booking page');
      await p.context().close();
    }
    note(t, '9 website pages loaded in Chromium with no policy violations and no script errors');
  });

  it('the app works under the policy', async (t) => {
    const p = await open('/app', { cookies: owner.browserCookies() });
    await p.waitForSelector('#main', { timeout: 20000 });
    await p.waitForLoadState('networkidle');
    for (const h of ['#/account', '#/account/billing']) {
      await p.evaluate((x) => { location.hash = x; }, h);
      await p.waitForTimeout(800);
    }
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    await screenshot(t, p, 'App: plans page under the policy', { fullPage: true });
    assert.deepEqual(p.violations, [], p.violations.join(', '));
    assert.deepEqual(p.errors, [], p.errors.join(', '));
  });

  it('the app inside Shopify admin loads App Bridge and opens with no violations', async (t) => {
    const shop = 'csp-embedded.myshopify.com';
    const p = await open(`/shopify?shop=${shop}`, { shop });
    await p.waitForFunction(() => !document.getElementById('emb-loading') && document.querySelector('#main'), null, { timeout: 30000 });
    await p.waitForTimeout(800);
    assert.ok(await p.evaluate(() => window.THARAM_EMBEDDED === true), 'inline embedded flag ran');
    await screenshot(t, p, 'Embedded app under the policy', { fullPage: true });
    assert.deepEqual(p.violations, [], p.violations.join(', '));
    assert.deepEqual(p.errors, [], p.errors.join(', '));
  });

  it('an injected inline script or event handler is blocked and reported', async (t) => {
    const p = await open('/');
    await p.waitForLoadState('networkidle');
    await p.evaluate(() => {
      const s = document.createElement('script'); s.textContent = 'window.__pwned = 1'; document.body.appendChild(s);
      const d = document.createElement('div'); d.innerHTML = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onload="window.__pwned2 = 1">'; document.body.appendChild(d);
    });
    await p.waitForTimeout(500);
    assert.equal(await p.evaluate(() => window.__pwned), undefined, 'injected script did not run');
    assert.equal(await p.evaluate(() => window.__pwned2), undefined, 'injected onload did not run');
    assert.ok(p.violations.some((v) => /script-src/.test(v)), `violation seen: ${p.violations.join(', ')}`);
    note(t, `Blocked: ${p.violations.slice(0, 2).join(' | ')}`);
  });

  it('violation reports are accepted and nothing else', async () => {
    const r = await fetch(`${P.base}/csp-report`, { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'inline', 'document-uri': `${P.base}/` } }) });
    assert.equal(r.status, 204);
    const big = await fetch(`${P.base}/csp-report`, { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: JSON.stringify({ x: 'a'.repeat(40000) }) });
    assert.equal(big.status, 413);
    assert.match(P.log(), /csp violation script-src inline/);
  });
});

describe('Content-Security-Policy in report-only mode', () => {
  let P;
  before(async () => { P = await startProduct({ env: { CSP_MODE: 'report-only' } }); });
  after(async () => { await P.stop(); });

  it('reports without blocking, and still enforces who may frame the page', async () => {
    const r = await fetch(`${P.base}/`);
    assert.ok(r.headers.get('content-security-policy-report-only')?.includes('script-src'));
    assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'self'");
  });
});
