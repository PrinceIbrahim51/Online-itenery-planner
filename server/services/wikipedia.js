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
const EXCLUDE =
  /\b(school|college|university|institute|hospital|railway station|metro station|bus station|airport|constituency|ward|village|district|taluk|mandal|tehsil|company|bank|stadium|cricket|film|election|police|office|neighbourhood|neighborhood|locality|suburb|road|street|highway|flyover)\b/i;

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

function createWikipedia({ fetchImpl = fetch, logger } = {}) {
  const cache = new Map();

  /** Returns { sights, rail } near a point. */
  async function placesAround(key, lat, lng) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;

    const url = new URL(URL_BASE);
    const params = {
      action: 'query',
      format: 'json',
      formatversion: '2',
      generator: 'geosearch',
      ggscoord: `${Number(lat).toFixed(5)}|${Number(lng).toFixed(5)}`,
      ggsradius: '10000',
      ggslimit: '100',
      prop: 'coordinates|description',
      colimit: 'max', // default is 10 — without this most pages come back with no coordinates
    };
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) throw new Error('Invalid coordinate');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'VoyagrItineraryPlanner/1.1 (+https://voyagr-itinerary-planner.vercel.app)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('Wikipedia response too large');
    const parsed = responseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error('Unexpected Wikipedia response');

    const sights = [];
    const rail = [];
    for (const raw of parsed.data.query?.pages ?? []) {
      const p = pageSchema.safeParse(raw);
      if (!p.success || !p.data.coordinates?.length) continue;
      const title = cleanText(p.data.title).slice(0, 90);
      const description = p.data.description ? cleanText(p.data.description).slice(0, 160) : '';
      const haystack = `${title} ${description}`;
      const { lat: plat, lon: plng } = p.data.coordinates[0];
      if (RAIL.test(haystack) && !/metro|monorail|light rail/i.test(haystack)) {
        rail.push({ name: title.replace(/\s+railway station$/i, '').trim(), lat: plat, lng: plng, notable: true, hours: null, tags: {} });
        continue;
      }
      if (!SIGHT_WORDS.test(haystack) || EXCLUDE.test(haystack)) continue;
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
    const value = { sights, rail };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + CACHE_TTL });
    return value;
  }

  return { placesAround };
}

module.exports = { createWikipedia, categoryFor };
