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
    open: name => { spur.geoeffnet.push(name); return Promise.resolve({ put: (rq, rs) => { spur.abgelegt.push([rq.url, rs]); return Promise.resolve(); }, addAll: () => Promise.resolve() }); },
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
  assert.strictEqual(sv[1], "udp-" + cv[1],
    `Cacheversion ${sv[1]} passt nicht zur Chart-Version ${cv[1]} — Clients behalten sonst die alte Shell`);
};

exports["Jede Datei der Shell existiert"] = () => {
  const liste = /const SHELL = \[([\s\S]*?)\];/.exec(SW);
  assert(liste, "SHELL-Liste nicht gefunden");
  const pfade = (liste[1].match(/"([^"]+)"/g) || []).map(s => s.slice(1, -1));
  assert(pfade.length >= 8, `SHELL wirkt unvollständig (${pfade.length} Einträge)`);
  for (const p of pfade)
    assert(fs.existsSync(path.join(ROOT, "gui/public", p)),
      `SHELL verweist auf gui/public${p} — Datei fehlt, addAll() bricht die Installation ab`);
};

exports["Shell-Treffer wird ausgeliefert UND im Hintergrund aufgefrischt"] = async () => {
  const alt = { ok: true, alt: true, clone: () => ({ alt: true }) };
  const w = ladeWorker({ imCache: alt });
  const r = await anfrage(w, "https://udp.example/smartcity-lib.js", "no-cors");
  assert.strictEqual(r, alt, "Cache-Treffer wird nicht sofort ausgeliefert");
  assert.deepStrictEqual(w.spur.geholt, ["https://udp.example/smartcity-lib.js"],
    "Cache-Treffer löst keine Hintergrund-Auffrischung aus — genau der Fehler, der Clients auf alten Dateien festhielt");
  assert.strictEqual(w.spur.abgelegt.length, 1, "aufgefrischte Antwort landet nicht im Cache");
};

exports["Shell-Fehltreffer kommt aus dem Netz"] = async () => {
  const w = ladeWorker({ imCache: null });
  const r = await anfrage(w, "https://udp.example/smartcity-theme.css", "no-cors");
  assert.strictEqual(r, w.frisch);
  assert.strictEqual(w.spur.abgelegt.length, 1);
};

exports["Seiten und Live-Daten gehen netz-zuerst"] = async () => {
  for (const [url, mode] of [
    ["https://udp.example/reutlingen", "navigate"],
    ["https://udp.example/gateway/ngsi-ld/v1/entities?type=ParkingSummary", "cors"],
    ["https://udp.example/abfahrten/08415061", "cors"],
  ]) {
    const w = ladeWorker({ imCache: { ok: true, veraltet: true, clone: () => ({}) } });
    const r = await anfrage(w, url, mode);
    assert.strictEqual(r, w.frisch, `${url} wird aus dem Cache statt aus dem Netz beantwortet`);
  }
};

exports["Fremde Origins und Schreibzugriffe bleiben unangetastet"] = async () => {
  const w = ladeWorker({ imCache: null });
  for (const req of [
    { method: "GET", url: "https://fremd.example/x.js", mode: "cors" },
    { method: "POST", url: "https://udp.example/gateway/ngsi-ld/v1/entities", mode: "cors" },
  ]) {
    let beantwortet = false;
    w.handler.fetch({ request: req, respondWith: () => { beantwortet = true; }, waitUntil: () => {} });
    assert(!beantwortet, `${req.method} ${req.url} wird vom Worker abgefangen`);
  }
  assert.deepStrictEqual(w.spur.geholt, []);
};
