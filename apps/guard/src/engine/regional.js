/**
 * Regional packs: the rules that apply where a store sells.
 *  - law.de       Germany and Austria: legal notice, withdrawal, price display, unit prices, withdrawal button
 *  - law.cookies  EU and UK: a consent banner, and no ad tracking before the shopper agrees
 *  - access.law   US (ADA) and EU (European Accessibility Act): the accessibility issues lawsuits and regulators look for
 *  - law.us       US privacy: the "Do not sell or share my personal information" link
 * These are automated checks, not legal advice; every detail says what was seen so the owner can judge.
 */
import AxeBuilder from '@axe-core/playwright';
import { newContext, gotoStore, openPreview } from './browser.js';
import { check, shortErr, plural } from './checks.js';

const settle = (page, ms = 800) => page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}).then(() => page.waitForTimeout(ms));

/** Links on the page, with visible text, plus the page's own text. */
async function readPage(page) {
  return page.evaluate(() => ({
    links: [...document.querySelectorAll('a[href], button')].map((a) => ({
      text: (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      href: a.getAttribute('href') || '',
      visible: !!(a.offsetWidth || a.offsetHeight || a.getClientRects().length),
    })),
    text: (document.body?.innerText || '').replace(/\s+/g, ' '),
    lang: document.documentElement.getAttribute('lang') || '',
    viewport: document.querySelector('meta[name=viewport]')?.getAttribute('content') || '',
  }));
}
const findLink = (links, re) => links.find((l) => re.test(l.text) || re.test(decodeURIComponent(l.href || '')));
const abs = (origin, href) => { try { return new URL(href, origin + '/').toString(); } catch { return null; } };
async function fetchText(request, url) {
  try {
    const r = await request.get(url, { timeout: 15000 });
    if (r.status() >= 400) return null;
    return (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  } catch { return null; }
}

// Ad and analytics trackers that must wait for consent in the EU and UK.
const TRACKERS = [
  [/facebook\.com\/tr|connect\.facebook\.net/, 'Meta (Facebook) pixel'],
  [/analytics\.tiktok\.com/, 'TikTok pixel'],
  [/ct\.pinterest\.com|s\.pinimg\.com\/ct/, 'Pinterest tag'],
  [/bat\.bing\.com/, 'Microsoft (Bing) ads'],
  [/sc-static\.net|tr\.snapchat\.com/, 'Snapchat pixel'],
  [/px\.ads\.linkedin\.com|snap\.licdn\.com/, 'LinkedIn insight tag'],
  [/static\.hotjar\.com|script\.hotjar\.com/, 'Hotjar'],
  [/clarity\.ms/, 'Microsoft Clarity'],
  [/klaviyo\.com\/onsite|static\.klaviyo\.com/, null], // loads forms, not tracking by itself
];
const CMP = /cookiebot|consentmanager|usercentrics|onetrust|cookielaw|klaro|iubenda|complianz|cookieyes|termly|didomi|borlabs|pandectes|consentmo|cookie-script|shopify-pc__banner|privacy-banner|cc-window|cookie-?banner|cookie-?consent|gdpr/i;

// Overlay widgets that promise one-click compliance. Regulators and courts have rejected that promise.
const OVERLAYS = [[/acsbapp\.com|accessibe/i, 'accessiBe'], [/userway\.org/i, 'UserWay'], [/audioeye\.com/i, 'AudioEye'], [/equalweb\.com|nagich/i, 'EqualWeb'], [/maxaccess|max-access/i, 'MaxAccess'], [/accessiblyapp|accessibly\.app/i, 'Accessibly'], [/enable\.co\.il|enable-accessibility/i, 'Enable']];

export async function runRegional({ page, rec, origin, info, password, on, preview = null }) {
  const product = info.products[0] ? `${origin}/products/${info.products[0].handle}` : null;
  let home = null, pdp = null;
  try {
    await gotoStore(page, origin + '/', { password });
    await settle(page, 500);
    home = await readPage(page);
  } catch (e) {
    for (const g of ['law.de', 'law.us']) if (on(g)) rec.add(check(`${g === 'law.de' ? 'de' : 'us'}.legal`, 'compliance', 'Legal pages', 'skip', { detail: shortErr(e) }));
  }
  if (product && (on('law.de') || on('access.law'))) {
    try { await gotoStore(page, product, { password }); await settle(page, 500); pdp = await readPage(page); } catch {}
  }

  if (on('law.de') && home) await germany({ page, rec, origin, info, home, pdp });
  if (on('law.us') && home) us({ rec, home });
  if (on('access.law')) await access({ page, rec, origin, password, home, pdp, product, info });
  if (on('law.cookies')) await consent({ rec, origin, password, preview });
}

async function germany({ page, rec, origin, info, home, pdp }) {
  const L = home.links;
  // Impressum: required for every commercial website in Germany (§ 5 DDG) and Austria (§ 5 ECG).
  const imp = findLink(L, /impressum|imprint|legal notice|anbieterkennzeichnung/i);
  let impText = null;
  if (imp) impText = await fetchText(page.request, abs(origin, imp.href));
  const impOk = imp && impText && /@|e-?mail/i.test(impText) && /\b\d{4,5}\b/.test(impText);
  rec.add(check('de.impressum', 'compliance', 'Legal notice (Impressum) is linked on every page', !imp ? 'fail' : impOk ? 'pass' : 'warn', {
    severity: 'major',
    detail: !imp ? 'No link to an Impressum or legal notice was found on your homepage.' : impOk ? `Linked as “${imp.text || 'Impressum'}”, with an address and email.` : `Linked as “${imp.text || 'Impressum'}”, but we could not find both a postal address and an email address on it.`,
    fix: !imp ? 'Add an Impressum page (company name, address, email, phone, register and VAT number) and link it in your footer. In Shopify: Settings → Policies → Contact information, then add it to the footer menu.' : impOk ? '' : 'The Impressum must show your full postal address and an email address customers can use.',
  }));

  // Right of withdrawal (Widerrufsbelehrung): 14 days for EU consumers.
  const wd = findLink(L, /widerruf|withdrawal|right to cancel|cancellation policy/i);
  const refund = findLink(L, /refund|r(ü|ue)ckgabe|erstattung|returns?/i) || { href: '/policies/refund-policy' };
  const policyText = wd ? await fetchText(page.request, abs(origin, wd.href)) : await fetchText(page.request, abs(origin, refund.href));
  const hasWd = policyText && /widerruf|right of withdrawal|withdraw from (this|the) contract|14 (tage|days)/i.test(policyText);
  rec.add(check('de.withdrawal', 'compliance', 'Right of withdrawal (Widerrufsbelehrung) is published', hasWd ? 'pass' : 'fail', {
    severity: 'major',
    detail: hasWd ? `Found${wd ? ` as “${wd.text}”` : ' in your refund policy'}, with the 14-day withdrawal wording.` : policyText ? 'Your refund or returns page does not explain the 14-day right of withdrawal.' : 'No withdrawal or refund policy page was found.',
    fix: hasWd ? '' : 'Publish a Widerrufsbelehrung with the model withdrawal form, and link it in your footer. In Shopify: Settings → Policies → Refund policy.',
  }));

  // From 19 June 2026, EU shops must offer an easy "withdraw from contract" function, labelled clearly.
  const btn = findLink(L, /vertrag(e)? (hier )?widerrufen|widerruf (hier )?(erkl(ä|ae)ren|einreichen|starten)|withdraw from (the |your )?contract|cancel (the |your )?contract here/i);
  rec.add(check('de.withdrawbutton', 'compliance', 'Withdrawal button (“Vertrag widerrufen”) is offered', btn ? (btn.visible ? 'pass' : 'warn') : 'fail', {
    severity: 'major',
    detail: btn ? (btn.visible ? `Found “${btn.text || 'withdrawal function'}”.` : `Found “${btn.text}”, but it is not visible on the homepage.`) : 'No clearly labelled withdrawal function was found. EU rules require one for online shops from 19 June 2026.',
    fix: btn?.visible ? '' : 'Add a clearly visible link or button labelled “Vertrag widerrufen” that leads to a short withdrawal form with a “Widerruf bestätigen” button. Keep it easy to find, not hidden in a long list of links.',
  }));

  // Privacy policy and terms.
  const priv = findLink(L, /datenschutz|privacy/i);
  const agb = findLink(L, /\bagb\b|gesch(ä|ae)ftsbedingungen|terms/i);
  const missing = [!priv && 'privacy policy (Datenschutzerklärung)', !agb && 'terms (AGB)'].filter(Boolean);
  rec.add(check('de.legalpages', 'compliance', 'Privacy policy and terms are linked', missing.length === 0 ? 'pass' : !priv ? 'fail' : 'warn', {
    severity: !priv ? 'major' : 'minor',
    detail: missing.length === 0 ? 'Privacy policy and terms are linked from your homepage.' : `Not linked from your homepage: ${missing.join(' and ')}.`,
    fix: missing.length ? 'Publish them under Settings → Policies and add them to your footer menu.' : '',
  }));

  // The EU dispute platform closed on 20 July 2025. Old links and wording now point customers to nothing.
  const odr = L.find((l) => /ec\.europa\.eu\/consumers\/odr/i.test(l.href));
  const odrText = !odr && impText && /ec\.europa\.eu\/consumers\/odr|online-streitbeilegung|os-plattform/i.test(impText);
  rec.add(check('de.odr', 'compliance', 'No outdated EU dispute platform (ODR) link', odr || odrText ? 'warn' : 'pass', {
    severity: 'minor',
    detail: odr || odrText ? 'Your store still links to or mentions the EU online dispute resolution platform, which closed on 20 July 2025.' : 'No outdated ODR link found.',
    fix: odr || odrText ? 'Remove the ODR link and paragraph from your Impressum, terms and footer.' : '',
  }));

  // Price display (PAngV): prices include VAT, and shipping costs are mentioned.
  if (pdp) {
    const vat = /inkl\.?\s*(\d+\s*%\s*)?(mwst|ust)|incl\.?\s*(\d+\s*%\s*)?(vat|tax)|tax(es)? included|including (vat|tax)|steuern inbegriffen|mwst\.? (inkl|enthalten)/i.test(pdp.text);
    const ship = /versand|shipping|zzgl|lieferkosten|delivery/i.test(pdp.text);
    rec.add(check('de.priceinfo', 'compliance', 'Prices show VAT and shipping information', vat && ship ? 'pass' : 'fail', {
      severity: 'major',
      detail: vat && ship ? 'The product page says prices include VAT and mentions shipping costs.' : `The product page does not say ${[!vat && 'that prices include VAT', !ship && 'how shipping is charged'].filter(Boolean).join(' or ')}.`,
      fix: vat && ship ? '' : 'Show “inkl. MwSt., zzgl. Versandkosten” (with a link to shipping costs) next to every price. In Shopify: Settings → Taxes and duties → “Include sales tax in product price”, and turn on the tax and shipping note in your theme’s product page settings.',
    }));

    // Unit price (Grundpreis) for products sold by weight or volume.
    const UNIT = /\b\d+([.,]\d+)?\s?(ml|cl|l|g|kg|liter|litre)\b/i;
    const measured = (info.products || []).filter((p) => UNIT.test(p.title || '')).slice(0, 8);
    if (measured.length) {
      const lacking = [];
      for (const p of measured) {
        try {
          const r = await page.request.get(`${origin}/products/${p.handle}.js`, { timeout: 12000 });
          const j = r.ok() ? await r.json() : null;
          if (j && !(j.variants || []).some((v) => v.unit_price)) lacking.push(p.title);
        } catch {}
      }
      rec.add(check('de.unitprice', 'compliance', 'Unit prices (Grundpreis) for products sold by weight or volume', lacking.length ? 'warn' : 'pass', {
        severity: 'major',
        detail: lacking.length ? `${plural(lacking.length, 'product')} sold by weight or volume without a unit price, e.g. “${lacking[0]}”.` : `${plural(measured.length, 'product')} sold by weight or volume, all with a unit price.`,
        fix: lacking.length ? 'In each product’s variant, set “Show unit price” with the total and base measure (for example 250 ml, per 100 ml), and show it in your theme.' : '',
      }));
    }
  }
}

function us({ rec, home }) {
  const optout = findLink(home.links, /do not sell|do not share|your privacy choices|opt.?out of (the )?sale/i);
  rec.add(check('us.optout', 'compliance', '“Do not sell or share my personal information” link', optout ? 'pass' : 'warn', {
    severity: 'minor',
    detail: optout ? `Found “${optout.text}”.` : 'No “Do not sell or share my personal information” or “Your privacy choices” link was found. Stores that sell or share data for ads with California shoppers may need one.',
    fix: optout ? '' : 'In Shopify: Settings → Customer privacy → turn on the US state privacy laws setting; Shopify then adds the link and page for you.',
  }));
}

async function access({ page, rec, origin, password, home, pdp, product, info }) {
  // Zoom: blocking pinch-zoom fails WCAG 1.4.4 and is easy to fix.
  if (home) {
    const vp = home.viewport.toLowerCase();
    const blocked = /user-scalable\s*=\s*(no|0)/.test(vp) || /maximum-scale\s*=\s*1(\.0)?\b/.test(vp);
    rec.add(check('ax.zoom', 'accessibility', 'Shoppers can zoom in on phones', blocked ? 'fail' : 'pass', {
      severity: 'major',
      detail: blocked ? `Your theme turns off zooming (viewport: “${home.viewport}”). People with low vision can’t enlarge text.` : 'Zooming is allowed.',
      fix: blocked ? 'Remove maximum-scale=1 and user-scalable=no from the viewport meta tag in theme.liquid.' : '',
    }));
    rec.add(check('ax.lang', 'accessibility', 'Page language is set', home.lang ? 'pass' : 'fail', {
      severity: 'minor',
      detail: home.lang ? `Language set to “${home.lang}”, so screen readers use the right voice.` : 'The page does not say which language it is in, so screen readers may read it with the wrong voice.',
      fix: home.lang ? '' : 'Add lang="{{ request.locale.iso_code }}" to the <html> tag in theme.liquid.',
    }));
    const stmt = findLink(home.links, /accessibility|barrierefreiheit|accessibilit(é|e)|accesibilidad/i);
    rec.add(check('ax.statement', 'accessibility', 'Accessibility statement is published', stmt ? 'pass' : 'warn', {
      severity: 'minor',
      detail: stmt ? `Found “${stmt.text}”.` : 'No accessibility statement is linked. The European Accessibility Act asks shops to explain how their store meets accessibility requirements, and a statement also helps in the US.',
      fix: stmt ? '' : 'Publish a short page describing what you have done for accessibility, known gaps, and how customers can ask for help, and link it in your footer.',
    }));
  }

  // Overlays: a widget does not make a store compliant; many sued stores had one.
  const html = await page.content().catch(() => '');
  const overlay = OVERLAYS.find(([re]) => re.test(html));
  rec.add(check('ax.overlay', 'accessibility', 'No accessibility overlay relied on for compliance', overlay ? 'warn' : 'pass', {
    severity: 'minor',
    detail: overlay ? `${overlay[1]} is installed. Overlays don’t fix the underlying code; in 2025 the US FTC fined one overlay vendor $1 million for claiming they made sites compliant.` : 'No overlay widget found.',
    fix: overlay ? 'Keep it if shoppers use it, but fix the issues Tharam lists in your theme itself. Don’t rely on the widget for compliance.' : '',
  }));

  // Keyboard: can someone who can't use a mouse reach Add to cart?
  if (product) {
    try {
      await gotoStore(page, product, { password });
      await settle(page, 400);
      let found = false, outline = null;
      {
        // Start from the top of the page without clicking anything (a click could follow a link).
        await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); }).catch(() => {});
        for (let i = 0; i < 80 && !found; i++) {
          await page.keyboard.press('Tab');
          const r = await page.evaluate(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return null;
            const atc = el.matches('[name=add], form[action*="/cart/add"] [type=submit]') || /add to (cart|bag|basket)|in den warenkorb|ajouter au panier|añadir al carrito/i.test(el.innerText || el.value || '');
            if (!atc) return null;
            const cs = getComputedStyle(el);
            const visibleFocus = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
            return { visibleFocus };
          });
          if (r) { found = true; outline = r.visibleFocus; }
        }
      }
      rec.add(check('ax.keyboard', 'accessibility', 'Add to cart can be reached with the keyboard', found ? (outline ? 'pass' : 'warn') : 'fail', {
        severity: 'major',
        detail: found ? (outline ? 'Pressing Tab reaches Add to cart, and it shows where the focus is.' : 'Pressing Tab reaches Add to cart, but there is no visible focus outline, so keyboard users can’t see where they are.') : 'We pressed Tab 80 times on the product page and never reached Add to cart. Keyboard and screen-reader users may not be able to buy.',
        fix: found && outline ? '' : found ? 'Don’t remove focus outlines in your theme CSS (outline: none). Add a clear :focus-visible style instead.' : 'Make Add to cart a real <button>, and check that popups or custom option pickers don’t trap the keyboard.',
      }));
    } catch (e) {
      rec.add(check('ax.keyboard', 'accessibility', 'Add to cart can be reached with the keyboard', 'skip', { detail: shortErr(e) }));
    }
  }

  // The cart is part of buying too: run the same WCAG checks there.
  try {
    await gotoStore(page, origin + '/cart', { password });
    await settle(page, 400);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const serious = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    rec.add(check('ax.cart', 'accessibility', 'Cart page is usable with assistive tech', serious.length === 0 ? 'pass' : serious.length > 3 ? 'fail' : 'warn', {
      severity: 'minor',
      detail: serious.length === 0 ? 'No serious issues on the cart page (WCAG 2.1 AA, automated).' : `${plural(serious.length, 'serious issue type')}: ${serious.slice(0, 3).map((v) => `${v.help} (${v.nodes.length})`).join('; ')}.`,
      fix: serious.length ? 'Ask your theme developer to fix the listed rules on the cart page; quantity buttons and remove links often lack labels.' : '',
    }));
  } catch (e) {
    rec.add(check('ax.cart', 'accessibility', 'Cart page is usable with assistive tech', 'skip', { detail: shortErr(e) }));
  }
}

async function consent({ rec, origin, password, preview }) {
  // A first-time visitor from Germany: nothing clicked, no cookies.
  const ctx = await newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const seen = new Set();
  let googleGranted = false;
  ctx.on('request', (r) => {
    const u = r.url();
    for (const [re, name] of TRACKERS) if (name && re.test(u)) seen.add(name);
    // Google tags may load in "consent mode" and only send cookieless pings. gcs=G111 means full tracking.
    if (/google-analytics\.com\/(g\/)?collect|googleadservices|googleads\.g\.doubleclick|google\.com\/pagead/.test(u)) {
      const gcs = /[?&]gcs=([^&]+)/.exec(u)?.[1];
      // G1xy: x = ads, y = analytics, 1 = granted. No gcs at all means the tag ignores consent.
      if (!gcs || /^G1(1.|.1)/.test(gcs)) googleGranted = true;
    }
  });
  try {
    const page = await ctx.newPage();
    if (password) await gotoStore(page, origin + '/', { password }).catch(() => {});
    if (preview) await openPreview(page, preview.url, { password }).catch(() => {});
    // Unlocking may have set cookies already; start this visit with a clean slate except the unlock.
    seen.clear(); googleGranted = false;
    await gotoStore(page, origin + '/', { password });
    await settle(page, 3500);
    const html = await page.content();
    const banner = await page.evaluate((src) => {
      const re = new RegExp(src, 'i');
      const nodes = [...document.querySelectorAll('[id],[class],[role=dialog],[aria-modal]')].filter((el) => re.test(el.id + ' ' + el.className) || /cookie|consent|einwillig|datenschutz/i.test(el.getAttribute('aria-label') || ''));
      const visible = nodes.some((el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 50 && r.height > 20 && s.visibility !== 'hidden' && s.display !== 'none'; });
      const text = /(cookies?|einwilligung|zustimmen|alle akzeptieren|accept all)/i.test(document.body.innerText.slice(0, 20000));
      return { visible, text };
    }, CMP.source);
    const hasBanner = banner.visible || (banner.text && CMP.test(html));
    const trackers = [...seen, ...(googleGranted ? ['Google Ads or Analytics (full tracking)'] : [])];
    rec.add(check('eu.banner', 'compliance', 'Cookie consent banner is shown to EU visitors', hasBanner ? 'pass' : trackers.length ? 'fail' : 'warn', {
      severity: 'major',
      detail: hasBanner ? 'A consent banner appears on the first visit.' : trackers.length ? 'No consent banner appeared for a first-time visitor from Germany, but tracking tags loaded.' : 'No consent banner appeared for a first-time visitor from Germany. That is fine only if your store uses no tracking or marketing cookies.',
      fix: hasBanner ? '' : 'Turn on the cookie banner in Shopify (Settings → Customer privacy → Cookie banner) or install a consent app, and show it in the EU and UK.',
    }));
    rec.add(check('eu.tracking', 'compliance', 'No ad tracking before the visitor agrees', trackers.length ? 'fail' : 'pass', {
      severity: 'major',
      detail: trackers.length ? `Loaded before any consent was given: ${trackers.join(', ')}.` : 'No ad or tracking tags fired before consent.',
      fix: trackers.length ? 'Load pixels only after consent: use Shopify’s Customer Privacy API (most Shopify pixel apps follow it), or set your consent app to block these tags until the visitor agrees.' : '',
    }));
  } catch (e) {
    rec.add(check('eu.tracking', 'compliance', 'No ad tracking before the visitor agrees', 'skip', { detail: shortErr(e) }));
  } finally {
    await ctx.close().catch(() => {});
  }
}
