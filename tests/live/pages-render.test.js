/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Live-Regression gegen den laufenden Stack (BASE_URL, Default localhost:3700).
   Rendert die Seiten per jsdom (Leaflet gestubbt) und prüft Mindest-Inhalte. */
"use strict";
const assert = require("assert");
const path = require("path");
const { createRequire } = require("module");
const greq = createRequire(path.join(__dirname, "..", "..", "gui", "package.json"));
const { JSDOM } = greq("jsdom");

const BASE = process.env.BASE_URL || "http://localhost:3700";
const leafletStub = w => {
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain });
  w.L = new Proxy({}, { get: () => chain });
};

async function renderCity(slug, stadt) {
  const bundle = await (await fetch(BASE + "/stadt.html")).text();
  const dom = new JSDOM(bundle.replace(/<script src="\/vendor\/[^"]*"><\/script>/g, ""), {
    url: BASE + "/" + slug, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.STADT = stadt;
  w.fetch = (u, o) => fetch(String(u).startsWith("http") ? u : BASE + u, o);
  leafletStub(w);
  w.eval(await (await fetch(BASE + "/smartcity-lib.js")).text());
  const doc = new JSDOM(bundle).window.document;
  for (const s of doc.querySelectorAll("script:not([src])")) w.eval(s.textContent);
  await new Promise(r => setTimeout(r, 12000));
  return w.document;
}

exports["Reutlingen: volle Detailtiefe (≥20 Kacheln, ≥7 Charts, Fehlerbox leer)"] = async () => {
  const d = await renderCity("reutlingen", { ags: "08415061", slug: "reutlingen", name: "Reutlingen" });
  assert.strictEqual(d.querySelector("#err").textContent, "", "Fehlerbox belegt");
  assert(d.querySelectorAll("#tiles .tile").length >= 20, "zu wenige Kacheln");
  assert(d.querySelectorAll("#charts .card").length >= 7, "zu wenige Chart-Karten");
};

exports["Datenarme Gemeinde rendert fehlerfrei (Böllen)"] = async () => {
  const d = await renderCity("boellen", { ags: "08336015", slug: "boellen", name: "Böllen" });
  assert.strictEqual(d.querySelector("#err").textContent, "");
  assert(d.querySelectorAll("#tiles .tile").length >= 5);
};

exports["Routing: Permalinks, Redirects, 404"] = async () => {
  const code = async (p, redirect) => {
    const r = await fetch(BASE + p, { redirect: "manual" });
    if (redirect) assert.strictEqual(r.headers.get("location"), redirect, p);
    return r.status;
  };
  assert.strictEqual(await code("/reutlingen"), 200);
  assert.strictEqual(await code("/kreis-reutlingen"), 200);
  assert.strictEqual(await code("/dashboard.html"), 200);
  assert.strictEqual(await code("/kommunen.html", "/dashboard.html"), 301);
  assert.strictEqual(await code("/kreis-ulm", "/ulm"), 301);
  assert.strictEqual(await code("/gibtsnicht-xyz"), 404);
};

exports["Gateway: NGSI-LD und Temporal antworten"] = async () => {
  const r1 = await fetch(BASE + "/gateway/ngsi-ld/v1/entities?type=CityPulse&limit=1");
  assert.strictEqual(r1.status, 200);
  const r2 = await fetch(BASE + "/gateway/temporal/health").catch(() => ({ status: 0 }));
  assert(r2.status < 500, "Mintaka-Health nicht erreichbar");
};

exports["Neue Bürger-Datenquellen liefern (Pollen, Pegel, Rathaus, Ausflug)"] = async () => {
  const count = async type => {
    const r = await fetch(`${BASE}/gateway/ngsi-ld/v1/entities?type=${type}&limit=1000&options=keyValues`);
    return r.ok ? (await r.json()).length : 0;
  };
  assert.strictEqual(await count("PollenForecast"), 3, "3 DWD-Teilregionen erwartet");
  assert(await count("CivicStructure") > 500, "Rathäuser: zu wenige");
  assert(await count("TouristDestination") > 500, "Ausflugsziel-Gemeinden: zu wenige");
  // Pegel: nur Bundeswasserstraßen — tolerant, aber > 0
  assert(await count("WaterLevelObserved") > 100, "Pegel: LUBW-Landespegel fehlen");
  // Reutlingen hat keinen eigenen Pegel — der nächste (Echaz/Wannweil) muss gefunden werden
  const all = await (await fetch(`${BASE}/gateway/ngsi-ld/v1/entities?type=WaterLevelObserved&limit=1000&options=keyValues`)).json();
  assert(all.some(e => e.id.includes("bw-hvz-") && e.water === "Echaz"), "kein Echaz-Pegel (LUBW)");
};

exports["ÖPNV in allen konfigurierten Städten"] = async () => {
  const conn = await (await fetch(BASE + "/connectors-status.json")).json();
  const efa = conn.connectors.find(c => c.id === "efa-abfahrten");
  const stops = await (await fetch(`${BASE}/gateway/ngsi-ld/v1/entities?type=PublicTransportStop&limit=100&options=keyValues`)).json();
  assert.strictEqual(stops.length, efa.enabledFor.length,
    `${efa.enabledFor.length} Städte konfiguriert, ${stops.length} Stops live`);
  for (const s of stops) assert(Array.isArray(s.departures) && s.departures.length, `${s.id}: keine Abfahrten`);
};

exports["Stufe-3-Bausteine sind landesweit (Laden, Carsharing, DWD, Vorhersage)"] = async () => {
  const hole = async (typ, extra = "") =>
    (await (await fetch(`${BASE}/gateway/ngsi-ld/v1/entities?type=${typ}&limit=1000&options=keyValues${extra}`)).json());

  // Ladestationen: Einzelstandorte mit Livestatus, nicht mehr nur Reutlingen
  const laden = await hole("ChargingSummary");
  const mitLive = laden.filter(e => e.liveEvse > 0);
  assert(mitLive.length > 200, `nur ${mitLive.length} Gemeinden mit Lade-Livestatus`);

  // Carsharing: mehrere Anbieter, Bauform gesetzt (Autos von Rädern getrennt)
  const flotten = await hole("FleetStatus");
  assert(flotten.length > 100, `nur ${flotten.length} Flotten`);
  assert(flotten.some(e => e.vehicleType === "car"), "keine Auto-Flotte");
  assert(flotten.some(e => e.vehicleType === "bicycle"), "keine Rad-Flotte");

  // Amtliche DWD-Stationen als eigene Entitäten (Dashboard wählt die nächste)
  const dwd = await hole("WeatherObserved", "&idPattern=" + encodeURIComponent("urn:ngsi-ld:WeatherObserved:bw-dwd-.*"));
  assert(dwd.length > 50, `nur ${dwd.length} DWD-Stationen`);

  // Vorhersage: Stufe-3-Werte für praktisch alle Gemeinden
  const fc = await hole("WeatherForecast");
  const mitUV = fc.filter(e => e.uvIndex != null).length;
  assert(mitUV > fc.length * 0.9, `nur ${mitUV} von ${fc.length} Vorhersagen mit UV-Index`);
};

exports["Abfahrten auf Anfrage antworten für beliebige Gemeinden"] = async () => {
  const halte = await (await fetch(BASE + "/oepnv-halte.json")).json();
  const ags = Object.keys(halte.halte);
  assert(ags.length > 900, `nur ${ags.length} Halte hinterlegt — efa-haltestellen.py laufen lassen`);

  // Stichprobe quer über das Land, darunter eine Großstadt und ein Kleinstort
  for (const a of [ags[0], ags[Math.floor(ags.length / 2)], ags[ags.length - 1]]) {
    const r = await fetch(`${BASE}/abfahrten?ags=${a}`);
    assert(r.ok, `/abfahrten?ags=${a}: HTTP ${r.status}`);
    const d = await r.json();
    assert(typeof d.halt === "string" && d.halt, `${a}: kein Haltname`);
    assert(Array.isArray(d.abfahrten), `${a}: keine Abfahrtsliste`);
  }
  // Unbekannte AGS muss sauber 404 liefern, nicht 500
  const r404 = await fetch(`${BASE}/abfahrten?ags=99999999`);
  assert.strictEqual(r404.status, 404, "unbekannte AGS liefert kein 404");
};

exports["Bürgerservice-Link ist flächendeckend (Wikidata P856)"] = async () => {
  const svc = (await (await fetch(BASE + "/gemeinde-services.json")).json()).dienste;
  const ags = Object.keys(svc);
  assert(ags.length > 1000, `nur ${ags.length} Gemeinden mit amtlicher Website — Generator laufen lassen`);
  // Jede Gemeinde-Website ist eine plausible http(s)-URL
  for (const a of [ags[0], ags[Math.floor(ags.length / 2)], ags[ags.length - 1]]) {
    assert(/^https?:\/\/.+\..+/.test(svc[a].website), `${a}: unplausible URL ${svc[a].website}`);
  }
  // Datenarme Gemeinde ohne OSM-Öffnungszeiten: die amtliche Website trägt die
  // Rathaus-&-Bürgerbüro-Kachel als Link-Fallback.
  const d = await renderCity("boellen", { ags: "08336010", slug: "boellen", name: "Böllen" });
  const rathaus = [...d.querySelectorAll('#tiles .tile[data-topic="service"]')]
    .find(t => /Rathaus & Bürgerbüro/.test(t.textContent));
  assert(rathaus, "Böllen ohne Rathaus-&-Bürgerbüro-Kachel");
  assert(rathaus.tagName === "A" && /boellen\.de/.test(rathaus.getAttribute("href") || ""),
    "Rathaus-Kachel verlinkt nicht auf die amtliche Website");
};

exports["Jede Gemeinde hat die vier Bürgerservice-Kacheln + saubere Themen-Gruppierung"] = async () => {
  // Kleiner Ort ohne kuratierte Links: die Pflicht-Vier müssen trotzdem da sein
  const d = await renderCity("boellen", { ags: "08336010", slug: "boellen", name: "Böllen" });
  // Pflicht-Vier über Service (Rathaus/Mängel/Müll) UND Freizeit (Veranstaltungen)
  const labels = [...d.querySelectorAll('#tiles .tile[data-topic="service"] .label, #tiles .tile[data-topic="freizeit"] .label')].map(l => l.textContent);
  for (const pflicht of ["Rathaus & Bürgerbüro", "Mängel melden", "Müllabfuhr", "Veranstaltungen"]) {
    assert(labels.includes(pflicht), `Böllen ohne Pflicht-Kachel »${pflicht}« (hat: ${labels.join(", ")})`);
  }
  // Nicht bereitgestellte Dienste erscheinen als Potenzial-Kachel, nicht als Lücke
  assert(d.querySelectorAll('#tiles a.tile.tile-empty').length >= 1, "keine Potenzial-Kachel bei datenarmer Gemeinde");

  // Themen-Gruppierung: Kacheln stehen nach Thema sortiert (nicht gemischt)
  const order = { "": 0, wetter: 1, umwelt: 2, mobilitaet: 3, energie: 4, service: 5, freizeit: 6 };
  const seq = [...d.querySelectorAll('#tiles .tile')].map(t => order[t.dataset.topic || ""] ?? 9);
  for (let i = 1; i < seq.length; i++) {
    assert(seq[i] >= seq[i - 1], `Kacheln nicht themengruppiert an Position ${i} (${seq.join(",")})`);
  }
};

exports["Neue Bürger-Features: Hitzeindex, Warn-iCal, Datenqualitäts-Panel"] = async () => {
  // Hitzebelastung: 5 DWD-Vertreterstädte
  const hitze = await (await fetch(`${BASE}/gateway/ngsi-ld/v1/entities?type=HeatHealthWarning&options=keyValues`)).json();
  assert(hitze.length >= 5, `nur ${hitze.length} Hitze-Vertreterstädte`);
  assert(hitze.every(e => e.todayLevel && typeof e.maxRank === "number"), "Hitze-Entität unvollständig");

  // Warn-iCal-Abo: gültiger Kalender je Kreis, 400 ohne Kreis
  const ics = await fetch(`${BASE}/warnungen.ics?kreis=08415`);
  assert.strictEqual(ics.status, 200, "warnungen.ics nicht 200");
  const cal = await ics.text();
  assert(cal.startsWith("BEGIN:VCALENDAR") && cal.includes("END:VCALENDAR"), "kein gültiges VCALENDAR");
  assert.strictEqual((await fetch(`${BASE}/warnungen.ics`)).status, 400, "warnungen.ics ohne Kreis nicht 400");

  // PWA: Manifest + Service-Worker erreichbar
  assert.strictEqual((await fetch(`${BASE}/manifest.webmanifest`)).status, 200, "Manifest fehlt");
  assert.strictEqual((await fetch(`${BASE}/sw.js`)).status, 200, "Service-Worker fehlt");

  // Datenqualitäts-Panel nur mit ?daten=1
  const d = await renderCity("reutlingen", { ags: "08415061", slug: "reutlingen", name: "Reutlingen" });
  assert.strictEqual(d.querySelector("#dq").style.display, "none", "Datenpanel in Bürgeransicht sichtbar");
};

exports["Familie & Versorgung (OSM) liefert für viele Gemeinden"] = async () => {
  const pa = await (await fetch(`${BASE}/gateway/ngsi-ld/v1/entities?type=PublicAmenity&limit=1000&options=keyValues`)).json();
  const mitDaten = pa.filter(e => e.totalCount > 0);
  assert(mitDaten.length > 200, `nur ${mitDaten.length} Gemeinden mit Versorgungs-POI`);
  // Struktur: counts je Art vorhanden
  const bsp = mitDaten.find(e => e.counts);
  assert(bsp && typeof bsp.counts === "object", "keine Art-Aufschlüsselung");
};
