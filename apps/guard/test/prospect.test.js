// Prospect checker (go-to-market tool): light, polite checks of public stores, findings only.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startMock, freePort, ROOT } from './lib/harness.js';
import { note } from './lib/evidence.js';

process.env.ALLOW_LOCAL_TARGETS = '1'; // the mock stores run on localhost
const { checkStore, checkStores, parseRobots, robotsAllows, checkoutHostOk, readStoreList, toCsv, USER_AGENT, MAX_CONCURRENCY } = await import('../src/prospect.js');

const allRequests = async (m) => (await (await fetch(`${m.origin}/__requests`)).json()).requests;
// Requests made since `mark` (the harness itself probes /products.json when a mock starts).
const requests = async (m, mark = 0) => (await allRequests(m)).slice(mark);
const markOf = async (m) => (await allRequests(m)).length;
const pageish = (r) => !/^\/(img\/|favicon)/.test(r.path);

describe('Prospect checker', () => {
  let browser;
  const mocks = {};
  const mock = async (name, opts) => (mocks[name] ||= await startMock(opts));
  before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] }); });
  after(async () => { await browser?.close(); for (const m of Object.values(mocks)) m.stop(); });

  it('a healthy store: home, prices, product, add to cart and checkout, one visit per page, as TharamBot', async (t) => {
    const m = await mock('healthy');
    const mark = await markOf(m);
    const log = [];
    const r = await checkStore(m.origin, { browser, log: (e) => log.push(e) });
    assert.equal(r.status, 'ok', r.error);
    assert.equal(r.home_ok, true);
    assert.ok(r.home_load_ms > 0);
    assert.equal(r.products, 3);
    assert.equal(r.zero_price_products, 1, 'the mock diya is priced at zero');
    assert.equal(r.zero_price_example, '/products/brass-diya');
    assert.equal(r.product_page_ok, true);
    assert.equal(r.add_to_cart, 'works');
    assert.equal(r.checkout, 'works');
    assert.equal(r.checkout_host, new URL(m.origin).host);
    assert.deepEqual(r.findings, ['1 product is for sale at a price of zero']);
    // Polite: every request it made on purpose is different, and the store saw each page at most once.
    const paths = log.map((e) => e.path);
    assert.equal(new Set(paths).size, paths.length, `no repeats: ${paths.join(', ')}`);
    const seen = (await requests(m, mark)).filter(pageish);
    const counts = {};
    for (const x of seen) counts[`${x.method} ${x.path}`] = (counts[`${x.method} ${x.path}`] || 0) + 1;
    for (const [k, n] of Object.entries(counts)) assert.equal(n, 1, `${k} requested ${n} times`);
    assert.ok(seen.every((x) => x.ua === USER_AGENT), 'every request says TharamBot');
    assert.match(USER_AGENT, /TharamBot\/1\.0 \(\+https:\/\/tharam\.store\/bot\)/);
    // Never places an order or types anything: no form posts other than add to cart, nothing after checkout opens.
    assert.deepEqual(seen.filter((x) => x.method !== 'GET').map((x) => x.path), ['/cart/add.js']);
    assert.ok(!seen.some((x) => /orders|payment|thank/i.test(x.path)));
    // Findings only: nothing from the page itself.
    const csv = toCsv([r]);
    assert.ok(!/Organic Cotton|Handwoven|Brass Diya Set|Handmade in India/.test(csv), 'no page content in the output');
    note(t, `Requests: ${Object.keys(counts).join(', ')}`);
  });

  it('finds broken add to cart and a checkout that does not open', async (t) => {
    const atc = await checkStore((await mock('atc', { breaks: 'atc' })).origin, { browser });
    assert.equal(atc.add_to_cart, 'broken');
    assert.ok(atc.findings.includes('Add to cart does nothing: the cart stays empty'));
    assert.equal(atc.checkout, 'not checked', 'no checkout without an item in the cart');
    const co = await checkStore((await mock('checkout', { breaks: 'checkout' })).origin, { browser });
    assert.equal(co.add_to_cart, 'works');
    assert.equal(co.checkout, 'not reached');
    assert.ok(co.findings.includes('Checkout sends shoppers back instead of opening'));
    note(t, `atc: ${atc.findings.join('; ')} | checkout: ${co.findings.join('; ')}`);
  });

  it('respects Shopify’s default robots.txt: no cart and no checkout', async (t) => {
    const m = await mock('robots-shopify', { extra: 'robots-shopify' });
    const mark = await markOf(m);
    const r = await checkStore(m.origin, { browser });
    assert.equal(r.status, 'ok', r.error);
    assert.equal(r.product_page_ok, true);
    assert.equal(r.add_to_cart, 'button present', 'button checked, not clicked');
    assert.equal(r.checkout, 'not checked');
    assert.ok(r.skipped.includes('add to cart (robots.txt)'));
    const seen = (await requests(m, mark)).map((x) => x.path);
    assert.ok(!seen.some((p) => /^\/(cart|checkout)/.test(p)), `never opened cart or checkout: ${seen.join(', ')}`);
    note(t, `Visited: ${[...new Set(seen.filter((p) => !p.startsWith('/img/')))].join(', ')}; skipped: ${r.skipped.join(', ')}`);
  });

  it('stays away when robots.txt says so, and waits for the crawl delay', async () => {
    const blocked = await mock('robots-block', { extra: 'robots-block' });
    const mark = await markOf(blocked);
    const r = await checkStore(blocked.origin, { browser });
    assert.equal(r.status, 'skipped');
    assert.deepEqual((await requests(blocked, mark)).map((x) => x.path), ['/robots.txt'], 'only robots.txt was read');

    const slow = await mock('robots-slow', { extra: 'robots-slow' });
    const times = [];
    await checkStore(slow.origin, { browser, log: (e) => times.push(Date.now()) });
    const gaps = times.slice(2).map((x, i) => x - times[i + 1]);
    assert.ok(gaps.every((g) => g >= 1900), `2 s between requests: ${gaps.join(', ')} ms`);
  });

  it('locked, unreachable, not a store, and bad addresses are reported, not retried', async () => {
    const locked = await checkStore((await mock('password', { breaks: 'password' })).origin, { browser });
    assert.equal(locked.status, 'locked');
    assert.deepEqual(locked.findings, ['The store is password protected']);
    const port = await freePort();
    const down = await checkStore(`http://localhost:${port}`, { browser });
    assert.equal(down.status, 'unreachable');
    assert.equal((await checkStore('', { browser })).status, 'invalid');
    assert.equal((await checkStore('ftp://shop.example', { browser })).status, 'invalid');
    // Outside tests, private and internal addresses are refused before anything is fetched.
    const code = "import('./src/prospect.js').then(async (m) => { const out = []; for (const u of ['http://localhost:3000', 'http://10.0.0.5', 'http://192.168.1.1']) out.push((await m.checkStore(u, {})).status); console.log(JSON.stringify(out)); })";
    const env = { ...process.env }; delete env.ALLOW_LOCAL_TARGETS;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8', env, timeout: 30000 });
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), ['invalid', 'invalid', 'invalid']);
  });

  it('checks at most two stores at a time, whatever it is asked', async (t) => {
    const a = await mock('healthy'), b = await mock('atc', { breaks: 'atc' }), c = await mock('checkout', { breaks: 'checkout' });
    const alias = (m) => m.origin.replace('localhost', '127.0.0.1');
    const list = [a.origin, b.origin, c.origin, alias(a), alias(b), a.origin /* duplicate */];
    let active = 0, peak = 0;
    const started = new Set();
    const results = await checkStores(list, {
      browser, concurrency: 10,
      log: (e) => { if (!started.has(e.store)) { started.add(e.store); active++; peak = Math.max(peak, active); } },
      onResult: () => { active--; },
    });
    assert.equal(MAX_CONCURRENCY, 2);
    assert.ok(peak <= 2, `peak ${peak}`);
    assert.equal(peak, 2, 'uses both slots');
    assert.equal(results.length, 5, 'duplicate store checked once');
    note(t, `5 stores (1 duplicate dropped), asked for 10 at a time, peak ${peak}`);
  });

  it('robots rules, checkout addresses and store lists', () => {
    const r = parseRobots('User-agent: *\nDisallow: /cart\nAllow: /products/*.js\nDisallow: /products/hidden$\nCrawl-delay: 60\n\nUser-agent: OtherBot\nDisallow: /\n');
    assert.equal(robotsAllows(r, '/'), true);
    assert.equal(robotsAllows(r, '/cart/add.js'), false);
    assert.equal(robotsAllows(r, '/products/hidden'), false);
    assert.equal(robotsAllows(r, '/products/hidden-gem'), true);
    assert.equal(r.delayMs, 10000, 'crawl delay capped at 10 s');
    assert.equal(robotsAllows(parseRobots('User-agent: tharambot\nDisallow: /\n'), '/'), false, 'agent names ignore case');
    const ctx = { storeHost: 'shop.example', shopDomain: 'shop-1.myshopify.com' };
    for (const h of ['shop.example', 'www.shop.example', 'shop-1.myshopify.com', 'checkout.shopify.com', 'shop.app']) assert.equal(checkoutHostOk(h, ctx), true, h);
    for (const h of ['shop-pay-secure.example', 'other.myshopify.com', 'shop.example.evil.test', '']) assert.equal(checkoutHostOk(h, ctx), false, h);
    assert.deepEqual(readStoreList('Store,Notes\nshop.example,"a, b"\nhttps://two.example\n'), ['shop.example', 'https://two.example']);
    assert.deepEqual(readStoreList('one.example\ntwo.example\n\n'), ['one.example', 'two.example']);
  });

  it('the command line writes a findings CSV as it goes', async (t) => {
    const m = await mock('healthy');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospect-'));
    const input = path.join(dir, 'stores.csv'), output = path.join(dir, 'findings.csv');
    fs.writeFileSync(input, `url\n${m.origin}\n`);
    const r = spawnSync(process.execPath, ['scripts/prospect-check.js', input, output], { cwd: ROOT, encoding: 'utf8', env: { ...process.env }, timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    const lines = fs.readFileSync(output, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^store,checked_at,status,/);
    assert.match(lines[1], new RegExp(`^${m.origin},`));
    assert.match(lines[1], /,ok,/);
    assert.match(lines[1], /for sale at a price of zero/);
    fs.rmSync(dir, { recursive: true, force: true });
    note(t, r.stdout.trim().split('\n').join(' | '));
  });
});
