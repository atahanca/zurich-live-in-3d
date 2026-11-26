/* global deck, DracoDecoderModule */
// Real 3D buildings (swisstopo swissBUILDINGS3D) for close-up views: true roof shapes, towers, courtyards.
//
// swisstopo streams them as 3D Tiles (b3dm with Draco-compressed glTF). The tileset has no simplified levels:
// all buildings sit in leaf tiles on a regular 2048 x 2048 grid over Switzerland (~167 m x 108 m each, about
// 50k vertices), so streaming it as a 3D tileset would load every tile up to the horizon. Instead, the
// tiles in a box around the map centre are fetched directly, and the box buildings (buildings.js) are cut
// out inside that box. The models sit at their real height above sea level while the map is flat, so each
// building is lowered on load until its lowest point touches the ground. They are drawn with the same
// facade shader as the boxes (windows, night lights, shadows).

import { lights, windowsModule, VS_DECL, FS_DECL, hash32, FACADES, pickWeighted } from './buildings.js';

const ROOT = 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/';
const GRID_N = 2048;          // leaf tiles per side over the tileset's root region
const MIN_ZOOM = 16;          // real models from this zoom on
const MAX_PARALLEL = 6;
const CACHE_CELLS = 140;

// ---------------------------------------------------------------- Draco decoder (bundled in vendor/draco)

let dracoPromise = null;
function loadDraco() {
  dracoPromise ||= (async () => {
    if (typeof DracoDecoderModule === 'undefined') {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/draco/draco_wasm_wrapper.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('draco decoder failed to load'));
        document.head.appendChild(s);
      });
    }
    const wasmBinary = await (await fetch('vendor/draco/draco_decoder.wasm')).arrayBuffer();
    return new Promise((resolve) => {
      DracoDecoderModule({
        wasmBinary,
        // the Emscripten module is a thenable: drop .then or resolving with it never settles
        onModuleLoaded: (m) => { delete m.then; resolve(m); },
      });
    });
  })();
  return dracoPromise;
}

/** Decode one KHR_draco_mesh_compression primitive into {attr: Float32Array}, indices. */
function decodeDraco(draco, bytes, attrIds) {
  const decoder = new draco.Decoder();
  const buffer = new draco.DecoderBuffer();
  buffer.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes.byteLength);
  const mesh = new draco.Mesh();
  try {
    const status = decoder.DecodeBufferToMesh(buffer, mesh);
    if (!status.ok() || mesh.ptr === 0) throw new Error('draco: ' + status.error_msg());
    const np = mesh.num_points();
    const out = {};
    for (const [name, id] of Object.entries(attrIds)) {
      const att = decoder.GetAttributeByUniqueId(mesh, id);
      const nc = att.num_components(), len = np * nc, bytesLen = len * 4;
      const ptr = draco._malloc(bytesLen);
      decoder.GetAttributeDataArrayForAllPoints(mesh, att, draco.DT_FLOAT32, bytesLen, ptr);
      out[name] = new Float32Array(draco.HEAPF32.buffer, ptr, len).slice();
      draco._free(ptr);
    }
    const ni = mesh.num_faces() * 3, ptr = draco._malloc(ni * 4);
    decoder.GetTrianglesUInt32Array(mesh, ni * 4, ptr);
    const indices = new Uint32Array(draco.HEAPU32.buffer, ptr, ni).slice();
    draco._free(ptr);
    return { attributes: out, indices };
  } finally {
    draco.destroy(mesh); draco.destroy(buffer); draco.destroy(decoder);
  }
}

// ---------------------------------------------------------------- b3dm -> one ground-standing mesh

const strHash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

function mul(a, b) {   // 4x4, column-major
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function nodeMatrix(n) {
  if (n.matrix) return n.matrix.slice();
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** Roof kind (same codes as the box buildings) from the real roof: pitched roofs get tiles, flat ones not. */
function roofKind(pitch, rnd) {
  if (pitch > 1.2) return rnd < 0.42 ? 0 : rnd < 0.72 ? 1 : 3;          // terracotta, brown tile, slate
  return rnd < 0.45 ? 2 : rnd < 0.65 ? 3 : rnd < 0.85 ? 4 : 5;          // gravel, dark, green, light
}

/**
 * Parse a b3dm tile into one mesh in metres east/north/up of its centre, every building lowered so it stands
 * at z = 0. Per-vertex building data rides in attributes the mesh layer would otherwise not use:
 * colors = (roof kind, seed 0..1, building height), texCoords.x = wall colour packed as r*65536 + g*256 + b.
 */
function buildTile(buf, draco) {
  const dv = new DataView(buf), td = new TextDecoder();
  if (td.decode(new Uint8Array(buf, 0, 4)) !== 'b3dm') throw new Error('not a b3dm tile');
  const ftj = dv.getUint32(12, true), ftb = dv.getUint32(16, true), btj = dv.getUint32(20, true), btb = dv.getUint32(24, true);
  let o = 28;
  const ft = JSON.parse(td.decode(new Uint8Array(buf, o, ftj))); o += ftj + ftb;
  const bt = btj ? JSON.parse(td.decode(new Uint8Array(buf, o, btj))) : {}; o += btj + btb;
  const glbEnd = o + dv.getUint32(o + 8, true);
  let json = null, bin = null;
  for (let p = o + 12; p < glbEnd;) {
    const len = dv.getUint32(p, true), type = dv.getUint32(p + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(td.decode(new Uint8Array(buf, p + 8, len)));
    else if (type === 0x004e4942) bin = new Uint8Array(buf, p + 8, len);
    p += 8 + len;
  }

  // tile frame: RTC centre (ECEF) -> east/north/up axes at that point
  const rtc = ft.RTC_CENTER || json.extensions?.CESIUM_RTC?.center || [0, 0, 0];
  const lon = Math.atan2(rtc[1], rtc[0]);
  const pr = Math.hypot(rtc[0], rtc[1]), e2 = 6.69437999014e-3;
  let lat = Math.atan2(rtc[2], pr * (1 - e2));
  for (let i = 0; i < 5; i++) {
    const N = 6378137 / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(rtc[2] + e2 * N * Math.sin(lat), pr);
  }
  const E = [-Math.sin(lon), Math.cos(lon), 0];
  const Nn = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const U = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  // glTF is y-up; 3D Tiles turns it z-up: (x, y, z) -> (x, -z, y). Then ECEF offsets from the RTC centre
  // projected on east/north/up give local metres.
  const yUp = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
  const toEnu = [E[0], Nn[0], U[0], 0, E[1], Nn[1], U[1], 0, E[2], Nn[2], U[2], 0, 0, 0, 0, 1];
  const frame = mul(toEnu, yUp);

  // collect primitives with their world matrices
  const prims = [];
  const visit = (i, parent) => {
    const node = json.nodes[i];
    const m = mul(parent, nodeMatrix(node));
    if (node.mesh !== undefined) for (const p of json.meshes[node.mesh].primitives) prims.push([m, p]);
    for (const c of node.children || []) visit(c, m);
  };
  let roots = json.scenes?.[json.scene || 0]?.nodes;
  if (!roots) {
    const child = new Set((json.nodes || []).flatMap((n) => n.children || []));
    roots = (json.nodes || []).map((_, i) => i).filter((i) => !child.has(i));
  }
  for (const r of roots) visit(r, frame);

  const parts = [];
  let nv = 0, ni = 0;
  for (const [m, p] of prims) {
    const ext = p.extensions?.KHR_draco_mesh_compression;
    if (!ext) continue; // swisstopo tiles are all Draco; anything else is skipped
    const bv = json.bufferViews[ext.bufferView];
    const d = decodeDraco(draco, bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength), ext.attributes);
    parts.push([m, d]);
    nv += d.attributes.POSITION.length / 3;
    ni += d.indices.length;
  }

  const nb = Math.max(1, ft.BATCH_LENGTH || 0);
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), bid = new Uint16Array(nv), idx = new Uint32Array(ni);
  const lo = new Float64Array(nb).fill(Infinity), hi = new Float64Array(nb).fill(-Infinity);
  const x0 = new Float64Array(nb).fill(Infinity), x1 = new Float64Array(nb).fill(-Infinity);
  const y0 = new Float64Array(nb).fill(Infinity), y1 = new Float64Array(nb).fill(-Infinity);
  let v = 0, k = 0;
  for (const [m, { attributes: A, indices: I }] of parts) {
    const P = A.POSITION, Nr = A.NORMAL, B = A._BATCHID, base = v, n = P.length / 3;
    for (let i = 0; i < n; i++, v++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const ex = m[0] * x + m[4] * y + m[8] * z + m[12];
      const ey = m[1] * x + m[5] * y + m[9] * z + m[13];
      const ez = m[2] * x + m[6] * y + m[10] * z + m[14];
      pos[v * 3] = ex; pos[v * 3 + 1] = ey; pos[v * 3 + 2] = ez;
      if (Nr) {
        const a = Nr[i * 3], b = Nr[i * 3 + 1], c = Nr[i * 3 + 2];
        const nx = m[0] * a + m[4] * b + m[8] * c, ny = m[1] * a + m[5] * b + m[9] * c, nz = m[2] * a + m[6] * b + m[10] * c;
        const l = Math.hypot(nx, ny, nz) || 1;
        nrm[v * 3] = nx / l; nrm[v * 3 + 1] = ny / l; nrm[v * 3 + 2] = nz / l;
      }
      const b = B ? Math.min(nb - 1, Math.max(0, Math.round(B[i]))) : 0;
      bid[v] = b;
      if (ez < lo[b]) lo[b] = ez;
      if (ez > hi[b]) hi[b] = ez;
      if (ex < x0[b]) x0[b] = ex;
      if (ex > x1[b]) x1[b] = ex;
      if (ey < y0[b]) y0[b] = ey;
      if (ey > y1[b]) y1[b] = ey;
    }
    for (let i = 0; i < I.length; i++) idx[k++] = I[i] + base;
  }

  // per building: seed, wall colour, roof kind (from the real roof pitch), height
  const info = [];
  for (let b = 0; b < nb; b++) {
    const seed = strHash(String(bt.UUID?.[b] ?? `${rtc[0]},${b}`));
    const rnd = (j) => hash32(seed + j * 0x9e3779b9) / 4294967296;
    const H = Number.isFinite(lo[b]) ? hi[b] - lo[b] : 0;
    const area = Math.max(0, x1[b] - x0[b]) * Math.max(0, y1[b] - y0[b]);
    const shade = 0.95 + 0.1 * rnd(2);
    const wall = pickWeighted(rnd(1), FACADES, H > 22 || area > 1500 ? 2 : 1).map((c) => Math.min(255, Math.round(c * shade)));
    const pitch = (+bt.DACH_MAX?.[b] || 0) - (+bt.DACH_MIN?.[b] || 0);
    info.push([Number.isFinite(lo[b]) ? lo[b] : 0, roofKind(pitch, rnd(4)), (seed & 1023) / 1023, H, wall[0] * 65536 + wall[1] * 256 + wall[2]]);
  }
  const col = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  for (let i = 0; i < nv; i++) {
    const [ground, kind, seed, H, wall] = info[bid[i]];
    pos[i * 3 + 2] -= ground;
    col[i * 3] = kind; col[i * 3 + 1] = seed; col[i * 3 + 2] = H;
    uv[i * 2] = wall;
  }
  return {
    position: [lon * 180 / Math.PI, lat * 180 / Math.PI, 0],
    vertices: nv,
    mesh: {
      attributes: {
        positions: { size: 3, value: pos }, normals: { size: 3, value: nrm },
        colors: { size: 3, value: col }, texCoords: { size: 2, value: uv },
      },
      indices: { size: 1, value: idx },
    },
  };
}

// ---------------------------------------------------------------- mesh layer with the facade shader

const MESH_VS_MAIN_END = /* glsl */ `
  vBld = colors;                                      // roof kind, seed, building height
  float wp = texCoords.x;
  vec3 wallRgb = vec3(floor(wp / 65536.0), mod(floor(wp / 256.0), 256.0), mod(wp, 256.0)) / 255.0;
  vec3 bn = normalize(normals);
  if (abs(bn.z) < 0.35) {                             // walls: x along the wall, y height above the ground
    vec2 wt = normalize(vec2(-bn.y, bn.x));
    vWin = vec3(dot(positions.xy, wt), positions.z, 1.0);
    vColor = vec4(wallRgb, 1.0);
  } else {                                            // roofs (pitched or flat)
    vWin = vec3(0.0);
    vColor = vec4(roofColor(vBld.x, vBld.y), 1.0);
  }
`;

// deck.gl's mesh shader filters the colour before lighting; the facade code (windows, night, shadows) must
// run on the lit colour, as it does for the box buildings, so the end of the fragment shader is rewritten
const FS_FROM = `vec4 color = simpleMesh.hasTexture ? texture(sampler, vTexCoord) : vColor;
DECKGL_FILTER_COLOR(color, geometry);
vec3 lightColor = lighting_getLightColor(color.rgb, cameraPosition, position_commonspace.xyz, normal);
fragColor = vec4(lightColor, color.a * layer.opacity);`;
const FS_TO = `vec4 color = simpleMesh.hasTexture ? texture(sampler, vTexCoord) : vColor;
fragColor = vec4(lighting_getLightColor(color.rgb, cameraPosition, position_commonspace.xyz, normal), color.a * layer.opacity);
DECKGL_FILTER_COLOR(fragColor, geometry);
fragColor = applyWindows(fragColor);`;

class BuildingMeshLayer extends deck.SimpleMeshLayer {
  getShaders() {
    const s = super.getShaders();
    if (!s.fs.includes(FS_FROM)) throw new Error('BuildingMeshLayer: unexpected SimpleMeshLayer shader');
    return {
      ...s,
      fs: s.fs.replace(FS_FROM, FS_TO),
      modules: [...s.modules, windowsModule],
      inject: { ...(s.inject || {}), 'vs:#decl': VS_DECL, 'vs:#main-end': MESH_VS_MAIN_END, 'fs:#decl': FS_DECL },
    };
  }
  draw(opts) {
    this.state.model?.shaderInputs.setProps({ windows: { night: lights.night, lit: lights.lit, dim: lights.dim, box: lights.box } });
    super.draw(opts);
  }
}
BuildingMeshLayer.layerName = 'BuildingMeshLayer';

// ---------------------------------------------------------------- tile cache around the map centre

let grid = null;              // { base, west, south, dx, dy }
let gridPromise = null;
const cells = new Map();      // "x/y" -> { state: 'loading'|'done'|'empty'|'error', tile, used }
let active = 0;
let wanted = [];              // cell keys of the current box, nearest first
let shownBox = null;          // [x0, y0, x1, y1] cells currently replacing the box buildings

/** Read the current publication (dated folder) and the grid's extent from the tileset. */
function initGrid() {
  gridPromise ||= (async () => {
    const root = await (await fetch(ROOT + 'tileset.json')).json();
    const dated = root.root.children[0].content.uri;            // e.g. "20260520/tileset.json"
    const base = new URL(dated, ROOT).href.replace(/tileset\.json$/, '');
    const sub = await (await fetch(base + 'tileset.json')).json();
    const r = sub.root.boundingVolume.region.map((x) => x * 180 / Math.PI);
    grid = { base, west: r[0], south: r[1], dx: (r[2] - r[0]) / GRID_N, dy: (r[3] - r[1]) / GRID_N };
    swiss.onChange();
  })().catch((e) => { console.warn('swissBUILDINGS3D unavailable', e); });
  return gridPromise;
}

async function loadCell(key) {
  const c = cells.get(key);
  active++;
  try {
    const [x, y] = key.split('/');
    const [res, draco] = await Promise.all([fetch(`${grid.base}11/${x}/${y}.b3dm`), loadDraco()]);
    if (!res.ok) { c.state = res.status === 403 || res.status === 404 ? 'empty' : 'error'; return; }
    c.tile = buildTile(await res.arrayBuffer(), draco);
    c.state = 'done';
  } catch (e) {
    console.warn('swissBUILDINGS3D tile', key, e);
    c.state = 'error';
  } finally {
    active--;
    pump();
    swiss.onChange();
  }
}

function pump() {
  for (const key of wanted) {
    if (active >= MAX_PARALLEL) return;
    if (!cells.has(key)) {
      cells.set(key, { state: 'loading', tile: null, used: performance.now() });
      loadCell(key);
    }
  }
}

function evict() {
  if (cells.size <= CACHE_CELLS) return;
  const keep = new Set(wanted);
  if (shownBox) for (let x = shownBox[0]; x <= shownBox[2]; x++) for (let y = shownBox[1]; y <= shownBox[3]; y++) keep.add(cellKey(x, y));
  const old = [...cells.entries()].filter(([k, c]) => !keep.has(k) && c.state !== 'loading').sort((a, b) => a[1].used - b[1].used);
  for (const [k] of old.slice(0, cells.size - CACHE_CELLS)) cells.delete(k);
}

const cellKey = (x, y) => `${x}/${y}`;

/** Status for the app: where real models replace the boxes, and a hook for redraws. */
export const swiss = {
  onChange: () => {},
  /**
   * Pick the cells for this view (a box of `half` metres around the centre) and start loading them.
   * The box buildings only step aside once every cell of the box has arrived, so panning never leaves holes.
   */
  update(center, zoom, half) {
    if (zoom < MIN_ZOOM) { wanted = []; shownBox = null; lights.box = [0, 0, 0, 0]; return; }
    if (!grid) { initGrid(); return; }
    const mLat = 111132, mLon = 111320 * Math.cos(center.lat * Math.PI / 180);
    const x0 = Math.floor((center.lng - half / mLon - grid.west) / grid.dx), x1 = Math.floor((center.lng + half / mLon - grid.west) / grid.dx);
    const y0 = Math.floor((center.lat - half / mLat - grid.south) / grid.dy), y1 = Math.floor((center.lat + half / mLat - grid.south) / grid.dy);
    const cx = (center.lng - grid.west) / grid.dx, cy = (center.lat - grid.south) / grid.dy;
    const list = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) list.push([(x + 0.5 - cx) ** 2 + ((y + 0.5 - cy) * grid.dy / grid.dx) ** 2, cellKey(x, y)]);
    wanted = list.sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    const now = performance.now();
    for (const k of wanted) { const c = cells.get(k); if (c) c.used = now; }
    pump();
    evict();
    const ready = wanted.every((k) => { const s = cells.get(k)?.state; return s && s !== 'loading'; });
    if (ready) shownBox = [x0, y0, x1, y1];
    lights.box = shownBox
      ? [grid.west + shownBox[0] * grid.dx, grid.south + shownBox[1] * grid.dy, grid.west + (shownBox[2] + 1) * grid.dx, grid.south + (shownBox[3] + 1) * grid.dy]
      : [0, 0, 0, 0];
  },
  get active() { return !!shownBox; },
  /** One mesh layer per loaded cell inside the shown box. */
  layers({ visible, opacity }) {
    if (!shownBox || !visible) return [];
    const out = [];
    for (let x = shownBox[0]; x <= shownBox[2]; x++) {
      for (let y = shownBox[1]; y <= shownBox[3]; y++) {
        const c = cells.get(cellKey(x, y));
        if (c?.state !== 'done') continue;
        out.push(new BuildingMeshLayer({
          id: `swiss-${x}-${y}`, data: [0], mesh: c.tile.mesh, getPosition: c.tile.position,
          getColor: [255, 255, 255], opacity,
        }));
      }
    }
    return out;
  },
};
