// Streaming reader for GTFS files inside a zip, without extracting to disk.
// Uses `unzip -p` (Git for Windows / Linux / macOS) and falls back to Windows' bsdtar.
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

function pickExtractor() {
  if (spawnSync('unzip', ['-v']).status === 0) return (zip, f) => ['unzip', ['-p', zip, f]];
  const winTar = 'C:\\Windows\\System32\\tar.exe';
  if (spawnSync(winTar, ['--version']).status === 0) return (zip, f) => [winTar, ['-xOf', zip, f]];
  throw new Error('Need `unzip` (or Windows tar.exe) on PATH to read the GTFS zip');
}
const extractor = pickExtractor();

// Minimal CSV line splitter that handles double-quoted fields (GTFS style).
export function splitCsv(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i <= n) {
    if (line[i] === '"') {
      let s = '';
      i++;
      for (;;) {
        let j = line.indexOf('"', i);
        if (j === -1) j = n;
        s += line.slice(i, j);
        if (line[j + 1] === '"') { s += '"'; i = j + 2; continue; }
        i = j + 1;
        break;
      }
      out.push(s);
      i++; // skip comma
    } else {
      let j = line.indexOf(',', i);
      if (j === -1) j = n;
      out.push(line.slice(i, j));
      i = j + 1;
    }
  }
  return out;
}

/**
 * Iterate rows of a GTFS file. Calls onRow(row) where row is an object keyed by header,
 * or, if `raw` is true, onRow(fields, colIndex) with an array (much faster for big files).
 */
export async function readGtfs(zipPath, file, onRow, { raw = false, progressEvery = 0 } = {}) {
  const [cmd, args] = extractor(zipPath, file);
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let header = null;
  let col = null;
  let count = 0;
  for await (let line of rl) {
    if (!header) {
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
      header = splitCsv(line);
      col = Object.fromEntries(header.map((h, i) => [h, i]));
      continue;
    }
    if (!line) continue;
    const f = splitCsv(line);
    if (raw) {
      if (onRow(f, col) === false) { child.kill(); break; }
    } else {
      const row = {};
      for (let i = 0; i < header.length; i++) row[header[i]] = f[i];
      if (onRow(row) === false) { child.kill(); break; }
    }
    count++;
    if (progressEvery && count % progressEvery === 0) {
      process.stdout.write(`\r  ${file}: ${(count / 1e6).toFixed(1)}M rows`);
    }
  }
  if (progressEvery) process.stdout.write(`\r  ${file}: ${count} rows done\n`);
  return count;
}

export function timeToSec(t) {
  // "25:13:00" -> seconds; GTFS allows hours >= 24
  const a = t.split(':');
  return (+a[0]) * 3600 + (+a[1]) * 60 + (+a[2] || 0);
}
