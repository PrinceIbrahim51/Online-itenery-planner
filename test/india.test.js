'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cities = require('../server/data/india-cities.json');
const india = require('../server/services/india');
const { createOverpass, buildQueries, normalise, issueCode } = require('../server/services/overpass');
const { createWikipedia } = require('../server/services/wikipedia');
const { generateItinerary } = require('../server/services/itinerary');
const { loadConfig } = require('../server/config');
const { startServer, client } = require('./helpers');

const FAKE_PLACES = {
  sights: [
    { name: 'Leh Palace', lat: 34.1659, lng: 77.5845, notable: true, hours: '09:00-16:00', tags: { historic: 'palace', fee: 'yes' } },
    { name: 'Shanti Stupa', lat: 34.1735, lng: 77.5634, notable: true, hours: null, tags: { amenity: 'place_of_worship', religion: 'buddhist' } },
    { name: 'Hall of Fame Museum', lat: 34.137, lng: 77.5683, notable: false, hours: null, tags: { tourism: 'museum' } },
  ],
  food: [{ name: 'Bon Appetit', lat: 34.161, lng: 77.585, notable: false, hours: null, tags: { amenity: 'restaurant', cuisine: 'tibetan' } }],
  stays: [
    { name: 'Zostel Leh', lat: 34.163, lng: 77.58, notable: false, hours: null, tags: { tourism: 'hostel' } },
    { name: 'The Grand Dragon', lat: 34.158, lng: 77.581, notable: true, hours: null, tags: { tourism: 'hotel', stars: '5' } },
  ],
  rail: [],
  bus: [{ name: 'Leh Bus Stand', lat: 34.159, lng: 77.583, notable: false, hours: null, tags: { amenity: 'bus_station' } }],
};

test('dataset covers every state and union territory with valid, unique slugs', () => {
  assert.ok(cities.length > 3000, `${cities.length} cities`);
  assert.equal(new Set(cities.map((c) => c.state)).size, 36);
  assert.equal(new Set(cities.map((c) => c.slug)).size, cities.length);
  for (const c of cities) {
    assert.match(c.slug, /^[a-z0-9][a-z0-9 -]{0,58}$/);
    assert.ok(c.lat > 6 && c.lat < 37 && c.lng > 68 && c.lng < 98, c.slug);
  }
  for (const slug of ['mumbai', 'kochi', 'leh', 'shimla', 'darjeeling', 'gangtok', 'port-blair', 'puducherry', 'nainital', 'prayagraj']) {
    assert.ok(india.getCity(slug), slug);
  }
});

test('city search: prefixes, aliases, accents and tourist favourites', () => {
  const curated = new Set(['mumbai']);
  assert.equal(india.searchCities('mumb', 5, curated)[0].slug, 'mumbai');
  assert.equal(india.searchCities('allahabad')[0].slug, 'prayagraj');
  assert.equal(india.searchCities('Manali')[0].slug, 'manali-hp');
  assert.equal(india.searchCities('Cochin')[0].slug, 'kochi');
  assert.ok(india.searchCities('Sūrat').some((c) => c.slug === 'surat'));
  assert.deepEqual(india.searchCities(''), []);
  assert.ok(india.searchCities('a').length <= 12);
});

test('Overpass queries are built only from numbers and stay small for big cities', () => {
  const q = buildQueries(34.16, 77.58, 6000);
  assert.match(q.sights, /around:6000,34\.16000,77\.58000/);
  assert.match(q.food, /around:2400,/, 'restaurants searched close to the centre');
  for (const part of Object.values(buildQueries(13.08, 80.27, 9000))) {
    const radii = [...part.matchAll(/around:(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(Math.max(...radii) <= 25000, 'no huge-radius scans');
    assert.match(part, /out tags/);
  }
  assert.throws(() => buildQueries('34];out;', 77, 1000));
  assert.throws(() => buildQueries(NaN, 77, 1000));
});

test('failure codes are coarse and safe to show', () => {
  assert.equal(issueCode(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout');
  assert.equal(issueCode(new Error('Overpass 429')), 'http_429');
  assert.equal(issueCode(new Error('fetch failed')), 'network');
});

test('Overpass results are validated, sanitised and de-duplicated', () => {
  const out = normalise([
    { type: 'node', id: 1, lat: 1, lon: 2, tags: { name: 'Fort <script>alert(1)</script>', historic: 'fort' } },
    { type: 'node', id: 2, lat: 1, lon: 2, tags: { name: 'Fort <script>alert(1)</script>', historic: 'fort' } },
    { type: 'way', id: 3, center: { lat: 1, lon: 2 }, tags: { name: 'Cafe One', amenity: 'cafe' } },
    { type: 'node', id: 4, tags: { name: 'No coords' } },
    { type: 'bogus', id: 5 },
    'garbage',
  ]);
  assert.equal(out.sights.length, 1);
  assert.ok(!/[<>]/.test(out.sights[0].name));
  assert.equal(out.food.length, 1);
});

test('Overpass client falls back to a mirror and caches results', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (String(url).includes('first')) throw new Error('down');
    return { ok: true, text: async () => JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 1, lon: 2, tags: { name: 'Museum', tourism: 'museum' } }] }) };
  };
  const op = createOverpass({ fetchImpl, endpoints: ['https://first.example/api', 'https://second.example/api'] });
  const a = await op.placesAround('x', 1, 2, 1000);
  const b = await op.placesAround('x', 1, 2, 1000);
  assert.equal(a.sights.length, 1, 'de-duplicated across the parallel queries');
  assert.equal(a.sights[0].name, 'Museum');
  assert.deepEqual(a.failed, []);
  assert.equal(a, b, 'complete results are cached');
  assert.equal(calls, 5, '3 parts, 2 of which hit the dead endpoint first');
});

test('one slow part does not wipe out the others; partial results are not cached', async () => {
  let calls = 0;
  const fetchImpl = async (_url, opts) => {
    calls++;
    if (decodeURIComponent(opts.body).includes('restaurant')) throw Object.assign(new Error('slow'), { name: 'TimeoutError' });
    return { ok: true, text: async () => JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 1, lon: 2, tags: { name: 'Fort', historic: 'fort' } }] }) };
  };
  const op = createOverpass({ fetchImpl, endpoints: ['https://a.example/api', 'https://b.example/api'] });
  const r = await op.placesAround('y', 1, 2, 1000);
  assert.equal(r.sights.length, 1);
  assert.deepEqual(r.failed, ['food']);
  assert.equal(r.issue, 'timeout');
  const before = calls;
  await op.placesAround('y', 1, 2, 1000);
  assert.ok(calls > before, 'partial result was retried, not served from cache');
});

test('Wikipedia fallback keeps real sights and drops schools, stations and wards', async () => {
  const pages = [
    { title: 'Kapaleeshwarar Temple', description: 'Hindu temple in Chennai', coordinates: [{ lat: 13.03, lon: 80.27 }] },
    { title: 'Marina Beach', description: 'urban beach in Chennai', coordinates: [{ lat: 13.05, lon: 80.28 }] },
    { title: 'Fort St. George', description: 'fortress in Chennai', coordinates: [{ lat: 13.08, lon: 80.29 }] },
    { title: 'Chennai Central', description: 'railway station in Chennai', coordinates: [{ lat: 13.08, lon: 80.27 }] },
    { title: 'Presidency College', description: 'college in Chennai', coordinates: [{ lat: 13.06, lon: 80.28 }] },
    { title: 'Ward 120 <script>', description: 'temple ward', coordinates: [{ lat: 13.06, lon: 80.28 }] },
    { title: 'No coords temple' },
  ];
  let requested;
  const wiki = createWikipedia({
    fetchImpl: async (url) => {
      requested = url;
      return { ok: true, text: async () => JSON.stringify({ query: { pages } }) };
    },
  });
  const sights = await wiki.sightsAround('chennai', 13.0827, 80.2707);
  assert.equal(requested.hostname, 'en.wikipedia.org');
  assert.equal(requested.searchParams.get('ggscoord'), '13.08270|80.27070');
  assert.deepEqual(sights.map((s) => s.name).sort(), ['Fort St. George', 'Kapaleeshwarar Temple', 'Marina Beach']);
  assert.equal(sights.find((s) => s.name === 'Marina Beach').wikiCategory, 'Beach');
});

test('live destination: no fabricated ratings, typical stay prices, real transport hubs', () => {
  const dest = india.toDestination(india.getCity('leh'), FAKE_PLACES);
  assert.equal(dest.region, 'Ladakh');
  assert.ok(dest.attractions.every((a) => a.rating === null));
  assert.equal(dest.stays.find((s) => s.name === 'The Grand Dragon').tier, 'premium');
  assert.equal(dest.stays.find((s) => s.name === 'Zostel Leh').tier, 'budget');
  assert.ok(dest.reach.some((r) => r.mode === 'Flight' && /IXL/.test(r.hub)), 'nearest airport is Leh (IXL)');
  assert.equal(dest.autoMeter, null, 'hill towns use shared jeeps, not meter autos');

  for (const days of [1, 4, 10]) {
    const plan = generateItinerary(dest, { days, travelers: 2, budget: 'comfort' });
    assert.equal(plan.itinerary.length, days);
    assert.ok(plan.estimate.total > 0);
    assert.ok(plan.attribution.includes('OpenStreetMap'));
  }
});

test('every city can produce a plan even with no live data', () => {
  const sample = cities.filter((_, i) => i % 97 === 0);
  for (const c of sample) {
    const dest = india.toDestination(c, { sights: [], food: [], stays: [], rail: [], bus: [] });
    const plan = generateItinerary(dest, { days: 3, travelers: 2, budget: 'budget' });
    assert.equal(plan.itinerary.length, 3, c.slug);
    assert.ok(plan.transport.reach.length >= 2, c.slug);
    assert.ok(plan.rideComparison.medium.groups.length >= 1, c.slug);
  }
});

test('API: any Indian city plans with live data; failures degrade gracefully', async () => {
  const ok = await startServer({}, { overpass: { placesAround: async () => FAKE_PLACES } });
  try {
    const c = client(ok.base);
    const plan = await c.req('/api/plan?destination=leh&days=3');
    assert.equal(plan.status, 200);
    assert.equal(plan.json.destination.source, 'live');
    assert.equal(plan.json.destination.degraded, false);
    assert.ok(plan.json.attractions.some((a) => a.name === 'Leh Palace'));
    assert.match(plan.headers.get('cache-control'), /s-maxage/);

    const search = await c.req('/api/cities?q=darj');
    assert.equal(search.json.cities[0].slug, 'darjeeling');
    const xss = await c.req(`/api/cities?q=${encodeURIComponent('<script>')}`);
    assert.ok([200, 400].includes(xss.status));

    const fares = await c.req('/api/fares?destination=nagpur&km=8');
    assert.equal(fares.status, 200);
  } finally {
    await ok.close();
  }

  const down = await startServer({}, { overpass: { placesAround: async () => { throw new Error('timeout'); } } });
  try {
    const plan = await client(down.base).req('/api/plan?destination=leh&days=2');
    assert.equal(plan.status, 200);
    assert.equal(plan.json.destination.degraded, true);
    assert.equal(plan.json.destination.liveStatus, 'unavailable');
    assert.equal(plan.headers.get('cache-control'), 'no-store');
  } finally {
    await down.close();
  }

  // Overpass down entirely, but Wikipedia rescues the sights.
  const rescued = await startServer(
    {},
    {
      overpass: { placesAround: async () => ({ sights: [], food: [], stays: [], rail: [], bus: [], failed: ['sights', 'food', 'hubs'], issue: 'timeout' }) },
      wikipedia: { sightsAround: async () => FAKE_PLACES.sights.map((s) => ({ ...s, wikiCategory: 'Heritage' })) },
    }
  );
  try {
    const plan = await client(rescued.base).req('/api/plan?destination=chennai&days=3');
    assert.equal(plan.status, 200);
    assert.equal(plan.json.destination.degraded, false);
    assert.equal(plan.json.destination.liveStatus, 'partial');
    assert.equal(plan.json.destination.sightsSource, 'wikipedia');
    assert.ok(plan.json.itinerary[0].stops.length > 0, 'day 1 has real stops');
    assert.equal(plan.headers.get('cache-control'), 'no-store');
  } finally {
    await rescued.close();
  }
});

test('Vercel without DATABASE_URL: planner works, accounts are cleanly disabled', async () => {
  const s = await startServer({ VERCEL: '1' });
  try {
    const c = client(s.base);
    const me = await c.req('/api/auth/me');
    assert.equal(me.json.accountsEnabled, false);
    const reg = await c.req('/api/auth/register', { method: 'POST', body: { name: 'A B', email: 'a@b.co', password: 'Long-enough-pass-1' } }); // scan-secrets: allow-fake-value
    assert.equal(reg.status, 503);
    assert.equal((await c.req('/api/trips')).status, 401);
    assert.equal((await c.req('/api/admin/stats')).status, 401);
    assert.equal((await c.req('/api/plan?destination=jaipur&days=2')).status, 200);
    // Vercel's rewrite may append the matched route as ?path=… — it must not break validation.
    assert.equal((await c.req('/api/plan?destination=jaipur&days=2&path=plan')).status, 200);
    assert.equal((await c.req('/api/cities?path=cities&q=goa')).status, 200);
    assert.equal((await c.req('/api/destinations?path=destinations')).status, 200);
  } finally {
    await s.close();
  }
});

test('config: DATABASE_URL must be postgres and is never echoed; Vercel trusts one proxy hop', () => {
  assert.throws(() => loadConfig({ DATABASE_URL: 'mysql://user:hunter2@db/x' }), (err) => !err.message.includes('hunter2')); // scan-secrets: allow-fake-value
  const c = loadConfig({ VERCEL: '1', DATABASE_URL: 'postgres://u:p@h/db' });
  assert.equal(c.accountsEnabled, true);
  assert.equal(c.trustProxy, 1);
  assert.equal(loadConfig({ VERCEL: '1' }).accountsEnabled, false);
});
