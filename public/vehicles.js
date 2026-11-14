// Realistic-ish vehicle models: procedural meshes + painted liveries, split into
// articulated sections that each follow the track (so long vehicles bend through curves).
//
// A model is a list of sections (length in metres) plus a mesh variant and a livery.
// Every section is drawn as one instance of a unit mesh scaled to [length, width, height].

// ---------------------------------------------------------------- vehicle catalogue
// Lengths approximate the real vehicles; gaps are the articulation joints.
export const MODELS = {
  flexity:  { sections: [6.2, 5.4, 6.2, 5.4, 6.2, 5.4, 6.2], gap: 0.35, w: 2.4, h: 3.5, mesh: 'tram', livery: 'vbz', pantograph: 3 },
  cobra:    { sections: [9.0, 4.4, 8.4, 4.4, 9.0], gap: 0.35, w: 2.4, h: 3.5, mesh: 'tram', livery: 'vbz', pantograph: 2 },
  tram2000: { sections: [10.6, 10.6, 0.8, 15.0], gap: 0.4, w: 2.2, h: 3.4, mesh: 'tram', livery: 'vbzOld', pantograph: 0, hideSection: 2 },
  lmb:      { sections: [6.2, 5.4, 6.2, 5.4, 6.2, 5.4, 6.2], gap: 0.35, w: 2.4, h: 3.5, mesh: 'tram', livery: 'lmb', pantograph: 3 },
  forch:    { sections: [19.0, 19.0], gap: 0.6, w: 2.4, h: 3.6, mesh: 'tram', livery: 'forch', pantograph: 0 },
  bus12:    { sections: [12.0], gap: 0, w: 2.55, h: 3.1, mesh: 'bus', livery: 'vbzBus' },
  bus18:    { sections: [10.9, 7.2], gap: 0.5, w: 2.55, h: 3.1, mesh: 'bus', livery: 'vbzBus' },
  trolley:  { sections: [11.2, 7.4], gap: 0.5, w: 2.55, h: 3.2, mesh: 'bus', livery: 'vbzBus', poles: 1 },
  post12:   { sections: [12.0], gap: 0, w: 2.55, h: 3.1, mesh: 'bus', livery: 'postauto' },
  post18:   { sections: [10.9, 7.2], gap: 0.5, w: 2.55, h: 3.1, mesh: 'bus', livery: 'postauto' },
  busOther: { sections: [12.0], gap: 0, w: 2.55, h: 3.1, mesh: 'bus', livery: 'genericBus' },
  sbahn:    { sections: [25, 26.5, 26.5, 25], gap: 0.6, w: 2.8, h: 4.6, mesh: 'train', livery: 'sbbDD' },
  ic:       { sections: [26.5, 26.5, 26.5, 26.5, 26.5, 26.5, 26.5, 18.5], gap: 0.6, w: 2.8, h: 4.6, mesh: 'train', livery: 'sbbDD' },
  regio:    { sections: [24, 24, 24], gap: 0.6, w: 2.8, h: 3.9, mesh: 'train', livery: 'red' },
  ship:     { sections: [44], gap: 0, w: 8.5, h: 2.6, mesh: 'ship', livery: 'ship', cabin: true },
  funi:     { sections: [12], gap: 0, w: 2.6, h: 3.3, mesh: 'tram', livery: 'funi' },
};

const TROLLEY_LINES = new Set(['31', '32', '33', '46', '72']);

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/** Pick a model for a trip. Which physical vehicle runs a trip isn't published, so the mix is approximate. */
export function modelFor(route, tripKey) {
  const r = hash(tripKey || route.n);
  const ag = route.a || '';
  switch (route.c) {
    case 'tram':
      if (/Forchbahn/.test(ag)) return 'forch';
      if (/Aargau Verkehr|Limmattal/.test(ag)) return 'lmb';
      return r < 0.45 ? 'flexity' : r < 0.8 ? 'cobra' : 'tram2000';
    case 'bus':
      if (/PostAuto/.test(ag)) return r < 0.5 ? 'post12' : 'post18';
      if (/Verkehrsbetriebe Z/.test(ag)) {
        if (TROLLEY_LINES.has(route.n)) return 'trolley';
        return r < 0.6 ? 'bus18' : 'bus12';
      }
      return 'busOther';
    case 'rail':
      if (/Sihltal|Forchbahn/.test(ag)) return 'regio';
      return [101, 102, 103, 2].includes(route.t) ? 'ic' : 'sbahn';
    case 'ship': return 'ship';
    case 'funicular': return 'funi';
    default: return 'busOther';
  }
}

// ---------------------------------------------------------------- meshes
// Unit body: x ∈ [-0.5, 0.5] (length), y ∈ [-0.5, 0.5] (width), z ∈ [0, 1] (height).
// Texture atlas: u 0–0.75 = side livery, u 0.75–1 = front/back face; v 0–0.85 = body height, v > 0.9 = roof.
const SIDE_U = 0.75;

function buildMesh({ roofRound = 0.12, skirt = 0.07, extras = [] } = {}) {
  const P = [], N = [], T = [];
  const tri = (a, b, c, n, ta, tb, tc) => { P.push(...a, ...b, ...c); N.push(...n, ...n, ...n); T.push(...ta, ...tb, ...tc); };
  const quad = (a, b, c, d, n, ta, tb, tc, td) => { tri(a, b, c, n, ta, tb, tc); tri(a, c, d, n, ta, tc, td); };

  // cross-section profile (y, z), counter-clockwise seen from the front, with v-coordinates for texturing
  const r = roofRound;
  const prof = [
    [0.5 - 0.04, 0, 0], [0.5, skirt, skirt * 0.85], [0.5, 1 - r, (1 - r) * 0.85],
    [0.5 - r * 0.7, 1, 0.9], [-(0.5 - r * 0.7), 1, 0.98],
    [-0.5, 1 - r, (1 - r) * 0.85], [-0.5, skirt, skirt * 0.85], [-(0.5 - 0.04), 0, 0],
  ];
  // sides along the length
  for (let i = 0; i < prof.length - 1; i++) {
    const [y1, z1, v1] = prof[i], [y2, z2, v2] = prof[i + 1];
    const ny = z2 - z1, nz = -(y2 - y1);
    const L = Math.hypot(ny, nz) || 1;
    const n = [0, ny / L, nz / L];
    const isRoof = z1 >= 1 - r - 1e-6 && z2 >= 1 - r - 1e-6;
    const va = isRoof ? 0.92 : v1, vb = isRoof ? 0.99 : v2;
    // left side (y<0) gets mirrored u so text-free liveries look the same from both sides
    quad([-0.5, y1, z1], [0.5, y1, z1], [0.5, y2, z2], [-0.5, y2, z2], n,
      [0, va], [SIDE_U, va], [SIDE_U, vb], [0, vb]);
  }
  // end caps (front x=+0.5, back x=-0.5) as triangle fans
  for (const sx of [0.5, -0.5]) {
    const n = [Math.sign(sx), 0, 0];
    const c = [sx, 0, 0.5];
    const cu = SIDE_U + (1 - SIDE_U) / 2;
    for (let i = 0; i < prof.length; i++) {
      const [y1, z1] = prof[i], [y2, z2] = prof[(i + 1) % prof.length];
      const ua = SIDE_U + (0.5 - y1 * Math.sign(sx)) * (1 - SIDE_U), ub = SIDE_U + (0.5 - y2 * Math.sign(sx)) * (1 - SIDE_U);
      const a = [sx, y1, z1], b = [sx, y2, z2];
      if (sx > 0) tri(c, a, b, n, [cu, 0.42], [ua, z1 * 0.85], [ub, z2 * 0.85]);
      else {
        // rear face: plain body livery taken from the side texture (no windscreen)
        const ra = 0.002 + (0.5 + y1) * 0.004, rb = 0.002 + (0.5 + y2) * 0.004;
        tri(c, b, a, n, [0.004, 0.42], [rb, z2 * 0.85], [ra, z1 * 0.85]);
      }
    }
  }
  // extras: boxes (roof units) and rods (pantograph arms, trolley poles), textured with the roof colour
  for (const e of extras) {
    if (e.rod) addRod(P, N, T, e.rod[0], e.rod[1], e.t || 0.02, [0.95, 0.93]);
    else addBox(P, N, T, ...e, [0.95, 0.93]);
  }
  return {
    attributes: {
      positions: { value: new Float32Array(P), size: 3 },
      normals: { value: new Float32Array(N), size: 3 },
      texCoords: { value: new Float32Array(T), size: 2 },
    },
  };
}

function addBox(P, N, T, x0, x1, y0, y1, z0, z1, uv) {
  const v = (x, y, z) => [x, y, z];
  const faces = [
    [[v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)], [0, 0, 1]],
    [[v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)], [0, -1, 0]],
    [[v(x1, y1, z0), v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1)], [0, 1, 0]],
    [[v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)], [1, 0, 0]],
    [[v(x0, y1, z0), v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1)], [-1, 0, 0]],
  ];
  for (const [[a, b, c, d], n] of faces) {
    for (const p of [a, b, c, a, c, d]) { P.push(...p); N.push(...n); T.push(...uv); }
  }
}

/** Thin square rod from point a to b (unit coordinates). */
function addRod(P, N, T, a, b, t, uv) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.hypot(...d);
  const u = d.map((x) => x / L);
  // two perpendicular axes
  let p1 = Math.abs(u[2]) < 0.9 ? [-u[1], u[0], 0] : [1, 0, 0];
  const l1 = Math.hypot(...p1); p1 = p1.map((x) => (x / l1) * t);
  const p2 = [u[1] * p1[2] - u[2] * p1[1], u[2] * p1[0] - u[0] * p1[2], u[0] * p1[1] - u[1] * p1[0]];
  const corner = (o, s1, s2) => [o[0] + s1 * p1[0] + s2 * p2[0], o[1] + s1 * p1[1] + s2 * p2[1], o[2] + s1 * p1[2] + s2 * p2[2]];
  const ring = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let i = 0; i < 4; i++) {
    const [s1, s2] = ring[i], [t1, t2] = ring[(i + 1) % 4];
    const a1 = corner(a, s1, s2), a2 = corner(a, t1, t2), b1 = corner(b, s1, s2), b2 = corner(b, t1, t2);
    const n = [(s1 + t1) * p1[0] + (s2 + t2) * p2[0], (s1 + t1) * p1[1] + (s2 + t2) * p2[1], (s1 + t1) * p1[2] + (s2 + t2) * p2[2]];
    const nl = Math.hypot(...n) || 1;
    const nn = n.map((x) => x / nl);
    for (const q of [a1, a2, b2, a1, b2, b1]) { P.push(...q); N.push(...nn); T.push(...uv); }
  }
}

// Extras are in unit coordinates (scaled with the section).
const PANTOGRAPH = [
  [-0.12, 0.12, -0.28, 0.28, 1.0, 1.04],              // base frame
  { rod: [[-0.06, 0, 1.04], [0.06, 0, 1.13]], t: 0.012 }, // lower arm
  { rod: [[0.06, 0, 1.13], [-0.02, 0, 1.22]], t: 0.012 }, // upper arm
  [-0.04, 0.0, -0.3, 0.3, 1.21, 1.235],               // contact bar
];
const ROOF_UNITS = [[-0.35, -0.05, -0.3, 0.3, 1.0, 1.06], [0.15, 0.4, -0.3, 0.3, 1.0, 1.05]];
// on the rear section of an articulated trolleybus: base near its front, poles trailing back up to the wires
const TROLLEY_POLES = [
  [0.25, 0.42, -0.3, 0.3, 1.0, 1.06],                          // pole base
  { rod: [[0.38, -0.12, 1.06], [-0.5, -0.2, 1.62]], t: 0.008 }, // left pole
  { rod: [[0.38, 0.12, 1.06], [-0.5, 0.2, 1.62]], t: 0.008 },   // right pole
];

export const MESHES = {
  tram: buildMesh({ roofRound: 0.1, extras: ROOF_UNITS }),
  tramPanto: buildMesh({ roofRound: 0.1, extras: PANTOGRAPH }),
  bus: buildMesh({ roofRound: 0.12, skirt: 0.1, extras: [[-0.4, -0.1, -0.3, 0.3, 1.0, 1.05]] }),
  busPoles: buildMesh({ roofRound: 0.12, skirt: 0.1, extras: TROLLEY_POLES }),
  train: buildMesh({ roofRound: 0.16, skirt: 0.06 }),
  ship: buildMesh({ roofRound: 0.02, skirt: 0.25 }),
  cabin: buildMesh({ roofRound: 0.05, skirt: 0.02 }),
};

// ---------------------------------------------------------------- liveries (painted on a canvas)
const W = 512, H = 128;
const SIDE_W = Math.round(W * SIDE_U);
// v (0 = bottom of body, 0.85 = top of wall) -> canvas y
const vy = (v) => Math.round((1 - v) * H);
// body height fraction z -> canvas y (z * 0.85 = v)
const zy = (z) => vy(z * 0.85);

function paint(spec, night) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const glass = night ? '#ffd98a' : '#22313f';
  const glassFront = night ? '#3a3020' : '#1c2733';

  // base: top body colour everywhere (covers the strip between wall and roof)
  g.fillStyle = spec.bands[spec.bands.length - 1][2];
  g.fillRect(0, 0, W, H);
  // roof band
  g.fillStyle = spec.roof || '#9aa1a8';
  g.fillRect(0, 0, W, vy(0.89));
  // side: body bands from bottom to top
  for (const [z0, z1, col] of spec.bands) { g.fillStyle = col; g.fillRect(0, zy(z1), SIDE_W, zy(z0) - zy(z1)); }
  // windows
  for (const [z0, z1, n, frac] of spec.windows) {
    const step = SIDE_W / n, ww = step * (frac ?? 0.82);
    g.fillStyle = glass;
    for (let i = 0; i < n; i++) g.fillRect(i * step + (step - ww) / 2, zy(z1), ww, zy(z0) - zy(z1));
  }
  // doors
  for (const [x, z1, wFrac] of spec.doors || []) {
    const dw = SIDE_W * (wFrac || 0.08);
    g.fillStyle = spec.doorColor || '#3c4650';
    g.fillRect(x * SIDE_W - dw / 2, zy(z1), dw, zy(spec.doorBottom ?? 0.08) - zy(z1));
    g.fillStyle = night ? '#e8c27a' : '#2b3742';
    g.fillRect(x * SIDE_W - dw / 2 + 2, zy(z1) + 3, dw / 2 - 3, (zy(0.3) - zy(z1)));
    g.fillRect(x * SIDE_W + 1, zy(z1) + 3, dw / 2 - 3, (zy(0.3) - zy(z1)));
  }
  // front face: lower colour, windscreen, lights
  const fx = SIDE_W, fw = W - SIDE_W;
  g.fillStyle = spec.front || spec.bands[0][2];
  g.fillRect(fx, zy(1), fw, H - zy(1));
  g.fillStyle = glassFront;
  const [s0, s1] = spec.screen || [0.45, 0.88];
  g.fillRect(fx + fw * 0.08, zy(s1), fw * 0.84, zy(s0) - zy(s1));
  g.fillStyle = night ? '#fff6d0' : '#e8eef2';
  g.fillRect(fx + fw * 0.1, zy(0.22), fw * 0.14, zy(0.15) - zy(0.22));
  g.fillRect(fx + fw * 0.76, zy(0.22), fw * 0.14, zy(0.15) - zy(0.22));
  if (spec.display !== false) { // destination display above the windscreen
    g.fillStyle = '#111';
    g.fillRect(fx + fw * 0.2, zy(0.97), fw * 0.6, zy(s1 + 0.01) - zy(0.97));
    g.fillStyle = '#ffb000';
    g.fillRect(fx + fw * 0.25, zy(0.95), fw * 0.5, Math.max(2, (zy(s1 + 0.02) - zy(0.95)) * 0.5));
  }
  // WebGL samples textures bottom-up: flip so v = 0 is the bottom of the body
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const o = out.getContext('2d');
  o.translate(0, H);
  o.scale(1, -1);
  o.drawImage(cv, 0, 0);
  return out;
}

const VBZ_BLUE = '#0f4c9a', WHITE = '#f4f6f7', SBB_RED = '#d7141a', GREY = '#5f6870';
const LIVERIES = {
  // VBZ trams: blue-white with a light skirt line
  vbz: { bands: [[0, 0.07, '#2b2f33'], [0.07, 0.4, VBZ_BLUE], [0.4, 1, WHITE]], windows: [[0.44, 0.86, 3, 0.86]], doors: [[0.5, 0.86, 0.22]], doorBottom: 0.07, doorColor: VBZ_BLUE, front: VBZ_BLUE, screen: [0.42, 0.9] },
  vbzOld: { bands: [[0, 0.07, '#2b2f33'], [0.07, 0.42, VBZ_BLUE], [0.42, 1, WHITE]], windows: [[0.46, 0.84, 5, 0.8]], doors: [[0.2, 0.84, 0.1], [0.8, 0.84, 0.1]], doorColor: VBZ_BLUE, front: WHITE, screen: [0.46, 0.86] },
  lmb: { bands: [[0, 0.07, '#2b2f33'], [0.07, 0.38, '#8a9399'], [0.38, 1, WHITE]], windows: [[0.44, 0.86, 3, 0.86]], doors: [[0.5, 0.86, 0.22]], doorColor: '#c9d200', front: WHITE, screen: [0.42, 0.9] },
  forch: { bands: [[0, 0.07, '#2b2f33'], [0.07, 0.45, '#c8102e'], [0.45, 1, '#f1e6d0']], windows: [[0.48, 0.86, 7, 0.8]], doors: [[0.12, 0.86, 0.08], [0.88, 0.86, 0.08]], doorColor: '#c8102e', front: '#c8102e' },
  vbzBus: { bands: [[0, 0.1, '#2b2f33'], [0.1, 0.38, VBZ_BLUE], [0.38, 1, WHITE]], windows: [[0.42, 0.88, 4, 0.9]], doors: [[0.12, 0.88, 0.12], [0.6, 0.88, 0.12]], doorBottom: 0.1, doorColor: '#26313b', front: WHITE, screen: [0.3, 0.9] },
  postauto: { bands: [[0, 0.1, '#2b2f33'], [0.1, 1, '#ffcc00']], windows: [[0.42, 0.88, 4, 0.9]], doors: [[0.12, 0.88, 0.12], [0.6, 0.88, 0.12]], doorBottom: 0.1, doorColor: '#26313b', front: '#ffcc00', screen: [0.3, 0.9] },
  genericBus: { bands: [[0, 0.1, '#2b2f33'], [0.1, 0.32, '#3e7d5a'], [0.32, 1, WHITE]], windows: [[0.42, 0.88, 4, 0.9]], doors: [[0.12, 0.88, 0.12], [0.6, 0.88, 0.12]], doorBottom: 0.1, doorColor: '#26313b', front: WHITE, screen: [0.3, 0.9] },
  // SBB double-deck: white, red stripe, two window rows
  sbbDD: { bands: [[0, 0.06, '#2b2f33'], [0.06, 0.12, SBB_RED], [0.12, 1, WHITE]], windows: [[0.17, 0.42, 9, 0.78], [0.56, 0.84, 9, 0.78]], doors: [[0.08, 0.44, 0.07], [0.92, 0.44, 0.07]], doorBottom: 0.12, doorColor: SBB_RED, front: SBB_RED, roof: '#7b828a', screen: [0.55, 0.85], display: false },
  red: { bands: [[0, 0.06, '#2b2f33'], [0.06, 0.4, '#b5121b'], [0.4, 1, '#f2f2f2']], windows: [[0.46, 0.84, 8, 0.8]], doors: [[0.15, 0.84, 0.07], [0.85, 0.84, 0.07]], doorColor: '#b5121b', front: '#b5121b', display: false },
  ship: { bands: [[0, 0.3, '#1d3d6e'], [0.3, 1, WHITE]], windows: [[0.55, 0.8, 14, 0.6]], roof: '#d8d2c4', front: WHITE, screen: [0.5, 0.8], display: false },
  cabin: { bands: [[0, 1, WHITE]], windows: [[0.35, 0.85, 10, 0.8]], roof: '#c7ccd1', front: WHITE, screen: [0.35, 0.85], display: false },
  funi: { bands: [[0, 0.07, '#2b2f33'], [0.07, 1, '#d1262c']], windows: [[0.42, 0.88, 4, 0.85]], front: '#d1262c', display: false },
};

const textureCache = new Map();
export function liveryTexture(name, night) {
  const key = name + (night ? ':n' : ':d');
  if (!textureCache.has(key)) textureCache.set(key, paint(LIVERIES[name], night));
  return textureCache.get(key);
}

// ---------------------------------------------------------------- placing sections along the track
/**
 * Build the drawable sections for a vehicle.
 * `behind(offsets)` must return [x, y] points (local metres) at the given distances behind the head.
 * Returns [{ x, y, yaw, len, w, h, mesh, livery }] with centre position and heading.
 */
export function sectionsFor(modelName, behind) {
  const m = MODELS[modelName];
  const offsets = [];
  let o = 0;
  for (const L of m.sections) { offsets.push(o, o + L); o += L + m.gap; }
  const pts = behind(offsets);
  const out = [];
  for (let i = 0; i < m.sections.length; i++) {
    if (m.hideSection === i) continue;
    const f = pts[2 * i], b = pts[2 * i + 1];
    const dx = f[0] - b[0], dy = f[1] - b[1];
    const yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
    let mesh = m.mesh;
    if (m.mesh === 'tram' && m.pantograph === i) mesh = 'tramPanto';
    if (m.mesh === 'bus' && m.poles === i) mesh = 'busPoles';
    if (m.mesh === 'ship') mesh = 'ship';
    const len = m.sections[i];
    out.push({ x: (f[0] + b[0]) / 2, y: (f[1] + b[1]) / 2, yaw, len, w: m.w, h: m.h, mesh, livery: m.livery });
    if (m.cabin) out.push({ x: (f[0] + b[0]) / 2 - dx * 0.05, y: (f[1] + b[1]) / 2 - dy * 0.05, yaw, len: len * 0.55, w: m.w * 0.7, h: m.h * 2.2, mesh: 'cabin', livery: 'cabin' });
  }
  return out;
}
