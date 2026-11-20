// Keeps public/data current while the server runs for weeks without a redeploy: once a day (after
// 03:00 Zurich time) it rebuilds the timetable in a child process, downloading a fresh GTFS export
// when the old one is a few days old. The server keeps serving the existing files meanwhile, and the
// build replaces them atomically. Turn off with DATA_REFRESH=0 (e.g. when a cron job does it instead).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHECK_MS = 15 * 60_000;
const RETRY_MS = 3 * 3600_000;   // after a failed build, wait before trying again
const REBUILD_HOUR = 3;          // nightly rebuild once the day's first trams are about to start

const zurich = (opts, d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', ...opts }).format(d);
const zurichDate = (d) => zurich({ year: 'numeric', month: '2-digit', day: '2-digit' }, d).replaceAll('-', '');
const zurichHour = () => +zurich({ hour: '2-digit', hourCycle: 'h23' });

export function startDataRefresh({ root, dataDir, log = console.log }) {
  let running = false;
  let lastFail = 0;

  function reason() {
    let idx;
    try { idx = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8')); } catch { return 'no timetable data yet'; }
    const today = zurichDate();
    if (!idx.days?.includes(today)) return 'no timetable for today';
    if (zurichDate(new Date(idx.generated)) !== today && zurichHour() >= REBUILD_HOUR) return 'daily refresh';
    return null;
  }

  // run one script; resolves to null on success or to the last line of its error output
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => { err = (err + c).slice(-4000); });
    child.on('error', (e) => resolve(e.message));
    child.on('close', (code) => resolve(code === 0 ? null : err.trim().split('\n').pop() || `exit code ${code}`));
  });

  async function check() {
    const why = reason();
    if (!why || running || Date.now() - lastFail < RETRY_MS) return;
    running = true;
    const t0 = Date.now();
    log(`Data: rebuilding the timetable (${why})…`);
    const err = (await run(['scripts/fetch-gtfs.js']))
      ?? (await run(['--max-old-space-size=4096', 'scripts/build-timetable.js']));
    running = false;
    if (err) { lastFail = Date.now(); log(`Data: rebuild failed, keeping the current files: ${err}`); }
    else log(`Data: timetable rebuilt in ${Math.round((Date.now() - t0) / 1000)} s`);
  }

  check();
  setInterval(check, CHECK_MS).unref?.();
}
