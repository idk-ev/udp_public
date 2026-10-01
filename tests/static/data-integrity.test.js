/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Datenintegrität der generierten Artefakte und der Konnektor-Registry. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const J = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

exports["bw-gemeinden.json: 1103 Gemeinden, 44 Kreise, eindeutige Slugs"] = () => {
  const d = J("gui/public/bw-gemeinden.json");
  assert.strictEqual(d.gemeinden.length, 1103);
  assert.strictEqual(d.kreise.length, 44);
  assert.strictEqual(d.kreise.filter(k => k[4] === "LK").length, 35);
  for (const g of d.gemeinden) assert.strictEqual(g.length, 9, `Zeile ${g[0]} hat ${g.length} Felder`);
  const slugs = d.gemeinden.map(g => g[8]);
  assert.strictEqual(new Set(slugs).size, slugs.length, "Gemeinde-Slug-Kollision");
  const lkSlugs = d.kreise.filter(k => k[4] === "LK").map(k => k[7]);
  for (const s of lkSlugs) assert(!slugs.includes(s), `Kreis-Slug kollidiert mit Gemeinde: ${s}`);
};

exports["Registry und Status-Export sind synchron"] = () => {
  const reg = J("platform/config/connectors.json").connectors;
  const exp = J("gui/public/connectors-status.json").connectors;
  assert.deepStrictEqual(exp.map(c => c.id), reg.map(c => c.id), "Konnektor-IDs weichen ab");
  for (const c of exp) if (c.pending) assert(reg.find(r => r.id === c.id).pending, `pending nicht aus Registry: ${c.id}`);
};

exports["dashboards.json und Compose parsen"] = () => {
  J("gui/public/dashboards.json");
  const compose = fs.readFileSync(path.join(ROOT, "platform/docker-compose.yml"), "utf8");
  const images = compose.split("\n").filter(l => /^\s*image:/.test(l)).join("\n");
  assert(!images.includes("redis:"), "Redis-Image wieder da (Lizenz! Valkey nutzen)");
  assert(images.includes("valkey"), "Valkey fehlt");
};

exports["Node-RED: nur der Beispielfluss, gleiche Dateien in Compose und Helm"] = () => {
  // Node-RED ist Low-Code-Baustein (B.II.4), keine Ingestion-Laufzeit mehr:
  // flows.json trägt genau den Beispiel-Tab. Kein http-in-Node — /abfahrten
  // und /warnungen.ics beantwortet der Konnektordienst.
  const flows = J("platform/config/nodered/flows.json");
  assert.deepStrictEqual(flows.map(n => n.id).sort(),
    ["udp-debug-1", "udp-func-1", "udp-http-1", "udp-inject-1", "udp-tab-1"]);
  assert.deepStrictEqual(flows.filter(n => n.type === "tab").map(n => n.label), ["Beispiel: Open Data → NGSI-LD"]);
  assert(!flows.some(n => n.type === "http in"), "Node-RED bedient wieder einen HTTP-Endpunkt");
  assert(/^http:\/\/orion-ld:1026\/ngsi-ld\/v1\/entityOperations\/upsert/.test(flows.find(n => n.id === "udp-http-1").url),
    "Beispielfluss schreibt nicht mehr nach Orion-LD");
  // Ausgeliefert deaktiviert: sonst schriebe er alle 10 min Zufallswerte in
  // den produktiven Broker. Zum Ausprobieren im Editor aktivieren.
  assert.strictEqual(flows.find(n => n.type === "tab").disabled, true, "Beispielfluss ist nicht deaktiviert ausgeliefert");

  // settings.js: nichts mehr, was nur die Ingestion brauchte.
  const settings = fs.readFileSync(path.join(ROOT, "platform/config/nodered/settings.js"), "utf8");
  assert(!/^\s*contextStorage:/m.test(settings), "contextStorage ist wieder aktiv");
  assert(/^\s*functionExternalModules:\s*false/m.test(settings), "functionExternalModules ist nicht aus");
  // Anmeldung am Editor aus der Umgebung (leer = offen, wie bisher).
  assert(/^\s*adminAuth:\s*udpAdminAuth,/m.test(settings), "adminAuth kommt nicht aus NODE_RED_ADMIN_*");
  assert(/process\.env\.NODE_RED_ADMIN_USER/.test(settings) && /process\.env\.NODE_RED_ADMIN_PASSWORD_HASH/.test(settings),
    "settings.js liest NODE_RED_ADMIN_USER/NODE_RED_ADMIN_PASSWORD_HASH nicht");

  // Das Chart liefert dieselben Dateien per ConfigMap aus (Upstream-Image).
  const eol = t => t.replace(/\r\n/g, "\n");
  for (const f of ["flows.json", "settings.js"]) {
    assert.strictEqual(eol(fs.readFileSync(path.join(ROOT, "helm/udp/files/nodered", f), "utf8")),
      eol(fs.readFileSync(path.join(ROOT, "platform/config/nodered", f), "utf8")),
      `helm/udp/files/nodered/${f} weicht von platform/config/nodered/${f} ab — kopieren`);
  }
  const apps = eol(fs.readFileSync(path.join(ROOT, "helm/udp/templates/apps.yaml"), "utf8"));
  const nodeRed = apps.slice(apps.indexOf("  name: node-red\n"), apps.indexOf("kind: Service"));
  assert(/image: \{\{ include "udp\.image" \(dict "ctx" \. "image" \.Values\.nodeRed\.image\) \}\}/.test(nodeRed),
    "Node-RED läuft nicht auf dem Upstream-Image");
  assert(!/TROE_DB_|HYSTREET_API_TOKEN/.test(nodeRed), "Node-RED bekommt wieder Zugangsdaten der Ingestion");
  const compose = fs.readFileSync(path.join(ROOT, "platform/docker-compose.yml"), "utf8");
  const nrCompose = compose.slice(compose.indexOf("\n  node-red:"), compose.indexOf("\n  connectors:"));
  assert(!/TROE_DB_|HYSTREET_API_TOKEN/.test(nrCompose), "Compose: Node-RED bekommt wieder Zugangsdaten der Ingestion");
  // Editor/Admin-API: standardmäßig nur lokal veröffentlicht, Anmeldung durchgereicht.
  assert(/"\$\{WORKFLOW_BIND:-127\.0\.0\.1\}:\$\{WORKFLOW_PORT:-4900\}:1880"/.test(nrCompose),
    "Compose: Node-RED ist nicht standardmäßig an 127.0.0.1 gebunden");
  for (const name of ["NODE_RED_ADMIN_USER", "NODE_RED_ADMIN_PASSWORD_HASH"]) {
    assert(new RegExp(`${name}: \\$\\{${name}:-\\}`).test(nrCompose), `Compose: ${name} wird nicht durchgereicht`);
    assert(new RegExp(`name: ${name}\\n\\s+valueFrom:`).test(nodeRed), `Helm: ${name} fehlt im Node-RED-Container`);
  }
};

exports["oepnv-halte.json: BW-Halte mit Koordinate, eigener Kreis oder Nachbarkreis in der Nähe"] = () => {
  // Grenzen aus dem Generator, damit Test und Auswahl nicht auseinanderlaufen.
  const script = fs.readFileSync(path.join(ROOT, "scripts/efa-haltestellen.py"), "utf8");
  const limit = name => Number((new RegExp(`^${name} = ([0-9]+)`, "m").exec(script) || [])[1]);
  const eigen = limit("RADIUS_EIGEN_M"), nachbar = limit("RADIUS_NACHBAR_M");
  assert(eigen > 0 && nachbar > 0 && nachbar <= eigen, "Radien im Generator nicht lesbar");

  const gemeinden = new Map(J("gui/public/bw-gemeinden.json").gemeinden.map(g => [g[0], g]));
  const halte = J("gui/public/oepnv-halte.json").halte;
  const km = (a, b, c, d) => {
    const r = x => x * Math.PI / 180;
    const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  };
  const eintraege = Object.entries(halte);
  // Fehlende Gemeinden sind gewollt (kein gültiger Halt), aber die Ausnahme.
  assert(eintraege.length > 1000, `nur ${eintraege.length} Halte`);
  for (const [ags, h] of eintraege) {
    const g = gemeinden.get(ags);
    assert(g, `${ags}: keine BW-Gemeinde`);
    assert(/^de:08\d{3}:/.test(h.stopId), `${ags} ${g[1]}: ${h.stopId} ist kein BW-Halt`);
    assert(typeof h.stopName === "string" && h.stopName, `${ags}: kein Haltname`);
    assert(Number.isFinite(h.lat) && Number.isFinite(h.lon), `${ags} ${g[1]}: keine Koordinate`);
    const eigenerKreis = h.stopId.startsWith(`de:${g[4]}:`);
    // Von Hand gepflegt (efa-abfahrten): eigener Kreis, aber ohne Radius.
    if (h.art === "kuratiert") {
      assert(eigenerKreis, `${ags} ${g[1]}: kuratierter Halt ${h.stopId} nicht im eigenen Kreis`);
      continue;
    }
    const dist = km(g[2], g[3], h.lat, h.lon);
    assert(dist <= (eigenerKreis ? eigen : nachbar) + 1,
      `${ags} ${g[1]}: ${h.stopId} ${Math.round(dist)} m vom Gemeindemittelpunkt (${eigenerKreis ? "eigener Kreis" : "Nachbarkreis"})`);
  }
};

exports["oepnv-halte.json: die Halte von efa-abfahrten (Registry) gehen vor"] = () => {
  const efa = J("platform/config/connectors.json").connectors.find(c => c.id === "efa-abfahrten");
  const halte = J("gui/public/oepnv-halte.json").halte;
  const kuratiert = Object.entries((efa.params && efa.params.stopId) || {});
  assert(kuratiert.length > 0, "efa-abfahrten ohne params.stopId");
  for (const [ags, stopId] of kuratiert) {
    assert(halte[ags], `${ags}: kein Eintrag in oepnv-halte.json`);
    assert.strictEqual(halte[ags].stopId, stopId, `${ags}: Halt weicht von der Registry ab — efa-haltestellen.py laufen lassen`);
    assert.strictEqual(halte[ags].art, "kuratiert", `${ags}: nicht als kuratiert markiert`);
  }
  // Umgekehrt: »kuratiert« nur, wo die Registry den Halt vorgibt.
  const ausRegistry = new Set(kuratiert.map(([ags]) => ags));
  for (const [ags, h] of Object.entries(halte)) {
    if (h.art === "kuratiert") assert(ausRegistry.has(ags), `${ags}: kuratiert, aber nicht in der Registry`);
  }
};
