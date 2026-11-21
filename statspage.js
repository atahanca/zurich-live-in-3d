// The /stats dashboard: plain server-rendered HTML (the site's CSP allows no inline scripts, and none
// are needed). Behind HTTP basic auth with STATS_PASSWORD.
import crypto from 'node:crypto';
import { EVENTS, DURATIONS } from './analytics.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n) => Math.round(n).toLocaleString('de-CH');
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : '–');
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const merge = (days, key) => {
  const m = {};
  for (const d of days) for (const [k, v] of Object.entries(d[key] || {})) m[k] = (m[k] || 0) + v;
  return m;
};
const dateLabel = (s) => `${+s.slice(6, 8)}.${+s.slice(4, 6)}.`;
const weekday = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8))).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });

const FEATURE_NAMES = {
  vehicle: 'Clicked a vehicle', search: 'Searched a line or stop', alerts: 'Opened disruptions', timetravel: 'Travelled in time',
  layers: 'Changed a layer', satellite: 'Switched to satellite', '2d': 'Switched to 2D', theme: 'Picked a day/night theme', panel: 'Opened the layers panel',
};

// ------------------------------------------------------------ auth
const fails = new Map(); // ip -> {n, until}
export function checkAuth(req, password) {
  const ip = req.socket.remoteAddress || '';
  const f = fails.get(ip);
  if (f && f.until > Date.now()) return 'locked';
  const m = /^Basic (.+)$/i.exec(req.headers.authorization || '');
  const given = m ? Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':') : '';
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  if (given && crypto.timingSafeEqual(h(given), h(password))) { fails.delete(ip); return 'ok'; }
  if (given) {
    const n = (f?.n || 0) + 1;
    fails.set(ip, { n, until: n >= 10 ? Date.now() + 15 * 60_000 : 0 });
  }
  return 'ask';
}

// ------------------------------------------------------------ charts (HTML columns, so labels stay readable on phones)
function columns(values, labels, { height = 160, title, unit, every = 1, weekend = [] } = {}) {
  const nice = niceMax(Math.max(1, ...values));
  const axis = [1, 0.5, 0].map((f) => `<span style="bottom:${f * 100}%"><b>${fmt(nice * f)}</b></span>`).join('');
  const cols = values.map((v, i) => `<div class="col" title="${esc(labels[i])}: ${fmt(v)} ${unit}">
    <div class="plot"><i style="height:${(100 * v) / nice}%"></i></div>
    <span class="lab${weekend[i] ? ' we' : ''}">${i % every === 0 ? esc(labels[i]) : ''}</span></div>`).join('');
  return `<div class="chart" role="img" aria-label="${esc(title)}" style="--h:${height}px"><div class="yaxis">${axis}</div><div class="cols">${cols}</div></div>`;
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 4, 6, 8, 10]) if (m * p >= v) return Math.max(2, m * p);
  return v;
}

function ranking(map, { total, names = {}, limit = 12, empty = 'No data yet', sort = true } = {}) {
  const rows = (sort ? Object.entries(map).sort((a, b) => b[1] - a[1]) : Object.entries(map)).slice(0, limit);
  const max = Math.max(...rows.map((r) => r[1]));
  if (!rows.length) return `<p class="empty">${empty}</p>`;
  const base = total ?? sum(Object.values(map));
  return `<table class="rank">${rows.map(([k, v]) => `<tr>
    <td class="k">${esc(names[k] || k)}<span class="track"><span style="width:${(100 * v) / max}%"></span></span></td>
    <td class="n">${fmt(v)}</td><td class="p">${pct(v, base)}</td></tr>`).join('')}</table>`;
}

// ------------------------------------------------------------ page
export function renderStats(analytics, range) {
  const days = analytics.days(range);
  const visitors = sum(days.map((d) => d.visitors));
  const views = sum(days.map((d) => sum(Object.values(d.views))));
  const mapViews = sum(days.map((d) => d.views.map || 0));
  const returning = sum(days.map((d) => d.returning));
  const durations = merge(days, 'durations');
  const durTotal = sum(Object.values(durations));
  const stayed = sum(DURATIONS.slice(2).map((k) => durations[k] || 0));
  const peak = Math.max(0, ...days.map((d) => d.peakOnline));
  const hours = Array(24).fill(0);
  for (const d of days) d.hours.forEach((v, i) => { hours[i] += v; });
  const today = days[days.length - 1];
  const daily = days.map((d) => d.visitors);
  const weekend = days.map((d) => ['Sat', 'Sun'].includes(weekday(d.date)));
  const every = range <= 14 ? 1 : range <= 31 ? 3 : range <= 92 ? 7 : 30;

  const tile = (label, value, sub = '') => `<div class="tile"><div class="tl">${label}</div><div class="tv">${value}</div>${sub ? `<div class="ts">${sub}</div>` : ''}</div>`;
  const ranges = [7, 30, 90, 365].map((r) => `<a href="?days=${r}"${r === range ? ' aria-current="page"' : ''}>${r === 365 ? '1 year' : `${r} days`}</a>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Stats · Zurich 3D</title><style>${CSS}</style></head><body><main>
<header><a class="brand" href="./"><span class="word">ZÜRICH</span><span class="accent">3D</span></a><span class="h">Visitor statistics</span><nav>${ranges}</nav></header>

<section class="tiles">
  ${tile('On the map now', fmt(analytics.onlineNow()), `peak ${fmt(peak)} at once in this period`)}
  ${tile('Visitors', fmt(visitors), `today ${fmt(today.visitors)}`)}
  ${tile('Page views', fmt(views), `${visitors ? (views / visitors).toFixed(1) : '–'} per visitor`)}
  ${tile('Returning visitors', pct(returning, visitors), 'had been on the site on an earlier day')}
  ${tile('Stayed over 1 minute', pct(stayed, durTotal), `of ${fmt(durTotal)} visits with a measured time`)}
</section>

<section class="card"><h2>Visitors per day</h2><p class="sub">Unique visitors each day, last ${range} days. Weekends are labelled in gold; hover a column for its number, or see the table at the bottom.</p>
${columns(daily, days.map((d) => dateLabel(d.date)), { title: 'Visitors per day', unit: 'visitors', every, weekend })}</section>

<section class="card"><h2>When people look</h2><p class="sub">Page views by hour of day (Zurich time), all days in the period added up.</p>
${columns(hours, hours.map((_, i) => `${i}h`), { title: 'Page views by hour', unit: 'page views', height: 130, every: 2 })}</section>

<div class="grid2">
  <section class="card"><h2>Where they come from</h2><p class="sub">Other websites and apps that sent visitors. Direct visits (typed, bookmarks, many messengers) send none.</p>${ranking(merge(days, 'refs'), { total: views, empty: 'No referrals yet' })}</section>
  <section class="card"><h2>Campaign links</h2><p class="sub">Visits through links with <code>?src=…</code>, e.g. <code>zuerich3d.ch/?src=insta</code>.</p>${ranking(merge(days, 'sources'), { total: views, empty: 'No campaign links used yet' })}</section>
  <section class="card"><h2>What they do</h2><p class="sub">Share of map visits that used each feature at least once.</p>${ranking(merge(days, 'events'), { total: mapViews, names: FEATURE_NAMES, limit: Object.keys(EVENTS).length, empty: 'No interactions yet' })}</section>
  <section class="card"><h2>Time on the site</h2><p class="sub">How long a visit lasted, measured when the tab is closed or hidden.</p>${ranking(Object.fromEntries(DURATIONS.filter((k) => durations[k]).map((k) => [k, durations[k]])), { limit: 6, sort: false, empty: 'No visits measured yet' })}</section>
  <section class="card"><h2>Devices</h2>${ranking(merge(days, 'devices'), { total: visitors })}</section>
  <section class="card"><h2>Browser language</h2>${ranking(merge(days, 'langs'), { total: visitors })}</section>
</div>

<section class="card"><h2>Day by day</h2><table class="days"><tr><th>Date</th><th>Visitors</th><th>New</th><th>Returning</th><th>Page views</th><th>Peak at once</th></tr>
${days.slice().reverse().filter((d, i) => i === 0 || d.visitors).map((d) => `<tr><td>${weekday(d.date)} ${dateLabel(d.date)}${d.date.slice(0, 4)}</td><td>${fmt(d.visitors)}</td><td>${fmt(d.newVisitors)}</td><td>${fmt(d.returning)}</td><td>${fmt(sum(Object.values(d.views)))}</td><td>${fmt(d.peakOnline)}</td></tr>`).join('')}
</table></section>

<p class="foot">Counted by this server only: no cookies, no IP addresses stored, nothing sent to third parties. Bots are left out.
Open <code>zuerich3d.ch/?notrack</code> once on each of your own devices so your visits aren't counted.${analytics.dir ? '' : ' <b>Totals are kept in memory only: ANALYTICS_DIR is not writable.</b>'}</p>
</main></body></html>`;
}

const CSS = `
:root { --bg:#0b0e13; --card:#121720; --line:rgba(255,255,255,.08); --fg:#e9edf2; --muted:#8d97a5; --faint:#5d6774; --accent:#f0b232; --bar:#3d8bfd; --bar-h:#7fb2ff; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing:antialiased; }
main { max-width:1100px; margin:0 auto; padding:24px 16px 48px; }
header { display:flex; align-items:center; gap:16px; flex-wrap:wrap; margin-bottom:20px; }
.brand { font-weight:800; letter-spacing:.32em; font-size:16px; color:var(--fg); text-decoration:none; } .brand .accent { color:var(--accent); letter-spacing:.25em; }
.h { color:var(--muted); font-size:13px; }
nav { margin-left:auto; display:flex; gap:4px; background:var(--card); border:1px solid var(--line); border-radius:9px; padding:3px; }
nav a { color:var(--muted); text-decoration:none; font-size:12px; padding:5px 10px; border-radius:6px; }
nav a[aria-current] { background:rgba(255,255,255,.08); color:var(--fg); }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin-bottom:12px; }
.tile, .card { background:var(--card); border:1px solid var(--line); border-radius:12px; }
.tile { padding:14px 16px; } .tl { color:var(--muted); font-size:12px; } .tv { font-size:28px; font-weight:700; font-variant-numeric:tabular-nums; margin:2px 0; } .ts { color:var(--faint); font-size:12px; }
.card { padding:16px 18px; margin-bottom:12px; min-width:0; }
.grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:0 12px; }
h2 { font-size:15px; margin:0 0 2px; } .sub { color:var(--muted); font-size:12px; margin:0 0 12px; }
code { font-size:12px; background:rgba(255,255,255,.06); padding:1px 5px; border-radius:4px; }
.chart { position:relative; padding-left:44px; }
.yaxis { position:absolute; left:0; right:0; top:0; height:var(--h); pointer-events:none; }
.yaxis span { position:absolute; left:44px; right:0; border-top:1px solid rgba(255,255,255,.08); }
.yaxis b { position:absolute; right:calc(100% + 8px); top:-8px; font-weight:400; font-size:11px; color:var(--faint); font-variant-numeric:tabular-nums; }
.cols { display:flex; gap:2px; position:relative; }
.col { flex:1 1 0; min-width:0; display:flex; flex-direction:column; align-items:center; cursor:default; }
.plot { height:var(--h); width:100%; display:flex; align-items:flex-end; justify-content:center; }
.plot i { display:block; width:100%; max-width:24px; background:var(--bar); border-radius:4px 4px 0 0; }
.col:hover .plot { background:rgba(255,255,255,.03); } .col:hover .plot i { background:var(--bar-h); }
.lab { font-size:11px; color:var(--faint); height:18px; line-height:18px; white-space:nowrap; overflow:visible; font-variant-numeric:tabular-nums; }
.lab.we { color:var(--accent); }
table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
.rank td { padding:5px 0; border-bottom:1px solid var(--line); vertical-align:middle; }
.rank .k { width:100%; padding-right:12px; overflow-wrap:anywhere; }
.rank .track { display:block; height:4px; margin-top:4px; background:rgba(255,255,255,.05); border-radius:2px; }
.rank .track span { display:block; height:100%; background:var(--bar); border-radius:2px; }
.rank .n { text-align:right; padding-right:12px; white-space:nowrap; } .rank .p { text-align:right; color:var(--muted); white-space:nowrap; width:3.5em; }
.days th, .days td { text-align:right; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; } .days th:first-child, .days td:first-child { text-align:left; }
.days th { color:var(--muted); font-weight:600; font-size:12px; }
.card:has(.days) { overflow-x:auto; }
.empty { color:var(--faint); font-size:13px; margin:4px 0; }
.foot { color:var(--faint); font-size:12px; margin-top:20px; }
@media (max-width:600px) { nav { margin-left:0; } .tv { font-size:24px; } }
`;
