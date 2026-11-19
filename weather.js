// Current weather and hourly forecast for Zurich from Open-Meteo (MeteoSwiss ICON-CH models).
// The server fetches it, so visitors' browsers never contact a third party.
// Open-Meteo is free for non-commercial use, data under CC BY 4.0 ("Weather data by Open-Meteo.com").

const URL_ =
  'https://api.open-meteo.com/v1/forecast?latitude=47.3769&longitude=8.5417' +
  '&current=temperature_2m,precipitation,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m' +
  '&hourly=temperature_2m,precipitation,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m' +
  '&timezone=Europe%2FZurich&past_days=1&forecast_days=3';
const REFRESH_MS = 15 * 60 * 1000;

export function startWeather({ log = console.log } = {}) {
  const state = { json: JSON.stringify({ status: 'pending' }), fetchedAt: 0, busy: false };

  async function refresh() {
    if (state.busy) return;
    state.busy = true;
    try {
      const res = await fetch(URL_, {
        headers: { 'User-Agent': 'zurich-3d (live public transport map)' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      const h = d.hourly;
      // compact form: hour keys "YYYYMMDDHH" -> [temp, precip mm, snow cm, code, cloud %, wind km/h, wind dir]
      const hours = {};
      h.time.forEach((t, i) => {
        hours[t.slice(0, 13).replace(/[-T]/g, '')] = [
          h.temperature_2m[i], h.precipitation[i], h.snowfall[i], h.weather_code[i],
          h.cloud_cover[i], h.wind_speed_10m[i], h.wind_direction_10m[i],
        ];
      });
      const c = d.current;
      state.json = JSON.stringify({
        status: 'ok', fetchedAt: Date.now(),
        current: {
          time: c.time, temp: c.temperature_2m, precip: c.precipitation, snow: c.snowfall, code: c.weather_code,
          cloud: c.cloud_cover, wind: c.wind_speed_10m, windDir: c.wind_direction_10m,
        },
        hours,
      });
      state.fetchedAt = Date.now();
    } catch (e) {
      log(`weather: ${e.message}`);
      if (!state.fetchedAt) state.json = JSON.stringify({ status: 'error' });
    } finally {
      state.busy = false;
    }
  }

  return {
    /** JSON for /api/weather; refreshes in the background when older than 15 min (only while someone asks). */
    get json() {
      if (Date.now() - state.fetchedAt > REFRESH_MS) refresh();
      return state.json;
    },
    ready: refresh(),
  };
}
