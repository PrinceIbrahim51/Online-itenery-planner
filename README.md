# Voyagr — Premium Online Itinerary Planner

Pick a destination and the number of days. Voyagr builds a day-by-day itinerary and shows you:

- **Sightseeing**: must-see sights and famous tourist spots, grouped by neighbourhood with timings, entry fees, ratings and Google Maps links
- **Restaurants**: matched to your style (affordable, comfort or premium), with lunch and dinner picks near each day's route
- **Stays**: affordable, comfort and premium/luxury rooms with indicative nightly prices
- **Transport**: how to get there (flight, train, bus) and how to get around, split into **public** (metro, bus, local train, ferry) and **private** (auto, taxi, app cab, rentals)
- **Cab & auto fare comparison across apps**: Uber, Ola, Rapido, inDrive, GoaMiles and the government meter auto. Results are grouped by vehicle type, with the cheapest option highlighted. You can compare between any two sights or for any distance.
- **Trip cost estimate**: stay, food, local transport and entry fees
- **Accounts**: you can save trips, and there is an **admin console** for user management and security events

Featured destinations: Delhi, Mumbai, Goa, Jaipur, Agra, Udaipur, Varanasi and Hyderabad.
To plan *any* other city, set an optional `OPENTRIPMAP_API_KEY`. The server uses it to look up places and never sends it to the browser.

> Fares, prices and timings are indicative estimates. Ride-hailing apps don't publish pricing APIs, so fares come from published rate cards and are shown as a range from normal to peak pricing.

## Tech

- **Backend**: Node.js 22 + Express 5, built-in `node:sqlite` (no native build step), zod validation
- **Frontend**: dependency-free HTML/CSS/ES modules with a midnight-navy and champagne-gold theme, served under a strict Content-Security-Policy
- **Runtime dependencies** (6): `express`, `helmet`, `cors`, `express-rate-limit`, `cookie-parser`, `zod`

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
