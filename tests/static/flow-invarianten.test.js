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
    assert(/const table = ersetzen \? \{\} : prev;/.test(n.func),
      `${n.name || n.id}: gateChanged schreibt den Kontext nicht modusabhängig`);
  }
  const cs = FUNCS.find(n => n.id === "udp-rt-cz-fn");
  assert(cs && /gateChanged\(node, stations, 'csSig', [^\n]*\n\s*\{ freshEvery: 3, periodMs: 3600e3 \}\)/.test(cs.func),
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
      assert(/graceMs:/.test(c) || (/confirmKey:/.test(c) && /confirmMs: 24 \* 3600e3/.test(c)),
        `${wo}: prune call without grace period or 24 h confirmation`);
      assert(/intervalMs: [0-9]+/.test(c), `${wo}: prune call without interval check`);
    }
    // Master data plausibility: every prune call is guarded by PRUNE_OK, which
    // checks the municipality count and the boundary coverage by key.
    assert(/PRUNE_OK &&|&& PRUNE_OK\) \{|if \(PRUNE_OK\) pruneStale|if \(PRUNE_OK\) \(async/.test(code), `${wo}: prune without PRUNE_OK guard`);
    assert(/GEM\.length < 1000 \|\| GEM\.length < prev \* 0\.95/.test(code), `${wo}: no municipality count floor`);
    assert(/covered >= GEM\.length \* 0\.99/.test(code), `${wo}: boundary coverage not checked by key`);
  }
  const park = FUNCS.find(n => n.id === "udp-rt-bp-build");
  assert(/if \(msg\.parkVollstaendig && PRUNE_OK && ids\.size\)/.test(park.func),
    "Parken-BW prunes without completeness guard");
  assert(/else \{[^}]*parkPruneSite[^}]*flow\.set\(k, \{\}\)/.test(park.func),
    "Parken-BW keeps its prune candidates across an incomplete run");
  const sc = FUNCS.find(n => n.id === "udp-rt-bs-fn");
  assert(/if \(detailLauf && PRUNE_OK\)/.test(sc.func), "sensor.community prune not tied to the detail run");
};

/* Behaviour of pruneStale() against a mocked broker and clock. */
function loadPrune() {
  const n = FUNCS.find(x => x.id === "udp-rt-bp-build");
  const start = n.func.indexOf("async function pruneStale(o) {");
  const endMark = "    return deletedIds.length;\n}";
  const end = n.func.indexOf(endMark, start);
  assert(start >= 0 && end > start, "pruneStale not found");
  const code = n.func.slice(start, end + endMark.length);
  return env => new Function("http", "flow", "node", "Date", code + "\nreturn pruneStale;")(
    env.http, env.flow, env.node, env.Date);
}

function pruneEnv(entities) {
  const ctx = {}, log = [], deleted = [];
  const env = {
    clock: Date.parse("2026-01-10T12:00:00Z"),
    listStatus: 200,
    deleteResponse: ids => ({ status: 204, text: "" }),
    ctx, log, deleted
  };
  env.Date = { now: () => env.clock, parse: s => Date.parse(s) };
  env.flow = { get: k => ctx[k], set: (k, v) => { ctx[k] = v; } };
  env.node = { warn: m => log.push("warn " + m), log: m => log.push("log " + m), status() {} };
  env.http = {
    request(url, opts, cb) {
      const u = new URL(url);
      let body = "";
      return {
        on() {}, setTimeout() {}, write(d) { body += d; },
        end() {
          let r;
          if (opts.method === "GET") {
            const off = +u.searchParams.get("offset");
            const page = entities.slice(off, off + 1000);
            r = { status: env.listStatus, text: JSON.stringify(page), headers: { "ngsild-results-count": String(entities.length) } };
          } else {
            const ids = JSON.parse(body);
            r = Object.assign({ headers: {} }, env.deleteResponse(ids));
            if (r.status === 204) deleted.push(...ids);
          }
          const h = {};
          cb({ statusCode: r.status, headers: r.headers || {}, on(ev, f) { h[ev] = f; } });
          if (r.text) h.data(Buffer.from(r.text));
          h.end();
        }
      };
    }
  };
  return env;
}

const ents = n => Array.from({ length: n }, (_, i) =>
  ({ id: "urn:ngsi-ld:ParkingSite:parkapi-" + i, type: "ParkingSite", modifiedAt: "2025-01-01T00:00:00Z" }));
const H = 3600e3;
const parkOpts = keep => ({ label: "t", type: "ParkingSite", pattern: "^urn:ngsi-ld:ParkingSite:parkapi-[^:]+$",
  keep: keep, confirmKey: "c", confirmMs: 24 * H, intervalMs: 3 * H });

exports["pruneStale: confirmation needs 24 h of consecutive runs"] = async () => {
  const all = ents(20);
  const env = pruneEnv(all);
  const prune = loadPrune()(env);
  const keep = new Set(all.slice(1).map(e => e.id));   // parkapi-0 is gone from the source
  env.ctx["pruneLastRun_t"] = env.clock - 3 * H;
  for (let run = 0; run < 8; run++) {                   // 8 runs à 3 h = 21 h
    assert.strictEqual(await prune(parkOpts(keep)), 0, `deleted already after ${run * 3} h`);
    env.clock += 3 * H;
  }
  env.clock += 3 * H;                                   // 27 h after first sighting
  assert.strictEqual(await prune(parkOpts(keep)), 1);
  assert.deepStrictEqual(env.deleted, ["urn:ngsi-ld:ParkingSite:parkapi-0"]);
};

exports["pruneStale: a skipped run resets the confirmation"] = async () => {
  const all = ents(20);
  const env = pruneEnv(all);
  const prune = loadPrune()(env);
  const keep = new Set(all.slice(1).map(e => e.id));
  env.ctx["pruneLastRun_t"] = env.clock - 3 * H;
  await prune(parkOpts(keep));                          // first sighting
  env.clock += 3 * H; env.listStatus = 500;
  await prune(parkOpts(keep));                          // broker error -> candidates cleared
  env.listStatus = 200;
  env.clock += 25 * H;                                  // long gap -> interval check skips too
  assert.strictEqual(await prune(parkOpts(keep)), 0);
  env.clock += 3 * H;
  assert.strictEqual(await prune(parkOpts(keep)), 0, "deleted although only seen once since the reset");
  assert(env.log.some(l => /listing HTTP 500/.test(l)), "broker error not logged");
  assert.deepStrictEqual(env.deleted, []);
};

exports["pruneStale: first run and share limit skip"] = async () => {
  const all = ents(20);
  const env = pruneEnv(all);
  const prune = loadPrune()(env);
  const opts = { label: "g", type: "ParkingSite", pattern: "^urn:ngsi-ld:ParkingSite:parkapi-[^:]+$",
    keep: new Set(all.slice(10).map(e => e.id)), graceMs: 24 * H, intervalMs: H };
  assert.strictEqual(await prune(opts), 0, "first run without a previous timestamp must not delete");
  env.clock += H;
  assert.strictEqual(await prune(opts), 0, "50 % deletion passed the share limit");
  assert(env.log.some(l => /would be deleted \(limit 6\)/.test(l)));
  assert.deepStrictEqual(env.deleted, []);
};

exports["pruneStale: 207 counts only confirmed deletions"] = async () => {
  const all = ents(20);
  const env = pruneEnv(all);
  const prune = loadPrune()(env);
  env.deleteResponse = ids => ({ status: 207, text: JSON.stringify({
    success: [ids[0]], errors: ids.slice(1).map(id => ({ entityId: id, error: { status: 500 } })) }) });
  env.ctx.sig = { "urn:ngsi-ld:ParkingSite:parkapi-0": "a", "urn:ngsi-ld:ParkingSite:parkapi-1": "b" };
  env.ctx["pruneLastRun_g"] = env.clock - H;
  const opts = { label: "g", type: "ParkingSite", pattern: "^urn:ngsi-ld:ParkingSite:parkapi-[^:]+$",
    keep: new Set(all.slice(2).map(e => e.id)), graceMs: 24 * H, intervalMs: H, sigKey: "sig" };
  assert.strictEqual(await prune(opts), 1);
  assert.deepStrictEqual(Object.keys(env.ctx.sig), ["urn:ngsi-ld:ParkingSite:parkapi-1"],
    "signature of a failed deletion was dropped");
};

exports["Roadworks: strict lookup and coordinate check"] = () => {
  const rw = FUNCS.find(n => n.id === "udp-rt-br-fn");
  assert(/nearestStrict\(p\[1\], p\[0\]\)/.test(rw.func), "roadworks not assigned by the strict lookup");
  assert(/p = \[p\[1\], p\[0\]\]; getauscht\+\+/.test(rw.func), "roadworks without swapped-coordinate repair");
  assert(/ungueltig > nFeatures \* 0\.05/.test(rw.func), "no warning on many invalid coordinates");
  assert(!FLOWS.some(n => n.id === "udp-rt-br-get"), "roadworks still fetch bw-gemeinden.json");
};

/* ---------------------------------------------------------------------------
   Data freshness (phase 2). Harness: run a generated function node with
   mocked context, node and http, as Node-RED would. */
const GEM_ROWS = JSON.parse(fs.readFileSync(path.join(ROOT, "gui/public/bw-gemeinden.json"), "utf8")).gemeinden;
const GRZ_ALL = JSON.parse(fs.readFileSync(path.join(ROOT, "gui/public/bw-grenzen.json"), "utf8"));

function nodeEnv(opts = {}) {
  const env = { flowCtx: opts.flowCtx || {}, nodeCtx: {}, log: [], http: opts.http || null,
    globalCtx: Object.assign({ bwGemeinden: GEM_ROWS, bwGrenzen: GRZ_ALL }, opts.global || {}) };
  env.flow = { get: k => env.flowCtx[k], set: (k, v) => { if (v === undefined) delete env.flowCtx[k]; else env.flowCtx[k] = v; } };
  env.global = { get: k => env.globalCtx[k], set: (k, v) => { env.globalCtx[k] = v; } };
  env.context = { get: k => env.nodeCtx[k], set: (k, v) => { env.nodeCtx[k] = v; } };
  env.node = { warn: m => env.log.push("warn " + m), log: m => env.log.push("log " + m),
               error: m => env.log.push("error " + m), status() {} };
  return env;
}
function runNode(id, msg, env) {
  const n = FLOWS.find(x => x.id === id);
  assert(n, "node " + id + " missing");
  const libs = n.libs || [];
  const fn = new AsyncFunction("msg", "node", "flow", "global", "env", "context", "RED", ...libs.map(l => l.var), n.func);
  return fn(msg, env.node, env.flow, env.global, { get: () => undefined }, env.context, {},
            ...libs.map(l => l.var === "http" ? env.http : require(l.module)));
}
// Output of a node as a list of messages (single message or [array] on output 1)
const outMsgs = r => r == null ? [] : Array.isArray(r) ? (Array.isArray(r[0]) ? r[0] : [r[0]]).filter(Boolean) : [r];
const tick = () => new Promise(r => setImmediate(r));
const commitMsg = (m, status, body) => Object.assign({}, m, { statusCode: status, payload: body === undefined ? "" : body });

/* Every node that gates on change signatures must hand them to a commit node
   behind its upsert – otherwise a failed write marks values as sent. */
exports["Change signatures are committed only behind the upsert"] = () => {
  const byId = Object.fromEntries(FLOWS.map(n => [n.id, n]));
  const users = FUNCS.filter(n => /gateChanged\(node, \w+, '|sigPending\('|msg\.sigCommit = /.test(nurCode(n.func || "")));
  assert(users.length >= 11, `only ${users.length} nodes use change signatures`);
  for (const n of users) {
    let cur = n, hops = 0;
    do { cur = byId[cur.wires[0][0]]; hops++; } while (cur && cur.type === "delay" && hops < 5);
    assert(cur && cur.type === "http request" && /entityOperations\/upsert/.test(cur.url),
      `${n.name || n.id}: output does not lead to an upsert`);
    const commit = byId[cur.wires[0][0]];
    assert(commit && commit.type === "function" && /const sc = msg\.sigCommit;/.test(commit.func),
      `${n.name || n.id}: upsert without signature commit node`);
    assert(/st === 207/.test(commit.func) && /st >= 200 && st < 300/.test(commit.func),
      `${commit.id}: commit does not check the broker status per entity`);
  }
  for (const n of FUNCS) {
    const code = nurCode(n.func || "");
    assert(!/next\[e\.id\] = s;/.test(code), `${n.name || n.id}: gateChanged stores signatures before the write`);
    assert(!/flow\.set\('(csStand|ocSignatur)', (Object\.assign|neu)/.test(code), `${n.name || n.id}: signatures stored before the write`);
  }
};

function pegelStations(n, level) {
  return Array.from({ length: n }, (_, i) => ({
    latitude: 48.7758, longitude: 9.1829, number: String(i + 1), shortname: "P" + (i + 1), water: { shortname: "NECKAR" },
    timeseries: [{ shortname: "W", unit: "cm", currentMeasurement: { value: typeof level === "function" ? level(i) : level, stateMnwMhw: "normal" } }]
  }));
}

exports["Signatures: failed upsert resends, confirmed upsert gates, 207 per entity, per chunk"] = async () => {
  const env = nodeEnv();
  const run = async stations => outMsgs(await runNode("udp-rt-pe-fn", { statusCode: 200, payload: stations }, env));
  const commit = async (msgs, status, body) => { for (const m of msgs) await runNode("udp-rt-pe-commit", commitMsg(m, status, body), env); };
  // 60 stations -> two chunks of 50 and 10
  let msgs = await run(pegelStations(60, 100));
  assert.strictEqual(msgs.length, 2);
  assert(msgs.every(m => Array.isArray(m.sigCommit) && m.sigCommit.length === m.payload.length));
  await commit(msgs, "ECONNREFUSED");                                   // Orion down
  assert.deepStrictEqual(env.flowCtx.pegelSig, {}, "signatures stored although the upsert failed");
  assert(env.log.some(l => /Upsert not confirmed \(ECONNREFUSED\)/.test(l)));
  msgs = await run(pegelStations(60, 100));
  assert(msgs.every(m => m.payload.every(e => e.level)), "values not resent after a failed upsert");
  // first chunk times out, second is confirmed
  await runNode("udp-rt-pe-commit", commitMsg(msgs[0], "ETIMEDOUT"), env);
  await runNode("udp-rt-pe-commit", commitMsg(msgs[1], 204), env);
  assert.strictEqual(Object.keys(env.flowCtx.pegelSig).length, 10);
  msgs = await run(pegelStations(60, 100));
  assert.strictEqual(msgs.flatMap(m => m.payload).filter(e => e.level).length, 50,
    "entities of the failed chunk not resent, or confirmed ones resent");
  await commit(msgs, 204);
  msgs = await run(pegelStations(60, 100));
  assert(msgs.flatMap(m => m.payload).every(e => !e.level && e.dateObserved), "unchanged values written again");
  // 207: station 1 fails, station 2 succeeds
  msgs = await run(pegelStations(60, i => i < 2 ? 200 : 100));
  const ids = msgs.flatMap(m => m.payload).filter(e => e.level).map(e => e.id);
  assert.deepStrictEqual(ids, ["urn:ngsi-ld:WaterLevelObserved:bw-pegel-1", "urn:ngsi-ld:WaterLevelObserved:bw-pegel-2"]);
  await commit(msgs, 207, JSON.stringify({ success: [ids[1]], errors: [{ entityId: ids[0], error: { status: 400 } }] }));
  msgs = await run(pegelStations(60, i => i < 2 ? 200 : 100));
  assert.deepStrictEqual(msgs.flatMap(m => m.payload).filter(e => e.level).map(e => e.id), [ids[0]],
    "207: failed entity not resent, or confirmed one resent");
};

exports["GBFS: vanished municipalities get a confirmed zero, empty feeds do not"] = async () => {
  const env = nodeEnv();
  const S = [48.7758, 9.1829], R = [48.49388, 9.18829];
  const run = async pts => outMsgs(await runNode("udp-rt-bg-fn", { statusCode: 200, system: "testsys",
    payload: { data: { bikes: pts.map(p => ({ lat: p[0], lon: p[1] })) } } }, env))[0];
  const counts = m => m ? Object.fromEntries(m.payload.map(e => [e.ags.value, e.availableVehicles.value])) : {};
  let m = await run([S, S, R]);
  assert.deepStrictEqual(counts(m), { "08111000": 2, "08415061": 1 });
  await runNode("udp-rt-bg-commit", commitMsg(m, 201), env);
  m = await run([S]);
  assert.deepStrictEqual(counts(m), { "08111000": 1, "08415061": 0 }, "no zero for the vanished municipality");
  const zero = m.payload.find(e => e.ags.value === "08415061");
  assert.deepStrictEqual(zero.vehiclePositions.value, [], "old positions of the zeroed summary survive");
  await runNode("udp-rt-bg-commit", commitMsg(m, 204), env);
  assert.deepStrictEqual(env.flowCtx["ffLast:testsys"], { "08111000": 1 });
  m = await run([S]);
  assert.deepStrictEqual(counts(m), { "08111000": 1 }, "zero written again after it was confirmed");
  assert.strictEqual(await runNode("udp-rt-bg-fn", { statusCode: 200, system: "testsys", payload: { data: { bikes: [] } } }, env), null,
    "an empty feed zeroes every municipality");
  m = await run([R]);
  assert.deepStrictEqual(counts(m), { "08415061": 1, "08111000": 0 });
  await runNode("udp-rt-bg-commit", commitMsg(m, 500), env);
  m = await run([R]);
  assert.deepStrictEqual(counts(m), { "08415061": 1, "08111000": 0 }, "failed zero write not repeated");
};

exports["Parking: realtime sites refresh dateObserved, static sites stay silent"] = async () => {
  const env = nodeEnv();
  // 0 id · 1 lat · 2 lon · 3 capacity · 4 purpose · 5 name · 6 ARS · 7 source · 8 uid · 9 modified · 10 realtime · 11 free
  const site = (id, rt, frei) => [id, 48.7758, 9.1829, 50, "CAR", "Anlage " + id, "081110000000", 1, "u" + id, "", rt, frei];
  const run = async anlagen => outMsgs(await runNode("udp-rt-bp-build", { payload: anlagen, parkVollstaendig: false }, env));
  let msgs = await run([site(1, true, 5), site(2, false, -1)]);
  assert.strictEqual(msgs.flatMap(m => m.payload).filter(e => e.name).length, 2, "first sighting not written in full");
  assert(msgs[0].sigCommit.some(p => p[0] === "parkStatik") && msgs[0].sigCommit.some(p => p[0] === "parkFrei"));
  for (const m of msgs) await runNode("udp-rt-bp-commit", commitMsg(m, 201), env);
  msgs = await run([site(1, true, 5), site(2, false, -1)]);
  const byId = Object.fromEntries(msgs.flatMap(m => m.payload).map(e => [e.id, e]));
  const s1 = byId["urn:ngsi-ld:ParkingSite:parkapi-1"];
  assert(s1 && s1.dateObserved && !s1.availableSpotNumber && !s1.name, "realtime site: freshness-only write expected");
  assert(!byId["urn:ngsi-ld:ParkingSite:parkapi-2"], "static site refreshed");
  const sum = byId["urn:ngsi-ld:ParkingSummary:bw-08111000"];
  assert(sum && sum.dateObserved && !sum.realtimeFree, "realtime sum: freshness-only write expected");
  msgs = await run([site(1, true, 6), site(2, false, -1)]);
  const s1b = msgs.flatMap(m => m.payload).find(e => e.id === "urn:ngsi-ld:ParkingSite:parkapi-1");
  assert(s1b.availableSpotNumber.value === 6 && s1b.dateObserved && !s1b.name, "occupancy change without freshness");
};

exports["Parking legacy ids: guarded one-off cleanup"] = async () => {
  const park = FUNCS.find(n => n.id === "udp-rt-bp-build").func;
  const guard = park.indexOf("if (msg.parkVollstaendig && PRUNE_OK && ids.size)");
  const legacy = park.indexOf("label: 'Parken-BW legacy ParkingSite'");
  assert(guard > 0 && legacy > guard && legacy < park.indexOf("// Incomplete run"), "legacy cleanup outside the completeness guard");
  for (const t of ["ParkingSite", "BikeParking"]) {
    const call = park.slice(park.indexOf("label: 'Parken-BW legacy " + t + "'"));
    const c = call.slice(0, call.indexOf("})"));
    assert(c.includes(`exclude: '^urn:ngsi-ld:${t}:parkapi-'`) && /accept: legacyParkApi/.test(c) && /attrs: 'ags,dataProvider'/.test(c), `${t}: legacy prune without exclude/accept`);
    assert(/graceMs: 7 \* 24 \* 3600e3/.test(c) && /intervalMs: 86400000/.test(c), `${t}: legacy prune without 7-day grace / daily interval`);
  }
  // Nobody else writes ParkingSite/BikeParking ids, the build only parkapi-<id>
  for (const n of FUNCS) {
    if (n.id === "udp-rt-bp-build") continue;
    assert(!/urn:ngsi-ld:(ParkingSite|BikeParking):'/.test(n.func || ""), `${n.name || n.id}: writes parking ids`);
    for (const a of idAusdruecke(n.func || "")) assert(!/ParkingSite|BikeParking/.test(a), `${n.name || n.id}: writes parking ids`);
  }
  // Behaviour against a mocked broker
  const m = /const SLUGS = [\s\S]*?\n\s*const legacyParkApi = [^\n]*/.exec(park);
  assert(m, "legacyParkApi not found");
  const accept = new Function("GEM", "ANBIETER", m[0] + "\nreturn legacyParkApi;")(GEM_ROWS, "MobiData BW ParkAPI");
  const dp = { dataProvider: { type: "Property", value: "MobiData BW ParkAPI" } };
  const P = "urn:ngsi-ld:ParkingSite:";
  const list = ents(20).map(e => Object.assign(e, { modifiedAt: "2026-01-10T00:00:00Z" }))
    .concat([{ id: P + "stuttgart-hauptbahnhof", modifiedAt: "2025-12-01T00:00:00Z", ...dp },
             { id: P + "reutlingen-48.49388-9.18829", modifiedAt: "2025-12-01T00:00:00Z", ...dp },
             { id: P + "nirgendwo-parkplatz", modifiedAt: "2025-12-01T00:00:00Z", ...dp },
             { id: P + "stuttgart-neu", modifiedAt: "2026-01-09T12:00:00Z", ...dp },
             { id: P + "stuttgart-ohne-zeit", ...dp },
             // a municipal connector with the documented slug-prefixed ids
             { id: P + "stuttgart-br-hbf", modifiedAt: "2025-12-01T00:00:00Z",
               dataProvider: { type: "Property", value: "Stadt Stuttgart" } }]);
  const env = pruneEnv(list);
  const prune = loadPrune()(env);
  const opts = { label: "Parken-BW legacy ParkingSite", type: "ParkingSite", pattern: "^urn:ngsi-ld:ParkingSite:[a-z0-9][a-z0-9.-]*$",
    exclude: "^urn:ngsi-ld:ParkingSite:parkapi-", accept, keep: new Set(), graceMs: 7 * 24 * H, maxFraction: 1, intervalMs: 24 * H };
  assert.strictEqual(await prune(opts), 0, "first daily check must not delete");
  env.clock += 24 * H;
  assert.strictEqual(await prune(opts), 2);
  assert.deepStrictEqual(env.deleted.sort(), [P + "reutlingen-48.49388-9.18829", P + "stuttgart-hauptbahnhof"]);
};

exports["OCPDB: all pages from total_count, capped, completeness before prune"] = async () => {
  let env = nodeEnv();
  let msgs = outMsgs(await runNode("udp-rt-bo-msgs", { statusCode: 200, payload: { total_count: 31462 }, _msgid: "x" }, env));
  assert.strictEqual(msgs.length, 32, "not all pages requested");
  assert(/offset=31000$/.test(msgs[31].url) && msgs.every(m => m.parts.count === 32 && m.ocSeiten === 32));
  msgs = outMsgs(await runNode("udp-rt-bo-msgs", { statusCode: 200, payload: { total_count: 99000 }, _msgid: "x" }, env));
  assert.strictEqual(msgs.length, 60);
  assert(env.log.some(l => /capped at 60/.test(l)), "page cap without warning");
  assert.strictEqual(await runNode("udp-rt-bo-msgs", { statusCode: 503, payload: "" }, env), null);
  assert(!/OC_SEITEN\s*=/.test(GENERATOR), "fixed OCPDB page count is back");
  // Build: complete vs. incomplete
  const row = (id, live) => [id, 48.7758, 9.1829, 2, live, live, 0, "Lader " + id, "Op", "Addr", 0];
  const part = (ok, rows) => ({ ok, items: ok ? 1000 : 0, seiten: 2, gesamt: 2000, rows });
  env = nodeEnv();
  let out = outMsgs(await runNode("udp-rt-bo-build", { payload: [part(true, [row("1", 2)]), part(false, [])] }, env));
  await tick();
  assert(env.log.some(l => /incomplete run/.test(l)) && !env.flowCtx.pruneLastRun_OCPDB_EVChargingStation, "incomplete run pruned");
  const st = out.flatMap(m => m.payload).find(e => e.type === "EVChargingStation");
  assert(st && st.dateObserved && st.id === "urn:ngsi-ld:EVChargingStation:stuttgart-ocpdb-1");
  env = nodeEnv();
  out = outMsgs(await runNode("udp-rt-bo-build", { payload: [part(true, [row("1", 2), row("2", 0)]), part(true, [])] }, env));
  await tick(); await tick();
  assert(env.flowCtx.pruneLastRun_OCPDB_EVChargingStation && env.flowCtx.pruneLastRun_OCPDB_ChargingSummary, "complete run did not prune");
  const reg = out.flatMap(m => m.payload).find(e => e.id.endsWith("-ocpdb-2"));
  assert(reg && !reg.dateObserved, "register entry without live status got dateObserved");
};

/* Mocked Orion for the pulse queries: type -> entity list, paginated. */
function pulseHttp(data, fail) {
  return {
    get(url, opts, cb) {
      const u = new URL(url);
      const type = u.searchParams.get("type"), off = +u.searchParams.get("offset"), lim = +u.searchParams.get("limit");
      const list = data[type] || [];
      const r = fail === type ? { status: 500, text: "{}" } : { status: 200, text: JSON.stringify(list.slice(off, off + lim)) };
      const h = {};
      cb({ statusCode: r.status, headers: { "ngsild-results-count": String(list.length) }, on(ev, f) { h[ev] = f; } });
      h.data(Buffer.from(r.text)); h.end();
      return { on() {}, setTimeout() {} };
    },
    request() { throw new Error("no prune expected in this test"); }
  };
}

exports["CityPulse: honest minimum, roadworks coverage, normalized sharing, stale dust, pagination"] = async () => {
  const now = new Date().toISOString(), old = new Date(Date.now() - 3 * 3600e3).toISOString();
  const later = GEM_ROWS[1050][0];
  const data = {
    AirQualityObserved: [
      { id: "urn:ngsi-ld:AirQualityObserved:bw-sc-08111000", ags: "08111000", pm25: 10, dateObserved: now },
      { id: "urn:ngsi-ld:AirQualityObserved:bw-sc-08415061", ags: "08415061", pm25: 5, dateObserved: old },
      { id: "urn:ngsi-ld:AirQualityObserved:bw-sc-" + later, ags: later, pm25: 5, dateObserved: { "@type": "DateTime", "@value": now } }],
    SharingSummary: [
      { id: "urn:ngsi-ld:SharingSummary:bw-08111000-ff-a", ags: "08111000", availableVehicles: 3168 },
      { id: "urn:ngsi-ld:SharingSummary:bw-08415061-ff-a", ags: "08415061", availableVehicles: 59 }],
    // one summary per municipality: 1,103 entities, two pages
    ChargingSummary: GEM_ROWS.map(r => ({ id: "urn:ngsi-ld:ChargingSummary:bw-" + r[0], ags: r[0], liveEvse: 10, availableEvse: 5 })),
    RoadWork: [1, 2].map(i => ({ id: "urn:ngsi-ld:RoadWork:bw-svz-" + i, ags: "08111000", dateObserved: now })),
    Alert: [{ id: "urn:ngsi-ld:Alert:bw-kreis-08111-dwd", ags: "08111", maxSeverity: 0 }]
  };
  const env = nodeEnv({ http: pulseHttp(data) });
  const out = outMsgs(await runNode("udp-rt-bz-build", {}, env)).flatMap(m => m.payload);
  const comp = ags => {
    const e = out.find(x => x.id === "urn:ngsi-ld:CityPulse:bw-" + ags);
    return e && Object.fromEntries(e.components.value.map(c => [c[0], c[1]]));
  };
  assert.deepStrictEqual(comp("08111000"), { feinstaub: 60, sharing: 100, laden: 50, baustellen: 90, warnungen: 100 });
  // stale dust ignored; 59 vehicles / 118,528 inhabitants = 0.5 per 1,000 -> 10; no roadworks -> 100
  assert.deepStrictEqual(comp("08415061"), { sharing: 10, laden: 50, baustellen: 100, warnungen: 100 });
  // laden + baustellen (+ warnungen) are only two real components
  assert.strictEqual(comp("08416041"), undefined, "warnungen counted towards the minimum");
  assert(comp(later) && comp(later).laden === 50, "second page of ChargingSummary not fetched");
  assert(out.every(e => e.dateObserved), "CityPulse without dateObserved");
  // Failed query: skip the run instead of scoring on a partial picture
  const env2 = nodeEnv({ http: pulseHttp(data, "RoadWork") });
  assert.strictEqual(await runNode("udp-rt-bz-build", {}, env2), null);
  assert(env2.log.some(l => /RoadWork: HTTP 500/.test(l)));
  // Roadworks feed without current data: no "no roadworks" score for anyone
  const stale = [{ id: "urn:ngsi-ld:RoadWork:bw-svz-1", ags: "08111000", dateObserved: "2020-01-01T00:00:00Z" }];
  const env3 = nodeEnv({ http: pulseHttp(Object.assign({}, data, { RoadWork: stale })) });
  const out3 = outMsgs(await runNode("udp-rt-bz-build", {}, env3)).flatMap(m => m.payload);
  assert(out3.every(e => !e.components.value.some(c => c[0] === "baustellen")), "baustellen scored without a live feed");
};

exports["Carsharing: master data run replaces the system's stations"] = async () => {
  const env = nodeEnv({ flowCtx: { csStationen: { "sysA::old": { ags: "08111000" }, "sysB::x": { ags: "08111000" } } } });
  await runNode("udp-rt-cs-fn", { statusCode: 200, system: "sysA", feed: "info",
    payload: { data: { stations: [{ station_id: "1", lat: 48.7758, lon: 9.1829, name: "S1" }] } } }, env);
  assert.deepStrictEqual(Object.keys(env.flowCtx.csStationen).sort(), ["sysA::1", "sysB::x"]);
  // A list without any station in BW (Basel) leaves the cache alone
  await runNode("udp-rt-cs-fn", { statusCode: 200, system: "sysA", feed: "info",
    payload: { data: { stations: [{ station_id: "2", lat: 47.5596, lon: 7.5886, name: "Basel" }] } } }, env);
  assert.deepStrictEqual(Object.keys(env.flowCtx.csStationen).sort(), ["sysA::1", "sysB::x"]);
};

exports["Carsharing prunes only touch entities of this connector"] = () => {
  const n = FUNCS.find(x => x.id === "udp-rt-cz-msgs");
  assert(/const ownGbfs = \(id, e\) => [^\n]*'MobiData BW GBFS'/.test(n.func), "no dataProvider ownership check");
  const calls = n.func.split("pruneStale({").slice(1);
  assert.strictEqual(calls.length, 2);
  for (const c of calls) assert(/accept: ownGbfs/.test(c) && /attrs: '[^']*dataProvider/.test(c), "carsharing prune without ownership check");
};

/* The city page called parking and B+R values "Echtzeit" without looking at
   their age. staleStand() decides; the parking/B+R texts must use it. */
exports["GUI: realtime labels only for current values"] = () => {
  const lib = fs.readFileSync(path.join(ROOT, "gui/public/smartcity-lib.js"), "utf8");
  const start = lib.indexOf("  const obsTime = e => {");
  const end = lib.indexOf("  };", lib.indexOf("  const staleStand = ")) + 4;
  assert(start > 0 && end > start, "obsTime/staleStand missing in smartcity-lib.js");
  const staleStand = new Function(lib.slice(start, end) + "\nreturn staleStand;")();
  const at = ms => new Date(Date.now() - ms).toISOString();
  const H = 3600e3;
  assert.strictEqual(staleStand({ dateObserved: { value: { "@type": "DateTime", "@value": at(H) } } }, 6 * H), "");
  assert.strictEqual(staleStand({ realtimeFree: { value: 3, observedAt: at(H) } }, 6 * H), "");
  assert(/^Stand: \d\d\.\d\d\. \d\d:\d\d$/.test(staleStand({ dateObserved: { value: at(7 * H) } }, 6 * H)));
  assert.strictEqual(staleStand([{ dateObserved: { value: at(9 * H) } }, { dateObserved: { value: at(H) } }], 6 * H), "",
    "newest entity decides");
  assert.strictEqual(staleStand({ name: { value: "x" } }, 6 * H), "Stand unbekannt");
  const page = fs.readFileSync(path.join(ROOT, "gui/public/stadt.html"), "utf8");
  assert(/const pkStand = [^\n]*staleStand\(pk, STALE\.parken\)/.test(page), "parking tile without age check");
  assert(/const brStand = staleStand\(bikes, STALE\.parken\)/.test(page), "B+R tile without age check");
  assert(!/hint: "freie Plätze, Echtzeit", explain/.test(page), "B+R still labelled Echtzeit unconditionally");
  assert(/"name,operator,availableVehicles,capacity,ags,location,dateObserved"/.test(page), "carsharing popup without dateObserved");
};
