/* global deck */
// 3D buildings drawn by deck.gl from the same OpenFreeMap vector tiles as the base map, with a small
// shader extension that paints lit windows onto the walls at night.

/** Values the shader reads every frame; atmosphere code updates them. */
export const lights = {
  night: 0,     // 0 = daylight, 1 = full night (walls dark, windows glowing)
  lit: 0.4,     // share of windows with the light on
  dim: 0,       // extra darkening for overcast/rain (0..1)
};

const UNIFORMS = `layout(std140) uniform windowsUniforms {
  float night;
  float lit;
  float dim;
} windows;
`;

const windowsModule = {
  name: 'windows',
  vs: UNIFORMS,
  fs: UNIFORMS,
  uniformTypes: { night: 'f32', lit: 'f32', dim: 'f32' },
};

// Per-building values reach the shader packed into the fill colour: RGB is the wall colour, the alpha
// byte (unused, since the layer's opacity prop handles transparency) holds roof kind * 32 + a 0..31 seed.
const VS_DECL = /* glsl */ `
out vec3 vWin;
out vec3 vBld;   // roof kind, per-building seed 0..1, building height in metres
vec3 roofColor(float kind, float s) {
  vec3 c = kind < 0.5 ? vec3(0.58, 0.37, 0.29)   // weathered terracotta tiles
         : kind < 1.5 ? vec3(0.45, 0.34, 0.29)   // brown tiles
         : kind < 2.5 ? vec3(0.60, 0.59, 0.56)   // gravel flat roof
         : kind < 3.5 ? vec3(0.37, 0.38, 0.40)   // slate / dark membrane
         : kind < 4.5 ? vec3(0.45, 0.51, 0.37)   // green roof
         :              vec3(0.76, 0.77, 0.76);  // light membrane / sheet metal
  return c * (0.88 + 0.24 * s);
}
`;

const FS_DECL = /* glsl */ `
in vec3 vWin;
in vec3 vBld;
float winHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec4 applyWindows(vec4 c) {
  float n = windows.night;
  float wall = step(0.5, vWin.z);   // 1 on walls, 0 on roofs
  float s = vBld.y, H = vBld.z, y = vWin.y;

  // ---- window grid, varied per building (computed everywhere: fwidth needs uniform control flow)
  float bay = 2.6 + 1.2 * fract(s * 7.31);        // window spacing along the wall
  float storey = 3.0 + 0.45 * fract(s * 3.17);
  bool tall = H > 7.5;                            // anything above two floors gets a taller ground floor
  float ground = tall ? 4.2 : storey;
  bool shop = tall && y < ground;                 // ground floor: wide shop windows and entrances
  vec2 g = vec2(vWin.x / bay, y < ground ? y / ground - 1.0 : (y - ground) / storey);
  vec2 cell = floor(g);
  vec2 f = fract(g);
  vec2 w = fwidth(g);
  vec2 a0 = shop ? vec2(0.08, 0.05) : vec2(0.24, 0.22);
  vec2 a1 = shop ? vec2(0.92, 0.80) : vec2(0.76, 0.78);
  vec2 lo = smoothstep(a0 - w, a0 + w, f);
  vec2 hi = 1.0 - smoothstep(a1 - w, a1 + w, f);
  // no windows on sheds and garages, nor in a row the roof line would cut through
  float top = y < ground ? a1.y * ground : ground + (cell.y + a1.y) * storey;
  float valid = wall * step(2.5, H) * step(top, H - 0.4);
  float rect = lo.x * lo.y * hi.x * hi.y * valid;
  float area = (a1.x - a0.x) * (a1.y - a0.y) * valid;
  float h = winHash(cell + s * 61.7);
  // far away a window is smaller than a pixel: fade to its average instead of flickering
  float far = smoothstep(0.25, 0.7, max(w.x, w.y));

  // ---- daylight facade: glass darker than the wall with a few panes catching the sky,
  // a slightly lighter cornice under the roof line, and a contact shadow towards the ground
  vec3 glass = c.rgb * (0.42 + 0.14 * fract(h * 7.7)) + vec3(0.03, 0.05, 0.08);
  c.rgb = mix(c.rgb, glass, mix(rect, area, far) * 0.8);
  c.rgb *= 1.0 + 0.08 * wall * smoothstep(H - 0.75, H - 0.55, y);
  c.rgb *= mix(1.0, mix(0.8, 1.0, smoothstep(0.0, 7.0, y)), wall);

  // ---- night: darker (and a little under heavy cloud) but readable. Colours fade in the dark, the
  // moonlit/unlit contrast from the lighting pass stays, shifted to cool blue, and roofs catch the sky glow
  vec3 dark = mix(vec3(dot(c.rgb, vec3(0.3, 0.55, 0.15))), c.rgb, 0.3);
  vec3 night = dark * vec3(0.30, 0.33, 0.42) + vec3(0.020, 0.024, 0.036);
  night += (1.0 - wall) * vec3(0.018, 0.022, 0.034);
  c.rgb = mix(c.rgb * (1.0 - 0.12 * windows.dim), night, n);
  if (wall < 0.5 || n < 0.01) return c;

  // street lamps wash the lower floors in warm light, in pools roughly one lamp spacing apart
  float pool = 0.65 + 0.35 * cos(vWin.x * 0.25);
  float up = (1.0 - smoothstep(0.0, 16.0, y)) * pool;
  c.rgb += vec3(1.0, 0.64, 0.32) * up * n * 0.11;

  // lit windows
  float on = step(h, windows.lit);
  float glow = mix(rect * on, area * windows.lit, far);
  vec3 warm = vec3(1.0, 0.74, 0.40);
  vec3 cool = vec3(0.86, 0.90, 1.0);
  vec3 tint = mix(warm, cool, step(0.82, fract(h * 17.31)));
  float bright = 0.55 + 0.45 * fract(h * 53.7);
  c.rgb += tint * bright * glow * n * 0.95;
  return c;
}
`;

class WindowsExtension extends deck.LayerExtension {
  isEnabled(layer) { return layer.constructor.layerName === 'SolidPolygonLayer'; }
  getShaders(extension) {
    if (!extension.isEnabled(this)) return null;
    return {
      modules: [windowsModule],
      inject: {
        'vs:#decl': VS_DECL,
        // Wall coordinate system in metres: x along the wall, y height above ground, z = 1 on walls.
        // Built from the wall's own lng/lat corners (pos/nextPos of the side shader), not from
        // geometry.position: at high zoom deck.gl measures that relative to the view centre, so
        // windows would slide along the walls whenever the map is panned or zoomed.
        'vs:#main-end': /* glsl */ `
          float bCode = floor(fillColors.a * 255.0 + 0.5);
          vBld = vec3(floor(bCode / 32.0), mod(bCode, 32.0) / 31.0, elevations);
          vColor.a = layer.opacity;                           // the alpha byte was data, not transparency
          #ifdef IS_SIDE_VERTEX
            const vec2 WIN_REF = vec2(8.54, 47.37);           // fixed reference near Zurich
            const vec2 WIN_M = vec2(75398.0, 110540.0);       // metres per degree lng/lat there
            vec2 wa = (pos.xy - WIN_REF) * WIN_M;
            vec2 wb = (nextPos.xy - WIN_REF) * WIN_M;
            vec2 wt = normalize(wb - wa + vec2(1e-6));
            vWin = vec3(dot(mix(wa, wb, positions.x), wt), elevations * positions.y, 1.0);
          #else
            vWin = vec3(0.0);                                 // roofs: no windows
            // roofs get their own material, lit like the walls
            if (solidPolygon.extruded) vColor.rgb = lighting_getLightColor(
              roofColor(vBld.x, vBld.y), project.cameraPosition, geometry.position.xyz, geometry.normal);
          #endif
        `,
        'fs:#decl': FS_DECL,
        'fs:DECKGL_FILTER_COLOR': 'color = applyWindows(color);',
      },
    };
  }
  draw(params, extension) {
    if (!extension.isEnabled(this)) return;
    this.setShaderModuleProps({ windows: { night: lights.night, lit: lights.lit, dim: lights.dim } });
  }
}
WindowsExtension.extensionName = 'WindowsExtension';

const windowsExt = new WindowsExtension();
let tileUrl = null;

/** OpenFreeMap publishes versioned tile URLs; read the current one from its TileJSON. */
export async function initBuildings() {
  const res = await fetch('https://tiles.openfreemap.org/planet');
  if (!res.ok) throw new Error(`tilejson ${res.status}`);
  tileUrl = (await res.json()).tiles[0];
}

// ---------------------------------------------------------------- minimal vector-tile (MVT) decoder
// Only what the building layer needs: polygons and two numeric properties.

class Pbf {
  constructor(buf) { this.buf = buf; this.pos = 0; this.len = buf.length; }
  varint() {
    let v = 0, shift = 0, b;
    do { b = this.buf[this.pos++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    return v;
  }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`wire type ${wire}`);
  }
  sub() { const n = this.varint(); const p = new Pbf(this.buf.subarray(this.pos, this.pos + n)); this.pos += n; return p; }
  string() { const n = this.varint(); const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + n)); this.pos += n; return s; }
}

function readValue(p) {
  let v = null;
  while (p.pos < p.len) {
    const tag = p.varint(), f = tag >> 3, w = tag & 7;
    if (f === 1) v = p.string();
    else if (f === 2) { v = new DataView(p.buf.buffer, p.buf.byteOffset + p.pos, 4).getFloat32(0, true); p.pos += 4; }
    else if (f === 3) { v = new DataView(p.buf.buffer, p.buf.byteOffset + p.pos, 8).getFloat64(0, true); p.pos += 8; }
    else if (f === 4 || f === 5) v = p.varint();
    else if (f === 6) { const n = p.varint(); v = n % 2 ? -(n + 1) / 2 : n / 2; }
    else if (f === 7) v = !!p.varint();
    else p.skip(w);
  }
  return v;
}

const packed = (p) => { const q = p.sub(), out = []; while (q.pos < q.len) out.push(q.varint()); return out; };
const zz = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

// ---------------------------------------------------------------- building appearance

/** 32-bit integer hash, for stable per-building randomness. */
function hash32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

// Zurich facades: [colour, weight for older/smaller buildings, weight for modern/large ones]
const FACADES = [
  [[240, 236, 226], 5, 3],     // warm white
  [[234, 224, 200], 4, 1],     // cream
  [[222, 204, 168], 3, 1],     // sandstone
  [[230, 210, 162], 2, 0.3],   // pale ochre
  [[228, 202, 186], 1.5, 0.3], // pale salmon
  [[206, 210, 190], 1, 0.3],   // pale sage
  [[214, 214, 210], 2, 3],     // light grey
  [[200, 190, 176], 1, 1.5],   // grey beige
  [[188, 186, 180], 0.4, 3],   // concrete
];

function pickWeighted(r, list, col) {
  let total = 0;
  for (const it of list) total += it[col];
  for (const it of list) if ((r -= it[col] / total) < 0) return it[0];
  return list[list.length - 1][0];
}

/** Parse an OSM-style colour ("#rgb" / "#rrggbb"); null when it isn't one. */
function parseHex(v) {
  if (typeof v !== 'string' || v[0] !== '#') return null;
  const s = v.length === 4 ? v.replace(/[0-9a-f]/gi, (c) => c + c) : v;
  if (!/^#[0-9a-f]{6}$/i.test(s)) return null;
  return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
}

/**
 * Fill colour for one building: RGB = wall colour (from its OSM colour tag, toned down, or a
 * plausible facade colour), alpha = roof kind * 32 + a 0..31 seed for the shader (see VS_DECL).
 * Roof kinds: 0 terracotta, 1 brown tile, 2 gravel, 3 slate/dark, 4 green, 5 light membrane.
 */
function buildingFill(id, firstVertex, h, areaM2, colour) {
  const seed = hash32(id ? (id % 4294967296) ^ Math.floor(id / 4294967296) : (firstVertex[0] * 4099) ^ firstVertex[1]);
  const rnd = (k) => hash32(seed + k * 0x9e3779b9) / 4294967296;
  const modern = h > 22 || areaM2 > 1500;
  let wall = pickWeighted(rnd(1), FACADES, modern ? 2 : 1);
  const tagged = parseHex(colour);
  // mapped colours can be loud (bright red, blue): keep their hue but pull them towards a pale render
  if (tagged) wall = tagged.map((c) => c * 0.55 + 236 * 0.45);
  const shade = 0.95 + 0.1 * rnd(2);
  wall = wall.map((c) => Math.min(255, Math.round(c * shade)));
  // small, low buildings mostly have pitched tile roofs; big or tall ones flat roofs
  const pitched = modern ? 0 : areaM2 < 900 ? 0.8 : areaM2 < 2500 ? 0.45 : 0.15;
  const r = rnd(3), q = rnd(4);
  const roof = r < pitched
    ? (q < 0.42 ? 0 : q < 0.72 ? 1 : 3)
    : (q < 0.45 ? 2 : q < 0.65 ? 3 : q < 0.85 ? 4 : 5);
  return [wall[0], wall[1], wall[2], roof * 32 + (seed & 31)];
}

/** Decode the "building" layer of one tile into [{polygon:[[lng,lat]...rings], h}] */
function decodeBuildings(buf, x, y, z) {
  const tile = new Pbf(buf);
  const out = [];
  while (tile.pos < tile.len) {
    const tag = tile.varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) { tile.skip(tag & 7); continue; }
    const layer = tile.sub();
    let name = '', extent = 4096;
    const keys = [], values = [], feats = [];
    while (layer.pos < layer.len) {
      const t = layer.varint(), f = t >> 3;
      if (f === 1) { name = layer.string(); if (name !== 'building') break; }
      else if (f === 2) feats.push(layer.sub());
      else if (f === 3) keys.push(layer.string());
      else if (f === 4) values.push(readValue(layer.sub()));
      else if (f === 5) extent = layer.varint();
      else layer.skip(t & 7);
    }
    if (name !== 'building') continue;
    const kH = keys.indexOf('render_height'), kMin = keys.indexOf('render_min_height');
    const kColour = keys.indexOf('colour'), kHide = keys.indexOf('hide_3d');
    const n = 2 ** z;
    const toLngLat = (px, py) => {
      const lng = ((x + px / extent) / n) * 360 - 180;
      const my = Math.PI * (1 - (2 * (y + py / extent)) / n);
      return [lng, (Math.atan(Math.sinh(my)) * 180) / Math.PI];
    };
    const mPerPx = (40075016 * Math.cos((toLngLat(extent / 2, extent / 2)[1] * Math.PI) / 180)) / (n * extent);
    const m2PerPx2 = mPerPx * mPerPx;
    for (const fp of feats) {
      let type = 0, tags = [], geom = [], id = 0;
      while (fp.pos < fp.len) {
        const t = fp.varint(), f = t >> 3;
        if (f === 1) id = fp.varint();
        else if (f === 2) tags = packed(fp);
        else if (f === 3) type = fp.varint();
        else if (f === 4) geom = packed(fp);
        else fp.skip(t & 7);
      }
      if (type !== 3) continue;
      let h = 8, base = 0, colour = null, hide = false;
      for (let i = 0; i < tags.length; i += 2) {
        if (tags[i] === kH) h = +values[tags[i + 1]] || h;
        else if (tags[i] === kMin) base = +values[tags[i + 1]] || 0;
        else if (tags[i] === kColour) colour = values[tags[i + 1]];
        else if (tags[i] === kHide) hide = !!values[tags[i + 1]];
      }
      if (hide) continue;                          // outline of a building that is also mapped as 3D parts
      if (base > 0 && base >= h - 0.5) continue;  // floating parts (overhangs): skip, they would fill to the ground
      let fill = null;                             // per feature, shared by all its polygons
      // geometry commands -> rings; a ring with positive area (in tile y-down coords) starts a new polygon
      let cx = 0, cy = 0, ring = null, poly = null;
      const rings = [];
      for (let i = 0; i < geom.length;) {
        const cmd = geom[i] & 7, cnt = geom[i] >> 3; i++;
        if (cmd === 1 || cmd === 2) {
          for (let k = 0; k < cnt; k++) {
            cx += zz(geom[i++]); cy += zz(geom[i++]);
            if (cmd === 1) { ring = [[cx, cy]]; rings.push(ring); } else ring.push([cx, cy]);
          }
        }
      }
      for (const r of rings) {
        if (r.length < 3) continue;
        let area = 0;
        for (let k = 0, j = r.length - 1; k < r.length; j = k++) area += (r[j][0] - r[k][0]) * (r[j][1] + r[k][1]);
        const ll = r.map(([px, py]) => toLngLat(px, py));
        ll.push(ll[0]);
        if (area > 0 || !poly) {                                                 // exterior ring (MVT: positive area)
          fill ??= buildingFill(id, r[0], h, Math.abs(area) * m2PerPx2 / 2, colour);
          poly = [ll];
          out.push({ polygon: poly, h, fill });
        }
        else poly.push(ll);                                                      // hole
      }
    }
  }
  return out;
}

async function loadTile({ index: { x, y, z }, signal }) {
  const url = tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  return decodeBuildings(new Uint8Array(await res.arrayBuffer()), x, y, z);
}

const MATERIAL = { ambient: 0.72, diffuse: 0.55, shininess: 8, specularColor: [20, 20, 20] };

/** The deck.gl building layer (null until the tile URL is known). */
export function buildingsLayer({ visible, opacity }) {
  if (!tileUrl) return null;
  return new deck.TileLayer({
    id: 'buildings',
    data: tileUrl,
    minZoom: 13,
    maxZoom: 14,
    tileSize: 512,
    visible,
    opacity,
    getTileData: loadTile,
    refinementStrategy: 'no-overlap',
    maxCacheSize: 120,
    renderSubLayers: (props) => new deck.SolidPolygonLayer({
      id: props.id,
      data: props.data,
      visible: props.visible,
      opacity: props.opacity,
      extruded: true,
      getPolygon: (d) => d.polygon,
      getElevation: (d) => d.h,
      getFillColor: (d) => d.fill,
      material: MATERIAL,
      extensions: [windowsExt],
    }),
  });
}
