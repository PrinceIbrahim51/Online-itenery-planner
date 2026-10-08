import { h, clear, $, $$, money, stars } from './dom.js';

// ---------------------------------------------------------------------------
// API client — same-origin cookies + CSRF header on every write
// ---------------------------------------------------------------------------
const state = { user: null, csrf: null, plan: null, destinations: [], accountsEnabled: true, suggestions: new Map() };

async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (state.csrf) headers['X-CSRF-Token'] = state.csrf;
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    if (res.status === 401 && state.user) setUser(null, null);
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3800);
}

function loading(container, text = 'Loading…') {
  clear(container).append(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), text));
}

function setUser(user, csrf) {
  state.user = user;
  state.csrf = csrf;
  const signedIn = Boolean(user);
  $$('.auth-only').forEach((el) => (el.hidden = !signedIn));
  $$('.guest-only').forEach((el) => (el.hidden = signedIn || !state.accountsEnabled));
  $('#btn-save').hidden = !state.accountsEnabled;
  // Purely cosmetic: the server enforces the admin role on every admin request.
  $$('.admin-only').forEach((el) => (el.hidden = !(signedIn && user.role === 'admin')));
  $('#user-name').textContent = user ? user.name : '';
  $('#user-initial').textContent = user ? user.name.charAt(0).toUpperCase() : '';
}

// ---------------------------------------------------------------------------
// Routing (hash based)
// ---------------------------------------------------------------------------
function showView(name) {
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== name));
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  window.scrollTo({ top: 0 });
}

async function route() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/plan')) {
    const params = new URLSearchParams(hash.split('?')[1] || '');
    return loadPlan(params);
  }
  if (hash === '#/trips') {
    if (!state.user) return requireSignIn();
    showView('trips');
    return loadTrips();
  }
  if (hash === '#/admin') {
    if (!state.user) return requireSignIn();
    showView('admin');
    return loadAdmin();
  }
  showView('home');
}

function requireSignIn() {
  location.hash = '#/';
  openAuth('login');
  toast('Please sign in to continue.');
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
async function loadDestinations() {
  try {
    const data = await api('/destinations');
    state.destinations = data.destinations;
    if (data.totalCities) $('#city-count').textContent = `${Math.floor(data.totalCities / 100) * 100}+`;
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const grid = clear($('#dest-grid'));
  state.destinations.forEach((d, i) => {
    grid.append(
      h(
        'button',
        {
          type: 'button',
          class: `dest-card glass art-${i % 8}`,
          onClick: () => {
            $('#f-destination').value = d.name;
            state.suggestions.set(d.name.toLowerCase(), d.slug);
            $('#plan-form').requestSubmit();
          },
        },
        h('span', { class: 'eyebrow' }, d.region),
        h('h3', {}, d.name),
        h('p', {}, d.tagline),
        h('span', { class: 'mini' }, `Best: ${d.bestTime} · ${d.highlights.join(' · ')}`)
      )
    );
  });
}

function initPlanner() {
  const travelers = $('#f-travelers');
  for (let i = 1; i <= 12; i++) travelers.append(h('option', { value: i }, `${i} ${i === 1 ? 'traveller' : 'travellers'}`));
  travelers.value = '2';

  const days = $('#f-days');
  $$('.stepper button').forEach((b) =>
    b.addEventListener('click', () => {
      const v = Math.min(14, Math.max(1, (Number(days.value) || 1) + Number(b.dataset.step)));
      days.value = String(v);
    })
  );

  // City autocomplete across every Indian city and town (server-side search).
  const input = $('#f-destination');
  let timer;
  let seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2 || state.suggestions.has(q.toLowerCase())) return;
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const { cities } = await api(`/cities?${new URLSearchParams({ q })}`);
        if (mine !== seq) return; // a newer search is in flight
        const list = clear($('#dest-list'));
        for (const c of cities) {
          const label = `${c.name}, ${c.state}`;
          state.suggestions.set(label.toLowerCase(), c.slug);
          list.append(h('option', { value: label }, c.curated ? 'Featured guide' : ''));
        }
      } catch {
        /* suggestions are best-effort */
      }
    }, 180);
  });

  async function resolveSlug(raw) {
    const key = raw.toLowerCase();
    if (state.suggestions.has(key)) return state.suggestions.get(key);
    const featured = state.destinations.find((d) => d.name.toLowerCase() === key || d.slug === key);
    if (featured) return featured.slug;
    const { cities } = await api(`/cities?${new URLSearchParams({ q: raw.split(',')[0] })}`);
    return cities[0]?.slug ?? null;
  }

  $('#plan-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = input.value.trim();
    if (!raw) return toast('Choose a destination first.', true);
    let slug;
    try {
      slug = await resolveSlug(raw);
    } catch (err) {
      return toast(err.message, true);
    }
    if (!slug) return toast('We couldn’t find that place in India — check the spelling and pick from the suggestions.', true);
    const params = new URLSearchParams({
      destination: slug,
      days: String(Math.min(14, Math.max(1, Number(days.value) || 3))),
      travelers: travelers.value,
      budget: new FormData(e.target).get('budget') || 'comfort',
    });
    location.hash = `#/plan?${params}`;
  });
}

// ---------------------------------------------------------------------------
// Plan results
// ---------------------------------------------------------------------------
let planSeq = 0;

/** Wipes every trace of the previous plan so nothing stale shows while loading. */
function resetPlanView(loadingText) {
  state.plan = null;
  for (const id of ['#r-region', '#r-tagline', '#r-disclaimer']) $(id).textContent = '';
  $('#r-title').textContent = 'Planning your trip…';
  clear($('#r-chips'));
  clear($('#r-estimate'));
  $('#r-banner').hidden = true;
  $('#btn-save').hidden = true;
  for (const name of ['sights', 'food', 'stays', 'transport']) clear($(`[data-panel="${name}"]`));
  clear($('#ride-results'));
  clear($('#ride-from'));
  clear($('#ride-to'));
  selectTab('itinerary');
  loading($('[data-panel="itinerary"]'), loadingText);
}

async function loadPlan(params) {
  const mine = ++planSeq;
  showView('plan');
  const featured = state.destinations.some((d) => d.slug === params.get('destination'));
  resetPlanView(featured ? 'Crafting your itinerary…' : 'Gathering live sights, food and stays…');
  let plan;
  try {
    plan = await api(`/plan?${params}`);
  } catch (err) {
    if (mine !== planSeq) return; // a newer search has started
    $('#r-title').textContent = 'Couldn’t plan this trip';
    clear($('[data-panel="itinerary"]')).append(h('div', { class: 'empty glass' }, err.message));
    return;
  }
  if (mine !== planSeq) return; // ignore responses for an older search
  state.plan = plan;
  $('#btn-save').hidden = !state.accountsEnabled;
  renderPlan(plan);
}

const SLOT_LABEL = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', any: 'Anytime' };
const TIER_LABEL = { budget: 'Affordable', comfort: 'Comfort', premium: 'Premium' };

function renderPlan(p) {
  const { destination: d, params } = p;
  $('#r-region').textContent = d.region;
  $('#r-title').textContent = `${params.days} ${params.days === 1 ? 'day' : 'days'} in ${d.name}`;
  $('#r-tagline').textContent = d.tagline;
  clear($('#r-chips')).append(
    h('span', { class: 'chip gold' }, TIER_LABEL[params.budget]),
    h('span', { class: 'chip' }, `${params.travelers} ${params.travelers === 1 ? 'traveller' : 'travellers'}`),
    h('span', { class: 'chip' }, `${params.nights} ${params.nights === 1 ? 'night' : 'nights'} · ${params.rooms} ${params.rooms === 1 ? 'room' : 'rooms'}`),
    h('span', { class: 'chip green' }, `Best time: ${d.bestTime}`)
  );
  $('#r-disclaimer').textContent = p.attribution ? `${p.disclaimer} ${p.attribution}.` : p.disclaimer;
  const banner = $('#r-banner');
  const status = d.liveStatus || 'ok';
  banner.hidden = status === 'ok';
  const reason = d.liveIssue ? ` (${d.liveIssue.replace('_', ' ')})` : '';
  if (status === 'unavailable') {
    clear(banner).append(
      `Live places couldn’t be loaded right now${reason}, so this plan shows transport, fares and costs only. `,
      h('a', { href: p.searchLinks.sights }, 'Browse sights on Google Maps ↗'),
      ' or try again in a minute.'
    );
  } else if (status === 'partial') {
    const missing = (d.failedParts || []).map((x) => ({ sights: 'sights', food: 'restaurants & hotels', hubs: 'station details' })[x]).filter(Boolean);
    clear(banner).append(
      `Some live data didn’t load${missing.length ? ` (${missing.join(', ')})` : ''}${reason} — showing everything we could get. `,
      ...(d.failedParts?.includes('food') ? [h('a', { href: p.searchLinks.restaurants }, 'Restaurants on Google Maps ↗'), ' · '] : []),
      'Refresh in a minute for the full plan.'
    );
  }

  const e = p.estimate;
  clear($('#r-estimate')).append(
    stat('Stay', money(e.stay)),
    stat('Food', money(e.food)),
    stat('Local transport', money(e.localTransport)),
    stat('Entry fees', money(e.entryFees)),
    stat('Estimated total', money(e.total), 'total')
  );

  renderItinerary(p);
  renderSights(p);
  renderFood(p);
  renderStays(p);
  renderTransport(p);
  renderRides(p);
}

/** Curated places show a rating; live OpenStreetMap places never get a made-up one. */
function ratingBadge(x) {
  if (typeof x.rating === 'number') return h('span', { class: 'rating' }, stars(x.rating));
  if (x.notable) return h('span', { class: 'rating' }, '✦ Notable');
  return null;
}

function emptyWithLink(text, url, label) {
  return h('div', { class: 'empty glass' }, text, ' ', h('a', { href: url }, label));
}

function stat(k, v, extra = '') {
  return h('div', { class: `stat glass ${extra}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
}

function mapLink(url) {
  return h('a', { href: url }, 'Open in Maps ↗');
}

function renderItinerary(p) {
  const panel = clear($('[data-panel="itinerary"]'));
  for (const day of p.itinerary) {
    const card = h(
      'article',
      { class: 'day glass' },
      h('div', { class: 'day-head' }, h('span', { class: 'day-num' }, `Day ${day.day}`), h('span', { class: 'day-theme' }, day.theme))
    );
    if (day.stops.length) {
      card.append(
        h(
          'ol',
          { class: 'timeline' },
          day.stops.map((s) =>
            h(
              'li',
              {},
              s.legFromPrevious
                ? h(
                    'div',
                    { class: 'leg' },
                    `↳ ${s.legFromPrevious.km} km · ${s.legFromPrevious.mode} · ~${s.legFromPrevious.minutes} min` +
                      (s.legFromPrevious.fare ? ` · from ${money(s.legFromPrevious.fare)}${s.legFromPrevious.app ? ` (${s.legFromPrevious.app})` : ''}` : '')
                  )
                : null,
              h('div', { class: 'stop-title' }, h('span', { class: 'slot' }, SLOT_LABEL[s.slot] || 'Anytime'), h('strong', {}, s.name), ratingBadge(s)),
              h('p', { class: 'stop-blurb' }, s.blurb),
              h('div', { class: 'stop-meta' }, h('span', {}, `🕘 ${s.hours}`), h('span', {}, `🎟 ${s.fee}`), h('span', {}, `⏱ ~${s.durationHrs} h`), mapLink(s.mapsUrl))
            )
          )
        )
      );
    } else if (day.note) {
      card.append(h('p', { class: 'stop-blurb' }, day.note));
    }
    const meal = (label, r) =>
      h(
        'div',
        { class: 'meal' },
        h('div', { class: 'k' }, label),
        r ? [h('strong', {}, r.name), h('div', { class: 'muted' }, [r.cuisine, r.area, r.costForTwo ? `${money(r.costForTwo)} for two` : null].filter(Boolean).join(' · '))] : h('span', { class: 'muted' }, 'Explore local eateries nearby')
      );
    card.append(h('div', { class: 'meals' }, meal('Lunch', day.meals.lunch), meal('Dinner', day.meals.dinner)));
    panel.append(card);
  }
}

function renderSights(p) {
  const panel = clear($('[data-panel="sights"]'));
  if (!p.attractions.length) {
    panel.append(emptyWithLink('No sights found in map data for this place yet.', p.searchLinks.sights, 'Search attractions on Google Maps ↗'));
    return;
  }
  panel.append(
    h(
      'div',
      { class: 'card-grid' },
      p.attractions.map((a) =>
        h(
          'article',
          { class: 'card glass' },
          h('div', { class: 'row' }, h('span', { class: 'chip' }, a.category), ratingBadge(a)),
          h('h3', {}, a.name),
          h('p', {}, a.blurb),
          h('div', { class: 'stop-meta' }, h('span', {}, `📍 ${a.area}`), h('span', {}, `🎟 ${a.fee}`)),
          h('div', { class: 'stop-meta' }, h('span', {}, `🕘 ${a.hours}`)),
          h('div', { class: 'links' }, mapLink(a.mapsUrl))
        )
      )
    )
  );
}

function renderFood(p) {
  const panel = clear($('[data-panel="food"]'));
  if (!p.restaurants.length) {
    panel.append(emptyWithLink('No restaurants found in map data near the centre.', p.searchLinks.restaurants, 'Find restaurants on Google Maps ↗'));
    return;
  }
  panel.append(
    h(
      'div',
      { class: 'card-grid' },
      p.restaurants.map((r) =>
        h(
          'article',
          { class: 'card glass' },
          h('div', { class: 'row' }, h('span', { class: `chip ${r.tier === 'premium' ? 'gold' : ''}` }, TIER_LABEL[r.tier] || r.cuisine), ratingBadge(r)),
          h('h3', {}, r.name),
          h('p', {}, `${r.cuisine} · ${r.area}`),
          r.mustTry ? h('p', {}, `Must try: ${r.mustTry}`) : null,
          r.costForTwo
            ? h('div', { class: 'row' }, h('span', { class: 'price' }, money(r.costForTwo)), h('span', { class: 'muted' }, 'approx. for two'))
            : h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Prices vary — check the menu on Maps')),
          h('div', { class: 'links' }, mapLink(r.mapsUrl))
        )
      )
    )
  );
}

function renderStays(p) {
  const panel = clear($('[data-panel="stays"]'));
  const tier = (title, items, badge) => {
    if (!items.length) return null;
    return [
      h('div', { class: 'tier-title' }, title, h('span', { class: `chip ${badge}` }, `${items.length} picks`)),
      h(
        'div',
        { class: 'card-grid' },
        items.map((s) =>
          h(
            'article',
            { class: 'card glass' },
            h('div', { class: 'row' }, h('span', { class: 'chip' }, s.area), ratingBadge(s)),
            h('h3', {}, s.name),
            s.highlights.length ? h('p', {}, s.highlights.join(' · ')) : null,
            h('div', { class: 'row' }, h('span', { class: 'price' }, `${money(s.pricePerNight[0])} – ${money(s.pricePerNight[1])}`), h('span', { class: 'muted' }, s.priceIsTypical ? 'typical per night here' : 'per night')),
            h('div', { class: 'links' }, mapLink(s.mapsUrl))
          )
        )
      ),
    ];
  };
  panel.append(
    ...[tier('Affordable', p.stays.affordable, ''), tier('Comfort', p.stays.comfort, ''), tier('Premium & luxury', p.stays.premium, 'gold')].flat().filter(Boolean),
    h('p', { class: 'disclaimer' }, h('a', { href: p.stays.bookingSearchUrl }, `Check live availability for ${p.destination.name} ↗`))
  );
  if (!panel.querySelector('.card')) {
    panel.prepend(emptyWithLink('No hotels found in map data for this place yet.', p.searchLinks.stays, 'Find hotels on Google Maps ↗'));
  }
}

function renderTransport(p) {
  const list = (title, items, render) => h('section', { class: 'list-card glass' }, h('h3', {}, title), h('ul', {}, items.map(render)));
  const localItem = (l) => h('li', {}, h('div', { class: 'row' }, h('strong', {}, l.mode), h('span', { class: 'rating' }, l.fare)), h('small', {}, l.note));

  clear($('[data-panel="transport"]')).append(
    list('Getting there', p.transport.reach, (r) =>
      h('li', {}, h('div', { class: 'row' }, h('strong', {}, r.mode), r.distanceKm ? h('span', { class: 'muted' }, `${r.distanceKm} km to centre`) : null), h('div', {}, r.hub), h('small', {}, r.note))
    ),
    h('div', { class: 'split' }, list('Public transport', p.transport.public, localItem), list('Private transport', p.transport.private, localItem)),
    p.dayTrips.length
      ? list('Day trips nearby', p.dayTrips, (t) =>
          h(
            'li',
            {},
            h('div', { class: 'row' }, h('strong', {}, t.name), h('span', { class: 'muted' }, `${t.distanceKm} km`)),
            h('small', {}, t.note),
            t.slug
              ? h('div', {}, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => (location.hash = `#/plan?${new URLSearchParams({ destination: t.slug, days: '2', travelers: String(p.params.travelers), budget: p.params.budget })}`) }, `Plan ${t.name} →`))
              : null
          )
        )
      : null
  );
}

function renderRides(p) {
  const from = clear($('#ride-from'));
  const to = clear($('#ride-to'));
  from.append(h('option', { value: '' }, 'Choose a place…'));
  to.append(h('option', { value: '' }, 'Choose a place…'));
  p.attractions.forEach((a, i) => {
    from.append(h('option', { value: i }, a.name));
    to.append(h('option', { value: i }, a.name));
  });
  renderFareTable(p.rideComparison.medium);
}

function haversineKm(a, b) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function compareRide() {
  const p = state.plan;
  if (!p) return;
  const fi = $('#ride-from').value;
  const ti = $('#ride-to').value;
  let km = Number($('#ride-km').value);
  if (fi !== '' && ti !== '' && fi !== ti) {
    km = Math.max(0.5, Math.round(haversineKm(p.attractions[fi], p.attractions[ti]) * 1.35 * 10) / 10);
    $('#ride-km').value = String(km);
  }
  if (!(km >= 0.5 && km <= 300)) return toast('Distance must be between 0.5 and 300 km.', true);
  const results = $('#ride-results');
  loading(results, 'Comparing fares…');
  try {
    const data = await api(`/fares?${new URLSearchParams({ destination: p.destination.slug, km: String(km) })}`);
    renderFareTable(data);
  } catch (err) {
    clear(results).append(h('div', { class: 'empty glass' }, err.message));
  }
}

function renderFareTable(cmp) {
  const results = clear($('#ride-results'));
  results.append(h('p', { class: 'ride-summary' }, `Estimated for ${cmp.distanceKm} km · ~${cmp.durationMin} min in typical traffic. Range shows normal → peak/surge pricing.`));
  const max = Math.max(...cmp.groups.flatMap((g) => g.options.map((o) => o.high)), 1);
  for (const g of cmp.groups) {
    results.append(
      h(
        'section',
        { class: 'ride-group glass' },
        h('h3', {}, g.category),
        g.options.map((o) =>
          h(
            'div',
            { class: `ride-row ${o.cheapest ? 'best' : ''}` },
            h('div', {}, h('strong', {}, o.product), h('small', {}, o.app), o.note ? h('small', {}, o.note) : null),
            h('div', { class: 'bar', title: 'Relative price' }, h('span', { style: { width: `${Math.round((o.low / max) * 100)}%` } })),
            h('div', { class: 'seats muted' }, `${o.seats} seat${o.seats > 1 ? 's' : ''}`),
            h('div', {}, h('span', { class: 'fare' }, `${money(o.low)} – ${money(o.high)}`), o.cheapest ? h('small', { class: 'rating' }, 'Cheapest') : null, o.appUrl ? h('small', {}, h('a', { href: o.appUrl }, 'Open app ↗')) : null)
          )
        )
      )
    );
  }
}

function selectTab(name) {
  $$('.tabs [role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('.tab-panel').forEach((pnl) => (pnl.hidden = pnl.dataset.panel !== name));
}

// ---------------------------------------------------------------------------
// Saved trips
// ---------------------------------------------------------------------------
async function loadTrips() {
  const listEl = $('#trip-list');
  loading(listEl);
  try {
    const { trips } = await api('/trips');
    clear(listEl);
    if (!trips.length) {
      listEl.append(h('div', { class: 'empty glass' }, 'No saved trips yet — plan one and tap “Save trip”.'));
      return;
    }
    for (const t of trips) {
      const params = new URLSearchParams({ destination: t.destination, days: t.days, travelers: t.travelers, budget: t.budget });
      listEl.append(
        h(
          'article',
          { class: 'trip glass' },
          h('div', {}, h('h3', {}, t.title), h('span', { class: 'muted' }, `${state.destinations.find((d) => d.slug === t.destination)?.name ?? t.destination} · ${t.days} days · ${t.travelers} travellers · ${TIER_LABEL[t.budget]} · saved ${new Date(t.created_at).toLocaleDateString()}`)),
          h(
            'div',
            { class: 'actions' },
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => (location.hash = `#/plan?${params}`) }, 'Open'),
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-danger btn-sm',
                onClick: async () => {
                  if (!confirm('Delete this trip?')) return;
                  try {
                    await api(`/trips/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
                    toast('Trip deleted.');
                    loadTrips();
                  } catch (err) {
                    toast(err.message, true);
                  }
                },
              },
              'Delete'
            )
          )
        )
      );
    }
  } catch (err) {
    clear(listEl).append(h('div', { class: 'empty glass' }, err.message));
  }
}

function initSave() {
  const dialog = $('#save-dialog');
  $('#btn-save').addEventListener('click', () => {
    if (!state.user) return openAuth('login');
    if (!state.plan) return;
    $('#s-title').value = `${state.plan.destination.name} getaway`;
    $('#save-error').textContent = '';
    dialog.showModal();
  });
  $('#save-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { params, destination } = state.plan;
    try {
      await api('/trips', {
        method: 'POST',
        body: { title: $('#s-title').value, destination: destination.slug, days: params.days, travelers: params.travelers, budget: params.budget },
      });
      dialog.close();
      toast('Trip saved to “My trips”.');
    } catch (err) {
      $('#save-error').textContent = err.message;
    }
  });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
async function loadAdmin() {
  const statsEl = $('#admin-stats');
  loading(statsEl);
  try {
    const [{ stats }, { users }, { events }] = await Promise.all([api('/admin/stats'), api('/admin/users'), api('/admin/audit')]);
    clear(statsEl).append(
      stat('Users', stats.users),
      stat('Disabled', stats.disabled_users),
      stat('Saved trips', stats.trips),
      stat('Active sessions', stats.active_sessions),
      stat('Failed logins (24h)', stats.failed_logins_24h, stats.failed_logins_24h > 20 ? 'total' : '')
    );
    const row = (cells, tag = 'td') => h('tr', {}, cells.map((c) => h(tag, {}, c)));
    clear($('#admin-users')).append(
      h('thead', {}, row(['Name', 'Email', 'Role', 'Joined', 'Status'], 'th')),
      h(
        'tbody',
        {},
        users.map((u) =>
          row([
            u.name,
            u.email,
            u.role,
            new Date(u.created_at).toLocaleDateString(),
            u.role === 'admin'
              ? '—'
              : h(
                  'button',
                  {
                    type: 'button',
                    class: `btn btn-sm ${u.disabled ? 'btn-ghost' : 'btn-danger'}`,
                    onClick: async () => {
                      try {
                        await api(`/admin/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: { disabled: !u.disabled } });
                        loadAdmin();
                      } catch (err) {
                        toast(err.message, true);
                      }
                    },
                  },
                  u.disabled ? 'Enable' : 'Disable'
                ),
          ])
        )
      )
    );
    clear($('#admin-audit')).append(
      h('thead', {}, row(['When', 'User', 'Event', 'Detail'], 'th')),
      h('tbody', {}, events.map((ev) => row([new Date(ev.created_at).toLocaleString(), ev.user_id ?? '—', ev.action, ev.detail ?? '']))),
    );
  } catch (err) {
    clear(statsEl).append(h('div', { class: 'empty glass' }, err.message));
  }
}

// ---------------------------------------------------------------------------
// Authentication dialog
// ---------------------------------------------------------------------------
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  const reg = mode === 'register';
  $(`input[name="auth-mode"][value="${mode}"]`).checked = true;
  $('#auth-title').textContent = reg ? 'Create your account' : 'Welcome back';
  $('#auth-submit').textContent = reg ? 'Create account' : 'Sign in';
  $('#name-field').hidden = !reg;
  $('#pw-hint').hidden = !reg;
  $('#a-password').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
  $('#auth-error').textContent = '';
}

function openAuth(mode) {
  setAuthMode(mode);
  $('#auth-form').reset();
  setAuthMode(mode);
  $('#auth-dialog').showModal();
}

function initAuth() {
  $('#btn-signin').addEventListener('click', () => openAuth('login'));
  $('#btn-signup').addEventListener('click', () => openAuth('register'));
  $$('input[name="auth-mode"]').forEach((r) => r.addEventListener('change', () => setAuthMode(r.value)));

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#auth-submit');
    btn.disabled = true;
    $('#auth-error').textContent = '';
    const body = { email: $('#a-email').value, password: $('#a-password').value };
    if (authMode === 'register') body.name = $('#a-name').value;
    try {
      const data = await api(`/auth/${authMode === 'register' ? 'register' : 'login'}`, { method: 'POST', body });
      setUser(data.user, data.csrfToken);
      $('#auth-form').reset();
      $('#auth-dialog').close();
      toast(`Welcome, ${data.user.name}!`);
      route();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    } finally {
      btn.disabled = false;
      $('#a-password').value = '';
    }
  });

  $('#btn-signout').addEventListener('click', async () => {
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
    } catch {
      /* session may already be gone */
    }
    setUser(null, null);
    toast('Signed out.');
    location.hash = '#/';
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  $('#year').textContent = String(new Date().getFullYear());
  initPlanner();
  initAuth();
  initSave();
  $$('.tabs [role="tab"]').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
  $('#btn-back').addEventListener('click', () => (location.hash = '#/'));
  $('#ride-go').addEventListener('click', compareRide);

  try {
    const me = await api('/auth/me');
    state.accountsEnabled = me.accountsEnabled !== false;
    setUser(me.user, me.csrfToken ?? null);
  } catch {
    setUser(null, null);
  }
  await loadDestinations();
  window.addEventListener('hashchange', route);
  route();
}

boot();
