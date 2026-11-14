// Routable graph built from OSM ways, used to draw realistic vehicle paths between stops
// (the Swiss GTFS feed ships no shapes.txt).

const LAT0 = 47.37;
const MX = 111320 * Math.cos((LAT0 * Math.PI) / 180); // metres per degree lon
const MY = 110540; // metres per degree lat

export const toXY = (lon, lat) => [lon * MX, lat * MY];
const DENSIFY = 15; // metres

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

export class Graph {
  /**
   * @param elements Overpass JSON elements (ways with node refs + nodes)
   * @param wayCost  (tags) => cost factor (>=1) or null to skip the way
   * @param useOneway honour oneway tags (roads)
   */
  constructor(elements, wayCost, useOneway = false) {
    const coord = new Map();
    for (const el of elements) if (el.type === 'node') coord.set(el.id, el);
    const idx = new Map();
    this.x = []; this.y = []; this.lon = []; this.lat = [];
    this.adj = [];
    const nodeIndex = (id) => {
      let i = idx.get(id);
      if (i !== undefined) return i;
      const n = coord.get(id);
      if (!n) return -1;
      i = this.x.length;
      idx.set(id, i);
      const [x, y] = toXY(n.lon, n.lat);
      this.x.push(x); this.y.push(y); this.lon.push(n.lon); this.lat.push(n.lat);
      this.adj.push([]);
      return i;
    };
    for (const el of elements) {
      if (el.type !== 'way' || !el.nodes) continue;
      const t = el.tags || {};
      const f = wayCost(t);
      if (f == null) continue;
      let fwd = true, back = true;
      if (useOneway) {
        const psvExempt = t['oneway:bus'] === 'no' || t['oneway:psv'] === 'no' || t['busway'] === 'opposite_lane';
        const ow = t.oneway || (t.junction === 'roundabout' || t.highway === 'motorway' ? 'yes' : 'no');
        if (!psvExempt) {
          if (ow === 'yes' || ow === '1' || ow === 'true') back = false;
          else if (ow === '-1') fwd = false;
        }
      }
      let prev = -1;
      for (const nid of el.nodes) {
        const i = nodeIndex(nid);
        if (i < 0) { prev = -1; continue; }
        if (prev >= 0 && prev !== i) {
          // densify long edges so stops can snap anywhere along the track, not only at OSM nodes
          const d = Math.hypot(this.x[i] - this.x[prev], this.y[i] - this.y[prev]);
          const parts = Math.max(1, Math.ceil(d / DENSIFY));
          let a = prev;
          for (let p = 1; p <= parts; p++) {
            let b = i;
            if (p < parts) {
              const t = p / parts;
              b = this.x.length;
              this.x.push(this.x[prev] + (this.x[i] - this.x[prev]) * t);
              this.y.push(this.y[prev] + (this.y[i] - this.y[prev]) * t);
              this.lon.push(this.lon[prev] + (this.lon[i] - this.lon[prev]) * t);
              this.lat.push(this.lat[prev] + (this.lat[i] - this.lat[prev]) * t);
              this.adj.push([]);
            }
            const c = (d / parts) * f;
            if (fwd) this.adj[a].push(b, c);
            if (back) this.adj[b].push(a, c);
            a = b;
          }
        }
        prev = i;
      }
    }
    // spatial grid
    this.cell = 50;
    this.grid = new Map();
    for (let i = 0; i < this.x.length; i++) {
      if (this.adj[i].length === 0) continue;
      const k = this.key(Math.floor(this.x[i] / this.cell), Math.floor(this.y[i] / this.cell));
      let a = this.grid.get(k);
      if (!a) this.grid.set(k, (a = []));
      a.push(i);
    }
  }

  key(cx, cy) { return cx * 1e6 + cy; }

  /** Label connected components (treating edges as undirected); returns the largest one's id. */
  mainComponent() {
    if (this._main !== undefined) return this._main;
    const n = this.x.length;
    const und = Array.from({ length: n }, () => []);
    for (let u = 0; u < n; u++) for (let k = 0; k < this.adj[u].length; k += 2) { und[u].push(this.adj[u][k]); und[this.adj[u][k]].push(u); }
    this.comp = new Int32Array(n).fill(-1);
    let c = 0, best = -1, bestSize = 0;
    for (let i = 0; i < n; i++) {
      if (this.comp[i] >= 0 || !und[i].length) continue;
      const st = [i]; this.comp[i] = c; let size = 0;
      while (st.length) { const u = st.pop(); size++; for (const v of und[u]) if (this.comp[v] < 0) { this.comp[v] = c; st.push(v); } }
      if (size > bestSize) { bestSize = size; best = c; }
      c++;
    }
    return (this._main = best);
  }

  /** Up to `max` candidate nodes within radius r (metres), spread at least `spread` m apart. */
  candidates(lon, lat, r, max = 8, spread = 5) {
    const [x, y] = toXY(lon, lat);
    const c = this.cell;
    const found = [];
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const a = this.grid.get(this.key(cx, cy));
      if (!a) continue;
      for (const i of a) {
        const d = Math.hypot(this.x[i] - x, this.y[i] - y);
        if (d <= r) found.push([d, i]);
      }
    }
    found.sort((p, q) => p[0] - q[0]);
    const out = [];
    for (const [d, i] of found) {
      if (out.some(([, j]) => Math.hypot(this.x[i] - this.x[j], this.y[i] - this.y[j]) < spread)) continue;
      out.push([d, i]);
      if (out.length >= max) break;
    }
    return out;
  }

  /**
   * Multi-source / multi-target A*. Sources and targets are [snapDist, nodeIdx].
   * Snap distances are penalised so the path prefers the nearest track/lane.
   */
  route(srcs, dsts, tx, ty, maxCost, snapPenalty = 3) {
    const g = new Map();
    const prev = new Map();
    const heap = new MinHeap();
    const targetPen = new Map(dsts.map(([d, i]) => [i, d * snapPenalty]));
    const maxSnap = Math.max(...dsts.map(([d]) => d));
    const h = (i) => Math.max(0, Math.hypot(this.x[i] - tx, this.y[i] - ty) - maxSnap);
    for (const [d, i] of srcs) {
      const c = d * snapPenalty;
      if (!g.has(i) || g.get(i) > c) { g.set(i, c); prev.set(i, -1); heap.push(c + h(i), i); }
    }
    let best = Infinity, bestNode = -1;
    const closed = new Set();
    while (heap.size) {
      const u = heap.pop();
      if (closed.has(u)) continue;
      closed.add(u);
      const gu = g.get(u);
      if (gu + h(u) >= best || gu > maxCost) break;
      const tp = targetPen.get(u);
      if (tp !== undefined && gu + tp < best) { best = gu + tp; bestNode = u; }
      const a = this.adj[u];
      for (let k = 0; k < a.length; k += 2) {
        const v = a[k];
        const nv = gu + a[k + 1];
        const gv = g.get(v);
        if (gv === undefined || nv < gv) {
          g.set(v, nv);
          prev.set(v, u);
          heap.push(nv + h(v), v);
        }
      }
    }
    if (bestNode < 0) return null;
    const path = [];
    for (let n = bestNode; n !== -1; n = prev.get(n)) path.push(n);
    path.reverse();
    return path;
  }

  nearestNode(lon, lat) {
    const [x, y] = toXY(lon, lat);
    let best = -1, bd = Infinity;
    const main = this.mainComponent();
    for (const cell of this.grid.values()) {
      for (const i of cell) {
        if (this.comp[i] !== main) continue;
        const d = (this.x[i] - x) ** 2 + (this.y[i] - y) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  }

  /** Returns [[lon,lat],...] between two stops or null if no plausible path exists. */
  pathBetween(a, b, { radius = 60, detour = 3, slack = 400 } = {}) {
    const sa = this.candidates(a.lon, a.lat, radius);
    const sb = this.candidates(b.lon, b.lat, radius);
    if (!sa.length && !sb.length) return null;
    if (!sa.length || !sb.length) {
      // One stop lies outside the downloaded network (e.g. Zürich HB -> Basel):
      // follow the tracks to the network node nearest the far stop, then go straight.
      const outside = sa.length ? b : a;
      const exit = this.nearestNode(outside.lon, outside.lat);
      if (exit < 0) return null;
      const exitStop = { lon: this.lon[exit], lat: this.lat[exit] };
      const inner = sa.length
        ? this.pathBetween(a, exitStop, { radius, detour: 2, slack: 2000 })
        : this.pathBetween(exitStop, b, { radius, detour: 2, slack: 2000 });
      if (!inner) return null;
      return sa.length ? [...inner, [b.lon, b.lat]] : [[a.lon, a.lat], ...inner];
    }
    const [ax, ay] = toXY(a.lon, a.lat);
    const [bx, by] = toXY(b.lon, b.lat);
    const straight = Math.hypot(bx - ax, by - ay);
    const maxCost = (straight * detour + slack) * 2.5; // cost includes per-way factors
    const nodes = this.route(sa, sb, bx, by, maxCost);
    if (!nodes) return null;
    let len = 0;
    for (let i = 1; i < nodes.length; i++) {
      len += Math.hypot(this.x[nodes[i]] - this.x[nodes[i - 1]], this.y[nodes[i]] - this.y[nodes[i - 1]]);
    }
    if (len > straight * detour + slack) return null;
    return nodes.map((i) => [this.lon[i], this.lat[i]]);
  }
}

// Douglas-Peucker simplification on lon/lat using local metres.
export function simplify(coords, tol = 1.5) {
  if (coords.length <= 2) return coords;
  const pts = coords.map(([lon, lat]) => toXY(lon, lat));
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [x1, y1] = pts[s], [x2, y2] = pts[e];
    const dx = x2 - x1, dy = y2 - y1;
    const L = Math.hypot(dx, dy) || 1e-9;
    let maxD = 0, maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / L;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tol && maxI > 0) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}
