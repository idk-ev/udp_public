/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Failed queries stay visible (smartcity-lib.js, stadt.html).

   A failed query (5xx, network error, 429 of the gateway's per-client rate
   limit) used to look exactly like "no data": tiles vanished without a word.
   Checked here: the soft helpers retry once and mark a failure, an empty or
   404 answer is not a failure, the page banner threshold, error tiles only
   where a municipality normally has the tile, the departure board states,
   and which requests the city page makes (pending connectors, WasteContainer).

   The city page runs in jsdom against a scripted backend (Leaflet stubbed).
   Skips without gui/node_modules like site-js.test.js. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..", "..");
const PUB = path.join(ROOT, "gui", "public");
const LIB = fs.readFileSync(path.join(PUB, "smartcity-lib.js"), "utf8");
const STADT_HTML = fs.readFileSync(path.join(PUB, "stadt.html"), "utf8");
const CONN = JSON.parse(fs.readFileSync(path.join(PUB, "connectors-status.json"), "utf8"));
const GEM = JSON.parse(fs.readFileSync(path.join(PUB, "bw-gemeinden.json"), "utf8"));

let JSDOM = null;
try {
  ({ JSDOM } = createRequire(path.join(ROOT, "gui", "package.json"))("jsdom"));
} catch {
  // not installed – the tests below skip
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/* A window with smartcity-lib loaded; `backend(url, n)` answers the n-th call
   of a URL (a Response, or an Error to simulate a network failure). */
function libWindow(backend) {
  const dom = new JSDOM("<!doctype html><html><body><div id='tiles'></div><div id='lw' role='status'></div></body></html>",
    { url: "https://udp.example/", runScripts: "outside-only" });
  const w = dom.window;
  const calls = [];
  const inits = [];
  w.fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    inits.push(init);
    const r = backend(u, calls.filter(x => x === u).length, w);
    if (r instanceof w.DOMException) throw r;
    if (r instanceof Error) throw new w.TypeError(r.message);
    return r;
  };
  w.eval(LIB);
  return { w, SC: w.SC, calls, inits };
}

exports["smartcity-lib: failed query is marked, empty and 404 are no data"] = async () => {
  if (!JSDOM) return;
  const { w, SC } = libWindow(u =>
    u.includes("type=Empty") ? json([])
      : u.includes("type=Broken") ? json({ title: "boom" }, 500, { "Retry-After": "0" })
        : u.includes("entities/urn%3Agone") ? json({ title: "Not Found" }, 404)
          : u.includes("entities/urn%3Adown") ? json({}, 503, { "Retry-After": "0" })
            : json([{ id: "x" }]));
  const mark = SC.loadMark();
  const empty = await SC.byAgs("Empty", "08415061");
  const broken = await SC.byAgs("Broken", "08415061");
  const gone = await SC.entity("urn:gone");
  const down = await SC.entity("urn:down");
  assert.deepStrictEqual([...empty], []);
  assert.strictEqual(SC.failed(empty), false, "an empty result counts as failed");
  assert.deepStrictEqual([...broken], [], "a failed list must still behave as empty");
  assert.strictEqual(SC.failed(broken), true, "a 500 is not marked as failed");
  assert.strictEqual(gone, null);
  assert.strictEqual(SC.failed("urn:gone"), false, "a 404 counts as failed");
  assert.strictEqual(down, null);
  assert.strictEqual(SC.failed("urn:down"), true, "a failed entity is not marked");
  assert.deepStrictEqual({ ...SC.loadSince(mark) }, { total: 4, failed: 2 });
  w.close();
};

exports["smartcity-lib: 429, 5xx and network errors are retried exactly once"] = async () => {
  if (!JSDOM) return;
  const { w, SC, calls } = libWindow((u, n) => {
    if (u.includes("type=Limited")) return n === 1 ? json({}, 429, { "Retry-After": "0" }) : json([{ id: "a" }]);
    if (u.includes("type=Net")) return n === 1 ? new Error("network down") : json([{ id: "b" }]);
    if (u.includes("type=Always")) return json({}, 429, { "Retry-After": "0" });
    if (u.includes("type=Bad")) return json({}, 400);
    return json([]);
  });
  const limited = await SC.byAgs("Limited", "1");
  assert.strictEqual(limited.length, 1);
  assert.strictEqual(SC.failed(limited), false, "a successful retry still counts as failed");
  assert.strictEqual(calls.filter(u => u.includes("type=Limited")).length, 2);
  const net = await SC.byAgs("Net", "1");
  assert.strictEqual(net.length, 1);
  assert.strictEqual(calls.filter(u => u.includes("type=Net")).length, 2);
  const always = await SC.byAgs("Always", "1");
  assert.strictEqual(SC.failed(always), true);
  assert.strictEqual(calls.filter(u => u.includes("type=Always")).length, 2, "more than one retry");
  const bad = await SC.byAgs("Bad", "1");
  assert.strictEqual(SC.failed(bad), true);
  assert.strictEqual(calls.filter(u => u.includes("type=Bad")).length, 1, "a 400 must not be retried");
  w.close();
};

exports["smartcity-lib: 504 and timeouts are failures without retry, each attempt has a timeout"] = async () => {
  if (!JSDOM) return;
  const { w, SC, calls, inits } = libWindow((u, n, win) =>
    u.includes("type=Gw") ? json({}, 504)
      : u.includes("type=Slow") ? new win.DOMException("signal timed out", "TimeoutError")
        : json([]));
  const gw = await SC.byAgs("Gw", "1");
  assert.strictEqual(SC.failed(gw), true);
  assert.strictEqual(calls.filter(u => u.includes("type=Gw")).length, 1, "a 504 was retried");
  const slow = await SC.byAgs("Slow", "1");
  assert.strictEqual(SC.failed(slow), true, "a timeout is not a failure");
  assert.strictEqual(calls.filter(u => u.includes("type=Slow")).length, 1, "a timeout was retried");
  assert(inits.every(i => i && i.signal instanceof w.AbortSignal), "an attempt without timeout signal");
  w.close();
};

exports["smartcity-lib: the retry honours Retry-After, capped"] = async () => {
  if (!JSDOM) return;
  const { w, SC } = libWindow((u, n) => n === 1 ? json({}, 429, { "Retry-After": "1" }) : json([]));
  let t = Date.now();
  await SC.byAgs("A", "1");
  assert(Date.now() - t >= 950, "Retry-After: 1 was not waited for");
  const capped = libWindow((u, n) => n === 1 ? json({}, 503, { "Retry-After": "120" }) : json([]));
  t = Date.now();
  await capped.SC.byAgs("B", "1");
  assert(Date.now() - t < 2600, "Retry-After is not capped");
  w.close(); capped.w.close();
};

exports["smartcity-lib: banner threshold (≥ 3, or ≥ 2 and ≥ 20 %)"] = () => {
  if (!JSDOM) return;
  const { w, SC } = libWindow(() => json([]));
  const cases = [[0, 10, false], [1, 1, false], [1, 3, false], [2, 20, false], [2, 10, true], [2, 3, true], [3, 40, true]];
  for (const [f, t, due] of cases) assert.strictEqual(SC.bannerDue(f, t), due, `${f} of ${t}`);
  w.close();
};

exports["smartcity-lib: loadBanner fills the role=status element and clears it"] = async () => {
  if (!JSDOM) return;
  const { w, SC } = libWindow(u => u.includes("type=Bad") ? json({}, 502, { "Retry-After": "0" }) : json([]));
  const el = w.document.getElementById("lw");
  let mark = SC.loadMark();
  await Promise.all(["Bad", "Bad", "Bad", "Ok"].map((t, i) => SC.byAgs(t, String(i))));
  assert.strictEqual(SC.loadBanner("#lw", mark), true);
  assert.match(el.textContent, /Einige Daten konnten nicht geladen werden/);
  assert.strictEqual(el.getAttribute("role"), "status");
  mark = SC.loadMark();
  await Promise.all(["Bad", "Ok", "Ok"].map((t, i) => SC.byAgs(t, String(i))));
  assert.strictEqual(SC.loadBanner("#lw", mark), false, "one failure must not raise the banner");
  assert.strictEqual(el.textContent, "");
  w.close();
};

exports["smartcity-lib: error tiles only where the tile normally exists"] = () => {
  if (!JSDOM) return;
  const { w, SC } = libWindow(() => json([]));
  const host = w.document.getElementById("tiles");
  const mem = SC.tileMemory("test:1");
  const specs = (parkenFailed, sharingFailed) => [
    { key: "parken", labels: ["Parken"], failed: parkenFailed, topic: "mobilitaet" },
    { key: "sharing", labels: ["E-Scooter"], failed: sharingFailed, topic: "mobilitaet" },
  ];
  // First view: Parken shown with data, E-Scooter fails but was never seen.
  host.innerHTML = SC.tile("Parken", 10, "");
  assert.deepStrictEqual(SC.errorTiles(host, specs(false, true), mem), []);
  // Next view: the Parken query fails – error tile; still none for E-Scooter.
  host.innerHTML = "";
  assert.deepStrictEqual(SC.errorTiles(host, specs(true, true), mem), ["parken"]);
  const err = host.querySelector(".tile-error");
  assert.strictEqual(err.querySelector(".label").textContent, "Parken");
  assert.strictEqual(err.querySelector(".value").textContent, "Daten derzeit nicht abrufbar");
  assert.strictEqual(err.dataset.topic, "mobilitaet");
  // Failing again keeps the memory; a successful empty answer drops it.
  host.innerHTML = "";
  assert.deepStrictEqual(SC.errorTiles(host, specs(true, false), mem), ["parken"]);
  host.innerHTML = "";
  assert.deepStrictEqual(SC.errorTiles(host, specs(false, false), mem), []);
  host.innerHTML = "";
  assert.deepStrictEqual(SC.errorTiles(host, specs(true, false), mem), [], "an empty result must end the memory");
  // Persisted per scope.
  host.innerHTML = SC.tile("E-Scooter", 3, "");
  SC.errorTiles(host, specs(false, false), mem);
  assert(SC.tileMemory("test:1").has("sharing"));
  assert(!SC.tileMemory("test:2").has("sharing"));
  w.close();
};

/* ---------- stadt.html against a scripted backend ---------- */

const REUTLINGEN = GEM.gemeinden.find(g => g[0] === "08415061");
const leafletStub = w => {
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain });
  w.L = new Proxy({}, { get: () => chain });
};

/* Renders stadt.html for Reutlingen. `opts.entities` maps entity ids to
   bodies, `opts.types` NGSI-LD types to lists, `opts.fail` is a predicate for
   URLs answered with 503, `opts.abfahrten` the /abfahrten Response. */
async function renderStadt(opts = {}) {
  const html = STADT_HTML.replace(/<script src="[^"]*"><\/script>/g, "");
  const dom = new JSDOM(html, { url: "https://udp.example/reutlingen", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  for (const [k, v] of Object.entries(opts.storage || {})) w.localStorage.setItem(k, v);
  w.STADT = { row: REUTLINGEN, website: "https://www.reutlingen.de" };
  w.fetch = async url => {
    const u = decodeURIComponent(String(url));
    calls.push(u);
    if (opts.delay) await new Promise(r => setTimeout(r, opts.delay));
    if (opts.fail && opts.fail(u)) return json({ title: "Service Unavailable" }, 503, { "Retry-After": "0" });
    if (u === "/connectors-status.json") return json(opts.conn || CONN);
    if (u === "/dashboards.json") return json({ kommunen: opts.kommunen || {} });
    if (u.startsWith("/abfahrten")) return opts.abfahrten ? opts.abfahrten() : json({ fehler: "kein Halt" }, 404);
    if (u.startsWith("/gateway/temporal/")) return json({});
    const byId = u.match(/\/ngsi-ld\/v1\/entities\/([^?]+)/);
    if (byId) {
      const e = (opts.entities || {})[byId[1]];
      return e ? json(e) : json({ title: "Entity Not Found" }, 404);
    }
    const type = (u.match(/[?&]type=([^&]+)/) || [])[1];
    return json((opts.types || {})[type] || []);
  };
  leafletStub(w);
  w.eval(LIB);
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  for (const src of inline) w.eval(src);
  const t0 = Date.now();
  while (!/^Stand:/.test(w.document.getElementById("stand").textContent)) {
    if (w.document.getElementById("err").textContent) throw new Error(w.document.getElementById("err").textContent);
    if (Date.now() - t0 > 10000) throw new Error("stadt.html did not finish rendering");
    await new Promise(r => setTimeout(r, 20));
  }
  return { w, d: w.document, calls };
}

const labels = d => [...d.querySelectorAll("#tiles .tile .label")].map(l => l.textContent.trim());
const errorLabels = d => [...d.querySelectorAll("#tiles .tile-error .label")].map(l => l.textContent.trim());
const WX = { id: "urn:ngsi-ld:WeatherObserved:bw-08415061", type: "WeatherObserved",
  temperature: { type: "Property", value: 14.2 }, windSpeed: { type: "Property", value: 8 } };

exports["stadt.html: a healthy page shows no error state and no banner"] = async () => {
  if (!JSDOM) return;
  const { w, d } = await renderStadt({ entities: { [WX.id]: WX } });
  assert.deepStrictEqual(errorLabels(d), []);
  assert.strictEqual(d.getElementById("loadwarn").textContent, "");
  assert(labels(d).includes("Temperatur"));
  w.close();
};

exports["stadt.html: pending connector is still asked, its 404 is no data"] = async () => {
  if (!JSDOM) return;
  // hystreet is "pending" in the image, but its token arrives at runtime
  // (reverted e6bed5c): the sample entity must still be asked for, and its
  // 404 must neither produce an error tile nor count for the banner.
  const hystreet = CONN.connectors.find(c => c.id === "hystreet");
  assert(hystreet && hystreet.pending && hystreet.enabledFor.includes("08415061"), "fixture assumption changed");
  const { w, d, calls } = await renderStadt({ entities: { [WX.id]: WX }, storage: { "sc-tiles:stadt:08415061": '["passanten"]' } });
  assert(calls.some(u => u.includes(hystreet.sampleEntity)), "pending connector not asked – the tile would stay hidden with a runtime token");
  assert(!errorLabels(d).includes("Passanten"), "a 404 of a pending connector became an error tile");
  assert.strictEqual(d.getElementById("loadwarn").textContent, "");
  w.close();
};

exports["stadt.html: WasteContainer is only asked where a connector provides it"] = async () => {
  if (!JSDOM) return;
  const without = await renderStadt({ entities: { [WX.id]: WX } });
  assert(!without.calls.some(u => u.includes("type=WasteContainer")), "WasteContainer asked without a providing connector");
  without.w.close();
  const conn = { connectors: CONN.connectors.concat([{ id: "fuellstand-test", active: true, enabledFor: ["08415061"], provides: ["fuellstand"] }]) };
  const withConn = await renderStadt({ conn, entities: { [WX.id]: WX } });
  assert(withConn.calls.some(u => u.includes("type=WasteContainer")), "WasteContainer not asked although provided");
  withConn.w.close();
  // A feed without a connector (IoT agent): opt-in per municipality in dashboards.json.
  const optIn = await renderStadt({ kommunen: { reutlingen: { fuellstand: true } }, entities: { [WX.id]: WX } });
  assert(optIn.calls.some(u => u.includes("type=WasteContainer")), "dashboards.json fuellstand: true ignored");
  optIn.w.close();
};

exports["stadt.html: failed queries show error tiles and the banner"] = async () => {
  if (!JSDOM) return;
  const { w, d } = await renderStadt({
    entities: { [WX.id]: WX },
    fail: u => /WeatherObserved:bw-|type=ParkingSummary|type=SharingSummary|type=RoadWork|Alert:bw-kreis/.test(u),
    // Parken was shown on an earlier view, E-Scooter never.
    storage: { "sc-tiles:stadt:08415061": '["parken"]' },
  });
  const errs = errorLabels(d);
  for (const l of ["Temperatur", "Wind", "Warnungen", "Baustellen", "Parken"]) assert(errs.includes(l), `no error tile for ${l} (${errs.join(", ")})`);
  assert(!errs.includes("E-Scooter"), "error tile for data the municipality never showed");
  assert(!labels(d).some(l => l === "Warnungen" && !errs.includes(l)), "Warnungen shown as 'keine' although the query failed");
  const banner = d.getElementById("loadwarn");
  assert.strictEqual(banner.getAttribute("role"), "status");
  assert.match(banner.textContent, /Einige Daten konnten nicht geladen werden – bitte später neu laden\./);
  w.close();
};

exports["stadt.html: departure board – no departures vs. disturbed"] = async () => {
  if (!JSDOM) return;
  const leer = await renderStadt({ entities: { [WX.id]: WX },
    abfahrten: () => json({ halt: "Reutlingen ZOB", stopId: "x", stand: new Date().toISOString(), medianVerspaetung: null,
      echtzeitAbfahrten: 0, quelle: "EFA-BW", abfahrten: [] }) });
  assert.strictEqual(leer.d.getElementById("dep-card").style.display, "block");
  assert.match(leer.d.querySelector("#deps tbody").textContent, /Derzeit keine Abfahrten/);
  assert.match(leer.d.getElementById("dep-title").textContent, /Reutlingen ZOB/);
  leer.w.close();

  const gestoert = await renderStadt({ entities: { [WX.id]: WX },
    abfahrten: () => json({ fehler: "Auskunft nicht erreichbar", halt: "Reutlingen ZOB" }, 502) });
  assert.strictEqual(gestoert.d.getElementById("dep-card").style.display, "block");
  assert.match(gestoert.d.querySelector("#deps tbody").textContent, /Fahrplanauskunft derzeit gestört/);
  gestoert.w.close();

  // No stop for this municipality (404): no board at all, as before.
  const ohne = await renderStadt({ entities: { [WX.id]: WX } });
  assert.strictEqual(ohne.d.getElementById("dep-card").style.display, "none");
  ohne.w.close();
};

exports["stadt.html: busy or unloaded /abfahrten is 'disturbed' only where a stop is known"] = async () => {
  if (!JSDOM) return;
  // 503 before the stop directory is loaded names no stop: no board for a
  // municipality that never had one ...
  const busy = () => json({ fehler: "Haltestellenverzeichnis noch nicht geladen" }, 503);
  const fremd = await renderStadt({ entities: { [WX.id]: WX }, abfahrten: busy });
  assert.strictEqual(fremd.d.getElementById("dep-card").style.display, "none");
  fremd.w.close();
  // ... but "disturbed" where the ÖPNV tile is normally shown.
  const bekannt = await renderStadt({ entities: { [WX.id]: WX }, abfahrten: busy,
    storage: { "sc-tiles:stadt:08415061": '["oepnv"]' } });
  assert.match(bekannt.d.querySelector("#deps tbody").textContent, /Fahrplanauskunft derzeit gestört/);
  assert(errorLabels(bekannt.d).includes("ÖPNV-Verspätung"), "no error tile for the remembered ÖPNV tile");
  bekannt.w.close();
};

/* ---------- kreis.html and dashboard.html ---------- */

// Renders a page whose gateway answers 503 for URLs matching `failRe`.
async function renderPage(file, url, failRe, globals = {}) {
  const html = fs.readFileSync(path.join(PUB, file), "utf8").replace(/<script src="[^"]*"><\/script>/g, "");
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(w, globals);
  w.fetch = async u => {
    const s = decodeURIComponent(String(u));
    if (failRe && failRe.test(s)) return json({}, 503, { "Retry-After": "0" });
    if (!s.startsWith("/gateway")) {
      const f = path.join(PUB, s.split("?")[0]);
      return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : json({}, 404);
    }
    if (s.includes("/entities/")) return json({ title: "Not Found" }, 404);
    return json(s.includes("/temporal/") ? {} : []);
  };
  leafletStub(w);
  w.open = () => {};
  w.eval(LIB);
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) w.eval(m[1]);
  const t0 = Date.now();
  while (!/^Stand:/.test(w.document.getElementById("stand").textContent)) {
    if (w.document.getElementById("err").textContent) throw new Error(w.document.getElementById("err").textContent);
    if (Date.now() - t0 > 10000) throw new Error(`${file} did not finish rendering`);
    await new Promise(r => setTimeout(r, 20));
  }
  return w;
}

exports["kreis.html: failed queries show the error state and the banner, empty ones don't"] = async () => {
  if (!JSDOM) return;
  const KREIS = { KREIS: { slug: "kreis-reutlingen", krs: "08415" } };
  const ok = await renderPage("kreis.html", "https://udp.example/kreis-reutlingen", null, KREIS);
  assert.deepStrictEqual(errorLabels(ok.document), []);
  assert.strictEqual(ok.document.getElementById("loadwarn").textContent, "");
  ok.close();
  const bad = await renderPage("kreis.html", "https://udp.example/kreis-reutlingen", /Alert|type=CityPulse|type=EnergyMonitor/, KREIS);
  assert.deepStrictEqual(errorLabels(bad.document), ["Warnungen"]);
  assert.match(bad.document.getElementById("loadwarn").textContent, /Einige Daten konnten nicht geladen werden/);
  bad.close();
};

exports["dashboard.html: failed PlatformStatus shows the error state instead of '–'"] = async () => {
  if (!JSDOM) return;
  const w = await renderPage("dashboard.html", "https://udp.example/dashboard.html", /PlatformStatus:udp-troe/);
  const errs = errorLabels(w.document);
  assert.deepStrictEqual(errs, ["Zeitreihen-DB", "TRoE-Zeilen", "Entitäten", "Datenfluss"]);
  assert(!errs.includes("Serverlast"), "the healthy host status became an error tile");
  w.close();
};

exports["stadt.html: a refresh while a render still runs is skipped"] = async () => {
  if (!JSDOM) return;
  const opts = { entities: { [WX.id]: WX } };
  const { w, d, calls } = await renderStadt(opts);
  const wxCalls = () => calls.filter(u => u.endsWith("/ngsi-ld/v1/entities/" + WX.id)).length;
  const before = wxCalls();
  opts.delay = 150;
  for (let i = 0; i < 3; i++) d.dispatchEvent(new w.CustomEvent("sc-theme-changed"));
  await new Promise(r => setTimeout(r, 1500));
  assert.strictEqual(wxCalls() - before, 1, "overlapping renders");
  w.close();
};
