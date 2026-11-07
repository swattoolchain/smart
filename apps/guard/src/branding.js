/**
 * Agency branding (T70, part 2 of agency workspaces): an agency name and logo that replace Tharam's header on the
 * reports it hands to clients. A small "Checked by Tharam" line always stays in the footer.
 * Website accounts only, set by the account owner only (members never reach these routes: see memberMay in team.js).
 * The logo is checked on upload (PNG or SVG, small, no scripts or outside links) and only ever shown as an
 * image from a data: address, so nothing in it can run.
 */
import express from 'express';
import { db } from './db.js';
import { audit as auditLog } from './license.js';
import { requireFeature } from './features.js';
import { teamAllowed } from './team.js';

db.exec(`
CREATE TABLE IF NOT EXISTS account_branding (
  account_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  agency_name TEXT,
  logo_mime TEXT,
  logo_data BLOB,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export const LOGO_MAX_BYTES = 100 * 1024;
export const LOGO_MAX_PIXELS = 2000;
export const NAME_MAX = 60;

const B = {
  get: db.prepare('SELECT agency_name, logo_mime, logo_data FROM account_branding WHERE account_id = ?'),
  ensure: db.prepare('INSERT OR IGNORE INTO account_branding (account_id) VALUES (?)'),
  setName: db.prepare("UPDATE account_branding SET agency_name = ?, updated_at = datetime('now') WHERE account_id = ?"),
  setLogo: db.prepare("UPDATE account_branding SET logo_mime = ?, logo_data = ?, updated_at = datetime('now') WHERE account_id = ?"),
  clear: db.prepare('DELETE FROM account_branding WHERE account_id = ?'),
};

/** The account's branding for a report, or null when none is set. Logo comes back as a data: address. */
export function brandingFor(accountId) {
  const r = accountId ? B.get.get(accountId) : null;
  if (!r || (!r.agency_name && !r.logo_data)) return null;
  return { name: r.agency_name || null, logo: r.logo_data ? `data:${r.logo_mime};base64,${Buffer.from(r.logo_data).toString('base64')}` : null };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SVG_BAD = /<\s*(script|foreignObject|iframe|embed|object|image|use|style|animate|set|link|meta|audio|video)\b|<!\s*(ENTITY|DOCTYPE)|\son[a-z]+\s*=|javascript:|data:|@import|(?:href|src)\s*=\s*["']?\s*(?!#)|url\(\s*["']?\s*(?!#)/i;

/** Checks an uploaded logo. Returns { mime } or { error } in plain words. */
export function checkLogo(buf, contentType) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { error: 'Choose a logo file (PNG or SVG).' };
  if (buf.length > LOGO_MAX_BYTES) return { error: `The logo is too big. Keep it under ${LOGO_MAX_BYTES / 1024} KB.` };
  if (/png/i.test(contentType || '')) {
    if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG) || buf.subarray(12, 16).toString('latin1') !== 'IHDR') return { error: 'That file is not a real PNG image.' };
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (!w || !h || w > LOGO_MAX_PIXELS || h > LOGO_MAX_PIXELS) return { error: `The logo can be at most ${LOGO_MAX_PIXELS} pixels wide or tall.` };
    return { mime: 'image/png' };
  }
  if (/svg/i.test(contentType || '')) {
    const s = buf.toString('utf8');
    if (s.includes('\u0000') || !/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return { error: 'That file is not a plain SVG image.' };
    if (SVG_BAD.test(s)) return { error: 'This SVG has scripts, outside links or embedded pictures, which we do not accept. Export a plain SVG, or use a PNG.' };
    return { mime: 'image/svg+xml' };
  }
  return { error: 'Use a PNG or SVG logo.' };
}

const cleanName = (v) => String(v ?? '').replace(/[<>]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

export function brandingRoutes(app, { requireUser }) {
  const allowed = (req, res) => {
    if (req.member) { res.status(403).json({ error: 'Only the account owner can change the agency branding.' }); return false; }
    if (!teamAllowed(req.user.id)) { res.status(403).json({ error: 'Agency branding is for website accounts.' }); return false; }
    return true;
  };
  const view = (id) => { const b = brandingFor(id); return { name: b?.name || '', hasLogo: !!b?.logo, logo: b?.logo || null, limits: { logoKb: LOGO_MAX_BYTES / 1024, logoPixels: LOGO_MAX_PIXELS, nameChars: NAME_MAX } }; };
  const audit = (id, action, detail) => auditLog('branding', id, action, detail);

  app.get('/api/branding', requireUser, requireFeature('agency_branding'), (req, res) => {
    if (!allowed(req, res)) return;
    res.json(view(req.user.id));
  });

  app.put('/api/branding', requireUser, requireFeature('agency_branding'), (req, res) => {
    if (!allowed(req, res)) return;
    const name = cleanName(req.body?.name);
    B.ensure.run(req.user.id);
    B.setName.run(name || null, req.user.id);
    audit(req.user.id, 'branding.name', { set: !!name });
    res.json(view(req.user.id));
  });

  // The logo is the raw file (image/png or image/svg+xml), not JSON, so it can be bigger than other requests.
  app.put('/api/branding/logo', requireUser, requireFeature('agency_branding'), (req, res, next) => {
    if (!allowed(req, res)) return;
    express.raw({ type: ['image/png', 'image/svg+xml'], limit: LOGO_MAX_BYTES + 1024 })(req, res, (err) => {
      if (err) return res.status(err.status === 413 ? 400 : err.status || 400).json({ error: err.status === 413 ? `The logo is too big. Keep it under ${LOGO_MAX_BYTES / 1024} KB.` : 'We could not read that logo.' });
      next();
    });
  }, (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    const c = checkLogo(buf, req.headers['content-type']);
    if (c.error) return res.status(400).json({ error: c.error });
    B.ensure.run(req.user.id);
    B.setLogo.run(c.mime, buf, req.user.id);
    audit(req.user.id, 'branding.logo', { mime: c.mime, bytes: buf.length });
    res.json(view(req.user.id));
  });

  app.delete('/api/branding/logo', requireUser, requireFeature('agency_branding'), (req, res) => {
    if (!allowed(req, res)) return;
    B.ensure.run(req.user.id);
    B.setLogo.run(null, null, req.user.id);
    audit(req.user.id, 'branding.logo.remove');
    res.json(view(req.user.id));
  });
}
