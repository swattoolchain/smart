/**
 * Agency workspaces (roadmap 13, part 2): team members on one website account, with roles.
 *
 *   owner  – the account itself: everything, including billing and the team.
 *   admin  – works on the account's stores: add, change, remove, run checks, approve looks.
 *            Not billing, not the team, not the owner's profile or password.
 *   viewer – sees the account's stores and reports and downloads exports. Changes nothing.
 *
 * A member signs in with their own Tharam login and switches into the workspace. While they work there,
 * requests act as the account (so every existing ownership check applies unchanged) and `req.member`
 * says who they really are and what they may do. Removing a member ends their access on the next request.
 * Website accounts only: Shopify stores add staff in Shopify admin.
 */
import crypto from 'node:crypto';
import { db, q } from './db.js';
import { config } from './config.js';
import { sendMail } from './alerts.js';
import { shopForUser } from './shopify.js';
import { audit as auditLog } from './license.js';
import { requireFeature } from './features.js';

const audit = (accountId, action, detail) => auditLog('team', accountId, action, detail);

db.exec(`
CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  invited_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, user_id)
);
CREATE TABLE IF NOT EXISTS team_invites (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS team_members_user ON team_members(user_id);
`);

export const ROLES = ['admin', 'viewer'];

/**
 * Credentials a viewer never sees: release-gate keys (`token`), the Slack webhook address and any signing
 * secret (`secret`, e.g. the store's webhook secret). They are set to null in every JSON answer to a viewer.
 */
const VIEWER_HIDDEN = new Set(['token', 'slack_webhook', 'secret']);
export function redactForViewer(value) {
  if (Array.isArray(value)) return value.map(redactForViewer);
  if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = VIEWER_HIDDEN.has(k) ? (v == null ? v : null) : redactForViewer(v);
  return out;
}

/**
 * New release-gate keys for every environment of the account's stores. Run when someone leaves the team or
 * becomes a viewer, so a key they copied stops working.
 */
export function rotateGateKeys(accountId) {
  const envs = db.prepare('SELECT e.id FROM environments e JOIN stores s ON s.id = e.store_id WHERE s.user_id = ?').all(accountId);
  const set = db.prepare('UPDATE environments SET token = ? WHERE id = ?');
  db.transaction(() => { for (const e of envs) set.run('tg_' + crypto.randomBytes(18).toString('base64url'), e.id); })();
  return envs.length;
}
export const TEAM_LIMIT = 10; // members plus open invites per account
const INVITE_DAYS = 7;
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length < 200;

const T = {
  member: db.prepare('SELECT * FROM team_members WHERE account_id = ? AND user_id = ?'),
  memberById: db.prepare('SELECT * FROM team_members WHERE id = ? AND account_id = ?'),
  members: db.prepare('SELECT m.id, m.role, m.created_at, u.email, u.name FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.account_id = ? ORDER BY m.id'),
  workspaces: db.prepare('SELECT m.account_id, m.role, u.email, u.name FROM team_members m JOIN users u ON u.id = m.account_id WHERE m.user_id = ? ORDER BY m.id'),
  openInvites: db.prepare("SELECT id, email, role, created_at, expires_at FROM team_invites WHERE account_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > datetime('now') ORDER BY id"),
  inviteByHash: db.prepare('SELECT * FROM team_invites WHERE token_hash = ?'),
  insertInvite: db.prepare('INSERT INTO team_invites (account_id, email, role, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)'),
  revokeInvite: db.prepare("UPDATE team_invites SET revoked_at = datetime('now') WHERE id = ? AND account_id = ? AND accepted_at IS NULL"),
  revokeSameEmail: db.prepare("UPDATE team_invites SET revoked_at = datetime('now') WHERE account_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL"),
  acceptInvite: db.prepare("UPDATE team_invites SET accepted_at = datetime('now') WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL"),
  insertMember: db.prepare('INSERT INTO team_members (account_id, user_id, role, invited_by) VALUES (?, ?, ?, ?) ON CONFLICT (account_id, user_id) DO UPDATE SET role = excluded.role'),
  setRole: db.prepare('UPDATE team_members SET role = ? WHERE id = ? AND account_id = ?'),
  removeMember: db.prepare('DELETE FROM team_members WHERE id = ? AND account_id = ?'),
  leave: db.prepare('DELETE FROM team_members WHERE account_id = ? AND user_id = ?'),
};

/** Website accounts only: an account created by (or linked to) a Shopify install has no team. */
export const teamAllowed = (userId) => !shopForUser(userId) && !db.prepare('SELECT 1 FROM shopify_shops WHERE user_id = ? LIMIT 1').get(userId);
export const membership = (accountId, userId) => (accountId && userId && accountId !== userId ? T.member.get(accountId, userId) || null : null);

/**
 * What a member may do. Everything not listed is the owner's alone (billing, team, profile, password,
 * browser access, founder console).
 */
const READ = [/^\/api\/me$/, /^\/api\/overview$/, /^\/api\/stores(\/.*)?$/, /^\/api\/runs\/\d+$/, /^\/api\/catalog$/];
const SELF = [/^\/api\/team\/(workspaces|switch|leave|join)$/, /^\/api\/auth\/logout$/];
const EDIT = [/^\/api\/stores(\/.*)?$/, /^\/api\/discover$/];
export function memberMay(role, method, path) {
  if (SELF.some((r) => r.test(path))) return true;
  if (method === 'GET' || method === 'HEAD') return READ.some((r) => r.test(path));
  return role === 'admin' && EDIT.some((r) => r.test(path));
}

/** Who may act: the account owner (no member) or an admin member. */
const ownerOnly = (req, res) => {
  if (req.member) { res.status(403).json({ error: 'Only the account owner can manage the team.' }); return false; }
  if (!teamAllowed(req.user.id)) { res.status(403).json({ error: 'Team members are for website accounts. For your Shopify store, add staff in your Shopify admin.' }); return false; }
  return true;
};

export function teamRoutes(app, { requireUser }) {
  app.get('/api/team', requireUser, requireFeature('teams'), (req, res) => {
    if (!ownerOnly(req, res)) return;
    res.json({ members: T.members.all(req.user.id), invites: T.openInvites.all(req.user.id), roles: ROLES, limit: TEAM_LIMIT });
  });

  app.post('/api/team/invites', requireUser, requireFeature('teams'), async (req, res) => {
    if (!ownerOnly(req, res)) return;
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = String(req.body?.role || '');
    if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Choose a role: admin or viewer.' });
    if (email === req.user.email.toLowerCase()) return res.status(400).json({ error: 'That is your own email. You already have full access.' });
    const existing = q.userByEmail.get(email);
    if (existing && T.member.get(req.user.id, existing.id)) return res.status(409).json({ error: 'This person is already in your team. Change their role instead.' });
    T.revokeSameEmail.run(req.user.id, email); // a new invite replaces an older one to the same address
    if (T.members.all(req.user.id).length + T.openInvites.all(req.user.id).length >= TEAM_LIMIT) return res.status(400).json({ error: `A team can have up to ${TEAM_LIMIT} people, including open invites.` });
    const token = crypto.randomBytes(24).toString('base64url');
    const expires = new Date(Date.now() + INVITE_DAYS * 86400e3).toISOString().replace('T', ' ').slice(0, 19);
    const info = T.insertInvite.run(req.user.id, email, role, hash(token), expires);
    const who = req.user.name ? `${req.user.name} (${req.user.email})` : req.user.email;
    const link = `${config.baseUrl}/app#/join/${token}`;
    await sendMail({
      to: email,
      subject: `${req.user.name || req.user.email} invited you to their Tharam workspace`,
      text: `${who} invited you to their Tharam workspace as ${role === 'admin' ? 'an admin (you can manage stores and run checks)' : 'a viewer (you can see stores and reports)'}.\n\nAccept the invite:\n${link}\n\nSign in or create a free Tharam login with this email address (${email}). The link works once and expires in ${INVITE_DAYS} days.\n\nIf you weren't expecting this, you can ignore this email.`,
    }).catch(() => {});
    audit(req.user.id, 'team.invite', { email, role });
    res.json({ invite: { id: Number(info.lastInsertRowid), email, role, expires_at: expires } });
  });

  app.delete('/api/team/invites/:inviteId', requireUser, requireFeature('teams'), (req, res) => {
    if (!ownerOnly(req, res)) return;
    const r = T.revokeInvite.run(Number(req.params.inviteId), req.user.id);
    if (!r.changes) return res.status(404).json({ error: 'Invite not found' });
    audit(req.user.id, 'team.invite.revoke', { id: Number(req.params.inviteId) });
    res.json({ ok: true });
  });

  app.patch('/api/team/members/:memberId', requireUser, requireFeature('teams'), (req, res) => {
    if (!ownerOnly(req, res)) return;
    const role = String(req.body?.role || '');
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Choose a role: admin or viewer.' });
    const m = T.memberById.get(Number(req.params.memberId), req.user.id);
    if (!m) return res.status(404).json({ error: 'Team member not found' });
    T.setRole.run(role, m.id, req.user.id);
    const rotated = m.role === 'admin' && role === 'viewer' ? rotateGateKeys(req.user.id) : 0;
    audit(req.user.id, 'team.role', { member: m.user_id, from: m.role, to: role, rotatedKeys: rotated });
    res.json({ ok: true });
  });

  app.delete('/api/team/members/:memberId', requireUser, requireFeature('teams'), (req, res) => {
    if (!ownerOnly(req, res)) return;
    const m = T.memberById.get(Number(req.params.memberId), req.user.id);
    if (!m) return res.status(404).json({ error: 'Team member not found' });
    T.removeMember.run(m.id, req.user.id);
    const rotated = rotateGateKeys(req.user.id);
    audit(req.user.id, 'team.remove', { member: m.user_id, rotatedKeys: rotated });
    res.json({ ok: true, rotatedKeys: rotated });
  });

  // ----- As a member -----
  /** Accepting an invite: signed in with the invited email. The real person, never the workspace they are in. */
  app.post('/api/team/join', requireUser, requireFeature('teams'), (req, res) => {
    const me = req.member?.user || req.user;
    const inv = T.inviteByHash.get(hash(String(req.body?.token || '')));
    const gone = !inv || inv.accepted_at || inv.revoked_at || new Date(inv.expires_at.replace(' ', 'T') + 'Z') < new Date();
    if (gone) return res.status(410).json({ error: 'This invite has expired or was already used. Ask for a new one.' });
    if (inv.email !== me.email.toLowerCase()) return res.status(403).json({ error: `This invite is for ${inv.email}. Sign in with that email to accept it.` });
    if (inv.account_id === me.id) return res.status(400).json({ error: 'You cannot join your own workspace.' });
    if (!teamAllowed(inv.account_id)) return res.status(410).json({ error: 'This workspace no longer accepts team members.' });
    if (!teamAllowed(me.id)) return res.status(403).json({ error: 'Logins created from a Shopify store cannot join a workspace. Create a website login with this email instead.' });
    if (!T.acceptInvite.run(inv.id).changes) return res.status(410).json({ error: 'This invite was already used.' });
    T.insertMember.run(inv.account_id, me.id, inv.role, inv.account_id);
    req.session.acct = inv.account_id; // straight into the workspace
    audit(inv.account_id, 'team.join', { member: me.id, role: inv.role });
    const acc = q.userById.get(inv.account_id);
    res.json({ ok: true, workspace: { accountId: inv.account_id, email: acc?.email, name: acc?.name, role: inv.role } });
  });

  app.get('/api/team/workspaces', requireUser, (req, res) => {
    const me = req.member?.user || req.user;
    res.json({
      current: req.member ? req.member.accountId : null,
      workspaces: T.workspaces.all(me.id).filter((w) => teamAllowed(w.account_id)).map((w) => ({ accountId: w.account_id, email: w.email, name: w.name, role: w.role })),
    });
  });

  app.post('/api/team/switch', requireUser, (req, res) => {
    const me = req.member?.user || req.user;
    const to = req.body?.accountId == null ? null : Number(req.body.accountId);
    if (to == null || to === me.id) { delete req.session.acct; return res.json({ ok: true, current: null }); }
    if (!membership(to, me.id) || !teamAllowed(to)) return res.status(404).json({ error: 'Workspace not found' });
    req.session.acct = to;
    res.json({ ok: true, current: to });
  });

  app.post('/api/team/leave', requireUser, (req, res) => {
    const me = req.member?.user || req.user;
    const from = Number(req.body?.accountId);
    if (!T.leave.run(from, me.id).changes) return res.status(404).json({ error: 'Workspace not found' });
    if (req.session.acct === from) delete req.session.acct;
    const rotated = rotateGateKeys(from);
    audit(from, 'team.leave', { member: me.id, rotatedKeys: rotated });
    res.json({ ok: true });
  });
}
