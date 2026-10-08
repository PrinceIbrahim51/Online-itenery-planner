'use strict';

const crypto = require('node:crypto');

const COOKIE_NAME = 'voyagr_sid';

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

/**
 * Server-side sessions. The browser only holds a random 256-bit token in an
 * HttpOnly cookie; the database stores its SHA-256 hash, so a leaked database
 * cannot be used to hijack sessions. Sessions are revocable (logout, disable).
 */
function createSessionStore(db, ttlMs) {
  return {
    async create(userId) {
      const token = crypto.randomBytes(32).toString('base64url');
      const csrf = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      await db.run(
        'INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
        sha256(token),
        userId,
        csrf,
        now + ttlMs,
        now
      );
      return { token, csrf };
    },
    async lookup(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
      const hash = sha256(token);
      const row = await db.get(
        `SELECT s.csrf_token, s.expires_at, u.id, u.email, u.name, u.role, u.disabled
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
        hash
      );
      if (!row) return null;
      if (row.expires_at < Date.now() || row.disabled) {
        await db.run('DELETE FROM sessions WHERE token_hash = ?', hash);
        return null;
      }
      return {
        csrf: row.csrf_token,
        user: { id: Number(row.id), email: row.email, name: row.name, role: row.role },
      };
    },
    async destroy(token) {
      if (typeof token === 'string') await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
    },
    async destroyAllForUser(userId) {
      await db.run('DELETE FROM sessions WHERE user_id = ?', userId);
    },
    async purgeExpired() {
      await db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    },
  };
}

function cookieOptions(config) {
  return {
    httpOnly: true, // not readable from JavaScript → XSS cannot steal it
    secure: config.cookieSecure, // HTTPS only
    sameSite: 'strict', // not sent on cross-site requests → CSRF defence
    path: '/',
    maxAge: config.sessionTtlMs,
  };
}

module.exports = { createSessionStore, cookieOptions, COOKIE_NAME };
