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

/* The 10-minute statistics once counted the whole attributes table.
   The client timeout did not stop the server query, runs piled up and kept
   TimescaleDB at its CPU limit. Guard both halves of the fix. */
exports["TRoE statistics stay cheap: server-side timeout, no full scan, overlap guard"] = () => {
  const troe = FUNCS.find(n => n.id === "udp-rt-db-fn");
  // SQL is written as concatenated string literals – join them first.
  const code = nurCode(troe.func).replace(/"\s*\+\s*"/g, "");
  assert(/statement_timeout:\s*\d+/.test(code), "no server-side statement_timeout in the 10-minute statistics");
  assert(!/count\(DISTINCT/i.test(code), "count(DISTINCT …) in the 10-minute statistics – that is a full scan");
  // Every read of attributes must be restricted to a time window.
  for (const q of code.match(/FROM attributes[^"]*"[^"]*"/g) || []) {
    assert(/WHERE ts >/.test(q), "unbounded query on attributes in the 10-minute statistics: " + q);
  }
  assert(/application_name = 'udp-troe-stats'/.test(code), "overlap guard missing");
  const ret = FUNCS.find(n => n.id === "udp-rt-rt-fn");
  assert(/statement_timeout:\s*\d+/.test(nurCode(ret.func)), "no server-side statement_timeout in the retention run");
  assert(/INSERT INTO udp_troe_type_stats/.test(ret.func), "retention no longer fills the nightly type statistics");
};

/* Municipality assignment. The former helper fell back to the nearest
   municipality centroid, so objects outside Baden-Württemberg (Basel, Alsace,
   Palatinate, Bavaria) were counted in the nearest BW municipality. Only
   inputs guaranteed to lie in BW may still use the centroid fallback. */
const CENTROID_WHITELIST = ["udp-rt-bu-build"];   // UBA stations, pre-selected by DEBW code
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

exports["All function nodes compile"] = () => {
  for (const n of FUNCS) {
    const libs = (n.libs || []).map(l => l.var);
    try {
      new AsyncFunction("msg", "node", "flow", "global", "env", "context", "RED", ...libs, n.func || "");
    } catch (e) {
      assert.fail(`${n.name || n.id}: ${e.message}`);
    }
  }
};

exports["No centroid fallback outside the whitelist"] = () => {
  for (const n of FUNCS) {
    const code = nurCode(n.func || "");
    assert(!/\bnearest\s*\(/.test(code), `${n.name || n.id}: uses the removed nearest() with centroid fallback`);
    if (CENTROID_WHITELIST.includes(n.id)) continue;
    assert(!/nearestOrCentroid/.test(code), `${n.name || n.id}: centroid fallback outside the whitelist`);
    assert(!/dy \* dy \+ dx \* dx/.test(code), `${n.name || n.id}: own nearest-centroid search`);
  }
  assert(!/g\[0\]\.slice\(0, 2\) !== '08'/.test(GENERATOR),
    "an '08' check after the lookup suggests a centroid fallback again");
};

/* Load the strict lookup from a generated node and evaluate it against the
   real boundary file. */
function strictLookup() {
  const n = FUNCS.find(x => x.id === "udp-rt-bg-fn");
  assert(n, "GBFS node udp-rt-bg-fn missing");
  const start = n.func.indexOf("const pip = (lat, lon, rings)");
  const end = n.func.indexOf("const nearestStrict");
  assert(start >= 0 && end > start, "strict lookup not found in udp-rt-bg-fn");
  const grz = JSON.parse(fs.readFileSync(path.join(ROOT, "gui/public/bw-grenzen.json"), "utf8"));
  return new Function("GRZ", n.func.slice(start, end) + "\nreturn agsStrict;")(grz);
}

exports["Strict lookup: Stuttgart yes, Basel/Strasbourg/Kaiserslautern no"] = () => {
  const agsStrict = strictLookup();
  assert.strictEqual(agsStrict(48.7758, 9.1829), "08111000", "Stuttgart city centre");
  assert.strictEqual(agsStrict(47.5596, 7.5886), null, "Basel");
  assert.strictEqual(agsStrict(48.5734, 7.7521), null, "Strasbourg");
  assert.strictEqual(agsStrict(49.4447, 7.7690), null, "Kaiserslautern");
  assert.strictEqual(agsStrict(NaN, 9.18), null, "invalid coordinates");
  // Sanity of the boundary file: nearly every municipal centroid lies in its own polygon.
  const gem = JSON.parse(fs.readFileSync(path.join(ROOT, "gui/public/bw-gemeinden.json"), "utf8")).gemeinden;
  const hits = gem.filter(r => agsStrict(r[2], r[3]) === r[0]).length;
  assert(hits / gem.length > 0.95, `only ${hits} of ${gem.length} municipal centroids found in their own polygon`);
};

exports["Node-RED reaches the cockpit on its container port"] = () => {
  const raw = fs.readFileSync(path.join(ROOT, "platform/config/nodered/flows.json"), "utf8");
  for (const [wo, text] of [["flows.json", raw], ["generate-nodered-flows.py", GENERATOR]]) {
    assert(!/http:\/\/cockpit(:80)?\//.test(text),
      `${wo}: http://cockpit/ without port 8080 — nginx-unprivileged listens on 8080 only (Compose)`);
  }
  assert(/http:\/\/cockpit:8080\//.test(raw), "no cockpit:8080 URL in flows.json");
  const apps = fs.readFileSync(path.join(ROOT, "helm/udp/templates/apps.yaml"), "utf8");
  const svc = apps.slice(apps.lastIndexOf("kind: Service"));
  assert(/name: cockpit/.test(svc) && /port: 8080, targetPort: 8080/.test(svc),
    "Helm Service cockpit does not expose port 8080");
};

exports["Prune steps carry their safety guards"] = () => {
  const withPrune = FUNCS.filter(n => /pruneStale\(\{/.test(n.func || ""));
  assert(withPrune.length >= 5, `only ${withPrune.length} connectors prune`);
  for (const n of withPrune) {
    const code = n.func;
    const wo = n.name || n.id;
    assert((n.libs || []).some(l => l.var === "http" && l.module === "http"), `${wo}: http not declared in libs`);
    // Helper guards
    assert(/!re\.test\(e\.id\)\) continue;/.test(code), `${wo}: prune does not re-check the id pattern`);
    assert(/cand\.length > limit/.test(code) && /mine \* frac/.test(code), `${wo}: prune without share limit`);
    assert(/listing incomplete/.test(code), `${wo}: prune does not check listing completeness`);
    // Call sites: anchored pattern; own ids or age-only liveness; grace or confirmation
    const calls = code.split("pruneStale({").slice(1).map(c => c.slice(0, c.indexOf("})")));
    for (const c of calls) {
      const m = /pattern: '([^']+)'/.exec(c);
      assert(m, `${wo}: prune call without literal pattern`);
      assert(m[1].startsWith("^urn:ngsi-ld:") && m[1].endsWith("$"), `${wo}: prune pattern not anchored: ${m[1]}`);
      assert(!/\.\*/.test(m[1]), `${wo}: prune pattern with .* is too broad: ${m[1]}`);
      assert(/keep:/.test(c) || /liveMs:/.test(c), `${wo}: prune call neither with keep nor with liveMs`);
      assert(/graceMs:/.test(c) || /confirmKey:/.test(c), `${wo}: prune call without grace period or confirmation`);
    }
    if (/keep:/.test(code)) {
      assert(/if \(!GRZ_OK\)/.test(code) || /GRZ_OK &&/.test(code), `${wo}: prune without boundary guard`);
    }
  }
  const park = FUNCS.find(n => n.id === "udp-rt-bp-build");
  assert(/if \(msg\.parkVollstaendig && GRZ_OK && ids\.size\)/.test(park.func),
    "Parken-BW prunes without completeness guard");
};

exports["Roadworks: strict lookup and coordinate check"] = () => {
  const rw = FUNCS.find(n => n.id === "udp-rt-br-fn");
  assert(/nearestStrict\(p\[1\], p\[0\]\)/.test(rw.func), "roadworks not assigned by the strict lookup");
  assert(/p = \[p\[1\], p\[0\]\]; getauscht\+\+/.test(rw.func), "roadworks without swapped-coordinate repair");
};
