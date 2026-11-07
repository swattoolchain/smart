// Agency branding (T70): an agency name and logo on the printable report and sale-readiness email,
// set by the account owner only, with the logo checked on upload.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { startProduct, signup, addStore, runAndWait, shopifyOpen } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

/** A real, tiny PNG of the given size (solid colour). */
function png(w, h, rgb = [20, 83, 45]) {
  const crc = (buf) => { let c, x = ~0; for (const b of buf) { c = (x ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; x = (x >>> 8) ^ c; } return ~x >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#14532d"/></svg>';

describe('Agency branding on reports', { concurrency: 1 }, () => {
  let P, owner, other, storeId, run, browser;
  const cookie = (s) => [...s.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const upload = (s, body, type) => fetch(P.base + '/api/branding/logo', { method: 'PUT', headers: { cookie: cookie(s), 'content-type': type }, body }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const report = async (s, id, rid) => (await fetch(`${P.base}/api/stores/${id}/runs/${rid}/report.html`, { headers: { cookie: cookie(s) } })).text();

  before(async () => {
    P = await startProduct();
    owner = await signup(P, 'agency@brand.test');
    other = await signup(P, 'other@brand.test');
    storeId = await addStore(P, owner, { runNow: false, name: 'Client Store' });
    run = await runAndWait(owner, storeId, { kind: 'journeys' });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('without branding the report keeps the Tharam header', async (t) => {
    const html = await report(owner, storeId, run.id);
    assert.match(html, /<b>THARAM<\/b>/);
    assert.ok(!html.includes('prepared by'));
    note(t, 'no name or logo set: Tharam header and the usual footer');
  });

  it('the owner saves an agency name; control characters and tags are cleaned', async (t) => {
    const r = await owner.req('PUT', '/api/branding', { name: '  Blue <b>Fox</b>\n Studio  ' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.name, 'Blue bFox/b Studio');
    assert.equal((await owner.req('PUT', '/api/branding', { name: 'x'.repeat(200) })).json.name.length, 60);
    await owner.req('PUT', '/api/branding', { name: 'Blue Fox Studio' });
    assert.equal((await owner.get('/api/branding')).json.name, 'Blue Fox Studio');
    note(t, 'name trimmed, tags and control characters removed, cut at 60 characters');
  });

  it('logo checks: PNG and SVG accepted; wrong type, fake PNG, huge, scripted or linked SVG refused', async (t) => {
    const refused = [];
    const bad = [
      ['not an image', Buffer.from('hello'), 'image/png'],
      ['text sent as png', Buffer.from('GIF89a....'.repeat(10)), 'image/png'],
      ['too many pixels', png(2001, 2), 'image/png'],
      ['too big', Buffer.concat([png(10, 10), Buffer.alloc(120 * 1024)]), 'image/png'],
      ['svg with script', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml'],
      ['svg with handler', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>'), 'image/svg+xml'],
      ['svg with outside picture', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/a.png"/></svg>'), 'image/svg+xml'],
      ['svg with outside link', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.test/x)"/></svg>'), 'image/svg+xml'],
      ['svg with entity', Buffer.from('<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml'],
      ['html as svg', Buffer.from('<html><body>hi</body></html>'), 'image/svg+xml'],
    ];
    for (const [label, body, type] of bad) {
      const r = await upload(owner, body, type);
      if (r.status !== 400 || !r.json?.error) refused.push(`${label} → ${r.status}`);
    }
    assert.deepEqual(refused, [], 'every bad logo is refused with a plain message');
    assert.equal((await upload(owner, Buffer.from('x'), 'image/jpeg')).status, 400, 'JPEG is not accepted');
    assert.equal((await owner.get('/api/branding')).json.hasLogo, false, 'nothing was saved');
    assert.equal((await upload(owner, png(120, 40), 'image/png')).status, 200, 'a PNG is accepted');
    assert.equal((await upload(owner, Buffer.from(SVG), 'image/svg+xml')).status, 200, 'a plain SVG is accepted');
    note(t, `${bad.length} bad logos refused (not an image, fake PNG, too many pixels, too big, SVG with script / handler / outside picture / outside link / entity, HTML as SVG, JPEG); PNG and plain SVG accepted`);
  });

  it('the printable report shows the agency name and logo, with "Checked by Tharam" kept in the footer', async (t) => {
    await upload(owner, png(120, 40), 'image/png');
    const html = await report(owner, storeId, run.id);
    assert.match(html, /<div class="brand agency">/);
    assert.match(html, /<b>Blue Fox Studio<\/b>/);
    assert.match(html, /<img class="logo" src="data:image\/png;base64,/);
    assert.ok(!html.includes('<b>THARAM</b>'), 'Tharam header replaced');
    assert.match(html, /prepared by Blue Fox Studio · checked by Tharam/);
    const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
    await page.setContent(html);
    assert.equal(await page.locator('img.logo').evaluate((i) => i.naturalWidth), 120, 'the logo really loads');
    await screenshot(t, page, 'Report with the agency name and logo');
    const pdf = await fetch(`${P.base}/api/stores/${storeId}/runs/${run.id}/report.pdf`, { headers: { cookie: cookie(owner) } });
    if (pdf.status === 200) assert.equal((await pdf.arrayBuffer()).byteLength > 1000, true, 'PDF made with the branding');
    note(t, `HTML report carries the agency name and logo and keeps the Tharam footer line; PDF answered ${pdf.status}`);
  });

  it('an SVG logo is shown only as an image, so it cannot run anything', async (t) => {
    await upload(owner, Buffer.from(SVG), 'image/svg+xml');
    const html = await report(owner, storeId, run.id);
    assert.match(html, /<img class="logo" src="data:image\/svg\+xml;base64,/);
    assert.ok(!html.includes('<svg'), 'never inlined into the page');
    note(t, 'SVG logo embedded as a data: image, never as inline markup');
  });

  it('another account never sees this branding, and has none of its own', async (t) => {
    const s2 = await addStore(P, other, { runNow: false, name: 'Other Store' });
    const r2 = await runAndWait(other, s2, { kind: 'journeys' });
    const html = await report(other, s2, r2.id);
    assert.match(html, /<b>THARAM<\/b>/);
    assert.ok(!html.includes('Blue Fox'));
    assert.equal((await other.get('/api/branding')).json.name, '');
    assert.equal((await other.get('/api/branding')).json.hasLogo, false);
    // The agency's report cannot be opened by the other account.
    const cross = await fetch(`${P.base}/api/stores/${storeId}/runs/${run.id}/report.html`, { headers: { cookie: cookie(other) } });
    assert.ok([403, 404].includes(cross.status));
    assert.equal((await P.session().get('/api/branding')).status, 401, 'not logged in');
    note(t, 'second account: Tharam header, empty branding; cannot open the first account\'s report; visitor gets 401');
  });

  it('team members see branded reports but cannot change the branding; Shopify accounts cannot set it', async (t) => {
    const invite = await owner.post('/api/team/invites', { email: 'staff@brand.test', role: 'admin' });
    assert.equal(invite.status, 200, invite.text);
    const token = P.log().split('[mail skipped] to=').filter((x) => x.startsWith('staff@brand.test ')).at(-1).match(/#\/join\/([\w-]+)/)[1];
    const staff = await signup(P, 'staff@brand.test');
    assert.equal((await staff.post('/api/team/join', { token })).status, 200);
    assert.match(await report(staff, storeId, run.id), /Blue Fox Studio/, 'a member hands over the agency report');
    assert.equal((await staff.req('PUT', '/api/branding', { name: 'Hijack' })).status, 403);
    assert.equal((await upload(staff, png(10, 10), 'image/png')).status, 403);
    assert.equal((await staff.get('/api/branding')).status, 403);
    assert.equal((await owner.get('/api/branding')).json.name, 'Blue Fox Studio', 'unchanged');
    const shop = await shopifyOpen(P);
    assert.equal((await shop.req('PUT', '/api/branding', { name: 'Shop' })).status, 403, 'Shopify accounts: no branding');
    note(t, 'admin member: report is branded, every branding call refused (403); Shopify account refused (403)');
  });

  it('the settings screen: name, logo upload, remove', async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addCookies(owner.browserCookies());
    const page = await ctx.newPage();
    await page.goto(`${P.base}/app#/account/branding`);
    await page.getByText('Agency name').first().waitFor();
    await screenshot(t, page, 'Account > Branding with the saved logo');
    await page.locator('#bn').fill('Blue Fox Studio Ltd');
    await page.getByRole('button', { name: 'Save name' }).click();
    await page.getByText('Agency name saved').waitFor();
    await page.getByRole('button', { name: 'Remove logo' }).click();
    await page.getByText('Logo removed').waitFor();
    await page.getByText('No logo yet.').waitFor();
    assert.equal((await owner.get('/api/branding')).json.hasLogo, false);
    assert.equal((await owner.get('/api/branding')).json.name, 'Blue Fox Studio Ltd');
    await screenshot(t, page, 'Branding after removing the logo');
    note(t, 'name saved and logo removed from the screen; both stuck on the server');
  });

  it('the sale-readiness email carries the agency name and the "Checked by Tharam" line', async (t) => {
    process.env.DATA_DIR = P.dataDir;
    process.env.FEATURES_DEFAULT = 'on';
    const { saleEmail } = await import('../src/sale-readiness.js');
    const r = { store: { name: 'Client Store', url: 'https://c.test' }, verdict: 'ready', counts: { blockers: 0 }, headline: 'Ready', checkedAt: new Date().toISOString(), sections: [], reportUrl: 'https://x/r', pageUrl: 'https://x/p' };
    const plain = saleEmail(r);
    const branded = saleEmail(r, 'Blue Fox Studio');
    assert.ok(!plain.text.includes('Checked by Tharam') && plain.text.includes('— Tharam'));
    assert.match(branded.text, /— Blue Fox Studio\nChecked by Tharam/);
    assert.match(branded.html, /Blue Fox Studio<\/b> · Sale readiness/);
    assert.match(saleEmail(r, '<img src=x onerror=1>').html, /&lt;img/, 'the name is escaped');
    note(t, 'plain email unchanged; branded email names the agency, keeps "Checked by Tharam", and escapes the name');
  });
});
