'use strict';

const { z } = require('zod');
const { cleanText } = require('../security/sanitize');

/**
 * OPTIONAL Google Places (New) enrichment, enabled only when GOOGLE_PLACES_API_KEY
 * is set. Gives what free sources cannot: reliable opening hours, temporary-closure
 * status ("CLOSED_TEMPORARILY"), price level, rating and whether Google can take
 * a table reservation. The key is sent only in a request header from the server.
 * Results are cached to keep costs down (Nearby Search is a billed SKU).
 */
const ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.businessStatus',
  'places.regularOpeningHours.weekdayDescriptions',
  'places.regularOpeningHours.periods',
  'places.reservable',
  'places.googleMapsUri',
  'places.nationalPhoneNumber',
  'places.primaryTypeDisplayName',
  'places.shortFormattedAddress',
].join(',');
const TIMEOUT_MS = 8000;
const CACHE_MAX = 300;
const CACHE_TTL = 12 * 60 * 60 * 1000;

const point = z.object({ day: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59).optional() });
const placeSchema = z.object({
  id: z.string(),
  displayName: z.object({ text: z.string() }).optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }),
  rating: z.number().optional(),
  userRatingCount: z.number().optional(),
  priceLevel: z.string().optional(),
  businessStatus: z.string().optional(),
  regularOpeningHours: z
    .object({
      weekdayDescriptions: z.array(z.string()).optional(),
      periods: z.array(z.object({ open: point, close: point.optional() })).optional(),
    })
    .optional(),
  reservable: z.boolean().optional(),
  googleMapsUri: z.string().optional(),
  nationalPhoneNumber: z.string().optional(),
  primaryTypeDisplayName: z.object({ text: z.string() }).optional(),
  shortFormattedAddress: z.string().optional(),
});
const responseSchema = z.object({ places: z.array(z.unknown()).optional() });

const PRICE_TIER = {
  PRICE_LEVEL_INEXPENSIVE: 'budget',
  PRICE_LEVEL_MODERATE: 'comfort',
  PRICE_LEVEL_EXPENSIVE: 'premium',
  PRICE_LEVEL_VERY_EXPENSIVE: 'premium',
};

/** Google periods (day 0 = Sunday) → our week format (index 0 = Monday, minutes). */
function periodsToWeek(periods) {
  if (!periods?.length) return null;
  const week = Array.from({ length: 7 }, () => []);
  for (const p of periods) {
    if (!p.close) return Array.from({ length: 7 }, () => [[0, 1440]]); // open 24 hours
    const day = (p.open.day + 6) % 7;
    const start = p.open.hour * 60 + (p.open.minute ?? 0);
    let end = p.close.hour * 60 + (p.close.minute ?? 0);
    if (p.close.day !== p.open.day || end <= start) end += 1440;
    week[day].push([start, end]);
  }
  return week;
}

const safeMapsUri = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && /(^|\.)google\.com$/.test(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
};

function createGooglePlaces(apiKey, { fetchImpl = fetch, logger } = {}) {
  const cache = new Map();

  async function restaurantsNear(key, lat, lng, radius = 2500) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const body = {
      includedTypes: ['restaurant'],
      maxResultCount: 20,
      rankPreference: 'POPULARITY',
      locationRestriction: {
        circle: { center: { latitude: Number(lat), longitude: Number(lng) }, radius: Math.min(Math.max(Number(radius) || 2500, 500), 20000) },
      },
    };
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`Google Places ${res.status}`);
    const text = await res.text();
    if (text.length > 2_000_000) throw new Error('Google Places response too large');
    const parsed = responseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error('Unexpected Google Places response');

    const out = [];
    for (const raw of parsed.data.places ?? []) {
      const p = placeSchema.safeParse(raw);
      if (!p.success || !p.data.displayName?.text) continue;
      const g = p.data;
      if (g.businessStatus === 'CLOSED_PERMANENTLY') continue;
      out.push({
        name: cleanText(g.displayName.text).slice(0, 90),
        lat: g.location.latitude,
        lng: g.location.longitude,
        area: g.shortFormattedAddress ? cleanText(g.shortFormattedAddress).split(',').slice(-2, -1)[0]?.trim() || null : null,
        cuisine: g.primaryTypeDisplayName ? cleanText(g.primaryTypeDisplayName.text).slice(0, 60) : 'Restaurant',
        tier: PRICE_TIER[g.priceLevel] || null,
        rating: typeof g.rating === 'number' ? Math.round(g.rating * 10) / 10 : null,
        ratingCount: g.userRatingCount ?? null,
        week: periodsToWeek(g.regularOpeningHours?.periods),
        status: g.businessStatus === 'CLOSED_TEMPORARILY' ? 'temporarily_closed' : null,
        reservable: g.reservable === true,
        phone: g.nationalPhoneNumber ? g.nationalPhoneNumber.replace(/[^\d+]/g, '').slice(0, 16) : null,
        googleMapsUri: g.googleMapsUri ? safeMapsUri(g.googleMapsUri) : null,
        source: 'google',
      });
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { value: out, expires: Date.now() + CACHE_TTL });
    logger?.info?.(`Google Places: ${out.length} restaurants for ${key}`);
    return out;
  }

  return { restaurantsNear };
}

module.exports = { createGooglePlaces, periodsToWeek, PRICE_TIER };
