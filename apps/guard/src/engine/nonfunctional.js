import AxeBuilder from '@axe-core/playwright';
import { check, shortErr } from './checks.js';
import { gotoStore, settle } from './browser.js';

async function measure(page) {
  return page.evaluate(async () => {
    const out = {};
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) {
      out.ttfb = Math.round(nav.responseStart);
      out.dcl = Math.round(nav.domContentLoadedEventEnd);
      out.load = Math.round(nav.loadEventEnd || 0);
    }
    out.lcp = await new Promise((resolve) => {
      let v = 0;
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) v = Math.max(v, e.startTime);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {}
      setTimeout(() => resolve(Math.round(v)), 400);
    });
    out.cls = await new Promise((resolve) => {
      let v = 0;
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) if (!e.hadRecentInput) v += e.value;
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {}
      setTimeout(() => resolve(Math.round(v * 1000) / 1000), 300);
    });
    const res = performance.getEntriesByType('resource');
    out.requests = res.length + 1;
    out.bytes = res.reduce((s, r) => s + (r.transferSize || r.encodedBodySize || 0), nav ? nav.transferSize || 0 : 0);
    const host = location.hostname;
    const thirdParty = new Map();
    let mixed = 0;
    for (const r of res) {
      try {
        const u = new URL(r.name);
        if (location.protocol === 'https:' && u.protocol === 'http:') mixed++;
        if (u.hostname !== host && !u.hostname.endsWith('shopify.com') && !u.hostname.endsWith('shopifycdn.com')) {
          const prev = thirdParty.get(u.hostname) || { host: u.hostname, bytes: 0, count: 0, ms: 0 };
          prev.bytes += r.transferSize || 0;
          prev.count += 1;
          prev.ms += r.duration || 0;
          thirdParty.set(u.hostname, prev);
        }
      } catch {}
    }
    out.mixedContent = mixed;
    out.thirdParty = [...thirdParty.values()].sort((a, b) => b.ms - a.ms).slice(0, 8);
    return out;
  });
}

async function seoAudit(page) {
  return page.evaluate(() => {
    const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.getAttribute('content') || '';
    const imgs = [...document.images].filter((i) => i.width > 40 || i.naturalWidth > 40);
    return {
      title: document.title || '',
      description: meta('description'),
      robots: meta('robots'),
      canonical: document.querySelector('link[rel="canonical"]')?.href || '',
      h1: document.querySelectorAll('h1').length,
      ogImage: !!document.querySelector('meta[property="og:image"]'),
      imagesMissingAlt: imgs.filter((i) => !i.hasAttribute('alt')).length,
      imagesTotal: imgs.length,
      lang: document.documentElement.lang || '',
    };
  });
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
function fmtBytes(b) {
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
}

export async function runNonFunctional({ page, mobilePage, rec, origin, info, password, shot, linkLimit = 40 }) {
  const metrics = {};
  const targets = [{ key: 'home', label: 'Homepage', url: origin + '/' }];
  if (info.products[0]) targets.push({ key: 'product', label: 'Product page', url: `${origin}/products/${info.products[0].handle}` });

  // Speed, measured on a phone-sized viewport (most Shopify traffic is mobile).
  for (const t of targets) {
    try {
      await gotoStore(mobilePage, t.url, { password });
      await settle(mobilePage, 1500);
      const m = await measure(mobilePage);
      metrics[t.key] = m;
      const lcp = m.lcp || m.load || 0;
      let status = 'pass',
        severity = 'major';
      if (lcp > 4000) status = 'fail';
      else if (lcp > 2500) status = 'warn';
      const slowest = m.thirdParty?.[0];
      rec.add(
        check(`nf.speed.${t.key}`, 'performance', `${t.label} loads fast on mobile`, status, {
          severity,
          detail: `Largest content painted at ${fmtMs(lcp)}; ${m.requests} requests, ${fmtBytes(m.bytes)} transferred.${
            slowest && slowest.ms > 800 ? ` Slowest third-party: ${slowest.host} (${fmtMs(Math.round(slowest.ms))}).` : ''
          }`,
          fix:
            status === 'pass'
              ? ''
              : 'Compress large images, remove unused apps (each adds scripts), and lazy-load sections below the fold.',
        })
      );
      if (m.cls > 0.1) {
        rec.add(
          check(`nf.cls.${t.key}`, 'performance', `${t.label} layout stays stable`, m.cls > 0.25 ? 'fail' : 'warn', {
            severity: 'minor',
            detail: `Layout shift score ${m.cls} (good is under 0.1). Content jumps while loading, causing mis-taps.`,
            fix: 'Give images and app widgets fixed dimensions; avoid banners that push content down after load.',
          })
        );
      }
      if (m.bytes > 8 * 1048576) {
        rec.add(
          check(`nf.weight.${t.key}`, 'performance', `${t.label} page weight`, 'warn', {
            severity: 'minor',
            detail: `${t.label} transfers ${fmtBytes(m.bytes)}; heavy pages are slow on mobile data.`,
            fix: 'Serve smaller images (Shopify image URLs accept width parameters) and remove unused scripts.',
          })
        );
      }
      if (m.mixedContent > 0) {
        rec.add(
          check(`nf.mixed.${t.key}`, 'trust', `${t.label} loads only secure resources`, 'warn', {
            severity: 'minor',
            detail: `${m.mixedContent} resource(s) load over insecure http://, which browsers may block.`,
            fix: 'Update hard-coded http:// links in theme settings, custom code or app embeds to https://.',
          })
        );
      }
    } catch (e) {
      rec.add(check(`nf.speed.${t.key}`, 'performance', `${t.label} loads fast on mobile`, 'skip', { detail: shortErr(e) }));
    }
  }

  // SEO on the homepage and product page.
  for (const t of targets) {
    try {
      await gotoStore(page, t.url, { password });
      await settle(page, 600);
      const s = await seoAudit(page);
      metrics[`seo_${t.key}`] = s;
      const problems = [];
      if (!s.title) problems.push('missing page title');
      else if (s.title.length > 70) problems.push(`title is ${s.title.length} characters (keep under 70)`);
      if (!s.description) problems.push('missing meta description');
      if (s.h1 === 0) problems.push('no H1 heading');
      if (s.h1 > 1) problems.push(`${s.h1} H1 headings (use one)`);
      if (!s.canonical) problems.push('no canonical link');
      if (!s.ogImage) problems.push('no social share image');
      const noindex = /noindex/i.test(s.robots);
      if (noindex) {
        rec.add(
          check(`nf.seo.noindex.${t.key}`, 'seo', `${t.label} can be found on Google`, 'fail', {
            severity: 'critical',
            detail: `${t.label} tells search engines not to index it (robots: ${s.robots}).`,
            fix: 'Remove the noindex meta tag from your theme or SEO app settings.',
          })
        );
      }
      rec.add(
        check(`nf.seo.${t.key}`, 'seo', `${t.label} SEO basics`, problems.length === 0 ? 'pass' : problems.length > 2 ? 'fail' : 'warn', {
          severity: 'minor',
          detail: problems.length ? `Found: ${problems.join('; ')}.` : 'Title, description, heading, canonical and share image are in place.',
          fix: problems.length ? 'Edit titles and descriptions under Online Store → Preferences and each product\'s "Search engine listing" section.' : '',
        })
      );
      if (t.key === 'home' && s.imagesTotal > 0) {
        const pct = Math.round((s.imagesMissingAlt / s.imagesTotal) * 100);
        rec.add(
          check('nf.alt', 'accessibility', 'Images have descriptions (alt text)', pct === 0 ? 'pass' : pct > 30 ? 'warn' : 'pass', {
            severity: 'minor',
            detail: pct === 0 ? 'All visible homepage images have alt text.' : `${s.imagesMissingAlt} of ${s.imagesTotal} homepage images have no alt text.`,
            fix: pct > 0 ? 'Add alt text in Products → Media and in theme image sections.' : '',
          })
        );
      }
    } catch (e) {
      rec.add(check(`nf.seo.${t.key}`, 'seo', `${t.label} SEO basics`, 'skip', { detail: shortErr(e) }));
    }
  }

  // Accessibility (WCAG A/AA rules from axe-core) on homepage and product page.
  for (const t of targets) {
    try {
      await gotoStore(page, t.url, { password });
      await settle(page, 600);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      const serious = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
      metrics[`a11y_${t.key}`] = results.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }));
      const top = serious.slice(0, 4).map((v) => `${v.help} (${v.nodes.length})`);
      rec.add(
        check(`nf.a11y.${t.key}`, 'accessibility', `${t.label} is usable with assistive tech`, serious.length === 0 ? 'pass' : serious.length > 4 ? 'fail' : 'warn', {
          severity: 'minor',
          detail: serious.length === 0 ? 'No serious accessibility issues found by automated checks.' : `${serious.length} serious issue type(s): ${top.join('; ')}.`,
          fix: serious.length ? 'Fix colour contrast and missing labels in theme settings; ask your theme developer about the listed rules.' : '',
        })
      );
    } catch (e) {
      rec.add(check(`nf.a11y.${t.key}`, 'accessibility', `${t.label} is usable with assistive tech`, 'skip', { detail: shortErr(e) }));
    }
  }

  // Broken links from the homepage (same-origin only, gentle concurrency).
  try {
    await gotoStore(page, origin + '/', { password });
    await settle(page, 500);
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
    const skip = /\/(cart|account|checkout|checkouts|password)(\/|$|\?)|\/challenge|#|^mailto:|^tel:|^javascript:/i;
    const host = new URL(origin).host;
    const unique = [...new Set(hrefs.map((h) => h.split('#')[0]))].filter((h) => {
      try {
        const u = new URL(h);
        return u.host === host && !skip.test(u.pathname + u.search) && !/^mailto|^tel|^javascript/.test(h);
      } catch {
        return false;
      }
    });
    const list = unique.slice(0, linkLimit);
    const broken = [];
    for (let i = 0; i < list.length; i += 4) {
      const batch = list.slice(i, i + 4);
      const res = await Promise.all(
        batch.map((u) =>
          page.request
            .get(u, { timeout: 15000, maxRedirects: 5 })
            .then((r) => ({ u, s: r.status() }))
            .catch(() => ({ u, s: 0 }))
        )
      );
      for (const r of res) if (r.s >= 400 && r.s !== 429) broken.push(r);
    }
    metrics.links = { checked: list.length, broken };
    rec.add(
      check('nf.links', 'reliability', 'Homepage links work', broken.length === 0 ? 'pass' : broken.length > 3 ? 'fail' : 'warn', {
        severity: 'major',
        detail:
          broken.length === 0
            ? `All ${list.length} homepage links checked are working.`
            : `${broken.length} of ${list.length} links are broken: ${broken
                .slice(0, 5)
                .map((b) => `${new URL(b.u).pathname} (${b.s || 'no response'})`)
                .join(', ')}.`,
        fix: broken.length ? 'Update menus under Online Store → Navigation and links inside theme sections.' : '',
      })
    );
  } catch (e) {
    rec.add(check('nf.links', 'reliability', 'Homepage links work', 'skip', { detail: shortErr(e) }));
  }

  // Policy pages customers (and payment providers) expect.
  const policies = [
    ['privacy-policy', 'Privacy policy'],
    ['refund-policy', 'Refund policy'],
    ['terms-of-service', 'Terms of service'],
    ['shipping-policy', 'Shipping policy'],
  ];
  const missing = [];
  for (const [slug, label] of policies) {
    const s = await page.request
      .get(`${origin}/policies/${slug}`, { timeout: 15000 })
      .then((r) => r.status())
      .catch(() => 0);
    if (s >= 400 || s === 0) missing.push(label);
  }
  rec.add(
    check('nf.policies', 'trust', 'Store policies are published', missing.length === 0 ? 'pass' : 'warn', {
      severity: 'minor',
      detail: missing.length === 0 ? 'Privacy, refund, terms and shipping policies are published.' : `Missing: ${missing.join(', ')}.`,
      fix: missing.length ? 'Add them under Settings → Policies; payment providers and ad platforms check for these.' : '',
    })
  );

  // Catalog quality from the products feed.
  if (info.quality && info.quality.sampled) {
    const q = info.quality;
    const items = [];
    if (q.zeroPrice) items.push(`${q.zeroPrice} priced at 0`);
    if (q.noImage) items.push(`${q.noImage} without images`);
    if (q.noDescription) items.push(`${q.noDescription} with little or no description`);
    const soldPct = Math.round((q.soldOut / q.sampled) * 100);
    if (soldPct >= 40) items.push(`${soldPct}% fully sold out`);
    rec.add(
      check('nf.catalog', 'trust', 'Product catalog looks complete', items.length === 0 ? 'pass' : q.zeroPrice ? 'fail' : 'warn', {
        severity: q.zeroPrice ? 'major' : 'minor',
        detail: items.length === 0 ? `Checked ${q.sampled} products: prices, images and descriptions look complete.` : `Of ${q.sampled} products checked: ${items.join(', ')}.`,
        fix: items.length ? 'Fix in Products. A 0 price usually means an import or bulk-edit mistake.' : '',
      })
    );
  }

  return { metrics };
}

export function jsErrorCheck(rec, pageErrors) {
  const unique = [...new Map(pageErrors.map((e) => [e.message, e])).values()];
  rec.add(
    check('nf.jserrors', 'reliability', 'No JavaScript errors while shopping', unique.length === 0 ? 'pass' : unique.length > 3 ? 'fail' : 'warn', {
      severity: 'major',
      detail:
        unique.length === 0
          ? 'No script errors occurred during the shopping journey.'
          : `${unique.length} script error(s), e.g. "${unique[0].message}" on ${new URL(unique[0].url).pathname}.`,
      evidence: unique.length ? { errors: unique.slice(0, 6) } : null,
      fix: unique.length ? 'Script errors usually come from an app or custom code. They can silently break buttons and cart drawers.' : '',
    })
  );
}
