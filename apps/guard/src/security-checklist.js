/**
 * Security watch S11: an owner-ticked security checklist per store, with a score and reminders.
 *
 * Tharam can't see inside a store's admin, so these are things the owner does and ticks off. Reviews
 * (staff, apps) come due again after 90 days; one-off settings are confirmed again once a year.
 * Reminder emails: at most one every 30 days per store, only while something is due, and never when the
 * owner switched them off.
 */
import { db, q } from './db.js';
import { config } from './config.js';
import { sendMail } from './alerts.js';

db.exec(`
CREATE TABLE IF NOT EXISTS security_checklist (
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  done_at TEXT NOT NULL,
  PRIMARY KEY (store_id, item)
);
CREATE TABLE IF NOT EXISTS security_settings (
  store_id INTEGER PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  reminders INTEGER NOT NULL DEFAULT 1,
  last_reminder_at TEXT
);
`);

const DAY = 24 * 3600 * 1000;
export const REMINDER_EVERY_DAYS = 30;
export const FIRST_REMINDER_AFTER_DAYS = 3; // give a new store a few days before the first nudge

/**
 * The checklist. `weight` adds up to 100. `every`: days until it should be confirmed again.
 * `how.shopify` / `how.other`: where to do it.
 */
export const ITEMS = [
  {
    key: 'two_step', weight: 25, every: 180,
    title: 'Two-step login is on for you and every staff account',
    why: 'A stolen password alone is then not enough to get into your store. This stops most break-ins.',
    how: {
      shopify: 'In Shopify admin open Settings → Users → Security and turn on two-step authentication (an authenticator app is safer than text messages). Then ask every staff member to do the same; the Users list shows who has it.',
      other: 'In your store admin, turn on two-step login for your own account, then for every staff account.',
    },
  },
  {
    key: 'email_2fa', weight: 15, every: 365,
    title: 'The email you sign in with has two-step login too',
    why: 'Whoever controls that mailbox can reset your store password.',
    how: {
      shopify: 'Turn on two-step login in your email account (Gmail, Outlook and others all have it), and check the recovery phone number and email are yours.',
      other: 'Turn on two-step login in your email account, and check the recovery phone number and email are yours.',
    },
  },
  {
    key: 'passwords', weight: 10, every: 365,
    title: 'Strong passwords, different for every account, kept in a password manager',
    why: 'A password reused on another site leaks when that site is hacked.',
    how: {
      shopify: 'Use a password manager to give your Shopify, email, domain and payment accounts long passwords that you use nowhere else.',
      other: 'Use a password manager to give your store, email, domain and payment accounts long passwords that you use nowhere else.',
    },
  },
  {
    key: 'staff_review', weight: 15, every: 90,
    title: 'Staff accounts reviewed',
    why: 'Old accounts of people who left, and staff with more access than they need, are an easy way in.',
    how: {
      shopify: 'In Shopify admin open Settings → Users. Remove anyone who no longer works with you, and give everyone else only the permissions they need.',
      other: 'In your store admin, remove accounts of people who no longer work with you and limit what everyone else can change.',
    },
  },
  {
    key: 'app_review', weight: 15, every: 90,
    title: 'Installed apps reviewed',
    why: 'Every app can read or change parts of your store. Apps you don\'t use only add risk and slow your store down.',
    how: {
      shopify: 'In Shopify admin open Settings → Apps. Uninstall apps you no longer use, and also remove their leftover code from your theme if the app asks you to.',
      other: 'In your store admin, remove plugins and apps you no longer use, and keep the rest up to date.',
    },
  },
  {
    key: 'collaborators', weight: 10, every: 365,
    title: 'Agencies and freelancers need your code to ask for access',
    why: 'Without a request code anyone can ask for access to your store, and a request is easy to approve by mistake.',
    how: {
      shopify: 'In Shopify admin open Settings → Users → Security → Collaborators and choose "Only people with a collaborator request code". Share the code only with people you hire.',
      other: 'Give agencies and freelancers their own accounts with limited access, never your own login, and remove them when the work is done.',
    },
  },
  {
    key: 'domain_lock', weight: 10, every: 365,
    title: 'Your domain account has two-step login and auto-renew',
    why: 'Whoever controls your domain controls where shoppers and your email go.',
    how: {
      shopify: 'Sign in where you bought your domain (or Settings → Domains in Shopify if you bought it there). Turn on two-step login, auto-renew and the transfer lock.',
      other: 'Sign in where you bought your domain. Turn on two-step login, auto-renew and the transfer lock.',
    },
  },
];
const BY_KEY = new Map(ITEMS.map((i) => [i.key, i]));
export const isItem = (key) => BY_KEY.has(key);

const Q = {
  done: db.prepare('SELECT item, done_at FROM security_checklist WHERE store_id = ?'),
  tick: db.prepare('INSERT INTO security_checklist (store_id, item, done_at) VALUES (?, ?, ?) ON CONFLICT(store_id, item) DO UPDATE SET done_at = excluded.done_at'),
  untick: db.prepare('DELETE FROM security_checklist WHERE store_id = ? AND item = ?'),
  settings: db.prepare('SELECT reminders, last_reminder_at FROM security_settings WHERE store_id = ?'),
  setReminders: db.prepare('INSERT INTO security_settings (store_id, reminders) VALUES (?, ?) ON CONFLICT(store_id) DO UPDATE SET reminders = excluded.reminders'),
  reminded: db.prepare('INSERT INTO security_settings (store_id, last_reminder_at) VALUES (?, ?) ON CONFLICT(store_id) DO UPDATE SET last_reminder_at = excluded.last_reminder_at'),
  stores: db.prepare('SELECT * FROM stores ORDER BY id'),
};

const iso = (ms) => new Date(ms).toISOString();
const sqlTime = (s) => (s ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z') : NaN);

/** The checklist for a store, as the owner sees it. */
export function checklist(store, { now = Date.now(), shopify = false } = {}) {
  const done = new Map(Q.done.all(store.id).map((r) => [r.item, r.done_at]));
  const st = Q.settings.get(store.id) || { reminders: 1, last_reminder_at: null };
  const items = ITEMS.map((i) => {
    const at = done.get(i.key) || null;
    const dueAt = at ? iso(Date.parse(at) + i.every * DAY) : null;
    const state = !at ? 'todo' : Date.parse(dueAt) <= now ? 'due' : 'done';
    return { key: i.key, title: i.title, why: i.why, how: shopify ? i.how.shopify : i.how.other, weight: i.weight, every: i.every, doneAt: at, dueAt, state };
  });
  const score = items.reduce((n, i) => n + (i.state === 'done' ? i.weight : 0), 0);
  const open = items.filter((i) => i.state !== 'done');
  return {
    items,
    score,
    grade: score >= 90 ? 'Well protected' : score >= 60 ? 'Good start' : 'Needs work',
    counts: { done: items.length - open.length, todo: items.filter((i) => i.state === 'todo').length, due: items.filter((i) => i.state === 'due').length, total: items.length },
    reminders: !!st.reminders,
    lastReminderAt: st.last_reminder_at,
  };
}

export function tick(storeId, item, done, now = Date.now()) {
  if (!isItem(item)) return false;
  if (done) Q.tick.run(storeId, item, iso(now));
  else Q.untick.run(storeId, item);
  return true;
}

export function setReminders(storeId, on) {
  Q.setReminders.run(storeId, on ? 1 : 0);
}

/** The reminder email for one store, or null when nothing is due or it isn't time yet. */
export function reminderFor(store, { now = Date.now(), shopify = false } = {}) {
  const c = checklist(store, { now, shopify });
  if (!c.reminders || !store.monitoring) return null;
  const open = c.items.filter((i) => i.state !== 'done');
  if (!open.length) return null;
  const last = c.lastReminderAt ? Date.parse(c.lastReminderAt) : null;
  if (last && now - last < REMINDER_EVERY_DAYS * DAY) return null;
  if (!last && now - sqlTime(store.created_at) < FIRST_REMINDER_AFTER_DAYS * DAY) return null;
  const name = store.name || new URL(store.url).host;
  const link = `${config.baseUrl}/app#/s/${store.id}/security`;
  const lines = open.map((i) => `${i.state === 'due' ? 'Review again' : 'To do'}: ${i.title}\n   ${i.how}`);
  const subject = `Security checklist for ${name}: ${c.score} of 100`;
  const text = `Your security checklist for ${name} is at ${c.score} of 100 (${c.grade}). ${open.length === 1 ? 'One thing is' : `${open.length} things are`} waiting:\n\n${lines.join('\n\n')}\n\nTick them off here: ${link}\n\nYou get this reminder at most once a month while something is open. Switch it off on the same page.\n\n— Tharam Store Guard`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1917">
<p>Your security checklist for <b>${esc(name)}</b> is at <b>${c.score} of 100</b> (${esc(c.grade)}).</p>
${open.map((i) => `<p><b>${i.state === 'due' ? 'Review again' : 'To do'}: ${esc(i.title)}</b><br>${esc(i.how)}</p>`).join('')}
<p><a href="${link}" style="background:#14532d;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open the checklist</a></p>
<p style="color:#78716c;font-size:13px">At most once a month while something is open. You can switch these reminders off on the checklist page.</p></div>`;
  const to = store.alert_email || q.userById.get(store.user_id)?.email;
  return { to, subject, text, html };
}

/** Sends due reminders for every store. Called by the scheduler; safe to call often. */
export async function sendChecklistReminders({ now = Date.now(), isShopify = () => false, send = sendMail } = {}) {
  let sent = 0;
  for (const store of Q.stores.all()) {
    const m = reminderFor(store, { now, shopify: isShopify(store) });
    if (!m || !m.to) continue;
    // Recorded before sending, so a slow or failing mail server can never cause repeats.
    Q.reminded.run(store.id, iso(now));
    try { await send(m); sent++; } catch (e) { console.error('checklist reminder failed', store.id, e.message); }
  }
  return sent;
}
