/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Live-Regression gegen die MobiData-BW-ParkAPI (öffentlich, ohne Schlüssel).
   Sichert die Annahme ab, auf der der Konnektor parken-bw seit Sprint 2.9
   aufbaut: Die v3-API paginiert über einen Cursor (start=<next_id>) und liefert
   dabei überschneidungsfreie Seiten. Vorher lief die Aufteilung über &offset=,
   das die API stillschweigend ignoriert — alle 66 Anfragen brachten dieselben
   ersten 500 Datensätze zurück.

   Netzfehler (kein Internet im Prüflauf) führen wie bei den übrigen Live-Tests
   nicht zum Fehlschlag; ein HTTP-Fehler oder ein falsches Antwortformat schon. */
"use strict";
const assert = require("assert");

const BASIS = process.env.PARKAPI_URL ||
  "https://api.mobidata-bw.de/park-api/api/public/v3/parking-sites";
const PRO_SEITE = 200;

async function seite(start) {
  const url = BASIS + "?limit=" + PRO_SEITE + (start == null ? "" : "&start=" + start);
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  assert.strictEqual(r.status, 200, url + " → HTTP " + r.status);
  const d = await r.json();
  assert(Array.isArray(d.items), url + ": Antwort ohne items-Array");
  return d;
}

// Netzausfall vom Testfehler trennen: fetch wirft, HTTP-/Formatfehler assert’en.
function netzfehler(e) {
  return e instanceof TypeError || /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timed out|aborted/i.test(String(e && e.message));
}

exports["ParkAPI: zwei aufeinanderfolgende Cursor-Seiten überschneiden sich nicht"] = async () => {
  let eins, zwei;
  try {
    eins = await seite(null);
  } catch (e) {
    if (netzfehler(e)) return console.log("    (übersprungen: ParkAPI nicht erreichbar)");
    throw e;
  }
  assert(eins.items.length > 0, "erste Seite leer");
  assert(typeof eins.total_count === "number" && eins.total_count > eins.items.length,
    "total_count fehlt oder ist nicht größer als eine Seite — Testannahme prüfen");
  assert(eins.next_id != null, "erste Seite ohne next_id — die API paginiert nicht mehr per Cursor");

  try {
    zwei = await seite(eins.next_id);
  } catch (e) {
    if (netzfehler(e)) return console.log("    (übersprungen: ParkAPI nicht erreichbar)");
    throw e;
  }
  assert(zwei.items.length > 0, "zweite Seite leer");

  const a = new Set(eins.items.map(i => i.id));
  const b = new Set(zwei.items.map(i => i.id));
  const doppelt = [...b].filter(id => a.has(id));
  assert.strictEqual(doppelt.length, 0,
    `Cursor-Seiten überschneiden sich in ${doppelt.length} von ${b.size} Datensätzen — greift start= nicht mehr?`);
  assert(Math.max(...b) > Math.max(...a), "zweite Seite läuft nicht vorwärts");
};

exports["ParkAPI: offset= wird ignoriert (Grund für die Cursor-Pagination)"] = async () => {
  // Dokumentiert den ursprünglichen Fehler und schlägt an, sobald die API
  // offset doch unterstützt — dann wäre die Umstellung erklärungsbedürftig.
  let ohne, mit;
  try {
    ohne = await seite(null);
    const r = await fetch(BASIS + "?limit=" + PRO_SEITE + "&offset=" + (PRO_SEITE * 3),
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    assert.strictEqual(r.status, 200, "offset-Anfrage → HTTP " + r.status);
    mit = await r.json();
  } catch (e) {
    if (netzfehler(e)) return console.log("    (übersprungen: ParkAPI nicht erreichbar)");
    throw e;
  }
  const a = ohne.items.map(i => i.id).join(",");
  const b = (mit.items || []).map(i => i.id).join(",");
  if (a !== b) {
    console.log("    HINWEIS: ParkAPI wertet offset= inzwischen aus — Kommentare in " +
      "scripts/generate-nodered-flows.py (FN_PARK_FETCH) prüfen.");
  }
};

exports["ParkAPI: die Felder, auf denen der Konnektor aufbaut, sind vollständig"] = async () => {
  let d;
  try {
    d = await seite(null);
  } catch (e) {
    if (netzfehler(e)) return console.log("    (übersprungen: ParkAPI nicht erreichbar)");
    throw e;
  }
  const n = d.items.length;
  const da = f => d.items.filter(i => i[f] !== undefined && i[f] !== null).length;
  for (const f of ["id", "lat", "lon", "capacity", "purpose", "has_realtime_data",
                   "official_region_code", "source_id", "original_uid", "modified_at"]) {
    assert.strictEqual(da(f), n, `Feld ${f} nur in ${da(f)} von ${n} Datensätzen`);
  }
  // ARS -> AGS: 12 Stellen, davon 0..5 und 9..12 (gegen bw-gemeinden.json geprüft)
  const ars = d.items.map(i => String(i.official_region_code));
  assert(ars.every(s => /^[0-9]{12}$/.test(s)), "official_region_code ist kein 12-stelliger ARS mehr");
};
