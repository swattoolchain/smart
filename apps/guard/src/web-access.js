/**
 * Signing in with an emailed link, and browser access for stores that installed from Shopify.
 *
 * Shopify store owners never need this: inside Shopify admin they are signed in by Shopify.
 * If they want Tharam in a browser too (to share reports, or check from a phone), they add an
 * email from inside Shopify and confirm it from a one-time link. That email then signs in to the
 * same account at tharam.store/app with a link, never a password. Website users can use links too.
 *
 * Links: 32 random bytes, stored only as a SHA-256 hash, valid 30 minutes, used once.
 * The link points at /app#/signin/<token>: the token stays in the page and is sent by a POST,
 * so mail scanners that open links can't use it up.
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, q, ensureColumn } from './db.js';
import { sendMail } from './alerts.js';
import { shopForUser } from './shopify.js';

db.exec(`
CREATE TABLE IF NOT EXISTS login_links (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,              -- 'confirm' (adds browser access) | 'signin'
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);`);

// A sign-up's confirmation link carries the password chosen in that sign-up; it is set only when the link is opened.
ensureColumn('login_links', 'password_hash', 'TEXT');

const LINK_TTL = 30 * 60e3;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const S = {
  byLogin: db.prepare('SELECT * FROM users WHERE login_email = ?'),
  byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  user: db.prepare('SELECT id, email, login_email, session_epoch, email_confirmed, pending_store_url FROM users WHERE id = ?'),
  confirmUser: db.prepare('UPDATE users SET email_confirmed = 1, password_hash = COALESCE(?, password_hash), pending_store_url = NULL WHERE id = ?'),
  lastVerify: db.prepare("SELECT password_hash FROM login_links WHERE user_id = ? AND purpose = 'verify' AND used_at IS NULL AND password_hash IS NOT NULL ORDER BY expires_at DESC LIMIT 1"),
  setLogin: db.prepare('UPDATE users SET login_email = ? WHERE id = ?'),
  bump: db.prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?'),
  everLinked: db.prepare('SELECT 1 FROM shopify_shops WHERE user_id = ? LIMIT 1'),
  addLink: db.prepare('INSERT INTO login_links (token_hash, user_id, email, purpose, expires_at, password_hash) VALUES (?, ?, ?, ?, ?, ?)'),
  link: db.prepare('SELECT * FROM login_links WHERE token_hash = ?'),
  useLink: db.prepare('UPDATE login_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL'),
  dropLinks: db.prepare('DELETE FROM login_links WHERE user_id = ? AND used_at IS NULL'),
  prune: db.prepare('DELETE FROM login_links WHERE expires_at < ?'),
};

/** The account that already uses this email, either to sign up or for browser access. */
export function emailTaken(email, exceptUserId = 0) {
  const e = String(email).toLowerCase();
  const u = S.byEmail.get(e) || S.byLogin.get(e);
  return !!u && u.id !== exceptUserId;
}

/** Whether a browser session is still valid: not signed out everywhere, and the Shopify app still installed. */
export function sessionValid(req, userId) {
  const u = S.user.get(userId);
  if (!u) return { ok: false };
  if ((req.session?.ep || 0) !== (u.session_epoch || 0)) return { ok: false };
  // Accounts created by a Shopify install only work while the app is installed on that store.
  if (S.everLinked.get(userId) && !shopForUser(userId)) return { ok: false, error: 'Tharam is no longer installed on your Shopify store. Install it again from the Shopify App Store to sign in.' };
  return { ok: true };
}
export const sessionEpoch = (userId) => S.user.get(userId)?.session_epoch || 0;
/** Ends every browser session of the account; returns the new epoch for a session that should stay. */
export function bumpSessionEpoch(userId) { S.bump.run(userId); return sessionEpoch(userId); }

// A few links per account and per address, so nobody can flood an inbox.
const sent = new Map();
function allowed(key, max = 5, windowMs = 15 * 60e3) {
  const now = Date.now();
  const list = (sent.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) return false;
  list.push(now); sent.set(key, list);
  return true;
}

function issue(userId, email, purpose, passwordHash = null) {
  S.prune.run(Date.now() - 24 * 3600e3);
  const token = crypto.randomBytes(32).toString('base64url');
  S.addLink.run(sha(token), userId, email, purpose, Date.now() + LINK_TTL, passwordHash);
  return `${config.baseUrl}/app#/signin/${token}`;
}

/**
 * Website sign-up: emails a link that confirms the address. Until it is opened the account can't be used,
 * so nobody can claim someone else's email. Returns false when too many links went to the address.
 */
export function sendSignupConfirm(userId, email, passwordHash) {
  if (!allowed(`v${email}`, 3)) return false;
  const link = issue(userId, email, 'verify', passwordHash);
  sendMail({
    to: email,
    subject: 'Confirm your email to start using Tharam',
    text: `Hi,\n\nConfirm your email to finish creating your Tharam account:\n\n${link}\n\nThe link works once, for 30 minutes. If it expires, sign up again or use "Email me a sign-in link" at ${config.baseUrl}/app.\n\nIf you didn't sign up for Tharam, ignore this email and nothing happens.\n\nTharam`,
  }).catch((e) => console.error('confirm mail failed', e.message));
  return true;
}

function shopName(userId) {
  const s = shopForUser(userId);
  return s ? s.shop : null;
}

export function webAccessRoutes(app, { requireUser, isEmail, admins, onConfirmed = () => {} }) {
  // Not confirmed yet: send the confirmation link again (keeps the password chosen at sign-up).
  app.post('/api/account/confirm/resend', requireUser, (req, res) => {
    const u = S.user.get(req.user.id);
    if (u.email_confirmed) return res.json({ ok: true, confirmed: true });
    if (!allowed(`u${u.id}`, 5) || !sendSignupConfirm(u.id, u.email, S.lastVerify.get(u.id)?.password_hash || null)) return res.status(429).json({ error: 'Too many emails sent. Try again in 15 minutes.' });
    res.json({ ok: true, sentTo: u.email });
  });

  // Inside Shopify: what browser access looks like for this account.
  app.get('/api/account/web-access', requireUser, (req, res) => {
    const u = S.user.get(req.user.id);
    res.json({ shopify: !!shopForUser(req.user.id), email: u.login_email || null });
  });

  // Inside Shopify: add or change the email, and send a link to confirm it.
  app.post('/api/account/web-access', requireUser, (req, res) => {
    if (!shopForUser(req.user.id)) return res.status(400).json({ error: 'You already sign in with your email.' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
    if (admins.has(email) || emailTaken(email, req.user.id)) return res.status(409).json({ error: 'This email already has a Tharam account. Use another email, or write to hello@tharam.store and we’ll link the two.' });
    if (!allowed(`u${req.user.id}`, 5) || !allowed(`c${email}`, 5)) return res.status(429).json({ error: 'Too many emails sent. Try again in 15 minutes.' });
    const link = issue(req.user.id, email, 'confirm');
    const shop = shopName(req.user.id);
    sendMail({
      to: email,
      subject: 'Confirm your email for Tharam',
      text: `Hi,\n\nSomeone asked to open Tharam for ${shop} in a browser with this email. Confirm it and sign in here:\n\n${link}\n\nThe link works once, for 30 minutes. After that, sign in at ${config.baseUrl}/app with "Email me a sign-in link".\n\nIf you didn't ask for this, ignore this email and nothing changes.\n\nTharam`,
    }).catch((e) => console.error('web-access mail failed', e.message));
    res.json({ ok: true, sentTo: email });
  });

  // Turn browser access off: removes the email and signs out every browser.
  app.delete('/api/account/web-access', requireUser, (req, res) => {
    if (!shopForUser(req.user.id)) return res.status(400).json({ error: 'Not available for this account.' });
    S.setLogin.run(null, req.user.id);
    S.dropLinks.run(req.user.id);
    S.bump.run(req.user.id);
    res.json({ ok: true });
  });

  // From the sign-in page: email a link. The answer is the same whether or not the email has an account.
  app.post('/api/auth/link', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
    const ipKey = `i${req.ip || req.socket.remoteAddress}`;
    if (!allowed(ipKey, 10) || !allowed(`s${email}`, 3)) return res.status(429).json({ error: 'Too many links sent. Try again in 15 minutes.' });
    const u = S.byLogin.get(email) || S.byEmail.get(email);
    if (u && !(S.everLinked.get(u.id) && !shopForUser(u.id))) {
      // An account that was never confirmed: opening this link proves the address and confirms it.
      const link = issue(u.id, email, u.email_confirmed ? 'signin' : 'verify');
      sendMail({
        to: email,
        subject: 'Your Tharam sign-in link',
        text: `Hi,\n\nSign in to Tharam here:\n\n${link}\n\nThe link works once, for 30 minutes. If you didn't ask for it, ignore this email.\n\nTharam`,
      }).catch((e) => console.error('sign-in mail failed', e.message));
    }
    res.json({ ok: true });
  });

  // The link was opened: check it, use it up, sign in.
  app.post('/api/auth/link/verify', (req, res) => {
    const token = String(req.body?.token || '');
    const row = /^[\w-]{40,60}$/.test(token) ? S.link.get(sha(token)) : null;
    if (!row || row.used_at || row.expires_at < Date.now()) return res.status(400).json({ error: 'This sign-in link has expired or was already used. Ask for a new one below.' });
    const u = S.user.get(row.user_id);
    if (!u) return res.status(400).json({ error: 'This sign-in link is no longer valid.' });
    if (S.everLinked.get(u.id) && !shopForUser(u.id)) return res.status(400).json({ error: 'Tharam is no longer installed on your Shopify store. Install it again from the Shopify App Store to sign in.' });
    if (row.purpose === 'verify') {
      if (row.email !== u.email) return res.status(400).json({ error: 'This sign-in link is no longer valid.' });
      if (u.email_confirmed) return res.status(400).json({ error: 'Your email is already confirmed. Log in, or ask for a sign-in link below.' });
      if (S.useLink.run(Date.now(), row.token_hash).changes !== 1) return res.status(400).json({ error: 'This sign-in link was already used.' });
      // The mailbox owner wins: their password applies and every other session on this account ends.
      S.confirmUser.run(row.password_hash || null, u.id);
      S.dropLinks.run(u.id);
      S.bump.run(u.id);
      req.session.uid = u.id;
      req.session.ep = sessionEpoch(u.id);
      try { onConfirmed(u.id, { email: u.email, storeUrl: u.pending_store_url }); } catch (e) { console.error('after confirm', e.message); }
      return res.json({ ok: true, verified: true });
    }
    if (row.purpose === 'confirm') {
      if (admins.has(row.email) || emailTaken(row.email, u.id)) return res.status(409).json({ error: 'This email is now used by another Tharam account.' });
    } else if (row.email !== u.login_email && row.email !== u.email) {
      return res.status(400).json({ error: 'This sign-in link is no longer valid.' });
    }
    if (S.useLink.run(Date.now(), row.token_hash).changes !== 1) return res.status(400).json({ error: 'This sign-in link was already used.' });
    if (row.purpose === 'confirm') S.setLogin.run(row.email, u.id);
    req.session.uid = u.id;
    req.session.ep = u.session_epoch || 0;
    res.json({ ok: true, confirmed: row.purpose === 'confirm' });
  });
}
