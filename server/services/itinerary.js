'use strict';

const { compareFares, cheapestFor } = require('./fares');

const DAY_HOURS = 8;
const ROAD_FACTOR = 1.35; // straight-line → road distance
const SLOT_ORDER = { morning: 0, any: 1, afternoon: 2, evening: 3 };
const TIER_PREFS = {
  budget: ['budget', 'comfort', 'premium'],
  comfort: ['comfort', 'budget', 'premium'],
  premium: ['premium', 'comfort', 'budget'],
};

function haversineKm([lat1, lng1], [lat2, lng2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

const roadKm = (a, b) => Math.round(haversineKm([a.lat, a.lng], [b.lat, b.lng]) * ROAD_FACTOR * 10) / 10;

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
  const pool = [...attractions].sort((a, b) => b.rating - a.rating);
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
  const score = (r) => {
    const tierPenalty = prefs.indexOf(r.tier) * 4;
    const distance = near ? roadKm(near, r) : 0;
    const repeat = used.has(r.name) ? 50 : 0;
    return tierPenalty + distance + repeat - r.rating;
  };
  const best = [...restaurants].sort((a, b) => score(a) - score(b))[0];
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
      const trip = dayTrips.shift();
      itinerary.push({
        day: d + 1,
        theme: trip ? `Day trip: ${trip.name}` : 'Leisure & local discoveries',
        stops: [],
        dayTrip: trip || null,
        note: trip
          ? `${trip.distanceKm} km away — ${trip.note} Hire a car for the day or check train/bus options.`
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
      theme: areas.slice(0, 2).join(' & '),
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
  const avgNight = tierStays.length
    ? tierStays.reduce((sum, s) => sum + (s.pricePerNight[0] + s.pricePerNight[1]) / 2, 0) / tierStays.length
    : 0;
  const vehicles = Math.ceil(travelers / 3);
  const estimate = {
    stay: Math.round(avgNight * nights * rooms),
    food: Math.round((dest.dailyFood?.[budget] ?? 1000) * travelers * days),
    localTransport: Math.round(transportTotal * vehicles),
    entryFees: Math.round(entryTotal * travelers),
  };
  estimate.total = estimate.stay + estimate.food + estimate.localTransport + estimate.entryFees;

  const withMaps = (items) => items.map((x) => ({ ...x, mapsUrl: mapsLink(x.name, x.area, city) }));

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
    attractions: withMaps([...dest.attractions].sort((a, b) => b.rating - a.rating)),
    restaurants: withMaps(
      [...dest.restaurants].sort((a, b) => TIER_PREFS[budget].indexOf(a.tier) - TIER_PREFS[budget].indexOf(b.tier) || b.rating - a.rating)
    ),
    stays: {
      affordable: withMaps(dest.stays.filter((s) => s.tier === 'budget')),
      comfort: withMaps(dest.stays.filter((s) => s.tier === 'comfort')),
      premium: withMaps(dest.stays.filter((s) => s.tier === 'premium')),
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
    disclaimer: 'Prices, timings and fares are indicative and change often — please verify before booking.',
  };
}

module.exports = { generateItinerary, haversineKm, feeAmount };
