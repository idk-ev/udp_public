/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Public pages before going live (smartcity-lib.js, stadt.html, kreis.html,
   generated slug pages, robots.txt, sitemap.xml).

   Checked here: temporal URLs repeat within a minute (cockpit cache), upstream
   text never becomes markup (popups, tiles, legends, detail views), blocked
   localStorage does not break a page, hidden tabs do not refresh, the
   background map has no OpenStreetMap tile fallback, source credits on the
   district page and in embed mode, robots.txt, sitemap and canonical links.

   The jsdom parts skip without gui/node_modules like site-js.test.js. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { JSDOM, ROOT, PUB, LIB, renderStadt, renderPage } = require("./page-harness");

// CRLF from a Windows checkout (core.autocrlf) is not a difference.
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n");

/* A window with smartcity-lib loaded; fetch answers {} and records URLs. */
function libWindow() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>",
    { url: "https://udp.example/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  w.fetch = async u => { calls.push(String(u)); return new Response("{}", { status: 200 }); };
  w.eval(LIB);
  return { w, SC: w.SC, calls };
}

/* ---------- temporal queries: cacheable URLs ---------- */

exports["temporal: timeAt is rounded down to the full minute"] = async () => {
  if (!JSDOM) return;
  const { SC, calls } = libWindow();
  assert.strictEqual(SC.histSince(24, Date.parse("2026-10-05T10:31:42.123Z")), "2026-10-04T10:31:00.000Z");
  assert.strictEqual(SC.histSince(1, Date.parse("2026-10-05T10:31:00.000Z")), "2026-10-05T09:31:00.000Z");
  await SC.hist("urn:ngsi-ld:WeatherObserved:bw-08415061", "temperature", 24);
  await SC.hist("urn:ngsi-ld:WeatherObserved:bw-08415061", "temperature", 24);
  const t = calls.filter(u => u.includes("/temporal/"));
  assert.strictEqual(t.length, 2);
  assert.match(t[0], /timeAt=\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z&/, "timeAt not rounded to the minute");
  // Same minute, same URL; only a minute boundary between both calls may part them.
  const ts = t.map(u => Date.parse(/timeAt=([^&]+)/.exec(u)[1]));
  assert(t[0] === t[1] || ts[1] - ts[0] === 60e3, "repeated query within a minute asks a different URL");
};

exports["temporal: no unrounded timeAt elsewhere (pages, load test)"] = () => {
  for (const f of fs.readdirSync(PUB).filter(x => /\.(html|js)$/.test(x) && x !== "dashboard.html")) {
    const src = fs.readFileSync(path.join(PUB, f), "utf8");
    if (f === "smartcity-lib.js") continue;
    assert(!/timeAt=/.test(src), `${f} builds its own temporal URL – use SC.hist / SC.histSince`);
  }
  const lib = read("gui/public/smartcity-lib.js");
  const load = read("tests/load/municipality-page.js");
  const step = s => (/const TEMPORAL_STEP_MS = ([\d.e]+);/.exec(s) || [])[1];
  assert.strictEqual(step(load), step(lib), "load test and smartcity-lib round temporal windows differently");
  assert.match(load, /const since = histSince\(24\);/, "load test does not use the rounded window");
  assert(!/new Date\(Date\.now\(\) - [^)]*\)\.toISOString\(\)/.test(load), "load test still builds an unrounded timeAt");
};

/* ---------- upstream text never becomes markup ---------- */

const EVIL = '<img src=x onerror="window.__xss=1">';
const at = (lon, lat) => ({ type: "GeoProperty", value: { type: "Point", coordinates: [lon, lat] } });
const P = v => ({ type: "Property", value: v });

exports["XSS: OSM, UBA, sensor, road work and provider texts are escaped everywhere"] = async () => {
  if (!JSDOM) return;
  const ags = "08415061";
  const { w, d, leaflet } = await renderStadt({
    entities: {
      [`urn:ngsi-ld:CivicStructure:bw-${ags}-rathaus`]: { id: `urn:ngsi-ld:CivicStructure:bw-${ags}-rathaus`, type: "CivicStructure",
        name: P("Rathaus"), openingHours: P("Mo-Fr 08:00-12:00 " + EVIL), telephone: P(EVIL), location: at(9.21, 48.49) },
      [`urn:ngsi-ld:TouristDestination:bw-${ags}`]: { id: `urn:ngsi-ld:TouristDestination:bw-${ags}`, type: "TouristDestination",
        ziele: P([["Ziel " + EVIL, "Art " + EVIL, 48.5, 9.2], ["Zweites", "Museum", 48.51, 9.21]]), zielCount: P(2) },
      [`urn:ngsi-ld:PublicAmenity:bw-${ags}`]: { id: `urn:ngsi-ld:PublicAmenity:bw-${ags}`, type: "PublicAmenity",
        amenities: P([["Apo " + EVIL, "Apotheke", 48.5, 9.2], ["X", EVIL, 48.52, 9.22]]), counts: P({ Apotheke: 1 }) },
    },
    types: {
      AirQualityObserved: [
        { id: `urn:ngsi-ld:AirQualityObserved:bw-uba-DEBW1`, type: "AirQualityObserved", ags: P(ags),
          airQualityIndex: P(EVIL), stationName: P("Station " + EVIL), no2: P(EVIL), location: at(9.2, 48.5) },
        { id: `urn:ngsi-ld:AirQualityObserved:bw-sensor-1`, type: "AirQualityObserved", ags: P(ags),
          name: P("Sensor"), pm25: P(EVIL), pm10: P(EVIL), location: at(9.21, 48.5) },
      ],
      RoadWork: [
        { id: "urn:ngsi-ld:RoadWork:bw-svz-1", type: "RoadWork", ags: P(ags), name: P("B 28"), endDate: P(EVIL),
          description: P(EVIL), location: at(9.2, 48.49) },
        { id: "urn:ngsi-ld:RoadWork:bw-svz-2", type: "RoadWork", ags: P("08415014"), name: P("L 1"), gemeindeName: P(EVIL),
          endDate: P(EVIL), location: at(9.1, 48.4) },
      ],
      SharingSummary: [
        { id: `urn:ngsi-ld:SharingSummary:bw-${ags}-ff-evil`, type: "SharingSummary", ags: P(ags), operator: P(EVIL),
          availableVehicles: P(3), vehiclePositions: P([[48.5, 9.2]]) },
      ],
    },
  });
  const noMarkup = (html, where) => {
    const f = JSDOM.fragment(String(html));
    assert.strictEqual(f.querySelector("img, [onerror]"), null, `${where}: upstream text became markup: ${String(html).slice(0, 200)}`);
  };
  noMarkup(d.body.innerHTML, "page");
  // Popups of the main map (bindPopup arguments).
  const popups = leaflet.flat().filter(a => typeof a === "string" && a.includes("navlink"));
  assert(popups.some(p => p.includes("Mo-Fr 08:00-12:00")), "Rathaus popup with opening hours not rendered");
  popups.forEach(p => noMarkup(p, "popup"));
  // Detail views (modal tables, lists, legends, their map popups).
  for (const key of ["rathaus", "ausflug", "versorgung", "baustellen", "sharing", "luft"]) {
    const before = leaflet.length;
    w.SC.openDetailByKey(key);
    await new Promise(r => setTimeout(r, 30));
    noMarkup(d.body.innerHTML, "detail " + key);
    leaflet.slice(before).flat().filter(a => typeof a === "string").forEach(p => noMarkup(p, "detail popup " + key));
  }
  assert.strictEqual(w.__xss, undefined);
};

exports["XSS: fmtN passes numbers only"] = () => {
  if (!JSDOM) return;
  const { SC } = libWindow();
  assert.strictEqual(SC.fmtN(1234.5), "1.234,5");
  assert.strictEqual(SC.fmtN("42"), "42");
  assert.strictEqual(SC.fmtN(EVIL), "–");
  assert.strictEqual(SC.fmtN(null), "–");
  assert.strictEqual(SC.fmtN(""), "–");
};

/* ---------- blocked storage ---------- */

exports["localStorage blocked: city page renders, theme selector works"] = async () => {
  if (!JSDOM) return;
  const { w, d } = await renderStadt({ noStorage: true });
  assert.throws(() => w.localStorage, /insecure/, "storage block not in effect");
  assert(d.querySelector("#tiles .tile"), "no tiles rendered");
  const sw = d.querySelector(".themesel .sw[data-t='wald']");
  assert(sw, "theme selector missing");
  sw.click();
  assert.strictEqual(d.documentElement.dataset.theme, "wald");
  d.querySelector(".themesel .mode[data-m='dark']").click();
  assert.strictEqual(d.documentElement.dataset.mode, "dark");
};

/* ---------- background tabs ---------- */

exports["autoRefresh: hidden tabs skip, catch up once visible"] = async () => {
  if (!JSDOM) return;
  const { w, SC } = libWindow();
  let state = "hidden";
  Object.defineProperty(w.document, "visibilityState", { configurable: true, get: () => state });
  let n = 0, allow = true;
  const timer = SC.autoRefresh(() => { n++; }, 20, () => allow);
  try {
    await new Promise(r => setTimeout(r, 90));
    assert.strictEqual(n, 0, "refreshed while hidden");
    state = "visible";
    w.document.dispatchEvent(new w.Event("visibilitychange"));
    await new Promise(r => setTimeout(r, 0));
    assert.strictEqual(n, 1, "no catch-up refresh on becoming visible");
    await new Promise(r => setTimeout(r, 70));
    assert(n >= 2, "visible tab does not refresh");
    allow = false;
    const m = n;
    await new Promise(r => setTimeout(r, 70));
    assert.strictEqual(n, m, "due() is ignored");
  } finally {
    w.clearInterval(timer);
  }
  for (const f of ["stadt.html", "kreis.html"]) {
    const src = read("gui/public/" + f);
    assert.match(src, /SC\.autoRefresh\(renderOnce, 120e3/, `${f}: refresh does not go through SC.autoRefresh`);
    assert(!/setInterval\([^)]*renderOnce/.test(src), `${f}: unconditional refresh interval left`);
  }
};

/* ---------- background map ---------- */

exports["basemap: no OpenStreetMap tile fallback, a note on repeated errors"] = () => {
  if (!JSDOM) return;
  for (const f of fs.readdirSync(PUB).filter(x => /\.(html|js)$/.test(x)))
    assert(!fs.readFileSync(path.join(PUB, f), "utf8").includes("tile.openstreetmap.org"), `${f} loads OSM tiles`);
  const { w, SC } = libWindow();
  const on = {}, layers = [];
  let note = null;
  w.L = {
    tileLayer: Object.assign((...a) => { layers.push(a); return { addTo: m => m }; },
      { wms: () => ({ on: (ev, fn) => { on[ev] = fn; }, addTo: m => m }) }),
    control: () => { const c = { addTo: m => { note = c.onAdd(m); return c; }, remove: () => { note = null; } }; return c; },
  };
  SC.baseLayer({});
  for (let i = 0; i < 5; i++) on.tileerror();
  assert.strictEqual(note, null, "note after single dropouts");
  on.tileerror();
  assert(note, "no note after repeated tile errors");
  assert.strictEqual(note.textContent, "Hintergrundkarte derzeit nicht verfügbar");
  assert.deepStrictEqual(layers, [], "switched to another tile provider");
  on.tileload();
  assert.strictEqual(note, null, "note stays after tiles load again");
};

/* ---------- source credits ---------- */

exports["district page credits the sources of the data it shows"] = async () => {
  if (!JSDOM) return;
  const w = await renderPage("kreis.html", "https://udp.example/kreis-tuebingen", null,
    { KREIS: { krs: "08416", slug: "kreis-tuebingen" } },
    { EnergyMonitor: [{ id: "urn:ngsi-ld:EnergyMonitor:bw-08416041", ags: "08416041", installedCapacityKw: 1000, plantCount: 3 }] });
  const footer = w.document.getElementById("footer").textContent;
  for (const s of ["Marktstammdatenregister (dl-de/by-2-0)", "DWD via BrightSky (GeoNutzV)", "BBK/NINA",
    "© EuroGeographics/BKG via opendatasoft", "basemap.de"])
    assert(footer.includes(s), `footer lacks "${s}": ${footer}`);
  for (const s of ["Open-Meteo", "sensor.community", "hystreet"])
    assert(!footer.includes(s), `footer credits "${s}" although the page shows none of its data`);
  assert(!/siehe Gemeinde-Dashboards/.test(footer));
};

exports["embed mode keeps a compact source line"] = async () => {
  if (!JSDOM) return;
  const html = read("gui/public/stadt.html");
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  for (const m of style.matchAll(/([^{}]+)\{[^}]*display:\s*none[^}]*\}/g))
    for (const sel of m[1].split(",").map(s => s.trim()))
      assert(!/(^|\s)footer$/.test(sel), `"${sel}" hides the source credits`);
  const { d } = await renderStadt({ query: "?embed=1" });
  assert(d.body.classList.contains("embed"));
  const footer = d.getElementById("footer");
  assert.match(footer.textContent, /^Datenquellen: .*basemap\.de/);
  assert(footer.querySelector(".footer-nav"), "navigation links are not separable from the credits");
};

/* ---------- robots.txt, sitemap, slug pages ---------- */

exports["robots.txt keeps crawlers away from live queries, not from page assets"] = () => {
  const robots = read("gui/public/robots.txt");
  const rules = [...robots.matchAll(/^Disallow:\s*(\S+)\s*$/gm)].map(m => m[1]);
  for (const p of ["/abfahrten", "/warnungen.ics", "/gateway/", "/cockpit", "/dashboard.html", "/ops/"])
    assert(rules.includes(p), `robots.txt does not disallow ${p}`);
  const blocked = p => rules.some(r => r.endsWith("$") ? p === r.slice(0, -1) : p.startsWith(r));
  // Needed to render the pages (crawlers obey robots.txt for resources too).
  for (const p of ["/", "/tuebingen", "/kreis-tuebingen", "/stadt.html", "/kreis.html", "/smartcity-lib.js",
    "/smartcity-theme.css", "/config.js", "/site.js", "/connectors-status.json", "/dashboards.json", "/bw-gemeinden.json",
    "/vendor/leaflet.js", "/mitmachen.html"])
    assert(!blocked(p), `robots.txt blocks ${p}`);
  // No municipality slug may be caught by a rule meant for the cockpit.
  for (const slug of fs.readdirSync(path.join(PUB, "g")))
    assert(!blocked("/" + slug), `robots.txt blocks the page /${slug}`);
  assert.match(robots, /^Sitemap: __PUBLIC_ORIGIN__\/sitemap\.xml$/m);
  assert.match(read("scripts/generate-city-pages.py"), /SITEMAP_ORIGIN = "__PUBLIC_ORIGIN__"/);
};

exports["sitemap.xml lists the start page and every generated page"] = () => {
  const xml = read("gui/public/sitemap.xml");
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
  assert(locs.every(l => l.startsWith("__PUBLIC_ORIGIN__/")), "sitemap URL without the origin placeholder");
  const want = ["/"].concat(fs.readdirSync(path.join(PUB, "g")).map(s => "/" + s)).sort();
  assert.deepStrictEqual(locs.map(l => l.slice("__PUBLIC_ORIGIN__".length)).sort(), want,
    "sitemap.xml and gui/public/g/ disagree – run scripts/generate-city-pages.py");
  assert(locs.length < 50000, "a sitemap holds at most 50,000 URLs");
};

exports["slug pages: canonical link, loader shows an error instead of a blank page"] = async () => {
  const dir = path.join(PUB, "g");
  const stale = fs.readdirSync(dir).filter(s => {
    const html = fs.readFileSync(path.join(dir, s, "index.html"), "utf8");
    return !html.includes(`<link rel="canonical" href="/${s}">`) || !/if \(!r\.ok\) throw/.test(html) || !html.includes("}).catch(() => {");
  });
  assert.deepStrictEqual(stale.slice(0, 5), [], `${stale.length} stubs outdated – run scripts/generate-city-pages.py`);
  if (!JSDOM) return;
  for (const slug of ["tuebingen", "kreis-tuebingen"]) {
    const html = fs.readFileSync(path.join(dir, slug, "index.html"), "utf8");
    const dom = new JSDOM(html, { url: "https://udp.example/" + slug, runScripts: "outside-only" });
    const w = dom.window;
    w.fetch = async () => new Response("upstream down", { status: 503 });
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) w.eval(m[1]);
    await new Promise(r => setTimeout(r, 30));
    assert.match(w.document.body.textContent, /konnte gerade nicht geladen werden/, `${slug}: blank page on a failed template`);
    assert(w.document.querySelector("body a[href='/']"), `${slug}: no way back to the search`);
  }
};

/* ---------- cockpit SPA ---------- */

exports["cockpit SPA: temporal window rounded to the minute, no query without a type"] = () => {
  const api = read("gui/src/api.ts");
  // Same rounding as smartcity-lib.js histSince: one cache entry per minute.
  assert.match(api, /const TEMPORAL_STEP_MS = 60_000;/);
  assert.match(api, /Math\.floor\(start \/ TEMPORAL_STEP_MS\) \* TEMPORAL_STEP_MS/);
  assert.match(api, /const timeAt = temporalSince\(hours\);/);
  assert(!/Date\.now\(\) - hours \* 3600_000\)\.toISOString/.test(api), "unrounded timeAt left");
  // The public gateway answers list queries without a type with 400.
  assert(!/local:\s*"true"/.test(api), "type-less local=true query left");
};

exports["slug pages: inline JSON cannot close its script element"] = () => {
  const gen = read("scripts/generate-city-pages.py");
  assert.match(gen, /def script_json\(value\):[\s\S]*?\.replace\("<", "\\\\u003c"\)/);
  assert(!/_json=json\.dumps\(/.test(gen), "JSON inlined without script_json()");
  const dir = path.join(PUB, "g");
  const bad = fs.readdirSync(dir).filter(s => {
    const m = /<script>window\.(?:STADT|KREIS) = ([\s\S]*?);<\/script>/.exec(fs.readFileSync(path.join(dir, s, "index.html"), "utf8"));
    return !m || m[1].includes("<");
  });
  assert.deepStrictEqual(bad.slice(0, 5), [], `${bad.length} stubs with raw "<" in inline JSON – run scripts/generate-city-pages.py`);
};
