import { check, shortErr } from './checks.js';
import { gotoStore, settle } from './browser.js';
import { searchTermFrom } from './discover.js';

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

export async function runFunctional({ page, rec, origin, info, password, shotDir, shot }) {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push({ url: page.url(), message: shortErr(e) }));

  // 1. Homepage
  rec.step('Open homepage');
  let home;
  try {
    const t0 = Date.now();
    home = await gotoStore(page, origin + '/', { password });
    await settle(page, 800);
    const status = home.res ? home.res.status() : 0;
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
    if (status >= 400 || status === 0) {
      rec.add(
        check('fn.home', 'functional', 'Store is reachable', 'fail', {
          severity: 'critical',
          detail: `Homepage returned HTTP ${status}.`,
          evidence: { screenshot: await shot(page, 'home-error') },
          fix: 'Check your domain settings and Shopify status. If you recently changed themes, confirm one is published.',
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
  rec.step('Open a collection');
  try {
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
  if (term) {
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
    if (product.variants.length >= 2) {
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

  // 5. Cart page and checkout reach (stops before any payment details)
  if (atcOk) {
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
              : `The cart has ${cart.item_count || 0} item(s) but the cart page does not show "${product.title}".`,
          evidence: showsItem ? null : { screenshot: await shot(page, 'cart') },
          fix: showsItem ? '' : 'Check the cart template or cart drawer app; customers may not see what they added.',
        })
      );

      rec.step('Proceed to checkout (stops before payment)');
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
      const reached = /\/checkouts?\//.test(url) || /checkout\.shopify\.com|shop\.app\/checkout/.test(url);
      const hasForm = await page
        .locator('input[type="email"], input[name="email"], input[autocomplete="email"], input[type="tel"], input[name="phone"]')
        .first()
        .isVisible({ timeout: 8000 })
        .catch(() => false);
      const challenged = /challenge|captcha|throttle|queue/i.test(url) || (await page.locator('iframe[src*="captcha"]').count()) > 0;
      let status = 'fail';
      let detail = '';
      if (reached && hasForm) {
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
      rec.add(
        check('fn.checkout', 'functional', 'Checkout opens', status, {
          severity: 'critical',
          detail,
          evidence: status === 'pass' ? null : { screenshot: await shot(page, 'checkout'), url },
          fix: status === 'fail' ? 'Check the cart template checkout button, checkout apps, and Settings → Checkout. Test a manual order on a phone.' : '',
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
