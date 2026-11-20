// Downloads the current Swiss GTFS timetable (opentransportdata.swiss, ~300 MB).
//   node scripts/fetch-gtfs.js [--force]
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gtfsUrls, GTFS_ZIP, RAW_DIR } from './config.js';

// opentransportdata.swiss publishes a new export on Mondays and Thursdays, and GTFS-RT trip IDs
// follow the newest one, so refresh after 3 days at the latest
const MAX_AGE_DAYS = 3;

if (fs.existsSync(GTFS_ZIP) && !process.argv.includes('--force')) {
  const ageDays = (Date.now() - fs.statSync(GTFS_ZIP).mtimeMs) / 864e5;
  if (ageDays < MAX_AGE_DAYS) {
    console.log(`GTFS is ${ageDays.toFixed(1)} days old, keeping it (use --force to refresh).`);
    process.exit(0);
  }
}
fs.mkdirSync(RAW_DIR, { recursive: true });
let res;
for (const url of gtfsUrls()) {
  console.log(`Downloading ${url} ...`);
  res = await fetch(url, { redirect: 'follow' });
  if (res.ok) break;
  console.log(`  HTTP ${res.status}`);
}
if (!res.ok) throw new Error('No GTFS dataset found');
const total = +res.headers.get('content-length') || 0;
let got = 0;
const tmp = GTFS_ZIP + '.part';
const body = Readable.fromWeb(res.body);
body.on('data', (c) => {
  got += c.length;
  process.stdout.write(`\r  ${(got / 1e6).toFixed(0)} MB${total ? ` / ${(total / 1e6).toFixed(0)} MB` : ''}`);
});
await pipeline(body, fs.createWriteStream(tmp));
fs.renameSync(tmp, GTFS_ZIP);
console.log(`\nSaved ${GTFS_ZIP} (${res.url.split('?')[0].split('/').pop()})`);
