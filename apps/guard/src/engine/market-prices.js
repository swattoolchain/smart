/**
 * Prices by country and currency (Pricing 5). Storefront only: no Shopify Markets permission is needed.
 * For each country the store sells in (Store settings → Where you sell), we switch the storefront to that
 * country the way a shopper does with the country picker (Shopify's localization form), then read the price
 * on the product page, in the cart (cart.js) and at checkout before payment. We flag:
 *  - a currency that changes between the product page, cart and checkout, or an amount that goes up,
 *  - a price that doesn't follow the owner's rounding rule (for example "ends in .99"),
 *  - a price far from the converted price in the store's own currency (owner's tolerance, in %),
 *  - a country where the product can't be bought (the cart refuses it or checkout doesn't open).
 * Nothing is bought; the cart is emptied and the store is switched back to its own country.
 */
import { check, shortErr } from './checks.js';
import { money, toMinor, pagePrice, checkoutSubtotal } from './pricing.js';

export const CHECK_ID = 'fn.price.markets';
/** The country a shopper picks for each Tharam market. Other EU countries: France stands for them. */
export const MARKET_COUNTRY = { US: 'US', DE: 'DE', AT: 'AT', EU: 'FR', UK: 'GB', IN: 'IN', SG: 'SG', AU: 'AU', CA: 'CA', AE: 'AE' };
export const ROUNDING = { none: null, '99': 99, '95': 95, '00': 0 };
const MAX_MARKETS = 6;

/** Validates Test suite → Price rules → Prices by country. Throws an Error with a plain message. */
export function cleanMarketPrices(input) {
  if (input == null || input === false) return null;
  if (typeof input !== 'object') throw new Error('Prices by country must be a setting.');
  if (input.enabled === false) return { enabled: false, product: null, variant: null, rounding: 'none', tolerance: 10 };
  let product = String(input.product || '').trim();
  const m = /\/products\/([^/?#]+)/.exec(product);
  if (m) product = decodeURIComponent(m[1]);
  product = product.toLowerCase();
  if (product && !/^[a-z0-9][a-z0-9_-]{0,199}$/i.test(product)) throw new Error(`“${input.product}” is not a product. Use the product's link or its handle, like cotton-kurta, or leave it empty to use your test product.`);
  const rounding = String(input.rounding ?? 'none');
  if (!(rounding in ROUNDING)) throw new Error('Choose how your prices are rounded in other currencies.');
  const tolerance = input.tolerance === '' || input.tolerance == null ? 10 : Number(input.tolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 50) throw new Error('The allowed difference must be from 0 to 50%. Use 0 to skip this comparison.');
  const variant = input.variant ? String(input.variant).trim().slice(0, 100) : null;
  return { enabled: true, product: product || null, variant, rounding, tolerance };
}

/** Whether a price (minor units) follows the rounding rule: ends in .99, .95 or .00. */
export function followsRounding(minor, rounding) {
  const want = ROUNDING[rounding];
  if (want == null || minor == null) return true;
  return Math.abs(minor) % 100 === want;
}

/**
 * Compares what one country showed. row: { currency, base: { minor, currency }, rate, page: { minor, trusted },
 * cart: { minor, currency } | null, checkout: { minor, currencyOk } | null, refused, noCheckout }.
 * Returns a list of problems: { level: 'fail'|'warn', key, text }.
 */
export function judgeMarket(row, { rounding = 'none', tolerance = 10, shopCurrency = null } = {}) {
  const out = [];
  const m = (x, c = row.currency) => money(x, c);
  if (row.refused) out.push({ level: 'fail', key: 'buy', text: 'the product can\'t be added to the cart' });
  else if (row.noCheckout) out.push({ level: 'fail', key: 'buy', text: 'checkout does not open' });
  if (row.cart && row.currency && row.cart.currency && row.cart.currency !== row.currency) out.push({ level: 'fail', key: 'currency', text: `the product page shows ${row.currency} but the cart charges in ${row.cart.currency}` });
  else if (row.cart && row.page?.trusted && row.cart.minor > row.page.minor + 1) out.push({ level: 'fail', key: 'amount', text: `the product page shows ${m(row.page.minor)} but the cart asks for ${m(row.cart.minor)}` });
  if (row.checkout && row.checkout.currencyOk === false) out.push({ level: 'fail', key: 'currency', text: `checkout does not show prices in ${row.cart?.currency || row.currency}` });
  else if (row.checkout && row.cart && row.checkout.minor > row.cart.minor + 1) out.push({ level: 'fail', key: 'amount', text: `checkout asks for ${m(row.checkout.minor)} while the cart showed ${m(row.cart.minor)}` });
  const price = row.cart?.minor ?? row.page?.minor;
  const foreign = row.currency && shopCurrency && row.currency !== shopCurrency;
  if (foreign && price != null && !followsRounding(price, rounding)) out.push({ level: 'warn', key: 'rounding', text: `${m(price)} does not end in .${rounding}` });
  if (foreign && tolerance > 0 && price != null && row.rate > 0 && row.base?.minor != null) {
    const converted = Math.round(row.base.minor * row.rate);
    const diff = Math.round((Math.abs(price - converted) / converted) * 100);
    if (diff > tolerance) out.push({ level: 'warn', key: 'far', text: `${m(price)} is ${diff}% ${price > converted ? 'more' : 'less'} than your ${m(row.base.minor, shopCurrency)} converted (about ${m(converted)})` });
  }
  return out;
}

async function api(page, path, body) {
  return page.evaluate(async ([path, body]) => {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) } : { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    let j = null;
    try { j = await r.json(); } catch {}
    return { status: r.status, json: j };
  }, [path, body]).catch((e) => ({ status: 0, error: String(e) }));
}

/** Shopify's own view of the country and currency on the page (window.Shopify), when the theme exposes it. */
const shopifyState = (page) => page.evaluate(() => ({ country: window.Shopify?.country || null, currency: window.Shopify?.currency?.active || null, rate: Number(window.Shopify?.currency?.rate) || null })).catch(() => ({}));

/** Switches the storefront to a country like the country picker does. Returns { ok, country, currency, rate }. */
export async function switchCountry(page, origin, country) {
  const status = await page.evaluate(async (cc) => {
    const body = new URLSearchParams({ form_type: 'localization', utf8: '✓', _method: 'put', country_code: cc, return_to: '/' });
    const r = await fetch('/localization', { method: 'POST', body, credentials: 'same-origin', redirect: 'follow' });
    return r.status;
  }, country).catch(() => 0);
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  const now = await shopifyState(page);
  const cart = (await api(page, '/cart.js')).json;
  // The theme says which country is shown; when it doesn't, a successful form post is taken as the switch.
  const ok = now.country ? now.country === country : status > 0 && status < 400;
  return { ok, country: now.country || (ok ? country : null), currency: now.currency || cart?.currency || null, rate: now.rate };
}

/** Does the checkout text show this currency (its code or its symbol)? */
function showsCurrency(text, cur) {
  if (!text || !cur) return null;
  if (text.includes(cur)) return true;
  const marks = new Set();
  for (const display of ['symbol', 'narrowSymbol']) {
    try { const s = new Intl.NumberFormat('en', { style: 'currency', currency: cur, currencyDisplay: display }).formatToParts(1).find((p) => p.type === 'currency')?.value; if (s) marks.add(s); } catch {}
  }
  if (cur === 'INR') marks.add('Rs');
  return [...marks].some((s) => text.includes(s));
}

/**
 * One check with a table of countries. markets: Tharam market codes (cfg.markets); settings: cleanMarketPrices output;
 * product: the handle to use when the owner named none (the test product).
 */
export async function runMarketPrices({ page, rec, origin, markets, settings, product: fallback }) {
  const title = 'Prices in each country';
  const handle = settings?.product || fallback;
  if (!markets?.length || !handle) return;
  rec.step(`Check prices in ${markets.length} ${markets.length === 1 ? 'country' : 'countries'}`);
  let home = null;
  try {
    if (!page.url().startsWith(origin)) await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    home = await shopifyState(page);
    const baseJs = await api(page, `/products/${encodeURIComponent(handle)}.js`);
    if (baseJs.status !== 200 || !baseJs.json?.variants) {
      rec.add(check(CHECK_ID, 'functional', title, 'warn', { severity: 'major', detail: `We couldn't find the product “${handle}” on your store, so prices by country weren't checked.`, fix: 'Open Test suite → Price rules → Prices by country and pick the product again, or leave it empty to use your test product.' }));
      return;
    }
    const want = settings?.variant ? String(settings.variant).toLowerCase() : null;
    const pick = (variants) => variants.find((x) => want && (String(x.id) === want || String(x.title).toLowerCase() === want)) || (!want && variants.find((x) => x.available));
    const v0 = pick(baseJs.json.variants);
    if (!v0) {
      rec.add(check(CHECK_ID, 'functional', title, 'warn', { severity: 'major', detail: want ? `“${baseJs.json.title}” has no variant called “${settings.variant}”, so prices by country weren't checked.` : `“${baseJs.json.title}” is sold out, so prices by country weren't checked.` }));
      return;
    }
    const shopCurrency = home?.currency || (await api(page, '/cart.js')).json?.currency || null;
    const base = { minor: toMinor(v0.price, true), currency: shopCurrency };
    const name = `“${baseJs.json.title}”${v0.title && v0.title !== 'Default Title' ? ` (${v0.title})` : ''}`;
    const rows = [];
    for (const market of markets.slice(0, MAX_MARKETS)) {
      const country = MARKET_COUNTRY[market] || market;
      const row = { market, country, currency: null, rate: null, base, page: null, cart: null, checkout: null, problems: [] };
      rows.push(row);
      const sw = await switchCountry(page, origin, country);
      if (!sw.ok) { row.switchFailed = true; continue; }
      row.currency = sw.currency;
      row.rate = sw.rate;
      // Product page, in this country: the price the shopper sees, checked against the product data in this currency.
      const pj = await api(page, `/products/${encodeURIComponent(handle)}.js`);
      const v = pj.json?.variants ? pj.json.variants.find((x) => String(x.id) === String(v0.id)) : null;
      if (!v) { row.refused = true; continue; }
      const dataMinor = toMinor(v.price, true);
      await page.goto(`${origin}/products/${encodeURIComponent(handle)}?variant=${v0.id}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      const st = await shopifyState(page);
      if (st.currency) row.currency = st.currency;
      const pp = await pagePrice(page, dataMinor);
      row.page = { minor: pp.minor, trusted: pp.trusted, text: pp.text };
      // Cart and checkout.
      await api(page, '/cart/clear.js', {});
      const added = await api(page, '/cart/add.js', { items: [{ id: v0.id, quantity: 1 }] });
      if (added.status >= 400) { row.refused = true; continue; }
      const cart = (await api(page, '/cart.js')).json;
      const line = (cart?.items || []).find((i) => String(i.variant_id ?? i.id) === String(v0.id));
      if (!line) { row.refused = true; continue; }
      row.cart = { minor: Number(line.final_line_price ?? line.line_price), currency: cart.currency || null };
      row.currency = row.currency || row.cart.currency;
      await page.goto(origin + '/checkout', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1000);
      if (!/\/checkouts?\//.test(page.url())) row.noCheckout = true;
      else {
        const sub = await checkoutSubtotal(page);
        if (sub) row.checkout = { minor: sub.minor, text: sub.text, currencyOk: showsCurrency(sub.text, row.cart.currency) };
      }
      await api(page, '/cart/clear.js', {});
    }
    for (const r of rows) r.problems = r.switchFailed ? [] : judgeMarket(r, { rounding: settings?.rounding || 'none', tolerance: settings?.tolerance ?? 10, shopCurrency });
    const label = (r) => `${r.market === r.country ? r.country : `${r.country} (${r.market})`}`;
    const marketTable = {
      product: name,
      base: money(base.minor, shopCurrency),
      rows: rows.map((r) => ({
        country: r.country,
        market: r.market,
        currency: r.currency,
        page: r.page ? money(r.page.minor, r.currency) : null,
        cart: r.cart ? money(r.cart.minor, r.cart.currency) : null,
        checkout: r.checkout ? (r.checkout.currencyOk === false ? r.checkout.text : money(r.checkout.minor, r.cart?.currency)) : null,
        converted: r.rate && r.currency !== shopCurrency ? money(Math.round(base.minor * r.rate), r.currency) : null,
        state: r.switchFailed ? 'switch' : r.problems.some((p) => p.level === 'fail') ? 'fail' : r.problems.length ? 'warn' : 'ok',
        notes: r.switchFailed ? 'Could not switch to this country' : r.problems.map((p) => p.text).join('; '),
      })),
    };
    const fails = rows.filter((r) => r.problems.some((p) => p.level === 'fail'));
    const warns = rows.filter((r) => !fails.includes(r) && r.problems.length);
    const switched = rows.filter((r) => !r.switchFailed);
    const skipped = rows.filter((r) => r.switchFailed);
    const say = (list, lvl) => list.map((r) => `${label(r)}: ${r.problems.filter((p) => !lvl || p.level === lvl).map((p) => p.text).join('; ')}`).join('. ');
    const skipNote = skipped.length ? ` We could not switch your store to ${skipped.map(label).join(', ')} with the country picker, so ${skipped.length === 1 ? 'it was' : 'they were'} not checked.` : '';
    const evidence = { marketTable };
    if (fails.length) {
      rec.add(check(CHECK_ID, 'functional', title, 'fail', { severity: fails.some((r) => r.problems.some((p) => p.level === 'fail' && p.key !== 'buy')) ? 'critical' : 'major', detail: `Shoppers in some countries see a different price or can't buy ${name}. ${say(fails, 'fail')}.${warns.length ? ` Also: ${say(warns)}.` : ''}${skipNote}`, evidence, fix: 'In Shopify admin, open Settings → Markets and check the market for that country: is it active, does it include this product, and are its currency and price adjustments right? Then check currency or pricing apps that change prices in the cart or checkout.' }));
    } else if (warns.length) {
      rec.add(check(CHECK_ID, 'functional', title, 'warn', { severity: 'major', detail: `Prices in some countries don't follow your rules: ${say(warns)}.${skipNote}`, evidence, fix: 'In Shopify admin, open Settings → Markets → the market → Products and pricing, and check the price adjustment and rounding. If the price is set on purpose, change the rule in Test suite → Price rules → Prices by country.' }));
    } else if (!switched.length) {
      rec.add(check(CHECK_ID, 'functional', title, 'warn', { severity: 'minor', detail: `We could not switch your store to ${skipped.map(label).join(', ')} with the country picker, so prices by country were not checked. If your store shows one price everywhere, this is expected.`, evidence }));
    } else {
      rec.add(check(CHECK_ID, 'functional', title, 'pass', { severity: 'critical', detail: `${name} has the same price from product page to checkout in ${switched.map((r) => `${label(r)} (${r.cart ? money(r.cart.minor, r.cart.currency) : r.currency})`).join(', ')}.${skipNote}`, evidence }));
    }
  } catch (e) {
    rec.add(check(CHECK_ID, 'functional', title, 'skip', { severity: 'major', detail: shortErr(e) }));
  } finally {
    // Back to the store's own country, so later checks see the store as before.
    if (home?.country) await switchCountry(page, origin, home.country).catch(() => {});
    await api(page, '/cart/clear.js', {});
  }
}
