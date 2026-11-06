/**
 * AI shopper (roadmap 2, part 1): a goal-driven shopper that finds its own way through any theme.
 * Each step it reads the page (address, cart count, a short excerpt, the things it can click or choose),
 * an AI picks the next action, and we carry it out, with hard limits:
 *   - only click, choose an option, or open a page on the same store; it never types anything
 *   - never presses anything that pays or places an order; it stops the moment checkout opens
 *   - at most MAX_STEPS steps per check, then the cart is emptied
 *   - it never leaves the store: links to other sites are not shown to the AI, and any page load to
 *     another site (link, script, popup) is blocked and ends the run
 *   - checkout counts only on the store's own address or Shopify's checkout, at a checkout path, on a
 *     page that looks like checkout (so /pages/checkout-help or other-site.example/checkout never count)
 * The result is one check, `ai.shopper`, with every step and the friction it noticed.
 */
import { newContext, gotoStore, settle } from './browser.js';
import { check, shortErr, plural } from './checks.js';
import { shopperStep } from '../ai.js';

export const MAX_STEPS = 12;
export const GOAL = 'Find a product you would buy, add it to the cart, open the cart and go to checkout. Stop when checkout opens.';
// Buttons the shopper must never press, whatever the AI says.
const FORBIDDEN = /\b(pay( now)?|place (my )?order|complete (my )?(order|purchase)|submit order|confirm (order|payment)|log ?in|sign ?in|sign ?up|create account|register|delete|remove all|unsubscribe)\b/i;
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const baseOf = (h) => h.replace(/^www\./, '');
const isHttp = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
/** The store's own addresses: its origin, the same domain with or without www (and its subdomains), and its .myshopify.com domain. */
export function onStore(url, origin, shopDomain = '') {
  const h = hostOf(url);
  if (!h || !isHttp(url)) return false;
  const store = baseOf(hostOf(origin));
  if (h === hostOf(origin) || baseOf(h) === store || h.endsWith(`.${store}`)) return true;
  return !!shopDomain && h === String(shopDomain).toLowerCase();
}
/** Shopify's own checkout hosts (same list as the checkout-destination check). */
const shopifyCheckoutHost = (h) => /(^|\.)(checkout|pay)\.shopify\.com$/.test(h) || h === 'shop.app' || h.endsWith('.shop.app');
/** Where the shopper may be at all: the store, or Shopify's checkout. */
export const allowedPlace = (url, origin, shopDomain = '') => onStore(url, origin, shopDomain) || (isHttp(url) && shopifyCheckoutHost(hostOf(url)));
/** Checkout by address: the store's own (or Shopify's) host and a checkout path. A path that merely contains "checkout" does not count. */
export const atCheckout = (url, origin, shopDomain = '') => {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!isHttp(url)) return false;
  const shaped = /^\/checkouts?(\/|$)|^\/\d+\/checkouts\//.test(u.pathname);
  if (onStore(url, origin, shopDomain)) return shaped;
  return shopifyCheckoutHost(u.hostname.toLowerCase()) && (shaped || /^\/(checkout|pay)(\/|$)/.test(u.pathname));
};
/** Checkout by content: a contact or delivery form, as every checkout has. */
async function looksLikeCheckout(page) {
  return page.evaluate(() => {
    if (document.querySelector('input[type=email], input[autocomplete~=email], input[name*=email i], input[autocomplete~=shipping]')) return true;
    return /\b(contact|delivery|shipping address|payment|order summary)\b/i.test((document.body?.innerText || '').slice(0, 4000));
  }).catch(() => false);
}

/** What the shopper can see: numbered visible links, buttons and option lists, plus a short page excerpt. */
async function observe(page, origin, shopDomain) {
  const data = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const els = [...document.querySelectorAll('a[href], button, [role=button], input[type=submit], input[type=button], select')].filter(vis).slice(0, 80);
    document.querySelectorAll('[data-tharam-i]').forEach((e) => e.removeAttribute('data-tharam-i'));
    const items = els.map((el, i) => {
      el.setAttribute('data-tharam-i', String(i));
      const tag = el.tagName.toLowerCase();
      if (tag === 'select') return { i, kind: 'list', text: label(el.labels?.[0] || el) || el.name || 'options', options: [...el.options].map((o) => o.text.trim()).slice(0, 15), disabled: el.disabled };
      const href = tag === 'a' ? el.getAttribute('href') : null;
      return { i, kind: tag === 'a' ? 'link' : 'button', text: label(el), href, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' };
    });
    return { title: document.title, text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200), items };
  });
  const cart = await page.evaluate(async () => { try { const r = await fetch('/cart.js', { headers: { Accept: 'application/json' }, credentials: 'same-origin' }); return r.ok ? (await r.json()).item_count : null; } catch { return null; } }).catch(() => null);
  // Links to other sites are not offered at all: page text and links come from the store (and its visitors), and must never steer the shopper away.
  const abs = (h) => { try { return new URL(h, page.url()).href; } catch { return ''; } };
  data.items = data.items.filter((x) => !x.href || !isHttp(abs(x.href)) || allowedPlace(abs(x.href), origin, shopDomain));
  const lines = data.items.map((x) => `[${x.i}] ${x.kind} "${x.text}"${x.href ? ` -> ${x.href}` : ''}${x.options ? ` options: ${x.options.map((o) => `"${o}"`).join(', ')}` : ''}${x.disabled ? ' (disabled)' : ''}`);
  return {
    items: data.items,
    text: `Address: ${new URL(page.url()).pathname}${new URL(page.url()).search}\nPage title: ${data.title}\nItems in cart: ${cart ?? 'unknown'}\nPage text (start): ${data.text}\n\nYou can use:\n${lines.join('\n') || '(nothing clickable)'}`,
    cart,
  };
}

/** Carries out one action within the limits. Returns a short description, or throws a refusal. */
async function act(page, origin, obs, action, shopDomain) {
  const item = action.index != null ? obs.items.find((x) => x.i === action.index) : null;
  if (action.type === 'goto') {
    let u;
    try { u = new URL(action.path || '', origin); } catch { throw new Error('not a page address'); }
    if (u.origin !== origin) throw new Error(`refused to leave the store (${u.host})`);
    if (/\/(account|admin|password)\b/.test(u.pathname)) throw new Error('refused to open account or admin pages');
    await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return `opened ${u.pathname}`;
  }
  if (!item) throw new Error('there is no element with that number');
  if (FORBIDDEN.test(item.text)) throw new Error(`refused to press "${item.text}"`);
  const loc = page.locator(`[data-tharam-i="${item.i}"]`).first();
  if (action.type === 'select') {
    if (item.kind !== 'list') throw new Error('that element is not a list of options');
    await loc.selectOption({ label: action.value || '' }, { timeout: 5000 });
    return `chose "${action.value}" in "${item.text}"`;
  }
  if (action.type === 'click') {
    if (item.kind === 'list') throw new Error('use select to choose an option');
    if (item.href) {
      let u = null;
      try { u = new URL(item.href, page.url()); } catch {}
      if (u && /^https?:$/.test(u.protocol) && !onStore(u.href, origin, shopDomain) && !atCheckout(u.href, origin, shopDomain)) throw new Error(`refused to leave the store (${u.host})`);
    }
    await loc.click({ timeout: 8000 });
    return `clicked ${item.kind} "${item.text}"`;
  }
  throw new Error(`unknown action "${action.type}"`);
}

/**
 * Runs the AI shopper in its own fresh browser window (a first-time visitor) and adds the check `ai.shopper`.
 */
export async function runShopper({ rec, origin, password, shot, shopDomain = '', maxSteps = MAX_STEPS, prime = null }) {
  const title = 'An AI shopper can find a product and reach checkout';
  const ctx = await newContext();
  ctx.setDefaultTimeout(15000);
  let page = null;
  let left = ''; // the other site a page load tried to reach; the run ends there
  let priming = false; // opening a draft's share-preview link may pass through Shopify's preview hosts; that is ours, not the AI's
  // Block every top-level page load (link, form, script, popup) that would leave the store or Shopify's checkout.
  await ctx.route('**/*', (route) => {
    const r = route.request();
    let top = false;
    try { top = r.isNavigationRequest() && !r.frame().parentFrame(); } catch {}
    if (top && !priming && isHttp(r.url()) && !allowedPlace(r.url(), origin, shopDomain)) {
      if (!left) left = hostOf(r.url());
      return route.abort('blockedbyclient').catch(() => {});
    }
    return route.fallback().catch(() => {});
  });
  page = await ctx.newPage();
  ctx.on('page', (p) => { if (p !== page) p.close().catch(() => {}); }); // popups and new tabs are never followed
  const steps = [];
  const friction = [];
  const history = [];
  let outcome = null; // 'checkout' | 'stuck' | 'limit' | 'left' | 'error'
  let reason = '';
  const here = () => { try { return new URL(page.url()).pathname; } catch { return '/'; } };
  const checkoutOpen = async () => atCheckout(page.url(), origin, shopDomain) && looksLikeCheckout(page);
  const offStore = () => left || (isHttp(page.url()) && !allowedPlace(page.url(), origin, shopDomain) ? hostOf(page.url()) : '');
  try {
    // Safe to publish: open the draft theme's preview in this window first, so every page shows the draft.
    if (prime) { priming = true; try { await prime(page); } finally { priming = false; } }
    const g = await gotoStore(page, origin + '/', { password });
    if (g.locked) { rec.add(check('ai.shopper', 'functional', title, 'skip', { severity: 'minor', detail: 'The store is password protected and could not be opened.' })); await ctx.close().catch(() => {}); return null; }
    await settle(page, 600);
    for (let n = 1; n <= Math.min(maxSteps, MAX_STEPS); n++) {
      if (await checkoutOpen()) { outcome = 'checkout'; break; }
      const obs = await observe(page, origin, shopDomain);
      const t0 = Date.now();
      const step = await shopperStep({ goal: GOAL, observation: obs.text, history });
      for (const f of step.friction) if (!friction.some((x) => x.issue === f.issue)) friction.push({ ...f, at: here() });
      const entry = { n, at: here(), thought: step.thought, action: step.action.type, did: '', ms: 0 };
      steps.push(entry);
      if (step.action.type === 'done') {
        if (await checkoutOpen()) { outcome = 'checkout'; break; }
        entry.did = 'said it was done, but checkout was not open';
        history.push(`Said done, but checkout is not open (still on ${entry.at}).`);
        continue;
      }
      if (step.action.type === 'stuck') { outcome = 'stuck'; reason = step.action.reason || step.thought; entry.did = `stuck: ${reason}`; break; }
      try {
        entry.did = await act(page, origin, obs, step.action, shopDomain);
        await settle(page, 700);
      } catch (e) {
        entry.did = `could not: ${shortErr(e)}`;
      }
      entry.ms = Date.now() - t0;
      const gone = offStore();
      if (gone) {
        outcome = 'left';
        reason = gone;
        entry.did = `stopped: this would have left your store for ${gone}`;
        break;
      }
      history.push(`${entry.did} (on ${entry.at})`);
    }
    if (!outcome) outcome = (await checkoutOpen()) ? 'checkout' : 'limit';
    if (outcome === 'checkout') steps.push({ n: steps.length + 1, at: here(), thought: 'Checkout opened. Stopping here, before any details.', action: 'done', did: 'reached checkout', ms: 0 });
  } catch (e) {
    outcome = 'error';
    reason = shortErr(e);
  }
  const screenshot = await shot(page, 'ai-shopper').catch(() => null);
  // Leave nothing behind: empty the cart on the store itself, wherever the shopper ended (checkout can be on Shopify's host).
  if (!onStore(page.url(), origin, shopDomain) || new URL(page.url()).origin !== origin) await page.goto(origin + '/cart', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.evaluate(() => fetch('/cart/clear.js', { method: 'POST', credentials: 'same-origin' })).catch(() => {});
  await ctx.close().catch(() => {});

  if (outcome === 'error') {
    rec.add(check('ai.shopper', 'functional', title, 'skip', { severity: 'minor', detail: `The AI shopper did not run: ${reason}` }));
    return { outcome, steps, friction };
  }
  const serious = friction.filter((f) => f.severity !== 'minor');
  const status = outcome === 'checkout' ? (serious.length ? 'warn' : 'pass') : 'warn';
  const severity = outcome === 'left' ? 'minor' : 'major';
  const frictionText = friction.length ? ` It noticed: ${friction.slice(0, 3).map((f) => f.issue).join('; ')}.` : '';
  const detail = outcome === 'checkout'
    ? `Starting from your homepage with no help, an AI shopper reached checkout in ${plural(steps.length - 1, 'step')}.${frictionText}`
    : outcome === 'left'
      ? `An AI shopper stopped on ${steps.at(-1)?.at || 'your store'}: the next step would have taken it to another site (${reason}). It never follows a store off its own address, so it did not finish. If that link or button belongs on your store, check where it sends your customers.${frictionText}`
      : outcome === 'stuck'
      ? `An AI shopper got stuck on ${steps.at(-1)?.at || 'your store'} after ${plural(steps.length, 'step')}: ${reason}.${frictionText}`
      : `An AI shopper did not reach checkout within ${plural(MAX_STEPS, 'step')}; it ended on ${steps.at(-1)?.at || 'your store'}.${frictionText}`;
  rec.add(check('ai.shopper', 'functional', title, status, {
    severity,
    detail,
    fix: status === 'pass' ? '' : 'Follow the steps below on your own store, the way a new customer would. Where the shopper got stuck is usually where real customers give up too: a button that does nothing, a popup in the way, or no clear path to the cart.',
    evidence: { screenshot, agent: { outcome, steps, friction } },
  }));
  return { outcome, steps, friction };
}
