'use strict';

/**
 * Packing list, dos & don'ts and alerts for a trip, from (in priority order):
 *   1. the live forecast for the trip dates (when within ~2 weeks),
 *   2. seasonal patterns for the state and month,
 *   3. altitude, the kinds of sights on the plan, and state-specific rules.
 * Every item is generic travel guidance — nothing here is invented about a
 * specific business or place.
 */

const HOT_PLAINS = new Set([
  'Rajasthan', 'Gujarat', 'Madhya Pradesh', 'Uttar Pradesh', 'Delhi', 'Haryana', 'Punjab', 'Bihar', 'Jharkhand',
  'Chhattisgarh', 'Maharashtra', 'Telangana', 'Andhra Pradesh', 'Odisha', 'Chandigarh',
]);
const COLD_NORTH_PLAINS = new Set(['Delhi', 'Punjab', 'Haryana', 'Uttar Pradesh', 'Bihar', 'Rajasthan', 'Chandigarh', 'Madhya Pradesh']);
const HILL_STATES = new Set(['Himachal Pradesh', 'Uttarakhand', 'Jammu and Kashmir', 'Sikkim', 'Arunachal Pradesh']);
const NORTH_EAST = new Set(['Assam', 'Arunachal Pradesh', 'Meghalaya', 'Nagaland', 'Mizoram', 'Manipur', 'Tripura', 'Sikkim']);
const DRY_STATES = new Set(['Gujarat', 'Bihar', 'Nagaland', 'Mizoram', 'Lakshadweep']);
const ILP_STATES = new Set(['Arunachal Pradesh', 'Nagaland', 'Mizoram', 'Manipur']);

/** Months (1–12) with significant rain, by state. */
function rainyMonths(state) {
  if (state === 'Kerala') return [6, 7, 8, 9, 10, 11];
  if (state === 'Tamil Nadu' || state === 'Puducherry') return [10, 11, 12];
  if (state === 'Andhra Pradesh') return [7, 8, 9, 10, 11];
  if (state === 'Andaman and Nicobar Islands') return [5, 6, 7, 8, 9, 10, 11];
  if (state === 'Lakshadweep') return [5, 6, 7, 8, 9];
  if (state === 'Meghalaya') return [5, 6, 7, 8, 9, 10];
  if (NORTH_EAST.has(state)) return [5, 6, 7, 8, 9];
  if (['Goa', 'Maharashtra', 'Karnataka'].includes(state)) return [6, 7, 8, 9];
  if (state === 'Ladakh') return [];
  return [7, 8, 9];
}

const item = (icon, text) => ({ icon, text });

function monthsOf(start, days) {
  const set = new Set();
  const [y, m, d] = start.split('-').map(Number);
  for (let i = 0; i < days; i++) set.add(new Date(Date.UTC(y, m - 1, d + i)).getUTCMonth() + 1);
  return [...set];
}

function buildAdvice({ state, start, days, weather, categories = [], tier = 'mid', metro = false }) {
  const pack = new Map(); // dedupe by text
  const add = (icon, text) => pack.set(text, item(icon, text));
  const dos = [];
  const donts = [];
  const alerts = [];
  const months = monthsOf(start, days);
  const elevation = weather?.elevation ?? null;
  const fc = weather?.source === 'forecast' && weather.days.length ? weather.days : null;
  let summary;

  // ---- Weather-driven packing ----
  if (fc) {
    const max = Math.max(...fc.map((d) => d.max ?? -99));
    const min = Math.min(...fc.map((d) => d.min ?? 99));
    const rainy = fc.filter((d) => (d.rainChance ?? 0) >= 50 || (d.rainMm ?? 0) >= 5);
    const uv = Math.max(...fc.map((d) => d.uv ?? 0));
    summary = `Forecast: ${Math.round(min)}–${Math.round(max)}°C${rainy.length ? `, rain likely on ${rainy.length} of ${fc.length} days` : ', mostly dry'}.`;
    if (max >= 35) {
      add('👕', 'Light, breathable cotton clothes');
      add('🧢', 'Cap or hat and sunglasses');
      add('💧', 'ORS sachets and a refillable water bottle');
      dos.push('Sightsee early morning and late afternoon; rest indoors around midday.');
    }
    if (min <= 12) add('🧥', 'A warm jacket or sweater for evenings');
    if (min <= 5) {
      add('🧤', 'Thermals, gloves, woollen cap and warm socks');
      alerts.push(`Night temperatures may drop to about ${Math.round(min)}°C.`);
    }
    if (rainy.length) {
      add('☂️', 'Umbrella or compact raincoat');
      add('👟', 'Quick-dry, non-slip footwear');
      add('📱', 'Waterproof pouch for your phone and documents');
    }
    if (uv >= 8) add('🧴', 'Sunscreen SPF 50+ (UV index is very high)');
  } else {
    const rainSet = new Set(rainyMonths(state));
    const rainy = months.some((m) => rainSet.has(m));
    const hot = HOT_PLAINS.has(state) && months.some((m) => [4, 5, 6].includes(m));
    const coldPlains = COLD_NORTH_PLAINS.has(state) && months.some((m) => [12, 1].includes(m));
    const coldHills = HILL_STATES.has(state) && months.some((m) => [11, 12, 1, 2, 3].includes(m));
    const ladakhWinter = state === 'Ladakh' && months.some((m) => [10, 11, 12, 1, 2, 3, 4].includes(m));
    const parts = [];
    if (rainy) {
      parts.push('monsoon rain likely');
      add('☂️', 'Umbrella or compact raincoat');
      add('👟', 'Quick-dry, non-slip footwear');
      add('📱', 'Waterproof pouch for your phone and documents');
    }
    if (hot) {
      parts.push('very hot days (often 40°C+)');
      add('👕', 'Light, breathable cotton clothes');
      add('🧢', 'Cap or hat and sunglasses');
      add('💧', 'ORS sachets and a refillable water bottle');
      dos.push('Sightsee early morning and late afternoon; rest indoors around midday.');
    }
    if (coldPlains) {
      parts.push('cold nights and morning fog');
      add('🧥', 'A warm jacket or sweater for mornings and nights');
      alerts.push('Dense winter fog can delay early-morning trains and flights — keep buffer time.');
    }
    if (coldHills || ladakhWinter) {
      parts.push('cold, possibly snowy');
      add('🧤', 'Thermals, gloves, woollen cap and warm socks');
      add('🧥', 'A heavy jacket');
      alerts.push('Mountain roads can close after snowfall — check road status before travelling.');
    }
    summary = parts.length ? `Typical for the season: ${parts.join(', ')}.` : 'Usually pleasant at this time of year — check the forecast closer to your trip.';
  }

  // ---- Altitude ----
  if (elevation !== null) {
    if (elevation >= 1500) add('🧥', 'A warm layer — nights are cool at this altitude');
    if (elevation >= 2500) {
      alerts.push(`High altitude (~${Math.round(elevation)} m): rest for 24–48 hours after arriving, drink plenty of water and avoid alcohol on day 1.`);
      add('💊', 'Basic altitude/headache medicine (ask your doctor)');
      add('🧴', 'Sunscreen and lip balm — the sun is strong at altitude');
    }
  }

  // ---- What's on the plan ----
  const cats = new Set(categories);
  if (cats.has('Spiritual')) {
    dos.push('Dress modestly at temples, mosques and churches (cover shoulders and knees).');
    dos.push('Remove footwear where asked — socks help on hot stone floors.');
    donts.push('Don’t photograph inside shrines or during rituals without permission.');
    add('🧦', 'Socks for temple visits');
  }
  if (cats.has('Beach')) {
    dos.push('Swim only at lifeguard-patrolled spots and follow the warning flags.');
    donts.push('Don’t enter the sea when it’s rough or during monsoon warnings.');
    add('🩴', 'Sandals and a beach towel');
  }
  if (cats.has('Nature')) {
    dos.push('Check whether waterfalls and forest trails are open — they often close after heavy rain.');
    add('🥾', 'Shoes with good grip for trails');
    add('🦟', 'Mosquito repellent');
  }
  if (cats.has('Heritage')) {
    donts.push('Don’t feed or tease monkeys at forts and temples; keep food and phones zipped away.');
  }

  // ---- State-specific rules ----
  if (DRY_STATES.has(state)) {
    alerts.push(`${state} has prohibition laws: alcohol sale and consumption are banned or tightly restricted. Don’t carry or drink alcohol in public.`);
  }
  if (ILP_STATES.has(state)) {
    alerts.push(`Indian visitors need an Inner Line Permit (ILP) to enter ${state} — apply online before you travel.`);
  }
  if (state === 'Lakshadweep') alerts.push('An entry permit is required to visit Lakshadweep — arrange it before booking travel.');
  if (state === 'Ladakh' || state === 'Sikkim') {
    alerts.push('Some border areas need a permit or environment fee — check the official tourism portal before you go.');
  }

  // ---- Always useful ----
  add('🪪', 'Government photo ID (hotels require it at check-in)');
  add('🔋', 'Power bank and charging cable');
  add('💊', 'Personal medicines and a small first-aid kit');
  add('💵', 'Some cash for small shops and autos (UPI is widely accepted)');
  dos.push('Drink bottled or filtered water.');
  dos.push(metro ? 'Use app cabs, metered autos or the metro; agree on fares before rides that have no meter.' : 'Agree on auto and taxi fares before you start the ride.');
  donts.push('Don’t litter — many states ban single-use plastic and fine offenders.');
  if (metro || tier === 'metro' || tier === 'large') donts.push('Don’t keep phones and wallets in back pockets in crowded markets and trains.');

  return {
    summary,
    source: fc ? 'forecast' : 'seasonal',
    forecast: fc || [],
    elevation,
    pack: [...pack.values()],
    dos: [...new Set(dos)],
    donts: [...new Set(donts)],
    alerts,
    emergency: [
      { label: 'All emergencies', number: '112' },
      { label: 'Ambulance', number: '108' },
      { label: 'Tourist helpline (24×7)', number: '1363' },
    ],
  };
}

module.exports = { buildAdvice, rainyMonths, DRY_STATES };
