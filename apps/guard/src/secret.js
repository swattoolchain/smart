/**
 * Encryption of secrets kept in the database (AES-256-GCM): Shopify access tokens, storefront passwords
 * and staging environment passwords. One key for all, from TOKEN_KEY (or derived from SESSION_SECRET).
 * Sealed values look like `v1:<iv>:<tag>:<data>` (base64 parts).
 */
import crypto from 'node:crypto';
import { config } from './config.js';

const KEY = crypto.createHash('sha256').update(config.tokenKey || `tharam-tokens:${config.sessionSecret}`).digest();
const SEALED = /^v1:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]*={0,2}$/;

/** Encrypts a value for storage. null and undefined stay null. */
export function seal(text) {
  if (text == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

/** Decrypts a sealed value. Throws if it was tampered with or sealed with another key. */
export function open(sealed) {
  if (!sealed) return null;
  const [v, iv, tag, enc] = sealed.split(':');
  if (v !== 'v1') return null;
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

/** True when a stored value is already encrypted (and opens with our key). */
export function isSealed(value) {
  if (typeof value !== 'string' || !SEALED.test(value)) return false;
  try { open(value); return true; } catch { return false; }
}

/**
 * Reads a stored password: decrypts sealed values; a value stored before encryption (not yet migrated)
 * is returned as it is, so a store never loses its password.
 */
export function readSecret(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && SEALED.test(value)) {
    try { return open(value); } catch {
      console.error('A stored password could not be decrypted. Was TOKEN_KEY or SESSION_SECRET changed?');
      return null;
    }
  }
  return value;
}

/** A store's storefront password, in plain text, for opening a password-protected store. */
export const storePassword = (store) => readSecret(store?.storefront_password);

/**
 * Encrypts storefront and environment passwords still stored in plain text. Runs at startup; safe to run
 * any number of times. Rows are updated in place (same row, same column), so nothing is lost.
 */
export function migratePasswords(db) {
  let n = 0;
  db.transaction(() => {
    for (const [table, col] of [['stores', 'storefront_password'], ['environments', 'password']]) {
      const rows = db.prepare(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != ''`).all();
      const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ? AND ${col} = ?`);
      for (const r of rows) {
        if (isSealed(r.v)) continue;
        upd.run(seal(r.v), r.id, r.v);
        n++;
      }
    }
  })();
  if (n) console.log(`Encrypted ${n} stored password${n === 1 ? '' : 's'}.`);
  return n;
}
