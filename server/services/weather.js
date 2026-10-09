'use strict';

const { z } = require('zod');

/**
 * Daily forecast + elevation from Open-Meteo (free, no API key).
 * Forecasts only exist ~16 days ahead; beyond that callers fall back to
 * seasonal rules. Only numbers and fixed parameter names are sent.
 */
const BASE = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 6000;
const CACHE_MAX = 500;
const CACHE_TTL = 60 * 60 * 1000;
const HORIZON_DAYS = 15;

const num = z.number().nullable();
const responseSchema = z.object({
  elevation: z.number().optional(),
  daily: z
    .object({
      time: z.array(z.string()),
      temperature_2m_max: z.array(num),
      temperature_2m_min: z.array(num),
      precipitation_probability_max: z.array(num).optional(),
      precipitation_sum: z.array(num).optional(),
      uv_index_max: z.array(num).optional(),
    })
    .optional(),
});

const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

function todayIst(now = Date.now()) {
  return new Date(now + 330 * 60000).toISOString().slice(0, 10);
}

function createWeather({ fetchImpl = fetch, logger, now = () => Date.now() } = {}) {
  const cache = new Map();

  /** Returns { elevation, days: [{date,max,min,rainChance,rainMm,uv}], source } or throws. */
  async function forecast(lat, lng, start, days) {
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) throw new Error('Invalid coordinate');
    const today = todayIst(now());
    const lastAvailable = addDays(today, HORIZON_DAYS);
    const end = addDays(start, days - 1);
    const inWindow = start <= lastAvailable && end >= today;
    const key = `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)},${inWindow ? `${start}:${end}` : 'elev'}`;
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.value;

    const url = new URL(BASE);
    url.searchParams.set('latitude', Number(lat).toFixed(4));
    url.searchParams.set('longitude', Number(lng).toFixed(4));
    url.searchParams.set('timezone', 'Asia/Kolkata');
    url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,uv_index_max');
    if (inWindow) {
      url.searchParams.set('start_date', start < today ? today : start);
      url.searchParams.set('end_date', end > lastAvailable ? lastAvailable : end);
    } else {
      url.searchParams.set('forecast_days', '1'); // just for the elevation
    }

    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const text = await res.text();
    if (text.length > 200_000) throw new Error('Open-Meteo response too large');
    const parsed = responseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error('Unexpected Open-Meteo response');

    const d = parsed.data.daily;
    const out = {
      elevation: parsed.data.elevation ?? null,
      source: inWindow ? 'forecast' : 'seasonal',
      days: inWindow && d
        ? d.time.map((date, i) => ({
            date,
            max: d.temperature_2m_max[i],
            min: d.temperature_2m_min[i],
            rainChance: d.precipitation_probability_max?.[i] ?? null,
            rainMm: d.precipitation_sum?.[i] ?? null,
            uv: d.uv_index_max?.[i] ?? null,
          }))
        : [],
    };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { value: out, expires: now() + CACHE_TTL });
    logger?.info?.(`Weather ${out.source} for ${key}`);
    return out;
  }

  return { forecast };
}

module.exports = { createWeather, todayIst, addDays, HORIZON_DAYS };
