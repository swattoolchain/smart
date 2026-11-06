import { check, shortErr, plural } from './checks.js';
import { gotoStore, settle } from './browser.js';

/**
 * Security watch S5: SEO spam and defacement.
 *
 * Hacked stores are often used to sell links: spam links (casinos, pills, replica goods) are slipped into the
 * theme, usually hidden from shoppers so the owner doesn't notice while Google still reads them. Defacement is
 * the loud version: the homepage is replaced with an attacker's message. Both are reported in the Security area.
 */

// Words that only show up on a store when someone else put them there. Kept narrow on purpose: no "slot", "loan"
// or "bet" alone, which honest stores use ("delivery slot", "loan-free").
export const SPAM_WORDS = /\b(casinos?|online casino|viagra|cialis|levitra|kamagra|tadalafil|sildenafil|porn|porno|escort service|sportsbook|online betting|betting sites?|poker online|slot gacor|gacor|judi online|togel|bokep|replica (?:watches|handbags|bags|rolex)|payday loans?|essay writing service|buy (?:essays?|instagram followers|followers)|cheap (?:jerseys|oakleys|ray-?bans|uggs|cigarettes))\b/i;

// What attackers write when they deface a site.
export const DEFACE_WORDS = /\b(?:hacked|defaced|pwned|h[a4]ck[e3]d|0wn[e3]d)\s+by\b|\byour (?:site|store|website|shop) (?:has been|was|is|got) hacked\b|\bgreetz\b|\bsecurity is (?:very )?(?:low|weak)\b/i;

// Social and platform sites that themes legitimately link to, sometimes from collapsed menus.
const KNOWN = /(^|\.)(facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|pinterest\.com|tiktok\.com|linkedin\.com|wa\.me|whatsapp\.com|threads\.net|snapchat\.com|shopify\.com|myshopify\.com|shop\.app|google\.com|apple\.com|paypal\.com)$/i;

/** Finds spam words and links hidden from shoppers in the page that is open. Runs in the browser. */
export async function scanPage(page) {
  return page.evaluate(({ spam, known }) => {
    const SPAM = new RegExp(spam, 'i');
    const KNOWN = new RegExp(known, 'i');
    const here = location.hostname.replace(/^www\./, '');
    const W = innerWidth, H = Math.max(document.documentElement.scrollHeight, innerHeight);
    const external = (host) => host && host.replace(/^www\./, '') !== here;
    // How an element is kept from shoppers, if it is: null when shoppers can see it.
    const how = (el) => {
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        for (let e = el; e && e !== document.body; e = e.parentElement) {
          const s = getComputedStyle(e);
          if (s.opacity === '0') return 'see-through';
          if (s.visibility === 'hidden') return 'hidden';
          if (s.display === 'none') return 'not shown';
        }
        return 'hidden';
      }
      const r = el.getBoundingClientRect();
      if (r.right < -50 || r.bottom + scrollY < -50 || r.left > W + 500 || r.top + scrollY > H + 500) return 'moved off the page';
      if (r.width <= 1 || r.height <= 1) return 'shrunk to nothing';
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 2) return 'shrunk to nothing';
      return null;
    };
    // Deliberate ways of hiding something (unlike a closed menu, which is just "not shown").
    const cloaked = (h) => h === 'moved off the page' || h === 'shrunk to nothing' || h === 'see-through';
    const links = [];
    for (const a of document.querySelectorAll('a[href]')) {
      let u;
      try { u = new URL(a.getAttribute('href'), location.href); } catch { continue; }
      if (!/^https?:$/.test(u.protocol) || !external(u.hostname)) continue;
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const words = SPAM.exec(`${text} ${a.getAttribute('title') || ''} ${u.href}`);
      const hidden = how(a);
      if (words || (cloaked(hidden) && !KNOWN.test(u.hostname))) links.push({ href: u.href.slice(0, 200), host: u.hostname, text, hidden, word: words ? words[0].toLowerCase() : null });
    }
    // Spam words in text that isn't a link (some injections are just hidden keyword blocks).
    const texts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.parentElement?.tagName) || n.parentElement?.closest('a[href]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n && texts.length < 10; n = walker.nextNode()) {
      const m = SPAM.exec(n.textContent || '');
      if (m) texts.push({ text: n.textContent.replace(/\s+/g, ' ').trim().slice(0, 120), word: m[0].toLowerCase(), hidden: how(n.parentElement) });
    }
    return { links: links.slice(0, 30), texts };
  }, { spam: SPAM_WORDS.source, known: KNOWN.source });
}

/** Checks the home page and a product page for spam links and spam text. Adds `sec.spam`. */
export async function runSpam({ page, rec, origin, info, password, shot }) {
  const pages = [['Home page', origin + '/']];
  if (info.products[0]) pages.push(['Product page', `${origin}/products/${info.products[0].handle}`]);
  const found = [];
  let checked = 0, shotUrl = null;
  for (const [label, url] of pages) {
    try {
      await gotoStore(page, url, { password });
      await settle(page, 800);
      const r = await scanPage(page);
      checked++;
      for (const l of r.links) found.push({ page: label, kind: 'link', ...l });
      for (const t of r.texts) found.push({ page: label, kind: 'text', ...t });
      if (!shotUrl && (r.links.some((l) => l.word) || r.texts.length)) shotUrl = await shot(page, 'spam');
    } catch (e) {
      rec.step(`Spam check could not open ${label.toLowerCase()}: ${shortErr(e)}`);
    }
  }
  if (!checked) {
    rec.add(check('sec.spam', 'security', 'No spam links or hidden text', 'skip', { severity: 'minor', detail: 'We could not open your pages to look for spam links.' }));
    return found;
  }
  const spam = found.filter((f) => f.word);
  const cloaked = found.filter((f) => !f.word);
  const where = (list) => [...new Set(list.map((f) => f.page.toLowerCase()))].join(' and ');
  if (spam.length) {
    const hidden = spam.filter((f) => f.hidden);
    const words = [...new Set(spam.map((f) => f.word))].slice(0, 5);
    const sites = [...new Set(spam.filter((f) => f.host).map((f) => f.host))].slice(0, 5);
    rec.add(check('sec.spam', 'security', 'No spam links or hidden text', 'fail', {
      severity: 'major',
      detail: `We found spam on your ${where(spam)}: ${plural(spam.length, 'place')} mentioning “${words.join('”, “')}”${sites.length ? `, linking to ${sites.join(', ')}` : ''}.`
        + (hidden.length ? ` ${hidden.length === spam.length ? 'All of it is' : `${hidden.length} of them are`} hidden from shoppers, so you won't see it on your store, but Google does.` : '')
        + ' This usually means someone changed your theme or an app without your knowledge. Google can lower your store in search results or mark it as hacked.',
      evidence: { spam: found, screenshot: shotUrl },
      fix: 'In Shopify, open Online Store → Themes → ⋯ → Edit code and search your theme files for the words or sites above, then remove them. Check recently installed apps, change your Shopify password, and review who has staff access.',
    }));
  } else if (cloaked.length) {
    const sites = [...new Set(cloaked.map((f) => f.host))].slice(0, 5);
    rec.add(check('sec.spam', 'security', 'No spam links or hidden text', 'warn', {
      severity: 'minor',
      detail: `Your ${where(cloaked)} ${cloaked.length === 1 ? 'has a link' : `has ${cloaked.length} links`} to ${sites.join(', ')} that ${cloaked.length === 1 ? 'is' : 'are'} hidden from shoppers (${[...new Set(cloaked.map((f) => f.hidden))].join(', ')}). Hidden links to other websites are a common sign of SEO spam.`,
      evidence: { spam: found },
      fix: 'If you don\'t know why these links are there, search your theme code for the sites above and remove them.',
    }));
  } else {
    rec.add(check('sec.spam', 'security', 'No spam links or hidden text', 'pass', { severity: 'major', detail: `No spam links or hidden spam text on your ${pages.map(([l]) => l.toLowerCase()).join(' and ')}.`, evidence: { spam: [] } }));
  }
  return found;
}

/** Words on the page, for telling a redesign from a replaced page. */
export function words(text) {
  return new Set(String(text || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
}

/** Share of the approved page's words that are still there (0–1). */
export function overlap(before, now) {
  const a = words(before), b = words(now);
  if (!a.size) return 1;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / a.size;
}

/**
 * Defacement, judged from the visual-check results plus the text of each page.
 * shots: [{ key, ratio (0–1) | null, text, title, before: { text, title } | null }]
 */
export function defacementCheck({ rec, shots }) {
  const hits = [];
  for (const s of shots) {
    const now = `${s.title || ''}\n${s.text || ''}`;
    const before = s.before ? `${s.before.title || ''}\n${s.before.text || ''}` : '';
    const m = DEFACE_WORDS.exec(now);
    if (m && !DEFACE_WORDS.test(before)) { hits.push({ key: s.key, why: 'message', words: m[0] }); continue; }
    // A page that looks completely different and lost most of its words was replaced, not restyled.
    if (s.before && s.ratio != null && s.ratio >= 0.5 && overlap(before, now) < 0.25) hits.push({ key: s.key, why: 'replaced', kept: Math.round(overlap(before, now) * 100) });
  }
  const pageOf = (k) => (k.startsWith('home') ? 'homepage' : 'product page');
  const devs = (list) => [...new Set(list.map((h) => h.key.split('-')[1]))].join(', ');
  const msg = hits.filter((h) => h.why === 'message');
  const rep = hits.filter((h) => h.why === 'replaced');
  if (msg.length) {
    rec.add(check('sec.deface', 'security', 'Store has not been defaced', 'fail', {
      severity: 'critical',
      detail: `Your ${[...new Set(msg.map((h) => pageOf(h.key)))].join(' and ')} shows a hacker's message (“${msg[0].words}”) on ${devs(msg)}. Shoppers see this instead of your store.`,
      evidence: { deface: hits },
      fix: 'In Shopify, open Online Store → Themes and publish a theme you trust (or restore an earlier version of the theme code). Then change your Shopify password, turn on two-step login, remove staff and apps you don\'t recognise, and contact Shopify Support.',
    }));
  } else if (rep.length) {
    rec.add(check('sec.deface', 'security', 'Store has not been defaced', 'fail', {
      severity: 'major',
      detail: `Your ${[...new Set(rep.map((h) => pageOf(h.key)))].join(' and ')} looks completely different from the approved version and only ${Math.min(...rep.map((h) => h.kept))}% of its words are still there (${devs(rep)}). If you didn't just redesign your store, it may have been defaced.`,
      evidence: { deface: hits },
      fix: 'Look at the screenshots. If this is your new design, approve the new look. If not, publish a theme you trust and change your Shopify password.',
    }));
  } else {
    rec.add(check('sec.deface', 'security', 'Store has not been defaced', 'pass', { severity: 'major', detail: shots.some((s) => s.before) ? 'Your homepage and product page show your own store.' : 'No hacker message on your pages. Today\'s pages are saved as the approved look; future checks compare against them.', evidence: { deface: [] } }));
  }
  return hits;
}
