// WordPress plugin: the zip served from our site, and the WooCommerce page that explains the install.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProduct } from './lib/harness.js';
import { note, screenshot } from './lib/evidence.js';

/** Reads a zip with no helper libraries: returns { name: Buffer } and checks every CRC. */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'zip end record found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const dataStart = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(zlib.crc32 ? zlib.crc32(data) : crc, crc, `${name} checksum`);
    out[name] = data;
    p += 46 + nlen + elen + clen;
  }
  return out;
}

describe('WordPress plugin and download page', () => {
  let P, zipRes, files, browser;
  before(async () => {
    P = await startProduct();
    zipRes = await fetch(`${P.base}/downloads/tharam-store-guard.zip`);
    files = readZip(Buffer.from(await zipRes.arrayBuffer()));
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await P.stop(); });

  it('the download is a zip with the plugin folder inside', (t) => {
    assert.equal(zipRes.status, 200);
    assert.equal(zipRes.headers.get('content-type'), 'application/zip');
    assert.match(zipRes.headers.get('content-disposition'), /attachment; filename="tharam-store-guard\.zip"/);
    assert.deepEqual(Object.keys(files).sort(), ['tharam-store-guard/readme.txt', 'tharam-store-guard/tharam-store-guard.php']);
    note(t, `served zip holds: ${Object.keys(files).join(', ')}; every file passes its checksum`);
  });

  it('the main file has a valid WordPress plugin header', () => {
    const php = files['tharam-store-guard/tharam-store-guard.php'].toString();
    assert.match(php, /^<\?php\s+\/\*\*/);
    for (const key of ['Plugin Name', 'Description', 'Version', 'Requires at least', 'Requires PHP', 'License', 'Text Domain']) {
      assert.match(php, new RegExp(`^\\s*\\*\\s*${key}:\\s*\\S+`, 'm'), key);
    }
    assert.match(php, /Plugin Name:\s+Tharam Store Guard/);
    assert.match(php, /defined\( 'ABSPATH' \)/, 'refuses to run outside WordPress');
    assert.match(files['tharam-store-guard/readme.txt'].toString(), /^=== Tharam Store Guard ===/);
    const v = /Version:\s*(\S+)/.exec(php)[1];
    assert.match(files['tharam-store-guard/readme.txt'].toString(), new RegExp(`Stable tag: ${v.replace(/\./g, '\\.')}`), 'readme and plugin agree on the version');
  });

  it('the plugin contains no secrets and makes no outside calls', () => {
    const all = Object.values(files).map((b) => b.toString()).join('\n');
    assert.doesNotMatch(all, /(api[_-]?key|secret|token|password)\s*[=:]\s*['"][^'"]{6,}/i);
    assert.doesNotMatch(all, /wp_remote_(get|post|request)|curl_|file_get_contents\(\s*['"]http/i, 'it never calls out');
    assert.doesNotMatch(all, /\b(eval|base64_decode|shell_exec|system|exec)\s*\(/, 'no risky functions');
    assert.match(all, /TharamStoreGuard/);
    assert.match(all, /wc\/store/);
  });

  it('the PHP is valid (when PHP is installed)', (t) => {
    const probe = spawnSync('php', ['-v']);
    if (probe.error || probe.status !== 0) return t.skip('php is not installed here');
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tharam-php-')), 'plugin.php');
    fs.writeFileSync(f, files['tharam-store-guard/tharam-store-guard.php']);
    const r = spawnSync('php', ['-l', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    note(t, r.stdout.trim().replace(f, 'tharam-store-guard.php'));
  });

  it('the same zip bytes every time', async () => {
    const again = Buffer.from(await (await fetch(`${P.base}/downloads/tharam-store-guard.zip`)).arrayBuffer());
    const first = Buffer.from(await (await fetch(`${P.base}/downloads/tharam-store-guard.zip`)).arrayBuffer());
    assert.ok(again.equals(first));
  });

  it('the WooCommerce page explains the install and links the download; other platforms do not show it', async (t) => {
    const woo = await (await fetch(`${P.base}/platforms/woocommerce`)).text();
    assert.match(woo, /href="\/downloads\/tharam-store-guard\.zip"/);
    assert.match(woo, /Install in three steps/);
    assert.match(woo, /TharamStoreGuard/);
    const shopifyPage = await (await fetch(`${P.base}/platforms/shopify`)).text();
    assert.doesNotMatch(shopifyPage, /tharam-store-guard\.zip/);
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const p = await ctx.newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${P.base}/platforms/woocommerce#plugin`);
    await p.locator('#plugin').scrollIntoViewIfNeeded();
    assert.ok(await p.locator('#plugin a.btn[download]').isVisible());
    await screenshot(t, p, 'WooCommerce page: plugin download and install steps');
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const m = await phone.newPage();
    await m.goto(`${P.base}/platforms/woocommerce#plugin`);
    await m.locator('#plugin').scrollIntoViewIfNeeded();
    assert.ok(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scrolling on a phone');
    await screenshot(t, m, 'Same section on a phone');
    assert.deepEqual(errors, []);
    await ctx.close(); await phone.close();
  });
});
