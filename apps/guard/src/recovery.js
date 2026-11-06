/**
 * Recovery console (S14): getting back into your reports when your normal way in is gone.
 *
 * Example: a hacked Shopify store whose app was uninstalled, or an owner who lost access to a Shopify admin.
 * The owner makes a recovery code ahead of time (Account > Security). At tharam.store/recover they ask for a
 * link, open it, and type the code. Both are needed. They get a read-only session: reports, incident mode,
 * the recovery packet and the clean theme download. Nothing can be changed from it.
 *
 *  - The code is optional and shown once. Only a hash is stored. Making a new one ends the old one (and
 *    any recovery session opened with it).
 *  - The link goes to the account email and the confirmed browser-access email, never to a store's alert
 *    email (that mailbox may be the one the attacker controls). It works once, for 30 minutes, and the token
 *    is sent by a POST from the page so mail scanners can't use it up.
 *  - Shopify accounts can recover from the day the app is removed until Shopify's shop/redact deletes the
 *    account (about 48 hours later). After that the account is gone, so there is nothing to recover.
 *  - Five wrong codes lock recovery for 30 minutes and cancel the open links.
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, q } from './db.js';
import { sendMail } from './alerts.js';
import { audit as auditLog } from './license.js';
import { requireFeature } from './features.js';

db.exec(`
CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  failed INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS recovery_links (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);`);

const audit = (userId, action, detail) => auditLog('recovery', userId, action, detail);
const LINK_TTL = 30 * 60e3;
const SESSION_TTL = 60 * 60e3;
const MAX_WRONG = 5;
// Per 15 minutes. The environment can raise them (tests only); the defaults are the real limits.
const LIMIT = { startIp: Number(process.env.RECOVER_START_PER_IP) || 10, startEmail: Number(process.env.RECOVER_LINKS_PER_EMAIL) || 3, verifyIp: Number(process.env.RECOVER_VERIFY_PER_IP) || 15 };
const LOCK_FOR = 30 * 60e3;
// No look-alike letters (0/O, 1/I/L): the code is read from paper.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
const S = {
  code: db.prepare('SELECT * FROM recovery_codes WHERE user_id = ?'),
  putCode: db.prepare(`INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, version = version + 1, created_at = datetime('now'), failed = 0, locked_until = 0`),
  dropCode: db.prepare('DELETE FROM recovery_codes WHERE user_id = ?'),
  wrong: db.prepare('UPDATE recovery_codes SET failed = failed + 1, locked_until = CASE WHEN failed + 1 >= ? THEN ? ELSE locked_until END WHERE user_id = ?'),
  clearWrong: db.prepare('UPDATE recovery_codes SET failed = 0, locked_until = 0 WHERE user_id = ?'),
  addLink: db.prepare('INSERT INTO recovery_links (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  link: db.prepare('SELECT * FROM recovery_links WHERE token_hash = ?'),
  useLink: db.prepare('UPDATE recovery_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL'),
  dropLinks: db.prepare('DELETE FROM recovery_links WHERE user_id = ? AND used_at IS NULL'),
  prune: db.prepare('DELETE FROM recovery_links WHERE expires_at < ?'),
  byEmail: db.prepare('SELECT * FROM users WHERE lower(email) = ? OR lower(login_email) = ?'),
  user: db.prepare('SELECT * FROM users WHERE id = ?'),
};

/** A new code, like K7QM-3XPD-9TCH-WB4N (about 78 bits). */
function newCode() {
  const bytes = crypto.randomBytes(16);
  const chars = Array.from({ length: 16 }, (_, i) => ALPHABET[bytes[i] % ALPHABET.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}
const normalize = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
// 0, 1, O, I, L are not in the alphabet, so mapping them can't make a wrong code match.
const hashCode = (userId, code) => sha(`recovery:${userId}:${normalize(code)}`);
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// A few tries per address and per email, so nobody can flood an inbox or guess.
const tries = new Map();
function allowed(key, max, windowMs = 15 * 60e3) {
  const now = Date.now();
  const list = (tries.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) return false;
  list.push(now); tries.set(key, list);
  return true;
}

/** Where the recovery link may go: the account email and the confirmed browser-access email. Not alert emails. */
export function recoveryRecipients(user) {
  const seen = new Set();
  return [user?.email, user?.login_email].filter((e) => isEmail(e) && !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()));
}

/** Whether an account may recover now. (A Shopify account is deleted by shop/redact, so it is gone after that.) */
function eligible(user, admins) {
  if (!user || !user.email_confirmed) return false;
  if (admins.has(String(user.email).toLowerCase())) return false; // founder accounts are never recovered this way
  const c = S.code.get(user.id);
  return !!c && c.locked_until <= Date.now();
}

// ---------- recovery sessions ----------

/** The signed-in recovery session of this request, or null. Ends when the hour is up, the code changes or is removed. */
export function recoverySession(req) {
  const r = req.session?.recover;
  if (!r || req.session?.uid) return null;
  if (!r.exp || r.exp < Date.now()) return null;
  const c = S.code.get(r.uid);
  const user = c && S.user.get(r.uid);
  if (!user || c.version !== r.ver) return null;
  return user;
}

/**
 * What a recovery session may read. Everything else, and every change, answers 403.
 * Reports, incident mode, the recovery packet and the clean theme copy: nothing that changes the store or the account.
 */
const RECOVERY_READ = [
  /^\/api\/me$/,
  /^\/api\/overview$/,
  /^\/api\/catalog$/,
  /^\/api\/stores$/,
  /^\/api\/runs\/\d+$/,
  /^\/api\/stores\/\d+\/(incident|recovery-packet|recovery-packet\.txt|scorecard|runs|reports|compare)$/,
  /^\/api\/stores\/\d+\/theme\/clean(\.zip|\/file)?$/,
];
export const recoveryMay = (method, path) => (method === 'GET' || method === 'HEAD') && RECOVERY_READ.some((r) => r.test(path));

// ---------- routes ----------

export function recoveryRoutes(app, { requireUser, admins }) {
  // The page asks first, so a switched-off feature shows "not available" instead of a form that can't work.
  app.get('/api/recover', requireFeature('recovery'), (req, res) => res.json({ ok: true }));

  // ----- Account > Security: the owner's code -----
  const ownerOnly = (req, res) => {
    if (req.recovery) { res.status(403).json({ error: 'Recovery sessions are read-only.' }); return false; }
    if (req.member) { res.status(403).json({ error: 'Only the account owner can manage the recovery code.' }); return false; }
    return true;
  };
  app.get('/api/account/recovery', requireUser, requireFeature('recovery'), (req, res) => {
    if (!ownerOnly(req, res)) return;
    const c = S.code.get(req.user.id);
    res.json({ hasCode: !!c, createdAt: c?.created_at || null, sendsTo: recoveryRecipients(req.user) });
  });
  app.post('/api/account/recovery/code', requireUser, requireFeature('recovery'), (req, res) => {
    if (!ownerOnly(req, res)) return;
    const code = newCode();
    const replaced = !!S.code.get(req.user.id);
    S.putCode.run(req.user.id, hashCode(req.user.id, code));
    S.dropLinks.run(req.user.id); // links asked for under the old code are no use
    audit(req.user.id, replaced ? 'code.replaced' : 'code.created');
    // Shown once. Only a hash is kept.
    res.set('Cache-Control', 'no-store').json({ ok: true, code, replaced, sendsTo: recoveryRecipients(req.user) });
  });
  app.delete('/api/account/recovery/code', requireUser, requireFeature('recovery'), (req, res) => {
    if (!ownerOnly(req, res)) return;
    S.dropCode.run(req.user.id);
    S.dropLinks.run(req.user.id);
    audit(req.user.id, 'code.removed');
    res.json({ ok: true });
  });

  // ----- /recover: ask for a link -----
  // The answer is always the same, whether or not the email has an account with a recovery code.
  app.post('/api/recover/start', requireFeature('recovery'), (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });
    if (!allowed(`i${req.ip || req.socket.remoteAddress}`, LIMIT.startIp) || !allowed(`e${email}`, LIMIT.startEmail)) return res.status(429).json({ error: 'Too many requests. Try again in 15 minutes.' });
    const user = S.byEmail.all(email, email).find((u) => eligible(u, admins));
    if (user) {
      const to = recoveryRecipients(user);
      if (to.length) {
        S.prune.run(Date.now() - 24 * 3600e3);
        const token = crypto.randomBytes(32).toString('base64url');
        S.addLink.run(sha(token), user.id, Date.now() + LINK_TTL);
        const link = `${config.baseUrl}/app#/recover/${token}`;
        audit(user.id, 'link.sent', { to });
        sendMail({
          to: to.join(', '),
          subject: 'Get back into your Tharam reports',
          text: `Hi,\n\nSomeone asked to open your Tharam account in recovery mode. If it was you, open this link and type your recovery code:\n\n${link}\n\nThe link works once, for 30 minutes. In recovery mode you can read your reports, use incident mode, get the recovery message for Shopify support and download the clean copy of your theme. Nothing can be changed from it.\n\nIf you didn't ask for this, ignore this email. Without your recovery code, the link does nothing.\n\nTharam`,
        }).catch((e) => console.error('recovery mail failed', e.message));
      }
    }
    res.json({ ok: true });
  });

  // ----- /recover: the link and the code together open a read-only session -----
  app.post('/api/recover/verify', requireFeature('recovery'), (req, res) => {
    const token = String(req.body?.token || '');
    const bad = () => res.status(400).json({ error: 'This link has expired or was already used. Ask for a new one.' });
    if (!allowed(`v${req.ip || req.socket.remoteAddress}`, LIMIT.verifyIp)) return res.status(429).json({ error: 'Too many tries. Try again in 15 minutes.' });
    const row = /^[\w-]{40,60}$/.test(token) ? S.link.get(sha(token)) : null;
    if (!row || row.used_at || row.expires_at < Date.now()) return bad();
    const user = S.user.get(row.user_id);
    const c = user && S.code.get(user.id);
    if (!user || !c) return bad();
    if (c.locked_until > Date.now()) return res.status(429).json({ error: 'Too many wrong codes. Recovery is paused for 30 minutes.' });
    if (!req.body?.code || !sameHash(hashCode(user.id, req.body.code), c.code_hash)) {
      S.wrong.run(MAX_WRONG, Date.now() + LOCK_FOR, user.id);
      const now = S.code.get(user.id);
      audit(user.id, 'code.wrong', { failed: now.failed });
      if (now.locked_until > Date.now()) {
        S.dropLinks.run(user.id);
        audit(user.id, 'locked');
        return res.status(429).json({ error: 'Too many wrong codes. Recovery is paused for 30 minutes.' });
      }
      return res.status(401).json({ error: `That code isn’t right. ${MAX_WRONG - now.failed} ${MAX_WRONG - now.failed === 1 ? 'try' : 'tries'} left.` });
    }
    if (S.useLink.run(Date.now(), row.token_hash).changes !== 1) return bad();
    S.clearWrong.run(user.id);
    S.dropLinks.run(user.id);
    // A read-only session: it is not a login (no `uid`), so no other route accepts it.
    req.session = { recover: { uid: user.id, ver: c.version, exp: Date.now() + SESSION_TTL } };
    audit(user.id, 'session.opened');
    const to = recoveryRecipients(user);
    if (to.length) {
      sendMail({
        to: to.join(', '),
        subject: 'Your Tharam account was opened in recovery mode',
        text: `Hi,\n\nYour Tharam account was just opened in recovery mode with your recovery code. It is read-only and lasts one hour.\n\nIf this wasn't you, sign in to Tharam, go to Account > Security and make a new recovery code. The old one stops working at once.\n\nTharam`,
      }).catch((e) => console.error('recovery notice failed', e.message));
    }
    res.json({ ok: true });
  });
}
