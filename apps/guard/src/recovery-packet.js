/**
 * Security watch S17: the recovery packet.
 *
 * When a store may have been taken over, the owner needs two things fast:
 *  1. one tap to reset their Shopify password (the store's own admin sign-in page, where "Forgot password" is,
 *     plus Shopify's help article), and
 *  2. a ready-to-send message to Shopify Support that says what changed and when, from Tharam's own records:
 *     the last healthy check, alerts since then, checks that broke, theme and product changes, and what the
 *     owner already did in incident mode.
 * Nothing is sent by Tharam: the owner copies the message or downloads it.
 */
import { db, q } from './db.js';
import { changesSinceHealthy, activeIncident, STEPS } from './incident.js';
import './shopify.js'; // creates shopify_shops

export const SHOPIFY_HELP = {
  resetPassword: 'https://help.shopify.com/en/manual/your-account/logging-in/reset-password',
  support: 'https://help.shopify.com/en/questions',
  unauthorized: 'https://help.shopify.com/en/manual/your-account/resolving-unauth-use-of-email',
};

const lastIncident = db.prepare('SELECT * FROM incidents WHERE store_id = ? ORDER BY id DESC LIMIT 1');
const shopRow = db.prepare('SELECT shop FROM shopify_shops WHERE store_id = ? ORDER BY installed_at DESC LIMIT 1');

const utc = (ts) => {
  if (!ts) return '';
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : String(ts).replace(' ', 'T') + 'Z');
  return isNaN(d) ? String(ts) : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

/** The packet for one store. `shopify`: whether it runs on Shopify (else general wording). */
export function recoveryPacket(store, { shopify = false } = {}) {
  const host = new URL(store.url).host;
  const shop = shopRow.get(store.id)?.shop || null;
  const name = store.name || host;
  const owner = q.userById.get(store.user_id);
  const c = changesSinceHealthy(store.id, activeIncident(store.id)?.healthy_run_id || null);
  const inc = lastIncident.get(store.id);
  const done = inc ? Object.keys(JSON.parse(inc.steps_json)) : [];

  // What changed and when, oldest first, in plain words.
  const timeline = [];
  if (c.healthy) timeline.push({ at: c.healthy.created_at, text: 'Last check where everything worked (Tharam monitoring).' });
  for (const a of [...(c.alerts || [])].reverse()) timeline.push({ at: a.at, text: `Alert: ${a.title}. ${a.message || ''}`.trim() });
  if (inc) timeline.push({ at: inc.started_at, text: `I switched on incident mode${inc.reason ? `: ${inc.reason}` : ''}.` });
  if (c.latest && (!c.healthy || c.latest.id !== c.healthy.id)) timeline.push({ at: c.latest.created_at, text: 'Latest check (Tharam monitoring).' });
  timeline.sort((x, y) => Date.parse(x.at.includes('T') ? x.at : x.at.replace(' ', 'T') + 'Z') - Date.parse(y.at.includes('T') ? y.at : y.at.replace(' ', 'T') + 'Z'));

  const changed = [
    ...(c.broken || []).map((b) => `${b.title}: ${b.detail}`),
    ...(c.theme ? [`The published theme changed from "${c.theme.before}" to "${c.theme.after}".`] : []),
    ...(c.products ? [`Products changed: ${c.products.totals.changed} edited, ${c.products.totals.added} added, ${c.products.totals.removed} removed, ${c.products.totals.price} with new prices.`, ...c.products.examples.slice(0, 5).map((x) => `  ${x.title}: ${x.detail}`)] : []),
    ...(c.looks || []).map((l) => `The ${l.key.replace('-', ' page on ')} looks different (${l.ratio}% of the page changed).`),
  ];
  const stepsDone = STEPS.filter((s) => done.includes(s.key)).map((s) => s.title);

  const platform = shopify ? 'Shopify' : 'store platform';
  const subject = `Possible unauthorized access to ${shop || host}`;
  const lines = [
    `Hello ${shopify ? 'Shopify Support' : 'Support team'},`,
    '',
    `I think someone may have accessed my store without my permission. Please help me secure it and check recent sign-ins and changes.`,
    '',
    `Store: ${name}`,
    `Store address: ${host}${shop && shop !== host ? ` (${shop})` : ''}`,
    `Account email: ${owner?.email || ''}`,
    '',
    'What happened and when (times in UTC):',
    ...(timeline.length ? timeline.map((x) => `- ${utc(x.at)}: ${x.text}`) : ['- I have no monitoring history before this happened.']),
    '',
    'What changed since the last time everything worked:',
    ...(changed.length ? changed.map((x) => (x.startsWith('  ') ? x : `- ${x}`)) : [c.healthy ? '- Our monitoring has not seen other changes yet.' : `- ${c.note}`]),
    '',
    'What I have done so far:',
    ...(stepsDone.length ? stepsDone.map((s) => `- ${s}`) : ['- Nothing yet: I am contacting you first.']),
    '',
    'Please:',
    '- check the sign-ins to my account and my staff accounts over the last days,',
    '- tell me which staff accounts, apps, theme or payout changes were made and by whom,',
    '- help me lock the account and undo anything I did not do.',
    '',
    'Thank you.',
    '',
    `(Times and changes from Tharam store monitoring.)`,
  ];
  return {
    store: { name, host, shop },
    reset: {
      // The store's own admin address opens the sign-in page, which has "Forgot password".
      url: `https://${shop || host}/admin`,
      help: shopify ? SHOPIFY_HELP.resetPassword : null,
      steps: shopify
        ? ['Open your store\'s sign-in page.', 'Choose "Forgot password?" and enter your account email.', 'Use the link Shopify emails you to set a new, unique password.', 'Then sign out of all devices and check two-step login is on.']
        : [`Open your ${platform} sign-in page and reset your password.`, 'Then sign out of all devices and turn on two-step login.'],
    },
    support: shopify ? { url: SHOPIFY_HELP.support, unauthorized: SHOPIFY_HELP.unauthorized } : null,
    message: { subject, text: lines.join('\n') },
    basis: { healthyAt: c.healthy?.created_at || null, latestAt: c.latest?.created_at || null, alerts: (c.alerts || []).length, changes: changed.length, incident: inc ? { startedAt: inc.started_at, endedAt: inc.ended_at } : null },
  };
}
