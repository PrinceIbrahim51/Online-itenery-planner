'use strict';

const { compareFares, cheapestFor } = require('./fares');
const { haversineKm } = require('./geo');

const DAY_HOURS = 8;
const ROAD_FACTOR = 1.35; // straight-line → road distance
const SLOT_ORDER = { morning: 0, any: 1, afternoon: 2, evening: 3 };
const TIER_PREFS = {
  budget: ['budget', 'comfort', 'premium'],
  comfort: ['comfort', 'budget', 'premium'],
  premium: ['premium', 'comfort', 'budget'],
};

const roadKm = (a, b) => Math.round(haversineKm(a, b) * ROAD_FACTOR * 10) / 10;

// Curated places carry a rating; live (OpenStreetMap) places carry a computed rank instead.
const score = (x) => x.rank ?? x.rating ?? 0;

const mapsLink = (name, area, city) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, ${area}, ${city}`)}`;

/** First rupee amount in a fee string, e.g. "₹50 / ₹1,100" → 50. */
function feeAmount(fee) {
  const m = /₹\s?([\d,]+)/.exec(fee || '');
  return m ? Number(m[1].replace(/,/g, '')) : 0;
}

function suggestLeg(dest, from, to, budget) {
  const km = roadKm(from, to);
  if (km <= 1.2) return { km, mode: 'Walk', minutes: Math.max(5, Math.round(km * 14)), fare: 0, app: null };
  const category = km <= 8 ? 'Auto' : budget === 'premium' ? 'Cab · Sedan' : 'Cab · Hatchback';
  const opt = cheapestFor(dest, km, category);
  return {
    km,
    mode: opt ? opt.category : 'Cab',
    minutes: Math.round((km / (dest.avgSpeedKmh || 20)) * 60),
    fare: opt ? opt.low : 0,
    app: opt ? `${opt.app} – ${opt.product}` : null,
  };
}

/** Groups attractions into days: seed with the best remaining sight, then add the nearest ones. */
function planDays(attractions, days) {
  const pool = [...attractions].sort((a, b) => score(b) - score(a));
  const plan = [];
  for (let d = 0; d < days && pool.length; d++) {
    const seed = pool.shift();
    const stops = [seed];
    let hours = seed.durationHrs;
    while (pool.length) {
      const last = stops[stops.length - 1];
      pool.sort((a, b) => roadKm(last, a) - roadKm(last, b));
      const idx = pool.findIndex((p) => hours + p.durationHrs + 0.5 <= DAY_HOURS);
      if (idx === -1) break;
      const [next] = pool.splice(idx, 1);
      stops.push(next);
      hours += next.durationHrs + 0.5;
    }
    stops.sort((a, b) => SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot]);
    plan.push(stops);
  }
  return plan;
}

function pickRestaurant(restaurants, near, budget, used) {
  if (!restaurants.length) return null;
  const prefs = TIER_PREFS[budget];
  const cost = (r) => {
    const tierPenalty = r.tier ? prefs.indexOf(r.tier) * 4 : 2;
    const distance = near ? roadKm(near, r) : 0;
    const repeat = used.has(r.name) ? 50 : 0;
    return tierPenalty + distance + repeat - score(r);
  };
  const best = [...restaurants].sort((a, b) => cost(a) - cost(b))[0];
  used.add(best.name);
  return best;
}

function generateItinerary(dest, { days, travelers, budget }) {
  const city = dest.name;
  const dayGroups = planDays(dest.attractions, days);
  const usedRestaurants = new Set();
  const dayTrips = [...(dest.dayTrips || [])];
  let transportTotal = 0;
  let entryTotal = 0;

  const itinerary = [];
  for (let d = 0; d < days; d++) {
    const stops = dayGroups[d];
    if (!stops) {
      // With no sights at all (e.g. live data unavailable), spend day 1 in the city itself.
      const trip = d === 0 && dayGroups.length === 0 ? null : dayTrips.shift();
      itinerary.push({
        day: d + 1,
        theme: trip ? `Day trip: ${trip.name}` : d === 0 ? `Discover ${city}` : 'Leisure & local discoveries',
        stops: [],
        dayTrip: trip || null,
        note: trip
          ? `${trip.distanceKm} km away — ${trip.note} Hire a car for the day or check train/bus options.`
          : d === 0
            ? `Explore ${city} on foot: the old market, a local temple or landmark, and street food — ask your hotel for tips.`
            : 'Revisit a favourite spot, try a cooking class or spa, and shop for souvenirs.',
        meals: {
          lunch: pickRestaurant(dest.restaurants, null, budget, usedRestaurants),
          dinner: pickRestaurant(dest.restaurants, null, budget, usedRestaurants),
        },
      });
      continue;
    }

    const enriched = stops.map((s, i) => {
      const leg = i > 0 ? suggestLeg(dest, stops[i - 1], s, budget) : null;
      if (leg) transportTotal += leg.fare;
      entryTotal += feeAmount(s.fee);
      return { ...s, mapsUrl: mapsLink(s.name, s.area, city), legFromPrevious: leg };
    });

    const mid = stops[Math.floor((stops.length - 1) / 2)];
    const areas = [...new Set(stops.map((s) => s.area))];
    itinerary.push({
      day: d + 1,
      theme: areas.slice(0, 2).join(' & ') || city,
      stops: enriched,
      dayTrip: null,
      note: null,
      meals: {
        lunch: pickRestaurant(dest.restaurants, mid, budget, usedRestaurants),
        dinner: pickRestaurant(dest.restaurants, stops[stops.length - 1], budget, usedRestaurants),
      },
    });
  }

  // ---- Cost estimate (per trip, all travellers) ----
  const nights = Math.max(0, days - 1);
  const rooms = Math.ceil(travelers / 2);
  const tierStays = dest.stays.filter((s) => s.tier === budget);
  const guide = dest.stayPriceGuide?.[budget];
  const avgNight = tierStays.length
    ? tierStays.reduce((sum, s) => sum + (s.pricePerNight[0] + s.pricePerNight[1]) / 2, 0) / tierStays.length
    : guide
      ? (guide[0] + guide[1]) / 2
      : 0;
  const vehicles = Math.ceil(travelers / 3);
  const estimate = {
    stay: Math.round(avgNight * nights * rooms),
    food: Math.round((dest.dailyFood?.[budget] ?? 1000) * travelers * days),
    localTransport: Math.round(transportTotal * vehicles),
    entryFees: Math.round(entryTotal * travelers),
  };
  estimate.total = estimate.stay + estimate.food + estimate.localTransport + estimate.entryFees;

  const withMaps = (items) => items.map(({ rank, ...x }) => ({ ...x, mapsUrl: mapsLink(x.name, x.area, city) }));
  const region = dest.region ? `, ${dest.region}` : '';
  const mapsSearch = (what) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${what} in ${city}${region}`)}`;
  const tierRank = (r) => (r.tier ? TIER_PREFS[budget].indexOf(r.tier) : 1);

  return {
    destination: {
      slug: dest.slug,
      name: dest.name,
      region: dest.region,
      tagline: dest.tagline,
      bestTime: dest.bestTime,
      source: dest.source || 'curated',
    },
    params: { days, travelers, budget, nights, rooms },
    itinerary,
    attractions: withMaps([...dest.attractions].sort((a, b) => score(b) - score(a))),
    restaurants: withMaps([...dest.restaurants].sort((a, b) => tierRank(a) - tierRank(b) || score(b) - score(a))),
    stays: {
      affordable: withMaps(dest.stays.filter((s) => s.tier === 'budget')),
      comfort: withMaps(dest.stays.filter((s) => s.tier === 'comfort')),
      premium: withMaps(dest.stays.filter((s) => s.tier === 'premium')),
      priceGuide: dest.stayPriceGuide || null,
      bookingSearchUrl: `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(city)}&group_adults=${travelers}&no_rooms=${rooms}`,
    },
    transport: {
      reach: dest.reach,
      local: dest.local,
      public: dest.local.filter((l) => l.type === 'public'),
      private: dest.local.filter((l) => l.type === 'private'),
    },
    rideComparison: {
      short: compareFares(dest, 4),
      medium: compareFares(dest, 10),
      long: compareFares(dest, 25),
    },
    dayTrips: dest.dayTrips || [],
    estimate,
    searchLinks: {
      sights: mapsSearch('tourist attractions'),
      restaurants: mapsSearch('best restaurants'),
      stays: mapsSearch('hotels'),
    },
    disclaimer:
      dest.source === 'live'
        ? 'Places come live from OpenStreetMap; stay prices are typical ranges for this city, and fares are estimates. Verify before booking.'
        : 'Prices, timings and fares are indicative and change often — please verify before booking.',
    attribution:
      dest.source === 'live' ? 'Place data © OpenStreetMap contributors (ODbL) and Wikipedia (CC BY-SA) · City data GeoNames (CC BY 4.0)' : null,
  };
}

module.exports = { generateItinerary, feeAmount };
