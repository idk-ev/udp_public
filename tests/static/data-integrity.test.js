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

  // settings.js: nichts mehr, was nur die Ingestion brauchte.
  const settings = fs.readFileSync(path.join(ROOT, "platform/config/nodered/settings.js"), "utf8");
  assert(!/^\s*contextStorage:/m.test(settings), "contextStorage ist wieder aktiv");
  assert(/^\s*functionExternalModules:\s*false/m.test(settings), "functionExternalModules ist nicht aus");

  // Das Chart liefert dieselben Dateien per ConfigMap aus (Upstream-Image).
  const eol = t => t.replace(/\r\n/g, "\n");
  for (const f of ["flows.json", "settings.js"]) {
    assert.strictEqual(eol(fs.readFileSync(path.join(ROOT, "helm/udp/files/nodered", f), "utf8")),
      eol(fs.readFileSync(path.join(ROOT, "platform/config/nodered", f), "utf8")),
      `helm/udp/files/nodered/${f} weicht von platform/config/nodered/${f} ab — kopieren`);
  }
  const apps = fs.readFileSync(path.join(ROOT, "helm/udp/templates/apps.yaml"), "utf8");
  const nodeRed = apps.slice(apps.indexOf("  name: node-red\n"), apps.indexOf("kind: Service"));
  assert(/image: \{\{ include "udp\.image" \(dict "ctx" \. "image" \.Values\.nodeRed\.image\) \}\}/.test(nodeRed),
    "Node-RED läuft nicht auf dem Upstream-Image");
  assert(!/TROE_DB_|HYSTREET_API_TOKEN/.test(nodeRed), "Node-RED bekommt wieder Zugangsdaten der Ingestion");
  const compose = fs.readFileSync(path.join(ROOT, "platform/docker-compose.yml"), "utf8");
  const nrCompose = compose.slice(compose.indexOf("\n  node-red:"), compose.indexOf("\n  connectors:"));
  assert(!/TROE_DB_|HYSTREET_API_TOKEN/.test(nrCompose), "Compose: Node-RED bekommt wieder Zugangsdaten der Ingestion");
};
