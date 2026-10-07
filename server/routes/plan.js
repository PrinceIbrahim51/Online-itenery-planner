'use strict';

const express = require('express');
const { z } = require('zod');
const { destinations, bySlug } = require('../data/destinations');
const { generateItinerary } = require('../services/itinerary');
const { compareFares } = require('../services/fares');
const { HttpError, validate } = require('../security/middleware');
const { slug, intIn } = require('../security/sanitize');

const planQuery = z
  .object({
    destination: slug,
    days: intIn(1, 14).default(3),
    travelers: intIn(1, 12).default(2),
    budget: z.enum(['budget', 'comfort', 'premium']).default('comfort'),
  })
  .strict();

const fareQuery = z
  .object({
    destination: slug,
    km: z.coerce.number().min(0.5).max(300),
  })
  .strict();

function planRouter({ openTripMap, logger, planLimiter = (_q, _s, n) => n() }) {
  const router = express.Router();

  const catalogue = destinations.map((d) => ({
    slug: d.slug,
    name: d.name,
    region: d.region,
    tagline: d.tagline,
    bestTime: d.bestTime,
    highlights: [...d.attractions]
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 3)
      .map((a) => a.name),
  }));

  async function resolve(name) {
    const curated = bySlug.get(name.replace(/\s+/g, '-'));
    if (curated) return curated;
    if (!openTripMap) return null;
    try {
      return await openTripMap.lookup(name);
    } catch (err) {
      logger.warn(`OpenTripMap lookup failed: ${err.message}`);
      throw new HttpError(502, 'Live destination data is temporarily unavailable. Try a featured destination.');
    }
  }

  router.get('/destinations', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ destinations: catalogue, liveSearch: Boolean(openTripMap) });
  });

  router.get('/plan', planLimiter, validate(planQuery, 'query'), async (req, res) => {
    const q = req.valid.query;
    const dest = await resolve(q.destination);
    if (!dest) {
      throw new HttpError(404, 'We don’t have that destination yet. Pick one of the featured destinations.');
    }
    res.json(generateItinerary(dest, q));
  });

  router.get('/fares', planLimiter, validate(fareQuery, 'query'), async (req, res) => {
    const dest = await resolve(req.valid.query.destination);
    if (!dest) throw new HttpError(404, 'Unknown destination.');
    res.json(compareFares(dest, req.valid.query.km));
  });

  return router;
}

module.exports = { planRouter };
