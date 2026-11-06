// Webhook alerts (T26, roadmap 10 part 1): signed JSON alerts for Zapier, Make, Teams, Discord and your own system.
// Part 1 runs in-process against a local receiver: formats, signatures, address checks, retries (500s, timeouts),
// no retries for permanent answers or redirects, and the alert rules (one delivery on break, one on fix, nothing
// while still broken, not on plans without chat alerts). Part 2 starts the whole product: an owner sets a webhook,
// a test alert arrives signed, a real broken store sends a signed alert, other accounts are refused, and the
// Alerts page shows the webhook, its secret and the latest deliveries.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import dns from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

/** A local webhook receiver. `answer(req, n)` returns a status code, or 'hang' to never answer. */
async function receiver(answer = () => 200) {
  const got = [];
  const hanging = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got.push({ path: req.url, headers: req.headers, body, json: (() => { try { return JSON.parse(body); } catch { return null; } })() });
      const a = answer(req, got.length);
      if (a === 'hang') { hanging.push(res); return; }
      if (a === 302) { res.writeHead(302, { location: 'http://localhost:1/elsewhere' }); res.end(); return; }
      res.writeHead(a, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://localhost:${server.address().port}`;
  return { url, got, set: (fn) => (answer = fn), close: () => { for (const r of hanging) r.destroy(); server.close(); } };
}

/** Checks X-Tharam-Signature the way a receiver should. */
function verify(secret, header, body, maxAgeS = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header || '');
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > maxAgeS) return false;
  const want = crypto.createHmac('sha256', secret).update(`${m[1]}.${body}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2]));
}
const waitFor = async (fn, ms = 10000) => { const until = Date.now() + ms; while (Date.now() < until) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timed out'); };

describe('Webhook delivery', () => {
  let w, db, q, alerts, storeId, userId, starterStore, rcv;
  const SECRET = 'whsec_test-secret-test-secret-123';
  before(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-webhooks-'));
    process.env.WEBHOOK_RETRY_MS = '100'; // attempts at 0, 100, 500 and 3000 ms
    process.env.WEBHOOK_TIMEOUT_MS = '400';
    process.env.SMTP_HOST = '';
    let ensureLicense;
    process.env.FEATURES_DEFAULT = 'on'; // the webhook feature is switched on, like the harness does for every feature
    ({ db, q } = await import('../src/db.js'));
    ({ ensureLicense } = await import('../src/license.js'));
    w = await import('../src/webhooks.js');
    alerts = await import('../src/alerts.js');
    rcv = await receiver();
    userId = Number(q.insertUser.run('hook@shop.test', 'x', 'Hook').lastInsertRowid);
    ensureLicense(userId);
    storeId = Number(q.insertStore.run(userId, 'https://hook-store.example', 'Hook Store', null, 'hook@shop.test', null, '{}', 'Shopify', 1).lastInsertRowid);
    const starter = Number(q.insertUser.run('starter@shop.test', 'x', 'S').lastInsertRowid);
    ensureLicense(starter);
    db.prepare("UPDATE licenses SET plan_key = 'starter', status = 'active', expires_at = NULL WHERE user_id = ?").run(starter);
    starterStore = Number(q.insertStore.run(starter, 'https://starter.example', 'Starter Store', null, 'starter@shop.test', null, '{}', 'Shopify', 1).lastInsertRowid);
  });
  after(() => { rcv?.close(); delete process.env.ALLOW_LOCAL_TARGETS; });

  const setHook = (id, url, format = 'json') => db.prepare('UPDATE stores SET webhook_json = ? WHERE id = ?').run(JSON.stringify({ url, format, secret: SECRET }), id);
  const store = (id = storeId) => q.storeById.get(id);
  const rows = (id = storeId) => db.prepare('SELECT * FROM webhook_deliveries WHERE store_id = ? ORDER BY id').all(id);

  it('formats: picked from the address; Teams card; Discord message with mentions off', () => {
    assert.equal(w.resolveFormat('https://discord.com/api/webhooks/1/x'), 'discord');
    assert.equal(w.resolveFormat('https://acme.webhook.office.com/webhookb2/x'), 'teams');
    assert.equal(w.resolveFormat('https://prod-12.westus.logic.azure.com/workflows/x'), 'teams');
    assert.equal(w.resolveFormat('https://hooks.zapier.com/hooks/catch/1/x'), 'json');
    assert.equal(w.resolveFormat('https://discord.com/api/webhooks/1/x', 'json'), 'json', 'a chosen format wins');
    const p = w.payloadFor({ event: 'alert.failing', store: { id: 4, name: 'Shop', url: 'https://shop.example' }, runId: 9, failing: [{ id: 'fn.atc', title: 'Add to cart works', severity: 'critical', detail: 'Button does nothing', fix: 'Check the theme' }], recovered: [], subject: 'Urgent: Check failed on Shop', text: 'x', deliveryId: 'd1' });
    assert.deepEqual([p.event, p.id, p.store.id, p.run.id, p.failing[0].severity], ['alert.failing', 'd1', 4, 9, 'critical']);
    assert.match(p.run.reportUrl, /#\/s\/4\/reports\/9$/);
    const t = w.bodyFor('teams', p);
    assert.equal(t.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
    assert.match(JSON.stringify(t), /Add to cart works: Button does nothing/);
    assert.equal(t.attachments[0].content.actions[0].url, p.run.reportUrl);
    const d = w.bodyFor('discord', { ...p, text: '@everyone ' + 'x'.repeat(3000) });
    assert.ok(d.content.length <= 2000);
    assert.deepEqual(d.allowed_mentions, { parse: [] }, 'store text can never ping a whole Discord server');
    assert.equal(w.bodyFor('json', p), p);
  });

  it('addresses: https and public only, no passwords in the address', async () => {
    delete process.env.ALLOW_LOCAL_TARGETS;
    await assert.rejects(w.checkWebhookUrl('not a url'), /full webhook address/);
    await assert.rejects(w.checkWebhookUrl('http://hooks.example.com/x'), /https/);
    await assert.rejects(w.checkWebhookUrl('ftp://hooks.example.com/x'), /https/);
    await assert.rejects(w.checkWebhookUrl('https://user:pw@hooks.example.com/x'), /user name and password/);
    await assert.rejects(w.checkWebhookUrl('https://10.0.0.5/hook'), /public addresses/);
    await assert.rejects(w.checkWebhookUrl('https://127.0.0.1:8080/hook'), /public addresses/);
    // IPv6 forms of internal addresses: IPv4-mapped (both spellings), unspecified, loopback.
    for (const a of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:10.0.0.5]', '[::]', '[::1]']) {
      await assert.rejects(w.checkWebhookUrl(`https://${a}/hook`), /public addresses/, a);
      await assert.rejects(w.addressFor(a), (e) => e.private === true, a);
    }
    await assert.rejects(w.checkWebhookUrl(`https://x.example/${'a'.repeat(600)}`), /too long/);
    process.env.ALLOW_LOCAL_TARGETS = '1';
    assert.equal(await w.checkWebhookUrl(` ${rcv.url}/hook `), `${rcv.url}/hook`);
  });

  it('a delivery is signed; a receiver that is down gets it again until it answers', async (t) => {
    process.env.ALLOW_LOCAL_TARGETS = '1';
    setHook(storeId, `${rcv.url}/retry`);
    rcv.got.length = 0;
    rcv.set((req, n) => (n <= 2 ? 500 : 200));
    const r = await w.deliver(store(), { event: 'test', subject: 'Test alert', text: 'hello' });
    assert.deepEqual([r.ok, r.code, r.retrying, r.format], [false, 500, true, 'json']);
    const row = await waitFor(() => { const x = rows().at(-1); return x.status === 'delivered' && x; });
    assert.deepEqual([row.attempts, row.last_code], [3, 200]);
    assert.equal(rcv.got.length, 3);
    assert.equal(new Set(rcv.got.map((g) => g.headers['x-tharam-delivery'])).size, 1, 'the same delivery id on every attempt');
    for (const g of rcv.got) {
      assert.ok(verify(SECRET, g.headers['x-tharam-signature'], g.body), 'valid signature');
      assert.ok(!verify('whsec_wrong', g.headers['x-tharam-signature'], g.body));
      assert.ok(!verify(SECRET, g.headers['x-tharam-signature'], g.body.replace('hello', 'hellO')), 'a changed body fails');
      assert.equal(g.headers['x-tharam-event'], 'test');
      assert.equal(g.headers['user-agent'], 'Tharam-Webhooks/1');
    }
    assert.equal(rcv.got[0].json.store.name, 'Hook Store');
    note(t, '500, 500, then 200: delivered on the 3rd attempt with the same delivery id and a valid signature each time');
  });

  it('timeouts are retried; after 4 attempts it stops; 404 and redirects stop at once', async () => {
    rcv.got.length = 0;
    rcv.set(() => 'hang');
    const r = await w.deliver(store(), { event: 'test', subject: 'x', text: 'x' });
    assert.match(r.error, /No answer/);
    const row = await waitFor(() => { const x = rows().at(-1); return x.status === 'failed' && x; }, 15000);
    assert.equal(row.attempts, 4);
    assert.equal(rcv.got.length, 4);

    rcv.got.length = 0;
    rcv.set(() => 404);
    const g = await w.deliver(store(), { event: 'test', subject: 'x', text: 'x' });
    assert.deepEqual([g.ok, g.code, g.retrying], [false, 404, false]);
    assert.deepEqual([rows().at(-1).status, rows().at(-1).attempts], ['failed', 1]);

    rcv.set(() => 302);
    const red = await w.deliver(store(), { event: 'test', subject: 'x', text: 'x' });
    assert.match(red.error, /redirect/);
    assert.equal(rows().at(-1).attempts, 1);
    await new Promise((res) => setTimeout(res, 700));
    assert.equal(rcv.got.filter((x) => x.path === '/elsewhere').length, 0, 'the redirect was not followed');
    assert.equal(rows().at(-1).status, 'failed');
    assert.equal(await w.deliver({ ...store(), webhook_json: null }, { event: 'test', subject: 'x', text: 'x' }), null, 'no webhook, nothing sent');
  });

  it('each attempt connects to the exact address it checked (no DNS rebinding)', async (t) => {
    delete process.env.ALLOW_LOCAL_TARGETS;
    const port = new URL(rcv.url).port;
    const realLookup = dns.lookup;
    const calls = [];
    // A fake DNS: pinned.test is the receiver (127.0.0.1, treated as public for this test); rebind.test answers
    // with a public address twice, then with 127.0.0.1, the way a rebinding attacker's DNS would.
    dns.lookup = async (host, opts) => {
      calls.push(host);
      if (host === 'pinned.test') return [{ address: '127.0.0.1', family: 4 }];
      if (host === 'rebind.test') return [{ address: calls.filter((h) => h === 'rebind.test').length <= 2 ? '93.184.215.14' : '127.0.0.1', family: 4 }];
      return realLookup(host, opts);
    };
    process.env.EGRESS_TEST_ALLOW = 'pinned.test';
    try {
      // The request goes to the checked address: no other DNS lookup happens, and the Host stays the name.
      setHook(storeId, `http://pinned.test:${port}/pinned`);
      rcv.got.length = 0;
      rcv.set(() => 200);
      calls.length = 0;
      const ok = await w.deliver(store(), { event: 'test', subject: 'x', text: 'x' }, { retry: false });
      assert.equal(ok.ok, true, ok.error || '');
      assert.deepEqual(calls, ['pinned.test'], 'one lookup per attempt');
      assert.equal(rcv.got.length, 1);
      assert.equal(rcv.got[0].headers.host, `pinned.test:${port}`);

      // Rebinding: the address passes the check when saved (public answer)…
      calls.length = 0;
      assert.equal(await w.checkWebhookUrl(`https://rebind.test:${port}/x`), `https://rebind.test:${port}/x`);
      setHook(storeId, `http://rebind.test:${port}/rebind`);
      rcv.got.length = 0;
      // …the attempt resolves once more (still public) and connects only there, so the later 127.0.0.1 answer is never used.
      const first = await w.deliver(store(), { event: 'test', subject: 'x', text: 'x' }, { retry: false });
      assert.equal(first.ok, false);
      assert.equal(calls.length, 2, 'the check and one lookup for the attempt, nothing more');
      assert.equal(rcv.got.length, 0, 'nothing reached the internal address');
      // The next attempt sees the private answer and stops for good.
      const next = await w.deliver(store(), { event: 'test', subject: 'x', text: 'x' });
      assert.deepEqual([next.ok, next.retrying], [false, false]);
      assert.match(next.error, /private network/);
      assert.equal(rcv.got.length, 0);
      note(t, `pinned.test → 127.0.0.1: delivered with Host pinned.test after one lookup. rebind.test (public, public, then 127.0.0.1): first attempt went only to the public address (${first.error}); next attempt refused: ${next.error}. Receiver got nothing.`);
    } finally {
      dns.lookup = realLookup;
      delete process.env.EGRESS_TEST_ALLOW;
      process.env.ALLOW_LOCAL_TARGETS = '1';
    }
  });

  it('alerts: one delivery when a check breaks, none while it stays broken, one when fixed; not on plans without chat alerts', async (t) => {
    rcv.set(() => 200);
    setHook(storeId, `${rcv.url}/alerts`);
    setHook(starterStore, `${rcv.url}/starter`);
    rcv.got.length = 0;
    const fail = { kind: 'journeys', checks: [{ id: 'fn.search', title: 'Search returns products', status: 'fail', severity: 'major', detail: 'Searching "kurta" returned no products.', fix: 'Check your search app.' }, { id: 'fn.home', title: 'Store is reachable', status: 'pass', severity: 'critical' }] };
    const ok = { kind: 'journeys', checks: [{ ...fail.checks[0], status: 'pass' }, fail.checks[1]] };
    await alerts.handleAlerts(storeId, 101, fail);
    await alerts.handleAlerts(storeId, 102, fail);
    await alerts.handleAlerts(storeId, 103, ok);
    await alerts.handleAlerts(starterStore, 104, fail);
    const mine = rcv.got.filter((g) => g.path === '/alerts');
    assert.deepEqual(mine.map((g) => g.json.event), ['alert.failing', 'alert.recovered']);
    assert.deepEqual(mine[0].json.failing, [{ id: 'fn.search', title: 'Search returns products', severity: 'major', detail: 'Searching "kurta" returned no products.', fix: 'Check your search app.' }]);
    assert.equal(mine[0].json.run.id, 101);
    assert.match(mine[0].json.summary, /Check failed on Hook Store: Search returns products/);
    assert.deepEqual(mine[1].json.recovered, [{ id: 'fn.search', title: 'Search returns products' }]);
    assert.equal(mine[1].json.run.id, 103);
    assert.equal(rcv.got.filter((g) => g.path === '/starter').length, 0, 'Starter has no chat alerts, so no webhook');
    note(t, 'break → alert.failing (run 101); still broken (102) → nothing; fixed (103) → alert.recovered; Starter plan → nothing');
  });
});

describe('Webhook alerts in the product', () => {
  let P, owner, other, store, rcv;
  before(async () => {
    rcv = await receiver();
    P = await startProduct({ env: { WEBHOOK_RETRY_MS: '200' }, mock: { breaks: 'search' } });
    owner = await signup(P, 'hooks-owner@shop.test');
    other = await signup(P, 'hooks-other@shop.test');
    store = await addStore(P, owner, { runNow: false });
  });
  after(async () => { rcv?.close(); await P?.stop(); });

  it('the owner sets a webhook; bad addresses and formats are refused; the secret can be renewed', async (t) => {
    const set = (b) => owner.patch(`/api/stores/${store}`, b);
    assert.equal((await set({ webhook: { url: 'ftp://x.example/h' } })).status, 400);
    assert.equal((await set({ webhook: { url: 'nonsense' } })).status, 400);
    assert.equal((await set({ webhook: { url: `${rcv.url}/h`, format: 'xml' } })).status, 400);
    assert.equal((await set({ webhookSecret: 'new' })).status, 400, 'no webhook yet');
    const r = await set({ webhook: { url: `${rcv.url}/h`, format: 'auto' } });
    assert.equal(r.status, 200, r.text);
    const hook = r.json.store.webhook;
    assert.deepEqual([hook.url, hook.format, hook.sendsAs], [`${rcv.url}/h`, 'auto', 'json']);
    assert.match(hook.secret, /^whsec_[\w-]{32}$/);
    assert.ok(!('webhook_json' in r.json.store), 'stored form not exposed');
    const same = await set({ alertEmail: 'hooks-owner@shop.test' });
    assert.equal(same.json.store.webhook.secret, hook.secret, 'other changes keep the secret');
    const renewed = await set({ webhookSecret: 'new' });
    assert.notEqual(renewed.json.store.webhook.secret, hook.secret);
    assert.equal((await other.patch(`/api/stores/${store}`, { webhook: { url: 'https://evil.example/h' } })).status, 404, 'another account');
    assert.equal((await other.get(`/api/stores/${store}/webhook-deliveries`)).status, 404);
    assert.equal((await P.session().get(`/api/stores/${store}/webhook-deliveries`)).status, 401);
    const list = (await other.get('/api/stores')).text;
    assert.ok(!list.includes(renewed.json.store.webhook.secret), 'the secret never reaches another account');
    note(t, 'ftp, nonsense and unknown format refused; secret kept across saves and renewed on request; other accounts refused');
  });

  it('a test alert arrives signed, and shows in the latest deliveries', async () => {
    const secret = (await owner.get(`/api/stores/${store}`)).json.store.webhook.secret;
    rcv.got.length = 0;
    const r = await owner.post(`/api/stores/${store}/test-alert`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.webhook.ok, r.json.webhook.code], [true, 200]);
    assert.equal(rcv.got.length, 1);
    assert.equal(rcv.got[0].json.event, 'test');
    assert.ok(verify(secret, rcv.got[0].headers['x-tharam-signature'], rcv.got[0].body));
    const d = (await owner.get(`/api/stores/${store}/webhook-deliveries`)).json.deliveries;
    assert.deepEqual([d[0].event, d[0].status, d[0].attempts, d[0].last_code], ['test', 'delivered', 1, 200]);
  });

  it('a real broken store sends a signed alert with what broke and the report link', async (t) => {
    const secret = (await owner.get(`/api/stores/${store}`)).json.store.webhook.secret;
    rcv.got.length = 0;
    const run = await runAndWait(owner, store, { kind: 'journeys' });
    assert.equal(run.status, 'done', run.error || '');
    const g = await waitFor(() => rcv.got.find((x) => x.json?.event === 'alert.failing'), 15000);
    assert.ok(verify(secret, g.headers['x-tharam-signature'], g.body));
    assert.ok(g.json.failing.some((c) => c.id === 'fn.search' && c.severity === 'major' && c.fix), JSON.stringify(g.json.failing));
    assert.equal(g.json.run.id, run.id);
    assert.match(g.json.run.reportUrl, new RegExp(`/app#/s/${store}/reports/${run.id}$`));
    assert.equal(g.json.store.id, store);
    note(t, `check #${run.id} found broken search; the webhook got alert.failing with the fix and report link`);
  });

  it('Alerts page: webhook address, format, secret and latest deliveries', async (t) => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      await ctx.addCookies(owner.browserCookies());
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`${P.base}/app#/s/${store}/alerts/channels`);
      await p.waitForSelector('#wh-deliveries li', { timeout: 20000 });
      await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
      assert.equal(await p.inputValue('#wh'), `${rcv.url}/h`);
      assert.match(await p.textContent('#wh-secret'), /^whsec_/);
      assert.match(await p.textContent('#wh-deliveries'), /Delivered/);
      await screenshot(t, p, 'Alerts: webhook with signing secret and latest deliveries', { fullPage: true });
      // Change the format in the page and save.
      await p.selectOption('#whf', 'discord');
      await p.getByRole('button', { name: 'Save changes' }).click();
      await waitFor(async () => (await owner.get(`/api/stores/${store}`)).json.store.webhook.format === 'discord', 10000);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
});
