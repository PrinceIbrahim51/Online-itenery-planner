'use strict';

const { z } = require('zod');
const { cleanText } = require('../security/sanitize');

/**
 * Fallback sights from Wikipedia's geosearch API (no key) when OpenStreetMap
 * is slow or down. Only numeric coordinates are sent; one fixed host is used.
 * Articles are kept only when their title/description looks like something a
 * visitor would go and see (temples, forts, beaches, museums…).
 */
const URL_BASE = 'https://en.wikipedia.org/w/api.php';
const TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_MAX = 300;
const CACHE_TTL = 12 * 60 * 60 * 1000;

const SIGHT_WORDS =
  /\b(temple|mandir|kovil|koil|devasthanam|fort|palace|mahal|museum|gallery|beach|park|garden|lake|falls|waterfall|church|basilica|cathedral|mosque|masjid|dargah|gurdwara|gurudwara|stupa|monastery|gompa|ghat|memorial|monument|tomb|mausoleum|cave|caves|zoo|aquarium|sanctuary|national park|reserve|hill|viewpoint|lighthouse|bridge|tower|gate|stepwell|baori|dam|island|marina|bazaar|market|planetarium|theatre|heritage)\b/i;
// Things that are never sights, wherever the word appears.
const EXCLUDE =
  /\b(school|college|university|institute|hospital|railway station|metro station|bus station|airport|company|bank|stadium|cricket|film|election|police|office|road|street|highway|flyover)\b/i;
// Administrative places: rejected when the article IS one ("village in …", "Ward 12"),
// but not when a sight merely mentions one ("waterfall in Tenkasi district").
const ADMIN_TITLE = /\b(district|taluk|taluka|mandal|tehsil|block|ward|constituency|village|neighbourhood|neighborhood|locality|suburb)\b/i;
const ADMIN_DESC = /^(a |an |the )?(census town|village|town|city|municipality|neighbourhood|neighborhood|locality|suburb|district|taluk|taluka|mandal|tehsil|ward|constituency|panchayat)\b/i;

const RAIL = /\b(railway station|railway junction|junction railway|rail station|railway terminus|terminal railway)\b/i;

const pageSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  coordinates: z.array(z.object({ lat: z.number(), lon: z.number() })).optional(),
  index: z.number().optional(),
});
const responseSchema = z.object({ query: z.object({ pages: z.array(z.unknown()) }).optional() });

function categoryFor(text) {
  if (/temple|mandir|kovil|koil|church|basilica|cathedral|mosque|masjid|dargah|gurdwara|gurudwara|stupa|monastery|gompa|ghat/i.test(text)) return 'Spiritual';
  if (/museum|gallery|planetarium/i.test(text)) return 'Museum';
  if (/beach|marina|island/i.test(text)) return 'Beach';
  if (/falls|waterfall|sanctuary|national park|reserve|lake|hill/i.test(text)) return 'Nature';
  if (/park|garden|zoo|aquarium/i.test(text)) return 'Garden';
  if (/fort|palace|mahal|tomb|mausoleum|cave|stepwell|baori|monument|memorial|gate|heritage/i.test(text)) return 'Heritage';
  if (/viewpoint|lighthouse|tower|bridge/i.test(text)) return 'Viewpoint';
  return 'Landmark';
}

const { haversineKm } = require('./geo');

const UA = 'VoyagrItineraryPlanner/1.2 (+https://voyagr-itinerary-planner.vercel.app)';
const SEARCH_TERMS =
  'temple OR falls OR fort OR beach OR museum OR dam OR palace OR lake OR sanctuary OR church OR mosque OR hill OR park OR "railway station"';

function createWikipedia({ fetchImpl = fetch, logger, maxKm = 60 } = {}) {
  const cache = new Map();

  async function call(params) {
    const url = new URL(URL_BASE);
    for (const [k, v] of Object.entries({ action: 'query', format: 'json', formatversion: '2', ...params })) url.searchParams.set(k, v);
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('Wikipedia response too large');
    const parsed = responseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error('Unexpected Wikipedia response');
    return parsed.data.query?.pages ?? [];
  }

  /**
   * Returns { sights, rail } for a place. Two lookups run in parallel:
   *  1. articles within 10 km of the point (Wikipedia's maximum radius), and
   *  2. a name search ("Tenkasi temple OR falls …") kept within `maxKm`,
   *     which matters for districts and rural centres where (1) finds little.
   * `name` comes from our own dataset, never from user input, and is reduced to letters anyway.
   */
  async function placesAround(key, lat, lng, name = '') {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) throw new Error('Invalid coordinate');
    const centre = { lat: Number(lat), lng: Number(lng) };

    const common = { prop: 'coordinates|description', colimit: 'max' }; // default colimit is 10
    const lookups = [
      call({ ...common, generator: 'geosearch', ggscoord: `${centre.lat.toFixed(5)}|${centre.lng.toFixed(5)}`, ggsradius: '10000', ggslimit: '100' }),
    ];
    const cleanName = String(name).replace(/\bdistrict\b/gi, '').replace(/[^A-Za-z .-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanName.length >= 3) {
      lookups.push(call({ ...common, generator: 'search', gsrsearch: `"${cleanName}" ${SEARCH_TERMS}`, gsrnamespace: '0', gsrlimit: '50' }));
    }
    const settled = await Promise.allSettled(lookups);
    if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason;

    const sights = [];
    const rail = [];
    const seen = new Set();
    for (const r of settled) {
      if (r.status !== 'fulfilled') {
        logger?.warn(`Wikipedia lookup failed: ${r.reason?.message}`);
        continue;
      }
      for (const raw of r.value) {
        const p = pageSchema.safeParse(raw);
        if (!p.success || !p.data.coordinates?.length) continue;
        const title = cleanText(p.data.title).slice(0, 90);
        if (seen.has(title.toLowerCase())) continue;
        const { lat: plat, lon: plng } = p.data.coordinates[0];
        if (haversineKm(centre, { lat: plat, lng: plng }) > maxKm) continue; // a namesake elsewhere in India
        seen.add(title.toLowerCase());
        const description = p.data.description ? cleanText(p.data.description).slice(0, 160) : '';
        const haystack = `${title} ${description}`;
        if (RAIL.test(haystack) && !/metro|monorail|light rail/i.test(haystack)) {
          rail.push({ name: title.replace(/\s+railway station$/i, '').trim(), lat: plat, lng: plng, notable: true, hours: null, tags: {} });
          continue;
        }
        if (!SIGHT_WORDS.test(haystack) || EXCLUDE.test(haystack)) continue;
        if (ADMIN_TITLE.test(title) || ADMIN_DESC.test(description)) continue;
        sights.push({
          name: title,
          lat: plat,
          lng: plng,
          notable: true, // every result has a Wikipedia article
          hours: null,
          wikiCategory: categoryFor(haystack),
          tags: { description: description ? `${description.charAt(0).toUpperCase()}${description.slice(1)}.` : null },
        });
      }
    }
    const value = { sights, rail };
    // Cache only when both lookups succeeded, so a transient failure is retried.
    if (settled.every((r) => r.status === 'fulfilled')) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, { value, expires: Date.now() + CACHE_TTL });
    }
    return value;
  }

  return { placesAround };
}

module.exports = { createWikipedia, categoryFor };
