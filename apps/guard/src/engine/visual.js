import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { check, shortErr } from './checks.js';
import { gotoStore, settle, newContext } from './browser.js';

/**
 * Visual regression: compares viewport screenshots against the store's approved baseline.
 * The first run becomes the baseline. Differences above the threshold are reported as warnings.
 */
export async function runVisual({ page, mobilePage, rec, origin, info, password, runDir, baselineDir, threshold = 0.12, captureOnly = false, prime = null }) {
  const tctx = await newContext({ tablet: true });
  const tabletPage = await tctx.newPage();
  if (prime) await prime(tabletPage).catch(() => {});
  const devices = [['desktop', page], ['tablet', tabletPage], ['mobile', mobilePage]];
  const shots = devices.map(([d, p]) => ({ key: `home-${d}`, p, url: origin + '/' }));
  if (info.products[0]) for (const [d, p] of devices) shots.push({ key: `product-${d}`, p, url: `${origin}/products/${info.products[0].handle}` });
  fs.mkdirSync(baselineDir, { recursive: true });
  const results = [];
  for (const s of shots) {
    try {
      await gotoStore(s.p, s.url, { password });
      await settle(s.p, 1500);
      // Freeze animations and carousels so diffs reflect real changes.
      await s.p.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' }).catch(() => {});
      const file = path.join(runDir, `${s.key}.png`);
      await s.p.screenshot({ path: file, fullPage: false });
      // Publish checks only capture: their screenshots are compared with the paired live run, never the baseline.
      if (captureOnly) { results.push({ key: s.key, status: 'captured' }); continue; }
      const base = path.join(baselineDir, `${s.key}.png`);
      if (!fs.existsSync(base)) {
        fs.copyFileSync(file, base);
        results.push({ key: s.key, status: 'baseline' });
        continue;
      }
      const a = PNG.sync.read(fs.readFileSync(base));
      const b = PNG.sync.read(fs.readFileSync(file));
      if (a.width !== b.width || a.height !== b.height) {
        results.push({ key: s.key, status: 'changed', ratio: 1 });
        continue;
      }
      const diff = new PNG({ width: a.width, height: a.height });
      const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.15 });
      const ratio = n / (a.width * a.height);
      if (ratio > threshold) fs.writeFileSync(path.join(runDir, `${s.key}-diff.png`), PNG.sync.write(diff));
      results.push({ key: s.key, status: ratio > threshold ? 'changed' : 'same', ratio: Math.round(ratio * 1000) / 10 });
    } catch (e) {
      results.push({ key: s.key, status: 'error', error: shortErr(e) });
    }
  }
  await tctx.close().catch(() => {});
  if (captureOnly) return results;
  const changed = results.filter((r) => r.status === 'changed');
  const isBaseline = results.every((r) => r.status === 'baseline' || r.status === 'error');
  rec.add(
    check('nf.visual', 'reliability', 'Pages look the same as the approved version', isBaseline ? 'pass' : changed.length ? 'warn' : 'pass', {
      severity: 'minor',
      detail: isBaseline
        ? 'Saved today\'s screenshots as the approved look. Future runs are compared against them.'
        : changed.length
          ? `Visible changes on: ${changed.map((c) => `${c.key} (${c.ratio}% of pixels)`).join(', ')}. If this was intended, approve the new look.`
          : 'No unexpected visual changes.',
      evidence: { visual: results },
      fix: changed.length ? 'Review the screenshots. If the change was not intended, check recent theme and app updates.' : '',
    })
  );
  return results;
}

export function approveBaseline(runDir, baselineDir) {
  fs.mkdirSync(baselineDir, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(runDir)) {
    if (/^(home|product)-(desktop|tablet|mobile)\.png$/.test(f)) {
      fs.copyFileSync(path.join(runDir, f), path.join(baselineDir, f));
      n++;
    }
  }
  return n;
}
