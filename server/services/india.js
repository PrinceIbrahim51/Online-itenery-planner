'use strict';

const cities = require('../data/india-cities.json');
const airports = require('../data/india-airports.json');
const { haversineKm } = require('./geo');

/**
 * Every Indian city/town (GeoNames, pop ≥ 1,000, plus popular tourist towns):
 * search, lookup, and conversion of live OpenStreetMap places into a destination
 * the itinerary engine understands. Data: GeoNames (CC BY 4.0), OurAirports (PD),
 * © OpenStreetMap contributors (ODbL).
 */
const bySlug = new Map(cities.map((c) => [c.slug, c]));

const fold = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const index = cities.map((c) => ({ c, keys: [c.name, ...(c.aka || [])].map(fold) }));

// Tourist favourites that share a name with a larger, lesser-known place.
const BOOST = new Set(['manali-hp', 'srinagar', 'aurangabad']);

function searchCities(query, limit = 12, curatedSlugs = new Set()) {
  const q = fold(query);
  if (!q) return [];
  const scored = [];
  for (const { c, keys } of index) {
    let score = -1;
    for (const k of keys) {
      if (k === q) score = Math.max(score, 3);
      else if (k.startsWith(q)) score = Math.max(score, 2);
      else if (k.includes(` ${q}`)) score = Math.max(score, 1.5);
      else if (q.length >= 3 && k.includes(q)) score = Math.max(score, 1);
    }
    if (score < 0) continue;
    if (curatedSlugs.has(c.slug)) score += 0.6;
    if (BOOST.has(c.slug)) score += 0.5;
    scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || b.c.pop - a.c.pop);
  return scored.slice(0, limit).map(({ c }) => ({ slug: c.slug, name: c.name, state: c.state, curated: curatedSlugs.has(c.slug) }));
}

const getCity = (slug) => bySlug.get(slug) || null;

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

  const restaurants = places.food
    .map((p) => ({
      name: p.name,
      area: area(p),
      cuisine: p.tags.cuisine ? p.tags.cuisine.replace(/[_;]/g, (m) => (m === ';' ? ', ' : ' ')) : p.tags.amenity === 'cafe' ? 'Café' : 'Local cuisine',
      tier: null,
      costForTwo: null,
      rating: null,
      rank: (p.notable ? 2 : 0) + (p.tags.cuisine ? 0.5 : 0) + (p.hours ? 0.3 : 0),
      mustTry: null,
      lat: p.lat,
      lng: p.lng,
    }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 18);

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
    tagline: tier === 'small' ? `A charming town in ${city.state}` : `${city.state} · population ${fmtPop(city.pop)}`,
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
    source: 'live',
  };
}

/** Radius (metres) to search for places, scaled to the size of the city. */
function searchRadius(city) {
  return { metro: 9000, large: 7000, mid: 5000, small: 4000 }[tierOf(city.pop)];
}

module.exports = { searchCities, getCity, toDestination, searchRadius, tierOf, totalCities: cities.length };
