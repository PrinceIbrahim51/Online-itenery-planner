'use strict';

const express = require('express');
const { z } = require('zod');
const { hashPassword, verifyPassword, dummyHash, passwordProblems } = require('../security/passwords');
const { cookieOptions, COOKIE_NAME } = require('../security/sessions');
const { HttpError, validate, requireAuth } = require('../security/middleware');
const { safeText, email, password } = require('../security/sanitize');

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

const registerSchema = z.object({ name: safeText(2, 60), email, password }).strict();
const loginSchema = z.object({ email, password }).strict();

function authRouter({ db, sessions, config, audit, authLimiter }) {
  const router = express.Router();

  const findByEmail = db.prepare(
    'SELECT id, email, name, role, password_hash, disabled, failed_logins, locked_until FROM users WHERE email = ?'
  );
  const insertUser = db.prepare(
    "INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'user', ?)"
  );
  const recordFail = db.prepare(`
    UPDATE users SET failed_logins = failed_logins + 1,
      locked_until = CASE WHEN failed_logins + 1 >= ? THEN ? ELSE locked_until END
    WHERE id = ?`);
  const resetFails = db.prepare('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?');

  function startSession(res, userId) {
    const { token, csrf } = sessions.create(userId);
    res.cookie(COOKIE_NAME, token, cookieOptions(config));
    return csrf;
  }

  router.post('/register', authLimiter, validate(registerSchema), async (req, res, next) => {
    try {
      const { name, email: mail, password: pw } = req.valid.body;
      const problems = passwordProblems(pw, mail);
      if (problems.length) throw new HttpError(400, `Password needs: ${problems.join(', ')}.`);

      const hash = await hashPassword(pw);
      if (findByEmail.get(mail)) {
        // Do not reveal whether the email exists.
        throw new HttpError(400, 'Unable to create account with these details.');
      }
      const info = insertUser.run(mail, name, hash, Date.now());
      const userId = Number(info.lastInsertRowid);
      audit(req, 'register', null, userId);
      const csrf = startSession(res, userId);
      res.status(201).json({ user: { id: userId, name, email: mail, role: 'user' }, csrfToken: csrf });
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', authLimiter, validate(loginSchema), async (req, res, next) => {
    try {
      const { email: mail, password: pw } = req.valid.body;
      const user = findByEmail.get(mail);
      const generic = new HttpError(401, 'Incorrect email or password.');

      if (!user) {
        await verifyPassword(pw, await dummyHash()); // equalise timing
        audit(req, 'login_failed', 'unknown account');
        throw generic;
      }
      if (user.locked_until > Date.now()) {
        audit(req, 'login_locked', null, user.id);
        throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
      }
      const ok = await verifyPassword(pw, user.password_hash);
      if (!ok || user.disabled) {
        if (!ok) recordFail.run(MAX_FAILED, Date.now() + LOCK_MS, user.id);
        audit(req, user.disabled ? 'login_disabled' : 'login_failed', null, user.id);
        throw generic;
      }

      resetFails.run(user.id);
      audit(req, 'login', null, user.id);
      const csrf = startSession(res, user.id);
      res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, csrfToken: csrf });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', requireAuth, (req, res) => {
    sessions.destroy(req.sessionToken);
    audit(req, 'logout');
    res.clearCookie(COOKIE_NAME, { ...cookieOptions(config), maxAge: undefined });
    res.status(204).end();
  });

  router.get('/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.json({ user: null });
    res.json({ user: req.user, csrfToken: req.csrf });
  });

  return router;
}

module.exports = { authRouter };
