/**
 * Script watch, part 2 (security S1): scripts from outside sites that read what shoppers type.
 *
 * On product and cart pages, an init script watches the store's own form fields that hold personal or payment
 * details (email, phone, address, name, card fields). It records which outside script
 *   - reads such a field's value (input.value, new FormData(form)), or
 *   - listens to typing in such a field (input, change, key and blur listeners on the field),
 * using the calling script's address from the call stack. To see what such a script does with the data, it
 * then puts a made-up marker (never real data, never a password) into each empty field and fires the usual
 * events, and watches whether the marker leaves for an outside site. No form is ever submitted.
 *
 * The store's own scripts and Shopify's are never reported; well-known services that legitimately read form
 * fields (analytics, email marketing, payments) are listed in FORM_SERVICES and are not reported either,
 * unless they send the marker somewhere unexpected.
 */
import crypto from 'node:crypto';
import { pageKind, isBadHost } from './scripts.js';
import { check, plural } from './checks.js';

/** Services that read or listen to form fields as part of what they do. Extra ones: FORM_SERVICES env (comma separated). */
const FORM_SERVICES = [
  'shopify.com', 'shopifycdn.com', 'shopifysvc.com', 'shop.app', 'shopifycloud.com',
  'google-analytics.com', 'googletagmanager.com', 'google.com', 'gstatic.com', 'doubleclick.net', 'googleadservices.com',
  'facebook.net', 'facebook.com', 'clarity.ms', 'hotjar.com', 'hotjar.io', 'tiktok.com', 'pinimg.com', 'snapchat.com',
  'klaviyo.com', 'omnisend.com', 'privy.com', 'attn.tv', 'attentivemobile.com', 'mailchimp.com', 'list-manage.com',
  'paypal.com', 'paypalobjects.com', 'stripe.com', 'stripe.network', 'razorpay.com', 'judge.me', 'okendo.io', 'yotpo.com',
];
export function isFormService(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  const extra = String(process.env.FORM_SERVICES || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  return [...FORM_SERVICES, ...extra].some((d) => h === d || h.endsWith('.' + d));
}

/** Field names, ids, autocomplete hints and labels that hold personal or payment details. */
export const FIELD_PATTERN = 'e-?mail|phone|mobile|\\btel\\b|address|street|city|zip|postal|pin.?code|card|\\bcc-|ccnum|cvv|cvc|csc|expir|security.?code|first.?name|last.?name|full.?name|given-name|family-name';

const PAGES = { product: 'product page', cart: 'cart page' };

// Runs in the page before any of its own scripts. Kept dependency-free: it is serialised into the browser.
function init({ marker, email, pattern }) {
  const kind = /^\/(collections\/[^/]+\/)?products\/[^/]+\/?$/.test(location.pathname) ? 'product' : /^\/cart\/?$/.test(location.pathname) ? 'cart' : null;
  if (!kind) return;
  const re = new RegExp(pattern, 'i');
  const SKIP = ['hidden', 'submit', 'button', 'checkbox', 'radio', 'image', 'reset', 'file', 'range', 'color', 'number', 'search'];
  const isField = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
  const sensitive = (el) => {
    if (!isField(el)) return false;
    const type = String(el.type || '').toLowerCase();
    if (SKIP.includes(type)) return false;
    if (type === 'email' || type === 'tel' || type === 'password') return true;
    return re.test([el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' '));
  };
  const describe = (el) => `${String(el.type || el.tagName).toLowerCase()}${el.name ? ` “${el.name}”` : el.id ? ` #${el.id}` : ''}`;
  const caller = () => {
    const urls = (new Error().stack || '').match(/https?:\/\/[^\s()]+?(?=:\d+:\d+)/g) || [];
    return urls.find((u) => !u.startsWith(location.origin + location.pathname)) || null;
  };
  const seen = new Set();
  const report = (how, el, script) => {
    if (!script) return;
    const key = `${how}|${script}|${describe(el)}`;
    if (seen.has(key)) return;
    seen.add(key);
    try { window.__tharamForm({ how, script, field: describe(el) }); } catch {}
  };
  // Reading a field's value.
  for (const C of [HTMLInputElement, HTMLTextAreaElement]) {
    const d = Object.getOwnPropertyDescriptor(C.prototype, 'value');
    Object.defineProperty(C.prototype, 'value', { ...d, get() { if (sensitive(this)) report('read', this, caller()); return d.get.call(this); } });
  }
  // Reading a whole form at once.
  const FD = window.FormData;
  window.FormData = class FormData extends FD {
    constructor(form, ...rest) {
      if (form && form.elements) { const el = [...form.elements].find(sensitive); if (el) report('read', el, caller()); }
      super(form, ...rest);
    }
  };
  // Listening to typing in a field.
  const add = EventTarget.prototype.addEventListener;
  const TYPES = ['input', 'change', 'keydown', 'keyup', 'keypress', 'blur', 'focusout', 'paste'];
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (TYPES.includes(type) && sensitive(this)) report('listen', this, caller());
    return add.call(this, type, fn, opts);
  };
  for (const C of [HTMLInputElement, HTMLTextAreaElement]) {
    for (const p of ['oninput', 'onchange', 'onkeyup', 'onkeydown', 'onblur']) {
      const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, p);
      if (d) Object.defineProperty(C.prototype, p, { ...d, set(v) { if (sensitive(this)) report('listen', this, caller()); d.set.call(this, v); } });
    }
  }
  // A made-up value in each empty field, with the events a shopper's typing fires. Never a password, never submitted.
  const probe = () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const fields = [...document.querySelectorAll('input')].filter((el) => sensitive(el) && el.type !== 'password' && !el.value && !el.disabled && !el.readOnly).slice(0, 5);
    for (const el of fields) {
      setter.call(el, el.type === 'email' || /mail/i.test(el.name + el.id) ? email : marker);
      for (const t of ['input', 'change']) el.dispatchEvent(new Event(t, { bubbles: true }));
      el.dispatchEvent(new FocusEvent('blur'));
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    }
    try { window.__tharamForm({ how: 'probed', fields: fields.length }); } catch {}
  };
  addEventListener('load', () => setTimeout(probe, 300));
}

/**
 * Starts watching a page. Call before the shopping journey; the returned function gives what was found.
 * Only top-level product and cart pages are watched.
 */
export async function watchForms(page, origin) {
  const storeHost = new URL(origin).host;
  const marker = 'tharam' + crypto.randomBytes(5).toString('hex');
  const email = `${marker}@example.invalid`;
  const variants = [...new Set([marker, email, encodeURIComponent(email), Buffer.from(email).toString('base64'), Buffer.from(marker).toString('base64')])];
  const found = new Map();
  const pages = new Set();
  const own = (host) => host === storeHost || isFormService(host);
  await page.exposeBinding('__tharamForm', (source, r) => {
    let kind;
    try { if (source.frame !== source.page.mainFrame()) return; kind = pageKind(source.frame.url()); } catch { return; }
    if (!PAGES[kind] || !r || typeof r !== 'object') return;
    if (r.how === 'probed') { pages.add(kind); return; }
    let u;
    try { u = new URL(String(r.script)); } catch { return; }
    if (own(u.host) && !isBadHost(u.host)) return;
    const script = `${u.origin}${u.pathname}`;
    const key = `${script}|${kind}`;
    const f = found.get(key) || { script, host: u.host, page: kind, reads: new Set(), listens: new Set(), sentTo: new Set(), bad: isBadHost(u.host) };
    (r.how === 'read' ? f.reads : f.listens).add(String(r.field).slice(0, 80));
    found.set(key, f);
  });
  await page.addInitScript(init, { marker, email, pattern: FIELD_PATTERN });
  const sent = new Map(); // host -> page kind
  page.on('request', (req) => {
    let u;
    try { u = new URL(req.url()); } catch { return; }
    if (u.host === storeHost || !/^https?:$/.test(u.protocol)) return;
    let body = '';
    try { body = req.postData() || ''; } catch {}
    const hay = req.url() + ' ' + body;
    if (!variants.some((v) => hay.includes(v))) return;
    const kind = pageKind(page.url());
    if (!sent.has(u.host)) sent.set(u.host, PAGES[kind] ? kind : 'product');
  });
  return () => {
    const list = [...found.values()];
    // What left for an outside site: tie it to the scripts from that site, or to the scripts that read the field.
    const leaks = [...sent.entries()].filter(([host]) => !isFormService(host) || isBadHost(host)).map(([host, kind]) => ({ host, page: kind }));
    for (const l of leaks) {
      const from = list.filter((f) => f.host === l.host);
      for (const f of from.length ? from : list.filter((f) => f.page === l.page)) f.sentTo.add(l.host);
    }
    return {
      pages: [...pages],
      readers: list.map((f) => ({ script: f.script, host: f.host, page: f.page, reads: [...f.reads], listens: [...f.listens], sentTo: [...f.sentTo], bad: f.bad })),
      sentTo: leaks,
    };
  };
}

/** The same script on several pages, as one line: its address, the pages and the fields. */
function byScript(readers) {
  const m = new Map();
  for (const r of readers) {
    const e = m.get(r.script) || { script: r.script, pages: [], fields: new Set(), sentTo: new Set() };
    e.pages.push(PAGES[r.page]);
    for (const f of [...r.reads, ...r.listens]) e.fields.add(f);
    for (const h of r.sentTo) e.sentTo.add(h);
    m.set(r.script, e);
  }
  return [...m.values()].map((e) => `${e.script} (${e.pages.join(' and ')}) on ${[...e.fields].join(', ')}`);
}

/** Adds the check and returns what to keep with the run's script record. */
export function formChecks({ rec, found }) {
  if (!found || !found.pages.length) return found || null; // no product or cart page was reached
  const { readers, sentTo } = found;
  const critical = readers.filter((r) => r.sentTo.length || r.bad);
  const name = 'No outside scripts reading what shoppers type';
  if (critical.length || sentTo.length) {
    const hosts = [...new Set([...sentTo.map((s) => s.host), ...critical.flatMap((r) => r.sentTo)])];
    const lines = byScript(critical);
    rec.add(check('sec.scripts.forms', 'security', name, 'fail', {
      severity: 'critical',
      detail: `${lines.length ? `A script reads what shoppers type: ${lines.slice(0, 3).join('; ')}.` : 'Something on your product or cart page reads what shoppers type.'}${hosts.length ? ` What was typed was sent to ${hosts.join(', ')}.` : ' It comes from a site known for stealing card details.'} This is how card and personal-data skimmers work. We typed a made-up test value, never real details.`,
      fix: 'Remove the script now: find the app or theme file that adds it (your apps list, Online Store → Themes → Edit code). Then change your Shopify password, review staff accounts and apps, and contact Shopify support if you did not add it.',
      evidence: { scripts: critical.map((r) => ({ url: r.script, page: r.page, fields: [...new Set([...r.reads, ...r.listens])], sentTo: r.sentTo })), sentTo: hosts },
    }));
  } else if (readers.length) {
    const lines = byScript(readers);
    rec.add(check('sec.scripts.forms', 'security', name, 'fail', {
      severity: 'major',
      detail: `${plural(lines.length, 'script')} from outside sites ${lines.length === 1 ? 'reads or watches' : 'read or watch'} what shoppers type: ${lines.slice(0, 3).join('; ')}${lines.length > 3 ? ', and more' : ''}. We did not see what was typed go anywhere else.`,
      fix: 'If this is an app you use (chat, reviews, email sign-up, analytics), there is nothing to do. If you don’t recognise it, find what adds it (your apps list, Online Store → Themes → Edit code) and remove it.',
      evidence: { scripts: readers.map((r) => ({ url: r.script, page: r.page, fields: [...new Set([...r.reads, ...r.listens])] })) },
    }));
  } else {
    rec.add(check('sec.scripts.forms', 'security', name, 'pass', { severity: 'critical', detail: `Watched the form fields on the ${found.pages.map((p) => PAGES[p]).join(' and ')}: only your store, Shopify and well-known services use them.` }));
  }
  return found;
}
