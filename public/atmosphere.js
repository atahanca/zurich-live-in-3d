// Sun, sky, weather and precipitation for the simulated time.

const LAT = 47.3769, LON = 8.5417;
const RAD = Math.PI / 180;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const mixRgb = (a, b, t) => a.map((v, i) => Math.round(lerp(v, b[i], t)));
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

const offsetCache = new Map();
/** Minutes Zurich is ahead of UTC on a given YYYYMMDD (CET/CEST). */
function zurichOffsetMin(ymd) {
  if (!offsetCache.has(ymd)) {
    const noon = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), 12);
    const h = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', hourCycle: 'h23' }).format(noon);
    offsetCache.set(ymd, (h - 12) * 60);
  }
  return offsetCache.get(ymd);
}

/** Sun altitude and azimuth (degrees, azimuth clockwise from north) for local time t on day ymd. */
export function sunPosition(ymd, t) {
  const ms = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + (t - zurichOffsetMin(ymd) * 60) * 1000;
  const d = ms / 864e5 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = (gmst * 15 + LON) * RAD - ra;
  const lat = LAT * RAD;
  const alt = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(ha));
  return { alt: alt / RAD, az: ((az / RAD) + 360) % 360 };
}

/** 0 in daylight, 1 once the sun is 7° below the horizon (end of civil twilight). */
export const nightOf = (alt) => smooth(3, -7, alt);

/** Share of windows lit: lights come on at dusk, most go out after midnight, some come back before work. */
export function litShare(t, night) {
  const h = (((t / 3600) % 24) + 24) % 24;
  let share;
  if (h >= 16 && h < 22) share = 0.5;
  else if (h >= 22) share = lerp(0.5, 0.22, (h - 22) / 2);
  else if (h < 4.5) share = lerp(0.22, 0.08, Math.min(1, h / 3));
  else if (h < 7.5) share = lerp(0.08, 0.42, (h - 4.5) / 3);
  else share = 0.35;
  return share * (0.4 + 0.6 * night);
}

// sky colours: [sky, horizon] for night, twilight and day
const SKY = {
  night: [[6, 9, 18], [22, 30, 54]],
  dusk: [[40, 52, 92], [232, 140, 92]],
  day: [[124, 182, 236], [222, 236, 248]],
  grey: [[150, 160, 172], [200, 206, 212]],
};

/** Sky/fog settings for MapLibre's setSky, from the sun altitude and cloud cover (0..1). */
export function skyFor(alt, overcast) {
  const dayT = smooth(-2, 10, alt);       // twilight -> day
  const duskT = smooth(-9, -1, alt);      // night -> twilight
  let sky = mixRgb(SKY.night[0], SKY.dusk[0], duskT);
  let hor = mixRgb(SKY.night[1], SKY.dusk[1], duskT);
  sky = mixRgb(sky, SKY.day[0], dayT);
  hor = mixRgb(hor, SKY.day[1], dayT);
  // clouds wash out the colours in daylight and hide the sunset glow
  const grey = overcast * 0.85;
  sky = mixRgb(sky, mixRgb(SKY.night[0], SKY.grey[0], dayT), grey);
  hor = mixRgb(hor, mixRgb(SKY.night[1], SKY.grey[1], dayT), grey);
  return {
    'sky-color': rgb(sky), 'horizon-color': rgb(hor), 'fog-color': rgb(hor),
    'sky-horizon-blend': 0.55, 'horizon-fog-blend': 0.6 - overcast * 0.2, 'fog-ground-blend': 0.75 - overcast * 0.35,
  };
}

// ---------------------------------------------------------------- weather data

/** WMO weather code -> short label and icon name. */
export function describe(code) {
  if (code === 0) return ['Clear', 'sun'];
  if (code <= 2) return ['Partly cloudy', 'partly'];
  if (code === 3) return ['Overcast', 'cloud'];
  if (code <= 48) return ['Fog', 'fog'];
  if (code <= 55) return ['Drizzle', 'rain'];
  if (code <= 57) return ['Freezing drizzle', 'rain'];
  if (code <= 63) return [code === 61 ? 'Light rain' : 'Rain', 'rain'];
  if (code <= 67) return [code === 65 ? 'Heavy rain' : 'Freezing rain', 'rain'];
  if (code <= 77) return [code === 71 ? 'Light snow' : code === 75 ? 'Heavy snow' : 'Snow', 'snow'];
  if (code <= 82) return ['Rain showers', 'rain'];
  if (code <= 86) return ['Snow showers', 'snow'];
  return ['Thunderstorm', 'storm'];
}

export const ICONS = {
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" stroke-width="1.8" stroke="currentColor" fill="none" stroke-linecap="round"/>',
  partly: '<path d="M9 4.5a4 4 0 0 1 6.9 2.6A4.5 4.5 0 0 1 17 16H7.5a4 4 0 0 1-.6-7.96A4 4 0 0 1 9 4.5Z" opacity=".9"/>',
  cloud: '<path d="M7.5 18a4.5 4.5 0 0 1-.7-8.95 6 6 0 0 1 11.4 1.6A3.7 3.7 0 0 1 17.5 18Z"/>',
  fog: '<path d="M4 9h16M3 13h18M5 17h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
  rain: '<path d="M7.5 14a4 4 0 0 1-.6-7.95 5.5 5.5 0 0 1 10.5 1.5A3.3 3.3 0 0 1 17 14Z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  snow: '<path d="M7.5 14a4 4 0 0 1-.6-7.95 5.5 5.5 0 0 1 10.5 1.5A3.3 3.3 0 0 1 17 14Z"/><circle cx="8" cy="18" r="1.1"/><circle cx="12" cy="20" r="1.1"/><circle cx="16" cy="18" r="1.1"/>',
  storm: '<path d="M7.5 14a4 4 0 0 1-.6-7.95 5.5 5.5 0 0 1 10.5 1.5A3.3 3.3 0 0 1 17 14Z"/><path d="m12.5 14-2 4h3l-2 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
};

/**
 * Weather for a simulated moment: the live "current" values near now, otherwise the hourly
 * forecast/history for that hour. Returns null when no data covers it.
 */
export function weatherAt(data, ymd, t, isLive) {
  if (!data || data.status !== 'ok') return null;
  if (isLive && data.current) {
    const c = data.current;
    return { temp: c.temp, precip: c.precip, snow: c.snow, code: c.code, cloud: c.cloud, wind: c.wind, windDir: c.windDir };
  }
  const hour = Math.floor((((t % 86400) + 86400) % 86400) / 3600);
  const row = data.hours?.[`${ymd}${String(hour).padStart(2, '0')}`];
  if (!row) return null;
  const [temp, precip, snow, code, cloud, wind, windDir] = row;
  return { temp, precip, snow, code, cloud, wind, windDir };
}

// ---------------------------------------------------------------- rain / snow overlay

/** Falling rain or snow drawn on a 2D canvas above the map. */
export class Precipitation {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.drops = [];
    this.kind = 'none';
    this.intensity = 0;  // 0..1
    this.wind = 0;       // horizontal drift in px/s
    this.night = 0;
    this.last = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.dpr = dpr;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  /** kind: 'rain' | 'snow' | 'none'; intensity 0..1 */
  set(kind, intensity, wind, night) {
    this.kind = intensity > 0 ? kind : 'none';
    this.intensity = intensity;
    this.wind = wind;
    this.night = night;
    this.canvas.hidden = this.kind === 'none';
  }
  spawn(fresh) {
    const snow = this.kind === 'snow';
    return {
      x: Math.random() * (this.w + 200) - 100,
      y: fresh ? Math.random() * this.h : -20 - Math.random() * 60,
      z: 0.35 + Math.random() * 0.65,                 // depth: far drops are smaller/slower/fainter
      v: snow ? 40 + Math.random() * 40 : 700 + Math.random() * 500,
      p: Math.random() * Math.PI * 2,                  // snow sway phase
    };
  }
  frame(now) {
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    if (this.kind === 'none') { if (this.drops.length) this.drops.length = 0; return; }
    const snow = this.kind === 'snow';
    // drizzle = a few dozen streaks, downpour = several hundred
    const target = Math.round((snow ? 60 + 520 * this.intensity : 25 + 420 * this.intensity) * Math.min(1.6, (this.w * this.h) / 1.6e6));
    while (this.drops.length < target) this.drops.push(this.spawn(this.drops.length < target * 0.9 && !this.started));
    this.started = true;
    if (this.drops.length > target) this.drops.length = target;

    const { ctx } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    const light = this.night > 0.5 ? '200,215,235' : '235,240,248';
    ctx.lineCap = 'round';
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      const vy = d.v * d.z;
      const vx = this.wind * d.z;
      if (snow) {
        d.p += dt * 1.5;
        d.x += (vx + Math.sin(d.p) * 18) * dt;
        d.y += vy * dt;
        ctx.fillStyle = `rgba(255,255,255,${0.45 + 0.45 * d.z})`;
        ctx.beginPath();
        ctx.arc(d.x, d.y, 0.8 + 2.0 * d.z, 0, Math.PI * 2);
        ctx.fill();
      } else {
        d.x += vx * dt;
        d.y += vy * dt;
        const len = 9 + 16 * d.z;
        const k = len / Math.hypot(vx, vy);
        ctx.strokeStyle = `rgba(${light},${0.12 + 0.3 * d.z})`;
        ctx.lineWidth = 0.6 + 0.8 * d.z;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - vx * k, d.y - vy * k);
        ctx.stroke();
      }
      if (d.y > this.h + 30 || d.x < -120 || d.x > this.w + 120) this.drops[i] = this.spawn(false);
    }
  }
}

/** Precipitation (mm/h) -> 0..1 visual intensity; light drizzle still shows a few drops. */
export const precipIntensity = (mm) => (mm <= 0 ? 0 : clamp01(0.12 + Math.log1p(mm) / Math.log1p(8)));
