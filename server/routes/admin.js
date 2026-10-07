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

  const stats = db.prepare(`
    SELECT (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM users WHERE disabled = 1) AS disabled_users,
           (SELECT COUNT(*) FROM trips) AS trips,
           (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS active_sessions,
           (SELECT COUNT(*) FROM audit_log WHERE action = 'login_failed' AND created_at > ?) AS failed_logins_24h`);
  // Password hashes are never selected.
  const users = db.prepare(
    'SELECT id, email, name, role, disabled, created_at FROM users ORDER BY id DESC LIMIT ? OFFSET ?'
  );
  const getUser = db.prepare('SELECT id, role FROM users WHERE id = ?');
  const setDisabled = db.prepare('UPDATE users SET disabled = ? WHERE id = ?');
  const auditRows = db.prepare(
    'SELECT id, user_id, action, detail, created_at FROM audit_log ORDER BY id DESC LIMIT 50'
  );

  router.get('/stats', (_req, res) => {
    const now = Date.now();
    res.json({ stats: stats.get(now, now - 24 * 60 * 60 * 1000) });
  });

  router.get('/users', validate(pageQuery, 'query'), (req, res) => {
    const page = req.valid.query.page;
    res.json({ page, users: users.all(PAGE_SIZE, (page - 1) * PAGE_SIZE) });
  });

  router.patch('/users/:id', validate(idParam, 'params'), validate(patchSchema), (req, res) => {
    const id = req.valid.params.id;
    const target = getUser.get(id);
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.role === 'admin') throw new HttpError(400, 'Admin accounts cannot be disabled here.');
    setDisabled.run(req.valid.body.disabled ? 1 : 0, id);
    if (req.valid.body.disabled) sessions.destroyAllForUser(id); // kick them out immediately
    audit(req, req.valid.body.disabled ? 'admin_disable_user' : 'admin_enable_user', String(id));
    res.json({ ok: true });
  });

  router.get('/audit', (_req, res) => {
    res.json({ events: auditRows.all() });
  });

  return router;
}

module.exports = { adminRouter };
