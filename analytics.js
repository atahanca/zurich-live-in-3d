// Privacy-friendly visitor statistics, counted by this server only: no cookies, no third parties,
// no IP addresses stored. The browser sends a tiny beacon per page view (public/track.js); the
// server keeps per-day totals. To count unique visitors, it hashes IP + browser with a random key
// that changes every day; the key and the day's hashes are thrown away at midnight (Zurich time),
// so visitors can't be recognised across days or traced back.
//
//   ANALYTICS=0            switch counting off
//   ANALYTICS_DIR=/path    where the daily totals are kept (default ~/.zuerich3d/analytics, outside
//                          the app folder so redeploys don't wipe it)
//   STATS_PASSWORD=...     enables the dashboard at /stats (HTTP basic auth, any user name)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FLUSH_MS = 5 * 60_000;
const ONLINE_MS = 2.5 * 60_000;     // the map polls /api/realtime every 30 s (once a minute in background tabs)
const MAX_KEYS = 300;               // per breakdown per day; the rest is counted as "other"
const MAX_VIEWS_PER_VISITOR = 100;  // per day, so one script can't inflate the numbers much
const MAX_EVENTS_PER_VISITOR = 300;

export const PAGES = { map: 1, privacy: 1, imprint: 1 };
export const EVENTS = { vehicle: 1, search: 1, alerts: 1, timetravel: 1, layers: 1, satellite: 1, '2d': 1, theme: 1, panel: 1 };
export const DURATIONS = ['<10s', '10-60s', '1-5min', '5-15min', '15-60min', '>1h'];
const BOT = /bot|crawl|spider|slurp|headless|preview|lighthouse|pingdom|monitor|curl|wget|python|java\/|go-http|node-fetch|axios|facebookexternalhit|embedly|whatsapp|telegram|discord/i;

const zurich = (opts, d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', ...opts }).format(d);
export const zurichDate = (d) => zurich({ year: 'numeric', month: '2-digit', day: '2-digit' }, d).replaceAll('-', '');
const zurichHour = () => +zurich({ hour: '2-digit', hourCycle: 'h23' }) % 24;

const emptyDay = (date) => ({
  date, views: {}, visitors: 0, newVisitors: 0, returning: 0, peakOnline: 0,
  hours: Array(24).fill(0), devices: {}, refs: {}, sources: {}, langs: {}, events: {}, durations: {},
});

function writeAtomic(file, text) {
  fs.writeFileSync(file + '.part', text);
  fs.renameSync(file + '.part', file);
}

function bump(map, key, n = 1) {
  if (!(key in map) && Object.keys(map).length >= MAX_KEYS) key = 'other';
  map[key] = (map[key] || 0) + n;
}

const clean = (s, re, max) => (typeof s === 'string' && s.length <= max && re.test(s) ? s.toLowerCase() : '');

// referrer host -> a readable source name (www./m./l. prefixes and app ids folded together)
function refName(host) {
  host = clean(host, /^[a-z0-9.-]+$/i, 100);
  if (!host) return '';
  if (/(^|\.)instagram/.test(host)) return 'instagram';
  if (/(^|\.)facebook|^fb\./.test(host)) return 'facebook';
  if (host === 't.co' || /(^|\.)(twitter|x)\.com$/.test(host)) return 'x/twitter';
  if (/(^|\.)reddit/.test(host)) return 'reddit';
  if (/(^|\.)linkedin|^lnkd\.in$/.test(host)) return 'linkedin';
  if (/(^|\.)google\./.test(host) || host === 'com.google.android.googlequicksearchbox') return 'google';
  return host.replace(/^(www\d?|m|l|lm|out|mobile)\./, '');
}

export function startAnalytics({ env = process.env, trustProxy = false, log = console.log } = {}) {
  if (/^(0|false|no)$/i.test(env.ANALYTICS || '')) return null;
  let dir = env.ANALYTICS_DIR || path.join(os.homedir(), '.zuerich3d', 'analytics');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    log(`Analytics: can't use ${dir} (${e.code}), counting in memory only`);
    dir = null;
  }
  const stateFile = dir && path.join(dir, 'today.json');
  const dayFile = (date) => path.join(dir, `${date}.json`);

  // today's totals plus the private bits needed to count unique visitors (deleted at day change)
  let day, salt, seen, dirty = false;
  const online = new Map(); // visitor hash -> last seen (ms); memory only

  function startDay(date) {
    day = emptyDay(date);
    salt = crypto.randomBytes(32);
    seen = {};
  }

  function load() {
    const today = zurichDate();
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (s.day?.date === today) { day = { ...emptyDay(today), ...s.day }; salt = Buffer.from(s.salt, 'base64'); seen = s.seen || {}; return; }
      if (s.day?.date) writeAtomic(dayFile(s.day.date), JSON.stringify(s.day)); // a day that ended while the server was down
    } catch { /* first start */ }
    startDay(today);
    dirty = true; // so the next save replaces a leftover today.json (and its old key)
  }

  function flush() {
    if (!dir || !dirty) return;
    try {
      writeAtomic(stateFile, JSON.stringify({ day, salt: salt.toString('base64'), seen }));
      writeAtomic(dayFile(day.date), JSON.stringify(day));
      dirty = false;
    } catch (e) { log(`Analytics: couldn't save (${e.message})`); }
  }

  function rollover() {
    const today = zurichDate();
    if (day.date === today) return;
    dirty = true;
    flush();
    startDay(today);
    online.clear();
    dirty = true;
    flush(); // overwrite today.json so yesterday's key and hashes are gone from disk too
  }

  function clientIp(req) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return (trustProxy || xff) && xff ? xff : req.socket.remoteAddress || '';
  }
  const visitorId = (req) => crypto.createHmac('sha256', salt)
    .update(`${clientIp(req)}|${req.headers['user-agent'] || ''}`).digest('base64url').slice(0, 16);
  const isBot = (req) => !req.headers['user-agent'] || BOT.test(req.headers['user-agent']);

  // GET/POST /api/hit?p=map&r=0&d=phone&ref=reddit.com&src=insta&l=de   (a page view)
  //          /api/hit?e=vehicle                                         (a feature used during the visit)
  //          /api/hit?t=95                                              (seconds spent, sent when leaving)
  function hit(req, url) {
    rollover();
    if (isBot(req)) return;
    const q = url.searchParams;
    const id = visitorId(req);
    const v = seen[id] || (seen[id] = [0, 0]);
    if (q.has('p')) {
      const page = q.get('p');
      if (!PAGES[page] || v[0] >= MAX_VIEWS_PER_VISITOR) return;
      if (v[0]++ === 0) {
        day.visitors++;
        if (q.get('r') === '0') day.newVisitors++; else day.returning++;
        bump(day.devices, ['phone', 'tablet', 'desktop'].includes(q.get('d')) ? q.get('d') : 'unknown');
        bump(day.langs, clean(q.get('l'), /^[a-z]{2}$/i, 2) || 'unknown');
      }
      bump(day.views, page);
      day.hours[zurichHour()]++;
      const ref = refName(q.get('ref'));
      if (ref) bump(day.refs, ref);
      const src = clean(q.get('src'), /^[a-z0-9_.-]+$/i, 40);
      if (src) bump(day.sources, src);
    } else if (q.has('e')) {
      if (!EVENTS[q.get('e')] || v[1]++ >= MAX_EVENTS_PER_VISITOR) return;
      bump(day.events, q.get('e'));
    } else if (q.has('t')) {
      const t = +q.get('t');
      if (!(t >= 0 && t < 86400) || v[1]++ >= MAX_EVENTS_PER_VISITOR) return;
      bump(day.durations, DURATIONS[t < 10 ? 0 : t < 60 ? 1 : t < 300 ? 2 : t < 900 ? 3 : t < 3600 ? 4 : 5]);
    } else return;
    dirty = true;
  }

  // every open map polls /api/realtime, which gives "visitors on the map right now"
  function ping(req) {
    rollover();
    if (isBot(req)) return;
    const now = Date.now();
    online.set(visitorId(req), now);
    const n = onlineNow(now);
    if (n > day.peakOnline) { day.peakOnline = n; dirty = true; }
  }

  function onlineNow(now = Date.now()) {
    for (const [k, t] of online) if (now - t > ONLINE_MS) online.delete(k);
    return online.size;
  }

  // the last n days of totals, oldest first (days without data are zero-filled)
  function days(n) {
    rollover();
    const out = [];
    const d = new Date();
    for (let i = 0; i < n; i++) {
      const date = zurichDate(new Date(d.getTime() - i * 86400_000));
      if (out.some((x) => x.date === date)) continue; // DST: same date twice
      let rec = date === day.date ? day : null;
      if (!rec && dir) try { rec = JSON.parse(fs.readFileSync(dayFile(date), 'utf8')); } catch { /* no data */ }
      out.push({ ...emptyDay(date), ...rec });
    }
    return out.reverse();
  }

  load();
  flush();
  setInterval(() => { rollover(); flush(); }, FLUSH_MS).unref?.();
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { flush(); process.exit(0); });
  log(`Analytics: counting visits${dir ? ` (totals in ${dir})` : ''}`);
  return { hit, ping, onlineNow, days, flush, dir };
}
