import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RAW_DIR = path.join(ROOT, 'data', 'raw');
export const OUT_DIR = path.join(ROOT, 'public', 'data');
export const GTFS_ZIP = path.join(RAW_DIR, 'gtfs.zip');
// Compressed copy of the OSM network that is committed to git, so a build machine doesn't have
// to query the (often busy) Overpass servers. `npm run fetch:osm` refreshes it.
export const OSM_DIR = path.join(ROOT, 'data', 'osm');
// The Swiss timetable year starts mid-December, so from ~13 Dec the next year's dataset applies.
export function gtfsUrls(now = new Date()) {
  const y = new Date(now.getTime() + 19 * 864e5).getUTCFullYear();
  const u = (yr) => `https://data.opentransportdata.swiss/dataset/timetable-${yr}-gtfs2020/permalink`;
  return [u(y), u(y - 1)];
}

// Area of interest: City of Zurich plus immediate surroundings.
// [west, south, east, north]
export const BBOX = [8.44, 47.315, 8.63, 47.44];

export function inBbox(lon, lat, b = BBOX) {
  return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
}

// GTFS (extended) route_type -> our vehicle category
export function categoryOf(routeType) {
  const t = +routeType;
  if (t === 0 || (t >= 900 && t < 1000)) return 'tram';
  if (t === 3 || (t >= 700 && t < 800) || (t >= 200 && t < 300) || t === 11 || t === 800) return 'bus';
  if (t === 4 || (t >= 1000 && t < 1100) || t === 1200) return 'ship';
  if (t === 6 || t === 7 || (t >= 1300 && t < 1500)) return 'funicular';
  if (t === 1 || (t >= 400 && t < 500)) return 'rail';
  if (t === 2 || (t >= 100 && t < 200)) return 'rail';
  return 'bus';
}

// Approximate VBZ tram line colours (from the public network map).
export const TRAM_COLORS = {
  '2': '#E3000F', '3': '#00A04F', '4': '#1F3A8C', '5': '#8B5A2B', '6': '#C77B30',
  '7': '#000000', '8': '#94C11F', '9': '#5A3E91', '10': '#E5007D', '11': '#00A651',
  '12': '#7FCBE5', '13': '#FFCC00', '14': '#00A0E0', '15': '#E3000F', '17': '#8E1E5A',
};

export const CATEGORY_COLORS = {
  tram: '#1f6feb',
  bus: '#2b8a3e',
  rail: '#d1242f',
  ship: '#0aa2c0',
  funicular: '#8250df',
};
