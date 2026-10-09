'use strict';

const { compareFares, cheapestFor } = require('./fares');
const { haversineKm } = require('./geo');
const { isOpenAt, hoursOn, describe, weekdayIndex, DAY_LABEL } = require('./hours');
const { sunTimes } = require('./sun');
const { todayIst, addDays } = require('./weather');
const { DRY_STATES } = require('./advice');

const LUNCH_MIN = 13 * 60;
const DINNER_MIN = 20 * 60;

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

/**
 * Best restaurant for a meal: right price style, close to the day's route, not used
 * yet — and never one that is temporarily closed or known to be shut at that time.
 */
function pickRestaurant(restaurants, near, budget, used, when) {
  const usable = restaurants.filter((r) => !r.status);
  const openThen = when ? usable.filter((r) => isOpenAt(r.week, when.dayIndex, when.minute) !== false) : usable;
  const pool = openThen.length ? openThen : [];
  if (!pool.length) return null;
  const prefs = TIER_PREFS[budget];
  const cost = (r) => {
    const tierPenalty = r.tier ? prefs.indexOf(r.tier) * 4 : 2;
    const distance = near ? roadKm(near, r) : 0;
    const repeat = used.has(r.name) ? 50 : 0;
    const known = r.week ? -1 : 0; // prefer places whose hours we can confirm
    return tierPenalty + distance + repeat + known - score(r);
  };
  const best = [...pool].sort((a, b) => cost(a) - cost(b))[0];
  used.add(best.name);
  const { week, rank, ...rest } = best;
  const open = when ? isOpenAt(week, when.dayIndex, when.minute) : null;
  return { ...rest, openAtMeal: open, hoursThatDay: when ? hoursOn(week, when.dayIndex) : null };
}

const PHOTO_WEIGHT = { Viewpoint: 5, Beach: 4, Heritage: 4, Nature: 4, Landmark: 3, Garden: 2, Spiritual: 2, Museum: 1, Experience: 1, Market: 2 };
const PHOTO_TIP = {
  Viewpoint: 'Best at golden hour — arrive 30 minutes before sunset for the colours.',
  Beach: 'Golden-hour silhouettes and reflections; early mornings are calm and empty.',
  Heritage: 'Go at opening time for soft light and frames without crowds.',
  Nature: 'Morning light is softest; keep a cover for your lens near water spray.',
  Landmark: 'Try the blue hour just after sunset, when it is lit up.',
  Garden: 'Early morning for dew, flowers and fewer people.',
  Spiritual: 'Photography is often restricted inside — shoot the exterior, and ask first.',
  Market: 'Colourful street shots in late afternoon; ask before photographing people.',
  Museum: 'Check the camera rules at the ticket counter.',
  Experience: 'Check the camera rules at the entrance.',
};

function generateItinerary(dest, { days, travelers, budget, start }) {
  const city = dest.name;
  const startDate = start || todayIst();
  const [cLat, cLng] = dest.center || [dest.attractions[0]?.lat ?? 22, dest.attractions[0]?.lng ?? 79];
  const dayInfo = (d) => {
    const date = addDays(startDate, d);
    const dayIndex = weekdayIndex(date);
    return { date, dayIndex, weekday: DAY_LABEL[dayIndex], sun: sunTimes(cLat, cLng, date) };
  };
  const dayGroups = planDays(dest.attractions, days);
  const usedRestaurants = new Set();
  const dayTrips = [...(dest.dayTrips || [])];
  let transportTotal = 0;
  let entryTotal = 0;

  const itinerary = [];
  for (let d = 0; d < days; d++) {
    const stops = dayGroups[d];
    const info = dayInfo(d);
    const lunchAt = { dayIndex: info.dayIndex, minute: LUNCH_MIN };
    const dinnerAt = { dayIndex: info.dayIndex, minute: DINNER_MIN };
    if (!stops) {
      // With no sights at all (e.g. live data unavailable), spend day 1 in the city itself.
      const trip = d === 0 && dayGroups.length === 0 ? null : dayTrips.shift();
      itinerary.push({
        day: d + 1,
        ...info,
        theme: trip ? `Day trip: ${trip.name}` : d === 0 ? `Discover ${city}` : 'Leisure & local discoveries',
        stops: [],
        dayTrip: trip || null,
        note: trip
          ? `${trip.distanceKm} km away — ${trip.note} Hire a car for the day or check train/bus options.`
          : d === 0
            ? `Explore ${city} on foot: the old market, a local temple or landmark, and street food — ask your hotel for tips.`
            : 'Revisit a favourite spot, try a cooking class or spa, and shop for souvenirs.',
        meals: {
          lunch: pickRestaurant(dest.restaurants, null, budget, usedRestaurants, lunchAt),
          dinner: pickRestaurant(dest.restaurants, null, budget, usedRestaurants, dinnerAt),
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
      ...info,
      theme: areas.slice(0, 2).join(' & ') || city,
      stops: enriched,
      dayTrip: null,
      note: null,
      meals: {
        lunch: pickRestaurant(dest.restaurants, mid, budget, usedRestaurants, lunchAt),
        dinner: pickRestaurant(dest.restaurants, stops[stops.length - 1], budget, usedRestaurants, dinnerAt),
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
  const tripDays = itinerary.map((x) => ({ day: x.day, date: x.date, dayIndex: x.dayIndex, weekday: x.weekday }));
  const googleSearch = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

  // Restaurants: hours, closure status, which trip days they're shut, and how to reserve.
  const restaurants = [...dest.restaurants]
    .sort((a, b) => tierRank(a) - tierRank(b) || score(b) - score(a))
    .map(({ week, rank, ...r }) => {
      const mapsUrl = mapsLink(r.name, r.area, city);
      const phone = r.phone ? String(r.phone).replace(/[^\d+]/g, '') : '';
      return {
        ...r,
        mapsUrl,
        hoursText: describe(week) || r.rawHours || null,
        closedOnTripDays: week ? tripDays.filter((t) => week[t.dayIndex]?.length === 0).map((t) => `Day ${t.day} (${t.weekday})`) : [],
        // Book a table: WhatsApp when the place lists it, otherwise a phone call.
        reserve: {
          whatsapp: /^\d{10,15}$/.test(r.whatsapp || '') ? r.whatsapp : null,
          call: /^\+?\d{6,15}$/.test(phone) ? `tel:${phone}` : null,
        },
      };
    });

  // Photo spots: scenic categories first, notable places break ties.
  const photoSpots = dest.attractions
    .filter((a) => PHOTO_WEIGHT[a.category])
    .map((a) => ({ a, w: PHOTO_WEIGHT[a.category] + (a.notable || (a.rating ?? 0) >= 4.5 ? 1 : 0) + (score(a) > 0 ? Math.min(score(a), 5) / 10 : 0) }))
    .sort((x, y) => y.w - x.w)
    .slice(0, 8)
    .map(({ a }) => ({
      name: a.name,
      area: a.area,
      category: a.category,
      tip: PHOTO_TIP[a.category],
      mapsUrl: mapsLink(a.name, a.area, city),
    }));

  // Nightlife & events (no free events API covers India, so we link out honestly).
  const dry = DRY_STATES.has(dest.region);
  const nightlife = (dest.nightlife || []).map((n) => ({ ...n, mapsUrl: mapsLink(n.name, n.area, city) }));
  const firstDate = itinerary[0]?.date || startDate;
  const lastDate = itinerary[itinerary.length - 1]?.date || startDate;
  const events = {
    dryState: dry,
    links: [
      { label: `Events in ${city} on BookMyShow`, url: `https://in.bookmyshow.com/explore/events-${city.toLowerCase().replace(/ district$/, '').replace(/[^a-z0-9]+/g, '-')}` },
      { label: `Search events ${firstDate === lastDate ? `on ${firstDate}` : `from ${firstDate} to ${lastDate}`}`, url: googleSearch(`events in ${city} ${firstDate}${firstDate === lastDate ? '' : ` to ${lastDate}`}`) },
      { label: 'Nightlife & live music nearby', url: mapsSearch('live music bars pubs') },
    ],
  };

  return {
    destination: {
      slug: dest.slug,
      name: dest.name,
      region: dest.region,
      tagline: dest.tagline,
      bestTime: dest.bestTime,
      source: dest.source || 'curated',
    },
    params: { days, travelers, budget, nights, rooms, start: startDate },
    itinerary,
    attractions: withMaps([...dest.attractions].sort((a, b) => score(b) - score(a))),
    restaurants,
    restaurantSource: dest.restaurantSource || (dest.source === 'live' ? 'openstreetmap' : 'curated'),
    photoSpots,
    nightlife,
    events,
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
