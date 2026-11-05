// Security watch S8: domain and certificate expiry, store address / name server / mail / SPF / DMARC changes.
// All lookups go to a fake "internet" (FAKE_DOMAIN_DATA JSON file), never the real one.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-domain-'));
const { registeredDomain, compareRecords, emailProblems, runDomain, snapshotFile } = await import('../src/engine/domain.js');
const { Recorder } = await import('../src/engine/checks.js');
const { groupOf, GROUPS } = await import('../src/engine/catalog.js');
const { scoreChecks } = await import('../src/engine/score.js');

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const inDays = (n) => new Date(NOW + n * DAY).toISOString();

/** A healthy custom-domain Shopify store as the internet would show it. */
function world() {
  return {
    host: 'shop.example.com',
    dns: {
      'shop.example.com': { CNAME: ['shops.myshopify.com'] },
      'example.com': { NS: ['ns1.goodhost.net', 'ns2.goodhost.net'], MX: ['10 mx.mailhost.com'], TXT: ['v=spf1 include:shops.shopify.com include:_spf.mailhost.com ~all', 'google-site-verification=abc'] },
      '_dmarc.example.com': { TXT: ['v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com'] },
    },
    certs: { 'shop.example.com': { validTo: inDays(80), issuer: "Let's Encrypt", trusted: true } },
    rdap: { 'example.com': { expires: inDays(300), registrar: 'GoodHost Registrar' } },
  };
}

/** In-process lookups over a world object. */
function L(w) {
  const down = (k) => { if ((w.down || []).includes(k)) throw Object.assign(new Error('lookup timed out'), { code: 'ETIMEOUT' }); };
  return {
    host: () => w.host,
    async dns(name, type) { down('dns'); return w.dns[name]?.[type] || []; },
    async cert(h) { down('cert'); return w.certs[h] || null; },
    async rdap(d) { down('rdap'); return w.rdap[d] ? { known: true, ...w.rdap[d] } : { known: false, expires: null }; },
  };
}

let storeN = 0;
async function scan(w, { storeId = ++storeN, now = NOW } = {}) {
  const rec = new Recorder();
  await runDomain({ rec, request: null, origin: 'https://shop.example.com', storeId, now, L: L(w) });
  const by = Object.fromEntries(rec.checks.map((c) => [c.id, c]));
  return { rec, by, storeId };
}

describe('Domain watch: the rules', () => {
  it('finds the registered domain name of a store address', () => {
    assert.equal(registeredDomain('shop.example.com'), 'example.com');
    assert.equal(registeredDomain('www.kurta.co.in'), 'kurta.co.in');
    assert.equal(registeredDomain('example.co.uk'), 'example.co.uk');
    assert.equal(registeredDomain('Store.Example.COM.'), 'example.com');
    assert.equal(registeredDomain('127.0.0.1'), null);
    assert.equal(registeredDomain('localhost'), null);
  });

  it('every domain check belongs to the switchable Security group, outside the health score', () => {
    const g = GROUPS.find((x) => x.key === 'security.domain');
    assert.equal(g.run, 'full');
    assert.equal(g.area, 'Security');
    for (const id of ['sec.domain.cert', 'sec.domain.expiry', 'sec.domain.dns', 'sec.domain.email']) assert.equal(groupOf(id), 'security.domain');
    const healthy = scoreChecks([{ id: 'fn.home', category: 'functional', status: 'pass', severity: 'critical' }]);
    const withDomain = scoreChecks([{ id: 'fn.home', category: 'functional', status: 'pass', severity: 'critical' }, { id: 'sec.domain.cert', category: 'security', status: 'warn', severity: 'minor' }]);
    assert.equal(withDomain.score, healthy.score, 'a domain warning never lowers the health score');
  });

  it('nothing changed: nothing reported; a different store address is never compared', async () => {
    const a = (await import('../src/engine/domain.js')).readRecords;
    const r = await a('shop.example.com', L(world()));
    assert.deepEqual(compareRecords(r, r), []);
    assert.deepEqual(compareRecords({ ...r, host: 'other.example.com' }, r), []);
    assert.deepEqual(compareRecords(r, null), []);
  });

  it('name server, mail server and store address changes are caught with before and after', async (t) => {
    const { readRecords } = await import('../src/engine/domain.js');
    const before = await readRecords('shop.example.com', L(world()));
    const w = world();
    w.dns['example.com'].NS = ['ns1.evil-dns.ru', 'ns2.evil-dns.ru'];
    w.dns['example.com'].MX = ['10 mx.evil-dns.ru'];
    w.dns['shop.example.com'] = { A: ['203.0.113.66'] };
    const changes = compareRecords(await readRecords('shop.example.com', L(w)), before);
    assert.deepEqual(changes.map((c) => c.serious), [true, true, true]);
    assert.match(changes[0].what, /no longer points to Shopify/);
    assert.equal(changes[0].before, 'shops.myshopify.com');
    assert.equal(changes[0].after, '203.0.113.66');
    assert.match(changes[1].what, /name servers/);
    assert.equal(changes[1].after, 'ns1.evil-dns.ru, ns2.evil-dns.ru');
    assert.match(changes[2].what, /email to your domain/);
    for (const c of changes) note(t, `${c.what}: ${c.before} → ${c.after}`);
  });

  it('rotating server addresses are not a change; a complete switch is', async () => {
    const { readRecords } = await import('../src/engine/domain.js');
    const w1 = world(); w1.dns['shop.example.com'] = { A: ['198.51.100.1', '198.51.100.2'] };
    const w2 = world(); w2.dns['shop.example.com'] = { A: ['198.51.100.2', '198.51.100.3'] };
    const w3 = world(); w3.dns['shop.example.com'] = { A: ['203.0.113.9'] };
    const r1 = await readRecords('shop.example.com', L(w1));
    assert.deepEqual(compareRecords(await readRecords('shop.example.com', L(w2)), r1), []);
    const c = compareRecords(await readRecords('shop.example.com', L(w3)), r1);
    assert.equal(c.length, 1);
    assert.match(c[0].what, /server behind your store address/);
    // Moving between Shopify's own addresses is fine.
    const s1 = world(); s1.dns['shop.example.com'] = { A: ['23.227.38.65'] };
    const s2 = world(); s2.dns['shop.example.com'] = { A: ['23.227.38.74'] };
    assert.deepEqual(compareRecords(await readRecords('shop.example.com', L(s2)), await readRecords('shop.example.com', L(s1))), []);
  });

  it('SPF opened to anyone and DMARC weakened are serious; a stricter DMARC is only worth a look', async (t) => {
    const { readRecords } = await import('../src/engine/domain.js');
    const before = await readRecords('shop.example.com', L(world()));
    const w = world();
    w.dns['example.com'].TXT = ['v=spf1 +all'];
    w.dns['_dmarc.example.com'].TXT = ['v=DMARC1; p=none'];
    const c = compareRecords(await readRecords('shop.example.com', L(w)), before);
    assert.deepEqual(c.map((x) => [x.what.slice(0, 20), x.serious]), [['Who may send email a', true], ['Protection against f', true]]);
    note(t, c.map((x) => `${x.what}: ${x.before} → ${x.after}`).join(' | '));
    const s = world(); s.dns['_dmarc.example.com'].TXT = ['v=DMARC1; p=reject'];
    const c2 = compareRecords(await readRecords('shop.example.com', L(s)), before);
    assert.equal(c2.length, 1);
    assert.equal(c2[0].serious, false);
    assert.match(c2[0].what, /DMARC email record changed/);
  });

  it('missing, doubled or open SPF and missing DMARC are explained in plain words', () => {
    const base = { spf: ['v=spf1 include:shops.shopify.com ~all'], dmarc: ['v=dmarc1; p=none'] };
    assert.deepEqual(emailProblems(base), []);
    assert.match(emailProblems({ ...base, spf: [] })[0], /No SPF record/);
    assert.match(emailProblems({ ...base, spf: ['v=spf1 a ~all', 'v=spf1 mx ~all'] })[0], /2 SPF records/);
    assert.match(emailProblems({ ...base, spf: ['v=spf1 +all'] })[0], /lets anyone send email/);
    assert.match(emailProblems({ ...base, dmarc: [] })[0], /No DMARC record/);
  });
});

describe('Domain watch: one check', () => {
  it('a healthy domain passes, saves its records and says what it will watch', async (t) => {
    const { by, storeId } = await scan(world());
    assert.equal(by['sec.domain.cert'].status, 'pass');
    assert.match(by['sec.domain.cert'].detail, /Valid until 2027-01-24 \(80 days\), issued by Let's Encrypt/);
    assert.equal(by['sec.domain.expiry'].status, 'pass');
    assert.match(by['sec.domain.expiry'].detail, /example.com is registered until/);
    assert.equal(by['sec.domain.dns'].status, 'pass');
    assert.equal(by['sec.domain.dns'].notice, true, 'a notice: news once, never "recovered"');
    assert.match(by['sec.domain.dns'].detail, /Saved the records/);
    assert.equal(by['sec.domain.email'].status, 'pass');
    assert.ok(fs.existsSync(snapshotFile(storeId)));
    for (const c of Object.values(by)) note(t, `${c.title}: ${c.status} — ${c.detail}`);
  });

  it('certificate: warning a month ahead, a problem two weeks ahead, expired or untrusted', async (t) => {
    const cases = [[25, 'warn', 'minor'], [10, 'fail', 'major'], [-2, 'fail', 'major']];
    for (const [days, status, severity] of cases) {
      const w = world(); w.certs['shop.example.com'].validTo = inDays(days);
      const c = (await scan(w)).by['sec.domain.cert'];
      assert.equal(c.status, status, `${days} days`);
      assert.equal(c.severity, severity);
      note(t, `${days} days left → ${c.status}: ${c.detail}`);
    }
    const w = world(); w.certs['shop.example.com'] = { validTo: inDays(200), trusted: false, error: 'SELF_SIGNED_CERT' };
    const u = (await scan(w)).by['sec.domain.cert'];
    assert.equal(u.status, 'fail');
    assert.match(u.detail, /don't trust/);
    const none = world(); delete none.certs['shop.example.com'];
    assert.match((await scan(none)).by['sec.domain.cert'].detail, /did not show a security certificate/);
    assert.match(u.fix, /Settings → Domains/);
  });

  it('domain registration: warning two months ahead, a problem a month ahead, with the registrar named', async (t) => {
    const cases = [[50, 'warn'], [20, 'fail'], [-1, 'fail']];
    for (const [days, status] of cases) {
      const w = world(); w.rdap['example.com'].expires = inDays(days);
      const c = (await scan(w)).by['sec.domain.expiry'];
      assert.equal(c.status, status, `${days} days`);
      note(t, `${days} days left → ${c.status}: ${c.detail}`);
      if (status === 'fail') assert.match(c.fix, /Sign in at GoodHost Registrar, renew example.com and turn on auto-renew/);
    }
    const hidden = world(); hidden.rdap = {};
    const c = (await scan(hidden)).by['sec.domain.expiry'];
    assert.equal(c.status, 'skip');
    assert.match(c.detail, /doesn't publish renewal dates/);
  });

  it('a change is reported once with before and after; the next check is quiet and not "fixed"', async (t) => {
    const storeId = ++storeN;
    await scan(world(), { storeId });
    const w = world(); w.dns['example.com'].MX = ['10 mx.evil-dns.ru'];
    const { by } = await scan(w, { storeId });
    const c = by['sec.domain.dns'];
    assert.equal(c.status, 'fail');
    assert.equal(c.severity, 'major');
    assert.equal(c.notice, true);
    assert.match(c.detail, /Where email to your domain is delivered changed: 10 mx.mailhost.com → 10 mx.evil-dns.ru/);
    assert.equal(c.evidence.changes.length, 1);
    note(t, c.detail);
    const again = (await scan(w, { storeId })).by['sec.domain.dns'];
    assert.equal(again.status, 'pass');
    assert.match(again.detail, /No changes/);
  });

  it('a lookup that fails keeps the saved records, so a change is still caught next time', async () => {
    const storeId = ++storeN;
    await scan(world(), { storeId });
    const saved = fs.readFileSync(snapshotFile(storeId), 'utf8');
    const down = world(); down.down = ['dns', 'cert', 'rdap'];
    const { by } = await scan(down, { storeId });
    for (const id of ['sec.domain.cert', 'sec.domain.expiry', 'sec.domain.dns', 'sec.domain.email']) assert.equal(by[id].status, 'skip', id);
    assert.equal(fs.readFileSync(snapshotFile(storeId), 'utf8'), saved);
    const w = world(); w.dns['example.com'].NS = ['ns1.other.net'];
    assert.equal((await scan(w, { storeId })).by['sec.domain.dns'].status, 'fail');
  });

  it("stores on their Shopify address are skipped: Shopify looks after that domain", async () => {
    const w = world(); w.host = 'kurta-house.myshopify.com';
    const { by, storeId } = await scan(w);
    assert.deepEqual(Object.values(by).map((c) => c.status), ['skip', 'skip', 'skip', 'skip']);
    assert.match(by['sec.domain.cert'].detail, /Shopify looks after that domain/);
    assert.equal(fs.existsSync(snapshotFile(storeId)), false);
  });
});

describe('Domain watch: in the product', () => {
  let product, owner, storeId, file;
  const group = { groups: ['security.domain'] };
  const write = (w) => fs.writeFileSync(file, JSON.stringify(w));
  const real = () => { const w = world(); w.certs['shop.example.com'].validTo = new Date(Date.now() + 80 * DAY).toISOString(); w.rdap['example.com'].expires = new Date(Date.now() + 300 * DAY).toISOString(); return w; };

  before(async () => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-fake-dns-')), 'internet.json');
    const w = real(); delete w.dns['_dmarc.example.com']; // start without DMARC: a "worth a look" item
    write(w);
    product = await startProduct({ env: { FAKE_DOMAIN_DATA: file } });
    owner = await signup(product);
    storeId = await addStore(product, owner);
  });
  after(async () => { await product?.stop(); });

  it('the group is listed in the test suite under Security', async () => {
    const r = await owner.get('/api/catalog');
    const all = JSON.stringify(r.json);
    assert.match(all, /security\.domain/);
    assert.match(all, /Domain, certificate and email records/);
  });

  it('first full check saves the records and points out the missing DMARC record', async (t) => {
    const run = await runAndWait(owner, storeId, group);
    assert.equal(run.status, 'done', run.error);
    const by = Object.fromEntries(run.result.checks.map((c) => [c.id, c]));
    assert.equal(by['sec.domain.cert'].status, 'pass');
    assert.equal(by['sec.domain.expiry'].status, 'pass');
    assert.equal(by['sec.domain.dns'].status, 'pass');
    assert.equal(by['sec.domain.email'].status, 'warn');
    assert.match(by['sec.domain.email'].detail, /No DMARC record/);
    assert.equal(run.result.verdict, 'healthy', 'domain warnings never change the verdict');
    assert.ok(fs.existsSync(path.join(product.dataDir, 'domain', `store-${storeId}.json`)));
    note(t, by['sec.domain.email'].detail);
  });

  it('name servers and mail moved and the certificate is running out: one alert email with before and after', async (t) => {
    const w = real(); delete w.dns['_dmarc.example.com'];
    w.dns['example.com'].NS = ['ns1.evil-dns.ru', 'ns2.evil-dns.ru'];
    w.dns['example.com'].MX = ['10 mx.evil-dns.ru'];
    w.certs['shop.example.com'].validTo = new Date(Date.now() + 5 * DAY).toISOString();
    write(w);
    const mark = product.log().length;
    const run = await runAndWait(owner, storeId, group);
    const by = Object.fromEntries(run.result.checks.map((c) => [c.id, c]));
    assert.equal(by['sec.domain.dns'].status, 'fail');
    assert.deepEqual(by['sec.domain.dns'].evidence.changes.map((c) => c.after), ['ns1.evil-dns.ru, ns2.evil-dns.ru', '10 mx.evil-dns.ru']);
    assert.equal(by['sec.domain.cert'].status, 'fail');
    assert.match(by['sec.domain.cert'].detail, /runs out in [45] days/);
    await new Promise((r) => setTimeout(r, 500));
    const mail = product.log().slice(mark);
    assert.match(mail, /\[mail skipped\] to=owner-.* subject=Check failed on Mock Store/);
    assert.match(mail, /Domain and email records unchanged: Records for example.com changed since the last check\. Your domain moved to different name servers/);
    assert.match(mail, /ns1.goodhost.net, ns2.goodhost.net → ns1.evil-dns.ru, ns2.evil-dns.ru/);
    assert.match(mail, /Security certificate \(padlock\) is valid/);
    note(t, mail.split('\n').filter((l) => /🔴/.test(l)).join('\n'));

    // The report shows the changes as a before / now table.
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addCookies(owner.browserCookies());
      const page = await ctx.newPage();
      await page.goto(`${product.base}/app#/s/${storeId}/reports/${run.id}`);
      await page.locator('[data-rtab="areas"]').click();
      const table = page.locator('.record-changes').first();
      await table.waitFor({ timeout: 20000 });
      await table.scrollIntoViewIfNeeded();
      assert.match(await table.innerText(), /name servers[\s\S]*ns1.goodhost.net[\s\S]*ns1.evil-dns.ru/);
      await page.evaluate(() => window.scrollBy(0, -160));
      await screenshot(t, page, 'report: domain records changed, before and now');
    } finally { await browser.close(); }
  });

  it('next check: records unchanged since then, so no new email and no "fixed" email for the records', async () => {
    const mark = product.log().length;
    const run = await runAndWait(owner, storeId, group);
    const by = Object.fromEntries(run.result.checks.map((c) => [c.id, c]));
    assert.equal(by['sec.domain.dns'].status, 'pass');
    assert.equal(by['sec.domain.cert'].status, 'fail', 'certificate still running out');
    await new Promise((r) => setTimeout(r, 500));
    assert.doesNotMatch(product.log().slice(mark), /\[mail skipped\]/);
  });

  it('certificate renewed: one "fixed" email for the certificate only', async () => {
    const w = real(); delete w.dns['_dmarc.example.com'];
    w.dns['example.com'].NS = ['ns1.evil-dns.ru', 'ns2.evil-dns.ru'];
    w.dns['example.com'].MX = ['10 mx.evil-dns.ru'];
    write(w);
    const mark = product.log().length;
    const run = await runAndWait(owner, storeId, group);
    assert.equal(run.result.checks.find((c) => c.id === 'sec.domain.cert').status, 'pass');
    await new Promise((r) => setTimeout(r, 500));
    const mail = product.log().slice(mark);
    assert.match(mail, /subject=Fixed on Mock Store: Security certificate \(padlock\) is valid\n/);
  });

  it('switched off in the test suite: no domain checks at all', async () => {
    const run = await runAndWait(owner, storeId, { groups: ['catalog'] });
    assert.equal(run.result.checks.filter((c) => c.id.startsWith('sec.domain.')).length, 0);
  });

  it('removing the store removes its saved records', async () => {
    const r = await owner.del(`/api/stores/${storeId}`);
    assert.equal(r.status, 200);
    assert.equal(fs.existsSync(path.join(product.dataDir, 'domain', `store-${storeId}.json`)), false);
  });
});
