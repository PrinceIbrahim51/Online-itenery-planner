'use strict';

/**
 * Regenerates server/data/india-cities.json and server/data/india-airports.json.
 * Build-time only — the source packages are NOT app dependencies.
 *
 *   mkdir /tmp/ds && cd /tmp/ds && npm i all-the-cities airports-json country-state-city
 *   node scripts/build-india-data.js /tmp/ds/node_modules
 *
 * Sources:
 *  - Cities: GeoNames (CC BY 4.0) via the `all-the-cities` package — every Indian
 *    populated place with population ≥ 1,000.
 *  - Airports & state names: OurAirports (public domain) via `airports-json`.
 *  - `country-state-city` is used only to vote which GeoNames admin code belongs
 *    to which state; none of its data is copied into the output.
 */
const fs = require('node:fs');
const path = require('node:path');

const modules = path.resolve(process.argv[2] || '');
const req = (name) => require(path.join(modules, name));

const cities = req('all-the-cities').filter((c) => c.country === 'IN' && !['PPLQ', 'PPLH', 'PPLW'].includes(c.featureCode));
const { airports } = req('airports-json');
const { City } = req('country-state-city');

// ISO 3166-2:IN subdivision codes → official names (states and union territories).
const stateNames = new Map(Object.entries({
  AN: 'Andaman and Nicobar Islands', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar',
  CH: 'Chandigarh', CT: 'Chhattisgarh', DH: 'Dadra and Nagar Haveli and Daman and Diu', DL: 'Delhi', GA: 'Goa',
  GJ: 'Gujarat', HR: 'Haryana', HP: 'Himachal Pradesh', JK: 'Jammu and Kashmir', JH: 'Jharkhand', KA: 'Karnataka',
  KL: 'Kerala', LA: 'Ladakh', LD: 'Lakshadweep', MP: 'Madhya Pradesh', MH: 'Maharashtra', MN: 'Manipur',
  ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', OR: 'Odisha', PY: 'Puducherry', PB: 'Punjab', RJ: 'Rajasthan',
  SK: 'Sikkim', TN: 'Tamil Nadu', TG: 'Telangana', TR: 'Tripura', UP: 'Uttar Pradesh', UT: 'Uttarakhand',
  WB: 'West Bengal',
}));

// Well-known tourist towns that fall below GeoNames' population threshold.
const SUPPLEMENT = [
  ['Nainital', 'UT', 29.3803, 79.4636], ['Khajuraho', 'MP', 24.8318, 79.9199], ['Gulmarg', 'JK', 34.0484, 74.3805],
  ['Pahalgam', 'JK', 34.0161, 75.315], ['Sonamarg', 'JK', 34.303, 75.293], ['Konark', 'OR', 19.8876, 86.0945],
  ['Bodh Gaya', 'BR', 24.6951, 84.9913], ['Kasol', 'HP', 32.01, 77.315], ['Auli', 'UT', 30.528, 79.566],
  ['McLeod Ganj', 'HP', 32.2426, 76.3213], ['Kaza (Spiti)', 'HP', 32.2276, 78.071], ['Dalhousie', 'HP', 32.5387, 75.971],
  ['Mamallapuram', 'TN', 12.6208, 80.1945], ['Kumarakom', 'KL', 9.6176, 76.4301], ['Thekkady', 'KL', 9.6031, 77.1615],
  ['Swaraj Dweep (Havelock)', 'AN', 11.9761, 92.9876], ['Shaheed Dweep (Neil Island)', 'AN', 11.832, 93.03],
  ['Kaziranga', 'AS', 26.5775, 93.1711], ['Majuli', 'AS', 26.95, 94.1667], ['Ziro', 'AR', 27.5449, 93.8197],
  ['Nubra (Diskit)', 'LA', 34.5513, 77.56], ['Pelling', 'SK', 27.3, 88.24], ['Lachung', 'SK', 27.689, 88.743],
  ['Yercaud', 'TN', 11.7753, 78.2093], ['Dhordo (Rann of Kutch)', 'GJ', 23.835, 69.72], ['Kalpetta (Wayanad)', 'KL', 11.6085, 76.083],
];

const ascii = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
const slugify = (s) =>
  ascii(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function km(aLat, aLng, bLat, bLng) {
  const r = (d) => (d * Math.PI) / 180;
  const x = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

// --- Vote: GeoNames adminCode -> ISO state code -------------------------------
const reference = City.getCitiesOfCountry('IN').map((c) => ({ lat: +c.latitude, lng: +c.longitude, state: c.stateCode }));
function nearestState(lat, lng) {
  let best = null;
  let bestD = Infinity;
  for (const r of reference) {
    if (Math.abs(r.lat - lat) > 0.6 || Math.abs(r.lng - lng) > 0.6) continue;
    const d = km(lat, lng, r.lat, r.lng);
    if (d < bestD) {
      bestD = d;
      best = r.state;
    }
  }
  return best;
}
const votes = new Map();
const perCity = new Map();
for (const c of cities) {
  const [lng, lat] = c.loc.coordinates;
  const s = nearestState(lat, lng);
  perCity.set(c.cityId, s);
  if (!s) continue;
  const v = votes.get(c.adminCode) || new Map();
  v.set(s, (v.get(s) || 0) + 1);
  votes.set(c.adminCode, v);
}
const adminToState = new Map(
  [...votes].map(([admin, v]) => [admin, [...v].sort((a, b) => b[1] - a[1])[0][0]])
);

// Official renames not yet reflected in GeoNames primary names.
const RENAMES = {
  Cochin: 'Kochi',
  Darjiling: 'Darjeeling',
  Kanniyakumari: 'Kanyakumari',
  Abu: 'Mount Abu',
  Dharamsala: 'Dharamshala',
  Madikeri: 'Madikeri (Coorg)',
  Alappuzha: 'Alappuzha (Alleppey)',
  Allahabad: 'Prayagraj',
  Gurgaon: 'Gurugram',
  Faizabad: 'Ayodhya',
  Mughalsarai: 'Pt. Deen Dayal Upadhyaya Nagar',
  Aurangabad_MH: 'Chhatrapati Sambhajinagar',
  Osmanabad: 'Dharashiv',
  Hoshangabad: 'Narmadapuram',
};

const out = [];
for (const c of cities) {
  const [lng, lat] = c.loc.coordinates;
  // Union territories that were split/merged: trust the per-city vote when the admin vote disagrees strongly.
  let iso = adminToState.get(c.adminCode) || perCity.get(c.cityId);
  const own = perCity.get(c.cityId);
  if (own && own !== iso && ['LA', 'JK', 'TG', 'AP', 'DH', 'DN', 'DD'].includes(own)) iso = own;
  if (!iso || !stateNames.has(iso)) continue;
  let name = ascii(c.name);
  const aliases = [];
  const key = name === 'Aurangabad' && iso === 'MH' ? 'Aurangabad_MH' : name;
  if (RENAMES[key]) {
    aliases.push(name);
    name = RENAMES[key];
  }
  out.push({ name, aliases, state: stateNames.get(iso), stateCode: iso, lat: +lat.toFixed(4), lng: +lng.toFixed(4), pop: c.population });
}

for (const [name, iso, lat, lng] of SUPPLEMENT) {
  out.push({ name, aliases: [], state: stateNames.get(iso), stateCode: iso, lat, lng, pop: 5000 });
}

// Deduplicate same name within a state (keep most populous), then assign unique slugs.
out.sort((a, b) => b.pop - a.pop);
const seen = new Set();
const deduped = out.filter((c) => {
  const k = `${c.name.toLowerCase()}|${c.stateCode}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
const nameCount = new Map();
for (const c of deduped) nameCount.set(slugify(c.name), (nameCount.get(slugify(c.name)) || 0) + 1);
const slugs = new Set();
const final = deduped.map((c) => {
  let slug = slugify(c.name);
  if (nameCount.get(slug) > 1 && slugs.has(slug)) slug = `${slug}-${c.stateCode.toLowerCase()}`;
  slug = slug.slice(0, 58);
  slugs.add(slug);
  const row = { slug, name: c.name, state: c.state, lat: c.lat, lng: c.lng, pop: c.pop };
  if (c.aliases.length) row.aka = c.aliases;
  return row;
});

const ap = airports
  .filter((a) => a.iso_country === 'IN' && a.iata_code && a.scheduled_service === 'yes')
  .map((a) => ({
    iata: a.iata_code,
    name: ascii(a.name),
    city: ascii(a.municipality || ''),
    lat: +(+a.latitude_deg).toFixed(4),
    lng: +(+a.longitude_deg).toFixed(4),
    large: a.type === 'large_airport',
  }));

const dataDir = path.join(__dirname, '..', 'server', 'data');
fs.writeFileSync(path.join(dataDir, 'india-cities.json'), JSON.stringify(final));
fs.writeFileSync(path.join(dataDir, 'india-airports.json'), JSON.stringify(ap));
const states = new Set(final.map((c) => c.state));
console.log(`Wrote ${final.length} cities across ${states.size} states/UTs and ${ap.length} airports.`);
