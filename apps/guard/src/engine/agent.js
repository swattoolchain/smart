/**
 * AI shopper (roadmap 2, part 1): a goal-driven shopper that finds its own way through any theme.
 * Each step it reads the page (address, cart count, a short excerpt, the things it can click or choose),
 * an AI picks the next action, and we carry it out, with hard limits:
 *   - only click, choose an option, or open a page on the same store; it never types anything
 *   - never presses anything that pays or places an order; it stops the moment checkout opens
 *   - at most MAX_STEPS steps per check, then the cart is emptied
 * The result is one check, `ai.shopper`, with every step and the friction it noticed.
 */
import { newContext, gotoStore, settle } from './browser.js';
import { check, shortErr, plural } from './checks.js';
import { shopperStep } from '../ai.js';

export const MAX_STEPS = 12;
export const GOAL = 'Find a product you would buy, add it to the cart, open the cart and go to checkout. Stop when checkout opens.';
// Buttons the shopper must never press, whatever the AI says.
const FORBIDDEN = /\b(pay( now)?|place (my )?order|complete (my )?(order|purchase)|submit order|confirm (order|payment)|log ?in|sign ?in|sign ?up|create account|register|delete|remove all|unsubscribe)\b/i;
export const atCheckout = (url) => { try { const p = new URL(url).pathname; return /^\/checkouts?\b|\/checkout\b|^\/\d+\/checkouts\//.test(p); } catch { return false; } };

/** What the shopper can see: numbered visible links, buttons and option lists, plus a short page excerpt. */
async function observe(page) {
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
  const lines = data.items.map((x) => `[${x.i}] ${x.kind} "${x.text}"${x.href ? ` -> ${x.href}` : ''}${x.options ? ` options: ${x.options.map((o) => `"${o}"`).join(', ')}` : ''}${x.disabled ? ' (disabled)' : ''}`);
  return {
    items: data.items,
    text: `Address: ${new URL(page.url()).pathname}${new URL(page.url()).search}\nPage title: ${data.title}\nItems in cart: ${cart ?? 'unknown'}\nPage text (start): ${data.text}\n\nYou can use:\n${lines.join('\n') || '(nothing clickable)'}`,
    cart,
  };
}

/** Carries out one action within the limits. Returns a short description, or throws a refusal. */
async function act(page, origin, obs, action) {
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
      if (u && /^https?:$/.test(u.protocol) && u.origin !== origin && !atCheckout(u.href)) throw new Error(`refused to leave the store (${u.host})`);
    }
    await loc.click({ timeout: 8000 });
    return `clicked ${item.kind} "${item.text}"`;
  }
  throw new Error(`unknown action "${action.type}"`);
}

/**
 * Runs the AI shopper in its own fresh browser window (a first-time visitor) and adds the check `ai.shopper`.
 */
export async function runShopper({ rec, origin, password, shot, maxSteps = MAX_STEPS }) {
  const title = 'An AI shopper can find a product and reach checkout';
  const ctx = await newContext();
  ctx.setDefaultTimeout(15000);
  const page = await ctx.newPage();
  const steps = [];
  const friction = [];
  const history = [];
  let outcome = null; // 'checkout' | 'stuck' | 'limit' | 'error'
  let reason = '';
  try {
    const g = await gotoStore(page, origin + '/', { password });
    if (g.locked) { rec.add(check('ai.shopper', 'functional', title, 'skip', { severity: 'minor', detail: 'The store is password protected and could not be opened.' })); return null; }
    await settle(page, 600);
    for (let n = 1; n <= Math.min(maxSteps, MAX_STEPS); n++) {
      if (atCheckout(page.url())) { outcome = 'checkout'; break; }
      const obs = await observe(page);
      const t0 = Date.now();
      const step = await shopperStep({ goal: GOAL, observation: obs.text, history });
      for (const f of step.friction) if (!friction.some((x) => x.issue === f.issue)) friction.push({ ...f, at: new URL(page.url()).pathname });
      const entry = { n, at: new URL(page.url()).pathname, thought: step.thought, action: step.action.type, did: '', ms: 0 };
      steps.push(entry);
      if (step.action.type === 'done') {
        if (atCheckout(page.url())) { outcome = 'checkout'; break; }
        entry.did = 'said it was done, but checkout was not open';
        history.push(`Said done, but checkout is not open (still on ${entry.at}).`);
        continue;
      }
      if (step.action.type === 'stuck') { outcome = 'stuck'; reason = step.action.reason || step.thought; entry.did = `stuck: ${reason}`; break; }
      try {
        entry.did = await act(page, origin, obs, step.action);
        await settle(page, 700);
      } catch (e) {
        entry.did = `could not: ${shortErr(e)}`;
      }
      entry.ms = Date.now() - t0;
      history.push(`${entry.did} (on ${entry.at})`);
    }
    if (!outcome) outcome = atCheckout(page.url()) ? 'checkout' : 'limit';
    if (outcome === 'checkout') steps.push({ n: steps.length + 1, at: new URL(page.url()).pathname, thought: 'Checkout opened. Stopping here, before any details.', action: 'done', did: 'reached checkout', ms: 0 });
  } catch (e) {
    outcome = 'error';
    reason = shortErr(e);
  }
  const screenshot = await shot(page, 'ai-shopper').catch(() => null);
  // Leave nothing behind.
  await page.evaluate(() => fetch('/cart/clear.js', { method: 'POST', credentials: 'same-origin' })).catch(() => {});
  await ctx.close().catch(() => {});

  if (outcome === 'error') {
    rec.add(check('ai.shopper', 'functional', title, 'skip', { severity: 'minor', detail: `The AI shopper did not run: ${reason}` }));
    return { outcome, steps, friction };
  }
  const serious = friction.filter((f) => f.severity !== 'minor');
  const status = outcome === 'checkout' ? (serious.length ? 'warn' : 'pass') : 'warn';
  const frictionText = friction.length ? ` It noticed: ${friction.slice(0, 3).map((f) => f.issue).join('; ')}.` : '';
  const detail = outcome === 'checkout'
    ? `Starting from your homepage with no help, an AI shopper reached checkout in ${plural(steps.length - 1, 'step')}.${frictionText}`
    : outcome === 'stuck'
      ? `An AI shopper got stuck on ${steps.at(-1)?.at || 'your store'} after ${plural(steps.length, 'step')}: ${reason}.${frictionText}`
      : `An AI shopper did not reach checkout within ${plural(MAX_STEPS, 'step')}; it ended on ${steps.at(-1)?.at || 'your store'}.${frictionText}`;
  rec.add(check('ai.shopper', 'functional', title, status, {
    severity: 'major',
    detail,
    fix: status === 'pass' ? '' : 'Follow the steps below on your own store, the way a new customer would. Where the shopper got stuck is usually where real customers give up too: a button that does nothing, a popup in the way, or no clear path to the cart.',
    evidence: { screenshot, agent: { outcome, steps, friction } },
  }));
  return { outcome, steps, friction };
}
