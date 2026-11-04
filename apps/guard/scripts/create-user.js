// Creates (or resets the password of) an account from the server, e.g. a founder account listed in ADMIN_EMAIL.
// Usage: node scripts/create-user.js you@example.com 'a-long-password' ['Your name']
import bcrypt from 'bcryptjs';
import { db, q } from '../src/db.js';
import { ensureLicense, audit } from '../src/license.js';

const [email, password, name = ''] = process.argv.slice(2);
if (!email || !password || password.length < 12) { console.error('Usage: node scripts/create-user.js email password(12+ chars) [name]'); process.exit(1); }
const e = email.toLowerCase();
const hash = bcrypt.hashSync(password, 10);
const existing = q.userByEmail.get(e);
if (existing) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
  audit('server', existing.id, 'note', { text: 'Password reset from the server' });
  console.log(`Password reset for ${e} (user ${existing.id}).`);
} else {
  const id = Number(q.insertUser.run(e, hash, name).lastInsertRowid);
  ensureLicense(id, 'server');
  console.log(`Created ${e} (user ${id}).`);
}
