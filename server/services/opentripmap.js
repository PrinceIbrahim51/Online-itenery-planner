'use strict';

const { z } = require('zod');
const { cleanText } = require('../security/sanitize');

/**
 * Optional provider for cities outside the curated catalogue.
 * The API key lives only in the server environment; the browser never sees it.
 * Only a fixed host is ever contacted (no user-controlled URLs → no SSRF).
 */
const BASE = 'https://api.opentripmap.com/0.1/en/places';
const TIMEOUT_MS = 6000;
const CACHE_MAX = 100;
const CACHE_TTL = 6 * 60 * 60 * 1000;

const geonameSchema = z.object({
  name: z.string(),
  country: z.string().optional(),
  lat: z.number(),
  lon: z.number(),
  status: z.string().optional(),
});
const placeSchema = z.array(
  z.object({
    name: z.string(),
    rate: z.number().optional(),
    kinds: z.string().optional(),
    point: z.object({ lat: z.number(), lon: z.number() }),
  })
);

const KIND_LABELS = [
  ['religion', 'Spiritual'],
  ['museums', 'Museum'],
  ['natural', 'Nature'],
  ['beaches', 'Beach'],
  ['fortifications', 'Heritage'],
  ['historic', 'Heritage'],
  ['architecture', 'Landmark'],
  ['cultural', 'Culture'],
];

function createOpenTripMap(apiKey, { fetchImpl = fetch } = {}) {
  const cache = new Map();

  async function getJson(path, params) {
    const url = new URL(`${BASE}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set('apikey', apiKey);
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    if (!res.ok) throw new Error(`OpenTripMap responded ${res.status}`);
    const text = await res.text();
    if (text.length > 1_000_000) throw new Error('OpenTripMap response too large');
    return JSON.parse(text);
  }

  async function lookup(cityName) {
    const key = cityName.toLowerCase();
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;

    const geo = geonameSchema.safeParse(await getJson('geoname', { name: cityName }));
    if (!geo.success || geo.data.status === 'NOT_FOUND') return null;
    const { lat, lon } = geo.data;

    const placesRaw = await getJson('radius', {
      radius: 12000,
      lon,
      lat,
      kinds: 'interesting_places',
      rate: 3,
      format: 'json',
      limit: 30,
    });
    const places = placeSchema.safeParse(placesRaw);
    if (!places.success) return null;

    const name = cleanText(geo.data.name).slice(0, 60);
    const attractions = places.data
      .filter((p) => p.name && p.name.trim())
      .slice(0, 14)
      .map((p) => {
        const kinds = p.kinds || '';
        const category = (KIND_LABELS.find(([k]) => kinds.includes(k)) || [null, 'Sight'])[1];
        return {
          name: cleanText(p.name).slice(0, 80),
          area: name,
          category,
          lat: p.point.lat,
          lng: p.point.lon,
          hours: 'Check locally',
          fee: 'Check locally',
          durationHrs: 1.5,
          rating: Math.min(5, 3.8 + (p.rate || 0) * 0.15),
          slot: 'any',
          blurb: `Popular ${category.toLowerCase()} in ${name}.`,
        };
      });
    if (!attractions.length) return null;

    const value = {
      slug: key,
      name,
      region: cleanText(geo.data.country || '').slice(0, 40),
      tagline: 'Discovered via OpenTripMap',
      bestTime: 'Check seasonal weather',
      center: [lat, lon],
      avgSpeedKmh: 22,
      dailyFood: { budget: 600, comfort: 1500, premium: 4000 },
      attractions,
      restaurants: [],
      stays: [],
      reach: [{ mode: 'Search', hub: `Nearest airport / railway station to ${name}`, distanceKm: 0, note: 'Use the links on each card to check live options.' }],
      local: [
        { mode: 'Public bus / metro', type: 'public', fare: 'Varies', note: 'Check the local transit operator.' },
        { mode: 'App cab / auto', type: 'private', fare: 'See comparison', note: 'Estimates use national average rate cards.' },
      ],
      autoMeter: { base: 30, baseKm: 1.5, perKm: 13 },
      cabApps: ['uber', 'ola', 'rapido', 'indrive'],
      dayTrips: [],
      source: 'opentripmap',
    };

    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + CACHE_TTL });
    return value;
  }

  return { lookup };
}

module.exports = { createOpenTripMap };
