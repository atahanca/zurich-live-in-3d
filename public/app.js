/* global maplibregl, deck */
import { MODELS, MESHES, modelFor, sectionsFor, liveryTexture } from './vehicles.js';
// Zurich 3D: scheduled public transport animated over a 3D map.

const START_VIEW = { center: [8.5402, 47.3779], zoom: 14.6, pitch: 62, bearing: -28 };
const STYLES = {
  day: 'https://tiles.openfreemap.org/styles/liberty',
  night: 'https://tiles.openfreemap.org/styles/dark',
};
const CATS = {
  tram: { label: 'Trams', len: 36, w: 2.4, h: 3.6 },
  bus: { label: 'Buses', len: 18, w: 2.55, h: 3.2 },
  rail: { label: 'Trains', len: 100, w: 3.0, h: 4.4 },
  ship: { label: 'Boats', len: 40, w: 8, h: 4.5 },
  funicular: { label: 'Funiculars', len: 14, w: 2.8, h: 3.4 },
};
const LONG_DISTANCE_TYPES = new Set([101, 102, 103, 2]);

// Local metric projection (good to a few cm over the city)
const LAT0 = 47.37;
const MX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const MY = 110540;

const $ = (id) => document.getElementById(id);
const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const fmtTime = (s) => {
  s = ((Math.floor(s) % 86400) + 86400) % 86400;
  return [s / 3600, (s % 3600) / 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':');
};
const fmtHM = (s) => fmtTime(s).slice(0, 5);
const shortName = (n) => n.replace(/^Zürich,\s*/, '');

function zurichNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  const ms = new Date().getMilliseconds() / 1000;
  return { date: `${parts.year}${parts.month}${parts.day}`, sec: +parts.hour * 3600 + +parts.minute * 60 + +parts.second + ms };
}
const addDays = (ymd, n) => {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + n));
  return d.toISOString().slice(0, 10).replaceAll('-', '');
};
const prettyDate = (ymd) =>
  new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });

// ---------------------------------------------------------------- state
const state = {
  routes: [], stops: [], segs: [], trips: [], maxDur: 0,
  days: [], date: null, t: 0, speed: 1, playing: true, live: true,
  hidden: new Set(), selected: -1, follow: false,
  show: { network: true, stops: true, labels: true, trails: false, buildings: true },
  theme: 'day',
  active: [],
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

async function loadNetwork() {
  const net = await loadJson('data/network.json');
  state.routes = net.routes.map((r) => ({ ...r, rgb: hexToRgb(r.col) }));
  state.stops = net.stops;
  state.segs = net.segments.map(decodeSegment);
}

async function loadDay(date) {
  $('loading-text').textContent = `Loading timetable for ${prettyDate(date)}…`;
  const tt = await loadJson(`data/timetable-${date}.json`);
  let maxDur = 0;
  const prevDate = addDays(date, -1);
  state.trips = tt.trips.map(([r, h, n, s, g, d, id, prev, seq]) => {
    const sched = new Float64Array(d.length);
    let acc = 0;
    for (let i = 0; i < d.length; i++) sched[i] = acc += d[i];
    const route = state.routes[r];
    const cat = route.c;
    const model = modelFor(route, id || `${r}-${n}-${d[0]}`);
    const mm = MODELS[model];
    const len = mm.sections.reduce((a, b) => a + b, 0) + mm.gap * (mm.sections.length - 1);
    maxDur = Math.max(maxDur, sched[sched.length - 1] - sched[0]);
    const seqs = Array.isArray(seq) ? seq : s.map((_, k) => (seq ?? 1) + k);
    return {
      r, h, n, s, g, cat, len, seqs, model,
      rtKey: id ? `${id}|${prev ? prevDate : date}` : null,
      sched, times: sched, sStart: sched[0], start: sched[0], end: sched[sched.length - 1],
      rt: null, // null = scheduled only, 'live' = real-time delays applied, 'cancel'
    };
  });
  state.maxDur = maxDur;
  state.date = date;
  state.selected = -1;
  state.follow = false;
  $('info').classList.add('hidden');
  $('date').textContent = prettyDate(date);
  applyRealtime();
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
    }
  } catch (e) {
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

function renderRealtimeStatus() {
  const el = $('rt-status');
  if (!el) return;
  const ago = rt.fetchedAt ? Math.round((Date.now() - rt.fetchedAt) / 1000) : null;
  let text, cls;
  if (rt.status === 'ok' && ago !== null && ago < 180) {
    const n = state.trips.filter((t) => t.rt).length;
    text = `● Real-time · ${n} trips · updated ${ago}s ago`; cls = 'ok';
  } else if (rt.status === 'no-key') { text = 'Scheduled timetable (no API key)'; cls = 'off'; }
  else if (rt.status === 'error') { text = `Real-time error: ${rt.error}`; cls = 'err'; }
  else if (rt.status === 'unreachable') { text = 'Real-time unavailable'; cls = 'err'; }
  else { text = 'Connecting to real-time…'; cls = 'off'; }
  el.textContent = text;
  el.className = 'rt ' + cls;
}

// ---------------------------------------------------------------- simulation
const ease = (f) => f - Math.sin(2 * Math.PI * f) / (2 * Math.PI); // accelerate, cruise, brake

/** Where is trip `tr` at time t? Returns {k, d} = segment index and distance along it, plus status. */
function locate(tr, t) {
  const T = tr.times, nStops = tr.s.length;
  for (let k = 0; k < nStops; k++) {
    const arr = T[2 * k], dep = T[2 * k + 1];
    if (t < arr) {
      // travelling from stop k-1 to k
      const seg = state.segs[tr.g[k - 1]];
      const prevDep = T[2 * k - 1];
      const f = arr > prevDep ? (t - prevDep) / (arr - prevDep) : 1;
      return { k: k - 1, d: ease(Math.min(1, Math.max(0, f))) * seg.len, next: k, atStop: false };
    }
    if (t <= dep) {
      // dwelling at stop k
      if (k < nStops - 1) return { k, d: 0, next: k, atStop: true };
      const seg = state.segs[tr.g[k - 1]];
      return { k: k - 1, d: seg.len, next: k, atStop: true };
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

/**
 * Points (local metres) at the given distances behind the head (k, d), following the track backwards.
 * `offsets` must be ascending. Before the start of the trip the last direction is extended.
 */
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

/** Polyline (metres, tail -> head) of the last `len` metres of the trip ending at (k, d). */
function bodyPath(tr, k, d, len) {
  const pts = [];
  let seg = state.segs[tr.g[k]];
  const [hx, hy, hi] = pointAt(seg, d);
  pts.push([hx, hy]);
  let remaining = len;
  let i = hi; // vertex index at or before head
  let px = hx, py = hy;
  let segK = k;
  for (;;) {
    while (i >= 0) {
      const vx = seg.xs[i], vy = seg.ys[i];
      const dd = Math.hypot(px - vx, py - vy);
      if (dd >= remaining) {
        const f = remaining / dd;
        pts.push([px + (vx - px) * f, py + (vy - py) * f]);
        return pts.reverse();
      }
      if (dd > 0.01) pts.push([vx, vy]);
      remaining -= dd; px = vx; py = vy;
      i--;
    }
    segK--;
    if (segK < 0) return pts.reverse();
    seg = state.segs[tr.g[segK]];
    i = seg.xs.length - 1;
  }
}

function outline(path, w) {
  const n = path.length;
  if (n < 2) return null;
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    const nx = -dy * w / 2, ny = dx * w / 2;
    left.push([(path[i][0] + nx) / MX, (path[i][1] + ny) / MY]);
    right.push([(path[i][0] - nx) / MX, (path[i][1] - ny) / MY]);
  }
  // slightly tapered nose so direction is readable
  const h = path[n - 1], p = path[n - 2];
  const L = Math.hypot(h[0] - p[0], h[1] - p[1]) || 1;
  const nose = [(h[0] + ((h[0] - p[0]) / L) * w * 0.25) / MX, (h[1] + ((h[1] - p[1]) / L) * w * 0.25) / MY];
  return [...left, nose, ...right.reverse()];
}

function firstActiveIndex(t) {
  // trips sorted by start; anything that started before t - maxDur is over
  // (sorted by scheduled start; allow up to an hour of delay)
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
  for (let i = firstActiveIndex(t); i < trips.length; i++) {
    const tr = trips[i];
    if (tr.sStart > t + 900) break; // nothing runs more than 15 min early
    if (tr.start > t || tr.end < t || tr.rt === 'cancel') continue;
    counts[tr.cat]++;
    if (state.hidden.has(tr.cat)) continue;
    const loc = locate(tr, t);
    if (!loc) continue;
    // cheap visibility test on the head position before building the 3D body
    const [hx, hy] = pointAt(state.segs[tr.g[loc.k]], loc.d);
    if ((hx < x0 || hx > x1 || hy < y0 || hy > y1) && i !== state.selected) continue;
    const sections = sectionsFor(tr.model, (offsets) => pointsBehind(tr, loc.k, loc.d, offsets));
    for (const sec of sections) { sec.lon = sec.x / MX; sec.lat = sec.y / MY; }
    out.push({ i, tr, loc, sections, head: [hx / MX, hy / MY], h: MODELS[tr.model].h, route: state.routes[tr.r] });
  }
  state.counts = counts;
  return out;
}

// ---------------------------------------------------------------- map + layers
let map, overlay;

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
    const e = byName.get(name) || { lon: 0, lat: 0, n: 0 };
    e.lon += lon; e.lat += lat; e.n++;
    byName.set(name, e);
  }
  const features = [];
  for (const [name, e] of byName) {
    features.push({ type: 'Feature', properties: { name: name.replace(/^Zürich,\s*/, '') }, geometry: { type: 'Point', coordinates: [e.lon / e.n, e.lat / e.n] } });
  }
  return { type: 'FeatureCollection', features };
}

let networkData, stopsData;

function addNativeLayers() {
  const night = state.theme === 'night';
  if (!map.getSource('network')) map.addSource('network', { type: 'geojson', data: networkData });
  if (!map.getSource('stops')) map.addSource('stops', { type: 'geojson', data: stopsData });
  const before = map.getLayer('building-3d') ? 'building-3d' : undefined;
  map.addLayer({
    id: 'network', type: 'line', source: 'network',
    layout: { 'line-cap': 'round', 'line-join': 'round', visibility: state.show.network ? 'visible' : 'none' },
    paint: {
      'line-color': ['match', ['get', 'cat'], 'tram', '#3d7bd9', 'rail', '#d1242f', 'ship', '#0aa2c0', 'funicular', '#8250df', '#2b8a3e'],
      'line-opacity': night ? 0.45 : 0.35,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 16, 3],
    },
  }, before);
  map.addLayer({
    id: 'stops-dot', type: 'circle', source: 'stops', minzoom: 13,
    layout: { visibility: state.show.stops ? 'visible' : 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2, 17, 5],
      'circle-color': night ? '#e8ecf1' : '#ffffff',
      'circle-stroke-color': night ? '#4ea1ff' : '#1b1f24',
      'circle-stroke-width': 1.2,
    },
  });
  map.addLayer({
    id: 'stops-label', type: 'symbol', source: 'stops', minzoom: 14.5,
    layout: {
      visibility: state.show.stops ? 'visible' : 'none',
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
      'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true,
    },
    paint: {
      'text-color': night ? '#e8ecf1' : '#1b1f24',
      'text-halo-color': night ? '#14181f' : '#ffffff', 'text-halo-width': 1.4,
    },
  });
  // the dark style ships without 3D buildings, so add them from the same vector tiles
  if (!map.getLayer('building-3d') && map.getSource('openmaptiles')) {
    map.addLayer({
      id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14,
      paint: { 'fill-extrusion-base': ['get', 'render_min_height'], 'fill-extrusion-height': ['get', 'render_height'] },
    }, 'network');
  }
  if (map.getLayer('building-3d')) {
    map.setLayoutProperty('building-3d', 'visibility', state.show.buildings ? 'visible' : 'none');
    map.setPaintProperty('building-3d', 'fill-extrusion-opacity', night ? 0.9 : 0.85);
    map.setPaintProperty('building-3d', 'fill-extrusion-color', night ? '#262c36' : 'hsl(35,8%,88%)');
  }
  // shops/restaurants icons clutter the 3D view
  for (const l of map.getStyle().layers) if (/^poi_/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
  map.setSky?.({
    'sky-color': night ? '#0b1020' : '#9cc8f0',
    'horizon-color': night ? '#1b2440' : '#e6f0f8',
    'fog-color': night ? '#0b1020' : '#e6f0f8',
    'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.7,
  });
}

function setTheme(theme) {
  state.theme = theme;
  document.body.classList.toggle('night', theme === 'night');
  map.setStyle(STYLES[theme]); // native layers are re-added by the 'style.load' handler
}

function buildLayers(vehicles) {
  const night = state.theme === 'night';
  const sel = state.selected;
  const layers = [];

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

  if (state.show.trails) {
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
    ? { ambient: 0.75, diffuse: 0.45, shininess: 32, specularColor: [80, 80, 80] }
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
  if (state.show.labels && zoom >= 14) {
    layers.push(new deck.TextLayer({
      id: 'labels', data: vehicles,
      getPosition: (v) => [v.sections[0].lon, v.sections[0].lat, v.h + 3],
      getText: (v) => v.route.n,
      getSize: 12, sizeUnits: 'pixels',
      getColor: [255, 255, 255],
      background: true, getBackgroundColor: (v) => [...v.route.rgb, 235], backgroundPadding: [4, 2],
      fontFamily: 'system-ui, Segoe UI, sans-serif', fontWeight: 700,
      characterSet: 'auto', billboard: true,
      parameters: { depthCompare: 'always' },
      updateTriggers: { getPosition: state.t },
    }));
  }
  return layers;
}

function trailPath(v) {
  // trail = last ~260 m behind the head, timestamps relative to head (0)
  const p = bodyPath(v.tr, v.loc.k, v.loc.d, 260);
  const ts = [];
  let acc = 0;
  for (let i = p.length - 1; i >= 0; i--) {
    if (i < p.length - 1) acc += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
    ts.push(-acc);
  }
  v._ts = ts.reverse();
  return p.map(([x, y]) => [x / MX, y / MY, 1]);
}

// ---------------------------------------------------------------- UI
function renderCounters() {
  const el = $('counters');
  el.innerHTML = '';
  for (const [cat, spec] of Object.entries(CATS)) {
    const has = state.trips.some((t) => t.cat === cat);
    if (!has) continue;
    const b = document.createElement('button');
    b.className = 'counter' + (state.hidden.has(cat) ? ' off' : '');
    b.dataset.cat = cat;
    const col = { tram: '#3d7bd9', bus: '#2b8a3e', rail: '#d1242f', ship: '#0aa2c0', funicular: '#8250df' }[cat];
    b.innerHTML = `<span class="dot" style="background:${col}"></span>${spec.label} <b data-count="${cat}">0</b>`;
    b.title = 'Click to show/hide';
    b.onclick = () => {
      state.hidden.has(cat) ? state.hidden.delete(cat) : state.hidden.add(cat);
      b.classList.toggle('off');
    };
    el.appendChild(b);
  }
}

function updateCounters() {
  for (const [cat, n] of Object.entries(state.counts || {})) {
    const el = document.querySelector(`[data-count="${cat}"]`);
    if (el && el.textContent !== String(n)) el.textContent = n;
  }
}

function realtimeLine(tr) {
  if (tr.rt === 'cancel') return '<div class="delay cancel">Cancelled</div>';
  if (tr.rt !== 'live') return '<div class="sub">No real-time data for this trip · scheduled times</div>';
  const d = Math.round(delayAt(tr, state.t) / 60);
  if (d === 0) return '<div class="delay ok">On time · real-time</div>';
  return `<div class="delay ${d > 0 ? 'late' : 'early'}">${d > 0 ? `${d} min late` : `${-d} min early`} · real-time</div>`;
}

function tooltipDelay(tr) {
  const d = delayAt(tr, state.t);
  if (d === null) return '';
  const m = Math.round(d / 60);
  return m === 0 ? ' · on time' : m > 0 ? ` · +${m} min` : ` · ${m} min`;
}

function renderInfo() {
  const sel = state.selected;
  if (sel < 0) { $('info').classList.add('hidden'); return; }
  const tr = state.trips[sel];
  const route = state.routes[tr.r];
  const loc = locate(tr, state.t);
  const next = loc ? loc.next : tr.s.length;
  const items = tr.s.map((s, k) => {
    const cls = k < next ? 'past' : k === next ? 'next' : '';
    const i = k === 0 ? 1 : 2 * k;
    const late = Math.round((tr.times[i] - tr.sched[i]) / 60);
    const lateTag = tr.rt === 'live' && late !== 0 ? `<span class="late ${late > 0 ? 'pos' : 'neg'}">${late > 0 ? '+' : ''}${late}</span>` : '';
    const skip = tr.skipped?.has(k) ? ' skipped' : '';
    return `<li class="${cls}${skip}"><span class="t">${fmtHM(tr.sched[i])}</span><span class="nm">${shortName(state.stops[s][2])}</span>${lateTag}</li>`;
  }).join('');
  const nextName = loc ? shortName(state.stops[tr.s[loc.next]][2]) : '';
  const status = !loc ? 'Not running' : loc.atStop ? `At ${nextName}` : `Next: ${nextName}`;
  $('info-body').innerHTML = `
    <div class="info-head"><span class="badge" style="background:${route.col}">${route.n}</span>
      <span class="to">→ ${shortName(tr.h || state.stops[tr.s[tr.s.length - 1]][2])}</span></div>
    <div class="sub">${route.a}${tr.n ? ` · trip ${tr.n}` : ''} · ${CATS[tr.cat].label.replace(/s$/, '')}</div>
    <div style="margin-top:8px">${status}</div>
    ${realtimeLine(tr)}
    <button class="follow ${state.follow ? 'on' : ''}" id="follow-btn">${state.follow ? 'Following — click to stop' : 'Follow this vehicle'}</button>
    <ul class="stoplist">${items}</ul>`;
  $('info').classList.remove('hidden');
  $('follow-btn').onclick = () => { state.follow = !state.follow; renderInfo(); };
  const nextEl = $('info-body').querySelector('li.next');
  if (nextEl && state.lastNext !== `${sel}:${next}`) { state.lastNext = `${sel}:${next}`; nextEl.scrollIntoView({ block: 'center' }); }
}

function select(i) {
  state.selected = i;
  state.follow = false;
  renderInfo();
}

function setSpeed(s) {
  state.speed = s;
  document.querySelectorAll('#speeds button').forEach((b) => b.classList.toggle('on', +b.dataset.speed === s));
}

function setLive(on) {
  state.live = on;
  $('live').classList.toggle('on', on);
  if (on) { state.playing = true; setSpeed(1); $('play').textContent = '❚❚'; }
}

function wireUi() {
  $('play').onclick = () => {
    state.playing = !state.playing;
    $('play').textContent = state.playing ? '❚❚' : '▶';
    if (!state.playing) setLive(false);
  };
  $('live').onclick = async () => {
    const now = zurichNow();
    if (now.date !== state.date && state.days.includes(now.date)) await loadDay(now.date);
    setLive(true);
  };
  document.querySelectorAll('#speeds button').forEach((b) => {
    b.onclick = () => { setSpeed(+b.dataset.speed); if (+b.dataset.speed !== 1) setLive(false); };
  });
  const slider = $('slider');
  slider.oninput = () => { state.t = +slider.value; setLive(false); };
  $('info-close').onclick = () => select(-1);
  for (const key of ['network', 'stops', 'labels', 'trails', 'buildings']) {
    $('l-' + key).onchange = (e) => {
      state.show[key] = e.target.checked;
      const vis = e.target.checked ? 'visible' : 'none';
      if (key === 'network' && map.getLayer('network')) map.setLayoutProperty('network', 'visibility', vis);
      if (key === 'stops') ['stops-dot', 'stops-label'].forEach((l) => map.getLayer(l) && map.setLayoutProperty(l, 'visibility', vis));
      if (key === 'buildings' && map.getLayer('building-3d')) map.setLayoutProperty('building-3d', 'visibility', vis);
    };
  }
  document.querySelectorAll('#theme button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#theme button').forEach((x) => x.classList.toggle('on', x === b));
      setTheme(b.dataset.theme);
    };
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (state.follow) { state.follow = false; renderInfo(); } else select(-1); }
    if (e.key === ' ' && e.target === document.body) { e.preventDefault(); $('play').click(); }
  });
}

// ---------------------------------------------------------------- main loop
let lastFrame = performance.now();
let lastInfo = 0;
let lastVehicles = 0;
let dayLoading = false;

async function tick(now) {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;

  if (state.live) {
    const z = zurichNow();
    if (z.date !== state.date && state.days.includes(z.date) && !dayLoading) {
      dayLoading = true; await loadDay(z.date); dayLoading = false;
    }
    state.t = z.sec;
  } else if (state.playing) {
    state.t += dt * state.speed;
    if (state.t >= 86400) {
      const next = addDays(state.date, 1);
      if (state.days.includes(next) && !dayLoading) { dayLoading = true; await loadDay(next); dayLoading = false; }
      state.t -= 86400;
    }
  }

  // Rebuilding every vehicle body is the expensive part, so at normal speed do it ~30x/s;
  // the map itself still renders at full frame rate while panning/zooming.
  const interval = state.follow || state.speed >= 60 ? 0 : 33;
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
    updateCounters();
  }

  const clock = fmtTime(state.t);
  if ($('clock').textContent !== clock) {
    $('clock').textContent = clock;
    if (document.activeElement !== $('slider')) $('slider').value = Math.floor(state.t);
  }
  if (now - lastInfo > 1000) { lastInfo = now; if (state.selected >= 0) renderInfo(); }
  requestAnimationFrame(tick);
}

async function main() {
  try {
    const idx = await loadJson('data/index.json');
    state.days = idx.days;
    await loadNetwork();
    const now = zurichNow();
    const day = state.days.includes(now.date) ? now.date : state.days[0];
    await loadDay(day);
    if (day !== now.date) {
      state.live = false;
      $('live').classList.remove('on');
      state.t = now.sec;
      $('sub').textContent = `No timetable for today — showing ${prettyDate(day)}. Run "npm run build:data".`;
    }
  } catch (e) {
    $('loading-text').textContent = `Could not load data (${e.message}). Run "npm run setup" first.`;
    document.querySelector('.spinner').remove();
    return;
  }

  networkData = networkGeojson();
  stopsData = stopsGeojson();

  map = new maplibregl.Map({
    container: 'map', style: STYLES.day, ...START_VIEW, maxPitch: 80,
    attributionControl: false,
    // High-DPI screens (e.g. 160% Windows scaling) multiply the pixels to draw; cap it.
    // MSAA is only worth it when not already rendering above 1x.
    pixelRatio: Math.min(window.devicePixelRatio || 1, 1.25),
    canvasContextAttributes: { antialias: (window.devicePixelRatio || 1) <= 1 },
  });
  // vehicles outside the old view must be rebuilt as soon as the view moves
  map.on('moveend', () => { state.dirty = true; });
  map.on('move', () => { if (performance.now() - lastVehicles > 100) state.dirty = true; });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  overlay = new deck.MapboxOverlay({
    interleaved: true,
    layers: [],
    onClick: (info) => { if (info.layer?.id.startsWith('veh-') && info.object) select(info.object.v.i); },
    getTooltip: ({ object, layer }) =>
      layer?.id.startsWith('veh-') && object ? { text: `${object.v.route.n} → ${shortName(object.v.tr.h)}${tooltipDelay(object.v.tr)}`, style: { fontSize: '12px', padding: '4px 8px', borderRadius: '6px' } } : null,
    getCursor: ({ isHovering }) => (isHovering ? 'pointer' : 'grab'),
  });
  map.addControl(overlay);
  window.zurich3d = { map, state, overlay, select }; // handy for debugging in the console
  map.on('style.load', () => { if (!map.getLayer('network')) addNativeLayers(); });
  map.on('dragstart', () => { if (state.follow) { state.follow = false; renderInfo(); } });

  renderCounters();
  wireUi();
  map.once('load', () => {
    $('loading').remove();
    requestAnimationFrame(tick);
    pollRealtime();
    setInterval(pollRealtime, 30_000);
    setInterval(renderRealtimeStatus, 5_000);
  });
}

main();
