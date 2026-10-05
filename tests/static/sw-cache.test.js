/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Invarianten des Service-Workers (Sprint 2.9).
   Anlass: gui/public/sw.js trug seit dem ersten Release die handgepflegte
   Cacheversion "udp-v2" und frischte Treffer im Shell-Cache nie auf. Wiederkehrende
   Browser hingen dadurch dauerhaft auf den statischen Dateien ihres ersten Besuchs —
   ein Deploy änderte an dashboards.json oder connectors-status.json für sie nichts.
   Geprüft wird beides: die Kopplung der Version an das Chart und das tatsächliche
   Verhalten des fetch-Handlers. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const SW = fs.readFileSync(path.join(ROOT, "gui/public/sw.js"), "utf8");

/* Den Worker mit Attrappen laden, statt sein Verhalten aus dem Quelltext zu raten.
   sw.js greift nur auf self/caches/fetch/location/URL zu — als Function-Parameter
   übergeben, verhält sich der Modulrumpf wie im Browser-Worker-Scope. */
function ladeWorker({ imCache = null, netz = { ok: true } } = {}) {
  const spur = { geholt: [], abgelegt: [], geoeffnet: [] };
  const antwort = o => Object.assign({ clone: () => Object.assign({}, o, { istKopie: true }) }, o);
  const frisch = antwort(netz);
  const handler = {};
  const self_ = {
    addEventListener: (typ, fn) => { handler[typ] = fn; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  const caches_ = {
    open: name => { spur.geoeffnet.push(name); return Promise.resolve({ put: (rq, rs) => { spur.abgelegt.push([rq.url, rs]); return Promise.resolve(); }, addAll: () => Promise.resolve(), delete: () => Promise.resolve(true) }); },
    match: () => Promise.resolve(imCache),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true),
  };
  const fetch_ = rq => { spur.geholt.push(rq.url); return Promise.resolve(frisch); };
  // eslint-disable-next-line no-new-func
  new Function("self", "caches", "fetch", "location", "URL", SW)(
    self_, caches_, fetch_, { origin: "https://udp.example" }, URL);
  return { handler, spur, frisch };
}

/* Ein fetch-Event nachstellen und abwarten, bis Antwort UND Hintergrundarbeit stehen. */
async function anfrage(worker, url, mode) {
  let antwort, warten = [];
  const e = {
    request: { method: "GET", url, mode },
    respondWith: p => { antwort = p; },
    waitUntil: p => warten.push(p),
  };
  worker.handler.fetch(e);
  const r = await antwort;
  await Promise.allSettled(warten);
  return r;
}

exports["Cacheversion folgt der Chart-Version"] = () => {
  const chart = fs.readFileSync(path.join(ROOT, "helm/udp/Chart.yaml"), "utf8");
  const cv = /^version:\s*(\S+)\s*$/m.exec(chart);
  assert(cv, "helm/udp/Chart.yaml: version nicht gefunden");
  const sv = /^const V = "([^"]+)";$/m.exec(SW);
  assert(sv, "gui/public/sw.js: const V nicht gefunden");
  // Optional "-swN": discards the caches between releases when the worker changes.
  const base = sv[1].replace(/-sw\d+$/, "");
  assert.strictEqual(base, "udp-" + cv[1],
    `Cacheversion ${sv[1]} passt nicht zur Chart-Version ${cv[1]} — Clients behalten sonst die alte Shell`);
};

exports["Jede Datei der Shell existiert"] = () => {
  const liste = /const SHELL = \[([\s\S]*?)\];/.exec(SW);
  assert(liste, "SHELL-Liste nicht gefunden");
  const pfade = (liste[1].match(/"([^"]+)"/g) || []).map(s => s.slice(1, -1));
  assert(pfade.length >= 8, `SHELL wirkt unvollständig (${pfade.length} Einträge)`);
  // Addresses nginx answers without a file of that name: /favicon falls back
  // to /icon.svg, the start page / is mitmachen.html
  // (platform/config/nginx/cockpit.conf.template).
  const conf = fs.readFileSync(path.join(ROOT, "platform/config/nginx/cockpit.conf.template"), "utf8");
  const served = { "/favicon": "/icon.svg", "/": "/mitmachen.html" };
  for (const p of pfade) {
    if (served[p]) {
      assert(conf.includes(`location = ${p} {`) && conf.includes(` ${served[p]} =404;`),
        `SHELL verweist auf ${p}, aber nginx liefert die Adresse nicht (mehr) mit Rückfall ${served[p]} aus`);
      continue;
    }
    assert(fs.existsSync(path.join(ROOT, "gui/public", p)),
      `SHELL verweist auf gui/public${p} — Datei fehlt, addAll() bricht die Installation ab`);
  }
};

/* Scripts, styles and config.js went stale-while-revalidate until 2026-10:
   after every deploy the first view ran new HTML with the old scripts. */
exports["Seiten, Skripte, Styles und config.js gehen netz-zuerst und frischen die Offline-Kopie auf"] = async () => {
  for (const [url, mode] of [
    ["https://udp.example/reutlingen", "navigate"],
    ["https://udp.example/smartcity-lib.js", "no-cors"],
    ["https://udp.example/smartcity-theme.css", "no-cors"],
    ["https://udp.example/config.js", "no-cors"],
  ]) {
    const w = ladeWorker({ imCache: { ok: true, veraltet: true, clone: () => ({}) } });
    const r = await anfrage(w, url, mode);
    assert.strictEqual(r, w.frisch, `${url} wird aus dem Cache statt aus dem Netz beantwortet`);
    assert.deepStrictEqual(w.spur.abgelegt.map(a => a[0]), [url], `${url}: Offline-Kopie wird nicht aufgefrischt`);
  }
};

exports["Offline: gespeicherte Kopie, für Seiten zuletzt die Startseite"] = async () => {
  // Worker whose network fails and whose cache answers per URL.
  const worker = cache => {
    const handler = {};
    const matched = [];
    // eslint-disable-next-line no-new-func
    new Function("self", "caches", "fetch", "location", "URL", SW)(
      { addEventListener: (t, fn) => { handler[t] = fn; }, skipWaiting: () => Promise.resolve(), clients: { claim: () => Promise.resolve() } },
      { open: () => Promise.resolve({ put: () => Promise.resolve() }), keys: () => Promise.resolve([]), delete: () => Promise.resolve(true),
        match: (rq, o) => {
          const url = typeof rq === "string" ? rq : rq.url;
          matched.push([url, o]);
          return Promise.resolve(cache[o && o.ignoreSearch ? url.split("?")[0] : url] || null);
        } },
      () => Promise.reject(new TypeError("offline")), { origin: "https://udp.example" }, URL);
    return { handler, matched };
  };
  const start = { start: true };
  const page = { page: true };
  const w1 = worker({ "/": start, "https://udp.example/tuebingen": page });
  assert.strictEqual(await anfrage(w1, "https://udp.example/tuebingen?embed=1", "navigate"), page,
    "offline page does not come from its stored copy");
  assert.deepStrictEqual(w1.matched[0][1], { ignoreSearch: true }, "stored copy is looked up with the query");
  const w2 = worker({ "/": start });
  assert.strictEqual(await anfrage(w2, "https://udp.example/aach", "navigate"), start, "no start page fallback offline");
};

exports["Live-Daten: weder beantwortet noch gespeichert"] = async () => {
  for (const url of [
    "https://udp.example/gateway/ngsi-ld/v1/entities?type=ParkingSummary",
    "https://udp.example/gateway/temporal/temporal/entities/urn%3Ax?attrs=a&timerel=after&timeAt=2026-10-05T10:00:00.000Z",
    "https://udp.example/abfahrten?ags=08415061",
    "https://udp.example/warnungen.ics?kreis=08415",
  ]) {
    const w = ladeWorker({ imCache: { ok: true, veraltet: true, clone: () => ({}) } });
    let beantwortet = false;
    w.handler.fetch({ request: { method: "GET", url, mode: "cors" }, respondWith: () => { beantwortet = true; }, waitUntil: () => {} });
    assert(!beantwortet, `${url} wird vom Worker beantwortet`);
    assert.deepStrictEqual(w.spur.geholt, [], `${url} wird vom Worker geholt`);
    assert.deepStrictEqual(w.spur.abgelegt, [], `${url} landet im Cache Storage`);
  }
};

exports["Adressen mit Query werden nicht gespeichert"] = async () => {
  const w = ladeWorker({ imCache: null });
  const r = await anfrage(w, "https://udp.example/tuebingen?embed=1&theme=wald", "navigate");
  assert.strictEqual(r, w.frisch);
  assert.deepStrictEqual(w.spur.abgelegt, [], "every query string would add a cache entry");
};

exports["Fremde Origins und Schreibzugriffe bleiben unangetastet"] = async () => {
  const w = ladeWorker({ imCache: null });
  for (const req of [
    { method: "GET", url: "https://fremd.example/x.js", mode: "cors" },
    { method: "POST", url: "https://udp.example/gateway/ngsi-ld/v1/entities", mode: "cors" },
    // Login-protected: the browser's own request must get the 401 (prompt).
    { method: "GET", url: "https://udp.example/dashboard.html", mode: "navigate" },
    // Operations data behind the same login: neither answered nor stored.
    { method: "GET", url: "https://udp.example/ops/connectors-status.json", mode: "cors" },
    { method: "GET", url: "https://udp.example/ops/gateway/ngsi-ld/v1/entities?type=PlatformStatus", mode: "cors" },
    { method: "GET", url: "https://udp.example/ops/gateway/temporal/temporal/entities/urn%3Ax?attrs=cpuLoadPct", mode: "cors" },
  ]) {
    let beantwortet = false;
    w.handler.fetch({ request: req, respondWith: () => { beantwortet = true; }, waitUntil: () => {} });
    assert(!beantwortet, `${req.method} ${req.url} wird vom Worker abgefangen`);
  }
  assert.deepStrictEqual(w.spur.geholt, []);
};
