# Voyagr — Premium Online Itinerary Planner

Pick a destination and the number of days. Voyagr builds a day-by-day itinerary and shows you:

- **Sightseeing**: must-see sights and famous tourist spots, grouped by neighbourhood with timings, entry fees, ratings and Google Maps links
- **Restaurants**: matched to your style (affordable, comfort or premium), with lunch and dinner picks near each day's route
- **Stays**: affordable, comfort and premium/luxury rooms with indicative nightly prices
- **Transport**: how to get there (flight, train, bus) and how to get around, split into **public** (metro, bus, local train, ferry) and **private** (auto, taxi, app cab, rentals)
- **Cab & auto fare comparison across apps**: Uber, Ola, Rapido, inDrive, GoaMiles and the government meter auto. Results are grouped by vehicle type, with the cheapest option highlighted. You can compare between any two sights or for any distance.
- **Trip cost estimate**: stay, food, local transport and entry fees
- **Accounts**: you can save trips, and there is an **admin console** for user management and security events
- **Opening hours & closures**: restaurant hours, an "open at lunch/dinner on that day" check, "closed on Day N" warnings, and temporarily-closed / under-renovation places flagged and never used in plans
- **Book a table**: "WhatsApp to book" (a ready-written message with your party size and date) when the restaurant lists WhatsApp, and "Call to book" when it lists a phone number
- **Photo spots** with tips and the sunrise/sunset golden hour for each trip day
- **Before you go**: live weather forecast (Open-Meteo) or seasonal expectations, a packing list (sweater, umbrella, sunscreen…), dos & don'ts, permit / dry-state / altitude alerts, and emergency numbers
- **Nightlife & events**: bars, pubs and clubs nearby, plus event listings for your dates
- **Customisable itinerary**: reorder, remove, move between days, add sights or your own stops and notes; edits are kept and saved with your trip; **Download PDF**
- **Where was this photo taken?**: reads the GPS location stored in a photo on your device (the photo isn't uploaded), then shows the exact spot, the town and famous places nearby; optional landmark recognition for photos without GPS
- **Price-style filters**: Restaurants and Stays default to the style you picked (Affordable / Comfort / Premium), with "All" one tap away

**Every city, town, district and state in India.** You can search 3,472 cities and towns, 751 districts and all 36 states and union territories.
- **Typo-tolerant search** with suggestions under the search bar. It handles transliteration variants (Thirunelveli → Tirunelveli, Kanniyakumari → Kanyakumari), old names (Madras, Tuticorin, Trichy, Orissa) and ordinary typos ("Did you mean Coimbatore?").
- **District plans** centre on the district headquarters. **State pages** list every district and the major towns.
- **Featured guides** (Delhi, Mumbai, Goa, Jaipur, Agra, Udaipur, Varanasi, Hyderabad) are hand-curated, with ratings, prices and must-try dishes.
- **Every other city** is planned with **live OpenStreetMap data** fetched on the server: sights, restaurants, hotels, railway stations and bus stands. On top of that come the nearest airports (from a bundled dataset), city-sized cost, fare and stay-price profiles, local transport and nearby day trips. No API key is needed.
- Live places never get invented ratings or prices. Notable places are marked "✦ Notable" (they have a Wikipedia/Wikidata entry), and stay prices are labelled as typical ranges for the city.
- If OpenStreetMap is unreachable, the plan still loads with transport, fares and costs, plus links to search the city on Google Maps.

### Optional Google keys (recommended for production)

| Variable | Unlocks | Notes |
| --- | --- | --- |
| `GOOGLE_PLACES_API_KEY` | Accurate restaurant hours, **temporarily closed** status, price levels (better filters), ratings, phone numbers and "Reserve on Google" | Places API (New) Nearby Search. Billed by Google per request; results are cached for 12 hours. Restrict the key to the Places API. |
| `GOOGLE_VISION_API_KEY` | Landmark recognition for photos **without** GPS data | Each photo is shrunk and stripped of metadata in the browser, sent only after the user taps "Recognise landmark", forwarded once and never stored. Limited to 10 per hour per IP. |

Without these keys, everything else still works using free data (OpenStreetMap, Wikipedia, Open-Meteo).

An optional `OPENTRIPMAP_API_KEY` adds places **outside** India. It is used only on the server and never sent to the browser.

> Fares, prices and timings are indicative estimates. Ride-hailing apps don't publish pricing APIs, so fares come from published rate cards and are shown as a range from normal to peak pricing.

## Tech

- **Backend**: Node.js 22 + Express 5, built-in `node:sqlite` (no native build step), zod validation
- **Frontend**: dependency-free HTML/CSS/ES modules with a midnight-navy and champagne-gold glassmorphism theme (frosted panels, no pill shapes or purple gradients), served under a strict Content-Security-Policy
- **Database**: PostgreSQL in production (`DATABASE_URL`, for example Neon from Vercel's Storage tab), SQLite locally
- **Runtime dependencies** (7): `express`, `helmet`, `cors`, `express-rate-limit`, `cookie-parser`, `zod`, `pg`
- **Data**: GeoNames (CC BY 4.0), OurAirports (public domain), India Post pincode directory via data.gov.in (GODL-India) for districts, © OpenStreetMap contributors (ODbL), Wikipedia (CC BY-SA). Regenerate the bundled city and airport files with `scripts/build-india-data.js`.

## Getting started

```bash
npm ci
cp .env.example .env          # then edit it; .env is git-ignored
# local http development only:
#   NODE_ENV=development and COOKIE_SECURE=false in .env
npm run dev                   # http://127.0.0.1:3000
```

Create an admin account. There are **no default admin credentials**:

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-unique-passphrase-2026' npm run create-admin
```

Production:

```bash
NODE_ENV=production npm start   # must be served over HTTPS (behind a TLS proxy)
```

Set `TRUST_PROXY=1` when running behind one reverse proxy (Nginx, Render, Heroku, and so on) so that rate limiting sees real client IPs.

## Deploying to Vercel

The repo is ready for Vercel as is:
- `api/index.js` runs the Express API as one serverless function, in the Mumbai region (`bom1`).
- Vercel's CDN serves `public/`, and `vercel.json` applies the same security headers there (CSP, HSTS and so on).
- `.vercelignore` keeps `.env`, databases and tests out of uploads.

**Turn on accounts** (sign-up, saved trips, admin): Vercel's filesystem is temporary, so accounts need a real database.
1. In the Vercel project, open **Storage**, then **Create Database**, then choose **Neon (Postgres)**. Connect it to the project; this adds `DATABASE_URL`.
2. Redeploy. The tables are created automatically on first use.
3. Create your admin from your machine:
   `DATABASE_URL='postgres://…' ADMIN_EMAIL=… ADMIN_PASSWORD='…' npm run create-admin`

Until `DATABASE_URL` is set, the planner works fully and the sign-in buttons are hidden. Account endpoints answer `503`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with auto-reload |
| `npm start` | Production server |
| `npm test` | Unit, API and security regression tests (`node:test`) |
| `npm run audit:deps` | `npm audit` of production dependencies |
| `npm run scan:secrets` | Scans the working tree and **full git history** for leaked secrets |
| `npm run security:check` | Runs all three checks above |
| `npm run create-admin` | Creates or promotes an admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD` |

## Project layout

```
server/
  index.js            process entry (timeouts, graceful shutdown)
  app.js              Express app: headers, CORS, rate limits, routing
  config.js           validated env configuration (fail-fast)
  db.js               SQLite schema (prepared statements only)
  security/           passwords, sessions, auth/CSRF/validation middleware, sanitisation
  routes/             auth, plan, trips, admin
  services/           itinerary engine, fare comparison, OpenTripMap provider
  data/               curated destination catalogue
public/               the ONLY directory served to browsers
scripts/              create-admin, scan-secrets
test/                 security + itinerary tests
```

See **[SECURITY.md](SECURITY.md)** for the full security audit.
