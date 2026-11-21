// Anonymous visit counting for this site's own statistics (see analytics.js on the server).
// No cookies and no identifiers: one beacon per page view, one per feature used (at most once per
// visit each) and the visit length when the tab is hidden. Nothing is sent when the browser asks
// sites not to track (Global Privacy Control / Do Not Track), or after opening the site once with
// ?notrack (to leave out your own visits; ?track switches counting back on).
const SEEN_KEY = 'z3d.lastVisit';
const OFF_KEY = 'z3d.notrack';
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const url = new URL(location.href);
if (url.searchParams.has('notrack')) store.set(OFF_KEY, '1');
if (url.searchParams.has('track')) store.set(OFF_KEY, null);
const off = store.get(OFF_KEY) === '1' || navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || navigator.webdriver;

function send(params) {
  if (off) return;
  const q = new URLSearchParams(params).toString();
  const u = new URL(`api/hit?${q}`, document.baseURI).href;
  if (!(navigator.sendBeacon && navigator.sendBeacon(u))) fetch(u, { method: 'POST', keepalive: true, cache: 'no-store' }).catch(() => {});
}

// one page view
const page = /privacy/.test(location.pathname) ? 'privacy' : /imprint/.test(location.pathname) ? 'imprint' : 'map';
const today = new Date().toISOString().slice(0, 10);
const last = store.get(SEEN_KEY);
store.set(SEEN_KEY, today);
const small = Math.min(screen.width, screen.height);
const coarse = matchMedia('(pointer: coarse)').matches;
let ref = '';
try { const r = new URL(document.referrer); if (r.host !== location.host) ref = r.host || r.protocol.replace(':', ''); } catch { /* none */ }
const src = url.searchParams.get('src') || url.searchParams.get('utm_source') || url.searchParams.get('ref') || '';
send({
  p: page,
  r: !last ? 0 : last === today ? 2 : 1,                          // first visit / earlier day / again today
  d: coarse && small < 600 ? 'phone' : coarse ? 'tablet' : 'desktop',
  l: (navigator.language || '').slice(0, 2),
  ...(ref && { ref }), ...(src && { src }),
});

// tidy the address bar so shared links don't carry the campaign or switch parameters along
const tidy = ['src', 'utm_source', 'utm_medium', 'utm_campaign', 'ref', 'notrack', 'track'];
if (tidy.some((k) => url.searchParams.has(k))) {
  tidy.forEach((k) => url.searchParams.delete(k));
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
}

// visit length, sent once when the tab is first hidden or closed
const start = performance.now();
let ended = false;
const end = () => {
  if (ended) return;
  ended = true;
  send({ t: Math.round((performance.now() - start) / 1000) });
};
addEventListener('pagehide', end);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') end(); });

// features used: each counted once per visit
const used = new Set();
export function track(event) {
  if (used.has(event)) return;
  used.add(event);
  send({ e: event });
}
