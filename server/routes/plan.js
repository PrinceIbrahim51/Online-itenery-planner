'use strict';

const express = require('express');
const { z } = require('zod');
const { destinations, bySlug } = require('../data/destinations');
const { generateItinerary } = require('../services/itinerary');
const { compareFares } = require('../services/fares');
const india = require('../services/india');
const { HttpError, validate } = require('../security/middleware');
const { slug, intIn, safeText } = require('../security/sanitize');

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

const cityQuery = z.object({ q: safeText(1, 60) }).strict();

// Public, user-independent responses can be cached by the CDN.
const PUBLIC_CACHE = 'public, max-age=300, s-maxage=21600, stale-while-revalidate=86400';

const EMPTY_PLACES = () => ({ sights: [], food: [], stays: [], rail: [], bus: [], failed: [], issue: null });

function planRouter({ openTripMap, overpass, wikipedia, logger, planLimiter = (_q, _s, n) => n() }) {
  const router = express.Router();
  const curatedSlugs = new Set(destinations.map((d) => d.slug));

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

  /** Resolution order: hand-curated guide → any Indian city (live OSM data) → OpenTripMap (optional). */
  async function resolve(name) {
    const key = name.replace(/\s+/g, '-');
    const curated = bySlug.get(key);
    if (curated) return curated;

    const city = india.getCity(key);
    if (city) {
      let places = EMPTY_PLACES();
      if (overpass) {
        try {
          places = { ...EMPTY_PLACES(), ...(await overpass.placesAround(city.slug, city.lat, city.lng, india.searchRadius(city))) };
        } catch (err) {
          places = { ...EMPTY_PLACES(), failed: ['sights', 'food', 'hubs'], issue: 'error' };
        }
        if (places.failed.length) logger.warn(`Live places partly failed for ${city.slug}: ${places.failed.join(',')} (${places.issue})`);
      } else {
        places.failed = ['sights', 'food', 'hubs'];
        places.issue = 'disabled';
      }

      // Too few sights (or none)? Top up from Wikipedia — an independent source.
      let sightsSource = places.sights.length ? 'openstreetmap' : null;
      if (wikipedia && places.sights.length < 4) {
        try {
          const known = new Set(places.sights.map((s) => s.name.toLowerCase()));
          const extra = (await wikipedia.sightsAround(city.slug, city.lat, city.lng)).filter((s) => !known.has(s.name.toLowerCase()));
          if (extra.length) {
            places.sights = [...places.sights, ...extra];
            sightsSource = sightsSource ? 'mixed' : 'wikipedia';
          }
        } catch (err) {
          logger.warn(`Wikipedia fallback failed for ${city.slug}: ${err.message}`);
        }
      }

      const dest = india.toDestination(city, places, curatedSlugs);
      dest.degraded = places.sights.length === 0;
      dest.liveStatus = dest.degraded ? 'unavailable' : places.failed.length ? 'partial' : 'ok';
      dest.liveIssue = places.issue;
      dest.failedParts = places.failed;
      dest.sightsSource = sightsSource;
      return dest;
    }

    if (!openTripMap) return null;
    try {
      return await openTripMap.lookup(name);
    } catch (err) {
      logger.warn(`OpenTripMap lookup failed: ${err.message}`);
      throw new HttpError(502, 'Live destination data is temporarily unavailable. Try a featured destination.');
    }
  }

  router.get('/destinations', (_req, res) => {
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json({ destinations: catalogue, liveSearch: true, totalCities: india.totalCities });
  });

  router.get('/cities', validate(cityQuery, 'query'), (req, res) => {
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json({ cities: india.searchCities(req.valid.query.q, 12, curatedSlugs) });
  });

  router.get('/plan', planLimiter, validate(planQuery, 'query'), async (req, res) => {
    const q = req.valid.query;
    const dest = await resolve(q.destination);
    if (!dest) throw new HttpError(404, 'We couldn’t find that place. Try another Indian city or town.');
    const plan = generateItinerary(dest, q);
    plan.destination.degraded = Boolean(dest.degraded);
    plan.destination.liveStatus = dest.liveStatus || 'ok';
    plan.destination.liveIssue = dest.liveIssue || null;
    plan.destination.failedParts = dest.failedParts || [];
    plan.destination.sightsSource = dest.sightsSource || null;
    // Only let the CDN cache complete plans; partial ones should retry soon.
    res.set('Cache-Control', plan.destination.liveStatus === 'ok' ? PUBLIC_CACHE : 'no-store');
    res.json(plan);
  });

  router.get('/fares', planLimiter, validate(fareQuery, 'query'), async (req, res) => {
    const key = req.valid.query.destination.replace(/\s+/g, '-');
    // Fares need only the city profile, never live place data.
    const dest = bySlug.get(key) || (india.getCity(key) && india.toDestination(india.getCity(key), { sights: [], food: [], stays: [], rail: [], bus: [] }));
    if (!dest) throw new HttpError(404, 'Unknown destination.');
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json(compareFares(dest, req.valid.query.km));
  });

  return router;
}

module.exports = { planRouter };
