'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { destinations } = require('../server/data/destinations');
const { generateItinerary, feeAmount } = require('../server/services/itinerary');
const { compareFares } = require('../server/services/fares');
const { createOpenTripMap } = require('../server/services/opentripmap');
const { startServer, client } = require('./helpers');

test('every destination produces a complete plan for 1–14 days and every budget', () => {
  for (const dest of destinations) {
    for (const budget of ['budget', 'comfort', 'premium']) {
      for (const days of [1, 3, 7, 14]) {
        const p = generateItinerary(dest, { days, travelers: 3, budget });
        assert.equal(p.itinerary.length, days, `${dest.slug} ${days}`);
        for (const day of p.itinerary) {
          assert.ok(day.stops.length || day.note, `${dest.slug} day ${day.day} empty`);
          assert.ok(day.meals.lunch && day.meals.dinner);
        }
        assert.ok(p.estimate.total > 0);
        assert.ok(p.stays.affordable.length && p.stays.premium.length);
        assert.ok(p.transport.public.length && p.transport.private.length);
      }
    }
  }
});

test('attractions are never repeated across days', () => {
  for (const dest of destinations) {
    const p = generateItinerary(dest, { days: 5, travelers: 2, budget: 'comfort' });
    const names = p.itinerary.flatMap((d) => d.stops.map((s) => s.name));
    assert.equal(new Set(names).size, names.length, dest.slug);
  }
});

test('all outbound links are https Google Maps / Booking URLs', () => {
  const p = generateItinerary(destinations[0], { days: 3, travelers: 2, budget: 'comfort' });
  const urls = [...p.attractions, ...p.restaurants, ...p.stays.premium].map((x) => x.mapsUrl);
  urls.push(p.stays.bookingSearchUrl);
  for (const u of urls) assert.match(u, /^https:\/\/www\.(google\.com\/maps|booking\.com)\//);
});

test('fare comparison groups by vehicle with cheapest first', () => {
  const cmp = compareFares(destinations.find((d) => d.slug === 'delhi'), 10);
  assert.ok(cmp.groups.length >= 4);
  for (const g of cmp.groups) {
    const lows = g.options.map((o) => o.low);
    assert.deepEqual(lows, [...lows].sort((a, b) => a - b));
    assert.equal(g.options.filter((o) => o.cheapest).length, 1);
    for (const o of g.options) assert.ok(o.high >= o.low && o.low > 0);
  }
  assert.ok(cmp.groups.find((g) => g.category === 'Auto').options.some((o) => o.app.includes('meter')));
});

test('fee parsing', () => {
  assert.equal(feeAmount('₹50 / ₹1,100'), 50);
  assert.equal(feeAmount('Free'), 0);
  assert.equal(feeAmount('₹1,500+'), 1500);
});

test('OpenTripMap provider keeps the API key server-side and sanitises remote data', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    const body = url.pathname.endsWith('/geoname')
      ? { name: 'Pondicherry<script>', country: 'IN', lat: 11.93, lon: 79.83, status: 'OK' }
      : [{ name: 'Promenade <img src=x onerror=alert(1)>', rate: 3, kinds: 'beaches,natural', point: { lat: 11.93, lon: 79.84 } }];
    return { ok: true, text: async () => JSON.stringify(body) };
  };
  const otm = createOpenTripMap('test-key-123', { fetchImpl: fakeFetch });
  const dest = await otm.lookup('pondicherry');
  assert.equal(calls[0].hostname, 'api.opentripmap.com');
  assert.ok(!/[<>]/.test(dest.name) && !/[<>]/.test(dest.attractions[0].name));

  const srv = await startServer();
  try {
    // The key must never appear in API responses.
    const r = await client(srv.base).req('/api/destinations');
    assert.ok(!r.text.includes('test-key-123'));
  } finally {
    await srv.close();
  }
});

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

test('plan API end-to-end', async () => {
  const c = client(srv.base);
  const list = await c.req('/api/destinations');
  assert.equal(list.status, 200);
  assert.equal(list.json.destinations.length, destinations.length);

  const plan = await c.req('/api/plan?destination=udaipur&days=4&travelers=2&budget=premium');
  assert.equal(plan.status, 200);
  assert.equal(plan.json.itinerary.length, 4);

  const unknown = await c.req('/api/plan?destination=atlantis');
  assert.equal(unknown.status, 404);

  const fares = await c.req('/api/fares?destination=mumbai&km=12');
  assert.equal(fares.status, 200);
  assert.equal(fares.json.distanceKm, 12);
});
