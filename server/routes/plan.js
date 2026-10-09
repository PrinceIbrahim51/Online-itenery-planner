'use strict';

const express = require('express');
const { z } = require('zod');
const { destinations, bySlug } = require('../data/destinations');
const { generateItinerary } = require('../services/itinerary');
const { compareFares } = require('../services/fares');
const india = require('../services/india');
const { HttpError, validate } = require('../security/middleware');
const { slug, intIn, safeText } = require('../security/sanitize');
const { buildAdvice } = require('../services/advice');
const { todayIst, addDays } = require('../services/weather');

/** Trip start date: a real calendar date from yesterday up to one year ahead. */
const startDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return false;
    const today = todayIst();
    return v >= addDays(today, -1) && v <= addDays(today, 366);
  }, 'must be a valid date within the next year');

const planQuery = z
  .object({
    destination: slug,
    days: intIn(1, 14).default(3),
    travelers: intIn(1, 12).default(2),
    budget: z.enum(['budget', 'comfort', 'premium']).default('comfort'),
    start: startDate.optional(),
  })
  .strict();

const fareQuery = z
  .object({
    destination: slug,
    km: z.coerce.number().min(0.5).max(300),
  })
  .strict();

const cityQuery = z.object({ q: safeText(1, 60) }).strict();
const stateParam = z.object({ code: z.string().regex(/^[A-Za-z]{2}$/, 'must be a 2-letter state code') }).strict();

// Public, user-independent responses can be cached by the CDN.
const PUBLIC_CACHE = 'public, max-age=300, s-maxage=21600, stale-while-revalidate=86400';

const EMPTY_PLACES = () => ({ sights: [], food: [], stays: [], rail: [], bus: [], night: [], google: [], failed: [], issue: null });

function planRouter({ openTripMap, overpass, wikipedia, googlePlaces, weather, logger, planLimiter = (_q, _s, n) => n() }) {
  const router = express.Router();
  const curatedSlugs = new Set(destinations.map((d) => d.slug));
  india.registerFeatured(destinations);

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

    // A state on its own plans around its capital; districts plan around their HQ/centre.
    const state = india.getStateBySlug(key);
    const city = india.getCity(key) || india.getDistrict(key) || (state?.capital ? india.getCity(state.capital) : null);
    if (city) {
      // OpenStreetMap and Wikipedia are queried in parallel; each covers for the other.
      const [osmResult, wikiResult, googleResult] = await Promise.allSettled([
        overpass
          ? overpass.placesAround(city.slug, city.lat, city.lng, india.searchRadius(city))
          : Promise.reject(Object.assign(new Error('disabled'), { code: 'disabled' })),
        wikipedia ? wikipedia.placesAround(city.slug, city.lat, city.lng, city.name) : Promise.resolve({ sights: [], rail: [] }),
        googlePlaces
          ? googlePlaces.restaurantsNear(city.slug, city.lat, city.lng, Math.min(india.searchRadius(city) * 0.5, 4000))
          : Promise.resolve([]),
      ]);

      const places =
        osmResult.status === 'fulfilled'
          ? { ...EMPTY_PLACES(), ...osmResult.value }
          : { ...EMPTY_PLACES(), failed: ['sights', 'food', 'hubs'], issue: osmResult.reason?.code || 'error' };
      if (places.failed.length) {
        logger.warn(`Live places partly failed for ${city.slug}: ${(places.diagnostics || places.failed).join(' | ')}`);
      }

      const wiki = wikiResult.status === 'fulfilled' ? wikiResult.value : { sights: [], rail: [] };
      if (googleResult.status === 'fulfilled') places.google = googleResult.value;
      else logger.warn(`Google Places failed for ${city.slug}: ${googleResult.reason?.message}`);
      // With Google restaurants in hand, a failed OSM food lookup no longer matters.
      if (places.google.length) places.failed = places.failed.filter((x) => x !== 'food');
      if (wikiResult.status === 'rejected') logger.warn(`Wikipedia failed for ${city.slug}: ${wikiResult.reason?.message}`);

      const known = new Set(places.sights.map((x) => x.name.toLowerCase()));
      const extraSights = wiki.sights.filter((x) => !known.has(x.name.toLowerCase()));
      const osmSights = places.sights.length;
      places.sights = [...places.sights, ...extraSights];
      if (!places.rail.length && wiki.rail.length) places.rail = wiki.rail;

      // Only tell the user about gaps they can actually see.
      const missing = [];
      if (places.sights.length < 3) missing.push('sights');
      if (places.failed.includes('food')) missing.push('food');
      if (places.failed.includes('hubs') && !places.rail.length) missing.push('hubs');

      const dest = india.toDestination(city, places, curatedSlugs);
      dest.degraded = places.sights.length === 0;
      dest.liveStatus = dest.degraded ? 'unavailable' : missing.length ? 'partial' : 'ok';
      dest.liveIssue = missing.length ? places.issue : null;
      dest.failedParts = missing;
      dest.sightsSource = osmSights && extraSights.length ? 'mixed' : osmSights ? 'openstreetmap' : extraSights.length ? 'wikipedia' : null;
      // Anything that failed (even if covered) means a retry could improve the plan.
      dest.complete = places.failed.length === 0 && wikiResult.status === 'fulfilled';
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
    res.json({
      destinations: catalogue,
      liveSearch: true,
      totalCities: india.totalCities,
      totalDistricts: india.totalDistricts,
      totalStates: india.totalStates,
      states: india.listStates(),
    });
  });

  router.get('/cities', validate(cityQuery, 'query'), (req, res) => {
    res.set('Cache-Control', PUBLIC_CACHE);
    const { results, exact } = india.search(req.valid.query.q, 10, curatedSlugs);
    res.json({ cities: results, exact });
  });

  router.get('/states/:code', validate(stateParam, 'params'), (req, res) => {
    const st = india.getState(req.valid.params.code);
    if (!st) throw new HttpError(404, 'Unknown state.');
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json(st);
  });

  router.get('/plan', planLimiter, validate(planQuery, 'query'), async (req, res) => {
    const q = req.valid.query;
    const dest = await resolve(q.destination);
    if (!dest) throw new HttpError(404, 'We couldn’t find that place. Try another Indian city or town.');
    const plan = generateItinerary(dest, q);

    // Weather (forecast within ~2 weeks, else elevation + seasonal rules) → packing, dos & don'ts.
    let wx = null;
    if (weather && dest.center) {
      try {
        wx = await weather.forecast(dest.center[0], dest.center[1], plan.params.start, q.days);
      } catch (err) {
        logger.warn(`Weather failed for ${dest.slug}: ${err.message}`);
      }
    }
    plan.advice = buildAdvice({
      state: dest.region,
      start: plan.params.start,
      days: q.days,
      weather: wx,
      categories: plan.attractions.map((a) => a.category),
      tier: india.tierOf(dest.population || 0),
      metro: (dest.avgSpeedKmh ?? 30) <= 18,
    });
    plan.destination.degraded = Boolean(dest.degraded);
    plan.destination.liveStatus = dest.liveStatus || 'ok';
    plan.destination.liveIssue = dest.liveIssue || null;
    plan.destination.failedParts = dest.failedParts || [];
    plan.destination.sightsSource = dest.sightsSource || null;
    // Only let the CDN cache complete plans; partial ones should retry soon.
    const cacheable = plan.destination.liveStatus === 'ok' && dest.complete !== false;
    res.set('Cache-Control', cacheable ? PUBLIC_CACHE : 'public, max-age=0, s-maxage=60');
    res.json(plan);
  });

  router.get('/fares', planLimiter, validate(fareQuery, 'query'), async (req, res) => {
    const key = req.valid.query.destination.replace(/\s+/g, '-');
    // Fares need only the city profile, never live place data.
    const place = india.getCity(key) || india.getDistrict(key);
    const dest = bySlug.get(key) || (place && india.toDestination(place, { sights: [], food: [], stays: [], rail: [], bus: [] }));
    if (!dest) throw new HttpError(404, 'Unknown destination.');
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json(compareFares(dest, req.valid.query.km));
  });

  return router;
}

module.exports = { planRouter };
