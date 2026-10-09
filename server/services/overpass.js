'use strict';

const { z } = require('zod');
const { cleanText } = require('../security/sanitize');

/**
 * Live place data from OpenStreetMap via the public Overpass API (no API key).
 * Queries are built ONLY from numeric coordinates taken from our bundled city
 * list — user input never reaches the query, and only fixed hosts are contacted.
 * Data © OpenStreetMap contributors, ODbL.
 *
 * Big cities are expensive to query, so the work is split into three small
 * queries (sights / food & stays / transport hubs) that run in parallel and
 * fail independently: a slow restaurant lookup can no longer wipe out sights.
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const TIMEOUT_MS = 12000;
const BUSY_BACKOFF_MS = 600;
const MAX_BYTES = 6 * 1024 * 1024;
const CACHE_MAX = 300;
const CACHE_TTL = 12 * 60 * 60 * 1000;
const PARTS = ['sights', 'food', 'hubs'];

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

/** Three independent Overpass QL queries around a point. */
function buildQueries(lat, lng, radius) {
  const c = `${num(lat)},${num(lng)}`;
  const r = int(radius);
  const wide = int(Math.min(Math.max(radius * 2, 15000), 25000));
  const food = int(Math.min(radius * 0.4, 2500));
  const stays = int(Math.min(radius * 0.6, 5000));
  const head = '[out:json][timeout:11];';
  return {
    sights: `${head}
(
  nw(around:${r},${c})["tourism"~"^(attraction|museum|viewpoint|zoo|theme_park|gallery|aquarium)$"]["name"];
  nw(around:${r},${c})["historic"~"^(monument|fort|castle|memorial|ruins|palace|archaeological_site|temple|city_gate)$"]["name"];
  nw(around:${r},${c})["amenity"="place_of_worship"]["name"]["wikidata"];
  nw(around:${r},${c})["leisure"~"^(park|garden|nature_reserve)$"]["name"]["wikidata"];
  nw(around:${wide},${c})["natural"~"^(beach|waterfall)$"]["name"];
);
out tags center 160;`,
    food: `${head}
nwr(around:${food},${c})["amenity"~"^(restaurant|cafe)$"]["name"];
out tags center 120;
nwr(around:${stays},${c})["tourism"~"^(hotel|guest_house|hostel|resort|motel)$"]["name"];
out tags center 120;
nwr(around:${int(Math.min(radius * 0.6, 5000))},${c})["amenity"~"^(bar|pub|nightclub|biergarten)$"]["name"];
out tags center 40;`,
    hubs: `${head}
node(around:${wide},${c})["railway"="station"]["name"]["station"!~"subway|light_rail|monorail"];
out tags 30;
nwr(around:${int(radius)},${c})["amenity"="bus_station"]["name"];
out tags center 20;`,
  };
}

function classify(tags) {
  if (tags.amenity === 'restaurant' || tags.amenity === 'cafe') return 'food';
  if (/^(hotel|guest_house|hostel|resort|motel|apartment)$/.test(tags.tourism || '')) return 'stay';
  if (tags.railway === 'station') return 'rail';
  if (tags.amenity === 'bus_station') return 'bus';
  if (/^(bar|pub|nightclub|biergarten)$/.test(tags.amenity || '')) return 'night';
  return 'sight';
}

const BUCKET = { sight: 'sights', food: 'food', stay: 'stays', rail: 'rail', bus: 'bus', night: 'night' };

/** Digits-only phone number (first one listed), or null. */
function phoneOf(tags) {
  const raw = tags.phone || tags['contact:phone'] || tags['contact:mobile'];
  if (!raw) return null;
  const first = String(raw).split(/[;,]/)[0];
  const cleaned = first.replace(/[^\d+]/g, '');
  return /^\+?\d{6,15}$/.test(cleaned) ? cleaned : null;
}

function normalise(raw) {
  const out = { sights: [], food: [], stays: [], rail: [], bus: [], night: [] };
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
    out[BUCKET[kind]].push({
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
        note: pick('note', 200),
        opening_hours: pick('opening_hours', 200),
        phone: phoneOf(tags),
      },
    });
  }
  return out;
}

/** Coarse, non-sensitive failure code (safe to show users for troubleshooting). */
function issueCode(err) {
  if (!err) return 'unknown';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
  const m = /Overpass (\d{3})/.exec(err.message || '');
  if (m) return `http_${m[1]}`;
  if (/fetch failed|ENOTFOUND|ECONN/i.test(err.message || '')) return 'network';
  return 'error';
}

function createOverpass({ fetchImpl = fetch, endpoints = ENDPOINTS, logger } = {}) {
  const cache = new Map();
  const inflight = new Map();

  async function queryOnce(url, body) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'VoyagrItineraryPlanner/1.1 (+https://voyagr-itinerary-planner.vercel.app)',
      },
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
  }

  /** Try every endpoint in turn (starting at a different one per part to spread load). */
  async function query(body, offset) {
    const attempts = [];
    let lastErr;
    for (let i = 0; i < endpoints.length; i++) {
      const url = endpoints[(offset + i) % endpoints.length];
      try {
        return await queryOnce(url, body);
      } catch (err) {
        lastErr = err;
        const host = new URL(url).host;
        const code = issueCode(err);
        attempts.push(`${host}:${code}`);
        logger?.warn(`Overpass failed (${host}): ${code} ${err.message}`);
        // Overloaded / rate-limited: give the public servers a moment before the next mirror.
        if (code === 'http_429' || code === 'http_504') await new Promise((r) => setTimeout(r, BUSY_BACKOFF_MS));
      }
    }
    const err = lastErr || new Error('Overpass unavailable');
    err.attempts = attempts;
    throw err;
  }

  async function fetchAll(lat, lng, radius) {
    const queries = buildQueries(lat, lng, radius);
    const settled = await Promise.allSettled(PARTS.map((p, i) => query(queries[p], i)));
    const merged = { sights: [], food: [], stays: [], rail: [], bus: [], night: [] };
    const failed = [];
    const diagnostics = [];
    let issue = null;
    const seen = new Set();
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        const part = normalise(r.value);
        for (const k of Object.keys(merged)) {
          for (const item of part[k]) {
            const id = `${k}|${item.name.toLowerCase()}`;
            if (!seen.has(id)) {
              seen.add(id);
              merged[k].push(item);
            }
          }
        }
      } else {
        failed.push(PARTS[i]);
        issue ??= issueCode(r.reason);
        diagnostics.push(`${PARTS[i]}→${(r.reason?.attempts || []).join(',')}`);
      }
    });
    return { ...merged, failed, issue, diagnostics };
  }

  /** Returns { sights, food, stays, rail, bus, failed[], issue } — never throws. */
  async function placesAround(key, lat, lng, radius) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const p = fetchAll(lat, lng, radius)
      .then((value) => {
        // Only cache complete results so a transient failure is retried next time.
        if (!value.failed.length) {
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
          cache.set(key, { value, expires: Date.now() + CACHE_TTL });
        }
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return { placesAround };
}

module.exports = { createOverpass, buildQueries, normalise, issueCode, ENDPOINTS };
