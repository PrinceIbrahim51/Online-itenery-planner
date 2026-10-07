'use strict';

/**
 * Ride fare estimator for cab / auto / bike-taxi apps.
 * No ride-hailing app publishes a public pricing API, so estimates are derived
 * from published per-km / per-minute rate cards, scaled per city, and shown as
 * a range (normal → peak demand). The UI labels them as estimates.
 */
const APPS = {
  uber: {
    name: 'Uber',
    url: 'https://m.uber.com/',
    products: [
      { product: 'Uber Moto', category: 'Bike', base: 15, perKm: 6, perMin: 1, min: 25, seats: 1 },
      { product: 'Uber Auto', category: 'Auto', base: 25, perKm: 11, perMin: 1, min: 30, seats: 3 },
      { product: 'Uber Go', category: 'Cab · Hatchback', base: 50, perKm: 13, perMin: 1.5, min: 80, seats: 4 },
      { product: 'Uber Premier', category: 'Cab · Sedan', base: 60, perKm: 16, perMin: 2, min: 100, seats: 4 },
      { product: 'Uber XL', category: 'Cab · SUV', base: 80, perKm: 20, perMin: 2, min: 150, seats: 6 },
    ],
  },
  ola: {
    name: 'Ola',
    url: 'https://book.olacabs.com/',
    products: [
      { product: 'Ola Bike', category: 'Bike', base: 15, perKm: 6, perMin: 1, min: 25, seats: 1 },
      { product: 'Ola Auto', category: 'Auto', base: 25, perKm: 11, perMin: 1, min: 30, seats: 3 },
      { product: 'Ola Mini', category: 'Cab · Hatchback', base: 50, perKm: 12.5, perMin: 1.5, min: 80, seats: 4 },
      { product: 'Ola Prime Sedan', category: 'Cab · Sedan', base: 60, perKm: 15, perMin: 1.75, min: 100, seats: 4 },
      { product: 'Ola Prime SUV', category: 'Cab · SUV', base: 80, perKm: 19, perMin: 2, min: 150, seats: 6 },
    ],
  },
  rapido: {
    name: 'Rapido',
    url: 'https://www.rapido.bike/',
    products: [
      { product: 'Rapido Bike', category: 'Bike', base: 10, perKm: 5.5, perMin: 0.75, min: 20, seats: 1 },
      { product: 'Rapido Auto', category: 'Auto', base: 20, perKm: 10, perMin: 0.8, min: 25, seats: 3 },
      { product: 'Rapido Cab Economy', category: 'Cab · Hatchback', base: 40, perKm: 12, perMin: 1.25, min: 70, seats: 4 },
      { product: 'Rapido Cab Premium', category: 'Cab · Sedan', base: 50, perKm: 14, perMin: 1.5, min: 90, seats: 4 },
    ],
  },
  indrive: {
    name: 'inDrive',
    url: 'https://indrive.com/',
    note: 'Fare is negotiated — you offer a price and drivers accept or counter.',
    products: [
      { product: 'inDrive Moto', category: 'Bike', base: 10, perKm: 5.5, perMin: 0.5, min: 20, seats: 1 },
      { product: 'inDrive Auto', category: 'Auto', base: 20, perKm: 10, perMin: 0.5, min: 25, seats: 3 },
      { product: 'inDrive Ride', category: 'Cab · Hatchback', base: 40, perKm: 11.5, perMin: 1, min: 70, seats: 4 },
    ],
  },
  goamiles: {
    name: 'GoaMiles',
    url: 'https://goamiles.com/',
    products: [
      { product: 'GoaMiles Hatchback', category: 'Cab · Hatchback', base: 75, perKm: 18, perMin: 1, min: 100, seats: 4 },
      { product: 'GoaMiles Sedan', category: 'Cab · Sedan', base: 85, perKm: 20, perMin: 1, min: 120, seats: 4 },
      { product: 'GoaMiles SUV', category: 'Cab · SUV', base: 110, perKm: 25, perMin: 1.5, min: 160, seats: 6 },
    ],
  },
};

const CATEGORY_ORDER = ['Bike', 'Auto', 'Cab · Hatchback', 'Cab · Sedan', 'Cab · SUV'];
const PEAK_MULTIPLIER = 1.4;

const round5 = (n) => Math.max(0, Math.round(n / 5) * 5);

function cityFactor(dest) {
  const perKm = dest.autoMeter?.perKm ?? 12;
  return Math.min(1.3, Math.max(0.9, perKm / 13));
}

function meterAutoFare(meter, km) {
  const extra = Math.max(0, km - meter.baseKm);
  return meter.base + extra * meter.perKm;
}

/**
 * Compare ride options for a trip of `km` road kilometres in `dest`.
 * Returns options grouped by vehicle category, cheapest first.
 */
function compareFares(dest, km) {
  const distance = Math.max(0.5, Math.min(300, Number(km) || 0));
  const minutes = Math.round((distance / (dest.avgSpeedKmh || 20)) * 60);
  const factor = cityFactor(dest);
  const options = [];

  for (const appId of dest.cabApps || []) {
    const app = APPS[appId];
    if (!app) continue;
    for (const p of app.products) {
      const raw = Math.max(p.min, p.base + p.perKm * distance + p.perMin * minutes) * factor;
      options.push({
        app: app.name,
        appUrl: app.url,
        product: p.product,
        category: p.category,
        seats: p.seats,
        low: round5(raw * (appId === 'indrive' ? 0.9 : 1)),
        high: round5(raw * PEAK_MULTIPLIER),
        note: app.note || null,
      });
    }
  }

  if (dest.autoMeter) {
    const fare = meterAutoFare(dest.autoMeter, distance);
    options.push({
      app: 'Street auto (meter)',
      appUrl: null,
      product: 'Metered auto-rickshaw',
      category: 'Auto',
      seats: 3,
      low: round5(fare),
      high: round5(fare * 1.5), // night charges / refusal to use meter
      note: `Govt. meter: ₹${dest.autoMeter.base} for first ${dest.autoMeter.baseKm} km, then ₹${dest.autoMeter.perKm}/km. Night surcharge applies.`,
    });
  }

  const groups = CATEGORY_ORDER.map((category) => {
    const items = options.filter((o) => o.category === category).sort((a, b) => a.low - b.low);
    items.forEach((o, i) => {
      o.cheapest = i === 0;
    });
    return { category, options: items };
  }).filter((g) => g.options.length);

  return { distanceKm: Math.round(distance * 10) / 10, durationMin: minutes, groups };
}

/** Cheapest sensible fare for a leg — used for itinerary cost estimates. */
function cheapestFor(dest, km, category) {
  const cmp = compareFares(dest, km);
  const g = cmp.groups.find((x) => x.category === category) || cmp.groups[0];
  return g ? g.options[0] : null;
}

module.exports = { compareFares, cheapestFor, APPS };
