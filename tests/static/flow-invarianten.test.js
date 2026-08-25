/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Invarianten der Ingestion-Flows (Sprint 2.9).
   Geprüft wird der GENERATOR und das erzeugte flows.json — beide, weil CI zwar
   auf Gleichstand achtet, ein Regressionsversuch aber in jedem der beiden
   Artefakte beginnen kann. Anlass ist der ParkAPI-Vorfall vom 24.08.2026: eine
   wirkungslose offset-Pagination und aus Freitext gebaute Entitäts-IDs liefen
   einen Monat lang unbemerkt und erzeugten rund die Hälfte aller TRoE-Zeilen. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const GENERATOR = fs.readFileSync(path.join(ROOT, "scripts/generate-nodered-flows.py"), "utf8");
const FLOWS = JSON.parse(fs.readFileSync(path.join(ROOT, "platform/config/nodered/flows.json"), "utf8"));
const FUNCS = FLOWS.filter(n => n.type === "function");

/* Nur Code, keine Kommentarzeilen: Die Kommentare beschreiben absichtlich den
   behobenen Fehler (»vorher &offset=…«) und dürfen die Prüfungen nicht auslösen.
   Zeilen mit URLs bleiben erhalten, weil dort das // nie am Zeilenanfang steht. */
const nurCode = t => t.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");

/* Alle ID-Ausdrücke einsammeln: ab »id: 'urn:ngsi-ld:« bis zum nächsten
   »type:« der Entität — die ID kann sich über mehrere Zeilen erstrecken. */
function idAusdruecke(text) {
  const out = [];
  const re = /id:\s*'urn:ngsi-ld:/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const rest = text.slice(m.index, m.index + 400);
    const ende = rest.indexOf("type:");
    out.push(ende > 0 ? rest.slice(0, ende) : rest);
  }
  return out;
}

exports["Keine Entitäts-ID aus geslugtem Freitext"] = () => {
  // Verboten ist der Aufruf einer Slug-Funktion IM ID-Ausdruck (radSlug(bez) &c.).
  // Erlaubt bleibt der amtliche Gemeinde-Slug aus bw-gemeinden.json, der als
  // Feld (g[8], info.slug) und nicht als Funktionsaufruf in die ID kommt:
  // Er ist stabil und eindeutig, ein Anlagenname ist beides nicht.
  const quellen = [["generate-nodered-flows.py", GENERATOR]]
    .concat(FUNCS.map(n => ["flows.json › " + (n.name || n.id), n.func || ""]));
  for (const [wo, text] of quellen) {
    for (const ausdruck of idAusdruecke(text)) {
      assert(!/[A-Za-z]*[Ss]lug\s*\(/.test(ausdruck),
        `${wo}: Entitäts-ID aus geslugtem Freitext gebaut — gleichnamige Objekte fallen zusammen:\n    ${ausdruck.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
};

exports["Parkanlagen tragen stabile IDs aus dem ParkAPI-Schlüssel"] = () => {
  const bau = FUNCS.find(n => n.id === "udp-rt-bp-build");
  assert(bau, "Build-Node udp-rt-bp-build fehlt");
  assert(/'urn:ngsi-ld:' \+ typ \+ ':parkapi-' \+ a\[0\]/.test(bau.func),
    "ParkingSite/BikeParking werden nicht aus der ParkAPI-eigenen id gebildet");
  // Die AGS gehört bewusst NICHT in die ID: sie ist abgeleitet, eine
  // Neuverortung würde Entität und Zeitreihe verwaisen lassen.
  for (const a of idAusdruecke(bau.func)) {
    assert(!/\bags\b/.test(a) || /ParkingSummary/.test(a),
      `Einzelanlagen-ID enthält die AGS: ${a.replace(/\s+/g, " ").slice(0, 160)}`);
  }
};

exports["ParkAPI paginiert per Cursor, nicht per offset"] = () => {
  // Die ParkAPI v3 ignoriert offset stillschweigend: offset=0/500/…/2500
  // lieferten byteweise identische Antworten. Wer das wieder einbaut, holt
  // erneut 66× dieselben 500 Datensätze.
  const parkapi = FUNCS.filter(n => (n.func || "").includes("park-api"));
  assert(parkapi.length, "kein Function-Node spricht die ParkAPI an");
  for (const n of parkapi) {
    assert(!/offset=/.test(nurCode(n.func)),
      `${n.name || n.id}: ParkAPI-Abruf nutzt wieder offset= — die v3-API ignoriert den Parameter`);
    assert(/start=/.test(n.func),
      `${n.name || n.id}: ParkAPI-Abruf ohne Cursor-Parameter start=`);
  }
  const gen = GENERATOR.slice(GENERATOR.indexOf("FN_PARK_FETCH"), GENERATOR.indexOf("FN_PARK_BUILD"));
  assert(gen.length > 0, "FN_PARK_FETCH nicht im Generator gefunden");
  assert(!/offset=/.test(nurCode(gen)), "Generator baut ParkAPI-Adressen wieder mit offset=");
};

exports["ParkAPI-Abruf prüft Seitenüberschneidung und deckelt die Schleife"] = () => {
  const f = FUNCS.find(n => n.id === "udp-rt-bp-fetch");
  assert(f, "Abruf-Node udp-rt-bp-fetch fehlt");
  assert(/gesehen\.has\(/.test(f.func), "keine Überschneidungsprüfung der Seiten");
  assert(/node\.error\(/.test(f.func), "Überschneidung/Abruffehler bleiben stumm");
  assert(/MAX_SEITEN/.test(f.func) && /node\.warn\(/.test(f.func),
    "kein Seitendeckel mit Warnung — stilles Abschneiden wäre derselbe Fehler in Grün");
  assert.deepStrictEqual((f.libs || []).map(l => l.module).sort(), ["https", "zlib"],
    "https/zlib müssen als libs deklariert sein — im vm-Sandbox des Function-Nodes gibt es kein fetch()");
};

exports["gateChanged: Ersetzen-Modus vorhanden, GBFS-Carsharing merged weiter"] = () => {
  // Ganzbestands-Flows dürfen die Signaturtabelle ersetzen, Teilbestands-Flows
  // (je GBFS-System ein Lauf) müssen mergen — sonst greift dort die
  // Änderungserkennung nie.
  const mitGate = FUNCS.filter(n => /function gateChanged\(/.test(n.func || ""));
  assert(mitGate.length, "gateChanged in keinem Flow enthalten");
  for (const n of mitGate) {
    assert(/opts && opts\.replace/.test(n.func),
      `${n.name || n.id}: gateChanged ohne replace-Option`);
    assert(/ersetzen \? next : Object\.assign\(prev, next\)/.test(n.func),
      `${n.name || n.id}: gateChanged schreibt den Kontext nicht modusabhängig`);
  }
  const cs = FUNCS.find(n => n.id === "udp-rt-cz-fn");
  assert(cs && /Object\.assign\(altStand, neuStand\)/.test(cs.func),
    "Carsharing-Statuslauf merged die Signaturen nicht mehr (läuft je System, darf nicht ersetzen)");
  const park = FUNCS.find(n => n.id === "udp-rt-bp-build");
  assert(/\{ replace: true \}/.test(park.func),
    "Parken-BW nutzt den Ersetzen-Modus nicht — die Signaturtabelle würde unbegrenzt wachsen");
};

exports["TRoE-Statistik kennt das Zeilenbudget aus der Registry"] = () => {
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, "platform/config/connectors.json"), "utf8")).connectors;
  const erwartet = {};
  for (const c of reg) for (const [t, n] of Object.entries(c.rowBudget24h || {})) erwartet[t] = (erwartet[t] || 0) + n;
  const troe = FUNCS.find(n => n.id === "udp-rt-db-fn");
  assert(troe, "TRoE-Statistik-Node fehlt");
  const m = /const BUDGET = (\{[^\n]*\});/.exec(troe.func);
  assert(m, "kein Budget-Objekt im TRoE-Node — Generator und Registry aus dem Tritt?");
  assert.deepStrictEqual(JSON.parse(m[1]), erwartet, "Budget im Flow weicht von der Registry ab");
  assert(/node\.warn\('TRoE-Zeilenbudget/.test(troe.func), "Budgetüberschreitung bleibt stumm");
  // Rückwärtskompatibel: Konnektoren ohne rowBudget24h bleiben unbeanstandet.
  assert(reg.some(c => !c.rowBudget24h), "Testannahme hinfällig: alle Konnektoren tragen ein Budget");
};
