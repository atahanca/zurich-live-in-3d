# zurich-live-in-3d

A 3D map of Zurich that shows every tram, bus, train, boat and funicular moving through the city, with real-time delays. Inspired by [geneva3d.ch](https://geneva3d.ch/).

- **~20,000 trips a day** across the city of Zurich and its surroundings: VBZ trams and buses, S-Bahn and long-distance trains, ZSG boats, Polybahn, Dolderbahn and more
- **Real-time delays and cancellations** from the official Swiss GTFS-RT feed
- **Realistic vehicles**: articulated trams (Flexity, Cobra, Tram 2000), buses and trolleybuses, double-deck trains, each in its operator's livery, bending through curves along the real tracks and roads
- **3D city** with buildings, day and night mode, and lit windows at night
- **Time travel**: pause, speed up to ×300, scrub through the day, or jump back to live
- **Follow mode**: click any vehicle to see its stops, scheduled times and delay, then ride along with it

No npm packages and no build step. Node.js and a browser are all it needs.

> Unofficial project, not affiliated with VBZ, ZVV, SBB or any other operator. Positions are calculated from timetable and delay data, not GPS, and may differ from reality.

---

## Contents

- [Quick start](#quick-start)
- [Real-time delays](#real-time-delays)
- [Commands](#commands)
- [Using the map](#using-the-map)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Configuration](#configuration)
- [Keeping data up to date](#keeping-data-up-to-date)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Data sources and licences](#data-sources-and-licences)
- [Roadmap](#roadmap)

---

## Quick start

**Requirements:** [Node.js](https://nodejs.org) 20 or newer, about 1 GB of free disk space and 4 GB of RAM for the data build. `unzip` must be on the PATH (included with Git for Windows, macOS and most Linux distributions); otherwise Windows' built-in `tar.exe` is used.

```sh
git clone <this repo> zurich-3d
cd zurich-3d
npm run setup   # downloads ~300 MB of timetable + map data and builds it (a few minutes)
npm start       # open http://localhost:8080
```

`npm run setup` runs three steps:

1. Downloads the Swiss national timetable (GTFS) from opentransportdata.swiss.
2. Downloads the rail, tram and road network for the area from OpenStreetMap.
3. Builds compact data files for today and tomorrow into `public/data/`.

Without an API key, vehicles follow the scheduled timetable. Add a key to get live delays, as described in the next section.

## Real-time delays

1. Create a free account at [api-manager.opentransportdata.swiss](https://api-manager.opentransportdata.swiss).
2. Subscribe to the **GTFS-RT** product and create an app. If the cart refuses it, empty the cart first; products from different catalogues must be requested separately.
3. Copy the **Token** (starts with `eyJ…`, *not* the Token Hash).
4. Create `.env` from the template and paste the token:

   ```sh
   cp .env.example .env
   # edit .env:  OTD_API_KEY=eyJ...
   ```

5. Restart with `npm start`. The header shows **● Real-time · N trips · updated Xs ago** when it works.

How it behaves:

- The server polls the national feed every **35 seconds**. The API allows 2–5 requests per minute and refreshes every 30 seconds.
- It polls **only while a browser has the page open**, because each response is about 8 MB. That avoids around 20 GB of traffic per day when nobody is watching.
- The key stays on the server. Browsers only receive a small, filtered JSON file for the trips in the area.
- Delays carry forward from stop to stop (GTFS-RT semantics), cancelled trips disappear, and skipped stops are crossed out in the vehicle panel.
- Switzerland publishes no open GPS positions. Positions are the timetable shifted by the reported delays, the same approach geneva3d uses.

## Commands

| Command | What it does |
| --- | --- |
| `npm run setup` | Runs `fetch:gtfs`, `fetch:osm` and `build:data` in sequence |
| `npm start` | Starts the web server on port 8080 (`node server.js 3000` or `PORT=3000` for another port) |
| `npm run fetch:gtfs` | Downloads the GTFS timetable to `data/raw/gtfs.zip`. Skipped if the file is less than 7 days old; add `-- --force` to refresh |
| `npm run fetch:osm` | Downloads tracks and roads from the Overpass API. Tiles are cached in `data/raw/osm-tiles/`, so an interrupted run resumes. `-- --force` refetches |
| `npm run build:data` | Builds `public/data/` for today and tomorrow. Other days: `npm run build:data -- --date 20261224 --days 3` |

## Using the map

| Action | How |
| --- | --- |
| Pan, zoom | Drag, scroll |
| Rotate, tilt | Right-drag (or Ctrl-drag), or the compass buttons |
| Vehicle details | Click a vehicle: line, destination, all stops with times and delays |
| Follow a vehicle | **Follow this vehicle** in the panel; Esc or dragging the map stops it |
| Show/hide a mode | Click the Trams / Buses / Trains / … chips at the top (they also show how many are running) |
| Time | Pause, ×1–×300 speed, drag the slider to any time of day, **● LIVE** to return to now; Space toggles play/pause |
| Layers | 3D buildings, route network, stops, line numbers, light trails, day/night map |

## How it works

```
                 BUILD TIME (npm run build:data)                         RUN TIME
 ┌──────────────────────────────┐                             ┌──────────────────────────┐
 │ GTFS zip, 3.7 GB stop_times  │──stream──┐                  │ opentransportdata GTFS-RT│
 └──────────────────────────────┘          ▼                  └────────────┬─────────────┘
                                ┌─────────────────────┐   every 35 s       │ protobuf, 8 MB
                                │ trips touching the  │                    ▼
                                │ Zurich area, per day│        ┌─────────────────────────┐
                                └─────────┬───────────┘        │ server.js + realtime.js │
 ┌──────────────────────────────┐         │                    │ decode, keep area trips │
 │ OSM tracks + roads (Overpass)│──► routable graphs           └────────────┬────────────┘
 └──────────────────────────────┘    (tram / rail / bus)                    │ /api/realtime
                                         │  A* between                      ▼
                                         ▼  consecutive stops   ┌──────────────────────────┐
                           public/data/network.json  ──────────►│ Browser (public/app.js)  │
                           public/data/timetable-*.json ───────►│ MapLibre + deck.gl       │
                                                                 └──────────────────────────┘
```

### Timetable processing (`scripts/build-timetable.js`)

- The Swiss GTFS feed covers all of Switzerland. `stop_times.txt` alone is 3.7 GB, so it is **streamed** straight out of the zip, never extracted.
- Only trips that **touch the area** (`BBOX` in `scripts/config.js`) are kept, from one stop before entering to one stop after leaving, so vehicles drive in and out of view.
- Each day gets its own file. Trips running after midnight are carried over into the next day's file.
- Frequency-based trips (`frequencies.txt`) are expanded into individual runs.

### Paths between stops (`scripts/lib/graph.js`)

The Swiss GTFS has **no route shapes**, so paths are reconstructed from OpenStreetMap:

- Three routable graphs: **tram** (tram and light-rail tracks), **rail** (railway tracks only, never tram tracks), and **bus** (roads, respecting one-way streets with bus exemptions).
- Long edges are split every 15 m so stops can snap anywhere along a track.
- For each pair of consecutive stops, the nearest candidate points on the graph are found and connected with **A\***. Sidings and yard tracks are penalised, and absurd detours are rejected.
- If a far stop lies outside the downloaded area (e.g. Zürich HB → Basel), the path follows the tracks to the edge of the network and continues straight from there.
- About 98% of segments follow real track or road. The rest fall back to a straight line.

### In the browser (`public/app.js`, `public/vehicles.js`)

- **Base map:** [MapLibre GL](https://maplibre.org) with [OpenFreeMap](https://openfreemap.org) vector tiles and 3D building extrusions.
- **Vehicles:** [deck.gl](https://deck.gl) instanced meshes. Each vehicle is a set of **articulated sections** placed separately along its path, so a 200 m train or a 43 m tram follows the curves.
- **Movement:** positions are interpolated between stop times with gentle acceleration and braking.
- **Real-time:** delays from `/api/realtime` shift each trip's times. A delay carries forward until the next reported stop, and travel time between stops never drops below 60% of the scheduled time, so vehicles don't jump.
- **Performance:**
  - Only vehicles in view get 3D sections.
  - Vehicle geometry updates about 30 times per second while the map itself renders at full frame rate.
  - Rendering resolution is capped at 1.25× on high-DPI screens.
- **Vehicle models** are procedural meshes with liveries painted on a canvas. Which physical vehicle runs a trip is not published, so trams are assigned a model at random in roughly the real fleet mix, and each trip keeps the same one.

## Project structure

```
zurich-3d/
├── server.js              Static file server (gzip) + /api/realtime endpoint
├── realtime.js            GTFS-RT polling, protobuf decoder, trip filtering
├── scripts/
│   ├── config.js          Area (BBOX), mode categories, tram line colours, GTFS URL
│   ├── fetch-gtfs.js      Download Swiss GTFS
│   ├── fetch-osm.js       Download OSM tracks and roads (tiled, cached, resumable)
│   ├── build-timetable.js Build public/data from GTFS + OSM
│   └── lib/
│       ├── gtfs.js        Streaming CSV reader for files inside the zip
│       └── graph.js       Routable graph, stop snapping, A*, simplification
├── public/
│   ├── index.html         Page layout
│   ├── style.css          UI styles (light/dark)
│   ├── app.js             Map, simulation loop, UI, real-time integration
│   ├── vehicles.js        Vehicle models, meshes, liveries
│   └── data/              Generated: network.json, timetable-YYYYMMDD.json, index.json
├── data/raw/              Downloaded: gtfs.zip, osm-*.json, osm-tiles/ (git-ignored)
├── .env.example           Template for the API key
└── package.json
```

`data/raw/`, `public/data/` and `.env` are git-ignored and regenerated by the scripts.

## Configuration

| What | Where |
| --- | --- |
| API key, port | `.env` (`OTD_API_KEY`, `PORT`) |
| Area covered | `BBOX` in `scripts/config.js` (`[west, south, east, north]`). After changing it, run `npm run fetch:osm -- --force` and `npm run build:data` |
| Tram line colours (badges) | `TRAM_COLORS` in `scripts/config.js` |
| Vehicle models, sizes, liveries | `MODELS` and `LIVERIES` in `public/vehicles.js` |
| Trolleybus lines | `TROLLEY_LINES` in `public/vehicles.js` (currently 31, 32, 33, 46, 72) |
| Start view, map styles | `START_VIEW`, `STYLES` at the top of `public/app.js` |
| Real-time poll interval | `POLL_MS` in `realtime.js` (keep it ≥ 30 s; the API is rate limited) |

## Keeping data up to date

| What | How often | Command |
| --- | --- | --- |
| Timetable for today and tomorrow | **Daily** (each file covers specific days) | `npm run build:data` |
| GTFS export | **Twice a week**: opentransportdata.swiss republishes it on Mondays and Thursdays, and GTFS-RT trip IDs follow the newest export. Also at the yearly timetable change in mid-December | `npm run fetch:gtfs -- --force && npm run build:data` |
| OSM network | Occasionally, when tracks or roads change | `npm run fetch:osm -- --force && npm run build:data` |

A server restart isn't needed after rebuilding. The server picks up new timetable files automatically, and browsers load them on the next page load.

Example crontab for a server:

```cron
# daily timetable at 03:30, fresh GTFS on Monday and Thursday afternoons
30 3 * * *   cd /opt/zurich-3d && npm run build:data >> /var/log/zurich-3d-build.log 2>&1
0 16 * * 1,4 cd /opt/zurich-3d && npm run fetch:gtfs -- --force && npm run build:data >> /var/log/zurich-3d-build.log 2>&1
```

## Deployment

The app needs a machine that runs Node.js **continuously**: for the real-time polling, and for the daily rebuild. Shared "web hosting" packages (PHP/WordPress) won't work. A small VPS (2 vCPU, 4 GB RAM, Ubuntu 24.04) is plenty.

Outline:

1. Install Node.js 20+ and `unzip`. Copy the project to e.g. `/opt/zurich-3d`, create `.env`, then run `npm run setup`.
2. Run `node server.js` as a **systemd** service with `Restart=always`, so it starts at boot and restarts after crashes.
3. Put **Caddy** (or nginx) in front for HTTPS: `your-domain.ch { reverse_proxy localhost:8080 }`. Caddy obtains certificates automatically.
4. Add the cron jobs from [Keeping data up to date](#keeping-data-up-to-date).
5. Point your domain's DNS **A record** to the server's IP address.

Before going public, check:

- The credits line (opentransportdata.swiss, OpenStreetMap, OpenFreeMap) is visible. The terms require citing opentransportdata.swiss as the source.
- The site doesn't look official: no operator logos or names like "VBZ Live".
- An imprint with your name, and a privacy note: server logs contain IP addresses. Keep them short-lived and mention where the server is hosted.
- Your API key stays in `.env` on the server.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| *"Could not load data … Run npm run setup first"* | `public/data/` is missing. Run `npm run setup` (or `npm run build:data` if the downloads already exist) |
| *"No timetable for today"* in the header | The data is for other days. Run `npm run build:data` |
| `fetch:osm` shows HTTP 502/504 or timeouts | The public Overpass servers are busy. Failing tiles are split and retried automatically; if it gives up, run it again later. Finished tiles are cached |
| Build runs out of memory | Close other programs or raise the limit: `node --max-old-space-size=6144 scripts/build-timetable.js` |
| *"Real-time error: API key rejected"* | Check `OTD_API_KEY` in `.env` (the Token, not the Token Hash) and that the key is subscribed to GTFS-RT |
| *"Real-time error: rate limit exceeded"* | Another program is using the same key, or `POLL_MS` is too low |
| Few or no trips with real-time data | The GTFS export is older than the one GTFS-RT refers to. Run `npm run fetch:gtfs -- --force && npm run build:data` |
| A vehicle takes an odd path | The OSM network may be incomplete there. Check the spot on openstreetmap.org; fixing it in OSM fixes it here after `fetch:osm -- --force` |
| Laggy rendering | Turn off 3D buildings or light trails, close other GPU-heavy tabs; laptops on battery may throttle the GPU |

## Data sources and licences

| Data / software | Source | Licence / terms |
| --- | --- | --- |
| Timetable (GTFS) and real-time (GTFS-RT) | [opentransportdata.swiss](https://opentransportdata.swiss) (Open Data platform mobility Switzerland, SBB) | [Terms of use](https://opentransportdata.swiss/en/terms-of-use/): free use including commercial; cite *opentransportdata.swiss* as the source |
| Tracks, roads | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors | ODbL |
| Base map tiles | [OpenFreeMap](https://openfreemap.org) | Free; attribution |
| Map rendering | [MapLibre GL JS](https://maplibre.org) | BSD-3-Clause |
| 3D layers | [deck.gl](https://deck.gl) | MIT |

Vehicle models and liveries are simplified representations made for this project. They contain no operator logos or trademarks.

## Roadmap

- [x] Scheduled timetable for the whole Zurich area
- [x] Paths along real tracks and roads
- [x] Real-time delays and cancellations (GTFS-RT)
- [x] Articulated vehicle models with liveries, day/night mode
- [ ] Disruption messages (GTFS Service Alerts)
- [ ] Optional colouring of vehicles by delay
- [ ] Terrain (Uetliberg, Zürichberg) and detailed 3D buildings (Stadt Zürich / swisstopo)
- [ ] Sun position lighting, weather
- [ ] Stop search, departure boards
- [ ] Deployment scripts (systemd, Caddy, cron)
