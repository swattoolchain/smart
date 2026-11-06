// Script watch, part 2 (S1): outside scripts that read what shoppers type on the product and cart pages.
// A script that sends what was typed to another site is critical; one that only reads it (a chat widget) is a
// major notice; the store's own scripts are never reported. Only a made-up test value is ever typed.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const { isFormService, FIELD_PATTERN, markerFor } = await import('../src/engine/forms.js');

const find = (run, id) => run.result.checks.find((c) => c.id === id);
const mails = (P, re) => (P.log().match(new RegExp(`\\[mail skipped\\] to=[^\\n]* subject=[^\\n]*${re}`, 'g')) || []).length;

describe('Scripts reading what shoppers type', () => {
  let P, owner, storeId, skimRun;
  const toggle = (q) => fetch(`${P.mock.origin}/__extra?${q}`).then((r) => r.json());
  const journeys = async () => { const r = await runAndWait(owner, storeId, { kind: 'journeys' }); assert.equal(r.status, 'done', r.error || ''); return r; };
  before(async () => {
    // svc.localhost plays a known email sign-up service, lib-cdn.localhost a public library CDN.
    P = await startProduct({ env: { FORM_SERVICES: 'svc.localhost', FORM_LIBRARY_CDNS: 'lib-cdn.localhost' } });
    owner = await signup(P, 'forms@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
  });
  after(async () => { await P?.stop(); });

  it('which fields count and which services are expected to use them', () => {
    const re = new RegExp(FIELD_PATTERN, 'i');
    for (const s of ['contact[email]', 'checkout[shipping_address][address1]', 'phone', 'cc-number', 'card_cvv', 'zip', 'first_name']) assert.ok(re.test(s), s);
    for (const s of ['quantity', 'q', 'note', 'discount', 'id', 'attributes[gift_wrap]']) assert.ok(!re.test(s), s);
    assert.equal(isFormService('static.klaviyo.com'), true);
    assert.equal(isFormService('cdn.shopify.com'), true);
    assert.equal(isFormService('www.clarity.ms'), true);
    assert.equal(isFormService('cdn.skim-stats.example'), false);
    assert.equal(isFormService('klaviyo.com.evil.example'), false);
    // One stable marker per store, so a run never creates a new made-up contact anywhere.
    assert.equal(markerFor('https://a-shop.myshopify.com'), markerFor('https://a-shop.myshopify.com/products/x'));
    assert.notEqual(markerFor('https://a-shop.myshopify.com'), markerFor('https://b-shop.myshopify.com'));
    assert.match(markerFor('https://a-shop.myshopify.com'), /^tharam[0-9a-f]{10}$/);
  });

  it('a store with only its own sign-up script passes', async (t) => {
    const r = await journeys();
    const c = find(r, 'sec.scripts.forms');
    assert.equal(c.status, 'pass');
    assert.match(c.detail, /^Watched the form fields on the product page and cart page/);
    assert.deepEqual(r.result.scripts.forms.readers, []);
    assert.equal(r.result.scripts.forms.probed, 0, 'no outside script uses the box, so nothing is typed into it');
    note(t, `${c.detail} Fields filled with the test value: 0.`);
  });

  it('an outside script that reads the email box but sends nothing is a major notice', async (t) => {
    await toggle('formreader=1');
    try {
      const r = await journeys();
      const c = find(r, 'sec.scripts.forms');
      assert.equal(c.status, 'fail');
      assert.equal(c.severity, 'major');
      assert.match(c.detail, /^1 script from outside sites reads or watches what shoppers type: http:\/\/127\.0\.0\.1:\d+\/apps\/chat-widget\.js \(product page and cart page\) on email “contact\[email\]”/);
      assert.match(c.detail, /We did not see what was typed go anywhere else/);
      assert.ok(!c.detail.includes('newsletter.js'), "the store's own script is never reported");
      assert.notEqual(r.verdict, 'critical');
      const readers = r.result.scripts.forms.readers;
      assert.deepEqual([...new Set(readers.map((x) => x.page))].sort(), ['cart', 'product']);
      assert.ok(readers.every((x) => x.sentTo.length === 0));
      assert.ok(readers.some((x) => x.listens.length) && readers.some((x) => x.reads.length), 'both the listener and the read are seen');
      // One alert email (shared with the new-script notice for the same script), naming this check.
      const inMail = () => (P.log().match(/🔴 No outside scripts reading what shoppers type: /g) || []).length;
      const until = Date.now() + 5000;
      while (!inMail() && Date.now() < until) await new Promise((res) => setTimeout(res, 100));
      assert.equal(inMail(), 1, 'one alert email names it');
      assert.equal(mails(P, 'Urgent'), 0, 'not urgent');
      note(t, c.detail);
    } finally { await toggle('formreader=0'); }
  });

  it('a skimmer that sends what was typed to another site is critical, and only a made-up value was typed', async (t) => {
    await toggle('skimmer=1');
    try {
      const r = await journeys();
      skimRun = r;
      const c = find(r, 'sec.scripts.forms');
      assert.equal(c.status, 'fail');
      assert.equal(c.severity, 'critical');
      assert.match(c.detail, /^A script reads what shoppers type: http:\/\/127\.0\.0\.1:\d+\/apps\/pixel-helper\.js \(product page and cart page\) on email “contact\[email\]”\. What was typed was sent to 127\.0\.0\.1:\d+\./);
      assert.match(c.detail, /made-up test value, never real details/);
      assert.equal(r.verdict, 'critical');
      assert.match(r.result.summary, /reading what shoppers type and sending it to another website/);
      assert.deepEqual(c.evidence.sentTo.map((h) => h.replace(/:\d+$/, '')), ['127.0.0.1']);
      // What the skimmer collected: only our marker, in the plain and base64 forms the test watches for.
      const got = (await (await fetch(`${P.mock.origin}/__collected`)).json()).collected;
      assert.ok(got.length >= 2);
      assert.ok(r.result.scripts.forms.probed > 0, 'the field the skimmer listens to was filled');
      const storeUrl = (await owner.get(`/api/stores/${storeId}`)).json.store.url;
      for (const g of got) {
        const value = g.method === 'GET' ? decodeURIComponent(g.query.slice(3)) : Buffer.from(JSON.parse(g.body).d, 'base64').toString();
        assert.match(value, /^tharam[0-9a-f]{10}@example\.invalid$/, 'only a made-up value, on a domain that can never receive mail');
        assert.equal(value, `${markerFor(storeUrl)}@example.invalid`, "the store's own stable marker");
      }
      note(t, `${c.detail} Skimmer received ${got.length} requests, all with the made-up value.`);
    } finally { await toggle('skimmer=0'); }
  });

  it("the store's own code using a library from a public CDN is not blamed on the CDN", async (t) => {
    await toggle('cdnlib=1');
    try {
      const r = await journeys();
      const c = find(r, 'sec.scripts.forms');
      assert.equal(c.status, 'pass', c.detail);
      assert.deepEqual(r.result.scripts.forms.readers, []);
      assert.equal(r.result.scripts.forms.probed, 0);
      note(t, `Inline store code reads and listens to the email box through lib-cdn.localhost/libs/minq.js: ${c.status}. ${c.detail}`);
    } finally { await toggle('cdnlib=0'); }
  });

  it('a field a known sign-up service uses is never filled in, so no fake contact is created', async (t) => {
    await toggle('popup=1&formreader=1');
    try {
      const r = await journeys();
      const c = find(r, 'sec.scripts.forms');
      // The unknown chat widget is still reported, from what it reads and listens to.
      assert.equal(c.status, 'fail');
      assert.equal(c.severity, 'major');
      assert.match(c.detail, /chat-widget\.js/);
      assert.ok(!c.detail.includes('popup.js'), 'the known service is not reported');
      assert.equal(r.result.scripts.forms.probed, 0, 'the box the popup uses was not filled');
      const captured = (await (await fetch(`${P.mock.origin}/__popup`)).json()).captured;
      assert.deepEqual(captured, [], 'the sign-up service received nothing');
      note(t, `Sign-up popup (svc.localhost) and an unknown chat widget on the same email box: chat widget reported (${c.severity}), box not filled, popup captured ${captured.length} contacts.`);
    } finally { await toggle('popup=0&formreader=0'); }
  });

  it('the Scripts and apps tab shows the script, the page, the field and where it sent it', async (t) => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      await ctx.addCookies(owner.browserCookies());
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`${P.base}/app#/s/${storeId}/reports/${skimRun.id}`);
      await p.waitForSelector('[data-rtab=scripts]', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      await p.click('[data-rtab=scripts]');
      const box = p.locator('#form-readers');
      assert.ok(await box.isVisible());
      const text = await box.textContent();
      assert.match(text, /A script sends what shoppers type to another website/);
      assert.match(text, /pixel-helper\.js/);
      assert.match(text, /Product page/);
      assert.match(text, /Cart page/);
      assert.match(text, /contact\[email\]/);
      assert.match(text, /127\.0\.0\.1/);
      await screenshot(t, p, 'Scripts and apps tab with a skimmer', { fullPage: true });
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
});
