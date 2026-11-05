// Security watch S5: spam links hidden in the store, and defacement (a replaced homepage).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startMock, startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.ALLOW_LOCAL_TARGETS = '1';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-spam-'));
const { runScan } = await import('../src/engine/index.js');
const { getBrowser } = await import('../src/engine/browser.js');
const { approveBaseline } = await import('../src/engine/visual.js');
const { SPAM_WORDS, DEFACE_WORDS, overlap, defacementCheck } = await import('../src/engine/spam.js');
const { Recorder } = await import('../src/engine/checks.js');
const { GROUPS, groupOf } = await import('../src/engine/catalog.js');
const { config } = await import('../src/config.js');

const check = (r, id) => r.checks.find((c) => c.id === id);
// Only what this feature needs, so each scan stays quick.
const SLOW = ['speed', 'seo', 'a11y', 'links', 'policies', 'catalog', 'law.de', 'law.cookies', 'access.law', 'law.us', 'ai.visual', 'ai.copy', 'sale.discount'];
let n = 0;
async function scan(breaks, opts = {}) {
  const mock = await startMock({ breaks });
  const runId = `spam-${Date.now()}-${n++}`;
  try {
    return { ...(await runScan({ runId, origin: mock.origin, kind: opts.kind || 'free', disabled: opts.disabled || SLOW, storeId: opts.storeId })), runId };
  } finally { mock.stop(); }
}

describe('Spam and defacement: the rules', () => {
  it('spam words catch link sellers but not honest store words', (t) => {
    for (const s of ['online casino', 'cheap viagra', 'Replica watches', 'payday loans', 'slot gacor', 'buy instagram followers']) assert.match(s, SPAM_WORDS, s);
    for (const s of ['Book a delivery slot', 'Our loan-free EMI', 'Bet you will love it', 'Handwoven silk saree', 'Escorted heritage walks', 'Poker table cover']) assert.doesNotMatch(s, SPAM_WORDS, s);
    note(t, 'Spam words are narrow: "slot", "loan" and "bet" alone are not spam.');
  });

  it('defacement messages are recognised', () => {
    for (const s of ['HACKED BY GH0ST CREW', 'Defaced by x', 'Your site has been hacked', 'h4ck3d by z', 'Greetz to all']) assert.match(s, DEFACE_WORDS, s);
    for (const s of ['We were featured by Vogue', 'Hand picked by our team', 'Security is our priority']) assert.doesNotMatch(s, DEFACE_WORDS, s);
  });

  it('a redesign that keeps the store words is not defacement; a replaced page is', (t) => {
    const before = { title: 'Mock Store', text: 'Handmade in India Organic Cotton Kurta Handwoven Silk Saree Brass Diya Set Shop About Search Cart Privacy Refunds' };
    const redesign = { key: 'home-desktop', ratio: 0.8, title: 'Mock Store', text: 'Diwali sale! Handmade in India: Organic Cotton Kurta, Handwoven Silk Saree, Brass Diya Set. Shop About Search Cart', before };
    const replaced = { key: 'home-desktop', ratio: 0.8, title: 'Welcome', text: 'Exclusive offers today. Claim your prize now.', before };
    const small = { ...replaced, ratio: 0.2 };
    assert.ok(overlap(before.text, redesign.text) > 0.7);
    let rec = new Recorder();
    defacementCheck({ rec, shots: [redesign] });
    assert.equal(rec.checks[0].status, 'pass');
    rec = new Recorder();
    defacementCheck({ rec, shots: [small] });
    assert.equal(rec.checks[0].status, 'pass', 'a small visual change is never called defacement');
    rec = new Recorder();
    defacementCheck({ rec, shots: [replaced] });
    assert.equal(rec.checks[0].status, 'fail');
    assert.equal(rec.checks[0].severity, 'major');
    note(t, rec.checks[0].detail);
  });

  it('a hacker message that was already in the approved look is not reported again', () => {
    const before = { title: 'Escape room', text: 'Our game: hacked by the AI. Book now.' };
    const rec = new Recorder();
    defacementCheck({ rec, shots: [{ key: 'home-desktop', ratio: 0, ...before, before }] });
    assert.equal(rec.checks[0].status, 'pass');
  });

  it('both checks are switchable groups in the Security area', () => {
    for (const k of ['security.spam', 'security.deface']) assert.equal(GROUPS.find((g) => g.key === k)?.area, 'Security');
    assert.equal(groupOf('sec.spam'), 'security.spam');
    assert.equal(groupOf('sec.deface'), 'security.deface');
  });
});

describe('Spam links on a store', { concurrency: 1 }, () => {
  after(async () => { (await getBrowser()).close(); });

  it('a healthy store has no spam', { timeout: 180000 }, async (t) => {
    const r = await scan('');
    const c = check(r, 'sec.spam');
    assert.equal(c?.status, 'pass', c?.detail);
    assert.equal(c.category, 'security');
    assert.ok(r.categories.some((x) => x.key === 'security' && x.tested));
    note(t, c.detail);
  });

  it('hidden casino and pill links are caught, with the sites and a screenshot', { timeout: 180000 }, async (t) => {
    const r = await scan('spam');
    const c = check(r, 'sec.spam');
    assert.equal(c?.status, 'fail', c?.detail);
    assert.match(c.detail, /best-casino-bonus\.example/);
    assert.match(c.detail, /hidden from shoppers/);
    const spam = c.evidence.spam;
    assert.ok(spam.some((s) => s.kind === 'link' && s.hidden === 'moved off the page'), JSON.stringify(spam));
    assert.ok(spam.some((s) => s.kind === 'text' && s.hidden === 'not shown'), 'the hidden keyword block is found too');
    assert.ok(c.evidence.screenshot, 'a screenshot of the page is kept');
    // Spam is serious but customers can still buy: a warning verdict, not "critical".
    assert.notEqual(r.verdict, 'critical');
    note(t, c.detail);
  });

  it('a link to another website hidden with a zero font size is worth a look', { timeout: 180000 }, async (t) => {
    const r = await scan('cloaked');
    const c = check(r, 'sec.spam');
    assert.equal(c?.status, 'warn', c?.detail);
    assert.match(c.detail, /link-farm\.example/);
    note(t, c.detail);
  });

  it('switching the group off skips the check', { timeout: 180000 }, async () => {
    const r = await scan('spam', { disabled: [...SLOW, 'security.spam'] });
    assert.equal(check(r, 'sec.spam'), undefined);
  });

  it('the quick journey test does not run it', { timeout: 180000 }, async () => {
    const r = await scan('spam', { kind: 'journeys' });
    assert.equal(check(r, 'sec.spam'), undefined);
  });
});

describe('Defacement', { concurrency: 1 }, () => {
  const storeId = 9000 + Math.floor(Math.random() * 1000);
  const baselineDir = path.join(config.dataDir, 'baselines', `store-${storeId}`);
  const full = (breaks) => scan(breaks, { kind: 'full', storeId, disabled: SLOW });
  after(async () => { (await getBrowser()).close(); });

  it('the first full check saves the approved look with its words', { timeout: 240000 }, async (t) => {
    const r = await full('');
    assert.equal(check(r, 'sec.deface')?.status, 'pass');
    assert.ok(fs.existsSync(path.join(baselineDir, 'home-desktop.text.json')), 'page words saved with the approved screenshot');
    const words = JSON.parse(fs.readFileSync(path.join(baselineDir, 'home-desktop.text.json'), 'utf8'));
    assert.match(words.text, /Handmade in India/);
    note(t, `Approved look saved: ${fs.readdirSync(baselineDir).length} files`);
  });

  it('an unchanged store passes', { timeout: 240000 }, async () => {
    const r = await full('');
    assert.equal(check(r, 'sec.deface')?.status, 'pass', check(r, 'sec.deface')?.detail);
  });

  it('a homepage showing a hacker message is a critical problem', { timeout: 240000 }, async (t) => {
    const r = await full('deface');
    const c = check(r, 'sec.deface');
    assert.equal(c?.status, 'fail', c?.detail);
    assert.equal(c.severity, 'critical');
    assert.match(c.detail, /hacker's message/);
    assert.equal(r.verdict, 'critical');
    assert.match(r.summary, /hacker/);
    note(t, `${r.summary} ${c.detail}`);
  });

  it('a homepage replaced with unrelated content is flagged; approving it as the new look clears it', { timeout: 300000 }, async (t) => {
    const r = await full('replaced');
    const c = check(r, 'sec.deface');
    assert.equal(c?.status, 'fail', c?.detail);
    assert.equal(c.severity, 'major');
    assert.match(c.detail, /may have been defaced/);
    note(t, c.detail);
    // The owner approves the new look (the same thing the "Approve new look" button does).
    assert.equal(approveBaseline(path.join(config.dataDir, 'shots', `run-${r.runId}`), baselineDir), 6);
    const again = await full('replaced');
    assert.equal(check(again, 'sec.deface')?.status, 'pass', check(again, 'sec.deface')?.detail);
    note(t, 'After approving the new look, the same page passes.');
  });
});

describe('Spam in the report', () => {
  let P, owner, storeId, run, browser;
  before(async () => {
    P = await startProduct({ mock: { breaks: 'spam' } });
    owner = await signup(P, 'spam@shop.test');
    storeId = await addStore(P, owner, { runNow: false });
    run = await runAndWait(owner, storeId, { kind: 'full' }, 300000);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('the full check reports spam under Security', { timeout: 60000 }, async (t) => {
    assert.equal(run.status, 'done', run.error || '');
    const row = P.db().prepare('SELECT result_json FROM runs WHERE id = ?').get(run.id);
    const res = JSON.parse(row.result_json);
    assert.equal(res.checks.find((c) => c.id === 'sec.spam')?.status, 'fail');
    assert.equal(res.checks.find((c) => c.id === 'sec.deface')?.status, 'pass', 'the first full check only saves the approved look');

    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(owner.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#/s/${storeId}/reports/${run.id}`);
    await p.waitForSelector('.rtabs button', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    await p.locator('.rtabs button[data-rtab=areas]').click();
    await p.waitForTimeout(400);
    const pane = p.locator('.rtab-pane:not([hidden])');
    assert.match(await pane.textContent(), /Security/);
    const item = pane.getByText('No spam links or hidden text').first();
    await item.scrollIntoViewIfNeeded();
    assert.ok(await item.isVisible());
    await screenshot(t, p, 'Report: spam links found under Security');
    assert.deepEqual(errors, []);
  });
});
