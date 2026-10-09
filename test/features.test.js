'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const hours = require('../server/services/hours');
const { sunTimes } = require('../server/services/sun');
const { buildAdvice } = require('../server/services/advice');
const { createWeather, todayIst, addDays } = require('../server/services/weather');
const { createGooglePlaces, periodsToWeek } = require('../server/services/googlePlaces');
const { imageKind } = require('../server/services/vision');
const { generateItinerary } = require('../server/services/itinerary');
const { destinations } = require('../server/data/destinations');
const { startServer, client } = require('./helpers');

const PW = 'Tr4vel-Safely-2026';

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------
test('opening hours: common OSM formats, overnight hours, unknown stays unknown', () => {
  const w = hours.parseOpeningHours('Mo-Sa 11:00-15:00,19:00-23:00; Su off');
  assert.equal(hours.describe(w), 'Mon–Sat 11:00–15:00, 19:00–23:00 · Sun Closed');
  assert.equal(hours.isOpenAt(w, 0, 13 * 60), true);
  assert.equal(hours.isOpenAt(w, 0, 17 * 60), false);
  assert.equal(hours.isOpenAt(w, 6, 13 * 60), false);

  const late = hours.parseOpeningHours('Tu-Su 18:00-02:00');
  assert.equal(hours.isOpenAt(late, 0, 60), true, 'Sunday night spills into Monday');
  assert.equal(hours.isOpenAt(late, 0, 20 * 60), false, 'days no rule mentions are closed');

  assert.equal(hours.parseOpeningHours('Jan-Mar 10:00-12:00'), null, 'unsupported → unknown, never guessed');
  assert.equal(hours.isOpenAt(null, 0, 600), null);
  assert.equal(hours.describe(hours.parseOpeningHours('24/7')), 'Open 24 hours');
  assert.equal(hours.closureFromTags({ note: 'Closed for renovation until December' }), 'temporarily_closed');
  assert.equal(hours.closureFromTags({ opening_hours: 'off' }), 'temporarily_closed');
  assert.equal(hours.closureFromTags({ description: 'Permanently closed' }), 'permanently_closed');
  assert.equal(hours.weekdayIndex('2026-10-12'), 0, '12 Oct 2026 is a Monday');
});

test('sunrise and sunset match published values within a few minutes', () => {
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const delhi = sunTimes(28.6139, 77.209, '2026-12-21'); // ~07:10 / ~17:29 IST
  assert.ok(Math.abs(toMin(delhi.sunrise) - (7 * 60 + 10)) <= 4, delhi.sunrise);
  assert.ok(Math.abs(toMin(delhi.sunset) - (17 * 60 + 29)) <= 4, delhi.sunset);
});

// ---------------------------------------------------------------------------
// Advice
// ---------------------------------------------------------------------------
test('advice: forecast-driven packing (rain, cold, heat, UV)', () => {
  const a = buildAdvice({
    state: 'Kerala',
    start: '2026-10-10',
    days: 2,
    weather: { source: 'forecast', elevation: 1600, days: [{ date: '2026-10-10', max: 24, min: 4, rainChance: 80, rainMm: 12, uv: 9 }] },
    categories: ['Spiritual', 'Nature'],
  });
  const texts = a.pack.map((p) => p.text).join(' | ');
  assert.match(texts, /Umbrella/);
  assert.match(texts, /Thermals/);
  assert.match(texts, /SPF 50/);
  assert.match(texts, /warm layer/);
  assert.ok(a.dos.some((d) => /Dress modestly/.test(d)));
  assert.equal(a.source, 'forecast');
  assert.ok(a.emergency.some((e) => e.number === '112'));
});

test('advice: seasonal rules, dry states, permits, altitude', () => {
  const monsoonGoa = buildAdvice({ state: 'Goa', start: '2027-07-10', days: 3, weather: null, categories: ['Beach'] });
  assert.ok(monsoonGoa.pack.some((p) => /Umbrella/.test(p.text)));
  assert.ok(monsoonGoa.donts.some((d) => /rough/.test(d)));
  const gujarat = buildAdvice({ state: 'Gujarat', start: '2027-05-10', days: 2 });
  assert.ok(gujarat.alerts.some((x) => /prohibition/.test(x)));
  assert.ok(gujarat.pack.some((p) => /cotton/.test(p.text)), 'May in Gujarat is hot');
  const nagaland = buildAdvice({ state: 'Nagaland', start: '2027-01-10', days: 2 });
  assert.ok(nagaland.alerts.some((x) => /Inner Line Permit/.test(x)));
  const leh = buildAdvice({ state: 'Ladakh', start: '2027-01-10', days: 3, weather: { source: 'seasonal', elevation: 3500, days: [] } });
  assert.ok(leh.alerts.some((x) => /High altitude/.test(x)));
});

test('weather client: forecast inside the window, elevation-only beyond it', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const daily = url.searchParams.get('start_date')
      ? { time: ['d1'], temperature_2m_max: [31], temperature_2m_min: [22], precipitation_probability_max: [70], precipitation_sum: [8], uv_index_max: [7] }
      : undefined;
    return { ok: true, text: async () => JSON.stringify({ elevation: 6, daily }) };
  };
  const wx = createWeather({ fetchImpl });
  const near = await wx.forecast(13.08, 80.27, addDays(todayIst(), 2), 1);
  assert.equal(near.source, 'forecast');
  assert.equal(near.days[0].rainChance, 70);
  assert.equal(calls[0].hostname, 'api.open-meteo.com');
  const far = await wx.forecast(13.08, 80.27, addDays(todayIst(), 90), 3);
  assert.equal(far.source, 'seasonal');
  assert.equal(far.elevation, 6);
  await assert.rejects(() => wx.forecast('x', 1, todayIst(), 1));
});

// ---------------------------------------------------------------------------
// Itinerary: hours-aware meals, closures, photo spots, events
// ---------------------------------------------------------------------------
test('meals avoid temporarily closed restaurants and ones shut at meal time', () => {
  const base = destinations.find((d) => d.slug === 'jaipur');
  const restaurants = [
    { name: 'Closed For Works', area: 'Old City', cuisine: 'X', tier: 'comfort', rating: 5, lat: 26.92, lng: 75.82, status: 'temporarily_closed', week: null },
    { name: 'Dinner Only', area: 'Old City', cuisine: 'X', tier: 'comfort', rating: 4.9, lat: 26.92, lng: 75.82, week: hours.parseOpeningHours('18:00-23:00') },
    { name: 'All Day', area: 'Old City', cuisine: 'X', tier: 'comfort', rating: 4.0, lat: 26.92, lng: 75.82, week: hours.parseOpeningHours('10:00-23:00'), phone: '+911412345678' },
    { name: 'Mondays Off', area: 'Old City', cuisine: 'X', tier: 'comfort', rating: 3.9, lat: 26.92, lng: 75.82, week: hours.parseOpeningHours('Tu-Su 11:00-23:00') },
  ];
  const plan = generateItinerary({ ...base, restaurants }, { days: 2, travelers: 2, budget: 'comfort', start: '2026-10-12' });
  for (const day of plan.itinerary) {
    assert.notEqual(day.meals.lunch?.name, 'Closed For Works');
    assert.notEqual(day.meals.lunch?.name, 'Dinner Only', 'not open at lunch time');
    assert.notEqual(day.meals.dinner?.name, 'Closed For Works');
  }
  assert.equal(plan.itinerary[0].weekday, 'Mon');
  assert.notEqual(plan.itinerary[0].meals.lunch?.name, 'Mondays Off');
  assert.equal(plan.itinerary[0].meals.lunch.openAtMeal, true);

  const allDay = plan.restaurants.find((r) => r.name === 'All Day');
  assert.equal(allDay.hoursText, 'Mon–Sun 10:00–23:00');
  assert.equal(allDay.reserve.call, 'tel:+911412345678');
  assert.match(allDay.reserve.search, /^https:\/\/www\.google\.com\/search\?q=reserve/);
  const mondays = plan.restaurants.find((r) => r.name === 'Mondays Off');
  assert.deepEqual(mondays.closedOnTripDays, ['Day 1 (Mon)']);
  assert.ok(!plan.restaurants.some((r) => 'week' in r), 'internal hours data not leaked');

  assert.ok(plan.itinerary[0].sun.sunrise);
  assert.ok(plan.photoSpots.length > 0 && plan.photoSpots.every((p) => p.tip));
  assert.ok(plan.events.links.every((l) => l.url.startsWith('https://')));
});

// ---------------------------------------------------------------------------
// Google Places (optional) — key stays in a header, data normalised
// ---------------------------------------------------------------------------
test('Google Places: key in header only, closures, price tiers and hours mapped', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          places: [
            {
              id: 'a', displayName: { text: 'Saravana <b>Bhavan</b>' }, location: { latitude: 13.05, longitude: 80.25 },
              rating: 4.36, userRatingCount: 1200, priceLevel: 'PRICE_LEVEL_INEXPENSIVE', businessStatus: 'OPERATIONAL',
              regularOpeningHours: { periods: [{ open: { day: 1, hour: 7, minute: 0 }, close: { day: 1, hour: 22, minute: 30 } }] },
              reservable: true, googleMapsUri: 'https://maps.google.com/?cid=1', nationalPhoneNumber: '044 2345 6789',
            },
            { id: 'b', displayName: { text: 'Under Renovation Cafe' }, location: { latitude: 13.05, longitude: 80.25 }, businessStatus: 'CLOSED_TEMPORARILY' },
            { id: 'c', displayName: { text: 'Gone For Good' }, location: { latitude: 13.05, longitude: 80.25 }, businessStatus: 'CLOSED_PERMANENTLY' },
            { id: 'd', displayName: { text: 'Evil link' }, location: { latitude: 13.05, longitude: 80.25 }, googleMapsUri: 'javascript:alert(1)' },
          ],
        }),
    };
  };
  const gp = createGooglePlaces('test-places-key', { fetchImpl });
  const list = await gp.restaurantsNear('chennai', 13.08, 80.27, 3000);
  assert.ok(!String(seen.url).includes('test-places-key'), 'key never in the URL');
  assert.equal(seen.opts.headers['X-Goog-Api-Key'], 'test-places-key');
  assert.match(seen.opts.headers['X-Goog-FieldMask'], /businessStatus/);
  assert.equal(list.length, 3, 'permanently closed dropped');
  assert.ok(!/[<>]/.test(list[0].name));
  assert.equal(list[0].tier, 'budget');
  assert.equal(list[0].phone, '04423456789');
  assert.equal(list[0].reservable, true);
  assert.equal(hours.describe(list[0].week), 'Mon 07:00–22:30 · Tue–Sun Closed', 'Google day 1 = Monday');
  assert.equal(list[1].status, 'temporarily_closed');
  assert.equal(list[2].googleMapsUri, null, 'unsafe links dropped');
  assert.equal(hours.describe(periodsToWeek([{ open: { day: 0, hour: 0 } }])), 'Open 24 hours');
});

// ---------------------------------------------------------------------------
// API: dates, advice, photo location, uploads, customised trips
// ---------------------------------------------------------------------------
test('plan API: start date validation, dated days, advice included', async () => {
  const weather = { forecast: async () => ({ source: 'forecast', elevation: 400, days: [{ date: 'x', max: 38, min: 26, rainChance: 10, rainMm: 0, uv: 9 }] }) };
  const srv = await startServer({}, { weather });
  try {
    const c = client(srv.base);
    const start = addDays(todayIst(), 3);
    const ok = await c.req(`/api/plan?destination=jaipur&days=2&start=${start}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.itinerary[0].date, start);
    assert.equal(ok.json.advice.source, 'forecast');
    assert.ok(ok.json.advice.pack.some((p) => /cotton/.test(p.text)));
    for (const bad of ['2026-02-30', '2020-01-01', addDays(todayIst(), 400), 'tomorrow', '2026-1-1']) {
      assert.equal((await c.req(`/api/plan?destination=jaipur&start=${encodeURIComponent(bad)}`)).status, 400, bad);
    }
  } finally {
    await srv.close();
  }
});

test('photo locate: India-only coordinates, nearest town, private (no-store)', async () => {
  const wikipedia = { placesAround: async () => ({ sights: [{ name: 'Marina Beach', lat: 13.05, lng: 80.28, wikiCategory: 'Beach' }], rail: [] }) };
  const srv = await startServer({}, { wikipedia });
  try {
    const c = client(srv.base);
    const r = await c.req('/api/locate?lat=13.0500&lng=80.2824');
    assert.equal(r.status, 200);
    assert.equal(r.json.nearest.slug, 'chennai');
    assert.equal(r.json.nearby[0].name, 'Marina Beach');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal((await c.req('/api/locate?lat=51.5&lng=-0.12')).status, 400, 'outside India');
    assert.equal((await c.req('/api/locate?lat=abc&lng=80')).status, 400);
  } finally {
    await srv.close();
  }
});

test('photo upload: disabled without a key; type, size and magic-byte checks', async () => {
  const off = await startServer();
  try {
    const r = await client(off.base).req('/api/photo/landmark', { method: 'POST', raw: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]), headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(r.status, 503);
  } finally {
    await off.close();
  }

  let received = null;
  const vision = { landmarks: async (buf) => { received = buf; return [{ name: 'Gateway of India', score: 0.93, lat: 18.922, lng: 72.8347 }]; } };
  const srv = await startServer({}, { vision, wikipedia: { placesAround: async () => ({ sights: [], rail: [] }) } });
  try {
    const c = client(srv.base);
    const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
    const ok = await c.req('/api/photo/landmark', { method: 'POST', raw: fakeJpeg, headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.landmarks[0].name, 'Gateway of India');
    assert.equal(ok.json.nearest.slug, 'mumbai');
    assert.equal(received.length, fakeJpeg.length);

    const html = await c.req('/api/photo/landmark', { method: 'POST', raw: Buffer.from('<html><script>alert(1)</script></html>'), headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(html.status, 415, 'content is checked, not just the header');
    const wrongType = await c.req('/api/photo/landmark', { method: 'POST', raw: 'hello', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(wrongType.status, 415);
    const huge = await c.req('/api/photo/landmark', { method: 'POST', raw: Buffer.concat([fakeJpeg, Buffer.alloc(5 * 1024 * 1024)]), headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(huge.status, 413);
  } finally {
    await srv.close();
  }
  assert.equal(imageKind(Buffer.from('RIFF0000WEBPVP8 ')), 'webp');
  assert.equal(imageKind(Buffer.from('GIF89a000000')), null);
});

test('saved trips keep start date + customised itinerary; owner-only updates', async () => {
  const srv = await startServer();
  try {
    const reg = async (email) => {
      const c = client(srv.base);
      assert.equal((await c.req('/api/auth/register', { method: 'POST', body: { name: 'Trip Tester', email, password: PW } })).status, 201);
      return c;
    };
    const alice = await reg('custom-alice@example.com');
    const bob = await reg('custom-bob@example.com');
    const custom = {
      days: [
        { note: 'Slow start <script>x</script>', stops: [{ name: 'Hawa Mahal', area: 'Old City', lat: 26.92, lng: 75.83 }, { name: 'Chai at Tapri', custom: true }] },
        { stops: [] },
      ],
    };
    const created = await alice.req('/api/trips', {
      method: 'POST',
      body: { title: 'Pink City my way', destination: 'jaipur', days: 2, travelers: 2, budget: 'comfort', start: '2026-12-01', custom },
      headers: { 'X-CSRF-Token': alice.csrf },
    });
    assert.equal(created.status, 201);
    const id = created.json.trip.id;

    const list = await alice.req('/api/trips');
    const saved = list.json.trips[0];
    assert.equal(saved.start, '2026-12-01');
    assert.equal(saved.custom.days[0].stops[1].name, 'Chai at Tapri');
    assert.ok(!/[<>]/.test(saved.custom.days[0].note), 'notes sanitised');

    const wrongDays = await alice.req(`/api/trips/${id}`, { method: 'PUT', body: { custom: { days: [{ stops: [] }] } }, headers: { 'X-CSRF-Token': alice.csrf } });
    assert.equal(wrongDays.status, 400);
    const bobEdit = await bob.req(`/api/trips/${id}`, { method: 'PUT', body: { custom: null }, headers: { 'X-CSRF-Token': bob.csrf } });
    assert.equal(bobEdit.status, 404, 'cannot edit someone else’s trip');
    const noCsrf = await alice.req(`/api/trips/${id}`, { method: 'PUT', body: { custom: null } });
    assert.equal(noCsrf.status, 403);
    const extraKey = await alice.req('/api/trips', {
      method: 'POST',
      body: { title: 'x y', destination: 'jaipur', days: 1, travelers: 1, budget: 'comfort', custom: { days: [{ stops: [{ name: 'A', html: '<b>' }] }] } },
      headers: { 'X-CSRF-Token': alice.csrf },
    });
    assert.equal(extraKey.status, 400, 'unknown fields rejected');
  } finally {
    await srv.close();
  }
});
