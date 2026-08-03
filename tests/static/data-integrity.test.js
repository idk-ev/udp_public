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

exports["Jeder aktive Registry-Konnektor hat Flow-Nodes (nodePrefixes)"] = () => {
  const reg = J("platform/config/connectors.json").connectors;
  const ids = new Set(J("platform/config/nodered/flows.json").map(n => String(n.id || "")));
  for (const c of reg.filter(c => c.active !== false)) {
    const hit = c.nodePrefixes.some(p => [...ids].some(id => id.startsWith(p)));
    assert(hit, `Konnektor ${c.id}: keine Nodes mit Präfix ${c.nodePrefixes}`);
  }
};

exports["dashboards.json und Compose parsen"] = () => {
  J("gui/public/dashboards.json");
  const compose = fs.readFileSync(path.join(ROOT, "platform/docker-compose.yml"), "utf8");
  const images = compose.split("\n").filter(l => /^\s*image:/.test(l)).join("\n");
  assert(!images.includes("redis:"), "Redis-Image wieder da (Lizenz! Valkey nutzen)");
  assert(images.includes("valkey"), "Valkey fehlt");
};

exports["Node-RED-Image bringt Flows, settings.js und pg mit"] = () => {
  // Die Flows kommen im Cluster aus dem eigenen Image, nicht aus einer
  // ConfigMap oder einem Volume. Bricht das, startet Node-RED mit leerer
  // Flow-Liste: kein Konnektor ingestiert, /abfahrten und /warnungen.ics 404.
  const df = fs.readFileSync(path.join(ROOT, "platform/config/nodered/Dockerfile"), "utf8");
  assert(/COPY\s+platform\/config\/nodered\/flows\.json\s+\/data\/flows\.json/.test(df),
    "Dockerfile kopiert flows.json nicht nach /data");
  assert(/COPY\s+platform\/config\/nodered\/settings\.js\s+\/data\/settings\.js/.test(df),
    "Dockerfile kopiert settings.js nicht nach /data");
  assert(/npm install[^\n]*\bpg@/.test(df),
    "pg wird nicht ins Image installiert — der Function-Node zöge es zur Laufzeit von npmjs.org");

  // Ein Volume auf /data würde die Dateien aus dem Image verdecken.
  const apps = fs.readFileSync(path.join(ROOT, "helm/udp/templates/apps.yaml"), "utf8");
  const nodeRedBlock = apps.slice(0, apps.indexOf("kind: Service"));
  assert(!/mountPath:\s*\/data/.test(nodeRedBlock),
    "Node-RED mountet wieder etwas auf /data — das verdeckt die Flows aus dem Image");

  // settings.js trägt zwei Einstellungen, ohne die die Flows nicht laufen.
  const settings = fs.readFileSync(path.join(ROOT, "platform/config/nodered/settings.js"), "utf8");
  assert(/^\s*functionExternalModules:\s*true/m.test(settings),
    "functionExternalModules fehlt — die TRoE-Nodes können pg nicht laden");
  assert(/^\s*contextStorage:/m.test(settings), "contextStorage fehlt");

  // Die beiden öffentlich proxied Endpunkte müssen in den Flows existieren.
  const urls = J("platform/config/nodered/flows.json")
    .filter(n => n.type === "http in").map(n => n.url).sort();
  assert.deepStrictEqual(urls, ["/abfahrten", "/warnungen.ics"]);
};
