import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { newContext, gotoStore, openPreview, themeOf } from './browser.js';
import { discover } from './discover.js';
import { Recorder, check, shortErr } from './checks.js';
import { runFunctional } from './functional.js';
import { runNonFunctional, jsErrorCheck } from './nonfunctional.js';
import { runVisual } from './visual.js';
import { scoreChecks, summarize } from './score.js';
import { groupOf } from './catalog.js';
import { runCatalog } from './catalog-check.js';
import { runRegional } from './regional.js';
import { runDiscounts } from './discount.js';
import { reviewScreens } from './visual-ai.js';
import { watchScripts, scriptChecks, pageKind } from './scripts.js';
import { watchCost, watchWidgets, missingWidgets, widgetCheck } from './apps.js';
import { watchHijack, hijackChecks } from './hijack.js';
import { watchForms, formChecks } from './forms.js';
import { aiEnabled } from '../ai.js';

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
export async function runScan({ runId, origin, kind = 'full', password, storeId, disabled = [], testProduct = null, discountCodes = [], signal, progress, preview = null, captureOnly = false, previousScripts = null, extraChecks = [] }) {
  const on = (k) => !disabled.includes(k);
  const started = Date.now();
  const rec = new Recorder();
  const phase = (k) => { if (progress) progress.phase = k; };
  if (progress) progress.rec = rec;
  phase('open');
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
  // Stopping a run closes both browser contexts; any Playwright call in flight then rejects at once.
  const onAbort = () => { ctx.close().catch(() => {}); mctx.close().catch(() => {}); };
  // A run stopped while the browser was still starting must not open pages on contexts that are closing
  // (Playwright can wait forever there): stop at once instead.
  const stopped = signal ? new Promise((_, rej) => {
    if (signal.aborted) rej(new Error('cancelled'));
    else signal.addEventListener('abort', () => rej(new Error('cancelled')), { once: true });
  }) : null;
  stopped?.catch(() => {});
  const unlessStopped = (p) => (stopped ? Promise.race([p, stopped]) : p);
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort); }
  const page = await unlessStopped(ctx.newPage());
  const mobilePage = await unlessStopped(mctx.newPage());
  let info;
  let theme = null;
  try {
    // Hijack watch records from the first page visit (redirects can happen on any of them).
    const hijack = on('security.hijack') ? await watchHijack({ contexts: [{ ctx, device: 'desktop' }, { ctx: mctx, device: 'phone' }], origin, shot }) : null;
    // Unlock password-protected storefronts first so discovery shares the unlocked session.
    if (password) {
      await gotoStore(page, origin + '/', { password }).catch(() => {});
      await gotoStore(mobilePage, origin + '/', { password }).catch(() => {});
    }
    // Publish checks: open the draft theme in every context before anything else.
    if (preview) {
      const opened = await openPreview(page, preview.url, { password });
      await openPreview(mobilePage, preview.url, { password });
      theme = opened.theme;
      if (opened.origin !== origin) origin = opened.origin; // share-preview links can move to the .myshopify.com domain
      if (theme?.role === 'main') {
        rec.add(check('fn.preview', 'functional', 'Draft theme opened', 'fail', { severity: 'critical', detail: `The link opened your live theme (“${theme.name}”), not a draft. In Shopify, open Online Store → Themes, choose the draft theme's ⋯ menu → Preview, then copy the Share preview link.`, fix: 'Use the Share preview link of the unpublished theme.' }));
        throw new Error('The preview link opened the live theme');
      }
      rec.add(check('fn.preview', 'functional', 'Draft theme opened', theme ? 'pass' : 'warn', { severity: 'minor', detail: theme ? `Testing “${theme.name}” (draft) in a preview session.` : 'We could not confirm which theme loaded. Results may reflect the live theme.' }));
    }
    info = await discover(ctx.request, origin, { testProduct });
    const lockedEarly = /\/password/.test(page.url());
    if (!info.isShopify && !lockedEarly && !(await isLocked(ctx, origin))) {
      rec.add(
        check('fn.platform', 'functional', 'Full shopping journey test', 'skip', {
          severity: 'minor',
          detail: `Detected platform: ${info.platform.label}. Automated add-to-cart and checkout tests currently run on Shopify stores; WooCommerce support is next. Uptime, speed, SEO, accessibility, links and script errors were fully tested.`,
        })
      );
    }
    let metrics = {};
    let catalog = null;
    let ai = null;
    let scripts = null;
    phase('journey');
    const inventory = on('security.scripts') ? watchScripts(page, origin) : null;
    const forms = on('security.scripts') ? await watchForms(page, origin).catch((e) => { console.error('form watch failed', e.message); return null; }) : null;
    const widgets = inventory ? await watchWidgets(page).catch(() => null) : null;
    const fn = await runFunctional({ page, rec, origin, info, password, shot, on });
    // Script watch compares with the store's previous check; publish-check runs only record.
    if (inventory && !fn.locked && !fn.blocked && !fn.down) {
      await inventory.settle();
      scripts = scriptChecks({ rec, inventory: inventory(), previous: previousScripts, monitored: !!storeId && !preview && !captureOnly });
      // App Health: app widgets that should show where the app loads.
      if (widgets && Object.keys(scripts.pages).length) {
        const seen = widgets();
        const w = missingWidgets(scripts, seen);
        scripts.widgets = { seen, checked: w.checked, missing: w.missing };
        widgetCheck(rec, w);
      }
      // App Health: which script each error came from.
      scripts.errors = (fn.pageErrors || []).slice(0, 30).map((e) => ({ page: pageKind(e.url) || 'other', message: e.message, source: e.source || null }));
    }
    if (hijack && !fn.locked && !fn.blocked && !fn.down) {
      await hijack.probe(mctx);
      hijackChecks({ rec, found: await hijack.result() });
    }
    // Scripts reading what shoppers type, on the product and cart pages (also on drafts: a skimmer in a draft theme matters).
    if (scripts && forms) scripts.forms = formChecks({ rec, found: forms() });
    if (!fn.locked && !fn.down && !fn.blocked) {
      if (on('errors.js')) jsErrorCheck(rec, fn.pageErrors || []);
      if (kind === 'full' && on('sale.discount') && discountCodes.length) await runDiscounts({ page, rec, origin, info, password, codes: discountCodes, shot });
      if (kind !== 'journeys') {
        phase('quality');
        // App Health: what each app's files cost on the phone while the speed check loads the pages.
        const cost = scripts && on('speed') ? watchCost(mobilePage) : null;
        metrics = (await runNonFunctional({ page, mobilePage, rec, origin, info, password, shot, linkLimit: kind === 'free' ? 30 : 60, on })).metrics;
        if (cost) scripts.phone = await cost();
      }
      if (kind === 'full' && ['law.de', 'law.cookies', 'access.law', 'law.us'].some(on)) {
        phase('regional');
        await runRegional({ page, rec, origin, info, password, on, preview });
      }
      if (kind === 'full' && storeId && on('visual')) {
        phase('visual');
        await runVisual({ page, mobilePage, rec, origin, info, password, runDir, baselineDir: path.join(config.dataDir, 'baselines', `store-${storeId}`), captureOnly, prime: preview ? (p) => openPreview(p, preview.url, { password }) : null });
      }
      if (kind === 'full' && storeId && info.isShopify && on('catalog')) {
        phase('catalog');
        catalog = await runCatalog({ request: ctx.request, origin, storeId, runId, rec, info, on });
        // The full catalog checks supersede the quick sample check; reporting both double-counts one mistake.
        if (catalog?.count) rec.checks = rec.checks.filter((c) => c.id !== 'nf.catalog');
      }
      if (kind === 'full' && storeId && on('ai.visual') && aiEnabled()) {
        phase('ai');
        ai = await reviewScreens({ runDir, origin, rec });
      }
    }
    // Checks made outside the browser (theme files through the Shopify API) count like any other.
    for (const c of extraChecks) rec.add(c);
    // A home screenshot gives every report a visual anchor.
    // Drop anything from a switched-off group (some sections share page visits).
    rec.checks = rec.checks.filter((c) => { const g = groupOf(c.id); return !g || on(g); });
    const cover = await shot(mobilePage.url() === 'about:blank' ? page : mobilePage, 'cover');
    const { score, verdict, categories } = scoreChecks(rec.checks);
    theme = theme || (await themeOf(page));
    return {
      origin,
      kind,
      theme,
      skippedGroups: disabled,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      isShopify: info.isShopify,
      metrics,
      catalog,
      ai,
      scripts,
      testedProduct: info.products[0] ? { title: info.products[0].title, handle: info.products[0].handle } : null,
      notes: info.notes,
      platform: info.platform,
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
    if (signal?.aborted) throw new Error('cancelled');
    rec.add(check('fn.engine', 'functional', 'Scan completed', 'skip', { detail: shortErr(e) }));
    const { score, verdict, categories } = scoreChecks(rec.checks);
    return { origin, kind, theme, error: shortErr(e), checks: rec.checks, steps: rec.steps, score, verdict, categories, summary: 'The scan could not finish.' };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    await ctx.close().catch(() => {});
    await mctx.close().catch(() => {});
  }
}
