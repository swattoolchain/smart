import { check, shortErr, plural } from './checks.js';
import { gotoStore, settle, settleChallenge } from './browser.js';
import { searchTermFrom } from './discover.js';
import { errorSource } from './apps.js';
import { runWooJourney } from './woo.js';
import { pagePrice, checkoutSubtotal, cartLine, priceCheck, toMinor } from './pricing.js';

const ATC_SELECTORS = [
  'form[action*="/cart/add"] button[type="submit"][name="add"]',
  'form[action*="/cart/add"] [type="submit"]',
  'button[name="add"]',
  '[data-add-to-cart]',
  '[data-action="add-to-cart"]',
  'button.product-form__submit',
  'button:has-text("Add to cart")',
  'button:has-text("Add to Cart")',
  'button:has-text("Add to bag")',
  'button:has-text("Add to Bag")',
];

const CHECKOUT_SELECTORS = [
  'button[name="checkout"]',
  'input[name="checkout"]',
  '#checkout',
  'a[href="/checkout"]',
  'button:has-text("Check out")',
  'button:has-text("Checkout")',
  'a:has-text("Check out")',
  'a:has-text("Checkout")',
];

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 5); i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) return { el, sel };
    }
  }
  return null;
}

async function cartJs(page) {
  return page
    .evaluate(async () => {
      const r = await fetch('/cart.js', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!r.ok) return { error: r.status };
      return r.json();
    })
    .catch((e) => ({ error: String(e) }));
}

async function clearCart(page) {
  await page
    .evaluate(() => fetch('/cart/clear.js', { method: 'POST', credentials: 'same-origin' }))
    .catch(() => {});
}

async function dismissOverlays(page) {
  // Newsletter and cookie popups regularly cover buttons; close the common ones politely.
  const closers = [
    'button[aria-label="Close"]',
    'button[aria-label="close"]',
    '[data-testid="close-button"]',
    '.klaviyo-close-form',
    'button:has-text("Accept")',
    'button:has-text("No thanks")',
  ];
  for (const sel of closers) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) await loc.click({ timeout: 1500 }).catch(() => {});
  }
}

export async function runFunctional({ page, rec, origin, info, password, shot, on = () => true }) {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push({ url: page.url(), message: shortErr(e), source: errorSource(e) }));

  // 1. Homepage
  rec.step('Open homepage');
  let home;
  try {
    const t0 = Date.now();
    home = await gotoStore(page, origin + '/', { password });
    await settle(page, 800);
    const status = home.res ? home.res.status() : 0;
    // The password page itself asked our browser to verify (Shopify protects it against password guessing).
    if (home.blockedByChallenge) {
      rec.add(check('fn.blocked', 'functional', 'Test browser allowed in', 'skip', {
        severity: 'critical',
        detail: 'Shopify’s protection on your store’s password page asked our test browser to verify itself, so we couldn’t unlock the store this time. Your store is fine.',
        evidence: { screenshot: await shot(page, 'blocked'), vendor: 'Shopify bot protection' },
        fix: 'This happens on password-protected stores after several logins in a short time. We now unlock once and reuse it, so the next check usually gets through. If it keeps happening, remove the password when your store launches, or write to hello@tharam.store.',
      }));
      return { blocked: true, vendor: 'Shopify bot protection', pageErrors };
    }
    if (home.locked) {
      rec.add(
        check('fn.home', 'functional', 'Store is reachable', 'warn', {
          severity: 'critical',
          detail: home.wrongPassword
            ? 'The storefront password you saved did not work.'
            : 'The store is password protected. Add the storefront password to run the full test suite.',
        })
      );
      return { locked: true, pageErrors };
    }
    const challenge = await settleChallenge(page, home.res);
    if (challenge.blocked) {
      rec.add(
        check('fn.blocked', 'functional', 'Test browser allowed in', 'skip', {
          severity: 'critical',
          detail: `${challenge.vendor} showed our test browser a verification page, so we could not test your store. This usually means your store is fine; it just doesn't recognise Tharam yet.`,
          evidence: { screenshot: await shot(page, 'blocked'), vendor: challenge.vendor },
          fix:
            // Shopify stores sit behind Shopify's own Cloudflare: the merchant can't change it, so don't send them there.
            challenge.vendor === 'Cloudflare' && info?.isShopify
              ? 'This is Shopify’s own protection, not something you set up, and your store is fine. It usually clears by itself: we try again on the next check. If it keeps happening, write to hello@tharam.store and we’ll route your checks through a verified connection.'
              : challenge.vendor === 'Cloudflare'
              ? 'In Cloudflare, go to Security → WAF → Custom rules and add a rule: if User Agent contains "TharamStoreGuard", then Skip (all remaining custom rules, Bot Fight Mode and Super Bot Fight Mode). Then run the check again.'
              : challenge.vendor === 'Shopify bot protection'
                ? 'Shopify sometimes verifies new automated visitors. Run the check again in a few minutes. If it keeps happening, write to hello@tharam.store and we will route your tests through a verified connection.'
                : `Ask whoever manages ${challenge.vendor} to allow visitors whose User Agent contains "TharamStoreGuard", then run the check again.`,
        })
      );
      return { blocked: true, vendor: challenge.vendor, pageErrors };
    }
    if (status >= 400 || status === 0) {
      rec.add(
        check('fn.home', 'functional', 'Store is reachable', 'fail', {
          severity: 'critical',
          detail: `Homepage returned HTTP ${status}.`,
          evidence: { screenshot: await shot(page, 'home-error') },
          fix: info?.isWoo ? 'Check your hosting and domain settings. If you recently changed themes or plugins, open the site yourself to confirm it loads.' : 'Check your domain settings and Shopify status. If you recently changed themes, confirm one is published.',
        })
      );
      return { down: true, pageErrors };
    }
    rec.add(
      check('fn.home', 'functional', 'Store is reachable', 'pass', {
        severity: 'critical',
        detail: `Homepage loaded (HTTP ${status}) in ${((Date.now() - t0) / 1000).toFixed(1)}s.`,
      })
    );
  } catch (e) {
    rec.add(
      check('fn.home', 'functional', 'Store is reachable', 'fail', {
        severity: 'critical',
        detail: `Homepage did not load: ${shortErr(e)}`,
        fix: 'Your store may be down or very slow. Check Shopify status and your domain DNS.',
      })
    );
    return { down: true, pageErrors };
  }
  await dismissOverlays(page);

  // 2. Collection page
  const coll = info.collections[0];
  const collUrl = coll ? `${origin}/collections/${coll.handle}` : `${origin}/collections/all`;
  // Collection, search, product and cart steps rely on Shopify's storefront conventions.
  if (info.isWoo) return { ...(await runWooJourney({ page, rec, origin, info, shot, on })), pageErrors };
  if (!info.isShopify) return { pageErrors };

  if (on('journey.collection')) try {
    rec.step('Open a collection');
    const res = await page.goto(collUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settle(page, 600);
    const links = await page.locator('a[href*="/products/"]').count();
    const status = res ? res.status() : 0;
    if (status >= 400) {
      rec.add(
        check('fn.collection', 'functional', 'Collection page shows products', 'fail', {
          detail: `${collUrl} returned HTTP ${status}.`,
          evidence: { screenshot: await shot(page, 'collection') },
        })
      );
    } else if (links === 0) {
      rec.add(
        check('fn.collection', 'functional', 'Collection page shows products', 'fail', {
          detail: `No product links were found on ${coll ? `"${coll.title}"` : '/collections/all'}.`,
          evidence: { screenshot: await shot(page, 'collection') },
          fix: 'Check the collection conditions and that the collection template renders the product grid.',
        })
      );
    } else {
      rec.add(
        check('fn.collection', 'functional', 'Collection page shows products', 'pass', {
          detail: `${coll ? `"${coll.title}"` : 'All products'} lists ${links} product links.`,
        })
      );
    }
  } catch (e) {
    rec.add(check('fn.collection', 'functional', 'Collection page shows products', 'fail', { detail: shortErr(e) }));
  }

  // 3. Search
  const term = searchTermFrom(info.products);
  if (term && on('journey.search')) {
    rec.step(`Search for "${term}"`);
    try {
      await page.goto(`${origin}/search?q=${encodeURIComponent(term)}&type=product`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await settle(page, 800);
      const found = await page.locator('main a[href*="/products/"], #MainContent a[href*="/products/"], a[href*="/products/"]').count();
      rec.add(
        check('fn.search', 'functional', 'Search returns products', found > 0 ? 'pass' : 'fail', {
          detail: found > 0 ? `Searching "${term}" returned results.` : `Searching "${term}" (a word from a product title) returned no products.`,
          evidence: found > 0 ? null : { screenshot: await shot(page, 'search') },
          fix: found > 0 ? '' : 'Check your search app or theme search template, and that products are published to the Online Store.',
        })
      );
    } catch (e) {
      rec.add(check('fn.search', 'functional', 'Search returns products', 'fail', { detail: shortErr(e) }));
    }
  }

  // 4. Product page + add to cart
  const product = info.products[0];
  if (!product) {
    rec.add(
      check('fn.pdp', 'functional', 'Product page works', 'skip', {
        detail: 'No in-stock products were found to test.',
      })
    );
    return { pageErrors };
  }
  await clearCart(page);
  const variant = product.variants[0];
  const pdpUrl = `${origin}/products/${product.handle}?variant=${variant.id}`;
  rec.step(`Open product "${product.title}"`);
  let atcOk = false;
  let trail = null; // what the shopper is asked to pay at each step (Prices stay the same)
  try {
    const res = await page.goto(pdpUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settle(page, 1000);
    await dismissOverlays(page);
    const status = res ? res.status() : 0;
    const hasPrice = await page
      .locator('[class*="price"], [data-price], .money')
      .filter({ hasText: /\d/ })
      .first()
      .isVisible()
      .catch(() => false);
    if (status >= 400) {
      rec.add(
        check('fn.pdp', 'functional', 'Product page works', 'fail', {
          severity: 'critical',
          detail: `"${product.title}" returned HTTP ${status}.`,
          evidence: { screenshot: await shot(page, 'pdp') },
        })
      );
    } else {
      rec.add(
        check('fn.pdp', 'functional', 'Product page works', hasPrice ? 'pass' : 'warn', {
          severity: 'critical',
          detail: hasPrice ? `"${product.title}" loads with a visible price.` : `"${product.title}" loads, but no price was visible.`,
          evidence: hasPrice ? null : { screenshot: await shot(page, 'pdp-noprice') },
          fix: hasPrice ? '' : 'Check the product template price block; a theme or app change may have hidden it.',
        })
      );
    }

    // Variant selection: the form's variant id should follow the ?variant= parameter.
    if (product.variants.length >= 2 && on('journey.variant')) {
      const v2 = product.variants[1];
      await page.goto(`${origin}/products/${product.handle}?variant=${v2.id}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settle(page, 600);
      const ids = await page
        .locator('form[action*="/cart/add"] [name="id"]')
        .evaluateAll((els) => els.map((e) => e.value))
        .catch(() => []);
      const selected = ids.includes(String(v2.id));
      rec.add(
        check('fn.variant', 'functional', 'Variant selection works', ids.length === 0 ? 'skip' : selected ? 'pass' : 'warn', {
          detail:
            ids.length === 0
              ? 'Variant picker uses a custom form; checked via add-to-cart instead.'
              : selected
                ? `Selecting "${v2.title}" updates the product form.`
                : `Opening variant "${v2.title}" did not select it in the product form, so customers may add the wrong variant.`,
          fix: selected ? '' : 'Check the variant picker script in your theme or product options app.',
        })
      );
      await page.goto(pdpUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settle(page, 800);
      await dismissOverlays(page);
    }

    if (on('pricing.journey')) {
      rec.step('Read the price on the product page');
      const pp = await pagePrice(page, toMinor(variant.price));
      if (pp.minor != null) trail = { product: product.title, variant: variant.title, variantId: variant.id, quantity: 1, page: pp };
    }

    // Add to cart through the real button, then confirm with Shopify's cart API.
    rec.step('Click Add to cart');
    const before = await cartJs(page);
    const beforeCount = before.item_count || 0;
    const btn = await firstVisible(page, ATC_SELECTORS);
    let clicked = false;
    if (btn && (await btn.el.isEnabled().catch(() => false))) {
      await btn.el.scrollIntoViewIfNeeded().catch(() => {});
      await btn.el.click({ timeout: 8000 }).then(() => (clicked = true)).catch(() => {});
    }
    let afterCount = beforeCount;
    if (clicked) {
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(700);
        const after = await cartJs(page);
        afterCount = after.item_count || 0;
        if (afterCount > beforeCount) break;
      }
    }
    if (afterCount > beforeCount) {
      atcOk = true;
      rec.add(
        check('fn.atc', 'functional', 'Add to cart works', 'pass', {
          severity: 'critical',
          detail: `Clicking "Add to cart" on "${product.title}" added it to the cart.`,
        })
      );
    } else {
      // Diagnose: does Shopify's cart accept the item directly? If yes, the storefront button is broken.
      const shotPath = await shot(page, 'atc-failed');
      const api = await page
        .evaluate(async (id) => {
          const r = await fetch('/cart/add.js', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ items: [{ id, quantity: 1 }] }),
            credentials: 'same-origin',
          });
          return { status: r.status, body: (await r.text()).slice(0, 300) };
        }, variant.id)
        .catch((e) => ({ status: 0, body: String(e) }));
      if (api.status === 200) {
        atcOk = true; // cart itself works, continue the journey
        if (!btn) {
          rec.add(
            check('fn.atc', 'functional', 'Add to cart works', 'warn', {
              severity: 'critical',
              detail: 'Could not find a standard "Add to cart" button. The cart works when called directly, so your theme may use a custom button.',
              evidence: { screenshot: shotPath },
              fix: 'If customers report problems adding to cart, check the product form block in your theme.',
            })
          );
        } else {
          rec.add(
            check('fn.atc', 'functional', 'Add to cart works', 'fail', {
              severity: 'critical',
              detail: !clicked
                ? `The "Add to cart" button on "${product.title}" is ${await btn.el.isEnabled().catch(() => false) ? 'covered or not clickable' : 'disabled'} even though the item is in stock.`
                : `Clicking "Add to cart" on "${product.title}" did not add anything, but Shopify's cart accepts the item. Something on the page (theme code or an app) is breaking the button.`,
              evidence: { screenshot: shotPath, selector: btn.sel },
              fix: 'Check recent theme edits and app installs/updates (cart drawers, upsell, bundle and popup apps are common causes). Disable them one at a time on a duplicate theme to find the culprit.',
            })
          );
        }
      } else {
        rec.add(
          check('fn.atc', 'functional', 'Add to cart works', 'fail', {
            severity: 'critical',
            detail: `"${product.title}" could not be added to the cart (cart responded HTTP ${api.status}).`,
            evidence: { screenshot: shotPath, response: api.body },
            fix: 'Check inventory, product availability on the Online Store channel, and any cart-validation apps.',
          })
        );
      }
    }
  } catch (e) {
    rec.add(
      check('fn.atc', 'functional', 'Add to cart works', 'fail', {
        severity: 'critical',
        detail: `The product journey failed: ${shortErr(e)}`,
        evidence: { screenshot: await shot(page, 'pdp-error') },
      })
    );
  }

  if (trail && atcOk) {
    const cart = await cartJs(page);
    trail.currency = cart.currency;
    trail.cart = cartLine(cart, trail.variantId);
    if (trail.cart) trail.quantity = trail.cart.quantity;
    else trail = null; // the cart holds something else (a theme or app swapped the item): fn.cart reports it
  }
  if (trail && !on('journey.checkout')) await priceCheck(rec, trail, { shot: () => shot(page, 'price') });

  // 5. Cart page and checkout reach (stops before any payment details)
  if (atcOk && !on('journey.checkout')) await clearCart(page);
  if (atcOk && on('journey.checkout')) {
    rec.step('Open cart');
    try {
      await page.goto(`${origin}/cart`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settle(page, 800);
      await dismissOverlays(page);
      const cart = await cartJs(page);
      const showsItem =
        (await page.locator(`a[href*="/products/${product.handle}"]`).count()) > 0 ||
        (await page.getByText(product.title, { exact: false }).count()) > 0;
      const total = cart.total_price;
      rec.add(
        check('fn.cart', 'functional', 'Cart shows the item and total', showsItem && cart.item_count > 0 ? 'pass' : 'fail', {
          severity: 'critical',
          detail:
            showsItem && cart.item_count > 0
              ? `Cart page lists "${product.title}" (cart total ${typeof total === 'number' ? (total / 100).toFixed(2) : '?'} ${cart.currency || ''}).`
              : `The cart has ${plural(cart.item_count || 0, 'item')} but the cart page does not show "${product.title}".`,
          evidence: showsItem ? null : { screenshot: await shot(page, 'cart') },
          fix: showsItem ? '' : 'Check the cart template or cart drawer app; customers may not see what they added.',
        })
      );

      rec.step('Proceed to checkout (stops before payment)');
      const shopDomain = await page.evaluate(() => (window.Shopify && window.Shopify.shop) || '').catch(() => '');
      const cbtn = await firstVisible(page, CHECKOUT_SELECTORS);
      if (cbtn) {
        await Promise.all([
          page.waitForURL(/checkout|checkouts/, { timeout: 25000 }).catch(() => {}),
          cbtn.el.click({ timeout: 8000 }).catch(() => {}),
        ]);
      }
      if (!/checkout|checkouts/.test(page.url())) {
        await page.goto(`${origin}/checkout`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
      await settle(page, 2000);
      const url = page.url();
      // Checkout must stay on the store's own site or Shopify's. A look-alike checkout elsewhere is how
      // hijacked apps stole card details in 2026, and it looks exactly like the real one.
      const offsite = !trustedCheckout(url, origin, shopDomain);
      const reached = !offsite && (/\/checkouts?\//.test(url) || /checkout\.shopify\.com|shop\.app\/checkout/.test(url));
      const hasForm = await page
        .locator('input[type="email"], input[name="email"], input[autocomplete="email"], input[type="tel"], input[name="phone"]')
        .first()
        .isVisible({ timeout: 8000 })
        .catch(() => false);
      const challenged = /challenge|captcha|throttle|queue/i.test(url) || (await page.locator('iframe[src*="captcha"]').count()) > 0;
      let status = 'fail';
      let detail = '';
      let fix = 'Check the cart template checkout button, checkout apps, and Settings → Checkout. Test a manual order on a phone.';
      if (offsite) {
        detail = `Checkout sent shoppers to a different website (${hostOf(url)}) instead of your store's Shopify checkout. Card details entered there do not reach you.`;
        fix = 'Treat this as urgent. Check which app or theme code changed recently (Online Store → Themes → Edit code, and your recently updated apps), remove it, and contact Shopify support. Pause the app that added the redirect until it is fixed.';
      } else if (reached && hasForm) {
        status = 'pass';
        detail = 'Checkout opens with the contact form. (Test stopped before any payment details.)';
      } else if (challenged) {
        status = 'warn';
        detail = 'Checkout showed a bot check or queue, so it could not be verified automatically.';
      } else if (reached) {
        status = 'warn';
        detail = 'Checkout URL opened but the contact form was not detected.';
      } else {
        detail = cbtn
          ? 'Clicking the checkout button did not open checkout.'
          : 'No checkout button was found on the cart page, and checkout did not open.';
      }
      if (trail) {
        trail.checkoutReached = reached && hasForm;
        if (trail.checkoutReached) trail.checkout = await checkoutSubtotal(page);
        await priceCheck(rec, trail, { shot: () => shot(page, 'checkout-price') });
      }
      rec.add(
        check('fn.checkout', 'functional', 'Checkout opens', status, {
          severity: 'critical',
          detail,
          evidence: status === 'pass' ? null : { screenshot: await shot(page, 'checkout'), url, ...(offsite ? { offsite: hostOf(url) } : {}) },
          fix: status === 'fail' ? fix : '',
        })
      );
    } catch (e) {
      rec.add(check('fn.checkout', 'functional', 'Checkout opens', 'fail', { severity: 'critical', detail: shortErr(e) }));
    } finally {
      await page.goto(`${origin}/cart`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await clearCart(page);
    }
  }

  return { pageErrors };
}

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const baseOf = (h) => h.replace(/^www\./, '');

/** Whether a checkout address belongs to the store or to Shopify. */
export function trustedCheckout(url, origin, shopDomain = '') {
  const h = hostOf(url);
  if (!h) return false;
  const store = baseOf(hostOf(origin));
  if (h === hostOf(origin) || baseOf(h) === store || h.endsWith(`.${store}`)) return true;
  if (shopDomain && h === String(shopDomain).toLowerCase()) return true;
  if (/(^|\.)(checkout|pay)\.shopify\.com$/.test(h) || h === 'shop.app' || h.endsWith('.shop.app')) return true;
  // A preview or share link can move to the store's .myshopify.com address.
  if (/\.myshopify\.com$/.test(h) && /\.myshopify\.com$/.test(hostOf(origin))) return h === hostOf(origin);
  return false;
}
