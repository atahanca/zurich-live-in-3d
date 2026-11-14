// Real-time delays from the opentransportdata.swiss GTFS-RT feed.
// Polls the feed (max 2 requests/minute allowed), keeps only trips that appear in our
// timetables, and serves them as compact JSON at /api/realtime.
import fs from 'node:fs';
import path from 'node:path';

const FEED_URL = 'https://api.opentransportdata.swiss/la/gtfs-rt';
const POLL_MS = 35_000; // limit is 2 requests per sliding minute; data refreshes every 30 s
const IDLE_MS = 120_000; // stop polling (8 MB per request) when no browser has asked for a while

// ---------------------------------------------------------------- minimal protobuf reader
class Reader {
  constructor(buf, pos = 0, end = buf.length) { this.b = buf; this.p = pos; this.end = end; }
  more() { return this.p < this.end; }
  // varint as [low32, high32] so negative int32 / large uint64 survive
  varint() {
    let lo = 0, hi = 0, shift = 0, byte;
    do {
      byte = this.b[this.p++];
      if (shift < 28) lo |= (byte & 0x7f) << shift;
      else if (shift === 28) { lo |= (byte & 0x0f) << 28; hi |= (byte & 0x7f) >> 4; }
      else hi |= (byte & 0x7f) << (shift - 32);
      shift += 7;
    } while (byte & 0x80);
    return [lo >>> 0, hi >>> 0];
  }
  uint() { const [lo, hi] = this.varint(); return hi * 4294967296 + lo; }
  int32() { return this.varint()[0] | 0; }
  bytes() { const n = this.uint(); const s = this.p; this.p += n; return [s, s + n]; }
  string() { const [s, e] = this.bytes(); return this.b.toString('utf8', s, e); }
  sub() { const [s, e] = this.bytes(); return new Reader(this.b, s, e); }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.p += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.p += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  // iterate fields: fn(fieldNo, wireType)
  each(fn) {
    while (this.more()) {
      const [key] = this.varint();
      const field = key >>> 3, wire = key & 7;
      if (fn(field, wire) === false) this.skip(wire);
    }
  }
}

function stopTimeEvent(r) {
  const ev = {};
  r.each((f) => {
    if (f === 1) ev.delay = r.int32();
    else if (f === 2) ev.time = r.uint();
    else return false;
  });
  return ev;
}

function stopTimeUpdate(r) {
  const u = { rel: 0 };
  r.each((f) => {
    if (f === 1) u.seq = r.uint();
    else if (f === 2) u.arr = stopTimeEvent(r.sub());
    else if (f === 3) u.dep = stopTimeEvent(r.sub());
    else if (f === 4) u.stop = r.string();
    else if (f === 5) u.rel = r.uint(); // 0 SCHEDULED, 1 SKIPPED, 2 NO_DATA
    else return false;
  });
  return u;
}

function tripDescriptor(r) {
  const t = { rel: 0 };
  r.each((f) => {
    if (f === 1) t.id = r.string();
    else if (f === 3) t.date = r.string();
    else if (f === 4) t.rel = r.uint(); // 0 SCHEDULED, 1 ADDED, 3 CANCELED ...
    else return false;
  });
  return t;
}

function tripUpdate(r) {
  const tu = { stu: [] };
  r.each((f) => {
    if (f === 1) tu.trip = tripDescriptor(r.sub());
    else if (f === 2) tu.stu.push(stopTimeUpdate(r.sub()));
    else if (f === 5) tu.delay = r.int32();
    else return false;
  });
  return tu;
}

export function decodeFeed(buf) {
  const r = new Reader(buf);
  const feed = { timestamp: 0, updates: [] };
  r.each((f) => {
    if (f === 1) {
      const h = r.sub();
      h.each((hf) => { if (hf === 3) feed.timestamp = h.uint(); else return false; });
    } else if (f === 2) {
      const e = r.sub();
      e.each((ef) => { if (ef === 3) feed.updates.push(tripUpdate(e.sub())); else return false; });
    } else return false;
  });
  return feed;
}

// ---------------------------------------------------------------- polling + filtering
export function startRealtime({ dataDir, apiKey, log = console.log }) {
  const state = {
    enabled: !!apiKey,
    status: apiKey ? 'starting' : 'no-key',
    error: null,
    fetchedAt: 0,
    feedTimestamp: 0,
    trips: {},          // "tripId|YYYYMMDD" -> { c: 1 } or { u: [[seq, arrDelay, depDelay, skipped]...] }
    json: null,
    lastRequest: 0, // set by the server whenever a browser fetches /api/realtime
  };
  if (!apiKey) {
    log('Real-time: no OTD_API_KEY in .env, serving the scheduled timetable only.');
    state.json = JSON.stringify(publicState(state));
    return state;
  }

  // the set of trips we care about, rebuilt when timetable files change
  let wanted = new Set();
  let wantedStamp = '';
  function refreshWanted() {
    let idx;
    try { idx = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8')); } catch { return; }
    const files = idx.days.map((d) => path.join(dataDir, `timetable-${d}.json`)).filter((f) => fs.existsSync(f));
    const stamp = files.map((f) => f + fs.statSync(f).mtimeMs).join('|');
    if (stamp === wantedStamp) return;
    const set = new Set();
    for (const file of files) {
      const tt = JSON.parse(fs.readFileSync(file, 'utf8'));
      const prev = (d) => {
        const x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) - 1));
        return x.toISOString().slice(0, 10).replaceAll('-', '');
      };
      for (const t of tt.trips) if (t[6]) set.add(`${t[6]}|${t[7] ? prev(tt.date) : tt.date}`);
    }
    wanted = set;
    wantedStamp = stamp;
    log(`Real-time: watching ${set.size} trips`);
  }

  async function poll() {
    refreshWanted();
    try {
      const res = await fetch(FEED_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': 'zurich-3d/0.1',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) throw new Error('rate limit exceeded (max 2 requests/minute)');
      if (res.status === 401 || res.status === 403) throw new Error(`API key rejected (HTTP ${res.status}) — check OTD_API_KEY and that GTFS-RT is subscribed`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const feed = decodeFeed(buf);
      const trips = {};
      let delayed = 0, canceled = 0;
      for (const tu of feed.updates) {
        const t = tu.trip;
        if (!t?.id) continue;
        const key = `${t.id}|${t.date || ''}`;
        if (!wanted.has(key)) continue;
        if (t.rel === 3) { trips[key] = { c: 1 }; canceled++; continue; }
        const u = [];
        for (const s of tu.stu) {
          if (s.seq === undefined) continue;
          const a = s.arr?.delay ?? s.dep?.delay;
          const d = s.dep?.delay ?? s.arr?.delay;
          if (a === undefined && s.rel !== 1) continue;
          u.push([s.seq, a ?? 0, d ?? 0, s.rel === 1 ? 1 : 0]);
        }
        if (!u.length && tu.delay !== undefined) u.push([0, tu.delay, tu.delay, 0]);
        if (!u.length) continue;
        u.sort((x, y) => x[0] - y[0]);
        trips[key] = { u };
        if (u.some((x) => Math.abs(x[1]) >= 60)) delayed++;
      }
      state.trips = trips;
      state.fetchedAt = Date.now();
      state.feedTimestamp = feed.timestamp;
      state.status = 'ok';
      state.error = null;
      log(`Real-time: ${feed.updates.length} updates in feed (${(buf.length / 1e6).toFixed(1)} MB), ${Object.keys(trips).length} in area, ${delayed} delayed ≥1 min, ${canceled} cancelled`);
    } catch (e) {
      state.status = 'error';
      state.error = e.message;
      log(`Real-time: ${e.message}`);
    }
    state.json = JSON.stringify(publicState(state));
  }

  let polling = false;
  async function maybePoll() {
    const idle = Date.now() - state.lastRequest > IDLE_MS;
    if (polling || (idle && state.fetchedAt)) {
      if (idle && state.status === 'ok') state.status = 'idle';
      return;
    }
    polling = true;
    try { await poll(); } finally { polling = false; }
  }
  // a browser asking after an idle period triggers an immediate refresh
  state.touch = () => {
    const wasIdle = Date.now() - state.lastRequest > IDLE_MS;
    state.lastRequest = Date.now();
    if (wasIdle && Date.now() - state.fetchedAt > POLL_MS) maybePoll();
  };
  maybePoll();
  setInterval(maybePoll, POLL_MS).unref?.();
  return state;
}

function publicState(s) {
  return { enabled: s.enabled, status: s.status, error: s.error, fetchedAt: s.fetchedAt, feedTimestamp: s.feedTimestamp, trips: s.trips };
}

export function loadEnv(file) {
  const env = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
  return env;
}
