// Prospects in the founder console: import and de-duplicate store lists, read each store's public details,
// light check, filters and export. Founders only, behind the 'prospects' switch.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startProduct, startMock, signup, founderSession } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

process.env.ALLOW_LOCAL_TARGETS = '1'; // the mock stores run on localhost
const { normalizeDomain, parseList, findContacts, storeOwnEmail, riskOf, icpScore, countryCode, inEU, prospectsCsv } = await import('../src/prospect-parse.js');

const TOKEN = 'test-prospect-api-token';
const text = (body) => ({ 'content-type': 'text/plain' });
const reqs = async (m) => (await (await fetch(`${m.origin}/__requests`)).json()).requests;
const domainOf = (m) => new URL(m.origin).host; // localhost:PORT, kept with its port for local test stores

describe('Prospects: reading lists and addresses', () => {
  it('one store, however it is written, is one domain', (t) => {
    const forms = ['Shop.Example.com', 'https://www.shop.example.com/products/x?y=1', 'shop.example.com.', 'HTTP://WWW.SHOP.EXAMPLE.COM:8080/', '  "shop.example.com" ', 'user@shop.example.com'];
    for (const f of forms) assert.equal(normalizeDomain(f), 'shop.example.com', f);
    for (const bad of ['', 'nodot', 'a b', 'http://', '-bad-.com', 'x..com', '10.0.0.1.', 'ftp:/x']) assert.equal(normalizeDomain(bad), null, `"${bad}" is not a store address`);
    note(t, `${forms.length} ways of writing one store give one domain; ${8} bad entries refused`);
  });

  it('reads a header column, a plain list or pasted links, and cuts at 100,000', (t) => {
    assert.deepEqual(parseList('rank,domain,visits\n1,a.com,5\n2,https://www.B.com/x,7\n').domains, ['a.com', 'b.com']);
    assert.deepEqual(parseList('a.com\nb.in, c.co.uk;d.com.au\nsomeone@x.com\njust words\n').domains, ['a.com', 'b.in', 'c.co.uk', 'd.com.au']);
    const big = Array.from({ length: 100005 }, (_, i) => `s${i}.example.com`).join('\n');
    const r = parseList(big);
    assert.equal(r.domains.length, 100000);
    assert.equal(r.truncated, true);
    note(t, 'header column, plain list, pasted links read; email addresses ignored; list cut at 100,000 and said so');
  });

  it('public contact details: only the store\'s own email, never a personal one', (t) => {
    assert.equal(storeOwnEmail('hello@kaveri.in', 'kaveri.in'), true, 'on the store\'s own domain');
    assert.equal(storeOwnEmail('support@other.example', 'kaveri.in'), true, 'a shared role address');
    assert.equal(storeOwnEmail('ravi.kumar@gmail.com', 'kaveri.in'), false, 'a personal address');
    assert.equal(storeOwnEmail('support@gmail.com', 'kaveri.in'), false, 'a free mail provider');
    assert.equal(storeOwnEmail('logo@2x.png', 'kaveri.in'), false);
    const c = findContacts('<footer><a href="mailto:ravi@gmail.com">me</a> <a href="mailto:care@kaveri.in?subject=Hi">Mail</a><a href="tel:+91 98765 43210">Call</a></footer><script>"x@y.com"</script>', 'www.kaveri.in');
    assert.deepEqual(c, { email: 'care@kaveri.in', phone: '+919876543210' });
    assert.deepEqual(findContacts('Order 1234567890123456789 now', 'kaveri.in'), { email: '', phone: '' }, 'no guessing');
    note(t, 'own-domain and role addresses kept; personal and free-mail addresses dropped; phone from tel: or a +number only');
  });

  it('the finding is in plain words, the biggest problem first, with a risk score', (t) => {
    const r = riskOf({ findings: ['The home page is slow on phones (6.2 s before the main content shows)', 'Add to cart does nothing: the cart stays empty'] });
    assert.equal(r.finding, 'Add to cart does nothing: the cart stays empty');
    assert.equal(r.score, 95);
    assert.deepEqual(riskOf({ findings: [] }), { finding: '', score: 0, findings: [] });
    assert.equal(riskOf({ findings: ['Not a Shopify store'] }).finding, '');
    assert.equal(countryCode('India'), 'IN');
    assert.equal(inEU('DE'), true);
    assert.equal(inEU('GB'), false);
    assert.ok(icpScore({ country: 'IN', products: 20, shopify: true, email: 'a@b.in' }) > icpScore({ country: 'US', products: 20, shopify: true, email: 'a@b.in' }), 'India first');
    note(t, 'biggest problem first, plain words, score 0 when nothing is wrong; India scores above US');
  });

  it('a spreadsheet never runs text from another website as a formula', () => {
    const csv = prospectsCsv([{ domain: 'a.com', store_name: '=HYPERLINK("http://x")', finding: 'ok, fine' }]);
    assert.match(csv, /'=HYPERLINK\(""http:\/\/x""\)/);
    assert.match(csv, /"ok, fine"/);
  });
});

describe('Prospects in the founder console', () => {
  let P, boss, owner, browser, home, us, eu, blockedStore;
  before(async () => {
    P = await startProduct({ env: { PROSPECT_API_TOKEN: TOKEN, PROSPECT_CHECKS_PER_DAY: '5' } });
    boss = await founderSession(P);
    owner = await signup(P, 'owner@prospects.test');
    home = P.mock; // India, with a public email and phone
    us = await startMock({ extra: 'meta-us,contact-personal' });
    eu = await startMock({ extra: 'meta-eu' });
    blockedStore = await startMock({ extra: 'robots-block' });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); us?.stop(); eu?.stop(); blockedStore?.stop(); await P?.stop(); });

  const imp = (body, s = boss, q = '') => s.req('POST', `/api/admin/prospects/import${q}`, body, { 'content-type': 'text/plain' });
  const row = (d) => P.db().prepare('SELECT * FROM prospects WHERE domain = ?').get(d);
  const count = () => P.db().prepare('SELECT COUNT(*) AS n FROM prospects').get().n;

  it('founders only: signed-out visitors and customers are refused on every route', async (t) => {
    const routes = [['GET', '/api/admin/prospects'], ['GET', '/api/admin/prospects.csv'], ['GET', '/api/admin/prospects.json'], ['POST', '/api/admin/prospects/import', 'a.com'],
      ['POST', '/api/admin/prospects/do-not-contact', 'a.com'], ['PATCH', '/api/admin/prospects/a.com', { status: 'drafted' }], ['POST', '/api/admin/prospects/run', {}]];
    const out = P.session();
    for (const [m, u, b] of routes) {
      const hdr = typeof b === 'string' ? { 'content-type': 'text/plain' } : {};
      assert.equal((await out.req(m, u, b, hdr)).status, 401, `signed out: ${m} ${u}`);
      assert.equal((await owner.req(m, u, b, hdr)).status, 403, `customer: ${m} ${u}`);
    }
    assert.equal(count(), 0, 'nothing was added by anyone refused');
    // The token is for reading only, and only the right one works.
    assert.equal((await out.get('/api/admin/prospects.json', { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await out.get('/api/admin/prospects.json', { authorization: `Bearer ${TOKEN}` })).status, 200);
    assert.equal((await out.req('POST', '/api/admin/prospects/import', 'a.com', { 'content-type': 'text/plain', authorization: `Bearer ${TOKEN}` })).status, 401, 'the token cannot import');
    note(t, `${routes.length} routes: signed out 401, customer 403; the outreach token reads the JSON list only`);
  });

  it('import keeps every store once: forms of one address, re-import, blank and bad entries', async (t) => {
    const first = (await imp('Shop.Example.com\nhttps://www.shop.example.com/products/x\nshop.example.com.\nother-store.in\nnot an address\n', boss, '?source=test')).json;
    assert.equal(first.added, 2);
    assert.equal(first.already, 2, 'the same store written two more ways');
    assert.equal(first.message, '2 new, 2 already there');
    const again = (await imp('other-store.in\nSHOP.example.com\nthird.example.co.uk')).json;
    assert.deepEqual([again.added, again.already], [1, 2]);
    assert.equal((await imp('domain,visits\nthird.example.co.uk,5\nfourth.example.com,9\n')).json.added, 1, 'a CSV with a header column');
    assert.equal(count(), 4);
    assert.equal(row('shop.example.com').source, 'test');
    assert.equal((await imp('  \n')).status, 400);
    const a = P.db().prepare("SELECT detail_json FROM audit WHERE action = 'prospects.import' ORDER BY id").all();
    assert.equal(a.length, 3, 'every import is in the audit log');
    note(t, `first import "${first.message}", re-import adds only the new one; ${count()} stores, each once`);
  });

  it('a store that opted out or must not be contacted is never added or contacted again', async (t) => {
    await imp('gone.example.com\nstays.example.com');
    assert.equal((await boss.patch('/api/admin/prospects/gone.example.com', { status: 'opted_out' })).status, 200);
    const re = (await imp('https://www.gone.example.com/')).json;
    assert.equal(re.added, 0);
    assert.equal(row('gone.example.com').status, 'opted_out', 'still opted out after a re-import');
    // Back to "new" is refused.
    const back = await boss.patch('/api/admin/prospects/gone.example.com', { status: 'new' });
    assert.equal(back.status, 400);
    assert.match(back.json.error, /asked not to be contacted/);
    // A domain on the do-not-contact list is never added, even before it is in the list.
    assert.equal((await boss.req('POST', '/api/admin/prospects/do-not-contact', 'never.example.org\nstays.example.com', { 'content-type': 'text/plain' })).json.blocked, 2);
    const r = (await imp('never.example.org\nfresh.example.org')).json;
    assert.deepEqual([r.added, r.blocked], [1, 1]);
    assert.equal(row('never.example.org'), undefined);
    assert.equal(row('stays.example.com').status, 'do_not_contact');
    // The reader skips them.
    assert.equal(P.db().prepare("SELECT COUNT(*) AS n FROM prospects WHERE status IN ('opted_out','do_not_contact') AND state = 'queued'").get().n, 2);
    assert.equal((await boss.patch('/api/admin/prospects/nobody.example.com', { status: 'drafted' })).status, 404);
    assert.equal((await boss.patch('/api/admin/prospects/stays.example.com', { status: 'nonsense' })).status, 400);
    note(t, 'opted-out domain stays out after re-import and cannot be moved back; do-not-contact list works before the domain is listed');
  });

  it('reads a store: public details, its own email and phone, a light check, the top finding', async (t) => {
    const d = domainOf(home);
    // Only this store is waiting, so it is the one read.
    for (const x of P.db().prepare("SELECT domain FROM prospects WHERE state = 'queued'").all()) await boss.req('POST', '/api/admin/prospects/do-not-contact', x.domain, { 'content-type': 'text/plain' });
    await imp(d);
    const mark = (await reqs(home)).length;
    const r = (await boss.post('/api/admin/prospects/run', { max: 1 })).json;
    assert.deepEqual([r.ran, r.stopped], [1, 'empty']);
    const s = row(d);
    assert.equal(s.state, 'done', s.note);
    assert.equal(s.shopify, 1);
    assert.equal(s.store_name, 'Kaveri Handlooms');
    assert.equal(s.country, 'IN');
    assert.equal(s.city, 'Jaipur');
    assert.equal(s.currency, 'INR');
    assert.equal(s.products, 42);
    assert.equal(s.myshopify, 'mock.myshopify.com');
    assert.equal(s.email, 'support@kaveri.example');
    assert.equal(s.phone, '+919876543210');
    assert.equal(s.finding, '1 product is for sale at a price of zero');
    assert.equal(s.score, 60);
    assert.equal(s.icp, 100);
    assert.equal(s.status, 'new');
    // Polite: robots.txt read once, every page once, TharamStoreGuard for the details, a second apart.
    const seen = (await reqs(home)).slice(mark).filter((x) => !/^\/(img\/|favicon|assets\/|apps\/|lib\/)/.test(x.path));
    const paths = seen.map((x) => `${x.method} ${x.path}`);
    assert.equal(paths.filter((p) => p === 'GET /robots.txt').length, 1, 'robots.txt once');
    for (const p of paths.filter((p) => p !== 'POST /cart/add')) assert.equal(paths.filter((q) => q === p).length, 1, `${p} once`);
    const mine = seen.filter((x) => ['/robots.txt', '/meta.json', '/policies/contact-information'].includes(x.path));
    assert.deepEqual(mine.map((x) => x.path), ['/robots.txt', '/meta.json', '/policies/contact-information']);
    for (const x of mine) assert.match(x.ua, /TharamStoreGuard/);
    for (let i = 1; i < mine.length; i++) assert.ok(mine[i].at - mine[i - 1].at >= 950, `a second between requests (${mine[i].at - mine[i - 1].at} ms)`);
    note(t, `${d}: Jaipur, IN, 42 products, support@kaveri.example, +919876543210; "${s.finding}", risk ${s.score}, fit ${s.icp}; robots.txt once, one second between requests`);
  });

  it('never guesses or takes a personal address; another country and the EU are handled', async (t) => {
    const u = domainOf(us), e = domainOf(eu), b = domainOf(blockedStore);
    await imp([u, e, b].join('\n'));
    const emark = (await reqs(eu)).length, bmark = (await reqs(blockedStore)).length;
    assert.equal((await boss.post('/api/admin/prospects/run', { max: 3 })).json.ran, 3);
    const us1 = row(u), eu1 = row(e), bl = row(b);
    assert.equal(us1.state, 'done', us1.note);
    assert.equal(us1.country, 'US');
    assert.equal(us1.email, '', 'only a personal gmail address was published: not taken');
    assert.equal(us1.icp, 25 + 40 + 15, 'US scores below India and has no email bonus');
    // EU: left out after the public details, no page is visited and no check runs.
    assert.equal(eu1.state, 'skipped');
    assert.equal(eu1.country, 'DE');
    assert.match(eu1.note, /EU/);
    assert.deepEqual((await reqs(eu)).slice(emark).map((x) => x.path), ['/robots.txt', '/meta.json']);
    // A store that asks bots to stay away is left alone.
    assert.equal(bl.state, 'skipped');
    assert.deepEqual((await reqs(blockedStore)).slice(bmark).map((x) => x.path), ['/robots.txt']);
    note(t, 'US store: country and score right, personal gmail not taken; EU store left out after robots.txt and meta.json only; robots-blocked store: only robots.txt read');
  });

  it('a daily cap keeps customer checks first', async (t) => {
    const cap = await startProduct({ env: { PROSPECT_CHECKS_PER_DAY: '2' } });
    const m1 = cap.mock, m2 = await startMock({ extra: 'meta-eu' });
    try {
      const f = await founderSession(cap);
      const doms = [`localhost:${m1.port}`, `127.0.0.1:${m1.port}`, `localhost:${m2.port}`];
      assert.equal((await f.req('POST', '/api/admin/prospects/import', doms.join('\n'), { 'content-type': 'text/plain' })).json.added, 3);
      const first = (await f.post('/api/admin/prospects/run', { max: 5 })).json;
      assert.deepEqual([first.ran, first.stopped], [2, 'cap']);
      assert.equal(first.summary.checkedToday, 2);
      const again = (await f.post('/api/admin/prospects/run', { max: 5 })).json;
      assert.deepEqual([again.ran, again.stopped], [0, 'cap']);
      assert.equal(cap.db().prepare("SELECT COUNT(*) AS n FROM prospects WHERE state = 'queued'").get().n, 1, 'the third waits for tomorrow');
      note(t, 'cap 2 a day: two read, the third stays queued, a second try reads nothing');
    } finally { m2.stop(); await cap.stop(); }
  });

  it('filters, status and export: country, products, email, finding, status; CSV and the outreach JSON', async (t) => {
    const all = (await boss.get('/api/admin/prospects?limit=500')).json;
    assert.ok(all.total >= 6);
    const ids = (q) => boss.get(`/api/admin/prospects?${q}`).then((r) => r.json.rows.map((x) => x.domain));
    const d = domainOf(home);
    assert.deepEqual(await ids('country=IN&has_email=1'), [d]);
    assert.deepEqual(await ids('country=us'), [domainOf(us)]);
    assert.deepEqual((await ids('min_products=40&finding=any')).sort(), [d, domainOf(us)].sort());
    assert.deepEqual(await ids('min_products=43'), [], 'no store has that many products');
    assert.deepEqual(await ids('finding=none'), [], 'every checked mock store has the zero-price product; left-out stores are not counted as clean');
    assert.ok((await ids('q=kaveri')).includes(d), 'search finds a store by its name');
    assert.equal((await boss.patch(`/api/admin/prospects/${encodeURIComponent(d)}`, { status: 'drafted' })).status, 200);
    assert.deepEqual(await ids('status=drafted'), [d]);
    assert.equal(all.summary.dailyCap, 5);
    const csv = await boss.get('/api/admin/prospects.csv?country=IN');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="tharam-prospects-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = csv.text.trim().split('\n');
    assert.match(lines[0], /^domain,status,country,city,store_name,products,email,phone,icp,score,finding/);
    assert.equal(lines.length, 2, 'only the filtered store');
    assert.match(lines[1], /support@kaveri\.example/);
    const j = (await P.session().get('/api/admin/prospects.json?has_email=1&status=drafted', { authorization: `Bearer ${TOKEN}` })).json;
    assert.equal(j.count, 1);
    assert.equal(j.prospects[0].email, 'support@kaveri.example');
    assert.equal(j.prospects[0].finding, '1 product is for sale at a price of zero');
    note(t, 'filters by country, products, email, finding, status and search; CSV holds only the filtered rows; the token JSON returns the same list');
  });

  it('the Prospects screen: add stores, see what was found, change a status', async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies(boss.browserCookies());
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/app#/admin/prospects`);
    await p.waitForSelector('#ptable', { timeout: 20000 });
    await p.evaluate(() => document.querySelectorAll('.tour,.tour-mask,.toast').forEach((x) => x.remove()));
    assert.ok(await p.locator('nav.tabs a', { hasText: 'Prospects' }).count(), 'the tab is there');
    await p.fill('#ptext', `brand-new.example.com\n${domainOf(home)}`);
    await p.click('#pimport button[type=submit]');
    await p.waitForSelector('.toast');
    assert.match(await p.locator('.toast').first().innerText(), /1 new, 1 already there/);
    await p.waitForSelector('#ptable');
    await p.selectOption(`select.pstatus[data-domain="${domainOf(home)}"]`, 'contacted');
    await p.waitForTimeout(600);
    assert.equal(row(domainOf(home)).status, 'contacted');
    await p.evaluate(() => document.querySelectorAll('.toast').forEach((x) => x.remove()));
    assert.ok((await p.locator('#ptable').innerText()).includes('1 product is for sale at a price of zero'));
    await screenshot(t, p, 'Prospects list', { fullPage: true });
    assert.deepEqual(errors, []);
    note(t, 'tab visible; pasted list adds "1 new, 1 already there"; status change saved; list shows the finding in plain words');
    await ctx.close();
  });
});
