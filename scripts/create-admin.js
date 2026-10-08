'use strict';

/**
 * Creates (or promotes) an admin account from ADMIN_EMAIL / ADMIN_PASSWORD.
 * There are NO default admin credentials anywhere in the codebase.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='…' npm run create-admin
 *
 * Remove ADMIN_PASSWORD from your environment / .env afterwards.
 */
const { loadConfig } = require('../server/config');
const { openDatabase } = require('../server/db');
const { hashPassword, passwordProblems } = require('../server/security/passwords');

async function main() {
  const config = loadConfig();
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Set ADMIN_EMAIL to a valid email address.');
  const problems = passwordProblems(password, email);
  if (password.length < 14) problems.push('at least 14 characters for admin accounts');
  if (problems.length) throw new Error(`ADMIN_PASSWORD needs: ${problems.join(', ')}.`);

  // Works against local SQLite or, with DATABASE_URL set, the production Postgres database.
  const db = openDatabase(config);
  await db.ready;
  const hash = await hashPassword(password);
  const existing = await db.get('SELECT id FROM users WHERE email = ?', email);
  if (existing) {
    await db.run("UPDATE users SET role = 'admin', password_hash = ?, disabled = 0, failed_logins = 0, locked_until = 0 WHERE id = ?", hash, existing.id);
    await db.run('DELETE FROM sessions WHERE user_id = ?', existing.id);
    console.log(`Promoted existing user ${email} to admin (password reset, sessions revoked).`);
  } else {
    await db.run("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, 'Administrator', ?, 'admin', ?)", email, hash, Date.now());
    console.log(`Created admin ${email}.`);
  }
  await db.close();
  console.log('Now remove ADMIN_PASSWORD from your environment.');
}

main().catch((err) => {
  console.error(`[create-admin] ${err.message}`);
  process.exit(1);
});
