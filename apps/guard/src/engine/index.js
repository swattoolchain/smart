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
import { runVariantSweep } from './variants.js';
import { runTraffic } from './traffic.js';
import { runPriceRules } from './pricing.js';
import { reviewScreens } from './visual-ai.js';
import { watchScripts, scriptChecks, pageKind } from './scripts.js';
import { watchCost, watchWidgets, missingWidgets, widgetCheck } from './apps.js';
import { watchHijack, hijackChecks } from './hijack.js';
import { watchForms, formChecks } from './forms.js';
import { runShopper } from './agent.js';
import { runSpam } from './spam.js';
import { runDomain } from './domain.js';
import { aiEnabled } from '../ai.js';
import { VIDEO_FILE, VIDEO_DAYS } from '../video.js';

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
export async function runScan({ runId, origin, kind = 'full', password, storeId, disabled = [], testProduct = null, discountCodes = [], shopifyCodes = null, priceRules = [], signal, progress, preview = null, captureOnly = false, previousScripts = null, extraChecks = [], video = false, traffic = null, release = false, woo = true }) {
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
  // Video replay: the shopping journey runs in its own recorded browser window; the video is kept only if it failed.
  let vctx = null;
  let vpage = null;
  let videoTmp = null;
  if (video && storeId && !preview) {
    try {
      videoTmp = fs.mkdtempSync(path.join(config.dataDir, 'video-tmp-'));
      vctx = await newContext({ recordVideo: { dir: videoTmp, size: { width: 1024, height: 674 } } });
      vctx.setDefaultTimeout(20000);
      vpage = await unlessStopped(vctx.newPage());
    } catch (e) {
      // Recording is a bonus: if it can't start (no video encoder), the checks run as usual.
      console.error('video recording unavailable:', shortErr(e));
      await vctx?.close().catch(() => {});
      vctx = null; vpage = null;
    }
  }
  const onAbortVideo = () => { vctx?.close().catch(() => {}); };
  if (signal && vctx) signal.addEventListener('abort', onAbortVideo);
  let info;
  let theme = null;
  let videoOut = null;
  try {
    // Hijack watch records from the first page visit (redirects can happen on any of them).
    const hijack = on('security.hijack') ? await watchHijack({ contexts: [{ ctx, device: 'desktop' }, { ctx: mctx, device: 'phone' }, ...(vctx ? [{ ctx: vctx, device: 'desktop' }] : [])], origin, shot }) : null;
    // Unlock password-protected storefronts first so discovery shares the unlocked session.
    if (password) {
      await gotoStore(page, origin + '/', { password }).catch(() => {});
      await gotoStore(mobilePage, origin + '/', { password }).catch(() => {});
      if (vpage) await gotoStore(vpage, origin + '/', { password }).catch(() => {});
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
    // WooCommerce shopping tests can be switched off (founder console); the store is then treated like any other platform.
    if (!woo) info.isWoo = false;
    const lockedEarly = /\/password/.test(page.url());
    if (!info.isShopify && !info.isWoo && !lockedEarly && !(await isLocked(ctx, origin))) {
      rec.add(
        check('fn.platform', 'functional', 'Full shopping journey test', 'skip', {
          severity: 'minor',
          detail: info.platform.key === 'woocommerce'
            ? 'This WooCommerce store does not answer on the WooCommerce Store API (it may be turned off or blocked by a security plugin), so add-to-cart and checkout could not be tested. Uptime, speed, SEO, accessibility, links and script errors were fully tested.'
            : `Detected platform: ${info.platform.label}. Automated add-to-cart and checkout tests run on Shopify and WooCommerce stores. Uptime, speed, SEO, accessibility, links and script errors were fully tested.`,
          fix: info.platform.key === 'woocommerce' ? 'Allow public access to /wp-json/wc/store/ in your security or firewall plugin (it is the same API your cart and checkout blocks use), then run the check again.' : '',
        })
      );
    }
    let metrics = {};
    let catalog = null;
    let variants = null;
    const catalogKeep = {};
    let trafficOut = null;
    let ai = null;
    let scripts = null;
    let shopper = null;
    phase('journey');
    // With video replay on, the journey runs in the recorded window; the script, form and widget watchers follow it.
    const jpage = vpage || page;
    const journeyStart = rec.checks.length;
    let journeyCover = null;
    const inventory = on('security.scripts') ? watchScripts(jpage, origin) : null;
    const forms = on('security.scripts') ? await watchForms(jpage, origin).catch((e) => { console.error('form watch failed', e.message); return null; }) : null;
    const widgets = inventory ? await watchWidgets(jpage).catch(() => null) : null;
    const fn = await runFunctional({ page: jpage, rec, origin, info, password, shot, on });
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
    // The recording ends after the watchers have read the journey page; kept only if a journey check failed.
    if (vpage) {
      theme = theme || (await themeOf(vpage));
      // Quick checks use no other browser window, so the report's cover comes from the journey window.
      if (kind === 'journeys') journeyCover = await shot(vpage, 'cover');
      videoOut = await keepVideo({ vctx, vpage, runDir, runId, failed: rec.checks.slice(journeyStart).filter((c) => c.status === 'fail' && c.category === 'functional') });
      vctx = null;
    }
    if (!fn.locked && !fn.down && !fn.blocked) {
      if (on('errors.js')) jsErrorCheck(rec, fn.pageErrors || []);
      if (on('pricing.journey') && priceRules.length && info.isShopify) await runPriceRules({ page, rec, origin, rules: priceRules });
      if (kind === 'full' && on('sale.discount') && discountCodes.length) await runDiscounts({ page, rec, origin, info, password, codes: discountCodes, shot });
      if (kind !== 'journeys') {
        phase('quality');
        // App Health: what each app's files cost on the phone while the speed check loads the pages.
        const cost = scripts && on('speed') ? watchCost(mobilePage) : null;
        metrics = (await runNonFunctional({ page, mobilePage, rec, origin, info, password, shot, linkLimit: kind === 'free' ? 30 : 60, on })).metrics;
        if (cost) scripts.phone = await cost();
        if (on('security.spam')) await runSpam({ page, rec, origin, info, password, shot });
      }
      // Opt-in only (Store settings), never on publish previews, at most every 6 hours (see traffic.js).
      if (kind === 'full' && storeId && traffic && !preview && on('sale.traffic')) {
        phase('traffic');
        trafficOut = await runTraffic({ rec, origin, info, password, shoppers: traffic.shoppers, lastAt: traffic.lastAt || null });
      }
      if (kind === 'full' && ['law.de', 'law.cookies', 'access.law', 'law.us'].some(on)) {
        phase('regional');
        await runRegional({ page, rec, origin, info, password, on, preview });
      }
      if (kind === 'full' && storeId && (on('visual') || on('security.deface'))) {
        phase('visual');
        // Defacement is judged against the approved look, so it rides on the visual screenshots.
        await runVisual({ page, mobilePage, rec, origin, info, password, runDir, baselineDir: path.join(config.dataDir, 'baselines', `store-${storeId}`), captureOnly, prime: preview ? (p) => openPreview(p, preview.url, { password }) : null, deface: on('security.deface') && !preview });
      }
      if (kind === 'full' && storeId && info.isShopify && (on('catalog') || on('security.tamper'))) {
        phase('catalog');
        const cat = await runCatalog({ request: ctx.request, origin, storeId, runId, rec, info, on, keep: catalogKeep, shopifyCodes });
        // The full catalog checks supersede the quick sample check; reporting both double-counts one mistake.
        if (cat?.count && on('catalog')) rec.checks = rec.checks.filter((c) => c.id !== 'nf.catalog');
        // Tampering alone (catalog checks off or not in the plan) reads the catalog but doesn't show it.
        catalog = on('catalog') ? cat : null;
      }
      if (kind === 'full' && storeId && info.isShopify && on('catalog.variants') && !preview) {
        phase('variants');
        // Big catalogs are covered over several checks: start where the previous check stopped.
        const posFile = path.join(config.dataDir, 'variants', `store-${storeId}.json`);
        let offset = 0;
        try { offset = Number(JSON.parse(fs.readFileSync(posFile, 'utf8')).next) || 0; } catch {}
        // Saved as the sweep goes, so a check stopped mid-sweep still moves on next time.
        const savePosition = (next) => {
          fs.mkdirSync(path.dirname(posFile), { recursive: true });
          fs.writeFileSync(posFile, JSON.stringify({ next, at: new Date().toISOString() }));
        };
        // Keep well inside the 6-minute limit for a whole check (queue.js), with time left for the rest.
        variants = await runVariantSweep({ request: ctx.request, origin, rec, products: catalogKeep.snap?.products || null, offset, signal, savePosition, deadline: started + 4.5 * 60 * 1000 });
        if (variants) savePosition(variants.next);
      }
      // Domain, certificate and records belong to the live store: not to a draft theme or a Safe to publish check.
      if (kind === 'full' && storeId && !preview && !release && on('security.domain')) {
        phase('domain');
        await runDomain({ rec, request: ctx.request, origin, storeId }).catch((e) => rec.add(check('sec.domain.dns', 'security', 'Domain and email records unchanged', 'skip', { severity: 'minor', detail: shortErr(e) })));
      }
      if (kind === 'full' && storeId && on('ai.visual') && aiEnabled()) {
        phase('ai');
        ai = await reviewScreens({ runDir, origin, rec });
      }
      // The AI shopper finds its own way, so it also tests themes the scripted journey doesn't know.
      // In Safe to publish it shops the draft theme too (its own window opens the preview first).
      if (kind === 'full' && storeId && on('ai.shopper') && aiEnabled() && info.isShopify) {
        phase('shopper');
        const shop = (r) => runShopper({ rec: r, origin, password, shot, prime: preview ? (p) => openPreview(p, preview.url, { password }) : null });
        shopper = await shop(rec);
        // Safe to publish: the AI is not deterministic, so a shopper that got stuck (or ran out of steps) gets one
        // more try before the publish check can treat it as a reason not to publish.
        if (captureOnly && shopper && (shopper.outcome === 'stuck' || shopper.outcome === 'limit')) {
          const rec2 = new Recorder();
          const again = await shop(rec2).catch(() => null);
          if (again?.outcome === 'checkout') {
            rec.checks = rec.checks.filter((c) => c.id !== 'ai.shopper').concat(rec2.checks.filter((c) => c.id === 'ai.shopper'));
            shopper = { ...again, tries: [shopper.outcome, again.outcome] };
          } else {
            shopper = { ...shopper, tries: [shopper.outcome, again?.outcome || 'error'] };
          }
        }
      }
    }
    // Checks made outside the browser (theme files through the Shopify API) count like any other.
    for (const c of extraChecks) rec.add(c);
    // A home screenshot gives every report a visual anchor.
    // Drop anything from a switched-off group (some sections share page visits).
    rec.checks = rec.checks.filter((c) => { const g = groupOf(c.id); return !g || on(g); });
    const cover = journeyCover && mobilePage.url() === 'about:blank' && page.url() === 'about:blank' ? journeyCover : await shot(mobilePage.url() === 'about:blank' ? page : mobilePage, 'cover');
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
      isWoo: !!info.isWoo,
      metrics,
      catalog,
      variants,
      video: videoOut,
      traffic: trafficOut,
      ai,
      scripts,
      shopper,
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
    if (signal) { signal.removeEventListener('abort', onAbort); signal.removeEventListener('abort', onAbortVideo); }
    await vctx?.close().catch(() => {});
    if (videoTmp) fs.rmSync(videoTmp, { recursive: true, force: true });
    await ctx.close().catch(() => {});
    await mctx.close().catch(() => {});
  }
}

/**
 * Ends the recording and keeps the video only when a journey check failed: it goes next to the run's screenshots
 * (owner-only, like them) and is linked from each failed journey check.
 */
async function keepVideo({ vctx, vpage, runDir, runId, failed }) {
  const v = vpage.video();
  try {
    await vpage.close();
    if (!failed.length || !v) return null;
    const dest = path.join(runDir, VIDEO_FILE);
    await v.saveAs(dest); // waits until the recording is written
    if (!fs.existsSync(dest) || !fs.statSync(dest).size) { fs.rmSync(dest, { force: true }); return null; }
    const url = `/shots/run-${runId}/${VIDEO_FILE}`;
    const until = new Date(Date.now() + VIDEO_DAYS * 86400e3).toISOString();
    for (const c of failed) c.evidence = { ...(c.evidence || {}), video: url, videoUntil: until };
    return { url, until, checks: failed.map((c) => c.id) };
  } catch (e) {
    console.error('video replay not saved:', shortErr(e));
    return null;
  } finally {
    await vctx.close().catch(() => {});
  }
}
