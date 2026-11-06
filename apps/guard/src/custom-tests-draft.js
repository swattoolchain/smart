/**
 * Your tests, part 3: the owner describes a test in words and AI drafts the steps (main server only).
 * We open the store page the test starts on, write down its outline (headings, fields, buttons, links), and ask
 * the AI for steps in the same file format as an uploaded test. The draft is checked with the same rules as a
 * file and handed to the editor; nothing is saved until the owner saves it.
 */
import { storePassword } from './secret.js';
import { newContext, gotoStore, settle } from './engine/browser.js';
import { validate } from './engine/custom.js';
import { draftTest } from './ai.js';

export const MIN_WORDS = 10;
export const MAX_DESCRIPTION = 600;

/** The store page to start from: a path on the store, "{product}" (the test product) or empty (the test product). */
export function startPath(input) {
  const s = String(input ?? '').trim();
  if (!s || s === '{product}') return '{product}';
  let path = s;
  try { if (/^https?:\/\//i.test(s)) { const u = new URL(s); path = u.pathname + u.search; } } catch { /* checked below */ }
  if (!path.startsWith('/') || path.startsWith('//') || path.length > 300 || /\s/.test(path)) throw new Error('Start the page with “/”, like /pages/contact, or leave it empty to use your test product.');
  return path;
}

/** Plain checks on the owner's words. Throws a plain message. */
export function cleanDescription(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < MIN_WORDS) throw new Error('Describe the test in a sentence or two, like “Enter pincode 560001 on a product page and check it says delivery available”.');
  if (s.length > MAX_DESCRIPTION) throw new Error(`Keep the description under ${MAX_DESCRIPTION} characters.`);
  return s;
}

/** The outline of a page the AI can pick targets from: headings, fields, buttons and links, with ids and text. */
export async function pageOutline(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const txt = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const attrs = (el) => [el.id && `#${el.id}`, el.getAttribute('name') && `name=${el.getAttribute('name')}`, el.className && typeof el.className === 'string' && `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`].filter(Boolean).join(' ');
    const labelOf = (el) => (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent.trim()) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    const lines = [`Address: ${location.pathname}${location.search}`, `Title: ${document.title}`];
    for (const h of [...document.querySelectorAll('h1, h2, h3')].filter(vis).slice(0, 12)) lines.push(`Heading: ${txt(h)}`);
    for (const el of [...document.querySelectorAll('input, select, textarea')].filter((x) => x.type !== 'hidden' && vis(x)).slice(0, 30)) {
      lines.push(`Field: ${el.tagName.toLowerCase()}${el.type ? `[type=${el.type}]` : ''} ${attrs(el)}${labelOf(el) ? ` label “${labelOf(el).slice(0, 60)}”` : ''}${el.tagName === 'SELECT' ? ` options: ${[...el.options].slice(0, 8).map((o) => o.text.trim()).join(' | ')}` : ''}`);
    }
    for (const el of [...document.querySelectorAll('button, [role=button], input[type=submit]')].filter(vis).slice(0, 30)) lines.push(`Button: “${txt(el) || el.value || el.getAttribute('aria-label') || ''}” ${attrs(el)}`);
    for (const el of [...document.querySelectorAll('[aria-live], [class*=result], [class*=message], [class*=notice]')].slice(0, 10)) lines.push(`Message area: ${attrs(el)}${txt(el) ? ` now says “${txt(el)}”` : ' (empty)'}`);
    for (const el of [...document.querySelectorAll('a[href]')].filter(vis).slice(0, 30)) lines.push(`Link: “${txt(el)}” ${new URL(el.href, location.href).pathname}`);
    return lines.join('\n').slice(0, 9000);
  });
}

/**
 * Drafts a test. store: { url, storefront_password }, testProduct: handle or null.
 * Returns { test, note, start } or throws { message, problems?, status }.
 */
export async function draftFromWords({ store, testProduct, description, start, limits }) {
  const origin = new URL(store.url).origin;
  const ctx = await newContext();
  try {
    const page = await ctx.newPage();
    let path = start;
    if (path === '{product}') {
      let handle = testProduct;
      if (!handle) {
        const r = await ctx.request.get(`${origin}/products.json?limit=1`, { timeout: 15000 }).catch(() => null);
        handle = r && r.ok() ? (await r.json().catch(() => ({}))).products?.[0]?.handle : null;
      }
      path = handle ? `/products/${encodeURIComponent(handle)}` : '/';
    }
    const url = new URL(path, origin);
    if (url.origin !== origin) throw Object.assign(new Error('The page must be on your store.'), { status: 400 });
    const g = await gotoStore(page, url.href, { password: storePassword(store) });
    if (g.locked) throw Object.assign(new Error('Your store is password protected and we could not open it. Check the storefront password in Store settings.'), { status: 400 });
    await settle(page, 800);
    const outline = await pageOutline(page);
    const { draft } = await draftTest({ description, outline });
    const raw = { name: String(draft.name || '').trim().slice(0, 80), severity: draft.severity, runs: 'full', device: draft.device, steps: Array.isArray(draft.steps) ? draft.steps : [] };
    if (!['critical', 'major', 'minor'].includes(raw.severity)) delete raw.severity;
    if (!['desktop', 'mobile'].includes(raw.device)) delete raw.device;
    const note = String(draft.note || '').trim().slice(0, 300);
    if (!raw.name || !raw.steps.length) {
      throw Object.assign(new Error(note ? `We couldn't draft this test: ${note}` : 'We couldn\'t draft this test. Try describing it step by step: which page, what to type or click, and what should appear.'), { status: 422 });
    }
    const { tests, problems } = validate({ tests: [raw] }, { ...limits, tests: 1 });
    if (problems.length) {
      throw Object.assign(new Error('The AI\'s draft didn\'t follow the test rules, so we didn\'t use it. Try describing the test step by step, or build it with the steps below.'), { status: 422, problems });
    }
    return { test: tests[0], note, start: path };
  } finally {
    await ctx.close().catch(() => {});
  }
}
