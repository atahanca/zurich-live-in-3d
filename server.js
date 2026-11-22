// Small static server for ./public with gzip, security headers and the /api/realtime endpoint.
// No dependencies.
//   node server.js [port]
//
// Environment (.env or process env):
//   PORT=8080          port to listen on
//   HOST=0.0.0.0       interface to bind; use 127.0.0.1 behind a reverse proxy (Caddy/nginx)
//   FORCE_HTTPS=1      redirect plain-HTTP requests to https:// and send HSTS
//   TRUST_PROXY=1      trust X-Forwarded-Proto/-Host from the reverse proxy (needed with FORCE_HTTPS behind a proxy)
//   OTD_API_KEY=...    opentransportdata.swiss GTFS-RT key (optional)
//   DATA_REFRESH=0     don't rebuild the timetable nightly from inside the server (default: on)
//   ANALYTICS=0        don't count visits (see analytics.js; ANALYTICS_DIR sets where totals are kept)
//   STATS_PASSWORD=... password for the visitor statistics at /stats (off when unset)
//   MAINTENANCE=1      take the map offline: visitors get a maintenance page (503); imprint, privacy and /stats stay up
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startRealtime, loadEnv } from './realtime.js';
import { startWeather } from './weather.js';
import { startDataRefresh } from './datarefresh.js';
import { startAnalytics } from './analytics.js';
import { checkAuth, renderStats } from './statspage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'public');
const env = { ...loadEnv(path.join(HERE, '.env')), ...process.env };
const PORT = +(process.argv[2] || env.PORT || 8080);
const HOST = env.HOST || '0.0.0.0';
const FORCE_HTTPS = /^(1|true|yes)$/i.test(env.FORCE_HTTPS || '');
const TRUST_PROXY = /^(1|true|yes)$/i.test(env.TRUST_PROXY || '');
if (!/^(0|false|no)$/i.test(env.DATA_REFRESH || '')) startDataRefresh({ root: HERE, dataDir: path.join(ROOT, 'data') });
const weather = startWeather();
const analytics = startAnalytics({ env, trustProxy: TRUST_PROXY });
const STATS_PASSWORD = env.STATS_PASSWORD || '';
const realtime = startRealtime({ dataDir: path.join(ROOT, 'data'), apiKey: env.OTD_API_KEY });
const MAINTENANCE = /^(1|true|yes)$/i.test(env.MAINTENANCE || '');
if (MAINTENANCE) console.log('Maintenance mode: the map and its APIs are offline (MAINTENANCE=1)');

// Maintenance mode keeps the legal pages (and what they load) and the owner's /stats reachable.
const MAINTENANCE_OPEN = new Set(['/imprint.html', '/privacy.html', '/legal.css', '/style.css', '/track.js', '/stats', '/stats/']);
const maintenanceOpen = (p) => MAINTENANCE_OPEN.has(p) || p.startsWith('/fonts/');
const MAINTENANCE_PAGE = Buffer.from(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Back soon · Zurich 3D</title>
  <meta name="robots" content="noindex" />
  <link rel="stylesheet" href="/legal.css" />
</head>
<body>
<main>
  <header class="legal">
    <a class="brand" href="/"><span class="word">ZÜRICH</span><span class="accent">3D</span></a>
    <nav><a href="/privacy.html">Privacy</a><a href="/imprint.html">Imprint</a></nav>
  </header>
  <h1>Back soon</h1>
  <p class="updated">Down for maintenance</p>
  <p>Zurich 3D is offline for a little while for maintenance. The trams are still running, we just can't show them right now.</p>
  <p>Please check back later.</p>
</main>
</body>
</html>
`);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

// External hosts the browser talks to: map tiles/styles/fonts (OpenFreeMap) and satellite imagery (swisstopo).
const MAP_HOSTS = 'https://tiles.openfreemap.org https://wmts.geo.admin.ch';
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",          // MapLibre runs its tile workers from blob: URLs
  "child-src blob:",
  "style-src 'self' 'unsafe-inline'", // MapLibre/deck.gl and line badges use inline style attributes
  `img-src 'self' data: blob: ${MAP_HOSTS}`,
  `connect-src 'self' ${MAP_HOSTS}`,
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(secure) {
  const h = {
    'Content-Security-Policy': CSP + (secure ? '; upgrade-insecure-requests' : ''),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // never tell the map tile providers which page a visitor was on
    'Referrer-Policy': 'same-origin',
    // switch off browser features the site never uses (incl. Topics ad profiling)
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'Origin-Agent-Cluster': '?1',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (secure) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

function isSecure(req) {
  if (req.socket.encrypted) return true;
  return TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function cacheControl(rel) {
  if (rel.startsWith('/fonts/') || rel.startsWith('/vendor/')) return 'public, max-age=604800';
  return 'no-cache'; // pages, app code and timetable data: always revalidate
}

const gzCache = new Map(); // path -> {mtime, buf}

const server = http.createServer((req, res) => {
  const secure = isSecure(req);
  const base = securityHeaders(secure);
  const send = (status, headers = {}, body) => {
    res.writeHead(status, { ...base, ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  // the visit beacon is the only POST (navigator.sendBeacon); its body is empty and ignored
  const beacon = req.url.startsWith('/api/hit?');
  if (req.method !== 'GET' && req.method !== 'HEAD' && !(beacon && req.method === 'POST')) {
    send(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }, 'Method not allowed');
    return;
  }

  if (FORCE_HTTPS && !secure) {
    const host = (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host || '';
    if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) { send(400, { 'Content-Type': 'text/plain' }, 'Bad request'); return; }
    send(301, { Location: `https://${host.replace(/:\d+$/, '')}${req.url}`, 'Content-Type': 'text/plain' }, 'Moved to HTTPS');
    return;
  }

  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    send(400, { 'Content-Type': 'text/plain' }, 'Bad request');
    return;
  }

  if (beacon) {
    req.resume();
    analytics?.hit(req, new URL(req.url, 'http://x'));
    send(204, { 'Cache-Control': 'no-store' });
    return;
  }

  if (MAINTENANCE && !maintenanceOpen(p)) {
    send(503, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '3600',
      'X-Robots-Tag': 'noindex', 'Content-Length': MAINTENANCE_PAGE.length,
    }, MAINTENANCE_PAGE);
    return;
  }

  if (p === '/stats' || p === '/stats/') {
    if (!analytics || !STATS_PASSWORD) { send(404, { 'Content-Type': 'text/plain' }, 'Not found'); return; }
    const auth = checkAuth(req, STATS_PASSWORD);
    if (auth !== 'ok') {
      send(auth === 'locked' ? 429 : 401, {
        'Content-Type': 'text/plain', 'Cache-Control': 'no-store',
        ...(auth === 'ask' && { 'WWW-Authenticate': 'Basic realm="Zurich 3D stats", charset="UTF-8"' }),
      }, auth === 'locked' ? 'Too many attempts, try again in 15 minutes' : 'Password required');
      return;
    }
    const asked = +new URL(req.url, 'http://x').searchParams.get('days');
    const range = [7, 30, 90, 365].includes(asked) ? asked : 30;
    const body = zlib.gzipSync(renderStats(analytics, range));
    send(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Length': body.length }, body);
    return;
  }

  if (p === '/api/realtime') {
    realtime.touch?.();
    analytics?.ping(req);
    const body = zlib.gzipSync(realtime.json || '{}');
    send(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store', 'Content-Length': body.length }, body);
    return;
  }

  if (p === '/api/weather') {
    const body = zlib.gzipSync(weather.json);
    send(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store', 'Content-Length': body.length }, body);
    return;
  }

  if (p.endsWith('/')) p += 'index.html';
  // no hidden files (e.g. .env would never be under public/, but stay strict) and no path tricks
  if (p.includes('\0') || p.split('/').some((seg) => seg.startsWith('.'))) { send(404, { 'Content-Type': 'text/plain' }, 'Not found'); return; }
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep)) { send(403, { 'Content-Type': 'text/plain' }, 'Forbidden'); return; }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { send(404, { 'Content-Type': 'text/plain' }, 'Not found'); return; }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': cacheControl(p) };
    const gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /json|javascript|css|html|svg|text\/plain/.test(type);
    if (!gzipOk) {
      res.writeHead(200, { ...base, ...headers, 'Content-Length': st.size });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      return;
    }
    let c = gzCache.get(file);
    if (!c || c.mtime !== st.mtimeMs) {
      try {
        c = { mtime: st.mtimeMs, buf: zlib.gzipSync(fs.readFileSync(file), { level: 6 }) };
      } catch {
        send(500, { 'Content-Type': 'text/plain' }, 'Server error');
        return;
      }
      gzCache.set(file, c);
    }
    send(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': c.buf.length, Vary: 'Accept-Encoding' }, c.buf);
  });
});

server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.listen(PORT, HOST, () => console.log(`Zurich 3D running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${FORCE_HTTPS ? ' (HTTPS enforced)' : ''}`));
