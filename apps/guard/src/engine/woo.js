/**
 * The shopping journey on WooCommerce stores: shop page, search, product page, Add to cart, cart and
 * checkout (stops before any payment details). The storefront is driven like a shopper would; the
 * public WooCommerce Store API (same cart session as the browser) confirms what really is in the cart.
 * Check ids are the same as on Shopify, so scores, alerts and test-suite switches work unchanged.
 */
import { check, shortErr, plural } from './checks.js';
import { settle } from './browser.js';
import { searchTermFrom, wooUrl } from './discover.js';

const ATC = [
  'form.cart button.single_add_to_cart_button',
  'button[name="add-to-cart"]',
  'button.single_add_to_cart_button',
  '.wc-block-components-product-button__button',
  'button:has-text("Add to cart")',
  'button:has-text("Add to basket")',
];
const CHECKOUT = [
  '.wc-proceed-to-checkout a.checkout-button',
  'a.checkout-button',
  '.wc-block-cart__submit-button',
  'a[href*="/checkout"]:has-text("checkout")',
  'a:has-text("Proceed to checkout")',
  'a:has-text("Checkout")',
];
const PRODUCT_LINKS = 'ul.products li.product a, .wc-block-grid__product a, a.woocommerce-LoopProduct-link, .wp-block-woocommerce-product-template a, .wc-block-product a';

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 5); i++) if (await loc.nth(i).isVisible().catch(() => false)) return { el: loc.nth(i), sel };
  }
  return null;
}

/** Calls the Store API from inside the page, so it shares the shopper's cart session. */
async function storeApi(page, url, { method = 'GET', body, nonceUrl } = {}) {
  return page
    .evaluate(async ({ url, method, body, nonceUrl }) => {
      const headers = { Accept: 'application/json' };
      if (method !== 'GET') {
        // Store API writes need the nonce it hands out on every read.
        const r0 = await fetch(nonceUrl, { credentials: 'same-origin', headers });
        headers.Nonce = r0.headers.get('Nonce') || r0.headers.get('X-WC-Store-API-Nonce') || '';
        headers['Content-Type'] = 'application/json';
      }
      const r = await fetch(url, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text: text.slice(0, 300) };
    }, { url, method, body, nonceUrl })
    .catch((e) => ({ status: 0, json: null, text: String(e) }));
}

async function cartCount(page, api) {
  const r = await storeApi(page, api('/cart'));
  return r.json && typeof r.json.items_count === 'number' ? r.json : { items_count: 0, items: [], error: r.status };
}

async function clearCart(page, api) {
  await storeApi(page, api('/cart/items'), { method: 'DELETE', nonceUrl: api('/cart') });
}

const decode = (t) => t.replace(/&quot;/g, '"').replace(/&#0?39;|&#8217;/g, '’').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Variable products: choose the first real option of every attribute, as a shopper would. */
async function chooseOptions(page) {
  const selects = page.locator('form.variations_form select[name^="attribute_"], form.cart select[name^="attribute_"]');
  const n = await selects.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const s = selects.nth(i);
    const first = await s.evaluate((el) => [...el.options].find((o) => o.value && !o.disabled)?.value || '').catch(() => '');
    if (first) await s.selectOption(first).catch(() => {});
  }
  if (n) await page.waitForTimeout(500);
  return n;
}

export async function runWooJourney({ page, rec, origin, info, shot, on = () => true }) {
  const api = (route, q) => wooUrl(origin, info.woo.base, route, q);
  const knownLinks = new Set(info.products.map((p) => p.url.replace(/\/$/, '')));

  // 1. Shop or category page
  if (on('journey.collection')) {
    const cat = info.collections[0];
    const url = cat ? cat.url : `${origin}/shop/`;
    rec.step(cat ? `Open the "${cat.title}" category` : 'Open the shop page');
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settle(page, 600);
      const status = res ? res.status() : 0;
      const links = await page.locator(PRODUCT_LINKS).count().catch(() => 0);
      const where = cat ? `The "${cat.title}" category` : 'Your shop page';
      rec.add(
        check('fn.collection', 'functional', 'Collection page shows products', status < 400 && links > 0 ? 'pass' : 'fail', {
          detail: status >= 400 ? `${where} returned HTTP ${status}.` : links > 0 ? `${where} lists ${plural(links, 'product link')}.` : `${where} shows no products.`,
          evidence: status < 400 && links > 0 ? null : { screenshot: await shot(page, 'collection'), url },
          fix: status < 400 && links > 0 ? '' : 'In WordPress, check WooCommerce → Settings → Products (shop page) and that the category still has published products. A theme or page-builder change can also hide the product grid.',
        })
      );
    } catch (e) {
      rec.add(check('fn.collection', 'functional', 'Collection page shows products', 'fail', { detail: shortErr(e) }));
    }
  }

  // 2. Search (WooCommerce jumps straight to the product when there is exactly one match)
  const term = searchTermFrom(info.products);
  if (term && on('journey.search')) {
    rec.step(`Search for "${term}"`);
    try {
      await page.goto(`${origin}/?s=${encodeURIComponent(term)}&post_type=product`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settle(page, 800);
      const landed = knownLinks.has(page.url().split('?')[0].replace(/\/$/, ''));
      const found = landed ? 1 : await page.locator(PRODUCT_LINKS).count().catch(() => 0);
      rec.add(
        check('fn.search', 'functional', 'Search returns products', found > 0 ? 'pass' : 'fail', {
          detail: found > 0 ? `Searching "${term}" returned results.` : `Searching "${term}" (a word from a product title) returned no products.`,
          evidence: found > 0 ? null : { screenshot: await shot(page, 'search') },
          fix: found > 0 ? '' : 'Check your search plugin or theme search template, and that the products are published and visible in the catalog.',
        })
      );
    } catch (e) {
      rec.add(check('fn.search', 'functional', 'Search returns products', 'fail', { detail: shortErr(e) }));
    }
  }

  // 3. Product page and Add to cart
  const product = info.products[0];
  if (!product) {
    rec.add(check('fn.pdp', 'functional', 'Product page works', 'skip', { detail: 'No in-stock products were found to test.' }));
    return {};
  }
  await clearCart(page, api);
  rec.step(`Open product "${product.title}"`);
  let atcOk = false;
  try {
    const res = await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settle(page, 1000);
    const status = res ? res.status() : 0;
    const hasPrice = await page.locator('.price, .woocommerce-Price-amount, .wc-block-components-product-price').filter({ hasText: /\d/ }).first().isVisible().catch(() => false);
    if (status >= 400) {
      rec.add(check('fn.pdp', 'functional', 'Product page works', 'fail', { severity: 'critical', detail: `"${product.title}" returned HTTP ${status}.`, evidence: { screenshot: await shot(page, 'pdp') } }));
    } else {
      rec.add(
        check('fn.pdp', 'functional', 'Product page works', hasPrice ? 'pass' : 'warn', {
          severity: 'critical',
          detail: hasPrice ? `"${product.title}" loads with a visible price.` : `"${product.title}" loads, but no price was visible.`,
          evidence: hasPrice ? null : { screenshot: await shot(page, 'pdp-noprice') },
          fix: hasPrice ? '' : 'Check the product template in your theme or page builder; a recent change may have hidden the price.',
        })
      );
    }

    rec.step('Click Add to cart');
    const options = await chooseOptions(page);
    const before = (await cartCount(page, api)).items_count;
    const btn = await firstVisible(page, ATC);
    let clicked = false;
    if (btn && (await btn.el.isEnabled().catch(() => false))) {
      await btn.el.scrollIntoViewIfNeeded().catch(() => {});
      await btn.el.click({ timeout: 8000 }).then(() => (clicked = true)).catch(() => {});
    }
    let after = before;
    if (clicked) {
      for (let i = 0; i < 10; i++) {
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(700);
        after = (await cartCount(page, api)).items_count;
        if (after > before) break;
      }
    }
    if (after > before) {
      atcOk = true;
      rec.add(check('fn.atc', 'functional', 'Add to cart works', 'pass', { severity: 'critical', detail: `Clicking "Add to cart" on "${product.title}"${options ? ' (first option chosen)' : ''} added it to the cart.` }));
    } else {
      // Does WooCommerce's own cart take the item? If it does, the button on the page is what's broken.
      const shotPath = await shot(page, 'atc-failed');
      const direct = await storeApi(page, api('/cart/add-item'), { method: 'POST', body: { id: product.variants[0].id, quantity: 1 }, nonceUrl: api('/cart') });
      if (direct.status >= 200 && direct.status < 300) {
        atcOk = true; // the cart works, so the rest of the journey can still be tested
        rec.add(
          check('fn.atc', 'functional', 'Add to cart works', btn ? 'fail' : 'warn', {
            severity: 'critical',
            detail: !btn
              ? 'We could not find a standard "Add to cart" button. The cart works when called directly, so your theme may use a custom button.'
              : !clicked
                ? `The "Add to cart" button on "${product.title}" is ${(await btn.el.isEnabled().catch(() => false)) ? 'covered or not clickable' : 'disabled'} even though the item is in stock.`
                : `Clicking "Add to cart" on "${product.title}" did not add anything, but WooCommerce's cart accepts the item. Something on the page (theme code or a plugin) is breaking the button.`,
            evidence: { screenshot: shotPath, selector: btn?.sel },
            fix: btn
              ? 'Check recent theme edits and plugin installs or updates (cart, upsell, popup and caching plugins are common causes). Turn them off one at a time on a staging copy to find the culprit.'
              : 'If customers report problems adding to cart, check the product page template in your theme or page builder.',
          })
        );
      } else {
        const msg = direct.json?.message ? decode(String(direct.json.message).replace(/<[^>]*>/g, '')).trim().replace(/\.$/, '') : '';
        rec.add(
          check('fn.atc', 'functional', 'Add to cart works', 'fail', {
            severity: 'critical',
            detail: `"${product.title}" could not be added to the cart${msg ? `: ${msg}` : ` (cart responded HTTP ${direct.status})`}.`,
            evidence: { screenshot: shotPath, response: direct.text },
            fix: 'Check the product stock and "purchasable" settings in WooCommerce, and any plugin that limits what can go in the cart.',
          })
        );
      }
    }
  } catch (e) {
    rec.add(check('fn.atc', 'functional', 'Add to cart works', 'fail', { severity: 'critical', detail: `The product journey failed: ${shortErr(e)}`, evidence: { screenshot: await shot(page, 'pdp-error') } }));
  }

  // 4. Cart and checkout (stops before any payment details), then empty the cart
  if (atcOk && on('journey.checkout')) {
    rec.step('Open cart');
    try {
      await page.goto(`${origin}/cart/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settle(page, 800);
      const cart = await cartCount(page, api);
      const showsItem = (await page.getByText(product.title, { exact: false }).count()) > 0 || (await page.locator(`a[href^="${product.url}"]`).count()) > 0;
      const t = cart.totals;
      const total = t && t.total_price != null ? `${(Number(t.total_price) / 10 ** Number(t.currency_minor_unit ?? 2)).toFixed(2)} ${t.currency_code || ''}`.trim() : '?';
      const ok = showsItem && cart.items_count > 0;
      rec.add(
        check('fn.cart', 'functional', 'Cart shows the item and total', ok ? 'pass' : 'fail', {
          severity: 'critical',
          detail: ok ? `Cart page lists "${product.title}" (cart total ${total}).` : `The cart has ${plural(cart.items_count || 0, 'item')} but the cart page does not show "${product.title}".`,
          evidence: ok ? null : { screenshot: await shot(page, 'cart') },
          fix: ok ? '' : 'Check WooCommerce → Settings → Advanced (cart page) and your cart template or cart plugin; customers may not see what they added.',
        })
      );

      rec.step('Proceed to checkout (stops before payment)');
      let checkoutStatus = 0;
      const onResponse = (r) => { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame() && /checkout/.test(r.url())) checkoutStatus = r.status(); };
      page.on('response', onResponse);
      const cbtn = await firstVisible(page, CHECKOUT);
      if (cbtn) await Promise.all([page.waitForURL(/checkout/, { timeout: 25000 }).catch(() => {}), cbtn.el.click({ timeout: 8000 }).catch(() => {})]);
      if (!/checkout/.test(page.url())) await page.goto(`${origin}/checkout/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await settle(page, 1500);
      const url = page.url();
      const reached = /checkout/.test(url);
      const hasForm = await page.locator('#billing_email, input[type="email"], input[autocomplete="email"], #email').first().isVisible({ timeout: 8000 }).catch(() => false);
      const challenged = /challenge|captcha|queue/i.test(url) || (await page.locator('iframe[src*="captcha"]').count()) > 0;
      page.off('response', onResponse);
      const broken = checkoutStatus >= 400;
      const status = reached && hasForm && !broken ? 'pass' : broken ? 'fail' : challenged || reached ? 'warn' : 'fail';
      const detail =
        broken ? `The checkout page shows an error (HTTP ${checkoutStatus}), so customers can't place an order.`
          : status === 'pass' ? 'Checkout opens with the contact form. (Test stopped before any payment details.)'
          : challenged ? 'Checkout showed a bot check or queue, so it could not be verified automatically.'
            : reached ? 'The checkout page opened but the contact form was not detected.'
              : cbtn ? 'Clicking the checkout button did not open checkout.' : 'No checkout button was found on the cart page, and checkout did not open.';
      rec.add(
        check('fn.checkout', 'functional', 'Checkout opens', status, {
          severity: 'critical',
          detail,
          evidence: status === 'pass' ? null : { screenshot: await shot(page, 'checkout'), url },
          fix: broken ? 'A plugin or theme error is breaking checkout. In WordPress, open Tools → Site Health and WooCommerce → Status → Logs for the error, and turn off the most recently updated plugin first.' : status === 'fail' ? 'Check WooCommerce → Settings → Advanced (checkout page), your payment and checkout plugins, and place a test order on a phone.' : '',
        })
      );
    } catch (e) {
      rec.add(check('fn.checkout', 'functional', 'Checkout opens', 'fail', { severity: 'critical', detail: shortErr(e) }));
    }
  }
  if (atcOk) await clearCart(page, api);
  return {};
}
