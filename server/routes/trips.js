'use strict';

const express = require('express');
const { z } = require('zod');
const { HttpError, validate, requireAuth } = require('../security/middleware');
const { safeText, slug, intIn } = require('../security/sanitize');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)');

/** A user's customised itinerary: bounded and sanitised, never trusted as HTML. */
const customSchema = z
  .object({
    days: z
      .array(
        z
          .object({
            note: safeText(0, 300).optional(),
            stops: z
              .array(
                z
                  .object({
                    name: safeText(1, 90),
                    area: safeText(0, 60).optional(),
                    note: safeText(0, 200).optional(),
                    lat: z.number().min(-90).max(90).optional(),
                    lng: z.number().min(-180).max(180).optional(),
                    custom: z.boolean().optional(),
                  })
                  .strict()
              )
              .max(15),
          })
          .strict()
      )
      .min(1)
      .max(14),
  })
  .strict();

const tripSchema = z
  .object({
    title: safeText(2, 80),
    destination: slug,
    days: intIn(1, 14),
    travelers: intIn(1, 12),
    budget: z.enum(['budget', 'comfort', 'premium']),
    start: isoDate.optional(),
    custom: customSchema.optional(),
  })
  .strict();

const updateSchema = z.object({ custom: customSchema.nullable() }).strict();

const idParam = z.object({ id: intIn(1, Number.MAX_SAFE_INTEGER) }).strict();

const MAX_TRIPS_PER_USER = 100;

function tripsRouter({ db, audit }) {
  const router = express.Router();
  router.use(requireAuth);

  // Every query is scoped by user_id → users can never read or delete
  // another user's trips by guessing IDs (prevents IDOR).
  router.get('/', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const trips = await db.all(
      'SELECT id, title, destination, days, travelers, budget, start_date, custom, created_at FROM trips WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
      req.user.id
    );
    res.json({
      trips: trips.map(({ custom, start_date: start, ...t }) => {
        let parsed = null;
        try {
          parsed = custom ? JSON.parse(custom) : null;
        } catch {
          /* ignore corrupt rows */
        }
        return { ...t, start, custom: parsed };
      }),
    });
  });

  router.post('/', validate(tripSchema), async (req, res) => {
    const { n } = await db.get('SELECT COUNT(*) AS n FROM trips WHERE user_id = ?', req.user.id);
    if (Number(n) >= MAX_TRIPS_PER_USER) {
      throw new HttpError(400, `You can save up to ${MAX_TRIPS_PER_USER} trips.`);
    }
    const t = req.valid.body;
    if (t.custom && t.custom.days.length !== t.days) throw new HttpError(400, 'Customised plan must have one entry per day.');
    const row = await db.get(
      'INSERT INTO trips (user_id, title, destination, days, travelers, budget, start_date, custom, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      req.user.id,
      t.title,
      t.destination,
      t.days,
      t.travelers,
      t.budget,
      t.start ?? null,
      t.custom ? JSON.stringify(t.custom) : null,
      Date.now()
    );
    res.status(201).json({ trip: { id: Number(row.id), ...t } });
  });

  // Update a saved trip's customised itinerary (scoped to the owner).
  router.put('/:id', validate(idParam, 'params'), validate(updateSchema), async (req, res) => {
    const custom = req.valid.body.custom;
    const trip = await db.get('SELECT days FROM trips WHERE id = ? AND user_id = ?', req.valid.params.id, req.user.id);
    if (!trip) throw new HttpError(404, 'Trip not found.');
    if (custom && custom.days.length !== Number(trip.days)) throw new HttpError(400, 'Customised plan must have one entry per day.');
    await db.run('UPDATE trips SET custom = ? WHERE id = ? AND user_id = ?', custom ? JSON.stringify(custom) : null, req.valid.params.id, req.user.id);
    res.json({ ok: true });
  });

  router.delete('/:id', validate(idParam, 'params'), async (req, res) => {
    const info = await db.run('DELETE FROM trips WHERE id = ? AND user_id = ?', req.valid.params.id, req.user.id);
    if (info.changes === 0) throw new HttpError(404, 'Trip not found.');
    await audit(req, 'trip_deleted', String(req.valid.params.id));
    res.status(204).end();
  });

  return router;
}

module.exports = { tripsRouter };
