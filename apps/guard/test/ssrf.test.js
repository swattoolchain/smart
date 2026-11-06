// The test browser and the free scan never reach internal addresses (security audit finding #1, T87).
// Runs WITHOUT ALLOW_LOCAL_TARGETS, so the real guard is exercised.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { note } from './lib/evidence.js';

delete process.env.ALLOW_LOCAL_TARGETS;
// 127.0.0.2 plays an outside "store" that redirects to an internal service on 127.0.0.1.
process.env.EGRESS_TEST_ALLOW = '127.0.0.2';
const { isPrivateIp } = await import('../src/egress.js');
const { normalizeStoreUrl, assertPublicTarget, getBrowser, newContext } = await import('../src/engine/browser.js');

describe('No internal addresses (SSRF)', () => {
  let internal, store, hits = 0, port, storePort;
  before(async () => {
    internal = http.createServer((req, res) => { hits++; res.end('INTERNAL-ONLY secret=AKIA-EXAMPLE'); });
    await new Promise((r) => internal.listen(0, '127.0.0.1', r));
    port = internal.address().port;
    store = http.createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${port}/latest/meta-data/` }); return res.end(); }
      if (req.url === '/mapped') { res.writeHead(302, { Location: `http://[::ffff:127.0.0.1]:${port}/` }); return res.end(); }
      res.setHeader('Content-Type', 'text/html');
      res.end(`<h1>Store</h1><script>fetch('http://127.0.0.1:${port}/from-page').catch(()=>{});</script><img src="http://127.0.0.1:${port}/img.png">`);
    });
    await new Promise((r) => store.listen(0, '0.0.0.0', r));
    storePort = store.address().port;
  });
  after(async () => { internal.close(); store.close(); (await getBrowser()).close(); });

  it('classifies internal addresses, including IPv6 forms that used to slip through', () => {
    for (const a of ['127.0.0.1', '10.0.0.5', '172.17.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', 'fec0::1', 'fd00::1', 'fe80::1', 'not-an-ip'])
      assert.equal(isPrivateIp(a), true, a);
    for (const a of ['8.8.8.8', '23.227.38.65', '2606:4700::6810:85e5']) assert.equal(isPrivateIp(a), false, a);
  });

  it('refuses internal addresses typed in, in any spelling', async () => {
    for (const u of ['http://127.0.0.1:9999', 'http://2130706433', 'http://0x7f000001', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://169.254.169.254', 'localhost:3000', 'shop.localhost', 'http://10.0.0.1'])
      assert.throws(() => normalizeStoreUrl(u), /Internal addresses|full domain/, u);
    await assert.rejects(() => assertPublicTarget('http://127.0.0.1:9999'), /private network/);
  });

  it('a store that redirects to an internal address never reaches it, and no internal page is shown', async (t) => {
    const ctx = await newContext();
    const page = await ctx.newPage();
    hits = 0;
    await page.goto(`http://127.0.0.2:${storePort}/redirect`).catch(() => {});
    const text = await page.textContent('body').catch(() => '');
    assert.equal(hits, 0, 'the internal service was never contacted');
    assert.doesNotMatch(text, /INTERNAL-ONLY/);
    await page.goto(`http://127.0.0.2:${storePort}/mapped`).catch(() => {});
    assert.equal(hits, 0, 'IPv4-mapped IPv6 redirect refused');
    note(t, `after redirects: internal hits ${hits}; page says "${text.slice(0, 120)}"`);
    await ctx.close();
  });

  it('requests from inside a store page and from Tharam\'s own direct requests are refused too', async () => {
    const ctx = await newContext();
    const page = await ctx.newPage();
    hits = 0;
    await page.goto(`http://127.0.0.2:${storePort}/`);
    await page.waitForTimeout(800);
    const r = await ctx.request.get(`http://127.0.0.2:${storePort}/redirect`).catch((e) => ({ status: () => 0, e }));
    assert.equal(hits, 0, 'no in-page fetch, image or direct request reached the internal service');
    assert.notEqual(r.status(), 200);
    await ctx.close();
  });

  it('a public store still loads normally', async () => {
    const ctx = await newContext();
    const page = await ctx.newPage();
    const res = await page.goto(`http://127.0.0.2:${storePort}/`);
    assert.equal(res.status(), 200);
    assert.match(await page.textContent('h1'), /Store/);
    await ctx.close();
  });
});
