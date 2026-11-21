/* global maplibregl, deck */
// Zurich 3D: public transport animated over a 3D map, with real-time delays.
import { MODELS, MESHES, modelFor, sectionsFor, liveryTexture } from './vehicles.js';
import { lights, initBuildings, buildingsLayer } from './buildings.js';
import { track } from './track.js';
import { sunPosition, nightOf, litShare, skyFor, describe, ICONS, weatherAt, Precipitation, precipIntensity } from './atmosphere.js';

const START_VIEW = { center: [8.5402, 47.3779], zoom: 14.6, pitch: 62, bearing: -28 };
const STYLES = {
  day: 'https://tiles.openfreemap.org/styles/liberty',
  night: 'https://tiles.openfreemap.org/styles/dark',
};
const SWISSIMAGE = 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg';
const CATS = {
  tram: { label: 'Trams', one: 'Tram', color: '#3d8bfd' },
  bus: { label: 'Buses', one: 'Bus', color: '#3ccf7a' },
  rail: { label: 'Trains', one: 'Train', color: '#ff5a5f' },
  ship: { label: 'Boats', one: 'Boat', color: '#2ec4d6' },
  funicular: { label: 'Funiculars', one: 'Funicular', color: '#b48cff' },
};
const QUALITY = {
  low: { ratio: () => 1, interval: 66 },
  std: { ratio: () => Math.min(window.devicePixelRatio || 1, 1.25), interval: 33 },
  high: { ratio: () => Math.min(window.devicePixelRatio || 1, 2), interval: 16 },
};
const OWN_LAYERS = new Set(['network', 'stops-dot', 'stops-label', 'sat', 'fade', 'street-glow', 'street-lamps']);

// Night palette for OpenFreeMap's "dark" style: near-black city, deep blue water, sodium-lit streets.
const NIGHT_PAINT = {
  background: { 'background-color': '#06080c' },
  water: { 'fill-color': '#08121d' },
  waterway: { 'line-color': '#08121d' },
  landuse_residential: { 'fill-color': '#0a0b0e', 'fill-opacity': 0.6 },
  landuse_park: { 'fill-color': '#0a100c' },
  landcover_wood: { 'fill-color': '#0a100c' },
  building: { 'fill-color': '#0c0e12', 'fill-outline-color': '#14171c' },
  highway_path: { 'line-color': '#1a1712' },
  highway_minor: { 'line-color': '#221d15' },
  highway_major_casing: { 'line-color': 'rgba(120,88,40,0.35)' },
  highway_major_inner: { 'line-color': '#2e2516' },
  highway_major_subtle: { 'line-color': '#2e2516' },
  highway_motorway_casing: { 'line-color': 'rgba(140,100,45,0.4)' },
  highway_motorway_inner: { 'line-color': '#3a2d18' },
  railway: { 'line-color': '#1c1e23' }, railway_transit: { 'line-color': '#1c1e23' }, railway_minor: { 'line-color': '#1c1e23' },
  highway_name_other: { 'text-color': '#6e6656' },
  highway_name_motorway: { 'text-color': '#6e6656' },
  water_name: { 'text-color': '#3d5a78', 'text-halo-color': '#06080c' },
};
for (const id of ['place_other', 'place_suburb', 'place_village', 'place_town', 'place_city', 'place_city_large']) {
  NIGHT_PAINT[id] = { 'text-color': '#9aa3b2', 'text-halo-color': 'rgba(0,0,0,0.85)' };
}
const LIT_ROADS = ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']]];

// Local metric projection (good to a few cm over the city)
const LAT0 = 47.37;
const MX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const MY = 110540;

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mod = (s, n) => ((s % n) + n) % n;
const fmtTime = (s) => {
  s = mod(Math.floor(s), 86400);
  return [s / 3600, (s % 3600) / 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':');
};
const fmtHM = (s) => fmtTime(s).slice(0, 5);
const fmtNum = (n) => n.toLocaleString('de-CH');
const shortName = (n) => n.replace(/^Zürich,\s*/, '');
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const zurichFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function zurichNow() {
  const now = new Date();
  const p = Object.fromEntries(zurichFmt.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}${p.month}${p.day}`, sec: +p.hour * 3600 + +p.minute * 60 + +p.second + now.getMilliseconds() / 1000 };
}
const ymdDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
const addDays = (ymd, n) => {
  const d = ymdDate(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
};
const prettyDate = (ymd) => ymdDate(ymd).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const periodOf = (s) => {
  const h = mod(s, 86400) / 3600;
  return h < 5 ? 'NIGHT' : h < 12 ? 'MORNING' : h < 18 ? 'AFTERNOON' : h < 22 ? 'EVENING' : 'NIGHT';
};

/** Approximate sunrise/sunset for Zurich in local seconds after midnight (NOAA formulas). */
function sunTimes(ymd) {
  const d = ymdDate(ymd);
  const doy = Math.round((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
  const g = ((2 * Math.PI) / 365) * (doy - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const lat = (47.37 * Math.PI) / 180, lon = 8.54;
  const ha = (Math.acos(Math.cos((90.833 * Math.PI) / 180) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl)) * 180) / Math.PI;
  const noonUtc = new Date(d.getTime() + 12 * 3600e3);
  const localHour = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', hourCycle: 'h23' }).format(noonUtc);
  const offsetMin = (localHour - 12) * 60;
  return { rise: (720 - 4 * (lon + ha) - eq + offsetMin) * 60, set: (720 - 4 * (lon - ha) - eq + offsetMin) * 60 };
}

// ---------------------------------------------------------------- state
const defaults = {
  quality: 'std', basemap: 'default', opacity: 100, cycle: true, theme: 'day', buildingOpacity: 85,
  show: { network: true, stops: true, labels: true, delays: true, trails: false, buildings: true, pt: true, weather: true },
  hidden: [], panelOpen: window.innerWidth > 760, // on phones the map comes first
};
const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('z3d.settings') || '{}');
    return { ...defaults, ...s, show: { ...defaults.show, ...(s.show || {}) } };
  } catch { return structuredClone(defaults); }
}
const settings = loadSettings();
function saveSettings() {
  settings.hidden = [...state.hidden];
  try { localStorage.setItem('z3d.settings', JSON.stringify(settings)); } catch { /* private mode */ }
}

const state = {
  routes: [], stops: [], segs: [], trips: [], maxDur: 0,
  days: [], date: null, t: 0, speed: 1, playing: true, live: true,
  hidden: new Set(settings.hidden), selected: -1, follow: false,
  theme: settings.theme, active: [], counts: {}, dirty: true,
  alerts: { delay: [], cancel: [] }, alertFilter: 'all', alertsOpen: window.innerWidth > 1100,
};

// ---------------------------------------------------------------- data
function decodeSegment(flat) {
  const n = flat.length / 2;
  const xs = new Float64Array(n), ys = new Float64Array(n), cum = new Float64Array(n);
  let lon = 0, lat = 0;
  for (let i = 0; i < n; i++) {
    lon += flat[2 * i]; lat += flat[2 * i + 1];
    xs[i] = (lon / 1e5) * MX; ys[i] = (lat / 1e5) * MY;
    if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  return { xs, ys, cum, len: cum[n - 1] || 0 };
}

async function loadJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

function applyNetwork(net) {
  state.generated = net.generated;
  state.routes = net.routes.map((r) => ({ ...r, rgb: hexToRgb(r.col) }));
  state.stops = net.stops;
  state.segs = net.segments.map(decodeSegment);
}

async function loadDay(date) {
  const loadingText = $('loading-text');
  if (loadingText) loadingText.textContent = `Loading timetable for ${prettyDate(date)}…`;
  const tt = await loadJson(`data/timetable-${date}.json`);
  // The server rebuilds the data nightly. Stop/segment indices in a timetable only fit the network.json
  // of the same build, so a page that stays open across a rebuild loads the new network with it.
  if (!state.segs.length || (tt.generated && tt.generated !== state.generated)) {
    const net = await loadJson('data/network.json');
    if (tt.generated && net.generated !== tt.generated) throw new Error('data is being rebuilt');
    applyNetwork(net);
  }
  let maxDur = 0;
  const prevDate = addDays(date, -1);
  state.trips = tt.trips.map(([r, h, n, s, g, d, id, prev, seq]) => {
    const sched = new Float64Array(d.length);
    let acc = 0;
    for (let i = 0; i < d.length; i++) sched[i] = acc += d[i];
    const route = state.routes[r];
    const model = modelFor(route, id || `${r}-${n}-${d[0]}`);
    maxDur = Math.max(maxDur, sched[sched.length - 1] - sched[0]);
    return {
      r, h, n, s, g, cat: route.c, model,
      seqs: Array.isArray(seq) ? seq : s.map((_, k) => (seq ?? 1) + k),
      rtKey: id ? `${id}|${prev ? prevDate : date}` : null,
      sched, times: sched, sStart: sched[0], start: sched[0], end: sched[sched.length - 1],
      rt: null, // null = scheduled only, 'live' = real-time delays applied, 'cancel'
    };
  });
  state.maxDur = maxDur;
  state.date = date;
  state.selected = -1;
  state.follow = false;
  showInfo(false);
  applyRealtime();
  renderStats();
  renderModes();
}

// ---------------------------------------------------------------- real-time delays
const rt = { status: 'off', trips: {}, fetchedAt: 0, error: null };

async function pollRealtime() {
  try {
    const r = await fetch('api/realtime', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    rt.status = j.enabled ? j.status : 'no-key';
    rt.error = j.error;
    if (j.fetchedAt !== rt.fetchedAt) {
      rt.trips = j.trips || {};
      rt.fetchedAt = j.fetchedAt;
      applyRealtime();
      computeAlerts();
    }
  } catch {
    rt.status = 'unreachable';
  }
  renderRealtimeStatus();
}

/** Shift each trip's stop times by its reported delays (GTFS-RT semantics: a delay carries forward). */
function applyRealtime() {
  for (const tr of state.trips) {
    const upd = tr.rtKey && rt.trips[tr.rtKey];
    if (!upd) { tr.times = tr.sched; tr.rt = null; tr.skipped = null; }
    else if (upd.c) { tr.times = tr.sched; tr.rt = 'cancel'; }
    else {
      const u = upd.u, T = new Float64Array(tr.sched.length), S = tr.sched;
      const skipped = new Set();
      let j = -1;
      for (let k = 0; k < tr.s.length; k++) {
        const seq = tr.seqs[k];
        while (j + 1 < u.length && u[j + 1][0] <= seq) j++;
        let a, d;
        if (j >= 0 && u[j][0] === seq) { a = u[j][1]; d = u[j][2]; if (u[j][3]) skipped.add(k); }
        else if (j >= 0) a = d = u[j][2]; // propagate the last departure delay
        else a = d = u[0][1];             // before the first update: assume the first known delay
        // never let the reported arrival make the hop shorter than 60% of the scheduled travel time
        T[2 * k] = k ? Math.max(S[2 * k] + a, T[2 * k - 1] + 0.6 * (S[2 * k] - S[2 * k - 1])) : S[0] + a;
        T[2 * k + 1] = Math.max(S[2 * k + 1] + d, T[2 * k]);
      }
      tr.times = T; tr.rt = 'live'; tr.skipped = skipped;
    }
    tr.start = tr.times[0];
    tr.end = tr.times[tr.times.length - 1];
  }
  state.dirty = true;
}

/** Current delay (seconds) of a trip at time t, or null when there is no real-time data. */
function delayAt(tr, t) {
  if (tr.rt !== 'live') return null;
  const loc = locate(tr, t);
  const k = loc ? loc.next : tr.s.length - 1;
  return tr.times[2 * k] - tr.sched[2 * k];
}

// ---------------------------------------------------------------- simulation
const ease = (f) => f - Math.sin(2 * Math.PI * f) / (2 * Math.PI); // accelerate, cruise, brake

/** Where is trip `tr` at time t? {k, d} = segment index and distance along it. */
function locate(tr, t) {
  const T = tr.times, nStops = tr.s.length;
  for (let k = 0; k < nStops; k++) {
    const arr = T[2 * k], dep = T[2 * k + 1];
    if (t < arr) {
      if (k === 0) return null;
      const seg = state.segs[tr.g[k - 1]];
      const prevDep = T[2 * k - 1];
      const f = arr > prevDep ? (t - prevDep) / (arr - prevDep) : 1;
      return { k: k - 1, d: ease(Math.min(1, Math.max(0, f))) * seg.len, next: k, atStop: false };
    }
    if (t <= dep) {
      if (k < nStops - 1) return { k, d: 0, next: k, atStop: true };
      return { k: k - 1, d: state.segs[tr.g[k - 1]].len, next: k, atStop: true };
    }
  }
  return null;
}

function pointAt(seg, d) {
  const { xs, ys, cum } = seg;
  const n = xs.length;
  if (d <= 0) return [xs[0], ys[0], 0];
  if (d >= seg.len) return [xs[n - 1], ys[n - 1], n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
  const f = (d - cum[lo]) / (cum[hi] - cum[lo] || 1);
  return [xs[lo] + (xs[hi] - xs[lo]) * f, ys[lo] + (ys[hi] - ys[lo]) * f, lo];
}

/** Lon/lat of a trip's head at time t (or its first stop if not running). */
function tripPosition(tr, t) {
  const loc = locate(tr, t);
  if (!loc) return state.stops[tr.s[0]].slice(0, 2);
  const [x, y] = pointAt(state.segs[tr.g[loc.k]], loc.d);
  return [x / MX, y / MY];
}

/** Points (local metres) at the given ascending distances behind the head (k, d), following the track. */
function pointsBehind(tr, k, d, offsets) {
  const out = new Array(offsets.length);
  let seg = state.segs[tr.g[k]];
  const [hx, hy, hi] = pointAt(seg, d);
  let px = hx, py = hy, walked = 0, j = 0, i = hi, segK = k;
  let dirx = 0, diry = 0;
  while (j < offsets.length) {
    if (i < 0) {
      segK--;
      if (segK < 0) break;
      seg = state.segs[tr.g[segK]];
      i = seg.xs.length - 1;
      continue;
    }
    const vx = seg.xs[i], vy = seg.ys[i];
    const dd = Math.hypot(px - vx, py - vy);
    while (j < offsets.length && offsets[j] <= walked + dd) {
      const f = dd > 0 ? (offsets[j] - walked) / dd : 0;
      out[j++] = [px + (vx - px) * f, py + (vy - py) * f];
    }
    if (dd > 0.01) { dirx = (vx - px) / dd; diry = (vy - py) / dd; }
    walked += dd; px = vx; py = vy; i--;
  }
  if (j < offsets.length) {
    // ran out of track: continue straight in the last direction (or along the first segment)
    if (!dirx && !diry) {
      const s0 = state.segs[tr.g[0]];
      const n = s0.xs.length;
      const L = Math.hypot(s0.xs[n - 1] - s0.xs[0], s0.ys[n - 1] - s0.ys[0]) || 1;
      dirx = (s0.xs[0] - s0.xs[n - 1]) / L; diry = (s0.ys[0] - s0.ys[n - 1]) / L;
    }
    for (; j < offsets.length; j++) out[j] = [px + dirx * (offsets[j] - walked), py + diry * (offsets[j] - walked)];
  }
  return out;
}

function firstActiveIndex(t) {
  // trips are sorted by scheduled start; allow up to an hour of delay
  const from = t - state.maxDur - 3600;
  let lo = 0, hi = state.trips.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (state.trips[m].sStart < from) lo = m + 1; else hi = m; }
  return lo;
}

/** Visible area in local metres, padded so vehicles don't pop in at the edges. */
function viewRect() {
  const b = map.getBounds();
  const pad = 300;
  return [b.getWest() * MX - pad, b.getSouth() * MY - pad, b.getEast() * MX + pad, b.getNorth() * MY + pad];
}

function computeVehicles(t) {
  const out = [];
  const counts = Object.fromEntries(Object.keys(CATS).map((c) => [c, 0]));
  const trips = state.trips;
  const [x0, y0, x1, y1] = viewRect();
  const showAny = settings.show.pt;
  for (let i = firstActiveIndex(t); i < trips.length; i++) {
    const tr = trips[i];
    if (tr.sStart > t + 900) break; // nothing runs more than 15 min early
    if (tr.start > t || tr.end < t || tr.rt === 'cancel') continue;
    counts[tr.cat]++;
    if (!showAny || state.hidden.has(tr.cat)) continue;
    const loc = locate(tr, t);
    if (!loc) continue;
    // cheap visibility test on the head position before building the 3D body
    const [hx, hy] = pointAt(state.segs[tr.g[loc.k]], loc.d);
    if ((hx < x0 || hx > x1 || hy < y0 || hy > y1) && i !== state.selected) continue;
    const sections = sectionsFor(tr.model, (offsets) => pointsBehind(tr, loc.k, loc.d, offsets));
    for (const sec of sections) { sec.lon = sec.x / MX; sec.lat = sec.y / MY; }
    const delay = tr.rt === 'live' ? tr.times[2 * loc.next] - tr.sched[2 * loc.next] : null;
    out.push({ i, tr, loc, sections, delay, head: [hx / MX, hy / MY], h: MODELS[tr.model].h, route: state.routes[tr.r] });
  }
  state.counts = counts;
  return out;
}

// ---------------------------------------------------------------- map: native layers
let map, overlay, networkData, stopsData, baseLayers = [];

function networkGeojson() {
  const catOf = new Map();
  for (const tr of state.trips) for (const g of tr.g) if (!catOf.has(g)) catOf.set(g, tr.cat);
  const features = [];
  for (const [g, cat] of catOf) {
    const s = state.segs[g];
    const coords = [];
    for (let i = 0; i < s.xs.length; i++) coords.push([s.xs[i] / MX, s.ys[i] / MY]);
    features.push({ type: 'Feature', properties: { cat }, geometry: { type: 'LineString', coordinates: coords } });
  }
  return { type: 'FeatureCollection', features };
}

function stopsGeojson() {
  // merge platforms into one point per stop name
  const byName = new Map();
  const used = new Set();
  for (const tr of state.trips) for (const s of tr.s) used.add(s);
  for (const s of used) {
    const [lon, lat, name] = state.stops[s];
    const e = byName.get(name) || { lon: 0, lat: 0, n: 0, modes: new Set() };
    e.lon += lon; e.lat += lat; e.n++;
    byName.set(name, e);
  }
  for (const tr of state.trips) for (const s of tr.s) byName.get(state.stops[s][2]).modes.add(tr.cat);
  const features = [];
  for (const [name, e] of byName) {
    features.push({
      type: 'Feature',
      properties: { name: shortName(name), full: name, modes: [...e.modes].join(',') },
      geometry: { type: 'Point', coordinates: [e.lon / e.n, e.lat / e.n] },
    });
  }
  return { type: 'FeatureCollection', features };
}

function addNativeLayers() {
  const night = state.theme === 'night';
  // remember the style's own layers so the basemap can be hidden/restored
  baseLayers = map.getStyle().layers
    .filter((l) => !OWN_LAYERS.has(l.id))
    .map((l) => ({ id: l.id, type: l.type, vis: /^poi_/.test(l.id) ? 'none' : l.layout?.visibility || 'visible' }));
  for (const l of baseLayers) if (/^poi_/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');

  if (!map.getSource('network')) map.addSource('network', { type: 'geojson', data: networkData });
  if (!map.getSource('stops')) map.addSource('stops', { type: 'geojson', data: stopsData });
  // the dark style ships without 3D buildings: add them from the same vector tiles
  if (!map.getLayer('building-3d') && map.getSource('openmaptiles')) {
    map.addLayer({
      id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
      paint: { 'fill-extrusion-base': ['get', 'render_min_height'], 'fill-extrusion-height': ['get', 'render_height'] },
    });
    baseLayers.push({ id: 'building-3d', type: 'fill-extrusion', vis: 'visible' });
  }
  if (night) {
    for (const [id, paint] of Object.entries(NIGHT_PAINT)) {
      if (!map.getLayer(id)) continue;
      for (const [k, v] of Object.entries(paint)) map.setPaintProperty(id, k, v);
    }
  }
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  // satellite imagery sits below labels, a fade layer above it implements "basemap opacity"
  if (!map.getSource('sat')) map.addSource('sat', { type: 'raster', tiles: [SWISSIMAGE], tileSize: 256, maxzoom: 19, attribution: '© swisstopo' });
  map.addLayer({ id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } }, firstSymbol);
  map.addLayer({ id: 'fade', type: 'background', paint: { 'background-color': night ? '#0b0e13' : '#eef0f2', 'background-opacity': 0 } }, 'building-3d');
  map.addLayer({
    id: 'network', type: 'line', source: 'network',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['match', ['get', 'cat'], 'tram', '#3d8bfd', 'rail', '#ff5a5f', 'ship', '#2ec4d6', 'funicular', '#b48cff', '#3ccf7a'],
      'line-opacity': night ? 0.5 : 0.4,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 16, 3],
    },
  }, 'building-3d');
  map.addLayer({
    id: 'stops-dot', type: 'circle', source: 'stops', minzoom: 13,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2, 17, 5],
      'circle-color': night ? '#e9edf2' : '#ffffff',
      'circle-stroke-color': night ? '#f0b232' : '#1b1f24',
      'circle-stroke-width': 1.2,
    },
  });
  map.addLayer({
    id: 'stops-label', type: 'symbol', source: 'stops', minzoom: 14.5,
    layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
      'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true,
    },
    paint: { 'text-color': night ? '#e9edf2' : '#1b1f24', 'text-halo-color': night ? '#0b0e13' : '#ffffff', 'text-halo-width': 1.4 },
  });
  // street lighting: a soft sodium glow along roads plus a row of lamp dots (night style only)
  if (night) {
    map.addLayer({
      id: 'street-glow', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 11, filter: LIT_ROADS,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ff9f45',
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 11, 2, 14, 6, 17, 26],
        'line-blur': ['interpolate', ['exponential', 1.6], ['zoom'], 11, 2, 14, 5, 17, 20],
        'line-opacity': ['match', ['get', 'class'], ['minor', 'service'], 0.07, 0.14],
      },
    }, 'network');
    map.addLayer({
      id: 'street-lamps', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 13.5, filter: LIT_ROADS,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffd08a',
        'line-width': ['interpolate', ['linear'], ['zoom'], 13.5, 1.1, 17, 2.6],
        'line-dasharray': [0, 9],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.5, 0.75],
      },
    }, 'network');
  }
  lastSky = '';
  updateAtmosphere(true);
  applyLayerVisibility();
  applyBasemap();
}

function setVis(id, on) { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); }

function applyLayerVisibility() {
  setVis('network', settings.show.network);
  setVis('stops-dot', settings.show.stops);
  setVis('stops-label', settings.show.stops);
  // buildings are drawn by deck.gl (with lit windows); the style's own extrusions stay hidden
  setVis('building-3d', false);
}

function applyBasemap() {
  const mode = settings.basemap;
  for (const l of baseLayers) {
    if (l.id === 'building-3d') continue;
    const keep = mode === 'none' ? l.type === 'background' : l.vis === 'visible';
    setVis(l.id, keep);
  }
  setVis('sat', mode === 'satellite');
  $('credit-swisstopo').hidden = mode !== 'satellite';
  if (map.getLayer('fade')) map.setPaintProperty('fade', 'background-opacity', mode === 'none' ? 0 : 1 - settings.opacity / 100);
}

function setTheme(theme) {
  if (theme === state.theme && map.getLayer('network')) return;
  state.theme = theme;
  settings.theme = theme;
  document.querySelectorAll('#theme button').forEach((b) => b.classList.toggle('on', b.dataset.theme === theme));
  map.setStyle(STYLES[theme]); // our layers are re-added on 'style.load'
}

/** With the day/night cycle on, the map style follows the simulated sun. */
function updateCycle() {
  if (!settings.cycle || !map) return;
  const { rise, set } = sunTimes(state.date);
  const t = mod(state.t, 86400);
  const want = t > rise - 900 && t < set + 900 ? 'day' : 'night';
  if (want !== state.theme) setTheme(want);
}

// ---------------------------------------------------------------- sun, sky, weather
let lastSky = '';
let weatherData = null;
let precip = null;
const ambientLight = new deck.AmbientLight({ color: [255, 255, 255], intensity: 1.0 });
const sunLight = new deck.DirectionalLight({ color: [255, 250, 240], intensity: 1.4, direction: [-1, -1, -2] });
const lighting = new deck.LightingEffect({ ambientLight, sunLight });

async function pollWeather() {
  try {
    const d = await loadJson('api/weather');
    if (d.status === 'ok') weatherData = d;
  } catch { /* keep the last data */ }
  updateAtmosphere(true);
}

/** Sun-driven sky, building lights and weather effects for the simulated time (runs ~1×/s). */
function updateAtmosphere(force = false) {
  if (!map || !state.date) return;
  const t = mod(state.t, 86400);
  const sun = sunPosition(state.date, t);
  const night = nightOf(sun.alt);
  const wx = weatherAt(weatherData, state.date, t, state.live);
  const cloud = wx ? wx.cloud / 100 : 0.3;
  const [label, icon] = wx ? describe(wx.code) : ['', ''];
  const wet = wx && (icon === 'rain' || icon === 'snow' || icon === 'storm');
  const showWx = settings.show.weather && wx;

  // windows and wall darkness (read by the building shader every frame)
  lights.night = night;
  lights.lit = litShare(t, night);
  lights.dim = showWx ? cloud * 0.8 : 0;

  // deck.gl lighting follows the sun; at night only a dim, cool ambient light remains
  const day = 1 - night;
  const altR = Math.max(sun.alt, 4) * Math.PI / 180, azR = sun.az * Math.PI / 180;
  sunLight.direction = [-Math.sin(azR) * Math.cos(altR), -Math.cos(azR) * Math.cos(altR), -Math.sin(altR)];
  const low = Math.min(1, Math.max(0, (sun.alt - 2) / 18)); // warm light when the sun is low
  sunLight.color = [255, Math.round(200 + 50 * low), Math.round(150 + 90 * low)];
  sunLight.intensity = day * (showWx ? 1.7 - cloud * 0.8 : 1.7);
  ambientLight.intensity = 0.6 + day * 0.4;
  ambientLight.color = night > 0.5 ? [190, 205, 235] : [255, 255, 255];

  const sky = skyFor(sun.alt, showWx ? cloud : 0.2);
  const key = JSON.stringify(sky);
  if (force || key !== lastSky) { lastSky = key; map.setSky?.(sky); }

  // rain / snow
  if (precip) {
    let kind = 'none', amount = 0;
    if (showWx) {
      const snowing = wx.snow > 0 || icon === 'snow';
      kind = snowing ? 'snow' : 'rain';
      amount = precipIntensity(snowing ? wx.snow * 7 : wx.precip);
      if (!amount && wet) amount = 0.1; // the code says rain but this hour's total rounds to 0
    }
    const windPx = wx ? Math.sin(wx.windDir * Math.PI / 180 + Math.PI) * Math.min(wx.wind, 60) * 3 : 0;
    precip.set(kind, amount, windPx, night);
  }

  // weather chip next to the logo
  const chip = $('wx');
  if (wx) {
    chip.hidden = false;
    chip.title = `${label}, ${Math.round(wx.temp)}°C · wind ${Math.round(wx.wind)} km/h${state.live ? '' : ' (at the selected time)'}`;
    chip.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[icon]}</svg><b>${Math.round(wx.temp)}°</b><span>${label}</span>`;
  } else chip.hidden = true;
}

// ---------------------------------------------------------------- deck.gl layers
function buildLayers(vehicles) {
  const night = state.theme === 'night';
  const sel = state.selected;
  const layers = [];
  const bl = buildingsLayer({ visible: settings.show.buildings, opacity: settings.buildingOpacity / 100 });
  if (bl) layers.push(bl);

  if (sel >= 0) {
    const tr = state.trips[sel];
    const path = [];
    for (const g of tr.g) {
      const s = state.segs[g];
      for (let i = 0; i < s.xs.length; i++) path.push([s.xs[i] / MX, s.ys[i] / MY]);
    }
    layers.push(new deck.PathLayer({
      id: 'selected-route', data: [{ path }], getPath: (d) => d.path,
      getColor: [...state.routes[tr.r].rgb, 230], getWidth: 5, widthUnits: 'pixels', widthMinPixels: 3,
      capRounded: true, jointRounded: true, parameters: { depthCompare: 'always' },
    }));
    layers.push(new deck.ScatterplotLayer({
      id: 'selected-stops', data: tr.s.map((s) => state.stops[s]),
      getPosition: (d) => [d[0], d[1]], getRadius: 5, radiusUnits: 'pixels',
      getFillColor: [255, 255, 255], getLineColor: [...state.routes[tr.r].rgb], lineWidthMinPixels: 2, stroked: true,
      parameters: { depthCompare: 'always' },
    }));
  }

  if (settings.show.trails) {
    layers.push(new deck.TripsLayer({
      id: 'trails', data: vehicles,
      getPath: (v) => trailPath(v),
      getTimestamps: (v) => v._ts,
      getColor: (v) => (night ? [255, 214, 140] : v.route.rgb),
      currentTime: 0, trailLength: 260, fadeTrail: true,
      widthMinPixels: 2, getWidth: 3, capRounded: true, jointRounded: true,
      updateTriggers: { getPath: state.t, getTimestamps: state.t, getColor: night },
    }));
  }

  // one instanced mesh layer per (body shape, livery); every articulated section is one instance
  const groups = new Map();
  for (const v of vehicles) {
    for (const sec of v.sections) {
      const key = sec.mesh + '|' + sec.livery;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push({ v, sec });
    }
  }
  const material = night
    // vehicles are lit from inside at night, so they stay bright while the city goes dark
    ? { ambient: 1.5, diffuse: 0.3, shininess: 32, specularColor: [80, 80, 80] }
    : { ambient: 0.45, diffuse: 0.7, shininess: 32, specularColor: [70, 72, 76] };
  for (const [key, data] of groups) {
    const [mesh, livery] = key.split('|');
    layers.push(new deck.SimpleMeshLayer({
      id: 'veh-' + key, data,
      mesh: MESHES[mesh],
      texture: liveryTexture(livery, night),
      getPosition: (d) => [d.sec.lon, d.sec.lat, 0],
      getOrientation: (d) => [0, d.sec.yaw, 0],
      getScale: (d) => [d.sec.len, d.sec.w, d.sec.h],
      getColor: (d) => (d.v.i === sel ? [255, 205, 90] : [255, 255, 255]),
      material,
      pickable: true,
      updateTriggers: { getPosition: state.t, getOrientation: state.t, getColor: sel },
    }));
  }

  const zoom = map.getZoom();
  if (settings.show.labels && zoom >= 13.5) {
    const labelPos = (v) => [v.sections[0].lon, v.sections[0].lat, v.h + 3];
    layers.push(new deck.TextLayer({
      id: 'labels', data: vehicles,
      getPosition: labelPos,
      getText: (v) => v.route.n,
      getSize: 12, sizeUnits: 'pixels',
      getColor: [255, 255, 255],
      background: true, getBackgroundColor: (v) => [...v.route.rgb, 240], backgroundPadding: [5, 2],
      fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 800,
      characterSet: 'auto', billboard: true,
      parameters: { depthCompare: 'always' },
      updateTriggers: { getPosition: state.t },
    }));
    if (settings.show.delays && zoom >= 14.5) {
      const late = vehicles.filter((v) => v.delay !== null && v.delay >= 60);
      layers.push(new deck.TextLayer({
        id: 'delay-labels', data: late,
        getPosition: labelPos,
        getText: (v) => `+${Math.round(v.delay / 60)} min`,
        getSize: 11, sizeUnits: 'pixels', getPixelOffset: [0, 17],
        getColor: [255, 255, 255],
        background: true, getBackgroundColor: [214, 48, 56, 235], backgroundPadding: [4, 1],
        fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 700,
        characterSet: 'auto', billboard: true,
        parameters: { depthCompare: 'always' },
        updateTriggers: { getPosition: state.t, getText: state.t },
      }));
    }
  }
  return layers;
}

function trailPath(v) {
  // trail = last ~260 m behind the head, timestamps relative to the head (0)
  const offs = [];
  for (let o = 0; o <= 260; o += 10) offs.push(o);
  const p = pointsBehind(v.tr, v.loc.k, v.loc.d, offs).reverse();
  v._ts = offs.map((o) => -o).reverse();
  return p.map(([x, y]) => [x / MX, y / MY, 1]);
}

// ---------------------------------------------------------------- UI: stats, modes, status
function renderStats() {
  const lines = Object.fromEntries(Object.keys(CATS).map((c) => [c, new Set()]));
  for (const tr of state.trips) lines[tr.cat].add(tr.r);
  const parts = ['tram', 'bus', 'rail']
    .filter((c) => lines[c].size)
    .map((c) => `<b>${lines[c].size}</b> ${c === 'rail' ? 'TRAIN' : CATS[c].one.toUpperCase()} LINES`);
  $('stats-lines').innerHTML = parts.join('<span class="sep">·</span>');
  $('stats-trips').innerHTML = `<b>${fmtNum(state.trips.length)}</b> TRIPS ON ${prettyDate(state.date).toUpperCase()}`;
}

function renderRealtimeStatus() {
  const el = $('rt-status');
  const ago = rt.fetchedAt ? Math.round((Date.now() - rt.fetchedAt) / 1000) : null;
  let text, cls;
  if (rt.status === 'ok' && ago !== null && ago < 180) {
    const n = state.trips.filter((t) => t.rt).length;
    text = `● LIVE DATA<span class="rt-more"> · ${fmtNum(n)} TRIPS</span> · ${ago}S AGO`; cls = 'ok';
  } else if (rt.status === 'no-key') { text = 'SCHEDULED TIMETABLE'; cls = 'off'; }
  else if (rt.status === 'error') { text = 'REAL-TIME ERROR'; cls = 'err'; el.title = rt.error || ''; }
  else if (rt.status === 'unreachable') { text = 'REAL-TIME UNAVAILABLE'; cls = 'err'; }
  else { text = 'CONNECTING…'; cls = 'off'; }
  el.innerHTML = text; // only fixed words and numbers
  el.className = 'rt ' + cls;
  $('pt-live').classList.toggle('off', cls !== 'ok');
}

function renderModes() {
  const el = $('modes');
  el.innerHTML = '';
  for (const [cat, spec] of Object.entries(CATS)) {
    if (!state.trips.some((t) => t.cat === cat)) continue;
    const row = document.createElement('label');
    row.className = 'mode';
    row.innerHTML = `<span class="dot" style="background:${spec.color}"></span><span class="nm">${spec.label}</span>
      <span class="n" data-count="${cat}">0</span><input type="checkbox" class="switch" ${state.hidden.has(cat) ? '' : 'checked'} />`;
    row.querySelector('input').onchange = (e) => {
      if (e.target.checked) state.hidden.delete(cat); else state.hidden.add(cat);
      state.dirty = true;
      saveSettings();
    };
    el.appendChild(row);
  }
}

function updateCounts() {
  let total = 0;
  for (const [cat, n] of Object.entries(state.counts)) {
    total += n;
    const el = document.querySelector(`[data-count="${cat}"]`);
    if (el && el.textContent !== String(n)) el.textContent = n;
  }
  const s = fmtNum(total);
  if ($('in-service').textContent !== s) $('in-service').textContent = s;
}

// ---------------------------------------------------------------- UI: disruptions
function computeAlerts() {
  const t = state.t;
  const delay = [], cancel = [];
  for (let i = 0; i < state.trips.length; i++) {
    const tr = state.trips[i];
    if (tr.rt === 'cancel') {
      if (tr.sStart > t - 1800 && tr.sStart < t + 7200) cancel.push({ i, tr, at: tr.sStart });
    } else if (tr.rt === 'live' && tr.start <= t && tr.end >= t) {
      const d = delayAt(tr, t);
      if (d >= 180) delay.push({ i, tr, d });
    }
  }
  delay.sort((a, b) => b.d - a.d);
  cancel.sort((a, b) => a.at - b.at);
  state.alerts = { delay: delay.slice(0, 80), cancel: cancel.slice(0, 80) };
  const n = delay.length + cancel.length;
  $('alert-count').hidden = n === 0;
  $('alert-count').textContent = n > 99 ? '99+' : n;
  $('af-all').textContent = n;
  $('af-delay').textContent = delay.length;
  $('af-cancel').textContent = cancel.length;
  renderAlerts();
}

function renderAlerts() {
  const f = state.alertFilter;
  const items = [
    ...(f !== 'delay' ? state.alerts.cancel.map((a) => ({ ...a, kind: 'cancel' })) : []),
    ...(f !== 'cancel' ? state.alerts.delay.map((a) => ({ ...a, kind: 'delay' })) : []),
  ];
  const list = $('alert-list');
  if (!items.length) {
    list.innerHTML = `<li class="empty">${rt.status === 'ok' ? 'No major disruptions right now' : 'Waiting for real-time data…'}</li>`;
    return;
  }
  list.innerHTML = items.map(({ i, tr, kind, d, at }) => {
    const route = state.routes[tr.r];
    const to = esc(shortName(tr.h || state.stops[tr.s[tr.s.length - 1]][2]));
    const meta = kind === 'cancel'
      ? `Scheduled ${fmtHM(at)} · ${esc(route.a)}`
      : `${esc(CATS[tr.cat].one)} · next stop ${esc(shortName(state.stops[tr.s[(locate(tr, state.t) || { next: 0 }).next]][2]))}`;
    const tag = kind === 'cancel' ? '<span class="tag cancel">CANCELLED</span>' : `<span class="tag late">+${Math.round(d / 60)} min</span>`;
    return `<li data-i="${i}"><span class="badge" style="background:${route.col}">${esc(route.n)}</span>
      <div class="txt"><div class="to">${to}</div><div class="meta">${meta}</div></div>${tag}</li>`;
  }).join('');
}

function showAlerts(on) {
  if (on && isPhone()) setPanel(false, false);
  state.alertsOpen = on;
  $('btn-alerts').classList.toggle('on', on);
  $('alerts').hidden = !on || state.selected >= 0;
}

// ---------------------------------------------------------------- UI: vehicle panel
function realtimeTag(tr) {
  if (tr.rt === 'cancel') return '<span class="delay cancel">CANCELLED</span>';
  if (tr.rt !== 'live') return '<span class="delay none">Scheduled</span>';
  const d = Math.round(delayAt(tr, state.t) / 60);
  if (d === 0) return '<span class="delay ok">ON TIME</span>';
  return `<span class="delay ${d > 0 ? 'late' : 'early'}">${d > 0 ? `+${d} MIN` : `${d} MIN`}</span>`;
}

function tooltipDelay(tr) {
  const d = delayAt(tr, state.t);
  if (d === null) return '';
  const m = Math.round(d / 60);
  return m === 0 ? ' · on time' : m > 0 ? ` · +${m} min` : ` · ${m} min`;
}

function renderInfo() {
  const sel = state.selected;
  if (sel < 0) return;
  const tr = state.trips[sel];
  const route = state.routes[tr.r];
  const loc = locate(tr, state.t);
  const next = loc ? loc.next : state.t > tr.end ? tr.s.length : 0;
  const items = tr.s.map((s, k) => {
    const cls = loc && k < next ? 'past' : loc && k === next ? 'next' : '';
    const i = k === 0 ? 1 : 2 * k;
    const late = Math.round((tr.times[i] - tr.sched[i]) / 60);
    const lateTag = tr.rt === 'live' && late !== 0 ? `<span class="late ${late > 0 ? 'pos' : 'neg'}">${late > 0 ? '+' : ''}${late}</span>` : '';
    const skip = tr.skipped?.has(k) ? ' skipped' : '';
    return `<li class="${cls}${skip}"><span class="t">${fmtHM(tr.sched[i])}</span><span class="nm">${esc(shortName(state.stops[s][2]))}</span>${lateTag}</li>`;
  }).join('');
  const nextName = loc ? esc(shortName(state.stops[tr.s[loc.next]][2])) : '';
  const status = tr.rt === 'cancel' ? 'Trip cancelled' : !loc ? (state.t < tr.start ? `Departs ${fmtHM(tr.times[1])}` : 'Trip finished') : loc.atStop ? `At ${nextName}` : `Next: ${nextName}`;
  $('info-body').innerHTML = `
    <div class="info-head"><span class="badge" style="background:${route.col}">${esc(route.n)}</span>
      <span class="to">${esc(shortName(tr.h || state.stops[tr.s[tr.s.length - 1]][2]))}</span></div>
    <div class="info-sub">${esc(CATS[tr.cat].one)} · ${esc(route.a)}${tr.n ? ` · trip ${esc(tr.n)}` : ''}</div>
    <div class="info-status"><span>${status}</span>${realtimeTag(tr)}</div>
    ${loc ? `<button class="follow ${state.follow ? 'on' : ''}" id="follow-btn">${state.follow ? 'FOLLOWING · ESC TO STOP' : 'FOLLOW THIS VEHICLE'}</button>` : ''}
    <ul class="stoplist">${items}</ul>`;
  const fb = $('follow-btn');
  if (fb) fb.onclick = () => { state.follow = !state.follow; renderInfo(); };
  const nextEl = $('info-body').querySelector('li.next');
  if (nextEl && state.lastNext !== `${sel}:${next}`) { state.lastNext = `${sel}:${next}`; nextEl.scrollIntoView({ block: 'center' }); }
}

function showInfo(on) {
  if (on && isPhone()) setPanel(false, false);
  $('info').classList.toggle('hidden', !on);
  $('alerts').hidden = on || !state.alertsOpen;
}

function select(i, { fly = false } = {}) {
  state.selected = i;
  state.follow = false;
  state.dirty = true;
  if (i < 0) { showInfo(false); return; }
  track('vehicle');
  renderInfo();
  showInfo(true);
  if (fly) map.flyTo({ center: tripPosition(state.trips[i], state.t), zoom: Math.max(map.getZoom(), 16.3), duration: 1400 });
}

// ---------------------------------------------------------------- UI: time
let sliderBase = null; // service day the slider refers to while dragging

function serviceBase() { return state.t < 14400 ? addDays(state.date, -1) : state.date; }

function setSpeed(s) {
  state.speed = s;
  document.querySelectorAll('#speeds button').forEach((b) => b.classList.toggle('on', +b.dataset.speed === s));
}

function setPlaying(on) {
  state.playing = on;
  $('play').classList.toggle('paused', !on);
  if (!on) setLive(false);
}

function setLive(on) {
  state.live = on;
  $('live').classList.toggle('on', on);
  if (on) { setSpeed(1); state.playing = true; $('play').classList.remove('paused'); }
  else track('timetravel');
}

async function jumpTo(date, t) {
  if (date !== state.date) {
    if (!state.days.includes(date) || !(await switchDay(date))) return;
  }
  state.t = t;
  state.dirty = true;
  computeAlerts();
}

function renderClock() {
  const hm = fmtHM(state.t);
  if ($('clock').textContent !== hm) {
    $('clock').textContent = hm;
    $('period').textContent = periodOf(state.t);
    $('date').textContent = prettyDate(state.date);
  }
  if (sliderBase === null) {
    const v = state.t < 14400 ? state.t + 86400 : state.t;
    $('slider').value = Math.floor(v);
  }
}

// ---------------------------------------------------------------- UI: search
let searchIndex = [];
function buildSearchIndex() {
  searchIndex = stopsData.features.map((f) => ({
    name: f.properties.name, full: f.properties.full, key: fold(f.properties.full),
    modes: f.properties.modes.split(','), coord: f.geometry.coordinates,
  }));
}
function runSearch(q) {
  const list = $('search-results');
  const k = fold(q.trim());
  if (!k) { list.innerHTML = ''; return; }
  const hits = searchIndex
    .filter((s) => s.key.includes(k))
    .sort((a, b) => (a.key.indexOf(k) - b.key.indexOf(k)) || a.name.length - b.name.length)
    .slice(0, 10);
  list.innerHTML = hits.length
    ? hits.map((s, i) => `<li data-i="${searchIndex.indexOf(s)}" class="${i === 0 ? 'active' : ''}"><span>${esc(s.full)}</span><span class="sub">${s.modes.map((m) => CATS[m]?.one || m).join(', ')}</span></li>`).join('')
    : '<li class="sub">No stop found</li>';
}
function pickSearch(idx) {
  const s = searchIndex[idx];
  if (!s) return;
  track('search');
  map.flyTo({ center: s.coord, zoom: 17, duration: 1600 });
  toggleSearch(false);
}
let searchHidPanel = false;
function setPanel(open, save = true) {
  $('panel').classList.toggle('closed', !open);
  $('btn-panel').classList.toggle('on', open);
  if (save) { settings.panelOpen = open; saveSettings(); }
}
function toggleSearch(on, { restore = true } = {}) {
  // the search box sits where the layer panel starts: hide the panel meanwhile, bring it back after
  if (on && !$('panel').classList.contains('closed')) { searchHidPanel = true; setPanel(false, false); }
  else if (!on && searchHidPanel) { searchHidPanel = false; if (restore) setPanel(true, false); }
  $('search').classList.toggle('hidden', !on);
  $('btn-search').classList.toggle('on', on);
  if (on) { $('search-input').value = ''; $('search-results').innerHTML = ''; $('search-input').focus(); }
}

// ---------------------------------------------------------------- UI: wiring
/**
 * deck.gl draws into MapLibre's canvas, so both must use the same pixel ratio, otherwise the 3D
 * layers are drawn at the wrong scale and drift away from the map underneath. In interleaved mode
 * deck.gl takes its ratio from the drawing-buffer size it last recorded, which it never refreshes
 * when MapLibre changes resolution, so it is updated here from the real canvas size.
 */
function syncDeckPixelRatio() {
  const cc = overlay?._deck?.device?.canvasContext;
  if (!cc || !map) return;
  const canvas = map.getCanvas();
  const [w, h] = cc.getDrawingBufferSize();
  if (w !== canvas.width || h !== canvas.height) cc.setDrawingBufferSize(canvas.width, canvas.height);
  map.triggerRepaint();
}

function setQuality(q) {
  settings.quality = q;
  document.querySelectorAll('#quality button').forEach((b) => b.classList.toggle('on', b.dataset.q === q));
  map?.setPixelRatio?.(QUALITY[q].ratio());
  syncDeckPixelRatio();
  saveSettings();
}

function set2D(on) {
  if (on) {
    map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
    map.setMaxPitch(0);
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
  } else {
    map.setMaxPitch(80);
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.easeTo({ pitch: 60, duration: 700 });
  }
}

function wireUi() {
  // toolbar
  $('btn-panel').onclick = () => {
    const open = $('panel').classList.contains('closed');
    if (open) {
      toggleSearch(false, { restore: false });
      if (isPhone()) { showAlerts(false); if (state.selected >= 0) select(-1); } // no room for two panels
      track('panel');
    }
    setPanel(open);
  };
  setPanel(settings.panelOpen, false);
  // Panels fill the space between the toolbar and the time bar. Measured, because the time bar's
  // height varies and 100vh on phones includes the area behind the browser's own toolbars.
  const layout = () => {
    const root = document.documentElement;
    const tools = document.querySelector('#topleft .toolbar').getBoundingClientRect();
    const tbTop = $('timebar').getBoundingClientRect().top;
    root.style.setProperty('--tools-top', `${Math.round(tools.top)}px`);
    root.style.setProperty('--top-space', `${Math.round(tools.bottom + 10)}px`);
    root.style.setProperty('--tb-space', `${Math.round(root.clientHeight - tbTop + 10)}px`);
    root.style.setProperty('--avail', `${Math.max(120, Math.round(tbTop - 10 - tools.bottom - 10))}px`);
  };
  layout();
  window.addEventListener('resize', layout);
  new ResizeObserver(layout).observe($('timebar'));
  $('btn-search').onclick = () => toggleSearch($('search').classList.contains('hidden'));
  $('btn-home').onclick = () => map.flyTo({ ...START_VIEW, pitch: $('l-2d').checked ? 0 : START_VIEW.pitch, bearing: $('l-2d').checked ? 0 : START_VIEW.bearing, duration: 1800 });
  $('btn-alerts').onclick = () => {
    if (state.selected >= 0) select(-1);
    const on = !state.alertsOpen || state.selected >= 0;
    if (on) track('alerts');
    showAlerts(on);
  };
  $('alerts-close').onclick = () => showAlerts(false);

  // search
  $('search-input').oninput = (e) => runSearch(e.target.value);
  $('search-input').onkeydown = (e) => {
    const items = [...$('search-results').querySelectorAll('li[data-i]')];
    const cur = items.findIndex((li) => li.classList.contains('active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      if (!n) return;
      const next = e.key === 'ArrowDown' ? (cur + 1) % n : (cur - 1 + n) % n;
      items.forEach((li, i) => li.classList.toggle('active', i === next));
    } else if (e.key === 'Enter' && items[Math.max(0, cur)]) pickSearch(+items[Math.max(0, cur)].dataset.i);
    else if (e.key === 'Escape') toggleSearch(false);
  };
  $('search-results').onclick = (e) => { const li = e.target.closest('li[data-i]'); if (li) pickSearch(+li.dataset.i); };

  // panel: graphics + map
  document.querySelectorAll('#quality button').forEach((b) => { b.onclick = () => setQuality(b.dataset.q); });
  $('l-2d').onchange = (e) => { if (e.target.checked) track('2d'); set2D(e.target.checked); };
  document.querySelectorAll('#basemap button').forEach((b) => {
    b.classList.toggle('on', b.dataset.b === settings.basemap);
    b.onclick = () => {
      settings.basemap = b.dataset.b;
      if (b.dataset.b === 'satellite') track('satellite');
      document.querySelectorAll('#basemap button').forEach((x) => x.classList.toggle('on', x === b));
      applyBasemap();
      saveSettings();
    };
  });
  $('l-opacity').value = settings.opacity;
  $('l-opacity').oninput = (e) => { settings.opacity = +e.target.value; applyBasemap(); saveSettings(); };
  $('l-cycle').checked = settings.cycle;
  $('theme-row').classList.toggle('hidden', settings.cycle);
  $('l-cycle').onchange = (e) => {
    settings.cycle = e.target.checked;
    $('theme-row').classList.toggle('hidden', settings.cycle);
    if (settings.cycle) updateCycle();
    saveSettings();
  };
  document.querySelectorAll('#theme button').forEach((b) => {
    b.classList.toggle('on', b.dataset.theme === state.theme);
    b.onclick = () => { track('theme'); setTheme(b.dataset.theme); saveSettings(); };
  });
  $('l-bopacity').value = settings.buildingOpacity;
  $('l-bopacity').oninput = (e) => { settings.buildingOpacity = +e.target.value; state.dirty = true; saveSettings(); };

  // panel: layer switches
  const switches = { weather: 'l-weather', buildings: 'l-buildings', network: 'l-network', stops: 'l-stops', pt: 'l-pt', labels: 'l-labels', delays: 'l-delays', trails: 'l-trails' };
  for (const [key, id] of Object.entries(switches)) {
    const el = $(id);
    el.checked = settings.show[key];
    el.onchange = (e) => {
      settings.show[key] = e.target.checked;
      track('layers');
      applyLayerVisibility();
      updateAtmosphere();
      state.dirty = true;
      saveSettings();
    };
    // a switch inside <summary> must not toggle the <details>
    el.addEventListener('click', (e) => e.stopPropagation());
  }

  // disruptions
  document.querySelectorAll('#alert-filter button').forEach((b) => {
    b.onclick = () => {
      state.alertFilter = b.dataset.f;
      document.querySelectorAll('#alert-filter button').forEach((x) => x.classList.toggle('on', x === b));
      renderAlerts();
    };
  });
  $('alert-list').onclick = (e) => { const li = e.target.closest('li[data-i]'); if (li) select(+li.dataset.i, { fly: true }); };
  $('info-close').onclick = () => select(-1);

  // time bar
  $('play').onclick = () => setPlaying(!state.playing);
  $('live').onclick = async () => {
    const now = zurichNow();
    await jumpTo(state.days.includes(now.date) ? now.date : state.date, now.sec);
    setLive(true);
  };
  document.querySelectorAll('#speeds button').forEach((b) => {
    b.onclick = () => { if (+b.dataset.speed !== 1) setLive(false); setSpeed(+b.dataset.speed); if (!state.playing) setPlaying(true); };
  });
  const slider = $('slider');
  slider.addEventListener('pointerdown', () => { sliderBase = serviceBase(); });
  slider.addEventListener('focus', () => { if (sliderBase === null) sliderBase = serviceBase(); });
  const release = () => { sliderBase = null; };
  slider.addEventListener('pointerup', release);
  slider.addEventListener('blur', release);
  slider.oninput = () => {
    setLive(false);
    const base = sliderBase ?? serviceBase();
    const v = +slider.value;
    jumpTo(v >= 86400 ? addDays(base, 1) : base, v % 86400);
  };

  window.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input[type="search"], input[type="text"]');
    if (e.key === 'Escape') {
      if (!$('search').classList.contains('hidden')) toggleSearch(false);
      else if (state.follow) { state.follow = false; renderInfo(); }
      else select(-1);
    }
    if (typing) return;
    if (e.key === ' ' && (e.target === document.body || e.target.closest('#map'))) { e.preventDefault(); setPlaying(!state.playing); }
    if (e.key === '/') { e.preventDefault(); toggleSearch(true); }
  });
}

// ---------------------------------------------------------------- main loop
let lastFrame = performance.now();
let lastInfo = 0, lastVehicles = 0, lastAlerts = 0, lastCycle = 0;
let dayLoading = false;
let lastIndexCheck = 0;

/** Re-read the list of available days (it changes when the server rebuilds the data). */
async function refreshDays() {
  try { state.days = (await loadJson('data/index.json')).days; } catch { /* keep the old list */ }
}

/** Load another day; never throws, so a missing file can't stop the animation loop. */
async function switchDay(date) {
  if (dayLoading) return false;
  dayLoading = true;
  try {
    await loadDay(date);
    return true;
  } catch (e) {
    console.warn(`Could not load ${date}: ${e.message}`);
    await refreshDays();
    return false;
  } finally {
    dayLoading = false;
  }
}

async function tick(now) {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;

  if (state.live) {
    const z = zurichNow();
    if (z.date !== state.date && !dayLoading) {
      if (state.days.includes(z.date)) await switchDay(z.date);
      else if (now - lastIndexCheck > 300_000) { lastIndexCheck = now; refreshDays(); } // wait for the nightly rebuild
    }
    state.t = z.sec;
  } else if (state.playing) {
    state.t += dt * state.speed;
    if (state.t >= 86400) {
      const next = addDays(state.date, 1);
      if (state.days.includes(next)) {
        if (!dayLoading) {
          if (await switchDay(next)) state.t -= 86400;
          else { state.t = 86399; setPlaying(false); }
        }
      } else {
        state.t = 86399; setPlaying(false); // no timetable beyond this day
      }
    }
  }

  // Rebuilding every vehicle body is the expensive part, so it runs at a capped rate;
  // the map itself still renders at full frame rate while panning/zooming.
  const interval = state.follow || state.speed >= 60 ? 0 : QUALITY[settings.quality].interval;
  if (now - lastVehicles >= interval || state.dirty) {
    lastVehicles = now;
    state.dirty = false;
    const vehicles = computeVehicles(state.t);
    state.active = vehicles;
    overlay.setProps({ layers: buildLayers(vehicles) });
    if (state.follow && state.selected >= 0) {
      const v = vehicles.find((x) => x.i === state.selected);
      if (v) map.jumpTo({ center: v.head });
    }
    updateCounts();
  }

  renderClock();
  if (now - lastInfo > 1000) { lastInfo = now; if (state.selected >= 0) renderInfo(); }
  if (now - lastAlerts > 5000) { lastAlerts = now; computeAlerts(); }
  if (now - lastCycle > 1000) { lastCycle = now; updateCycle(); updateAtmosphere(); }
  precip?.frame(now);
  requestAnimationFrame(tick);
}

async function main() {
  try {
    const idx = await loadJson('data/index.json');
    state.days = idx.days;
    const now = zurichNow();
    const day = state.days.includes(now.date) ? now.date : state.days[0];
    await loadDay(day);
    state.t = now.sec;
    if (day !== now.date) {
      state.live = false;
      $('rt-status').textContent = 'NO TIMETABLE FOR TODAY';
    }
  } catch (e) {
    $('loading-text').textContent = `Could not load data (${e.message}). Run "npm run setup" first.`;
    document.querySelector('#loading .spinner')?.remove();
    return;
  }

  networkData = networkGeojson();
  stopsData = stopsGeojson();
  buildSearchIndex();

  if (settings.cycle) {
    const { rise, set } = sunTimes(state.date);
    state.theme = state.t > rise - 900 && state.t < set + 900 ? 'day' : 'night';
  }

  map = new maplibregl.Map({
    container: 'map', style: STYLES[state.theme], ...START_VIEW, maxPitch: 80,
    attributionControl: false,
    pixelRatio: QUALITY[settings.quality].ratio(),
    // MSAA only pays off when not already rendering above 1x
    canvasContextAttributes: { antialias: (window.devicePixelRatio || 1) <= 1 },
  });
  // vehicles outside the old view must be rebuilt as soon as the view moves
  map.on('moveend', () => { state.dirty = true; });
  map.on('move', () => { if (performance.now() - lastVehicles > 100) state.dirty = true; });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  overlay = new deck.MapboxOverlay({
    interleaved: true,
    layers: [],
    effects: [lighting],
    onClick: (info) => { if (info.layer?.id.startsWith('veh-') && info.object) select(info.object.v.i); },
    getTooltip: ({ object, layer }) =>
      layer?.id.startsWith('veh-') && object
        ? { text: `${CATS[object.v.tr.cat].one} ${object.v.route.n} → ${shortName(object.v.tr.h)}${tooltipDelay(object.v.tr)}`, style: { fontSize: '12px', padding: '6px 10px' } }
        : null,
    getCursor: ({ isHovering }) => (isHovering ? 'pointer' : 'grab'),
  });
  map.addControl(overlay);
  window.zurich3d = { map, state, overlay, select, settings }; // handy for debugging in the console
  map.on('style.load', addNativeLayers);
  map.on('dragstart', () => { if (state.follow) { state.follow = false; renderInfo(); } });

  wireUi();
  setQuality(settings.quality);
  setLive(state.live);
  showAlerts(state.alertsOpen);
  renderModes();
  precip = new Precipitation($('precip'));
  initBuildings().then(() => { state.dirty = true; }).catch((e) => console.warn('buildings:', e.message));
  map.on('resize', syncDeckPixelRatio);
  map.once('load', () => {
    $('loading').remove();
    syncDeckPixelRatio();
    pollWeather();
    setInterval(pollWeather, 10 * 60_000);
    requestAnimationFrame(tick);
    pollRealtime();
    setInterval(pollRealtime, 30_000);
    setInterval(renderRealtimeStatus, 5_000);
  });
}

main();
