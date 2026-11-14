// Tiny static server for ./public with gzip (no dependencies).
//   node server.js [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startRealtime, loadEnv } from './realtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'public');
const env = { ...loadEnv(path.join(HERE, '.env')), ...process.env };
const realtime = startRealtime({ dataDir: path.join(ROOT, 'data'), apiKey: env.OTD_API_KEY });
const PORT = +(process.argv[2] || env.PORT || 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const gzCache = new Map(); // path -> {mtime, buf}

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/api/realtime') {
    realtime.touch?.();
    const body = zlib.gzipSync(realtime.json || '{}');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
    const gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /json|javascript|css|html|svg/.test(type);
    if (!gzipOk) { res.writeHead(200, headers); fs.createReadStream(file).pipe(res); return; }
    let c = gzCache.get(file);
    if (!c || c.mtime !== st.mtimeMs) {
      c = { mtime: st.mtimeMs, buf: zlib.gzipSync(fs.readFileSync(file), { level: 6 }) };
      gzCache.set(file, c);
    }
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': c.buf.length });
    res.end(c.buf);
  });
}).listen(PORT, () => console.log(`Zurich 3D running at http://localhost:${PORT}`));
