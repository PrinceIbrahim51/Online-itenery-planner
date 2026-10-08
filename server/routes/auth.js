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

const FIND_BY_EMAIL =
  'SELECT id, email, name, role, password_hash, disabled, failed_logins, locked_until FROM users WHERE email = ?';

function authRouter({ db, sessions, config, audit, authLimiter }) {
  const router = express.Router();

  async function startSession(res, userId) {
    const { token, csrf } = await sessions.create(userId);
    res.cookie(COOKIE_NAME, token, cookieOptions(config));
    return csrf;
  }

  router.get('/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!config.accountsEnabled) return res.json({ user: null, accountsEnabled: false });
    if (!req.user) return res.json({ user: null, accountsEnabled: true });
    res.json({ user: req.user, csrfToken: req.csrf, accountsEnabled: true });
  });

  // Everything below needs a persistent database.
  router.use((_req, _res, next) => {
    if (!config.accountsEnabled) return next(new HttpError(503, 'Accounts are not enabled on this deployment yet.'));
    next();
  });

  router.post('/register', authLimiter, validate(registerSchema), async (req, res) => {
    const { name, email: mail, password: pw } = req.valid.body;
    const problems = passwordProblems(pw, mail);
    if (problems.length) throw new HttpError(400, `Password needs: ${problems.join(', ')}.`);

    const hash = await hashPassword(pw);
    if (await db.get(FIND_BY_EMAIL, mail)) {
      // Do not reveal whether the email exists.
      throw new HttpError(400, 'Unable to create account with these details.');
    }
    const row = await db.get(
      "INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'user', ?) RETURNING id",
      mail,
      name,
      hash,
      Date.now()
    );
    const userId = Number(row.id);
    await audit(req, 'register', null, userId);
    const csrf = await startSession(res, userId);
    res.status(201).json({ user: { id: userId, name, email: mail, role: 'user' }, csrfToken: csrf });
  });

  router.post('/login', authLimiter, validate(loginSchema), async (req, res) => {
    const { email: mail, password: pw } = req.valid.body;
    const user = await db.get(FIND_BY_EMAIL, mail);
    const generic = new HttpError(401, 'Incorrect email or password.');

    if (!user) {
      await verifyPassword(pw, await dummyHash()); // equalise timing
      await audit(req, 'login_failed', 'unknown account');
      throw generic;
    }
    const userId = Number(user.id);
    if (Number(user.locked_until) > Date.now()) {
      await audit(req, 'login_locked', null, userId);
      throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    }
    const ok = await verifyPassword(pw, user.password_hash);
    if (!ok || user.disabled) {
      if (!ok) {
        await db.run(
          `UPDATE users SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= ? THEN ? ELSE locked_until END
           WHERE id = ?`,
          MAX_FAILED,
          Date.now() + LOCK_MS,
          userId
        );
      }
      await audit(req, user.disabled ? 'login_disabled' : 'login_failed', null, userId);
      throw generic;
    }

    await db.run('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?', userId);
    await audit(req, 'login', null, userId);
    const csrf = await startSession(res, userId);
    res.json({ user: { id: userId, name: user.name, email: user.email, role: user.role }, csrfToken: csrf });
  });

  router.post('/logout', requireAuth, async (req, res) => {
    await sessions.destroy(req.sessionToken);
    await audit(req, 'logout');
    res.clearCookie(COOKIE_NAME, { ...cookieOptions(config), maxAge: undefined });
    res.status(204).end();
  });

  return router;
}

module.exports = { authRouter };
