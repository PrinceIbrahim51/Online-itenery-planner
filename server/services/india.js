'use strict';

const cities = require('../data/india-cities.json');
const airports = require('../data/india-airports.json');
const districts = require('../data/india-districts.json');
const states = require('../data/india-states.json');
const { haversineKm } = require('./geo');
const { fold, soundKey, distance, tolerance } = require('./fuzzy');
const { parseOpeningHours, describe, closureFromTags } = require('./hours');

/**
 * Every Indian city/town (GeoNames, pop ≥ 1,000, plus popular tourist towns):
 * search, lookup, and conversion of live OpenStreetMap places into a destination
 * the itinerary engine understands. Data: GeoNames (CC BY 4.0), OurAirports (PD),
 * © OpenStreetMap contributors (ODbL).
 */
const bySlug = new Map(cities.map((c) => [c.slug, c]));
const districtsBySlug = new Map(districts.map((d) => [d.slug, d]));
const statesBySlug = new Map(states.map((st) => [st.slug, st]));
const statesByCode = new Map(states.map((st) => [st.code, st]));

// District HQ towns that share the district's name get the district as an alias
// (one "Tirunelveli" entry, not two); other districts are searchable on their own.
const hqOf = new Map();
for (const d of districts) {
  if (d.sameAsHub && d.hub) hqOf.set(d.hub, d);
}

// ---------------------------------------------------------------------------
// Unified, typo-tolerant search over states, districts and cities
// ---------------------------------------------------------------------------
const entry = (type, slug, name, state, aliases, pop, extra = {}) => {
  const names = [name, ...aliases];
  return { type, slug, name, state, pop, keys: names.map(fold), sounds: names.map(soundKey), ...extra };
};
const index = [
  ...states.map((st) => entry('state', st.slug, st.name, st.name, st.aka || [], 1e9, { code: st.code })),
  ...districts
    .filter((d) => !d.sameAsHub)
    .map((d) => entry('district', d.slug, d.name, d.state, [], (d.hub && bySlug.get(d.hub)?.pop) || 50000)),
  ...cities.map((c) => {
    const hq = hqOf.get(c.slug);
    const aliases = [...(c.aka || []), ...(hq && hq.name !== c.name ? [hq.name] : [])];
    return entry('city', c.slug, c.name, c.state, aliases, c.pop, { hq: Boolean(hq) });
  }),
];

/** Adds hand-curated guides that are not towns in the dataset (e.g. "Goa"). */
function registerFeatured(list) {
  for (const d of list) {
    if (bySlug.has(d.slug) || index.some((e) => e.slug === d.slug)) continue;
    index.push(entry('city', d.slug, d.name, d.region, [], 2e6));
  }
}

// Tourist favourites that share a name with a larger, lesser-known place.
const BOOST = new Set(['manali-hp', 'srinagar', 'aurangabad', 'chhatrapati-sambhajinagar']);

function scoreEntry(e, q, qs) {
  let best = -1;
  const tol = tolerance(qs.length);
  for (let i = 0; i < e.keys.length; i++) {
    const k = e.keys[i];
    const sk = e.sounds[i];
    let sc = -1;
    if (k === q) sc = 100;
    else if (k.startsWith(q)) sc = 80;
    else if (sk === qs) sc = 76;
    else if (qs.length >= 3 && sk.startsWith(qs)) sc = 66;
    else if (k.includes(` ${q}`)) sc = 55;
    else if (q.length >= 4 && k.includes(q)) sc = 42;
    else if (tol > 0) {
      const full = distance(qs, sk, tol);
      const prefix = sk.length > qs.length ? distance(qs, sk.slice(0, qs.length), tol) : full;
      if (full <= tol) sc = 52 - full * 10;
      else if (prefix <= tol) sc = 46 - prefix * 10;
    }
    if (sc >= 0 && i > 0) sc -= 8; // official name beats an alias / old name
    if (sc > best) best = sc;
  }
  return best;
}

/**
 * Search states, districts and cities. Results carry a `type` and a short `hint`.
 * `exact` is false when the best match needed typo correction ("did you mean").
 */
function search(query, limit = 10, curatedSlugs = new Set()) {
  const q = fold(query);
  const qs = soundKey(query);
  if (!q || !qs) return { results: [], exact: false };
  const scored = [];
  for (const e of index) {
    let sc = scoreEntry(e, q, qs);
    if (sc < 0) continue;
    if (e.type === 'district') sc += 2;
    if (curatedSlugs.has(e.slug)) sc += 6;
    if (BOOST.has(e.slug)) sc += 5;
    if (e.hq) sc += 2;
    sc += e.type === 'state' ? 10 : Math.log10(Math.max(e.pop, 1000)) * 1.2;
    scored.push({ e, sc });
  }
  scored.sort((a, b) => b.sc - a.sc);
  const top = scored.slice(0, limit);
  const results = top.map(({ e }) => {
    let hint;
    if (e.type === 'state') hint = `State · ${districtsByState.get(e.name)?.length ?? 0} districts`;
    else if (e.type === 'district') hint = `District · ${e.state}`;
    else if (curatedSlugs.has(e.slug)) hint = `Featured guide · ${e.state}`;
    else hint = `${e.hq ? 'District HQ · ' : ''}${e.state}`;
    return { slug: e.slug, name: e.name, state: e.state, type: e.type, code: e.code, hint, curated: curatedSlugs.has(e.slug) };
  });
  const exact = top.length > 0 && scoreEntry(top[0].e, q, qs) >= 66;
  return { results, exact };
}

/** Back-compat helper used by older callers/tests. */
function searchCities(query, limit = 12, curatedSlugs = new Set()) {
  return search(query, limit, curatedSlugs).results;
}

const getCity = (slug) => bySlug.get(slug) || null;

const districtsByState = new Map();
for (const d of districts) {
  const list = districtsByState.get(d.state) || [];
  list.push(d);
  districtsByState.set(d.state, list);
}

/** A district as a plannable place: centred on its HQ when the HQ shares its name, else on the district itself. */
function getDistrict(slug) {
  const d = districtsBySlug.get(slug);
  if (!d) return null;
  const hub = d.hub ? bySlug.get(d.hub) : null;
  return {
    slug: d.slug,
    name: `${d.name} district`,
    state: d.state,
    lat: d.sameAsHub && hub ? hub.lat : d.lat,
    lng: d.sameAsHub && hub ? hub.lng : d.lng,
    pop: Math.max(hub?.pop ?? 0, 150000),
    isDistrict: true,
    hubName: hub?.name ?? null,
    hubIsHq: Boolean(d.sameAsHub && hub),
  };
}

/** A state overview: its capital plus every district (linking to the best plannable slug). */
function getState(codeOrSlug) {
  const st = statesByCode.get(String(codeOrSlug).toUpperCase()) || statesBySlug.get(codeOrSlug);
  if (!st) return null;
  const list = (districtsByState.get(st.name) || []).map((d) => {
    const hub = d.hub ? bySlug.get(d.hub) : null;
    return {
      name: d.name,
      slug: d.sameAsHub && hub ? hub.slug : d.slug,
      hq: hub?.name ?? null,
    };
  });
  const topCities = cities
    .filter((c) => c.state === st.name)
    .sort((a, b) => b.pop - a.pop)
    .slice(0, 12)
    .map((c) => ({ slug: c.slug, name: c.name }));
  const capital = st.capital ? bySlug.get(st.capital) : null;
  return {
    code: st.code,
    slug: st.slug,
    name: st.name,
    capital: capital ? { slug: capital.slug, name: capital.name } : null,
    districts: list,
    topCities,
    totalPlaces: cities.filter((c) => c.state === st.name).length,
  };
}

const getStateBySlug = (slug) => statesBySlug.get(slug) || null;

/**
 * The town a point belongs to (for photo locations). Big cities win over tiny
 * neighbours whose centre happens to be closer (Gateway of India → Mumbai, not Uran).
 */
function nearestCity(lat, lng) {
  let best = null;
  let bestScore = -Infinity;
  let nearest = null;
  let nearestKm = Infinity;
  for (const c of cities) {
    if (Math.abs(c.lat - lat) > 1.5 || Math.abs(c.lng - lng) > 1.5) continue;
    const km = haversineKm({ lat, lng }, c);
    if (km < nearestKm) {
      nearestKm = km;
      nearest = c;
    }
    if (km <= 30) {
      const sc = c.pop / (km + 2) ** 2;
      if (sc > bestScore) {
        bestScore = sc;
        best = c;
      }
    }
  }
  const pick = best || nearest;
  if (!pick) return null;
  return { slug: pick.slug, name: pick.name, state: pick.state, km: Math.round(haversineKm({ lat, lng }, pick) * 10) / 10 };
}
const listStates = () => states.map((st) => ({ code: st.code, name: st.name })).sort((a, b) => a.name.localeCompare(b.name));

// ----------------------------------------------------------------------------
// City profile helpers
// ----------------------------------------------------------------------------
const METRO_CITIES = new Set([
  'delhi', 'new-delhi', 'mumbai', 'navi-mumbai', 'thane', 'kolkata', 'chennai', 'bengaluru', 'hyderabad',
  'ahmedabad', 'jaipur', 'lucknow', 'kochi', 'nagpur', 'pune', 'kanpur', 'agra', 'bhopal', 'indore',
  'patna', 'surat', 'meerut', 'gurugram', 'noida', 'ghaziabad', 'faridabad', 'gandhinagar',
]);
const HILL_STATES = new Set(['Himachal Pradesh', 'Uttarakhand', 'Jammu and Kashmir', 'Ladakh', 'Sikkim', 'Arunachal Pradesh', 'Meghalaya', 'Nagaland', 'Mizoram', 'Manipur']);
const NORTH_EAST = new Set(['Assam', 'Arunachal Pradesh', 'Meghalaya', 'Nagaland', 'Mizoram', 'Manipur', 'Tripura', 'Sikkim']);
const BEST_TIME = {
  Ladakh: 'May – September',
  'Jammu and Kashmir': 'March – October',
  'Himachal Pradesh': 'March – June, September – November',
  Uttarakhand: 'March – June, September – November',
  Sikkim: 'March – May, October – December',
  Kerala: 'September – March',
  Goa: 'November – February',
  'Andaman and Nicobar Islands': 'November – April',
  Lakshadweep: 'October – April',
};
// Indicative government auto meter rates (₹ base, km included, ₹/km). Default for others.
const AUTO_METER = {
  Delhi: [30, 1.5, 11], Maharashtra: [26, 1.5, 17], Karnataka: [30, 2, 15], 'Tamil Nadu': [30, 1.8, 18],
  Telangana: [25, 1.6, 15], 'West Bengal': [30, 2, 15], Kerala: [30, 1.5, 15], Gujarat: [21, 1.2, 15],
  Rajasthan: [25, 2, 13], 'Uttar Pradesh': [25, 2, 12], Goa: [40, 1.5, 18],
};

function tierOf(pop) {
  if (pop >= 4_000_000) return 'metro';
  if (pop >= 1_000_000) return 'large';
  if (pop >= 200_000) return 'mid';
  return 'small';
}

const FOOD = { metro: [700, 1800, 5000], large: [600, 1500, 4000], mid: [500, 1200, 3200], small: [400, 1000, 2500] };
const STAY_PRICE = {
  metro: { budget: [800, 3000], comfort: [5000, 10000], premium: [12000, 30000] },
  large: { budget: [700, 2500], comfort: [3500, 7500], premium: [8000, 20000] },
  mid: { budget: [600, 2000], comfort: [2500, 5500], premium: [6000, 15000] },
  small: { budget: [500, 1800], comfort: [2000, 4500], premium: [5000, 12000] },
};
const SPEED = { metro: 17, large: 20, mid: 24, small: 28 };

function cabAppsFor(city, tier) {
  if (city.state === 'Goa') return ['goamiles', 'rapido', 'indrive'];
  if (tier === 'metro' || tier === 'large') return ['uber', 'ola', 'rapido', 'indrive'];
  if (tier === 'mid') return ['ola', 'uber', 'rapido', 'indrive'];
  return ['rapido'];
}

const fmtPop = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} million` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

// ----------------------------------------------------------------------------
// OSM → itinerary-engine shapes
// ----------------------------------------------------------------------------
function sightCategory(t) {
  if (t.natural === 'beach') return 'Beach';
  if (t.natural === 'waterfall' || t.boundary === 'national_park' || t.leisure === 'nature_reserve') return 'Nature';
  if (t.leisure === 'park' || t.leisure === 'garden') return 'Garden';
  if (t.tourism === 'museum' || t.tourism === 'gallery') return 'Museum';
  if (t.tourism === 'viewpoint') return 'Viewpoint';
  if (t.tourism === 'zoo' || t.tourism === 'aquarium' || t.tourism === 'theme_park') return 'Experience';
  if (t.amenity === 'place_of_worship' || t.historic === 'temple') return 'Spiritual';
  if (t.historic) return 'Heritage';
  return 'Landmark';
}
const DURATION = { Beach: 2.5, Nature: 3, Garden: 1, Museum: 2, Viewpoint: 1, Experience: 3, Spiritual: 1, Heritage: 1.5, Landmark: 1 };
const SLOT = { Beach: 'evening', Viewpoint: 'evening', Garden: 'morning', Nature: 'morning', Spiritual: 'morning', Museum: 'afternoon', Heritage: 'morning', Experience: 'afternoon', Landmark: 'any' };

function blurbFor(cat, t, cityName) {
  if (t.description) return t.description;
  const faith = t.religion ? `${t.religion.charAt(0).toUpperCase()}${t.religion.slice(1)} ` : '';
  const words = {
    Spiritual: `${faith}place of worship`,
    Heritage: `Historic ${t.historic && t.historic !== 'yes' ? t.historic.replace(/_/g, ' ') : 'site'}`,
    Museum: t.tourism === 'gallery' ? 'Art gallery' : 'Museum',
    Garden: 'Green space for a relaxed stroll',
    Nature: t.natural === 'waterfall' ? 'Waterfall' : t.boundary === 'national_park' ? 'National park' : 'Nature reserve',
    Beach: 'Beach',
    Viewpoint: 'Scenic viewpoint',
    Experience: t.tourism ? t.tourism.replace(/_/g, ' ').replace(/^./, (m) => m.toUpperCase()) : 'Attraction',
    Landmark: 'Local landmark and attraction',
  };
  return `${words[cat]} in ${cityName}.`;
}

function feeFor(t) {
  if (t.fee === 'no') return 'Free';
  if (t.fee === 'yes') return 'Entry fee applies';
  return 'Check locally';
}

function toDestination(city, places, curatedSlugs = new Set()) {
  const tier = tierOf(city.pop);
  const center = { lat: city.lat, lng: city.lng };
  const area = (p) => p.tags.suburb || city.name;

  const attractions = places.sights
    .map((p) => {
      const category = p.wikiCategory || sightCategory(p.tags);
      const distance = haversineKm(center, p);
      const rank = (p.notable ? 3 : 0) + (p.tags.tourism === 'attraction' ? 1 : 0) + (p.hours ? 0.5 : 0) - distance / 15;
      return {
        name: p.name,
        area: area(p),
        category,
        lat: p.lat,
        lng: p.lng,
        hours: p.hours || 'Check locally',
        fee: feeFor(p.tags),
        durationHrs: DURATION[category],
        rating: null,
        rank,
        notable: p.notable,
        slot: SLOT[category],
        blurb: blurbFor(category, p.tags, city.name),
      };
    })
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 24);

  // Google Places (optional, more reliable) wins over OpenStreetMap when available.
  const fromGoogle = (places.google || []).map((g, i) => ({
    name: g.name,
    area: g.area || city.name,
    cuisine: g.cuisine,
    tier: g.tier,
    costForTwo: null,
    rating: g.rating,
    ratingCount: g.ratingCount,
    rank: 30 - i, // Google already ranks by popularity
    mustTry: null,
    lat: g.lat,
    lng: g.lng,
    week: g.week,
    status: g.status,
    phone: g.phone,
    reservable: g.reservable,
    googleMapsUri: g.googleMapsUri,
    hoursSource: g.week ? 'google' : null,
  }));
  const fromOsm = places.food
    .map((p) => {
      const status = closureFromTags(p.tags);
      return {
        name: p.name,
        area: area(p),
        cuisine: p.tags.cuisine ? p.tags.cuisine.replace(/[_;]/g, (m) => (m === ';' ? ', ' : ' ')) : p.tags.amenity === 'cafe' ? 'Café' : 'Local cuisine',
        tier: null,
        costForTwo: null,
        rating: null,
        rank: (p.notable ? 2 : 0) + (p.tags.cuisine ? 0.5 : 0) + (p.hours ? 0.5 : 0) - (status ? 5 : 0),
        mustTry: null,
        lat: p.lat,
        lng: p.lng,
        week: parseOpeningHours(p.hours),
        rawHours: p.hours,
        status,
        phone: p.tags.phone,
        reservable: false,
        hoursSource: p.hours ? 'openstreetmap' : null,
      };
    })
    .filter((r) => r.status !== 'permanently_closed');
  const restaurants = (fromGoogle.length ? fromGoogle : fromOsm).sort((a, b) => b.rank - a.rank).slice(0, 18);

  const nightlife = (places.night || [])
    .map((p) => ({
      name: p.name,
      kind: { bar: 'Bar', pub: 'Pub', nightclub: 'Nightclub', biergarten: 'Beer garden' }[p.tags.amenity] || 'Bar',
      area: area(p),
      lat: p.lat,
      lng: p.lng,
      hoursText: describe(parseOpeningHours(p.hours)) || p.hours || null,
      km: Math.round(haversineKm(center, p) * 10) / 10,
    }))
    .sort((a, b) => a.km - b.km)
    .slice(0, 12);

  const prices = STAY_PRICE[tier];
  const stays = places.stays
    .map((p) => {
      const t = p.tags;
      const stars = Number(t.stars) || 0;
      let stayTier = 'comfort';
      if (t.tourism === 'hostel' || t.tourism === 'guest_house' || t.tourism === 'motel' || (stars && stars <= 2)) stayTier = 'budget';
      if (t.tourism === 'resort' || stars >= 4) stayTier = 'premium';
      return {
        name: p.name,
        area: area(p),
        tier: stayTier,
        pricePerNight: prices[stayTier],
        priceIsTypical: true,
        rating: null,
        highlights: [stars ? `${stars}-star` : null, t.tourism ? t.tourism.replace(/_/g, ' ') : null].filter(Boolean),
        rank: (p.notable ? 2 : 0) + stars,
        lat: p.lat,
        lng: p.lng,
      };
    })
    .sort((a, b) => b.rank - a.rank);
  const pickStays = (t) => stays.filter((s) => s.tier === t).slice(0, 6);

  // ---- Getting there ----
  const nearAirports = airports
    .map((a) => ({ ...a, km: haversineKm(center, a) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, 2);
  const rail = places.rail.map((r) => ({ ...r, km: haversineKm(center, r) })).sort((a, b) => a.km - b.km);
  const bus = places.bus.map((b) => ({ ...b, km: haversineKm(center, b) })).sort((a, b) => a.km - b.km);
  const road = (km) => Math.round(km * 1.3);
  const reach = [
    ...nearAirports.map((a, i) => ({
      mode: i === 0 ? 'Flight' : 'Flight (alternative)',
      hub: `${a.name} (${a.iata})${a.city ? ` — ${a.city}` : ''}`,
      distanceKm: road(a.km),
      note: road(a.km) > 60 ? `About ${Math.round(road(a.km) / 45)} h by road from the airport — taxi or bus onward.` : 'App cabs and prepaid taxis to the city.',
    })),
    rail.length
      ? { mode: 'Train', hub: rail.slice(0, 2).map((r) => r.name).join(' / '), distanceKm: road(rail[0].km), note: 'Book on IRCTC; check Vande Bharat / express options.' }
      : { mode: 'Train', hub: 'Nearest railhead', distanceKm: 0, note: 'No station found nearby in map data — check IRCTC for the closest railhead.' },
    bus.length
      ? { mode: 'Bus', hub: bus[0].name, distanceKm: road(bus[0].km), note: 'State transport and private Volvo / sleeper buses (redBus, state RTC sites).' }
      : { mode: 'Bus', hub: `${city.name} bus stand`, distanceKm: 0, note: 'State transport and private buses connect to nearby cities.' },
  ];

  // ---- Getting around ----
  const meter = AUTO_METER[city.state] || [30, 1.5, 15];
  const hill = HILL_STATES.has(city.state);
  const apps = cabAppsFor(city, tier);
  const appNames = apps.map((a) => ({ uber: 'Uber', ola: 'Ola', rapido: 'Rapido', indrive: 'inDrive', goamiles: 'GoaMiles' })[a]);
  const local = [
    METRO_CITIES.has(city.slug) ? { mode: 'Metro', type: 'public', fare: '₹10 – ₹60', note: 'Fast and air-conditioned — the best way to beat traffic.' } : null,
    { mode: tier === 'small' ? 'Local & shared buses' : 'City bus', type: 'public', fare: '₹10 – ₹40', note: tier === 'small' ? 'State transport buses link nearby towns.' : 'Municipal / state transport buses across the city.' },
    hill ? { mode: 'Shared jeep / taxi', type: 'public', fare: '₹50 – ₹300 per seat', note: 'The usual way to travel between hill towns.' } : { mode: 'E-rickshaw / shared auto', type: 'public', fare: '₹10 – ₹40 per seat', note: 'Handy for short hops and the last mile.' },
    hill ? null : { mode: 'Auto-rickshaw', type: 'private', fare: `Meter: ~₹${meter[0]} first ${meter[1]} km, then ~₹${meter[2]}/km`, note: 'Insist on the meter, agree a fare first, or book through an app.' },
    { mode: 'App cab / bike taxi', type: 'private', fare: tier === 'small' ? 'Limited availability' : '₹12 – ₹25 / km', note: `${appNames.join(', ')}${tier === 'small' ? ' — coverage in smaller towns varies; local taxi stands are common.' : '.'}` },
    { mode: hill ? 'Hired taxi for the day' : 'Car with driver', type: 'private', fare: hill ? '₹3,000 – ₹5,000 / day' : '₹2,000 – ₹3,500 / day', note: 'Best for sightseeing circuits and day trips.' },
    { mode: 'Self-drive car / scooter rental', type: 'private', fare: '₹400 – ₹2,500 / day', note: 'Carry your driving licence and check the vehicle before you leave.' },
  ].filter(Boolean);

  // ---- Day trips: notable places 40–160 km away ----
  const dayTrips = cities
    .filter((c) => c.slug !== city.slug && (c.pop >= 100000 || curatedSlugs.has(c.slug) || c.pop === 5000))
    .map((c) => ({ c, km: haversineKm(center, c) }))
    .filter((x) => x.km >= 40 && x.km <= 160)
    .sort((a, b) => (curatedSlugs.has(b.c.slug) ? 1 : 0) - (curatedSlugs.has(a.c.slug) ? 1 : 0) || b.c.pop - a.c.pop)
    .slice(0, 3)
    .map(({ c, km }) => ({ name: c.name, slug: c.slug, distanceKm: Math.round(km * 1.3), note: `${c.state} — explore it as a day trip or extend your journey.` }));

  return {
    slug: city.slug,
    name: city.name,
    region: city.state,
    tagline: city.isDistrict
      ? `District of ${city.state}${city.hubName ? ` · ${city.hubIsHq ? 'headquarters' : 'nearest major town'} ${city.hubName}` : ''}`
      : tier === 'small'
        ? `A charming town in ${city.state}`
        : `${city.state} · population ${fmtPop(city.pop)}`,
    bestTime: BEST_TIME[city.state] || (NORTH_EAST.has(city.state) ? 'October – April' : 'October – March'),
    center: [city.lat, city.lng],
    avgSpeedKmh: SPEED[tier],
    dailyFood: { budget: FOOD[tier][0], comfort: FOOD[tier][1], premium: FOOD[tier][2] },
    attractions,
    restaurants,
    stays: [...pickStays('budget'), ...pickStays('comfort'), ...pickStays('premium')],
    stayPriceGuide: prices,
    reach,
    local,
    autoMeter: hill ? null : { base: meter[0], baseKm: meter[1], perKm: meter[2] },
    cabApps: apps,
    dayTrips,
    nightlife,
    restaurantSource: fromGoogle.length ? 'google' : 'openstreetmap',
    source: 'live',
  };
}

/** Radius (metres) to search for places, scaled to the size of the city. */
function searchRadius(city) {
  return { metro: 9000, large: 7000, mid: 5000, small: 4000 }[tierOf(city.pop)];
}

module.exports = {
  search,
  searchCities,
  registerFeatured,
  getCity,
  getDistrict,
  getState,
  getStateBySlug,
  listStates,
  nearestCity,
  toDestination,
  searchRadius,
  tierOf,
  totalCities: cities.length,
  totalDistricts: districts.length,
  totalStates: states.length,
};
