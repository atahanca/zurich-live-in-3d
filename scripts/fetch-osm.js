// Downloads the rail/tram and road network for the Zurich area from OpenStreetMap (Overpass API).
// Output: data/raw/osm-rail.json, data/raw/osm-road.json
// Tiles are cached in data/raw/osm-tiles/ so an interrupted run resumes where it stopped.
//   node scripts/fetch-osm.js [--force]
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { BBOX, OSM_DIR, RAW_DIR } from './config.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const TILE_DIR = path.join(RAW_DIR, 'osm-tiles');
const FORCE = process.argv.includes('--force');

// Overpass bbox order is south,west,north,east
const RAIL_PAD = 0.08; // rail gets a wider box so trains entering/leaving follow real tracks
const RAIL_BBOX = [BBOX[1] - RAIL_PAD, BBOX[0] - RAIL_PAD, BBOX[3] + RAIL_PAD, BBOX[2] + RAIL_PAD];
const ROAD_BBOX = [BBOX[1], BBOX[0], BBOX[3], BBOX[2]];

const FILTERS = {
  rail: 'way["railway"~"^(rail|light_rail|tram|narrow_gauge|subway|funicular)$"]',
  road:
    'way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|busway|bus_guideway|road|pedestrian)$"]' +
    '["access"!~"^(private|no)$"]["service"!~"^(parking_aisle|driveway|drive-through)$"]',
};
const query = (filter, b) => `[out:json][timeout:180];(${filter}(${b.map((v) => v.toFixed(5)).join(',')}););out body;>;out skel qt;`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryOnce(q) {
  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'zurich-3d-data-prep/0.1' },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(200_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(json.remark);
      return json;
    } catch (e) {
      console.warn(`    ${new URL(ep).host}: ${e.message}`);
    }
  }
  return null;
}

// Fetch a bbox; on failure split it into 4 smaller tiles (up to `depth` times).
async function fetchTile(name, b, depth = 0) {
  const file = path.join(TILE_DIR, `${name}-${b.map((v) => v.toFixed(4)).join('_')}.json`);
  if (fs.existsSync(file) && !FORCE) return JSON.parse(fs.readFileSync(file, 'utf8')).elements;
  console.log(`  ${name} ${b.map((v) => v.toFixed(3)).join(',')}`);
  for (let attempt = 0; attempt < (depth >= 2 ? 4 : 1); attempt++) {
    if (attempt) await sleep(20000 * attempt);
    const json = await tryOnce(query(FILTERS[name], b));
    if (json) {
      fs.writeFileSync(file, JSON.stringify({ elements: json.elements }));
      return json.elements;
    }
  }
  if (depth >= 2) throw new Error(`Could not fetch ${name} tile ${b}`);
  const [s, w, n, e] = b, my = (s + n) / 2, mx = (w + e) / 2;
  const out = [];
  for (const sub of [[s, w, my, mx], [s, mx, my, e], [my, w, n, mx], [my, mx, n, e]]) out.push(...(await fetchTile(name, sub, depth + 1)));
  return out;
}

function tiles(b, n) {
  const [s, w, no, e] = b, dy = (no - s) / n, dx = (e - w) / n;
  const out = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push([s + i * dy, w + j * dx, s + (i + 1) * dy, w + (j + 1) * dx]);
  return out;
}

async function fetchLayer(name, tileList) {
  const out = path.join(RAW_DIR, `osm-${name}.json`);
  if (fs.existsSync(out) && !FORCE) { console.log(`  ${name}: cached (use --force to refetch)`); snapshot(name, fs.readFileSync(out)); return; }
  const seen = new Set();
  const elements = [];
  for (const t of tileList) {
    for (const el of await fetchTile(name, t)) {
      const k = el.type[0] + el.id;
      if (!seen.has(k)) { seen.add(k); elements.push(el); }
    }
  }
  const text = JSON.stringify({ elements });
  fs.writeFileSync(out, text);
  console.log(`  ${name}: ${elements.length} elements, ${(text.length / 1e6).toFixed(1)} MB`);
  snapshot(name, text);
}

/** Update the committed copy in data/osm/ that builds fall back to when data/raw/ is empty. */
function snapshot(name, text) {
  fs.mkdirSync(OSM_DIR, { recursive: true });
  fs.writeFileSync(path.join(OSM_DIR, `osm-${name}.json.gz`), zlib.gzipSync(text, { level: 9 }));
}

fs.mkdirSync(TILE_DIR, { recursive: true });
await fetchLayer('rail', [RAIL_BBOX]);
await fetchLayer('road', tiles(ROAD_BBOX, 3));
