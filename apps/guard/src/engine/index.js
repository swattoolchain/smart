import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { newContext, gotoStore } from './browser.js';
import { discover } from './discover.js';
import { Recorder, check, shortErr } from './checks.js';
import { runFunctional } from './functional.js';
import { runNonFunctional, jsErrorCheck } from './nonfunctional.js';
import { runVisual } from './visual.js';
import { scoreChecks, summarize } from './score.js';

async function isLocked(ctx, origin) {
  try {
    const r = await ctx.request.get(origin + '/', { timeout: 15000, maxRedirects: 0 });
    return r.status() >= 300 && r.status() < 400 && /\/password/.test(r.headers().location || '');
  } catch {
    return false;
  }
}

/**
 * Runs a scan against a store.
 * kind: 'free' (public scan, everything except visual baselines)
 *       'journeys' (fast functional monitoring)
 *       'full' (everything including visual regression)
 */
export async function runScan({ runId, origin, kind = 'full', password, storeId }) {
  const started = Date.now();
  const rec = new Recorder();
  const runDir = path.join(config.dataDir, 'shots', `run-${runId}`);
  fs.mkdirSync(runDir, { recursive: true });
  let shotN = 0;
  const shot = async (page, name) => {
    const file = `${String(++shotN).padStart(2, '0')}-${name}.png`;
    await page.screenshot({ path: path.join(runDir, file), fullPage: false }).catch(() => {});
    return `/shots/run-${runId}/${file}`;
  };

  const ctx = await newContext();
  const mctx = await newContext({ mobile: true });
  ctx.setDefaultTimeout(20000);
  mctx.setDefaultTimeout(20000);
  const page = await ctx.newPage();
  const mobilePage = await mctx.newPage();
  let info;
  try {
    // Unlock password-protected storefronts first so discovery shares the unlocked session.
    if (password) {
      await gotoStore(page, origin + '/', { password }).catch(() => {});
      await gotoStore(mobilePage, origin + '/', { password }).catch(() => {});
    }
    info = await discover(ctx.request, origin);
    const lockedEarly = /\/password/.test(page.url());
    if (!info.isShopify && !lockedEarly && !(await isLocked(ctx, origin))) {
      rec.add(
        check('fn.shopify', 'functional', 'Shopify store detected', 'warn', {
          severity: 'major',
          detail: 'This does not look like a Shopify storefront (or its product feed is disabled). Store Guard is built for Shopify; results may be limited.',
        })
      );
    }
    const fn = await runFunctional({ page, rec, origin, info, password, shot });
    if (!fn.locked && !fn.down) {
      jsErrorCheck(rec, fn.pageErrors || []);
      if (kind !== 'journeys') {
        await runNonFunctional({ page, mobilePage, rec, origin, info, password, shot, linkLimit: kind === 'free' ? 30 : 60 });
      }
      if (kind === 'full' && storeId) {
        await runVisual({ page, mobilePage, rec, origin, info, password, runDir, baselineDir: path.join(config.dataDir, 'baselines', `store-${storeId}`) });
      }
    }
    // A home screenshot gives every report a visual anchor.
    const cover = await shot(mobilePage.url() === 'about:blank' ? page : mobilePage, 'cover');
    const { score, verdict, categories } = scoreChecks(rec.checks);
    return {
      origin,
      kind,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      isShopify: info.isShopify,
      discovered: { products: info.products.map((p) => ({ title: p.title, handle: p.handle })), collections: info.collections, sampleSize: info.sampleSize },
      checks: rec.checks,
      steps: rec.steps,
      score,
      verdict,
      categories,
      summary: summarize(rec.checks, verdict),
      cover,
    };
  } catch (e) {
    rec.add(check('fn.engine', 'functional', 'Scan completed', 'skip', { detail: shortErr(e) }));
    const { score, verdict, categories } = scoreChecks(rec.checks);
    return { origin, kind, error: shortErr(e), checks: rec.checks, steps: rec.steps, score, verdict, categories, summary: 'The scan could not finish.' };
  } finally {
    await ctx.close().catch(() => {});
    await mctx.close().catch(() => {});
  }
}
