'use strict';

const express = require('express');
const { z } = require('zod');
const { HttpError, validate, requireAdmin } = require('../security/middleware');
const { intIn } = require('../security/sanitize');

const pageQuery = z.object({ page: intIn(1, 10000).default(1) }).strict();
const idParam = z.object({ id: intIn(1, Number.MAX_SAFE_INTEGER) }).strict();
const patchSchema = z.object({ disabled: z.boolean() }).strict();

const PAGE_SIZE = 25;

function adminRouter({ db, sessions, audit }) {
  const router = express.Router();
  // Role is enforced on the server for every admin request; hiding the UI is not security.
  router.use(requireAdmin);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/stats', async (_req, res) => {
    const now = Date.now();
    const row = await db.get(
      `SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM users WHERE disabled = 1) AS disabled_users,
              (SELECT COUNT(*) FROM trips) AS trips,
              (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS active_sessions,
              (SELECT COUNT(*) FROM audit_log WHERE action = 'login_failed' AND created_at > ?) AS failed_logins_24h`,
      now,
      now - 24 * 60 * 60 * 1000
    );
    const stats = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
    res.json({ stats });
  });

  router.get('/users', validate(pageQuery, 'query'), async (req, res) => {
    const page = req.valid.query.page;
    // Password hashes are never selected.
    const users = await db.all(
      'SELECT id, email, name, role, disabled, created_at FROM users ORDER BY id DESC LIMIT ? OFFSET ?',
      PAGE_SIZE,
      (page - 1) * PAGE_SIZE
    );
    res.json({ page, users });
  });

  router.patch('/users/:id', validate(idParam, 'params'), validate(patchSchema), async (req, res) => {
    const id = req.valid.params.id;
    const target = await db.get('SELECT id, role FROM users WHERE id = ?', id);
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.role === 'admin') throw new HttpError(400, 'Admin accounts cannot be disabled here.');
    await db.run('UPDATE users SET disabled = ? WHERE id = ?', req.valid.body.disabled ? 1 : 0, id);
    if (req.valid.body.disabled) await sessions.destroyAllForUser(id); // kick them out immediately
    await audit(req, req.valid.body.disabled ? 'admin_disable_user' : 'admin_enable_user', String(id));
    res.json({ ok: true });
  });

  router.get('/audit', async (_req, res) => {
    const events = await db.all('SELECT id, user_id, action, detail, created_at FROM audit_log ORDER BY id DESC LIMIT 50');
    res.json({ events });
  });

  return router;
}

module.exports = { adminRouter };
