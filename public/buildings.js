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

const FS_DECL = /* glsl */ `
in vec3 vWin;
float winHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec4 applyWindows(vec4 c) {
  float n = windows.night;
  // the city gets darker at night (and a little under heavy cloud)
  vec3 night = c.rgb * 0.16 + vec3(0.018, 0.022, 0.032);
  c.rgb = mix(c.rgb * (1.0 - 0.12 * windows.dim), night, n);
  if (vWin.z < 0.5 || n < 0.01) return c;          // roofs never get windows

  // one cell = one window: 2.8 m wide, 3.2 m storey height, first row starts 0.8 m above the ground
  vec2 g = vec2(vWin.x / 2.8, (vWin.y - 0.8) / 3.2);
  vec2 cell = floor(g);
  vec2 f = fract(g);
  vec2 w = fwidth(g);
  // anti-aliased window rectangle
  vec2 lo = smoothstep(vec2(0.24, 0.22) - w, vec2(0.24, 0.22) + w, f);
  vec2 hi = 1.0 - smoothstep(vec2(0.76, 0.78) - w, vec2(0.76, 0.78) + w, f);
  float rect = lo.x * lo.y * hi.x * hi.y * step(0.0, g.y);
  float h = winHash(cell);
  float on = step(h, windows.lit);
  // far away a window is smaller than a pixel: fade to the average glow instead of flickering
  float far = smoothstep(0.25, 0.7, max(w.x, w.y));
  float glow = mix(rect * on, 0.28 * windows.lit, far);
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
        'vs:#decl': 'out vec3 vWin;',
        // wall coordinate system in metres: x along the wall, y height above ground, z = 1 on walls
        'vs:#main-end': /* glsl */ `
          vec3 wm = geometry.position.xyz / project.commonUnitsPerMeter;
          vec3 wn = geometry.normal;
          float isWall = 1.0 - step(0.5, abs(wn.z));
          vec2 tng = normalize(vec2(-wn.y, wn.x) + vec2(1e-6));
          vWin = vec3(dot(wm.xy, tng), wm.z, isWall);
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
    const n = 2 ** z;
    const toLngLat = (px, py) => {
      const lng = ((x + px / extent) / n) * 360 - 180;
      const my = Math.PI * (1 - (2 * (y + py / extent)) / n);
      return [lng, (Math.atan(Math.sinh(my)) * 180) / Math.PI];
    };
    for (const fp of feats) {
      let type = 0, tags = [], geom = [];
      while (fp.pos < fp.len) {
        const t = fp.varint(), f = t >> 3;
        if (f === 2) tags = packed(fp);
        else if (f === 3) type = fp.varint();
        else if (f === 4) geom = packed(fp);
        else fp.skip(t & 7);
      }
      if (type !== 3) continue;
      let h = 8, base = 0;
      for (let i = 0; i < tags.length; i += 2) {
        if (tags[i] === kH) h = +values[tags[i + 1]] || h;
        else if (tags[i] === kMin) base = +values[tags[i + 1]] || 0;
      }
      if (base > 0 && base >= h - 0.5) continue;  // floating parts (overhangs): skip, they would fill to the ground
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
        if (area > 0 || !poly) { poly = [ll]; out.push({ polygon: poly, h }); } // exterior ring (MVT: positive area)
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
const WALL = [240, 236, 228];

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
      getFillColor: WALL,
      material: MATERIAL,
      extensions: [windowsExt],
    }),
  });
}
