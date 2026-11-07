// S16 part 2: after Tharam is removed from a Shopify store, the storefront is still watched from outside
// (like a free check) until shop/redact, and the owner is emailed if it looks tampered with.
// Uses the mock store (live tamper switches) and fake uninstall / redact webhooks.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startProduct, shopifyOpen, lastMailLink, shopifyHmac } from './lib/harness.js';
import { note } from './lib/evidence.js';

process.env.FEATURES_DEFAULT = 'on';
process.env.DATA_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'tharam-rw-'));
const { problemsIn, alertMail } = await import('../src/removal-watch.js');

const wait = async (fn, ms = 60000) => { const until = Date.now() + ms; let v; while (!(v = await fn()) && Date.now() < until) await new Promise((r) => setTimeout(r, 300)); return v; };
const ALERTS = /\[mail skipped\] to=([^\n]*) subject=Your store ([^\n]*) may have been tampered with/g;

describe('Watching after removal: the messages', () => {
  it('only failed tampering checks count, in plain words', (t) => {
    const result = { checks: [
      { id: 'fn.checkout', status: 'fail', detail: 'Checkout went to evil.example' },
      { id: 'sec.scripts.bad', status: 'fail', detail: '' },
      { id: 'sec.redirect', status: 'pass' },
      { id: 'nf.catalog', status: 'fail', detail: 'Of 3 products checked: 2 priced at 0.' },
      { id: 'fn.search', status: 'fail' },
    ] };
    assert.deepEqual(problemsIn(result).map((x) => x.key), ['checkout', 'badscript'], 'prices are not judged before there is something to compare with');
    assert.deepEqual(problemsIn(result, { zeroBefore: 2 }).map((x) => x.key), ['checkout', 'badscript'], 'a store that already gave things away is not flagged');
    const p = problemsIn(result, { zeroBefore: 1 });
    assert.deepEqual(p.map((x) => x.key), ['checkout', 'badscript', 'prices'], 'one entry per kind of problem; ordinary breakage is not tampering');
    const mail = alertMail({ store_name: 'Kaveri', emails_json: '["a@x.test","b@x.test"]' }, p);
    assert.equal(mail.to, 'a@x.test, b@x.test');
    assert.match(mail.text, /Checkout sends customers to another website\./);
    assert.match(mail.text, /change your password/);
    assert.match(mail.text, /stop and delete these checks when Shopify asks us to delete your data/);
    note(t, mail.text.split('\n').slice(0, 5).join(' | '));
  });
});

describe('Watching after removal: the whole product', () => {
  let P;
  before(async () => { P = await startProduct({ env: { BAD_DOMAINS: 'evil-cdn.localhost', REMOVAL_WATCH_TICK_MS: '1000', REMOVAL_WATCH_EVERY_MIN: '0' } }); });
  after(async () => { await P?.stop(); });

  const webhook = (topic, shop) => {
    const raw = JSON.stringify({ domain: shop });
    return fetch(`${P.base}/shopify/webhooks`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-hmac-sha256': shopifyHmac(raw) } });
  };
  const extra = (q) => fetch(`${P.mock.origin}/__extra?${q}`);
  const watch = (shop) => P.db().prepare('SELECT * FROM removal_watch WHERE shop = ?').all(shop);
  const watchRuns = () => P.db().prepare("SELECT id, status, kind FROM runs WHERE trigger = 'removal_watch'").all();
  const alerts = () => [...P.log().matchAll(ALERTS)];

  it('a healthy store is checked again and again after removal, and nobody is bothered', async (t) => {
    await extra('badscript=0&miner=0');
    const shop = 'calm.myshopify.com';
    const s = await shopifyOpen(P, shop);
    assert.equal((await s.post('/api/account/web-access', { email: 'owner@calm.test' })).status, 200);
    assert.equal((await P.session().post('/api/auth/link/verify', { token: lastMailLink(P).split('#/signin/')[1] })).status, 200);
    assert.equal(watch(shop).length, 0, 'nothing is watched while installed');
    assert.equal((await webhook('app/uninstalled', shop)).status, 200);
    const w = await wait(() => watch(shop)[0]);
    assert.ok(w, 'watch started by the uninstall');
    assert.deepEqual(JSON.parse(w.emails_json).sort(), ['hello@testshop.example', 'owner@calm.test']);
    const ends = new Date(w.ends_at.replace(' ', 'T') + 'Z').getTime() - new Date(w.started_at.replace(' ', 'T') + 'Z').getTime();
    assert.ok(ends > 47 * 3600e3 && ends <= 73 * 3600e3, 'runs for about the 48 hours until redact');
    assert.ok(await wait(() => watchRuns().filter((r) => r.status === 'done').length >= 2), 'several outside checks finished');
    assert.ok(watchRuns().every((r) => r.kind === 'free'), 'public pages only, like a free check');
    assert.equal(P.db().prepare('SELECT monitoring FROM stores WHERE id = ?').get(s.storeId).monitoring, 0, 'normal monitoring stays off');
    assert.equal(alerts().length, 0, "healthy sends no tamper email: " + P.log().slice(P.log().indexOf("may have been tampered")).slice(0, 900));
    note(t, `${watchRuns().length} outside checks ran after removal; no tamper email on a healthy store`);
    assert.equal((await webhook('shop/redact', shop)).status, 200);
    assert.ok(await wait(() => watch(shop).length === 0), 'redact removes the watch');
  });

  it('tampering is emailed to the owner once, and redact stops and deletes everything', async (t) => {
    const shop = 'hacked.myshopify.com';
    const s = await shopifyOpen(P, shop);
    await webhook('app/uninstalled', shop);
    assert.ok(await wait(() => watch(shop)[0]));
    await extra('miner=1');
    assert.ok(await wait(() => alerts().length >= 1), 'tamper email sent');
    const a = alerts()[0];
    assert.equal(a[2], 'Test Shop');
    assert.match(a[1], /hello@testshop\.example/);
    const body = P.log().slice(P.log().indexOf('may have been tampered with'));
    assert.match(body, /cryptocurrency mining/);
    // More checks run while it stays tampered; still just one email.
    const before = watchRuns().length;
    assert.ok(await wait(() => watchRuns().length >= before + 2), 'keeps checking');
    assert.equal(alerts().length, 1, 'the same problem is emailed once');
    // A different kind of tampering later is a new email.
    await extra('badscript=1');
    assert.ok(await wait(() => alerts().length >= 2), 'a new kind of problem is emailed');
    assert.match(P.log().slice(P.log().lastIndexOf('may have been tampered with')), /known for stealing card details/);
    assert.doesNotMatch(P.log().slice(P.log().lastIndexOf('may have been tampered with'), P.log().lastIndexOf('may have been tampered with') + 400), /cryptocurrency mining code/, 'only what is new');
    const n2 = watchRuns().length;
    assert.ok(await wait(() => watchRuns().length >= n2 + 2));
    assert.equal(alerts().length, 2, 'nothing repeated');
    note(t, `Email: ${body.split('\n').slice(1, 6).join(' | ')}`);

    // shop/redact: stops at once and deletes everything the watch made.
    assert.equal((await webhook('shop/redact', shop)).status, 200);
    assert.ok(await wait(() => watch(shop).length === 0), 'watch rows deleted');
    await new Promise((r) => setTimeout(r, 1500));
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(watchRuns().length, 0, 'every outside check run is deleted');
    assert.equal(P.db().prepare('SELECT COUNT(*) AS n FROM removal_watch').get().n, 0);
    await extra('badscript=0&miner=0');
    note(t, 'shop/redact removed the watch and all its runs; nothing new started');
  });

  it('adding the app again ends the watch', async (t) => {
    const shop = 'back.myshopify.com';
    await shopifyOpen(P, shop);
    await webhook('app/uninstalled', shop);
    assert.ok(await wait(() => watch(shop)[0]));
    await shopifyOpen(P, shop);
    const w = watch(shop)[0];
    assert.equal(w.ended_reason, 'reinstalled');
    assert.ok(w.ended_at);
    const n = watchRuns().length;
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(watchRuns().length, n, 'no more outside checks once the normal checks are back');
    note(t, 'reinstall ended the watch');
  });
});
