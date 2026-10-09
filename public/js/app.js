import { h, clear, $, $$, money, stars } from './dom.js';
import { initPhotoFinder } from './photo.js';
import { printPlan } from './print.js';

// ---------------------------------------------------------------------------
// API client — same-origin cookies + CSRF header on every write
// ---------------------------------------------------------------------------
const state = {
  user: null,
  csrf: null,
  plan: null,
  destinations: [],
  accountsEnabled: true,
  selectDestination: () => {},
  custom: null, // the user's customised itinerary: { days: [{ note, stops: [...] }] }
  editing: false,
  tripId: null, // set when a saved trip is open, so edits can update it
  foodFilter: null,
  stayFilter: null,
};

async function api(path, { method = 'GET', body, rawBody, contentType } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['Content-Type'] = rawBody ? contentType : 'application/json';
    if (state.csrf) headers['X-CSRF-Token'] = state.csrf;
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
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
// Dates (local calendar dates as YYYY-MM-DD)
// ---------------------------------------------------------------------------
function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDaysIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function prettyDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
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
  if (hash.startsWith('#/state/')) {
    showView('state');
    return loadState(hash.slice('#/state/'.length));
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
    if (data.totalDistricts) $('#district-count').textContent = `${Math.floor(data.totalDistricts / 10) * 10}+`;
    clear($('#state-grid')).append(
      ...(data.states || []).map((st) =>
        h('button', { type: 'button', class: 'chip state-chip', onClick: () => (location.hash = `#/state/${st.code}`) }, st.name)
      )
    );
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
            state.selectDestination(d.slug, d.name);
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

  // Trip start date: today by default, up to a year ahead.
  const startInput = $('#f-start');
  const today = isoToday();
  startInput.min = today;
  startInput.max = addDaysIso(today, 365);
  if (!startInput.value) startInput.value = today;

  const days = $('#f-days');
  $$('.stepper button').forEach((b) =>
    b.addEventListener('click', () => {
      const v = Math.min(14, Math.max(1, (Number(days.value) || 1) + Number(b.dataset.step)));
      days.value = String(v);
    })
  );

  // ---- Destination search: cities, districts and states, typo-tolerant ----
  const input = $('#f-destination');
  const box = $('#dest-suggest');
  let timer;
  let seq = 0;
  let items = [];
  let active = -1;
  let selected = null; // { slug, type, code, label }

  const ICON = { state: '🗺', district: '◎', city: '•' };

  function closeSuggest() {
    box.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function highlight(i) {
    active = i;
    [...box.querySelectorAll('[role="option"]')].forEach((li, idx) => {
      li.setAttribute('aria-selected', String(idx === i));
      if (idx === i) {
        input.setAttribute('aria-activedescendant', li.id);
        li.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function renderSuggest(results, exact, q) {
    items = results;
    clear(box);
    if (!results.length) {
      box.append(h('li', { class: 'suggest-empty' }, `No place matches “${q}”. Try another spelling.`));
    } else {
      if (!exact) box.append(h('li', { class: 'suggest-head', 'aria-hidden': 'true' }, 'Did you mean…'));
      results.forEach((r, i) => {
        box.append(
          h(
            'li',
            {
              id: `sugg-${i}`,
              role: 'option',
              'aria-selected': 'false',
              class: `suggest-item type-${r.type}`,
              onMousedown: (ev) => {
                ev.preventDefault(); // keep focus; avoid blur closing first
                choose(r);
              },
            },
            h('span', { class: 'suggest-icon', 'aria-hidden': 'true' }, r.curated ? '✦' : ICON[r.type] || '•'),
            h('span', { class: 'suggest-text' }, h('strong', {}, r.name), h('small', {}, r.hint || r.state))
          )
        );
      });
    }
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = -1;
  }

  async function fetchSuggest(q) {
    const mine = ++seq;
    const data = await api(`/cities?${new URLSearchParams({ q })}`);
    if (mine !== seq) return null; // a newer keystroke won
    return data;
  }

  function choose(r) {
    closeSuggest();
    if (r.type === 'state') {
      input.value = '';
      selected = null;
      location.hash = `#/state/${r.code}`;
      return;
    }
    selected = { slug: r.slug, type: r.type, label: r.type === 'district' ? `${r.name} district, ${r.state}` : `${r.name}, ${r.state}` };
    input.value = selected.label;
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    selected = null;
    const q = input.value.trim();
    if (q.length < 2) return closeSuggest();
    timer = setTimeout(async () => {
      try {
        const data = await fetchSuggest(q);
        if (data) renderSuggest(data.cities, data.exact, q);
      } catch {
        /* suggestions are best-effort */
      }
    }, 150);
  });

  input.addEventListener('keydown', (e) => {
    if (box.hidden || !items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlight((active + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight((active - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === 'Escape') {
      closeSuggest();
    }
  });
  // Close on blur, unless focus came back (e.g. we re-opened "Did you mean…" after submit).
  input.addEventListener('blur', () =>
    setTimeout(() => {
      if (document.activeElement !== input) closeSuggest();
    }, 150)
  );
  input.addEventListener('focus', () => {
    if (items.length && !selected && input.value.trim().length >= 2) {
      box.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }
  });

  // Featured cards and other code can pre-select a destination.
  state.selectDestination = (slug, label) => {
    selected = { slug, type: 'city', label };
    input.value = label;
  };

  $('#plan-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = input.value.trim();
    if (!raw) {
      input.focus();
      return toast('Type a city, district or state first.', true);
    }
    let slug = selected && selected.label === raw ? selected.slug : null;
    if (!slug) {
      let data;
      try {
        data = await fetchSuggest(raw.split(',')[0]);
      } catch (err) {
        return toast(err.message, true);
      }
      if (!data) return;
      const top = data.cities[0];
      if (!top) {
        renderSuggest([], false, raw);
        return;
      }
      if (!data.exact) {
        // Never silently guess: show "Did you mean…" and let the user pick.
        renderSuggest(data.cities, false, raw);
        input.focus();
        return;
      }
      if (top.type === 'state') return choose(top);
      slug = top.slug;
    }
    const start = startInput.value && startInput.value >= startInput.min && startInput.value <= startInput.max ? startInput.value : today;
    const params = new URLSearchParams({
      destination: slug,
      days: String(Math.min(14, Math.max(1, Number(days.value) || 3))),
      travelers: travelers.value,
      budget: new FormData(e.target).get('budget') || 'comfort',
      start,
    });
    state.tripId = null; // a fresh search is not a saved trip
    location.hash = `#/plan?${params}`;
  });
}

// ---------------------------------------------------------------------------
// State overview: every district + major towns
// ---------------------------------------------------------------------------
let stateSeq = 0;
function planFromState(slug, label) {
  state.selectDestination(slug, label);
  location.hash = '#/';
  // Let the home view render, then plan with whatever days/travellers/style are set.
  setTimeout(() => $('#plan-form').requestSubmit(), 0);
}

async function loadState(code) {
  const mine = ++stateSeq;
  if (!/^[A-Za-z]{2}$/.test(code)) {
    location.hash = '#/';
    return;
  }
  $('#st-title').textContent = 'Loading…';
  $('#st-sub').textContent = '';
  $('#st-filter').value = '';
  $('#st-capital').hidden = true;
  loading(clear($('#st-districts')));
  clear($('#st-towns'));
  let st;
  try {
    st = await api(`/states/${encodeURIComponent(code)}`);
  } catch (err) {
    if (mine !== stateSeq) return;
    $('#st-title').textContent = 'State not found';
    clear($('#st-districts')).append(h('div', { class: 'empty glass' }, err.message));
    return;
  }
  if (mine !== stateSeq) return;
  $('#st-title').textContent = st.name;
  $('#st-sub').textContent = `${st.districts.length} districts · ${st.totalPlaces} cities & towns${st.capital ? ` · Capital: ${st.capital.name}` : ''}`;
  if (st.capital) {
    const cap = $('#st-capital');
    cap.hidden = false;
    cap.textContent = `Plan ${st.capital.name}`;
    cap.onclick = () => planFromState(st.capital.slug, `${st.capital.name}, ${st.name}`);
  }
  const grid = clear($('#st-districts'));
  for (const d of st.districts) {
    grid.append(
      h(
        'button',
        {
          type: 'button',
          class: 'district-card glass',
          dataset: { name: d.name.toLowerCase() },
          onClick: () => planFromState(d.slug, `${d.name}${d.hq && d.hq !== d.name ? ' district' : ''}, ${st.name}`),
        },
        h('strong', {}, d.name),
        h('small', {}, d.hq ? (d.hq === d.name ? 'District HQ' : `Around ${d.hq}`) : 'District')
      )
    );
  }
  clear($('#st-towns')).append(
    ...st.topCities.map((c) =>
      h('button', { type: 'button', class: 'chip state-chip', onClick: () => planFromState(c.slug, `${c.name}, ${st.name}`) }, c.name)
    )
  );
}

function initStateView() {
  $('#st-back').addEventListener('click', () => (location.hash = '#/'));
  $('#st-filter').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$('#st-districts .district-card').forEach((card) => (card.hidden = q !== '' && !card.dataset.name.includes(q)));
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
  for (const name of ['sights', 'food', 'stays', 'transport', 'photos', 'advice', 'night']) clear($(`[data-panel="${name}"]`));
  $('#btn-pdf').hidden = true;
  state.custom = null;
  state.editing = false;
  state.foodFilter = null;
  state.stayFilter = null;
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
  state.custom = loadCustom(plan);
  $('#btn-save').hidden = !state.accountsEnabled;
  $('#btn-save').textContent = state.tripId ? 'Update saved trip' : 'Save trip';
  $('#btn-pdf').hidden = false;
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
    params.start ? h('span', { class: 'chip' }, `${prettyDate(params.start)}${params.days > 1 ? ` – ${prettyDate(addDaysIso(params.start, params.days - 1))}` : ''}`) : null,
    h('span', { class: 'chip green' }, `Best time: ${d.bestTime}`)
  );
  $('#r-disclaimer').textContent = p.attribution ? `${p.disclaimer} ${p.attribution}.` : p.disclaimer;
  const banner = $('#r-banner');
  const status = d.liveStatus || 'ok';
  banner.hidden = status === 'ok';
  // Plain-English reason; the raw code stays in the tooltip for troubleshooting.
  const REASONS = {
    timeout: 'the free map service was too busy to answer in time',
    http_504: 'the free map service was too busy to answer in time',
    http_429: 'the free map service is limiting requests right now',
    http_503: 'the free map service is temporarily down',
    http_502: 'the free map service is temporarily down',
    http_500: 'the free map service had an internal error',
    network: 'we couldn’t reach the free map service',
  };
  const reasonText = d.liveIssue ? REASONS[d.liveIssue] || 'the free map service didn’t respond properly' : '';
  const reason = reasonText ? ` because ${reasonText}` : '';
  banner.title = d.liveIssue ? `Code: ${d.liveIssue}` : '';
  if (status === 'unavailable') {
    clear(banner).append(
      `Live places couldn’t be loaded${reason}, so this plan shows transport, fares and costs only. `,
      h('a', { href: p.searchLinks.sights }, 'Browse sights on Google Maps ↗'),
      ' or try again in a minute.'
    );
  } else if (status === 'partial') {
    const missing = (d.failedParts || []).map((x) => ({ sights: 'sights', food: 'restaurants & hotels', hubs: 'station details' })[x]).filter(Boolean);
    clear(banner).append(
      `Some live data (${missing.join(', ') || 'details'}) didn’t load${reason}. This isn’t a problem with your search — we’re showing everything we could get. `,
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
  renderPhotos(p);
  renderAdvice(p);
  renderNight(p);
}

/** Curated places show a rating; live OpenStreetMap places never get a made-up one. */
function ratingBadge(x) {
  if (typeof x.rating === 'number') return h('span', { class: 'rating' }, stars(x.rating));
  if (x.notable) return h('span', { class: 'rating' }, '✦ Notable');
  return null;
}

/** Like el.append(), but skips null/false (the DOM would print them as text). */
function put(el, ...items) {
  el.append(...items.flat().filter((x) => x !== null && x !== undefined && x !== false));
  return el;
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

function toStop(s) {
  return {
    name: s.name,
    area: s.area,
    lat: s.lat,
    lng: s.lng,
    slot: s.slot,
    hours: s.hours,
    fee: s.fee,
    blurb: s.blurb,
    mapsUrl: s.mapsUrl,
    category: s.category,
    durationHrs: s.durationHrs,
    rating: s.rating,
    notable: s.notable,
  };
}

const customKey = (p) => `voyagr:custom:${p.destination.slug}:${p.params.days}:${p.params.start}`;

/** Rebuilds full stop details for a saved custom plan (which stores only names/notes). */
function hydrateCustom(saved, p) {
  const byName = new Map(p.attractions.map((a) => [a.name, a]));
  return {
    days: p.itinerary.map((_, i) => {
      const d = saved.days?.[i] || { stops: [] };
      return {
        note: d.note || '',
        stops: (d.stops || []).map((st) => (byName.has(st.name) && !st.custom ? { ...toStop(byName.get(st.name)), note: st.note || '' } : { name: st.name, area: st.area || '', note: st.note || '', custom: true, lat: st.lat, lng: st.lng })),
      };
    }),
  };
}

function loadCustom(p) {
  try {
    const raw = localStorage.getItem(customKey(p));
    if (raw) return hydrateCustom(JSON.parse(raw), p);
  } catch {
    /* storage unavailable or corrupt — fall back to the suggested plan */
  }
  return null;
}

/** The shape stored on the server / in localStorage (matches the API schema). */
function serialiseCustom(custom) {
  const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  return {
    days: custom.days.map((d) => ({
      ...(d.note ? { note: clip(d.note, 300) } : {}),
      stops: d.stops.slice(0, 15).map((st) => ({
        name: clip(st.name, 90),
        ...(st.area ? { area: clip(st.area, 60) } : {}),
        ...(st.note ? { note: clip(st.note, 200) } : {}),
        ...(Number.isFinite(st.lat) && Number.isFinite(st.lng) ? { lat: st.lat, lng: st.lng } : {}),
        ...(st.custom ? { custom: true } : {}),
      })),
    })),
  };
}

function saveCustomLocal() {
  const p = state.plan;
  try {
    if (state.custom) localStorage.setItem(customKey(p), JSON.stringify(serialiseCustom(state.custom)));
    else localStorage.removeItem(customKey(p));
  } catch {
    /* private mode — edits still work for this visit */
  }
}

function currentDays(p) {
  return state.custom ? state.custom.days : p.itinerary.map((d) => ({ note: '', stops: d.stops.map(toStop) }));
}

function editCustom(mutator) {
  if (!state.custom) state.custom = { days: currentDays(state.plan).map((d) => ({ note: d.note, stops: d.stops.map((x) => ({ ...x })) })) };
  mutator(state.custom.days);
  saveCustomLocal();
  renderItinerary(state.plan);
}

function legBetween(a, b) {
  if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) return null;
  const km = Math.round(haversineKm(a, b) * 1.35 * 10) / 10;
  const mode = km <= 1.2 ? 'Walk' : km <= 8 ? 'Auto' : 'Cab';
  return `↳ ${km} km · ${mode}`;
}

function renderItinerary(p) {
  const panel = clear($('[data-panel="itinerary"]'));
  const days = currentDays(p);
  const used = new Set(days.flatMap((d) => d.stops.map((s) => s.name)));

  // Toolbar: customise / done / reset
  panel.append(
    h(
      'div',
      { class: 'edit-bar' },
      state.custom ? h('span', { class: 'chip gold' }, 'Customised') : h('span', { class: 'muted' }, 'Suggested plan — make it yours:'),
      h(
        'button',
        { type: 'button', class: `btn btn-sm ${state.editing ? 'btn-gold' : 'btn-ghost'}`, onClick: () => { state.editing = !state.editing; renderItinerary(p); } },
        state.editing ? 'Done editing' : 'Customise itinerary'
      ),
      state.custom
        ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => { if (confirm('Discard your changes and go back to the suggested plan?')) { state.custom = null; saveCustomLocal(); renderItinerary(p); } } }, 'Reset to suggested')
        : null
    )
  );

  days.forEach((day, i) => {
    const base = p.itinerary[i];
    const card = h(
      'article',
      { class: 'day glass' },
      h(
        'div',
        { class: 'day-head' },
        h('span', { class: 'day-num' }, `Day ${i + 1}`),
        h('span', { class: 'day-theme' }, base.date ? `${prettyDate(base.date)} · ${base.theme}` : base.theme)
      ),
      base.sun ? h('div', { class: 'sun-line' }, `☀ Sunrise ${base.sun.sunrise} · Sunset ${base.sun.sunset} · 📸 Golden hour ${base.sun.goldenEvening}`) : null
    );

    if (state.editing) {
      card.append(
        h('textarea', {
          class: 'day-note',
          maxlength: 300,
          rows: 2,
          placeholder: 'Notes for this day (bookings, reminders…)',
          'aria-label': `Notes for day ${i + 1}`,
          onChange: (ev) => editCustom((ds) => { ds[i].note = ev.target.value.slice(0, 300); }),
        })
      );
      card.lastChild.value = day.note || '';
    } else if (day.note) {
      card.append(h('p', { class: 'day-user-note' }, `📝 ${day.note}`));
    }

    if (day.stops.length) {
      card.append(
        h(
          'ol',
          { class: 'timeline' },
          day.stops.map((s, j) => {
            const serverLeg = !state.custom ? s && base.stops[j]?.legFromPrevious : null;
            const legText = serverLeg
              ? `↳ ${serverLeg.km} km · ${serverLeg.mode} · ~${serverLeg.minutes} min` + (serverLeg.fare ? ` · from ${money(serverLeg.fare)}${serverLeg.app ? ` (${serverLeg.app})` : ''}` : '')
              : j > 0
                ? legBetween(day.stops[j - 1], s)
                : null;
            return h(
              'li',
              {},
              legText ? h('div', { class: 'leg' }, legText) : null,
              h('div', { class: 'stop-title' }, s.slot ? h('span', { class: 'slot' }, SLOT_LABEL[s.slot] || 'Anytime') : h('span', { class: 'slot' }, s.custom ? 'Your stop' : 'Anytime'), h('strong', {}, s.name), ratingBadge(s)),
              s.blurb ? h('p', { class: 'stop-blurb' }, s.blurb) : null,
              s.note ? h('p', { class: 'day-user-note' }, `📝 ${s.note}`) : null,
              s.custom
                ? null
                : h('div', { class: 'stop-meta' }, s.hours ? h('span', {}, `🕘 ${s.hours}`) : null, s.fee ? h('span', {}, `🎟 ${s.fee}`) : null, s.durationHrs ? h('span', {}, `⏱ ~${s.durationHrs} h`) : null, s.mapsUrl ? mapLink(s.mapsUrl) : null),
              state.editing ? stopControls(days, i, j) : null
            );
          })
        )
      );
    } else if (base.note && !state.custom) {
      card.append(h('p', { class: 'stop-blurb' }, base.note));
    } else if (state.editing) {
      card.append(h('p', { class: 'muted' }, 'No stops yet — add one below.'));
    }

    if (state.editing) card.append(addStopControls(p, days, i, used));

    const meal = (label, r) =>
      h(
        'div',
        { class: 'meal' },
        h('div', { class: 'k' }, label),
        r
          ? [
              h('strong', {}, r.name),
              h('div', { class: 'muted' }, [r.cuisine, r.area, r.costForTwo ? `${money(r.costForTwo)} for two` : null].filter(Boolean).join(' · ')),
              h(
                'div',
                { class: r.openAtMeal === true ? 'open-ok' : 'open-unknown' },
                r.openAtMeal === true ? `✓ Open then · ${r.hoursThatDay}` : 'Hours not listed — check before you go'
              ),
            ]
          : h('span', { class: 'muted' }, 'Explore local eateries nearby')
      );
    card.append(h('div', { class: 'meals' }, meal('Lunch · ~1 pm', base.meals.lunch), meal('Dinner · ~8 pm', base.meals.dinner)));
    panel.append(card);
  });
}

function stopControls(days, i, j) {
  const move = (fn) => editCustom(fn);
  const daySelect = h(
    'select',
    {
      'aria-label': 'Move to another day',
      onChange: (ev) => {
        const to = Number(ev.target.value);
        if (Number.isInteger(to) && to !== i) move((ds) => ds[to].stops.push(ds[i].stops.splice(j, 1)[0]));
      },
    },
    days.map((_, k) => h('option', { value: k, ...(k === i ? { selected: 'selected' } : {}) }, k === i ? `Day ${k + 1}` : `Move to day ${k + 1}`))
  );
  return h(
    'div',
    { class: 'stop-controls' },
    h('button', { type: 'button', class: 'icon-mini', 'aria-label': 'Move up', disabled: j === 0, onClick: () => move((ds) => ds[i].stops.splice(j - 1, 0, ds[i].stops.splice(j, 1)[0])) }, '↑'),
    h('button', { type: 'button', class: 'icon-mini', 'aria-label': 'Move down', disabled: j === days[i].stops.length - 1, onClick: () => move((ds) => ds[i].stops.splice(j + 1, 0, ds[i].stops.splice(j, 1)[0])) }, '↓'),
    days.length > 1 ? daySelect : null,
    h('button', { type: 'button', class: 'icon-mini danger', 'aria-label': 'Remove stop', onClick: () => move((ds) => ds[i].stops.splice(j, 1)) }, '✕')
  );
}

function addStopControls(p, days, i, used) {
  const available = p.attractions.filter((a) => !used.has(a.name));
  const pick = h('select', { 'aria-label': 'Add a sight' }, h('option', { value: '' }, available.length ? 'Add a sight…' : 'All sights are in your plan'), available.map((a) => h('option', { value: a.name }, `${a.name} · ${a.category}`)));
  const own = h('input', { maxlength: 90, placeholder: 'Or add your own stop (e.g. Shopping at T. Nagar)', 'aria-label': 'Add your own stop' });
  const note = h('input', { maxlength: 200, placeholder: 'Note (optional)', 'aria-label': 'Note for the new stop' });
  return h(
    'div',
    { class: 'add-stop' },
    pick,
    h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => {
      const a = available.find((x) => x.name === pick.value);
      if (!a) return toast('Choose a sight to add.', true);
      if (days[i].stops.length >= 15) return toast('A day can have up to 15 stops.', true);
      editCustom((ds) => ds[i].stops.push({ ...toStop(a), note: note.value.trim().slice(0, 200) }));
    } }, 'Add sight'),
    own,
    note,
    h('button', { type: 'button', class: 'btn btn-sm btn-gold', onClick: () => {
      const name = own.value.trim().slice(0, 90);
      if (name.length < 1) return toast('Type a name for your stop.', true);
      if (days[i].stops.length >= 15) return toast('A day can have up to 15 stops.', true);
      editCustom((ds) => ds[i].stops.push({ name, area: '', note: note.value.trim().slice(0, 200), custom: true }));
    } }, 'Add my stop')
  );
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

function filterChips(current, onPick, counts) {
  const opts = [['all', 'All'], ['budget', 'Affordable'], ['comfort', 'Comfort'], ['premium', 'Premium']];
  return h(
    'div',
    { class: 'filter-chips', role: 'group', 'aria-label': 'Filter by price style' },
    opts.map(([v, label]) =>
      h('button', { type: 'button', class: `chip state-chip ${current === v ? 'gold' : ''}`, 'aria-pressed': String(current === v), onClick: () => onPick(v) }, `${label}${counts?.[v] !== undefined ? ` (${counts[v]})` : ''}`)
    )
  );
}

function renderFood(p) {
  const panel = clear($('[data-panel="food"]'));
  if (!p.restaurants.length) {
    put(panel, emptyWithLink('No restaurants found in map data near the centre.', p.searchLinks.restaurants, 'Find restaurants on Google Maps ↗'));
    return;
  }
  const counts = { all: p.restaurants.length, budget: 0, comfort: 0, premium: 0 };
  for (const r of p.restaurants) if (r.tier) counts[r.tier]++;
  const anyTier = counts.budget + counts.comfort + counts.premium > 0;
  const filter = state.foodFilter ?? (anyTier && counts[p.params.budget] ? p.params.budget : 'all');
  const shown = filter === 'all' ? p.restaurants : p.restaurants.filter((r) => r.tier === filter);
  const unknown = p.restaurants.filter((r) => !r.tier).length;

  put(panel, 
    filterChips(filter, (v) => { state.foodFilter = v; renderFood(p); }, counts),
    filter !== 'all' && unknown ? h('p', { class: 'muted' }, `${unknown} more place${unknown > 1 ? 's' : ''} don’t list a price level — see “All”.`) : null,
    !anyTier ? h('p', { class: 'muted' }, 'Price levels aren’t available for these live listings, so all places are shown.') : null,
    p.restaurantSource === 'openstreetmap' ? h('p', { class: 'muted' }, 'Opening hours come from OpenStreetMap where listed — always confirm before visiting.') : null,
    shown.length
      ? h('div', { class: 'card-grid' }, shown.map(restaurantCard))
      : h('div', { class: 'empty glass' }, 'No restaurants in this price style here — try “All”.')
  );
}

/** wa.me chat with a ready-to-send booking request (party size + first trip date). */
function whatsappLink(r) {
  const num = r.reserve?.whatsapp;
  if (!num || !/^\d{10,15}$/.test(num)) return null;
  const p = state.plan;
  const people = p?.params.travelers ?? 2;
  const when = p?.params.start ? prettyDate(p.params.start) : 'today';
  const text = `Hello ${r.name}, I'd like to book a table for ${people} ${people === 1 ? 'person' : 'people'} on ${when}. Is it available?`;
  return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
}

function restaurantCard(r) {
  const tel = r.reserve?.call;
  const wa = whatsappLink(r);
  return h(
    'article',
    { class: `card glass ${r.status ? 'is-closed' : ''}` },
    h('div', { class: 'row' }, h('span', { class: `chip ${r.tier === 'premium' ? 'gold' : ''}` }, TIER_LABEL[r.tier] || r.cuisine), ratingBadge(r)),
    h('h3', {}, r.name),
    r.status === 'temporarily_closed' ? h('p', { class: 'closed-flag' }, '⚠ Temporarily closed (e.g. renovation) — not used in your plan') : null,
    h('p', {}, [r.cuisine, r.area].filter(Boolean).join(' · ')),
    r.mustTry ? h('p', {}, `Must try: ${r.mustTry}`) : null,
    h('p', { class: 'hours-line' }, `🕘 ${r.hoursText || 'Hours not listed — check on Maps'}`),
    r.closedOnTripDays?.length ? h('p', { class: 'closed-days' }, `Closed on ${r.closedOnTripDays.join(', ')} of your trip`) : null,
    r.costForTwo
      ? h('div', { class: 'row' }, h('span', { class: 'price' }, money(r.costForTwo)), h('span', { class: 'muted' }, 'approx. for two'))
      : null,
    typeof r.rating === 'number' && r.ratingCount ? h('p', { class: 'muted' }, `${r.ratingCount.toLocaleString('en-IN')} Google reviews`) : null,
    r.status
      ? null
      : h(
          'div',
          { class: 'book-row' },
          h('span', { class: 'book-label' }, 'Book a table'),
          wa ? h('a', { href: wa, class: 'btn btn-sm btn-whatsapp' }, 'WhatsApp to book') : null,
          tel ? h('a', { href: tel, class: 'btn btn-sm btn-ghost' }, 'Call to book') : null,
          !wa && !tel ? h('span', { class: 'muted' }, 'No phone or WhatsApp listed') : null
        ),
    h('div', { class: 'links' }, h('a', { href: r.googleMapsUri || r.mapsUrl }, 'Open in Maps ↗'))
  );
}

function renderStays(p) {
  const panel = clear($('[data-panel="stays"]'));
  const groups = { budget: p.stays.affordable, comfort: p.stays.comfort, premium: p.stays.premium };
  const counts = { all: groups.budget.length + groups.comfort.length + groups.premium.length, budget: groups.budget.length, comfort: groups.comfort.length, premium: groups.premium.length };
  const filter = state.stayFilter ?? (counts[p.params.budget] ? p.params.budget : 'all');
  const tier = (key, title, badge) => {
    const items = groups[key];
    if (!items.length || (filter !== 'all' && filter !== key)) return null;
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
  put(panel, 
    filterChips(filter, (v) => { state.stayFilter = v; renderStays(p); }, counts),
    ...[tier('budget', 'Affordable', ''), tier('comfort', 'Comfort', ''), tier('premium', 'Premium & luxury', 'gold')].flat().filter(Boolean),
    h('p', { class: 'disclaimer' }, h('a', { href: p.stays.bookingSearchUrl }, `Check live availability for ${p.destination.name} ↗`))
  );
  if (!panel.querySelector('.card')) {
    panel.insertBefore(
      counts.all ? h('div', { class: 'empty glass' }, 'No stays in this price style here — try “All”.') : emptyWithLink('No hotels found in map data for this place yet.', p.searchLinks.stays, 'Find hotels on Google Maps ↗'),
      panel.children[1] || null
    );
  }
}

function renderPhotos(p) {
  const panel = clear($('[data-panel="photos"]'));
  const golden = p.itinerary.filter((d) => d.sun);
  if (golden.length) {
    put(panel, 
      h(
        'section',
        { class: 'list-card glass' },
        h('h3', {}, '📸 Golden hour on your trip'),
        h('p', { class: 'muted' }, 'The soft, warm light just after sunrise and before sunset is best for photos.'),
        h('ul', {}, golden.map((d) => h('li', {}, h('div', { class: 'row' }, h('strong', {}, `Day ${d.day} · ${prettyDate(d.date)}`), h('span', { class: 'rating' }, `${d.sun.goldenMorning}  ·  ${d.sun.goldenEvening}`)))))
      )
    );
  }
  if (!p.photoSpots.length) {
    put(panel, emptyWithLink('No photo spots found for this place yet.', p.searchLinks.sights, 'Browse sights on Google Maps ↗'));
    return;
  }
  put(panel, 
    h(
      'div',
      { class: 'card-grid section-gap' },
      p.photoSpots.map((s) =>
        h('article', { class: 'card glass' }, h('div', { class: 'row' }, h('span', { class: 'chip' }, s.category)), h('h3', {}, s.name), h('p', {}, s.tip), h('div', { class: 'links' }, mapLink(s.mapsUrl)))
      )
    )
  );
}

function renderAdvice(p) {
  const panel = clear($('[data-panel="advice"]'));
  const a = p.advice;
  if (!a) return;
  const list = (title, items, cls = '') => (items.length ? h('section', { class: `list-card glass ${cls}` }, h('h3', {}, title), h('ul', {}, items.map((x) => h('li', {}, x)))) : null);
  put(panel, 
    h(
      'section',
      { class: 'list-card glass' },
      h('h3', {}, a.source === 'forecast' ? '🌦 Weather forecast' : '🌦 What to expect'),
      h('p', {}, a.summary),
      a.forecast.length
        ? h(
            'div',
            { class: 'forecast-row' },
            a.forecast.map((f) =>
              h('div', { class: 'forecast-day' }, h('strong', {}, prettyDate(f.date)), h('span', {}, `${Math.round(f.min)}–${Math.round(f.max)}°C`), h('small', { class: 'muted' }, f.rainChance !== null ? `☔ ${f.rainChance}%` : ''))
            )
          )
        : null,
      a.elevation !== null && a.elevation !== undefined ? h('p', { class: 'muted' }, `Altitude about ${Math.round(a.elevation)} m.`) : null
    ),
    a.alerts.length ? list('⚠ Important', a.alerts, 'alert-card') : null,
    h('section', { class: 'list-card glass' }, h('h3', {}, '🎒 Pack'), h('ul', { class: 'pack-grid' }, a.pack.map((x) => h('li', {}, h('span', { 'aria-hidden': 'true' }, x.icon), ` ${x.text}`)))),
    h('div', { class: 'split' }, list('✅ Do', a.dos), list('🚫 Don’t', a.donts)),
    h(
      'section',
      { class: 'list-card glass' },
      h('h3', {}, '🆘 Emergency numbers'),
      h('ul', {}, a.emergency.map((x) => h('li', {}, h('div', { class: 'row' }, h('span', {}, x.label), h('a', { href: `tel:${x.number}` }, x.number)))))
    )
  );
}

function renderNight(p) {
  const panel = clear($('[data-panel="night"]'));
  if (p.events.dryState) {
    put(panel, h('p', { class: 'banner glass' }, `${p.destination.region} has prohibition laws — bars and alcohol are banned or tightly restricted here.`));
  }
  put(panel, 
    h(
      'section',
      { class: 'list-card glass' },
      h('h3', {}, '🎉 Events & parties on your dates'),
      h('p', { class: 'muted' }, 'No ticketing platform in India offers a public events feed, so these open live listings for your dates.'),
      h('ul', {}, p.events.links.map((l) => h('li', {}, h('a', { href: l.url }, `${l.label} ↗`))))
    )
  );
  if (p.nightlife.length) {
    put(panel, 
      h('h3', { class: 'subtitle' }, 'Bars, pubs & clubs nearby'),
      h(
        'div',
        { class: 'card-grid' },
        p.nightlife.map((n) =>
          h('article', { class: 'card glass' }, h('div', { class: 'row' }, h('span', { class: 'chip' }, n.kind), h('span', { class: 'muted' }, `${n.km} km from centre`)), h('h3', {}, n.name), h('p', { class: 'hours-line' }, `🕘 ${n.hoursText || 'Hours not listed'}`), h('div', { class: 'links' }, mapLink(n.mapsUrl)))
        )
      )
    );
  } else if (!p.events.dryState) {
    put(panel, emptyWithLink('No bars or clubs found in map data near the centre.', p.events.links[p.events.links.length - 1].url, 'Search nightlife on Google Maps ↗'));
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
              ? h('div', {}, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { state.tripId = null; location.hash = `#/plan?${new URLSearchParams({ destination: t.slug, days: '2', travelers: String(p.params.travelers), budget: p.params.budget, ...(p.params.start ? { start: p.params.start } : {}) })}`; } }, `Plan ${t.name} →`))
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
      // Past start dates can't be re-planned, so old trips reopen from today.
      if (t.start && t.start >= isoToday()) params.set('start', t.start);
      listEl.append(
        h(
          'article',
          { class: 'trip glass' },
          h('div', {}, h('h3', {}, t.title), h('span', { class: 'muted' }, `${state.destinations.find((d) => d.slug === t.destination)?.name ?? t.destination} · ${t.days} days · ${t.travelers} travellers · ${TIER_LABEL[t.budget]} · saved ${new Date(t.created_at).toLocaleDateString()}`)),
          h(
            'div',
            { class: 'actions' },
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-ghost btn-sm',
                onClick: () => {
                  // Hand the saved customisations to the plan view, then open it as this trip.
                  if (t.custom && params.get('start')) {
                    try {
                      localStorage.setItem(`voyagr:custom:${t.destination}:${t.days}:${params.get('start')}`, JSON.stringify(t.custom));
                    } catch {
                      /* storage unavailable */
                    }
                  }
                  state.tripId = t.id;
                  location.hash = `#/plan?${params}`;
                },
              },
              'Open'
            ),
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
  $('#btn-save').addEventListener('click', async () => {
    if (!state.user) return openAuth('login');
    if (!state.plan) return;
    if (state.tripId) {
      // An opened saved trip: just store the current customisations.
      try {
        await api(`/trips/${encodeURIComponent(state.tripId)}`, { method: 'PUT', body: { custom: state.custom ? serialiseCustom(state.custom) : null } });
        toast('Saved trip updated.');
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    $('#s-title').value = `${state.plan.destination.name} getaway`;
    $('#save-error').textContent = '';
    dialog.showModal();
  });
  $('#save-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { params, destination } = state.plan;
    try {
      const body = { title: $('#s-title').value, destination: destination.slug, days: params.days, travelers: params.travelers, budget: params.budget };
      if (params.start) body.start = params.start;
      if (state.custom) body.custom = serialiseCustom(state.custom);
      const { trip } = await api('/trips', { method: 'POST', body });
      state.tripId = trip.id;
      $('#btn-save').textContent = 'Update saved trip';
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
  initStateView();
  initAuth();
  initSave();
  $$('.tabs [role="tab"]').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
  $('#btn-back').addEventListener('click', () => (location.hash = '#/'));
  $('#ride-go').addEventListener('click', compareRide);
  $('#btn-pdf').addEventListener('click', () => {
    if (!state.plan) return;
    printPlan(state.plan, currentDays(state.plan));
  });
  initPhotoFinder({ api, toast, planPlace: (slug, label) => planFromState(slug, label) });

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
