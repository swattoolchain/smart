// AI shopper (roadmap 2, part 1): a goal-driven shopper finds its own way to checkout, within hard limits.
// Uses a fake AI provider (test/fake-ai.js); the production key is set on the server by the owner.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startMock, startFakeAi, startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

const ai = await startFakeAi();
process.env.ALLOW_LOCAL_TARGETS = '1';
process.env.AI_PROVIDER = 'anthropic';
process.env.AI_API_KEY = 'test-ai-key';
process.env.AI_BASE_URL = ai.base;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-agent-'));
const { runShopper, MAX_STEPS, GOAL, atCheckout } = await import('../src/engine/agent.js');
const { Recorder } = await import('../src/engine/checks.js');
const { getBrowser } = await import('../src/engine/browser.js');

async function shop(mock, mode = 'shop', opts = {}) {
  await ai.control({ mode, calls: 0, prompts: [] });
  const rec = new Recorder();
  const shot = async () => null;
  const out = await runShopper({ rec, origin: mock.origin, shot, ...opts });
  return { out, check: rec.checks.find((c) => c.id === 'ai.shopper'), ai: await ai.state() };
}

describe('AI shopper', { concurrency: 1 }, () => {
  after(async () => { (await getBrowser()).close(); ai.stop(); });

  it('finds its own way from the homepage to checkout', { timeout: 120000 }, async (t) => {
    const mock = await startMock();
    try {
      const { out, check, ai: st } = await shop(mock);
      assert.equal(out.outcome, 'checkout', JSON.stringify(out.steps));
      assert.equal(check.status, 'pass', check.detail);
      assert.match(check.detail, /reached checkout in \d+ steps/);
      assert.deepEqual(out.steps.map((s) => s.did.replace(/".*"/, '"…"')).slice(0, 4), ['clicked link "…"', 'clicked button "…"', 'clicked link "…"', 'clicked button "…"']);
      assert.ok(atCheckout(mock.origin + out.steps.at(-1).at));
      assert.ok(st.calls <= MAX_STEPS);
      assert.deepEqual(st.keys, ['test-ai-key']);
      assert.match(st.prompts[0].text, new RegExp(GOAL.slice(0, 30)));
      assert.match(st.prompts[0].system, /never type, never enter personal or payment details/);
      assert.match(st.prompts[0].text, /Items in cart: 0/);
      note(t, out.steps.map((s) => `${s.n}. ${s.did} (${s.at})`).join('\n'));
    } finally { mock.stop(); }
  });

  it('reports where it got stuck when Add to cart is broken', { timeout: 120000 }, async (t) => {
    const mock = await startMock({ breaks: 'atc' });
    try {
      const { out, check } = await shop(mock);
      assert.equal(out.outcome, 'stuck');
      assert.equal(check.status, 'warn');
      assert.equal(check.severity, 'major');
      assert.match(check.detail, /got stuck on \/products\/[\w-]+ after \d+ steps: clicking Add to cart did nothing/);
      assert.match(check.detail, /It noticed: Clicking Add to cart did nothing/);
      assert.deepEqual(check.evidence.agent.friction.map((f) => f.severity), ['critical']);
      note(t, check.detail);
    } finally { mock.stop(); }
  });

  it('stops after the step limit', { timeout: 180000 }, async (t) => {
    const mock = await startMock();
    try {
      const { out, check, ai: st } = await shop(mock, 'loop');
      assert.equal(out.outcome, 'limit');
      assert.equal(st.calls, MAX_STEPS, 'never more AI calls than steps');
      assert.equal(check.status, 'warn');
      assert.match(check.detail, new RegExp(`did not reach checkout within ${MAX_STEPS} steps`));
      note(t, `${st.calls} AI calls, then stopped: ${check.detail}`);
    } finally { mock.stop(); }
  });

  it('refuses to leave the store, open admin pages or use made-up elements, then carries on', { timeout: 120000 }, async (t) => {
    const mock = await startMock();
    try {
      const { out } = await shop(mock, 'naughty');
      const did = out.steps.map((s) => s.did);
      assert.match(did[0], /could not: refused to leave the store \(evil\.example\)/);
      assert.match(did[1], /could not: refused to open account or admin pages/);
      assert.match(did[2], /could not: there is no element with that number/);
      assert.equal(out.outcome, 'checkout', 'still reached checkout afterwards');
      note(t, did.slice(0, 3).join(' | '));
    } finally { mock.stop(); }
  });

  it('never presses buttons that pay, place an order or sign in', async (t) => {
    const src = fs.readFileSync(new URL('../src/engine/agent.js', import.meta.url), 'utf8');
    const FORBIDDEN = new Function(`return ${/const FORBIDDEN = (\/.*\/i);/.exec(src)[1]}`)();
    for (const t1 of ['Pay now', 'Place order', 'Complete order', 'Complete purchase', 'Log in', 'Sign up', 'Create account', 'Confirm payment']) assert.ok(FORBIDDEN.test(t1), t1);
    for (const ok of ['Add to cart', 'Check out', 'Buy it now', 'Continue shopping', 'Size']) assert.ok(!FORBIDDEN.test(ok), ok);
    assert.ok(!/type:\s*'type'|\.fill\(|\.type\(|keyboard/.test(src), 'the shopper has no way to type');
    note(t, 'pay / place order / complete / sign-in buttons refused; no typing action exists');
  });

  it('says plainly when the AI finds no way in', { timeout: 120000 }, async (t) => {
    const mock = await startMock();
    try {
      const { check } = await shop(mock, 'stuck');
      assert.equal(check.status, 'warn');
      assert.match(check.detail, /no products are shown on the homepage/);
      assert.match(check.fix, /where real customers give up/);
      note(t, check.detail);
    } finally { mock.stop(); }
  });
});

describe('AI shopper in a full check', { concurrency: 1 }, () => {
  let P, owner, storeId, browser, fake;
  before(async () => {
    fake = await startFakeAi();
    P = await startProduct({ env: { AI_PROVIDER: 'anthropic', AI_API_KEY: 'test-ai-key', AI_BASE_URL: fake.base } });
    owner = await signup(P, 'ai-shopper@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); fake.stop(); });

  it('runs in the full check and the report shows each step', { timeout: 300000 }, async (t) => {
    const cat = (await owner.get('/api/catalog')).json;
    assert.ok(cat.groups.some((g) => g.key === 'ai.shopper' && g.ai));
    const run = await runAndWait(owner, storeId, { kind: 'full', groups: ['ai.shopper'] });
    assert.equal(run.status, 'done', run.error || '');
    const c = run.result.checks.find((x) => x.id === 'ai.shopper');
    assert.ok(c, run.result.checks.map((x) => x.id).join(','));
    assert.equal(c.status, 'pass', c.detail);
    assert.equal(run.result.shopper.outcome, 'checkout');
    assert.ok(c.evidence.screenshot);
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#/s/${storeId}/runs/${run.id}`);
    await p.waitForSelector('text=Show', { timeout: 20000 }).catch(() => {});
    await p.evaluate(() => { document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()); document.querySelectorAll('details').forEach((d) => (d.open = true)); });
    await p.waitForSelector('.agent-steps li', { timeout: 20000 });
    const steps = await p.locator('.agent-steps li').allTextContents();
    assert.ok(steps.length >= 5);
    assert.match(steps.at(-1), /reached checkout/);
    await p.locator('.agent-steps').first().scrollIntoViewIfNeeded();
    await screenshot(t, p, 'Report: what the AI shopper did');
    assert.deepEqual(errors, []);
    note(t, steps.join(' | '));
    await ctx.close();
  });

  it('is off without an AI key: nothing runs, nothing is sent', { timeout: 300000 }, async (t) => {
    const P2 = await startProduct();
    try {
      const o = await signup(P2, 'no-ai@shop.test');
      const sid = await addStore(P2, o, { runNow: false });
      const before = (await fake.state()).calls;
      const run = await runAndWait(o, sid, { kind: 'full', groups: ['ai.shopper', 'catalog'] });
      assert.equal(run.status, 'done', run.error || '');
      assert.equal(run.result.checks.find((x) => x.id === 'ai.shopper'), undefined);
      assert.equal((await fake.state()).calls, before);
      note(t, 'no AI key on the server: no AI shopper check, no AI calls');
    } finally { await P2.stop(); }
  });
});
