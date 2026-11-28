// Zurich Airport detail: runway and taxiway markings by day, airfield lighting at night.
// Runway geometry comes from the OpenStreetMap runway centrelines (ends measured from the base map
// tiles); taxiways and aprons are drawn straight from the base map's vector tiles. The lighting
// follows the usual ICAO layout, simplified; it shows what an airfield looks like, not the exact
// fixtures in service at Zurich.

// Runway ends: [lon, lat] of each threshold, the designator painted there and whether that end has
// an instrument approach (approach lights, touchdown zone lights, PAPI).
const RUNWAYS = [
  { width: 60, ends: [{ at: [8.535937, 47.475712], name: '16', ils: true }, { at: [8.556697, 47.445562], name: '34', ils: true }] },
  { width: 60, ends: [{ at: [8.534725, 47.483076], name: '14', ils: true }, { at: [8.56446, 47.46129], name: '32', ils: false }] },
  { width: 60, ends: [{ at: [8.537477, 47.45894], name: '10', ils: false }, { at: [8.570452, 47.456597], name: '28', ils: true }] },
];

// [west, south, east, north] around the runways and approach lights
const AREA = [8.51, 47.43, 8.595, 47.495];
const LAT0 = 47.46;
const M_LAT = 111320;
const M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const PX_PER_M_Z0 = 512 / (40075016 * Math.cos(LAT0 * Math.PI / 180)); // MapLibre uses 512 px tiles

/** A width of `m` metres on the ground, as a zoom-dependent line/circle size in pixels. */
const metres = (m, min = 0) => ['interpolate', ['exponential', 2], ['zoom'],
  10, Math.max(min, m * PX_PER_M_Z0 * 2 ** 10), 22, Math.max(min, m * PX_PER_M_Z0 * 2 ** 22)];

const COLORS = { w: '#fff4d6', y: '#ffc93c', r: '#ff3b2f', g: '#2dff7c', b: '#3d6bff' };

/** Local frame for one runway end: walk `s` metres along the runway and `l` metres to the left. */
function frame(from, to) {
  const dx = (to[0] - from[0]) * M_LON, dy = (to[1] - from[1]) * M_LAT;
  const len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
  const at = (s, l = 0) => [from[0] + (ux * s - uy * l) / M_LON, from[1] + (uy * s + ux * l) / M_LAT];
  const heading = (Math.atan2(ux, uy) * 180 / Math.PI + 360) % 360;
  return { len, at, heading };
}

const point = (coordinates, props) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates } });
const line = (coordinates, props) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates } });

function buildLights() {
  const lights = [], flash = [];
  const add = (c, color) => lights.push(point(c, { c: color }));
  for (const rw of RUNWAYS) {
    const half = rw.width / 2;
    for (const [i, end] of rw.ends.entries()) {
      const other = rw.ends[1 - i];
      const { len, at } = frame(end.at, other.at);
      if (i === 0) {
        // edge lights every 60 m (yellow in the last 600 m), centreline every 15 m
        // (red/white alternating from 900 m before the end, red in the last 300 m)
        for (let s = 0; s <= len + 0.1; s += 60) {
          const toEnd = Math.min(s, len - s);
          for (const side of [-1, 1]) add(at(s, side * (half + 1.5)), toEnd < 600 ? 'y' : 'w');
        }
        for (let s = 7.5, k = 0; s < len; s += 15, k++) {
          const toEnd = Math.min(s, len - s);
          add(at(s), toEnd < 300 ? 'r' : toEnd < 900 ? (k % 2 ? 'r' : 'w') : 'w');
        }
      }
      // threshold: green bar across the runway, red stop bar just inside it
      for (let l = -half; l <= half + 0.1; l += 3) { add(at(-2, l), 'g'); add(at(2, l), 'r'); }
      // wing bars just outside the runway edges
      for (let l = half + 3; l <= half + 15; l += 3) for (const side of [-1, 1]) add(at(-2, side * l), 'g');
      if (!end.ils) continue;
      // touchdown zone: rows of white bars either side of the centreline for the first 900 m
      for (let s = 60; s <= 900; s += 60) for (const side of [-1, 1]) for (const l of [9, 10.5, 12]) add(at(s, side * l), 'w');
      // approach lights: centreline barrettes out to 900 m, crossbar at 300 m, red side rows near the runway
      for (let s = 30; s <= 900; s += 30) for (let l = -2; l <= 2; l += 1) add(at(-s, l), 'w');
      for (let l = 4; l <= 22; l += 1.5) for (const side of [-1, 1]) add(at(-300, side * l), 'w');
      for (let s = 30; s <= 270; s += 30) for (const l of [11, 12.5, 14]) for (const side of [-1, 1]) add(at(-s, side * l), 'r');
      // the "rabbit": sequenced flashers racing towards the runway, twice a second
      for (let s = 900, k = 0; s >= 330; s -= 30, k++) flash.push(point(at(-s, 0), { k }));
      // PAPI on the left: two white, two red on the glide path
      for (let j = 0; j < 4; j++) add(at(330, -(half + 15 + j * 9)), j < 2 ? 'w' : 'r');
    }
  }
  return { lights: { type: 'FeatureCollection', features: lights }, flash: { type: 'FeatureCollection', features: flash }, flashers: flash.length / RUNWAYS.flatMap((r) => r.ends).filter((e) => e.ils).length };
}

function buildMarkings() {
  const lines = [], labels = [];
  for (const rw of RUNWAYS) {
    const half = rw.width / 2;
    const { len, at } = frame(rw.ends[0].at, rw.ends[1].at);
    // side stripes along both edges and the dashed centreline
    for (const side of [-1, 1]) lines.push(line([at(0, side * (half - 1)), at(len, side * (half - 1))], { w: 0.9 }));
    for (let s = 120; s + 30 < len - 110; s += 50) lines.push(line([at(s), at(s + 30)], { w: 0.9 }));
    for (const [i, end] of rw.ends.entries()) {
      const f = frame(end.at, rw.ends[1 - i].at);
      // threshold "piano keys": 8 stripes either side of the centreline
      for (let j = 0; j < 8; j++) for (const side of [-1, 1]) {
        const l = side * (3.5 + j * 3.4);
        lines.push(line([f.at(6, l), f.at(36, l)], { w: 1.8 }));
      }
      // aiming point blocks 400 m in, touchdown zone pairs along the first 900 m
      for (const side of [-1, 1]) lines.push(line([f.at(400, side * 14), f.at(460, side * 14)], { w: 9 }));
      for (const s of [150, 300, 550, 700, 850]) for (const side of [-1, 1]) for (const l of [10, 13, 16].slice(0, s < 300 ? 3 : s < 600 ? 2 : 1)) {
        lines.push(line([f.at(s, side * l), f.at(s + 22, side * l)], { w: 1.8 }));
      }
      labels.push(point(f.at(62), { name: end.name, rot: f.heading }));
    }
  }
  return { lines: { type: 'FeatureCollection', features: lines }, labels: { type: 'FeatureCollection', features: labels } };
}

const LIGHTS = buildLights();
const MARKINGS = buildMarkings();
const MARKING_LAYERS = ['ap-runway', 'ap-taxiway', 'ap-taxi-line', 'ap-marks', 'ap-numbers'];
export const AIRPORT_LAYERS = [...MARKING_LAYERS, 'ap-taxi-glow', 'ap-taxi-lights', 'ap-apron-lights', 'ap-glow', 'ap-lights', 'ap-flash'];

const taxiways = ['all', ['==', ['get', 'class'], 'taxiway'], ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false]];
const runways = ['all', ['==', ['get', 'class'], 'runway'], ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false]];
const aprons = ['all', ['==', ['get', 'class'], 'apron'], ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false]];

export const airport = {
  /** Add the airport layers; call after every style load. `lightsBefore` keeps lights under the vehicles. */
  add(map, night, lightsBefore) {
    if (!map.getSource('openmaptiles')) return;
    for (const [id, data] of [['ap-lights', LIGHTS.lights], ['ap-flash', LIGHTS.flash], ['ap-marks', MARKINGS.lines], ['ap-labels', MARKINGS.labels]]) {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data });
    }
    // markings sit right above the style's own runway surfaces, under roads and labels
    const layers = map.getStyle().layers;
    const runwayIdx = layers.findIndex((l) => l.id === 'aeroway-runway');
    const marksBefore = runwayIdx >= 0 ? layers[runwayIdx + 1]?.id : undefined;
    const paintColor = night ? '#c9ccd2' : '#ffffff';
    const markOpacity = night ? 0.28 : 0.95;
    // asphalt: the base map paints runways almost white by day, which hides the markings
    map.addLayer({
      id: 'ap-runway', type: 'fill', source: 'openmaptiles', 'source-layer': 'aeroway', minzoom: 11, filter: runways,
      paint: { 'fill-color': night ? '#121418' : '#8f959c', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 12.5, 1] },
    }, marksBefore);
    map.addLayer({
      id: 'ap-taxiway', type: 'line', source: 'openmaptiles', 'source-layer': 'aeroway', minzoom: 12, filter: taxiways,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': night ? '#17191d' : '#a9aeb4', 'line-width': metres(23, 1), 'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 13.5, 1] },
    }, marksBefore);
    map.addLayer({
      id: 'ap-taxi-line', type: 'line', source: 'openmaptiles', 'source-layer': 'aeroway', minzoom: 14, filter: taxiways,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': night ? '#9c8536' : '#f0c020', 'line-width': metres(0.6, 0.6), 'line-opacity': night ? 0.45 : 0.9 },
    }, marksBefore);
    map.addLayer({
      id: 'ap-marks', type: 'line', source: 'ap-marks', minzoom: 13.5,
      layout: { 'line-cap': 'butt' },
      paint: {
        'line-color': paintColor, 'line-opacity': markOpacity,
        'line-width': ['interpolate', ['exponential', 2], ['zoom'], 10, ['*', ['get', 'w'], PX_PER_M_Z0 * 2 ** 10], 22, ['*', ['get', 'w'], PX_PER_M_Z0 * 2 ** 22]],
      },
    }, marksBefore);
    map.addLayer({
      id: 'ap-numbers', type: 'symbol', source: 'ap-labels', minzoom: 14.5,
      layout: {
        'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': metres(18),
        'text-rotate': ['get', 'rot'], 'text-rotation-alignment': 'map', 'text-pitch-alignment': 'map',
        'text-allow-overlap': true, 'text-ignore-placement': true, 'text-letter-spacing': 0.15,
      },
      paint: { 'text-color': paintColor, 'text-opacity': markOpacity },
    }, marksBefore);
    if (!night) return;

    const flat = { 'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'map' };
    const colour = ['match', ['get', 'c'], 'y', COLORS.y, 'r', COLORS.r, 'g', COLORS.g, 'b', COLORS.b, COLORS.w];
    // taxiway centreline lights (green) with a faint glow, blue edge lights around the aprons
    map.addLayer({
      id: 'ap-taxi-glow', type: 'line', source: 'openmaptiles', 'source-layer': 'aeroway', minzoom: 11, filter: taxiways,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': COLORS.g,
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 11, 1.5, 14, 4, 17, 14],
        'line-blur': ['interpolate', ['exponential', 1.6], ['zoom'], 11, 1.5, 14, 4, 17, 12],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.25, 15, 0.12],
      },
    }, lightsBefore);
    map.addLayer({
      id: 'ap-taxi-lights', type: 'line', source: 'openmaptiles', 'source-layer': 'aeroway', minzoom: 13.5, filter: taxiways,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#8dffb6', 'line-width': metres(1.4, 1.2), 'line-dasharray': [0, 11], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.5, 0.95] },
    }, lightsBefore);
    map.addLayer({
      id: 'ap-apron-lights', type: 'line', source: 'openmaptiles', 'source-layer': 'aeroway', minzoom: 13.5, filter: aprons,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#7d9bff', 'line-width': metres(1.6, 1.2), 'line-dasharray': [0, 25], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.5, 0.9] },
    }, lightsBefore);
    // runway, approach and threshold lights: a soft coloured halo with a bright core
    map.addLayer({
      id: 'ap-glow', type: 'circle', source: 'ap-lights', minzoom: 10,
      paint: {
        ...flat, 'circle-color': colour, 'circle-blur': 1,
        'circle-radius': ['interpolate', ['exponential', 1.7], ['zoom'], 10, 1.5, 14, 3.5, 17, 9, 20, 28],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 14, 0.4, 17, 0.3],
      },
    }, lightsBefore);
    map.addLayer({
      id: 'ap-lights', type: 'circle', source: 'ap-lights', minzoom: 12,
      paint: {
        ...flat, 'circle-color': ['match', ['get', 'c'], 'y', '#ffe28a', 'r', '#ff6a5c', 'g', '#8dffb6', 'b', '#8ca6ff', '#ffffff'],
        'circle-radius': ['interpolate', ['exponential', 1.7], ['zoom'], 12, 0.6, 15, 1.1, 18, 2.6, 20, 6],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 13, 1],
      },
    }, lightsBefore);
    map.addLayer({
      id: 'ap-flash', type: 'circle', source: 'ap-flash', minzoom: 10,
      paint: {
        ...flat, 'circle-color': '#ffffff', 'circle-blur': 0.6, 'circle-opacity': 0,
        'circle-radius': ['interpolate', ['exponential', 1.7], ['zoom'], 10, 3, 14, 7, 17, 20, 20, 60],
      },
    }, lightsBefore);
    this.lastFlash = -1;
  },

  /** Show the painted markings only on the street basemap (aerial imagery has the real ones). */
  setMarkings(map, on) {
    for (const id of MARKING_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  },

  /** Run the approach flashers; cheap to call every frame. Each step repaints the map, so only
   *  animate while the airport is on screen. */
  frame(map, now) {
    if (!map.getLayer('ap-flash') || map.getZoom() < 10) return;
    const b = map.getBounds();
    if (b.getEast() < AREA[0] || b.getWest() > AREA[2] || b.getNorth() < AREA[1] || b.getSouth() > AREA[3]) return;
    const n = LIGHTS.flashers;
    const k = Math.floor((now % 500) / 500 * (n + 4)); // a short dark pause after each run
    if (k === this.lastFlash) return;
    this.lastFlash = k;
    map.setPaintProperty('ap-flash', 'circle-opacity', k < n ? ['case', ['==', ['get', 'k'], k], 1, ['==', ['get', 'k'], k - 1], 0.25, 0] : 0);
  },
};
