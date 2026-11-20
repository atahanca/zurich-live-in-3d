// Streaming reader for GTFS files inside a zip, without extracting to disk.
// Pure Node (no `unzip` binary needed), so it also runs on hosts with a bare build image.
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';

const MAX32 = 0xffffffff;

/** Open one file inside a zip as a stream of its uncompressed bytes (stored or deflated, zip64 aware). */
export function zipEntryStream(zipPath, name) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const read = (len, pos) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
    const size = fs.fstatSync(fd).size;
    // end-of-central-directory record: last 22 bytes + up to 64 KB comment, plus the zip64 locator before it
    const tailLen = Math.min(size, 22 + 0xffff + 20);
    const tail = read(tailLen, size - tailLen);
    const e = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (e < 0) throw new Error(`${zipPath} is not a zip file`);
    let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (cdOff === MAX32 || cdSize === MAX32 || count === 0xffff) {
      if (e < 20 || tail.readUInt32LE(e - 20) !== 0x07064b50) throw new Error('zip64 locator missing');
      const z = read(56, Number(tail.readBigUInt64LE(e - 12)));
      count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
    }
    const cd = read(cdSize, cdOff);
    for (let p = 0, i = 0; i < count; i++) {
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24), lho = cd.readUInt32LE(p + 42);
      const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      if (cd.toString('utf8', p + 46, p + 46 + nlen) === name) {
        // zip64 extra field holds the 64-bit values of whichever fields are 0xffffffff, in this order
        for (let x = p + 46 + nlen, end = x + xlen; x + 4 <= end; x += 4 + cd.readUInt16LE(x + 2)) {
          if (cd.readUInt16LE(x) !== 1) continue;
          let q = x + 4;
          if (usize === MAX32) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === MAX32) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (lho === MAX32) lho = Number(cd.readBigUInt64LE(q));
        }
        const lh = read(30, lho);
        const start = lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        if (!csize) return Readable.from([]);
        const raw = fs.createReadStream(zipPath, { start, end: start + csize - 1 });
        if (method === 0) return raw;
        if (method !== 8) throw new Error(`${name}: unsupported zip compression method ${method}`);
        const inflate = zlib.createInflateRaw();
        raw.on('error', (err) => inflate.destroy(err));
        return raw.pipe(inflate);
      }
      p += 46 + nlen + xlen + clen;
    }
    throw new Error(`${name} not found in ${zipPath}`);
  } finally {
    fs.closeSync(fd);
  }
}

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
  const input = zipEntryStream(zipPath, file);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
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
      if (onRow(f, col) === false) { input.destroy(); break; }
    } else {
      const row = {};
      for (let i = 0; i < header.length; i++) row[header[i]] = f[i];
      if (onRow(row) === false) { input.destroy(); break; }
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
