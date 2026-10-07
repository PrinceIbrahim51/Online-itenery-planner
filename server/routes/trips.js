'use strict';

const express = require('express');
const { z } = require('zod');
const { HttpError, validate, requireAuth } = require('../security/middleware');
const { safeText, slug, intIn } = require('../security/sanitize');

const tripSchema = z
  .object({
    title: safeText(2, 80),
    destination: slug,
    days: intIn(1, 14),
    travelers: intIn(1, 12),
    budget: z.enum(['budget', 'comfort', 'premium']),
  })
  .strict();

const idParam = z.object({ id: intIn(1, Number.MAX_SAFE_INTEGER) }).strict();

const MAX_TRIPS_PER_USER = 100;

function tripsRouter({ db, audit }) {
  const router = express.Router();
  router.use(requireAuth);

  // Every query is scoped by user_id → users can never read or delete
  // another user's trips by guessing IDs (prevents IDOR).
  const list = db.prepare(
    'SELECT id, title, destination, days, travelers, budget, created_at FROM trips WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
  );
  const count = db.prepare('SELECT COUNT(*) AS n FROM trips WHERE user_id = ?');
  const insert = db.prepare(
    'INSERT INTO trips (user_id, title, destination, days, travelers, budget, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const remove = db.prepare('DELETE FROM trips WHERE id = ? AND user_id = ?');

  router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ trips: list.all(req.user.id) });
  });

  router.post('/', validate(tripSchema), (req, res) => {
    if (count.get(req.user.id).n >= MAX_TRIPS_PER_USER) {
      throw new HttpError(400, `You can save up to ${MAX_TRIPS_PER_USER} trips.`);
    }
    const t = req.valid.body;
    const info = insert.run(req.user.id, t.title, t.destination, t.days, t.travelers, t.budget, Date.now());
    res.status(201).json({ trip: { id: Number(info.lastInsertRowid), ...t } });
  });

  router.delete('/:id', validate(idParam, 'params'), (req, res) => {
    const info = remove.run(req.valid.params.id, req.user.id);
    if (info.changes === 0) throw new HttpError(404, 'Trip not found.');
    audit(req, 'trip_deleted', String(req.valid.params.id));
    res.status(204).end();
  });

  return router;
}

module.exports = { tripsRouter };
