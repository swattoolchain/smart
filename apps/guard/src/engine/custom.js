/**
 * Your tests (the engine side): the file format, its checks, and the step runner. No database here;
 * saving and versions live in src/custom-tests.js.
 *
 * Nothing the owner uploads is run as code. A file is a list of tests; each test is a list of steps from a
 * fixed step library (open, click, fill, add to cart, expect ...). Our own step runner carries them out in the
 * same test browser as the shopping journey, on the store's own address only, and stops before payment.
 */
import { parseYaml } from '../yaml-lite.js';
import { newContext, gotoStore, settle } from './browser.js';
import { discover } from './discover.js';
import { check, shortErr } from './checks.js';
import { ATC_SELECTORS } from './functional.js';

/** Hard limits, whatever the plan. */
export const MAX_STEPS = 25;
export const TEST_TIME_MS = 60 * 1000;
/** All of a store's tests together, in one scheduled check (the whole check is stopped at 6 minutes). */
export const RUN_BUDGET_MS = 150 * 1000;
export const MAX_FILE_BYTES = 100 * 1024;

// ---------- The file format ----------

const SEVERITIES = ['critical', 'major', 'minor'];
const RUNS = ['journeys', 'full'];
const DEVICES = ['desktop', 'mobile'];
const PLACEHOLDERS = ['product', 'product_handle', 'product_title', 'variant', 'price', 'store'];

/**
 * The step library. `arg` is what the step's own value is:
 *   target: what to find on the page; path: a page of the store; number; text; flag (true); range (a number, or {min, max, equals}).
 * `need`/`opt`: other fields the step takes.
 */
export const STEPS = {
  open: { arg: 'path', say: (s) => `Open ${s.open}` },
  click: { arg: 'target', say: (s) => `Click ${say(s.click)}` },
  fill: { arg: 'target', need: ['value'], say: (s) => `Type “${s.value}” into ${say(s.fill)}` },
  choose: { arg: 'target', need: ['option'], say: (s) => `Choose “${s.option}” in ${say(s.choose)}` },
  quantity: { arg: 'number', say: (s) => `Set quantity to ${s.quantity}` },
  add_to_cart: { arg: 'flag', say: () => 'Click Add to cart' },
  open_cart: { arg: 'flag', say: () => 'Open the cart' },
  checkout: { arg: 'flag', say: () => 'Go to checkout (stops before payment)' },
  wait_for: { arg: 'target', opt: ['timeout'], say: (s) => `Wait for ${say(s.wait_for)}` },
  expect_visible: { arg: 'target', say: (s) => `Check ${say(s.expect_visible)} is showing` },
  expect_hidden: { arg: 'target', say: (s) => `Check ${say(s.expect_hidden)} is not showing` },
  expect_text: { arg: 'target', need: ['contains'], say: (s) => `Check ${say(s.expect_text)} says “${s.contains}”` },
  expect_price: { arg: 'target', range: true, say: (s) => `Check the price in ${say(s.expect_price)} is ${rangeSay(s)}` },
  expect_count: { arg: 'target', range: true, say: (s) => `Check there are ${rangeSay(s)} of ${say(s.expect_count)}` },
  expect_url: { arg: 'text', say: (s) => `Check the address contains “${s.expect_url}”` },
  expect_cart_total: { arg: 'range', say: (s) => `Check the cart total is ${rangeSay(rangeOf(s.expect_cart_total))}` },
  expect_cart_items: { arg: 'range', say: (s) => { const r = rangeOf(s.expect_cart_items); return `Check the cart has ${rangeSay(r)} item${r.equals === 1 ? '' : 's'}`; } },
  expect_no_errors: { arg: 'flag', say: () => 'Check there were no script errors' },
};
const OPTIONS = ['value', 'option', 'contains', 'equals', 'min', 'max', 'timeout'];

function say(target) {
  if (!target) return 'the page';
  if (target.text) return `the text “${target.text}”`;
  if (target.role) return `the ${target.role}${target.name ? ` “${target.name}”` : ''}`;
  return `“${target.css}”`;
}
const rangeOf = (v) => (typeof v === 'number' ? { equals: v } : v || {});
function rangeSay(r) {
  if (r.equals != null) return String(r.equals);
  if (r.min != null && r.max != null) return r.min === r.max ? String(r.min) : `between ${r.min} and ${r.max}`;
  if (r.min != null) return `at least ${r.min}`;
  return `at most ${r.max}`;
}

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'test';
/** The check id a test reports under. */
export const checkIdOf = (name) => `custom.${slug(name)}`;

/** Reads the owner's file text as JSON or YAML. Returns { doc, format } or throws a plain message. */
export function readFile(text, format) {
  const s = String(text ?? '');
  if (!s.trim()) throw new Error('The file is empty. Add at least one test.');
  if (Buffer.byteLength(s) > MAX_FILE_BYTES) throw new Error(`The file is larger than ${MAX_FILE_BYTES / 1024} KB. Split it into fewer, shorter tests.`);
  const looksJson = /^\s*[[{]/.test(s);
  if (format === 'json' || (!format && looksJson)) {
    try { return { doc: JSON.parse(s), format: 'json' }; } catch (e) {
      if (format === 'json') throw new Error(`The file is not valid JSON: ${shortErr(e)}`);
    }
  }
  try { return { doc: parseYaml(s), format: 'yaml' }; } catch (e) { throw new Error(`The file could not be read: ${e.message}`); }
}

function targetOf(v) {
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    if (/^text=/i.test(t)) return t.slice(5).trim() ? { text: t.slice(5).trim() } : null;
    if (/^role=/i.test(t)) { const [role, ...name] = t.slice(5).split(':'); return role.trim() ? { role: role.trim().toLowerCase(), name: name.join(':').trim() || undefined } : null; }
    return { css: t };
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (typeof v.css === 'string' && v.css.trim()) return { css: v.css.trim() };
    if (typeof v.text === 'string' && v.text.trim()) return { text: v.text.trim() };
    if (typeof v.role === 'string' && v.role.trim()) return { role: v.role.trim().toLowerCase(), name: typeof v.name === 'string' && v.name.trim() ? v.name.trim() : undefined };
  }
  return null;
}

function placeholderProblems(s) {
  const bad = [...String(s).matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]).filter((p) => !PLACEHOLDERS.includes(p));
  return bad.length ? `“{${bad[0]}}” is not a value we know. You can use ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}` : null;
}

/** Checks one step and returns it normalised, or pushes plain problems. */
function checkStep(raw, where, problems) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`${where}: each step is a line like “click: "#button"”.`); return null; }
  const actions = Object.keys(raw).filter((k) => STEPS[k]);
  const unknown = Object.keys(raw).filter((k) => !STEPS[k] && !OPTIONS.includes(k));
  if (unknown.length) { problems.push(`${where}: “${unknown[0]}” is not a step we know. Steps are: ${Object.keys(STEPS).join(', ')}.`); return null; }
  if (actions.length !== 1) { problems.push(actions.length ? `${where}: one step per line; this one has ${actions.join(' and ')}.` : `${where}: says what to check but not which step it is (for example “click:” or “expect_text:”).`); return null; }
  const name = actions[0];
  const def = STEPS[name];
  const v = raw[name];
  const step = { [name]: v };
  const before = problems.length;
  if (def.arg === 'target') {
    const t = targetOf(v);
    if (!t) problems.push(`${where}: “${name}” needs a target, for example ${name}: "#delivery-check" or ${name}: "text=Check".`);
    else { step[name] = t; const p = placeholderProblems(t.css || t.text || t.name || ''); if (p) problems.push(`${where}: ${p}.`); }
  } else if (def.arg === 'path') {
    const p = typeof v === 'string' ? v.trim() : '';
    if (!p) problems.push(`${where}: “open” needs a page of your store, for example open: "/pages/contact" or open: "{product}".`);
    else if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//')) problems.push(`${where}: tests stay on your own store. Write the page as a path like "/pages/contact", not a full web address.`);
    else if (!p.startsWith('/') && !p.startsWith('{')) problems.push(`${where}: a page starts with “/”, for example "/collections/all".`);
    else { const pp = placeholderProblems(p); if (pp) problems.push(`${where}: ${pp}.`); else step.open = p; }
  } else if (def.arg === 'number') {
    if (!Number.isInteger(v) || v < 1 || v > 999) problems.push(`${where}: “${name}” needs a whole number from 1 to 999.`);
  } else if (def.arg === 'text') {
    if (typeof v !== 'string' || !v.trim()) problems.push(`${where}: “${name}” needs some text to look for.`);
    else step[name] = v.trim();
  } else if (def.arg === 'flag') {
    if (v !== true && v !== null) problems.push(`${where}: write “${name}: true”.`);
    step[name] = true;
  } else if (def.arg === 'range') {
    const r = rangeOf(v);
    if (typeof r !== 'object' || Array.isArray(r) || !rangeOk(r)) problems.push(`${where}: “${name}” needs a number, or a range like { min: 1, max: 3 }.`);
    else step[name] = Object.fromEntries(['equals', 'min', 'max'].filter((k) => r[k] != null).map((k) => [k, r[k]]));
  }
  for (const k of def.need || []) {
    if (raw[k] == null || String(raw[k]).trim() === '') problems.push(`${where}: “${name}” also needs “${k}:”.`);
    else { step[k] = String(raw[k]).slice(0, 500); const p = placeholderProblems(step[k]); if (p) problems.push(`${where}: ${p}.`); }
  }
  if (def.range) {
    const r = { equals: raw.equals, min: raw.min, max: raw.max };
    if (!rangeOk(r)) problems.push(`${where}: “${name}” needs “equals:”, or “min:” and/or “max:” as numbers.`);
    for (const k of ['equals', 'min', 'max']) if (raw[k] != null) step[k] = raw[k];
  }
  if (raw.timeout != null) {
    if (!(def.opt || []).includes('timeout')) problems.push(`${where}: “timeout:” only works with wait_for.`);
    else if (typeof raw.timeout !== 'number' || raw.timeout <= 0 || raw.timeout > 30) problems.push(`${where}: “timeout:” is in seconds, from 1 to 30.`);
    else step.timeout = raw.timeout;
  }
  const extra = OPTIONS.filter((k) => raw[k] != null && !(def.need || []).includes(k) && !(def.range && ['equals', 'min', 'max'].includes(k)) && k !== 'timeout');
  if (extra.length) problems.push(`${where}: “${extra[0]}:” does not go with “${name}”.`);
  return problems.length === before ? step : null;
}
function rangeOk(r) {
  const has = ['equals', 'min', 'max'].filter((k) => r[k] != null);
  if (!has.length) return false;
  if (has.some((k) => typeof r[k] !== 'number' || !Number.isFinite(r[k]))) return false;
  if (r.equals != null && (r.min != null || r.max != null)) return false;
  if (r.min != null && r.max != null && r.min > r.max) return false;
  return true;
}

/**
 * Checks a whole file. Returns { tests, problems }; `tests` is only usable when `problems` is empty.
 * limits: { tests, steps } from the plan (steps never above MAX_STEPS).
 */
export function validate(doc, limits = {}) {
  const maxTests = limits.tests ?? 10;
  const maxSteps = Math.min(limits.steps ?? MAX_STEPS, MAX_STEPS);
  const problems = [];
  const list = Array.isArray(doc) ? doc : doc && typeof doc === 'object' ? doc.tests : undefined;
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    const other = Object.keys(doc).filter((k) => k !== 'tests' && k !== 'version');
    if (other.length) problems.push(`The file starts with “${other[0]}:”. Put your tests under “tests:”.`);
  }
  if (!Array.isArray(list)) return { tests: [], problems: [...problems, 'The file needs a list of tests under “tests:”.'] };
  if (!list.length) return { tests: [], problems: [...problems, 'The file has no tests. Add at least one under “tests:”.'] };
  if (list.length > maxTests) problems.push(`Your plan allows ${maxTests} of your own test${maxTests === 1 ? '' : 's'} per store. This file has ${list.length}.`);
  const tests = [];
  const seen = new Map();
  list.forEach((raw, ti) => {
    const label = `Test ${ti + 1}${raw && typeof raw.name === 'string' && raw.name.trim() ? ` (“${raw.name.trim().slice(0, 60)}”)` : ''}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`${label}: each test needs a name and steps.`); return; }
    const unknown = Object.keys(raw).filter((k) => !['name', 'severity', 'runs', 'device', 'enabled', 'fix', 'steps'].includes(k));
    if (unknown.length) problems.push(`${label}: “${unknown[0]}:” is not a test setting. Settings are name, severity, runs, device, enabled, fix and steps.`);
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) problems.push(`${label}: give the test a name.`);
    else if (name.length > 80) problems.push(`${label}: the name is longer than 80 characters.`);
    else {
      const id = checkIdOf(name);
      if (seen.has(id)) problems.push(`${label}: another test (test ${seen.get(id) + 1}) has the same name.`);
      seen.set(id, ti);
    }
    const severity = raw.severity ?? 'major';
    if (!SEVERITIES.includes(severity)) problems.push(`${label}: severity is critical, major or minor.`);
    const runs = raw.runs ?? 'full';
    if (!RUNS.includes(runs)) problems.push(`${label}: runs is “journeys” (every shopping check) or “full” (the daily full check).`);
    const device = raw.device ?? 'desktop';
    if (!DEVICES.includes(device)) problems.push(`${label}: device is desktop or mobile.`);
    if (raw.enabled != null && typeof raw.enabled !== 'boolean') problems.push(`${label}: enabled is true or false.`);
    if (raw.fix != null && typeof raw.fix !== 'string') problems.push(`${label}: fix is a sentence telling you what to do when the test fails.`);
    const steps = [];
    if (!Array.isArray(raw.steps) || !raw.steps.length) problems.push(`${label}: add at least one step under “steps:”.`);
    else {
      if (raw.steps.length > maxSteps) problems.push(`${label}: has ${raw.steps.length} steps; a test can have at most ${maxSteps}.`);
      raw.steps.slice(0, MAX_STEPS + 5).forEach((s, si) => { const ok = checkStep(s, `${label}, step ${si + 1}`, problems); if (ok) steps.push(ok); });
    }
    tests.push({ name, id: name ? checkIdOf(name) : null, severity, runs, device, enabled: raw.enabled !== false, fix: typeof raw.fix === 'string' ? raw.fix.trim().slice(0, 300) : '', steps });
  });
  return { tests, problems: problems.slice(0, 50) };
}

/** Plain description of a step, for trails and reports. */
export function describeStep(step) {
  const name = Object.keys(STEPS).find((k) => k in step);
  return STEPS[name].say(step);
}

// ---------- Running ----------

const CHECKOUT_HOSTS = /(^|\.)checkout\.shopify\.com$|(^|\.)shop\.app$/;
const ATC = [...ATC_SELECTORS, 'button.single_add_to_cart_button', '.add_to_cart_button'];

function fillPlaceholders(s, vars) {
  return String(s).replace(/\{([a-z_]+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}
function varsOf(info, origin) {
  const p = info?.products?.[0];
  const v = p?.variants?.[0];
  return { product: p ? `/products/${p.handle}` : null, product_handle: p?.handle ?? null, product_title: p?.title ?? null, variant: v?.id ?? null, price: v?.price != null ? String(v.price) : null, store: new URL(origin).host };
}
function locate(page, t, vars) {
  if (t.text) return page.getByText(fillPlaceholders(t.text, vars));
  if (t.role) return page.getByRole(t.role, t.name ? { name: fillPlaceholders(t.name, vars) } : {});
  return page.locator(fillPlaceholders(t.css, vars));
}

/** Reads a price like "₹1,499.00", "1.499,00 €" or "Rs. 999" as a number. */
export function parsePrice(text) {
  const m = /\d[\d.,\s  ']*/.exec(String(text || ''));
  if (!m) return null;
  let s = m[0].replace(/[\s  ']/g, '').replace(/[.,]$/, '');
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) s = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  else if (lastComma !== -1) s = /,\d{1,2}$/.test(s) && (s.match(/,/g) || []).length === 1 ? s.replace(',', '.') : s.replace(/,/g, '');
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function inRange(n, r) {
  if (n == null) return false;
  if (r.equals != null) return Math.abs(n - r.equals) < 0.005;
  return (r.min == null || n >= r.min) && (r.max == null || n <= r.max);
}

/** The cart, from Shopify's cart API or WooCommerce's Store API: { items, total } in the store's currency. */
async function readCart(page) {
  return page.evaluate(async () => {
    const get = async (u) => { const r = await fetch(u, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }); if (!r.ok) return null; try { return await r.json(); } catch { return null; } };
    const s = await get('/cart.js');
    if (s && typeof s.item_count === 'number') return { items: s.item_count, total: s.total_price / 100 };
    const w = await get('/wp-json/wc/store/v1/cart');
    if (w && w.totals) return { items: w.items_count ?? (w.items || []).reduce((n, i) => n + i.quantity, 0), total: Number(w.totals.total_price) / 10 ** (w.totals.currency_minor_unit ?? 2) };
    return null;
  }).catch(() => null);
}

class StepError extends Error {}
const no = (msg) => { throw new StepError(msg); };

async function runStep(page, step, ctx) {
  const { origin, password, vars, errors } = ctx;
  const name = Object.keys(STEPS).find((k) => k in step);
  const t = step[name];
  const q = (target) => locate(page, target, vars).first();
  const visible = async (target, ms = 5000) => {
    try { await q(target).waitFor({ state: 'visible', timeout: ms }); } catch { no(`we couldn't find ${say(target)} on the page`); }
  };
  switch (name) {
    case 'open': {
      const p = fillPlaceholders(t, vars);
      if (/\{[a-z_]+\}/.test(p)) no('the store has no product we could use for {product}');
      if (!p.startsWith('/') || p.startsWith('//')) no('tests stay on your own store');
      const r = await gotoStore(page, origin + p, { password });
      if (r.locked) no(r.wrongPassword ? 'the storefront password we have does not open your store' : 'your store is password protected; add the storefront password in Store settings');
      const st = r.res?.status?.() || 0;
      if (st >= 400) no(`the page answered with an error (${st})`);
      await settle(page, 500);
      return;
    }
    case 'click':
      await visible(t);
      await q(t).click({ timeout: 8000 }).catch((e) => no(`${say(t)} could not be clicked (${/intercept|cover/i.test(e.message) ? 'something is covering it' : 'it is not clickable'})`));
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(400);
      return;
    case 'fill':
      await visible(t);
      await q(t).fill(fillPlaceholders(step.value, vars), { timeout: 8000 }).catch(() => no(`${say(t)} is not a box we can type into`));
      return;
    case 'choose': {
      await visible(t);
      const opt = fillPlaceholders(step.option, vars);
      const el = q(t);
      const tag = await el.evaluate((e) => e.tagName).catch(() => '');
      if (tag === 'SELECT') {
        const ok = await el.selectOption({ label: opt }, { timeout: 5000 }).then(() => true).catch(() => el.selectOption(opt, { timeout: 5000 }).then(() => true).catch(() => false));
        if (!ok) no(`“${opt}” is not one of the choices in ${say(t)}`);
      } else {
        await el.click({ timeout: 5000 }).catch(() => {});
        const o = page.getByText(opt, { exact: true }).first();
        if (!(await o.isVisible().catch(() => false))) no(`“${opt}” is not one of the choices in ${say(t)}`);
        await o.click({ timeout: 5000 }).catch(() => no(`“${opt}” could not be chosen`));
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(400);
      return;
    }
    case 'quantity': {
      const box = page.locator('input[name="quantity"], input.qty, input[name="qty"]').first();
      if (!(await box.isVisible().catch(() => false))) no('there is no quantity box on this page');
      await box.fill(String(t), { timeout: 5000 }).catch(() => no('the quantity box could not be changed'));
      return;
    }
    case 'add_to_cart': {
      let btn = null;
      for (const sel of ATC) { const l = page.locator(sel).first(); if (await l.isVisible().catch(() => false)) { btn = l; break; } }
      if (!btn) no('there is no Add to cart button on this page');
      if (!(await btn.isEnabled().catch(() => false))) no('the Add to cart button is switched off (sold out or an option is missing)');
      ctx.addedToCart = true;
      await btn.click({ timeout: 8000 }).catch(() => no('the Add to cart button could not be clicked'));
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);
      return;
    }
    case 'open_cart': {
      const r = await gotoStore(page, origin + '/cart', { password });
      if ((r.res?.status?.() || 0) >= 400) no(`the cart page answered with an error (${r.res.status()})`);
      await settle(page, 400);
      return;
    }
    case 'checkout': {
      if (!/\/cart/.test(new URL(page.url()).pathname)) await gotoStore(page, origin + '/cart', { password }).catch(() => {});
      const btn = page.locator('button[name="checkout"], input[name="checkout"], a[href*="/checkout"], a.checkout-button').first();
      if (await btn.isVisible().catch(() => false)) {
        await Promise.all([page.waitForURL(/checkout/, { timeout: 20000 }).catch(() => {}), btn.click({ timeout: 8000 }).catch(() => {})]);
      }
      if (!/checkout/.test(page.url())) await page.goto(origin + '/checkout', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      if (!/checkout/.test(page.url())) no('checkout did not open');
      await settle(page, 500);
      return;
    }
    case 'wait_for':
      await visible(t, Math.round((step.timeout || 10) * 1000));
      return;
    case 'expect_visible':
      return visible(t);
    case 'expect_hidden':
      try { await q(t).waitFor({ state: 'hidden', timeout: 5000 }); } catch { no(`${say(t)} is still showing`); }
      return;
    case 'expect_text': {
      await visible(t);
      const want = fillPlaceholders(step.contains, vars);
      const got = ((await q(t).innerText({ timeout: 5000 }).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!got.toLowerCase().includes(want.toLowerCase())) no(`${say(t)} says “${got.slice(0, 120) || '(nothing)'}”, not “${want}”`);
      return;
    }
    case 'expect_price': {
      await visible(t);
      const txt = (await q(t).innerText({ timeout: 5000 }).catch(() => '')) || '';
      const n = parsePrice(txt);
      if (n == null) no(`${say(t)} does not show a price (it says “${txt.trim().slice(0, 80)}”)`);
      if (!inRange(n, step)) no(`the price shows ${n}, but it should be ${rangeSay(step)}`);
      return;
    }
    case 'expect_count': {
      const n = await locate(page, t, vars).count().catch(() => 0);
      if (!inRange(n, step)) no(`we found ${n} of ${say(t)}, but there should be ${rangeSay(step)}`);
      return;
    }
    case 'expect_url': {
      const want = fillPlaceholders(t, vars);
      if (!page.url().includes(want)) no(`the address is ${page.url().replace(origin, '') || '/'}, which does not contain “${want}”`);
      return;
    }
    case 'expect_cart_total':
    case 'expect_cart_items': {
      const cart = await readCart(page);
      if (!cart) no('we could not read the cart on this store');
      const n = name === 'expect_cart_total' ? cart.total : cart.items;
      if (!inRange(n, t)) no(name === 'expect_cart_total' ? `the cart total is ${n}, but it should be ${rangeSay(t)}` : `the cart has ${n} item${n === 1 ? '' : 's'}, but it should have ${rangeSay(t)}`);
      return;
    }
    case 'expect_no_errors':
      if (errors.length) no(`${errors.length} script error${errors.length === 1 ? '' : 's'} happened, the first: “${errors[0]}”`);
      return;
    default:
      no('this step is not supported');
  }
}

/** True when the page is still on the store (or on Shopify's own checkout). */
function onStore(page, origin) {
  let u;
  try { u = new URL(page.url()); } catch { return true; }
  if (u.protocol === 'about:') return true;
  const host = new URL(origin).host;
  return u.host === host || CHECKOUT_HOSTS.test(u.hostname);
}

/**
 * Runs one test in a fresh browser window on the store.
 * Returns { status: 'pass'|'fail', message, failedStep, trail: [{ n, text, status, ms, error?, image? }], screenshot? }.
 * trail images (JPEG data URLs) are added when `images` is true (for "Try it now").
 */
export async function runTest(test, { origin, password, info = null, testProduct = null, shot = null, images = false, timeMs = TEST_TIME_MS } = {}) {
  const ctx = await newContext({ mobile: test.device === 'mobile' });
  ctx.setDefaultTimeout(10000);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(shortErr(e)));
  const trail = [];
  const started = Date.now();
  let timer;
  let timedOut = false;
  const state = { origin, password, vars: {}, errors, addedToCart: false };
  const out = { status: 'pass', message: '', failedStep: null, trail, screenshot: null };
  const work = (async () => {
    if (!info) info = await discover(ctx.request, origin, { testProduct }).catch(() => ({ products: [] }));
    state.vars = varsOf(info, origin);
    for (const [i, step] of test.steps.entries()) {
      if (timedOut) return;
      const t0 = Date.now();
      const row = { n: i + 1, text: fillPlaceholders(describeStep(step), state.vars), status: 'pass', ms: 0 };
      trail.push(row);
      try {
        await runStep(page, step, state);
        if (!onStore(page, origin)) no(`it left your store and opened ${new URL(page.url()).host}. Tests stay on your own store`);
      } catch (e) {
        row.status = 'fail';
        row.error = timedOut ? `the test took longer than ${Math.round(timeMs / 1000)} seconds` : e instanceof StepError ? e.message : `something went wrong (${shortErr(e)})`;
      }
      if (timedOut) return;
      row.ms = Date.now() - t0;
      if (images) row.image = await page.screenshot({ type: 'jpeg', quality: 45 }).then((b) => `data:image/jpeg;base64,${b.toString('base64')}`).catch(() => null);
      if (row.status === 'fail') {
        out.status = 'fail';
        out.failedStep = row.n;
        out.message = `Step ${row.n} (${row.text}): ${row.error}.`;
        if (shot) out.screenshot = await shot(page, `yours-${checkIdOf(test.name).slice(7)}`).catch(() => null);
        break;
      }
    }
  })();
  try {
    await Promise.race([work, new Promise((_, rej) => (timer = setTimeout(() => { timedOut = true; rej(new StepError('timeout')); }, timeMs)))]);
  } catch {
    if (timedOut) {
      out.status = 'fail';
      const last = trail.at(-1);
      out.failedStep = last ? last.n : 1;
      if (last) { last.status = 'fail'; last.error = `the test took longer than ${Math.round(timeMs / 1000)} seconds`; }
      out.message = `${last ? `Step ${last.n} (${last.text})` : 'The test'}: it took longer than ${Math.round(timeMs / 1000)} seconds in total, so we stopped it.`;
      if (shot) out.screenshot = await shot(page, `yours-${checkIdOf(test.name).slice(7)}`).catch(() => null);
    }
  } finally {
    clearTimeout(timer);
    // Leave nothing in the store's cart.
    if (state.addedToCart) await page.evaluate(() => fetch('/cart/clear.js', { method: 'POST', credentials: 'same-origin' })).catch(() => {});
    await ctx.close().catch(() => {});
  }
  out.ms = Date.now() - started;
  return out;
}

/** Runs a store's tests inside a check and records one result per test under "Your tests". */
export async function runCustomTests({ rec, tests, origin, password, info, shot, budgetMs = RUN_BUDGET_MS }) {
  const until = Date.now() + budgetMs;
  for (const test of tests) {
    const left = until - Date.now();
    if (left < 5000) {
      rec.add(check(test.id, 'custom', test.name, 'skip', { severity: test.severity, detail: `Not run this time: your tests had used their ${Math.round(budgetMs / 1000)} seconds for this check. Shorter tests, or fewer tests on every shopping check, leave room for all of them.` }));
      continue;
    }
    rec.step(`Your test: ${test.name}`);
    const r = await runTest(test, { origin, password, info, shot, timeMs: Math.min(TEST_TIME_MS, left) });
    const steps = r.trail.map(({ n, text, status, ms, error }) => ({ n, text, status, ms, ...(error && { error }) }));
    if (r.status === 'pass') {
      rec.add(check(test.id, 'custom', test.name, 'pass', { severity: test.severity, detail: `All ${test.steps.length} step${test.steps.length === 1 ? '' : 's'} worked (${(r.ms / 1000).toFixed(1)} s).`, evidence: { steps } }));
    } else {
      rec.add(check(test.id, 'custom', test.name, 'fail', {
        severity: test.severity, detail: r.message,
        evidence: { screenshot: r.screenshot, steps },
        fix: test.fix || 'If your store changed on purpose, update this test under Your tests. Otherwise, check what changed on that page.',
      }));
    }
  }
}
