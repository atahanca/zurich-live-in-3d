// Builds the frontend data from the Swiss GTFS feed + OSM network.
//
//   node scripts/build-timetable.js [--date YYYYMMDD] [--days N]
//
// Output (public/data/):
//   network.json            routes, stops and path geometry between consecutive stops
//   timetable-YYYYMMDD.json all trips running in the area on that service day
//   index.json              list of available days
import fs from 'node:fs';
import path from 'node:path';
import { readGtfs, timeToSec } from './lib/gtfs.js';
import { Graph, simplify } from './lib/graph.js';
import { BBOX, GTFS_ZIP, OUT_DIR, RAW_DIR, inBbox, categoryOf, TRAM_COLORS, CATEGORY_COLORS } from './config.js';

// ---------- args ----------
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const zurichToday = () => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p.replaceAll('-', '');
};
const startDate = arg('date', zurichToday());
const nDays = +arg('days', 2);

const ymdToDate = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const dateToYmd = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');
const addDays = (s, n) => { const d = ymdToDate(s); d.setUTCDate(d.getUTCDate() + n); return dateToYmd(d); };

// Day slots: slot 0 = day before the first requested day (for after-midnight trips).
const days = [];
for (let i = -1; i < nDays; i++) days.push(addDays(startDate, i));
const daySlot = new Map(days.map((d, i) => [d, i]));
console.log(`Building for ${days.slice(1).join(', ')} (bbox ${BBOX.join(',')})`);

if (!fs.existsSync(GTFS_ZIP)) {
  console.error(`Missing ${GTFS_ZIP}. Run: npm run fetch:gtfs`);
  process.exit(1);
}
const t0 = Date.now();
const lap = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`);

// ---------- agencies / routes ----------
const agencies = new Map();
await readGtfs(GTFS_ZIP, 'agency.txt', (r) => { agencies.set(r.agency_id, r.agency_name.replace(/ INFO\+$/, '')); });
const routes = new Map();
await readGtfs(GTFS_ZIP, 'routes.txt', (r) => {
  routes.set(r.route_id, { short: r.route_short_name, type: +r.route_type, agency: agencies.get(r.agency_id) || '', desc: r.route_desc });
});
lap(`${routes.size} routes`);

// ---------- stops ----------
const stops = new Map();
await readGtfs(GTFS_ZIP, 'stops.txt', (r) => {
  const lat = +r.stop_lat, lon = +r.stop_lon;
  stops.set(r.stop_id, { name: r.stop_name, lat, lon, inside: inBbox(lon, lat) });
});
lap(`${stops.size} stops`);

// ---------- calendar: which service_ids run on which day slot (bitmask) ----------
const services = new Map();
const weekdayCols = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
await readGtfs(GTFS_ZIP, 'calendar.txt', (r) => {
  let mask = 0;
  days.forEach((d, i) => {
    if (d < r.start_date || d > r.end_date) return;
    if (r[weekdayCols[ymdToDate(d).getUTCDay()]] === '1') mask |= 1 << i;
  });
  services.set(r.service_id, mask);
});
await readGtfs(GTFS_ZIP, 'calendar_dates.txt', (f, c) => {
  const slot = daySlot.get(f[c.date]);
  if (slot === undefined) return;
  const id = f[c.service_id];
  const m = services.get(id) || 0;
  services.set(id, f[c.exception_type] === '1' ? m | (1 << slot) : m & ~(1 << slot));
}, { raw: true, progressEvery: 2e6 });
lap(`${services.size} services`);

// ---------- trips active on any slot ----------
const trips = new Map();
await readGtfs(GTFS_ZIP, 'trips.txt', (f, c) => {
  const mask = services.get(f[c.service_id]);
  if (!mask) return;
  trips.set(f[c.trip_id], { route: f[c.route_id], head: f[c.trip_headsign], num: f[c.trip_short_name], mask });
}, { raw: true, progressEvery: 5e5 });
lap(`${trips.size} trips active in the window`);

const freqs = new Map();
await readGtfs(GTFS_ZIP, 'frequencies.txt', (r) => {
  if (!trips.has(r.trip_id)) return;
  if (!freqs.has(r.trip_id)) freqs.set(r.trip_id, []);
  freqs.get(r.trip_id).push([timeToSec(r.start_time), timeToSec(r.end_time), +r.headway_secs]);
});

// ---------- stop_times: keep the part of each trip that touches the area ----------
const kept = []; // {trip, stops:[id], arr:[], dep:[]}
let cur = null, curId = null;
function finishTrip() {
  if (!cur) return;
  const s = cur.stops;
  let first = -1, last = -1;
  for (let i = 0; i < s.length; i++) {
    if (stops.get(s[i])?.inside) { if (first < 0) first = i; last = i; }
  }
  if (first >= 0) {
    // extend one stop beyond the area on each side so vehicles drive in/out
    const a = Math.max(0, first - 1), b = Math.min(s.length - 1, last + 1);
    if (b > a) kept.push({ id: curId, stops: s.slice(a, b + 1), arr: cur.arr.slice(a, b + 1), dep: cur.dep.slice(a, b + 1), seq: cur.seq.slice(a, b + 1) });
  }
  cur = null;
}
await readGtfs(GTFS_ZIP, 'stop_times.txt', (f, c) => {
  const id = f[c.trip_id];
  if (id !== curId) {
    finishTrip();
    curId = id;
    if (trips.has(id)) cur = { stops: [], arr: [], dep: [], seq: [] };
  }
  if (!cur) return;
  cur.stops.push(f[c.stop_id]);
  cur.seq.push(+f[c.stop_sequence]);
  cur.arr.push(timeToSec(f[c.arrival_time] || f[c.departure_time]));
  cur.dep.push(timeToSec(f[c.departure_time] || f[c.arrival_time]));
}, { raw: true, progressEvery: 1e6 });
finishTrip();
lap(`${kept.length} trips touch the area`);

// ---------- network: graphs for snapping ----------
const loadOsm = (name) => {
  const p = path.join(RAW_DIR, `osm-${name}.json`);
  if (!fs.existsSync(p)) { console.warn(`  (no ${p}; ${name} paths will be straight lines — run npm run fetch:osm)`); return null; }
  return JSON.parse(fs.readFileSync(p, 'utf8')).elements;
};
const railEls = loadOsm('rail');
const roadEls = loadOsm('road');
const ROAD_COST = {
  motorway: 1, motorway_link: 1, trunk: 1, trunk_link: 1, primary: 1, primary_link: 1,
  secondary: 1.05, secondary_link: 1.05, tertiary: 1.1, tertiary_link: 1.1, busway: 0.9, bus_guideway: 0.9,
  unclassified: 1.3, residential: 1.4, road: 1.4, living_street: 2, service: 1.8, pedestrian: 2.5,
};
const sidingFactor = (t) => (/^(yard|siding|spur)$/.test(t.service || '') ? 3 : 1);
const graphs = {
  tram: railEls && new Graph(railEls, (t) => { const f = ({ tram: 1, light_rail: 1.1, narrow_gauge: 1.5, rail: 4 })[t.railway]; return f ? f * sidingFactor(t) : null; }),
  // no tram tracks here: mainline trains never use them (the Forchbahn runs as category 'tram')
  rail: railEls && new Graph(railEls, (t) => { const f = ({ rail: 1, narrow_gauge: 1, light_rail: 1, subway: 1, funicular: 1 })[t.railway]; return f ? f * sidingFactor(t) : null; }),
  bus: roadEls && new Graph(roadEls, (t) => ROAD_COST[t.highway] ?? null, true),
};
for (const [k, g] of Object.entries(graphs)) if (g) lap(`${k} graph: ${g.x.length} nodes`);

// ---------- build output tables ----------
const routeIdx = new Map(), routeOut = [];
const stopIdx = new Map(), stopOut = [];
const segIdx = new Map(), segOut = [];
const segStats = { snapped: 0, straight: 0 };
const getRoute = (rid) => {
  if (routeIdx.has(rid)) return routeIdx.get(rid);
  const r = routes.get(rid) || { short: '?', type: 3, agency: '' };
  const cat = categoryOf(r.type);
  let color = CATEGORY_COLORS[cat];
  if (cat === 'tram' && /Verkehrsbetriebe Z/.test(r.agency) && TRAM_COLORS[r.short]) color = TRAM_COLORS[r.short];
  // dedupe by (short name, category, agency): GTFS has many route_ids per line
  const key = `${r.short}|${cat}|${r.agency}`;
  if (routeIdx.has(key)) { routeIdx.set(rid, routeIdx.get(key)); return routeIdx.get(key); }
  const i = routeOut.length;
  routeOut.push({ n: r.short, c: cat, col: color, a: r.agency, t: r.type });
  routeIdx.set(rid, i); routeIdx.set(key, i);
  return i;
};
const getStop = (sid) => {
  if (stopIdx.has(sid)) return stopIdx.get(sid);
  const s = stops.get(sid);
  const i = stopOut.length;
  stopOut.push([+s.lon.toFixed(6), +s.lat.toFixed(6), s.name]);
  stopIdx.set(sid, i);
  return i;
};
const snapMode = { tram: 'tram', rail: 'rail', funicular: 'rail', bus: 'bus', ship: null };
const snapOpts = { tram: { radius: 60 }, rail: { radius: 80, detour: 2.5, slack: 600 }, bus: { radius: 45, detour: 3, slack: 400 } };
const getSeg = (cat, a, b) => {
  const mode = snapMode[cat];
  const key = `${mode}|${a}|${b}`;
  if (segIdx.has(key)) return segIdx.get(key);
  const A = stops.get(a), B = stops.get(b);
  let coords = null;
  if (mode && graphs[mode] && a !== b) {
    coords = graphs[mode].pathBetween(A, B, snapOpts[mode]);
    // buses: retry ignoring one-way restrictions is not possible on this graph, so fall back to straight
  }
  if (coords && coords.length >= 2) { segStats.snapped++; coords = simplify(coords, 1.5); }
  else { segStats.straight++; coords = [[A.lon, A.lat], [B.lon, B.lat]]; }
  const flat = [];
  for (const [lon, lat] of coords) flat.push(Math.round(lon * 1e5), Math.round(lat * 1e5));
  // delta-encode to shrink JSON
  for (let i = flat.length - 1; i >= 2; i--) flat[i] -= flat[i - 2];
  const i = segOut.length;
  segOut.push(flat);
  segIdx.set(key, i);
  return i;
};

const perDay = days.map(() => []);
let processed = 0;
for (const k of kept) {
  const trip = trips.get(k.id);
  const ri = getRoute(trip.route);
  const cat = routeOut[ri].c;
  const sIdx = k.stops.map(getStop);
  const contiguous = k.seq.every((v, i) => v === k.seq[0] + i);
  const seqOut = contiguous ? k.seq[0] : k.seq;
  const segs = [];
  for (let i = 0; i + 1 < k.stops.length; i++) segs.push(getSeg(cat, k.stops[i], k.stops[i + 1]));

  // frequency-based trips are expanded into individual runs
  const starts = [];
  const f = freqs.get(k.id);
  if (f) {
    for (const [s, e, hw] of f) for (let t = s; t < e; t += hw) starts.push(t - k.dep[0]);
  } else starts.push(0);
  // frequency-expanded runs share one trip_id, so real-time updates can't be matched to them
  const rtId = f ? '' : k.id;

  for (const off of starts) {
    const times = [];
    for (let i = 0; i < k.arr.length; i++) times.push(k.arr[i] + off, k.dep[i] + off);
    const lastT = times[times.length - 1];
    for (let slot = 0; slot < days.length; slot++) {
      if (!(trip.mask & (1 << slot))) continue;
      // trip of its own service day
      if (slot >= 1) perDay[slot].push({ r: ri, h: trip.head, n: trip.num, s: sIdx, g: segs, times, shift: 0, id: rtId, seq: seqOut });
      // after-midnight part shows up on the next day
      if (slot + 1 < days.length && lastT >= 86400) {
        perDay[slot + 1].push({ r: ri, h: trip.head, n: trip.num, s: sIdx, g: segs, times, shift: -86400, id: rtId, seq: seqOut });
      }
    }
  }
  if (++processed % 2000 === 0) process.stdout.write(`\r  paths: ${processed}/${kept.length} trips, ${segOut.length} segments`);
}
process.stdout.write('\n');
lap(`segments: ${segStats.snapped} snapped to OSM, ${segStats.straight} straight`);

// ---------- write ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
const network = { generated: new Date().toISOString(), bbox: BBOX, routes: routeOut, stops: stopOut, segments: segOut };
fs.writeFileSync(path.join(OUT_DIR, 'network.json'), JSON.stringify(network));
lap(`network.json: ${routeOut.length} lines, ${stopOut.length} stops, ${segOut.length} segments`);

const written = [];
for (let slot = 1; slot < days.length; slot++) {
  const list = perDay[slot]
    .map((t) => {
      const abs = t.times.map((x) => x + t.shift);
      return { ...t, abs };
    })
    .filter((t) => t.abs[t.abs.length - 1] >= 0)
    .sort((a, b) => a.abs[0] - b.abs[0]);
  // compact: t = [start, then deltas]
  const out = list.map((t) => {
    const d = [t.abs[0]];
    for (let i = 1; i < t.abs.length; i++) d.push(t.abs[i] - t.abs[i - 1]);
    // prev = 1 when the trip belongs to the previous service day (after-midnight part)
    return [t.r, t.h, t.n, t.s, t.g, d, t.id, t.shift ? 1 : 0, t.seq];
  });
  const file = `timetable-${days[slot]}.json`;
  fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify({ date: days[slot], fields: ['route', 'headsign', 'number', 'stops', 'segments', 'times', 'tripId', 'prevDay', 'stopSequence'], trips: out }));
  written.push(days[slot]);
  lap(`${file}: ${out.length} trips`);
}
// segment/stop indices are only valid together with this network.json, so drop older timetables
for (const f of fs.readdirSync(OUT_DIR)) {
  const m = /^timetable-(\d{8})\.json$/.exec(f);
  if (m && !written.includes(m[1])) fs.unlinkSync(path.join(OUT_DIR, f));
}
fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({ days: written, generated: network.generated }));
lap('done');
