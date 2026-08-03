/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Invarianten der öffentlichen Angriffsfläche (Release-Härtung).

   Hintergrund: die APISIX-Routen werten noch kein OIDC-Token aus. Öffentlich
   erreichbar ist die Plattform-API deshalb ausschließlich lesend über den
   /gateway-Präfix des Cockpit-nginx. Diese Tests halten die dafür nötigen
   Zusagen fest, damit sie nicht unbemerkt zurückgedreht werden. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const PUB = path.join(ROOT, "gui", "public");
const HELM = path.join(ROOT, "helm", "udp");
const NGINX = path.join(ROOT, "platform", "config", "nginx", "cockpit.conf.template");

const read = p => fs.readFileSync(p, "utf8");
const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);

/* smartcity-lib.js ist eine IIFE über `window` und registriert beim Laden einen
   Service-Worker. Node bringt dafür keine Browser-Globals mit: `navigator` gibt
   es erst ab Node 21, die CI läuft auf 20. Alle beim LADEN berührten Globals
   werden deshalb als Funktionsparameter geschattet, statt sich auf die
   Node-Version zu verlassen. navigator ohne serviceWorker-Schlüssel lässt die
   Registrierung sauber aus. */
function loadSC() {
  let exported = null;
  const win = {
    addEventListener() {},
    get SC() { return exported; },
    set SC(v) { exported = v; },
  };
  new Function("window", "navigator", "location", read(path.join(PUB, "smartcity-lib.js")))(
    win, {}, { protocol: "https:" });
  assert(exported, "smartcity-lib.js hat window.SC nicht gesetzt");
  return exported;
}

/* ---------- Ausgabe-Maskierung (Stored XSS) ---------- */

exports["smartcity-lib exportiert esc/safeUrl und nutzt sie in den Renderern"] = () => {
  const src = read(path.join(PUB, "smartcity-lib.js"));
  assert(/w\.SC = \{[^}]*\besc\b/s.test(src), "esc wird nicht auf SC exportiert");
  assert(/w\.SC = \{[^}]*\bsafeUrl\b/s.test(src), "safeUrl wird nicht auf SC exportiert");
  // Die generischen Renderer dürfen Broker-Strings nicht roh interpolieren.
  assert(src.includes("<b>${esc(it.name)}</b>"), "popupHtml maskiert it.name nicht");
  assert(src.includes("${esc(s.name)}"), "chart maskiert Seriennamen nicht");
  assert(src.includes("<title>${esc(r[0])}"), "barSvg maskiert die Balkenbeschriftung nicht");
  assert(src.includes('<div class="label">${esc(label)}</div>'), "tile maskiert das Label nicht");
  assert(src.includes('data-title="${esc(label)}"'), "tile maskiert data-title nicht");
};

exports["esc maskiert alle fünf HTML-Sonderzeichen"] = () => {
  const SC = loadSC();
  const out = SC.esc(`<img src=x onerror="alert('1')">`);
  // Kein Zeichen darf mehr aus dem Text- oder Attributkontext ausbrechen können.
  for (const ch of ["<", ">", '"', "'"]) assert(!out.includes(ch), `esc lässt ${ch} durch: ${out}`);
  assert.strictEqual(SC.esc("a&b"), "a&amp;b");
  assert.strictEqual(SC.esc("&lt;"), "&amp;lt;", "esc darf nicht doppeldeutig kodieren");
  assert.strictEqual(SC.esc(null), "");
  assert.strictEqual(SC.esc(undefined), "");
};

exports["safeUrl lässt nur http/https und relative Ziele zu"] = () => {
  const SC = loadSC();
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>", "vbscript:x"])
    assert.strictEqual(SC.safeUrl(bad), "", `safeUrl lässt ${bad} durch`);
  for (const good of ["https://example.org/x", "http://example.org", "/dashboard.html", "#anker"])
    assert.strictEqual(SC.safeUrl(good), good, `safeUrl verwirft ${good}`);
};

exports["Keine rohe Interpolation von val(...) in Markup der Seiten"] = () => {
  // val(e, "...") liefert einen Broker-Wert. Direkt in ein Template-Literal
  // interpoliert (${val(...)}) wäre das eine ungeschützte Senke.
  for (const f of ["stadt.html", "kreis.html", "dashboard.html"]) {
    const src = read(path.join(PUB, f));
    const roh = [...src.matchAll(/\$\{val\([^}]*\)\}/g)].map(m => m[0]);
    assert.deepStrictEqual(roh, [], `${f}: unmaskierte Broker-Werte im Markup: ${roh.join(" · ")}`);
  }
};

/* ---------- Cockpit-nginx: nur lesend nach außen ---------- */

exports["Alle /gateway-Locations sind auf lesende Methoden begrenzt"] = () => {
  const conf = read(NGINX);
  const locs = [...conf.matchAll(/location\s+(\^~\s+)?(\/gateway\S*)\s*\{([\s\S]*?)\n    \}/g)];
  assert(locs.length >= 3, `erwartet ≥3 /gateway-Locations, gefunden ${locs.length}`);
  for (const [, caret, pfad, body] of locs) {
    assert(/limit_except\s+GET\s+HEAD\s+OPTIONS\s*\{\s*deny\s+all;\s*\}/.test(body),
      `${pfad}: kein limit_except auf GET/HEAD/OPTIONS`);
    // ^~ verhindert, dass die Regex-Location für .js/.json/.css/.html greift.
    assert(caret, `${pfad}: ohne ^~ übersteuert die Regex-Location den Präfix-Treffer`);
  }
};

exports["Node-RED ist nur über die beiden exakten Endpunkte erreichbar"] = () => {
  const conf = read(NGINX);
  const nodered = [...conf.matchAll(/location\s+(=\s+)?(\/\S+)\s*\{([\s\S]*?)\n    \}/g)]
    .filter(([, , , body]) => body.includes("UDP_NODERED_UPSTREAM"));
  assert.deepStrictEqual(nodered.map(m => m[2]).sort(), ["/abfahrten", "/warnungen.ics"]);
  for (const [, exakt, pfad] of nodered)
    assert(exakt, `${pfad}: Präfix-Match reicht in weitere Node-RED-Pfade durch (location = ... nötig)`);
};

/* ---------- Helm: nichts Schreibendes am Ingress ---------- */

exports["values.yaml veröffentlicht keine ungeschützten Plattform-APIs"] = () => {
  const v = read(path.join(HELM, "values.yaml"));
  assert(/^\s*apiPaths:\s*\[\]\s*$/m.test(v), "ingress.apiPaths ist nicht leer");
  assert(/^\s*exposeComponentPaths:\s*false\s*$/m.test(v), "ingress.exposeComponentPaths ist nicht false");
  assert(/^\s*exposeRoutes:\s*false\s*$/m.test(v), "iotAgentJson.exposeRoutes ist nicht false");
  assert(/^\s*authEnabled:\s*false\s*$/m.test(v), "cockpit.authEnabled ist nicht false");
  // FROST schreibt serviceRootUrl in jeden @iot.selfLink – sie muss auf den
  // tatsächlich erreichbaren (lesenden) Pfad zeigen.
  assert(/serviceRootUrl:\s*"[^"]*\/gateway\/FROST-Server"/.test(v),
    "frost.serviceRootUrl zeigt nicht auf den /gateway-Pfad");
};

exports["CORS erlaubt keine schreibenden Methoden"] = () => {
  for (const f of [path.join(HELM, "files", "apisix", "apisix.yaml.tpl"),
                   path.join(ROOT, "platform", "config", "apisix", "apisix.yaml")]) {
    const m = read(f).match(/allow_methods:\s*"([^"]+)"/);
    assert(m, `${path.basename(f)}: keine allow_methods gefunden`);
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"])
      assert(!m[1].includes(verb), `${path.basename(f)}: CORS erlaubt ${verb}`);
  }
};

exports["Kein Service im Chart ist von außen exponiert"] = () => {
  for (const f of walk(path.join(HELM, "templates")).filter(x => x.endsWith(".yaml"))) {
    const src = read(f);
    for (const verboten of ["LoadBalancer", "NodePort", "nodePort:", "hostPort:", "hostNetwork:"])
      assert(!src.includes(verboten),
        `${path.basename(f)}: ${verboten} macht einen Dienst von außen erreichbar`);
  }
};
