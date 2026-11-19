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
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startRealtime, loadEnv } from './realtime.js';
import { startWeather } from './weather.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'public');
const env = { ...loadEnv(path.join(HERE, '.env')), ...process.env };
const PORT = +(process.argv[2] || env.PORT || 8080);
const HOST = env.HOST || '0.0.0.0';
const FORCE_HTTPS = /^(1|true|yes)$/i.test(env.FORCE_HTTPS || '');
const TRUST_PROXY = /^(1|true|yes)$/i.test(env.TRUST_PROXY || '');
const weather = startWeather();
const realtime = startRealtime({ dataDir: path.join(ROOT, 'data'), apiKey: env.OTD_API_KEY });

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

  if (req.method !== 'GET' && req.method !== 'HEAD') {
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

  if (p === '/api/realtime') {
    realtime.touch?.();
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
