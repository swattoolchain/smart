/** HTTP side of the Shopify app: the embedded page, its session start, native data, and webhooks. */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db, q } from './db.js';
import { storePassword } from './secret.js';
import { GROUPS } from './engine/catalog.js';
import { startRun } from './scheduler.js';
import { entitlements, blockReason, has } from './license.js';
import * as shopify from './shopify.js';
import { assertPublicTarget } from './engine/browser.js';
import { isOn } from './features.js';

const pending = new Map(); // storeId:kind -> timestamp, to coalesce bursts of webhooks
const scheduled = new Set();

/** Starts a run limited to some groups, at most once per `gapMin` minutes per store and reason. */
function triggerRun(store, groups, trigger, gapMin) {
  const key = `${store.id}:${trigger}`;
  if (Date.now() - (pending.get(key) || 0) < gapMin * 60e3) return null;
  if (q.activeRunForStore.get(store.id)) return null;
  const ent = entitlements(store.user_id);
  if (blockReason(ent, store.id)) return null;
  pending.set(key, Date.now());
  const chosen = new Set(groups);
  for (const g of GROUPS) if (g.locked) chosen.add(g.key);
  const disabled = GROUPS.filter((g) => !chosen.has(g.key)).map((g) => g.key);
  try { return startRun({ storeId: store.id, origin: store.url, kind: 'full', password: storePassword(store), trigger, disabled }); }
  catch (e) { if (e.code === 'QUEUE_FULL') { pending.delete(key); return null; } throw e; }
}

export function shopifyRoutes(app, { requireUser, appHtml, version }) {
  // The app inside Shopify admin: our app page plus Shopify's App Bridge, loaded first as Shopify requires.
  const page = () => appHtml
    .replace('<head>', `<head>\n<meta name="shopify-api-key" content="${config.shopify.apiKey}">\n<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`)
    .replace('<body class="app">', `<body class="app embedded">\n<ui-nav-menu><a href="/shopify" rel="home">Overview</a><a href="/shopify/reports">Reports</a><a href="/shopify/publish">Safe to publish</a>${isOn('sale_plans') ? '<a href="/shopify/sales">Sale plans</a>' : ''}<a href="/shopify/catalog">Products</a>${isOn('app_health') ? '<a href="/shopify/apps">App health</a>' : ''}${isOn('sale_report') ? '<a href="/shopify/sale">Sale readiness</a>' : ''}<a href="/shopify/alerts">Alerts</a>${isOn('security_checklist') ? '<a href="/shopify/security">Security checklist</a>' : ''}${isOn('incident_mode') ? '<a href="/shopify/incident">Incident mode</a>' : ''}<a href="/shopify/suite">Test suite</a><a href="/shopify/settings">Settings</a><a href="/shopify/account">Account and plan</a><a href="/shopify/guide">How to use Tharam</a></ui-nav-menu>\n<script>window.THARAM_EMBEDDED = true;</script>`);
  const embedded = (req, res) => {
    if (!shopify.shopifyEnabled()) return res.status(503).type('text').send('The Shopify app is not configured on this server.');
    res.set('Cache-Control', 'no-store').type('html').send(page());
  };
  app.get(['/shopify', '/shopify/welcome', '/shopify/:section'], (req, res, next) => (req.params.section === 'webhooks' ? next() : embedded(req, res)));

  // First call from the embedded page: install if needed, link the account, sync the plan.
  app.post('/shopify/api/session', async (req, res) => {
    const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    let shop;
    try { ({ shop } = shopify.verifySessionToken(token)); } catch (e) { return res.status(401).json({ error: 'Open Tharam from your Shopify admin.', reauth: true }); }
    try {
      const r = await shopify.ensureShop(shop, token, { startRun, isPublic: assertPublicTarget });
      // Re-read the plan from Shopify straight away after choosing a plan, or whenever the account isn't active.
      const force = !!req.body?.welcome || !entitlements(r.userId).usable;
      await shopify.syncBilling(shop, { force }).catch((e) => console.error('billing sync', shop, e.message));
      res.json({ ok: true, shop, storeId: r.storeId, created: r.created, pricingUrl: shopify.pricingUrl(shop) });
    } catch (e) {
      console.error('shopify session failed', shop, e);
      res.status(502).json({ error: 'We couldn’t connect to your Shopify store just now. Reload the page in a minute.' });
    }
  });

  // Draft themes, for Safe to publish without copying preview links.
  app.get('/api/stores/:id/shopify/themes', requireUser, async (req, res) => {
    const s = q.storeById.get(Number(req.params.id));
    if (!s || s.user_id !== req.user.id) return res.status(404).json({ error: 'Store not found' });
    const link = shopify.shopForStore(s.id);
    if (!link) return res.json({ themes: null });
    try { res.json({ themes: await shopify.draftThemes(link.shop) }); } catch (e) { res.status(502).json({ error: 'Couldn’t load your themes from Shopify.' }); }
  });
}

// ---------- webhooks ----------
export async function shopifyWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!shopify.verifyWebhook(raw, req.get('x-shopify-hmac-sha256'))) return res.status(401).send('Invalid signature');
  const topic = String(req.get('x-shopify-topic') || '');
  const shop = String(req.get('x-shopify-shop-domain') || '').toLowerCase();
  res.status(200).send('ok'); // acknowledge quickly; work happens after
  if (!shopify.validShop(shop)) return;
  let body = {};
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch {}
  try {
    const link = db.prepare('SELECT * FROM shopify_shops WHERE shop = ?').get(shop);
    const store = link?.store_id ? q.storeById.get(link.store_id) : null;
    switch (topic) {
      case 'app/uninstalled': shopify.uninstalled(shop); break;
      case 'shop/redact': shopify.redactShop(shop); break;
      case 'customers/data_request':
      case 'customers/redact':
        // Tharam never stores customer data: test carts are anonymous and emptied. Nothing to export or delete.
        break;
      case 'app_subscriptions/update': await shopify.syncBilling(shop, { force: true }); break;
      case 'themes/publish':
        // A new live theme: check buying, errors, speed and looks straight away.
        if (store) triggerRun(store, ['journey.search', 'journey.variant', 'journey.checkout', 'errors.js', 'speed', 'visual'], 'theme-publish', 10);
        break;
      case 'products/create':
      case 'products/update':
        // A product changed (often a bulk import): run the product and price checks within minutes.
        // A bulk import sends hundreds of these; one check two minutes after the first is enough.
        if (store && has(entitlements(store.user_id), 'catalog') && !scheduled.has(store.id)) {
          scheduled.add(store.id);
          setTimeout(() => { scheduled.delete(store.id); const fresh = q.storeById.get(store.id); if (fresh) triggerRun(fresh, ['catalog'], 'product-change', 30); }, 2 * 60e3);
        }
        break;
      default: break;
    }
  } catch (e) {
    console.error('webhook failed', topic, shop, e);
  }
}
