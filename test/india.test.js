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
    { title: 'Chennai Egmore railway station', description: 'railway station in Chennai', coordinates: [{ lat: 13.07, lon: 80.26 }] },
    { title: 'Guindy metro station', description: 'metro station in Chennai', coordinates: [{ lat: 13.0, lon: 80.2 }] },
    { title: 'No coords temple' },
  ];
  let requested;
  const wiki = createWikipedia({
    fetchImpl: async (url) => {
      requested = url;
      return { ok: true, text: async () => JSON.stringify({ query: { pages } }) };
    },
  });
  const { sights, rail } = await wiki.placesAround('chennai', 13.0827, 80.2707);
  assert.equal(requested.hostname, 'en.wikipedia.org');
  assert.equal(requested.searchParams.get('ggscoord'), '13.08270|80.27070');
  assert.equal(requested.searchParams.get('colimit'), 'max', 'otherwise only 10 pages get coordinates');
  assert.deepEqual(rail.map((r) => r.name).sort(), ['Chennai Central', 'Chennai Egmore'], 'metro excluded');
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
    assert.match(plan.headers.get('cache-control'), /s-maxage=60/);
  } finally {
    await down.close();
  }

  // Overpass down entirely, but Wikipedia rescues the sights.
  const rescued = await startServer(
    {},
    {
      overpass: { placesAround: async () => ({ sights: [], food: [], stays: [], rail: [], bus: [], failed: ['sights', 'food', 'hubs'], issue: 'timeout' }) },
      wikipedia: { placesAround: async () => ({ sights: FAKE_PLACES.sights.map((s) => ({ ...s, wikiCategory: 'Heritage' })), rail: [] }) },
    }
  );
  try {
    const plan = await client(rescued.base).req('/api/plan?destination=chennai&days=3');
    assert.equal(plan.status, 200);
    assert.equal(plan.json.destination.degraded, false);
    assert.equal(plan.json.destination.liveStatus, 'partial');
    assert.deepEqual(plan.json.destination.failedParts, ['food', 'hubs'], 'sights were covered, so not reported');
    assert.equal(plan.json.destination.sightsSource, 'wikipedia');
    assert.ok(plan.json.itinerary[0].stops.length > 0, 'day 1 has real stops');
    assert.match(plan.headers.get('cache-control'), /s-maxage=60/);
  } finally {
    await rescued.close();
  }

  // Overpass sights + hubs fail, but Wikipedia covers both → no gaps to report.
  const covered = await startServer(
    {},
    {
      overpass: { placesAround: async () => ({ ...FAKE_PLACES, sights: [], rail: [], bus: [], failed: ['sights', 'hubs'], issue: 'http_500' }) },
      wikipedia: { placesAround: async () => ({ sights: FAKE_PLACES.sights, rail: [{ name: 'Leh', lat: 34.1, lng: 77.5, notable: true, hours: null, tags: {} }] }) },
    }
  );
  try {
    const plan = await client(covered.base).req('/api/plan?destination=leh&days=2');
    assert.equal(plan.json.destination.liveStatus, 'ok');
    assert.ok(plan.json.transport.reach.some((r) => r.mode === 'Train' && r.hub === 'Leh'));
  } finally {
    await covered.close();
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

test('search: typos, transliterations, old names, districts and states', () => {
  const cur = new Set(['delhi', 'mumbai', 'goa', 'jaipur', 'agra', 'udaipur', 'varanasi', 'hyderabad']);
  const top = (q) => india.search(q, 5, cur).results[0];
  assert.equal(top('Thirunelveli').slug, 'tirunelveli');
  assert.equal(top('Kanniyakumari').slug, 'kanyakumari');
  assert.equal(top('Madras').slug, 'chennai');
  assert.equal(top('Tuticorin').slug, 'thoothukudi');
  assert.equal(top('Thanjavoor').slug, 'thanjavur');
  assert.equal(top('Hydrabad').slug, 'hyderabad');
  assert.equal(top('Orissa').type, 'state');
  assert.equal(top('tamilnadu').code, 'TN');
  assert.equal(top('Tenkasi').slug, 'tenkasi', 'district HQ town');
  assert.equal(top('Thenkasi').slug, 'tenkasi', 'GeoNames spelling still finds it');
  assert.equal(top('Theni').slug, 'theni');
  assert.equal(top('Thane').slug, 'thane');
  assert.equal(top('Ranipet').type, 'district');
  assert.equal(top('Nilgiris').type, 'district');
  assert.equal(india.search('Hydrabad', 5, cur).exact, false, 'typo corrections are flagged as "did you mean"');
  assert.equal(india.search('Chennai', 5, cur).exact, true);
  assert.deepEqual(india.search('zzqqxx').results, []);
});

test('every state lists its districts; Tamil Nadu has all 38', () => {
  const tn = india.getState('TN');
  assert.equal(tn.name, 'Tamil Nadu');
  assert.equal(tn.districts.length, 38);
  assert.equal(tn.capital.slug, 'chennai');
  for (const st of india.listStates()) {
    const full = india.getState(st.code);
    assert.ok(full.districts.length >= 1, st.name);
    for (const d of full.districts) assert.match(d.slug, /^[a-z0-9][a-z0-9 -]{0,58}$/);
  }
  const districtsData = require('../server/data/india-districts.json');
  assert.ok(districtsData.length >= 740);
  assert.equal(new Set(districtsData.map((d) => d.slug)).size, districtsData.length);
});

test('API: districts plan, states overview, did-you-mean search', async () => {
  const srv = await startServer();
  try {
    const c = client(srv.base);
    const s = await c.req('/api/cities?q=Thirunelveli');
    assert.equal(s.json.cities[0].slug, 'tirunelveli');
    const typo = await c.req('/api/cities?q=Coimbatur');
    assert.equal(typo.json.exact, false);
    assert.equal(typo.json.cities[0].slug, 'coimbatore');

    const plan = await c.req('/api/plan?destination=district-tenkasi-tn&days=2');
    assert.equal(plan.status, 200);
    assert.match(plan.json.destination.name, /Tenkasi district/);
    assert.equal(plan.json.destination.region, 'Tamil Nadu');

    const st = await c.req('/api/states/tn');
    assert.equal(st.status, 200);
    assert.equal(st.json.districts.length, 38);
    assert.equal((await c.req('/api/states/zz')).status, 404);
    assert.equal((await c.req('/api/states/t1')).status, 400);

    const viaState = await c.req('/api/plan?destination=state-tn&days=2');
    assert.equal(viaState.json.destination.slug, 'chennai', 'a state plans around its capital');

    const list = await c.req('/api/destinations');
    assert.equal(list.json.states.length, 36);
    assert.ok(list.json.totalDistricts >= 740);
  } finally {
    await srv.close();
  }
});

test('Wikipedia name search finds district sights and drops far-away namesakes', async () => {
  const urls = [];
  const wiki = createWikipedia({
    fetchImpl: async (url) => {
      urls.push(url);
      const pages =
        url.searchParams.get('generator') === 'search'
          ? [
              { title: 'Courtallam Falls', description: 'waterfall in Tenkasi district', coordinates: [{ lat: 8.93, lon: 77.27 }] },
              { title: 'Kasi Viswanathar Temple, Tenkasi', description: 'Hindu temple', coordinates: [{ lat: 8.96, lon: 77.3 }] },
              { title: 'Tenkasi Lake (Kashmir)', description: 'lake in Kashmir', coordinates: [{ lat: 34.0, lon: 74.8 }] },
            ]
          : [];
      return { ok: true, text: async () => JSON.stringify({ query: { pages } }) };
    },
  });
  const { sights } = await wiki.placesAround('district-tenkasi-tn', 9.017, 77.4239, 'Tenkasi district');
  assert.equal(urls.length, 2, 'point search + name search');
  const search = urls.find((u) => u.searchParams.get('generator') === 'search');
  assert.match(search.searchParams.get('gsrsearch'), /^"Tenkasi" temple OR falls/);
  assert.deepEqual(sights.map((x) => x.name).sort(), ['Courtallam Falls', 'Kasi Viswanathar Temple, Tenkasi']);

  // Names are reduced to letters, so nothing odd reaches the search query.
  await createWikipedia({ fetchImpl: async (url) => { urls.push(url); return { ok: true, text: async () => '{"query":{"pages":[]}}' }; } })
    .placesAround('x', 1, 2, 'Foo" OR insource:/x/');
  assert.match(urls.at(-1).searchParams.get('gsrsearch'), /^"Foo OR insource x" /);
});
