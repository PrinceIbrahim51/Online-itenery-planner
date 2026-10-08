'use strict';

const { z } = require('zod');
const { cleanText } = require('../security/sanitize');

/**
 * Live place data from OpenStreetMap via the public Overpass API (no API key).
 * Queries are built ONLY from numeric coordinates taken from our bundled city
 * list — user input never reaches the query, and only fixed hosts are contacted.
 * Data © OpenStreetMap contributors, ODbL.
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const TIMEOUT_MS = 14000;
const MAX_BYTES = 6 * 1024 * 1024;
const CACHE_MAX = 300;
const CACHE_TTL = 12 * 60 * 60 * 1000;

const elementSchema = z.object({
  type: z.enum(['node', 'way', 'relation']),
  id: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});
const responseSchema = z.object({ elements: z.array(z.unknown()) });

const num = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) throw new Error('Invalid coordinate');
  return v.toFixed(5);
};
const int = (n) => String(Math.max(100, Math.min(50000, Math.round(Number(n) || 0))));

function buildQuery(lat, lng, radius) {
  const c = `${num(lat)},${num(lng)}`;
  const r = int(radius);
  const near = int(Math.min(radius, 3500));
  const wide = int(Math.max(radius * 2.5, 20000));
  return `[out:json][timeout:25];
(
  nwr(around:${r},${c})["tourism"~"^(attraction|museum|viewpoint|zoo|theme_park|gallery|aquarium)$"]["name"];
  nwr(around:${r},${c})["historic"~"^(monument|fort|castle|memorial|ruins|palace|archaeological_site|temple|city_gate)$"]["name"];
  nwr(around:${r},${c})["amenity"="place_of_worship"]["name"]["wikidata"];
  nwr(around:${r},${c})["leisure"~"^(park|garden|nature_reserve)$"]["name"]["wikidata"];
  nwr(around:${wide},${c})["natural"~"^(beach|waterfall)$"]["name"];
  nwr(around:${wide},${c})["boundary"="national_park"]["name"];
)->.sights;
.sights out center tags 160;
nwr(around:${near},${c})["amenity"~"^(restaurant|cafe)$"]["name"]->.food;
.food out center tags 120;
nwr(around:${r},${c})["tourism"~"^(hotel|guest_house|hostel|resort|motel|apartment)$"]["name"]->.stays;
.stays out center tags 120;
(
  nwr(around:${wide},${c})["railway"="station"]["name"]["station"!~"subway|light_rail|monorail"];
  nwr(around:${int(radius * 1.5)},${c})["amenity"="bus_station"]["name"];
)->.hubs;
.hubs out center tags 40;`;
}

function classify(tags) {
  if (tags.amenity === 'restaurant' || tags.amenity === 'cafe') return 'food';
  if (/^(hotel|guest_house|hostel|resort|motel|apartment)$/.test(tags.tourism || '')) return 'stay';
  if (tags.railway === 'station') return 'rail';
  if (tags.amenity === 'bus_station') return 'bus';
  return 'sight';
}

const BUCKET = { sight: 'sights', food: 'food', stay: 'stays', rail: 'rail', bus: 'bus' };

function normalise(raw) {
  const out = { sights: [], food: [], stays: [], rail: [], bus: [] };
  const seen = new Set();
  for (const item of raw) {
    const parsed = elementSchema.safeParse(item);
    if (!parsed.success || !parsed.data.tags) continue;
    const el = parsed.data;
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat === undefined || lng === undefined) continue;
    const tags = el.tags;
    const name = cleanText(tags['name:en'] || tags.name || '').slice(0, 90);
    if (name.length < 2) continue;
    const kind = classify(tags);
    const key = `${kind}|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pick = (k, max = 120) => (tags[k] ? cleanText(tags[k]).slice(0, max) : null);
    const entry = {
      name,
      lat,
      lng,
      notable: Boolean(tags.wikidata || tags.wikipedia),
      hours: pick('opening_hours'),
      tags: {
        tourism: pick('tourism', 30),
        historic: pick('historic', 30),
        amenity: pick('amenity', 30),
        leisure: pick('leisure', 30),
        natural: pick('natural', 30),
        boundary: pick('boundary', 30),
        religion: pick('religion', 30),
        cuisine: pick('cuisine', 60),
        stars: pick('stars', 5),
        fee: pick('fee', 30),
        suburb: pick('addr:suburb', 60) || pick('addr:city', 60),
        description: pick('description', 200),
      },
    };
    out[BUCKET[kind]].push(entry);
  }
  return out;
}

function createOverpass({ fetchImpl = fetch, endpoints = ENDPOINTS, logger } = {}) {
  const cache = new Map();
  const inflight = new Map();

  async function query(body) {
    let lastErr;
    for (const url of endpoints) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'VoyagrItineraryPlanner/1.0' },
          body: `data=${encodeURIComponent(body)}`,
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: 'error',
        });
        if (!res.ok) throw new Error(`Overpass ${res.status}`);
        const text = await res.text();
        if (text.length > MAX_BYTES) throw new Error('Overpass response too large');
        const parsed = responseSchema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error('Unexpected Overpass response');
        return parsed.data.elements;
      } catch (err) {
        lastErr = err;
        logger?.warn(`Overpass endpoint failed (${new URL(url).host}): ${err.message}`);
      }
    }
    throw lastErr || new Error('Overpass unavailable');
  }

  /** Returns { sights, food, stays, rail, bus } around a point; cached and de-duplicated. */
  async function placesAround(key, lat, lng, radius) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const p = query(buildQuery(lat, lng, radius))
      .then((elements) => {
        const value = normalise(elements);
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, { value, expires: Date.now() + CACHE_TTL });
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return { placesAround };
}

module.exports = { createOverpass, buildQuery, normalise };
