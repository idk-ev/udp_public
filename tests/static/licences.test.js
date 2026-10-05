/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Licences of the data sources on the public pages (docs/api.md, "Lizenzen
   der Datenquellen"):
     - credits as the licences ask for them, linked to source and licence,
       none of the former wrong labels anywhere public;
     - LUBW/HVZ gauges are not republished (their terms), a link to the HVZ
       takes their place;
     - official warnings are shown unaltered: full headline, source, link to
       the original warning;
     - markers derived from OpenStreetMap add the ODbL credit to the map.
   Page tests run in jsdom (page-harness.js) and skip without gui/node_modules. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { JSDOM, ROOT, PUB, LIB, CONN, GEM, renderStadt, renderPage, labels } = require("./page-harness");

const REUTLINGEN = GEM.gemeinden.find(g => g[0] === "08415061");
const [, , LAT, LON] = REUTLINGEN;
const P = value => ({ type: "Property", value });
const at = (lat, lon) => ({ type: "GeoProperty", value: { type: "Point", coordinates: [lon, lat] } });
const WX = { id: "urn:ngsi-ld:WeatherObserved:bw-08415061", type: "WeatherObserved", temperature: P(12) };

exports["public files carry none of the former wrong credit labels"] = () => {
  const wrong = /GeoNutzV|EuroGeographics|naldo\/bwegt|SVZ-BW|CC-BY 4\.0|BrightSky \(GeoNutzV\)/;
  const files = fs.readdirSync(PUB).filter(f => /\.(html|js|css|json)$/.test(f) && !/^bw-(gemeinden|grenzen)\.json$/.test(f));
  for (const f of files.concat(["../ops/connectors-status.json", "../../platform/config/connectors.json"])) {
    const text = fs.readFileSync(path.join(PUB, f), "utf8");
    const m = wrong.exec(text);
    assert(!m, `${f} still says "${m && m[0]}"`);
  }
};

exports["smartcity-lib: credits link source and licence, escaped, https only"] = () => {
  if (!JSDOM) return;
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://udp.example/", runScripts: "outside-only" });
  dom.window.eval(LIB);
  const SC = dom.window.SC;
  const html = SC.attributionHtml([
    { id: "a", active: true, attribution: "Wetterdaten: Open-Meteo.com (CC BY 4.0) · <b>X</b>",
      attributionLinks: { "Open-Meteo.com": "https://open-meteo.com/", "CC BY 4.0": "https://creativecommons.org/licenses/by/4.0/",
        "<b>X</b>": "javascript:alert(1)" } },
    { id: "b", active: false, attribution: "Abgeschaltet (CC0)" },
    { id: "c", active: true, attribution: "© OpenStreetMap-Mitwirkende (ODbL)",
      attributionLinks: { "OpenStreetMap-Mitwirkende": "https://www.openstreetmap.org/copyright", "OpenStreetMap": "https://x.example/" } },
  ]);
  const d = new dom.window.DOMParser().parseFromString(`<p>${html}</p>`, "text/html");
  const links = [...d.querySelectorAll("a")].map(a => [a.textContent, a.getAttribute("href")]);
  assert.deepStrictEqual(links, [
    ["Open-Meteo.com", "https://open-meteo.com/"],
    ["CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/"],
    ["OpenStreetMap-Mitwirkende", "https://www.openstreetmap.org/copyright"],
  ]);
  assert.strictEqual(d.querySelector("p").textContent,
    "Wetterdaten: Open-Meteo.com (CC BY 4.0) · <b>X</b> · © OpenStreetMap-Mitwirkende (ODbL)");
  assert(!d.querySelector("b"), "credit text not escaped");
  assert(SC.MAP_CREDIT.includes("© GeoBasis-DE / BKG (2026)") && SC.MAP_CREDIT.includes("https://basemap.de/")
    && SC.MAP_CREDIT.includes("https://creativecommons.org/licenses/by/4.0/"), "basemap.de credit");
};

exports["stadt.html: footer credits are linked (Open-Meteo, OSM copyright, basemap.de)"] = async () => {
  if (!JSDOM) return;
  const { w, d } = await renderStadt({ entities: { [WX.id]: WX } });
  const footer = d.getElementById("footer");
  const href = text => { const a = [...footer.querySelectorAll("a")].find(x => x.textContent === text); return a && a.getAttribute("href"); };
  assert.strictEqual(href("Open-Meteo.com"), "https://open-meteo.com/");
  assert.strictEqual(href("OpenStreetMap-Mitwirkende"), "https://www.openstreetmap.org/copyright");
  assert.strictEqual(href("basemap.de"), "https://basemap.de/");
  assert.strictEqual(href("CC BY 4.0"), "https://creativecommons.org/licenses/by/4.0/");
  for (const s of ["Wetterdaten: Open-Meteo.com (CC BY 4.0)", "Pegel: WSV/PEGELONLINE (DL-DE→Zero-2.0)",
    "Feinstaub: sensor.community (ODbL)", "Datenpaket: MobiData BW; NVBW (dl-de/by-2-0)", "Wikidata (CC0)",
    "Umweltbundesamt mit Daten der Messnetze der Länder und des Bundes (dl-de/by-2-0)"])
    assert(footer.textContent.includes(s), `footer lacks "${s}"`);
  assert(!/LUBW|hystreet/.test(footer.textContent), "a switched-off source is credited");
  w.close();
};

exports["stadt.html: LUBW/HVZ gauges are not shown, the HVZ is linked instead"] = async () => {
  if (!JSDOM) return;
  const gauge = (id, name, dLat) => ({ id, type: "WaterLevelObserved", name: P(name), water: P("Echaz"), level: P(80),
    ags: P("08415061"), location: at(LAT + dLat, LON) });
  const { w, d, leaflet } = await renderStadt({
    entities: { [WX.id]: WX },
    types: { WaterLevelObserved: [
      gauge("urn:ngsi-ld:WaterLevelObserved:bw-hvz-00092", "Reutlingen HVZ", 0.001),
      gauge("urn:ngsi-ld:WaterLevelObserved:bw-pegel-23800900", "Reutlingen WSV", 0.002),
    ] },
  });
  const markup = JSON.stringify(leaflet);
  assert(markup.includes("Pegel Reutlingen WSV"), "the PEGELONLINE gauge is missing on the map");
  assert(!markup.includes("Reutlingen HVZ"), "a LUBW/HVZ gauge is shown");
  const link = [...d.querySelectorAll("#tiles a.tile-link")].find(a => a.querySelector(".label").textContent === "Pegel & Hochwasser");
  assert(link, "no link to the HVZ");
  assert.strictEqual(link.getAttribute("href"), "https://hvz.lubw.baden-wuerttemberg.de/");
  assert.match(link.textContent, /Pegelstände und Hochwasservorhersage: LUBW Hochwasservorhersagezentrale/);
  w.close();
};

exports["stadt.html and kreis.html: official warnings unaltered, with source and link"] = async () => {
  if (!JSDOM) return;
  const long = "Amtliche UNWETTERWARNUNG vor ORKANBÖEN im Kreis Reutlingen und auf der Schwäbischen Alb oberhalb 800 m";
  const nina = "Verunreinigung des Trink- / Leitungswassers - Pfullingen, Ortsteil Mitte";
  const NINA_URL = "https://warnung.bund.de/meldungen/mow.DE-BW-RT-W001-20261001-000";
  const alerts = {
    "urn:ngsi-ld:Alert:bw-kreis-08415-dwd": { id: "urn:ngsi-ld:Alert:bw-kreis-08415-dwd", type: "Alert",
      activeCount: P(1), maxSeverity: P(4), headlines: P([{ h: long, sev: "extreme" }]) },
    "urn:ngsi-ld:Alert:bw-kreis-08415-nina": { id: "urn:ngsi-ld:Alert:bw-kreis-08415-nina", type: "Alert",
      activeCount: P(1), maxSeverity: P(1), headlines: P([{ h: nina, sev: "minor", url: NINA_URL }]) },
  };
  const { w, d } = await renderStadt({ entities: { [WX.id]: WX, ...alerts } });
  const banner = d.getElementById("wbanner");
  const lines = [...banner.querySelectorAll(".wline")];
  assert.deepStrictEqual(lines.map(l => l.getAttribute("title")), [long, nina], "headline cut or missing");
  assert.deepStrictEqual(lines.map(l => l.querySelector("a").textContent), [long, nina]);
  assert.strictEqual(lines[1].querySelector("a").getAttribute("href"), NINA_URL);
  assert.match(lines[0].querySelector("a").getAttribute("href"), /^https:\/\/www\.dwd\.de\//);
  assert.match(banner.textContent, /Quelle: Deutscher Wetterdienst/);
  assert.match(banner.textContent, /Warnungen: BBK\/warnung\.bund\.de/);
  // The detail table: full text and the link to the original.
  w.SC.openDetailByKey("warnungen");
  const body = d.getElementById("sc-modal-body");
  assert(body.textContent.includes(long) && body.textContent.includes(nina), "detail table cuts a headline");
  assert([...body.querySelectorAll("a")].some(a => a.getAttribute("href") === NINA_URL && a.textContent === "Originalmeldung"));
  w.close();

  const k = await renderPage("kreis.html", "https://udp.example/kreis-reutlingen", null,
    { KREIS: { krs: "08415", slug: "kreis-reutlingen" } });
  // The district page fetches entities through the gateway, which answers 404
  // here: no warning, no banner lines, but no cut text either.
  assert.strictEqual(k.document.querySelectorAll("#wbanner .wline").length, 0);
  k.close();
};

exports["stadt.html: OpenStreetMap markers add the ODbL credit to the map"] = async () => {
  if (!JSDOM) return;
  const rathaus = { id: "urn:ngsi-ld:CivicStructure:bw-08415061-rathaus", type: "CivicStructure",
    name: P("Rathaus"), openingHours: P("Mo-Fr 08:00-12:00"), location: at(LAT, LON) };
  const { w, leaflet } = await renderStadt({ entities: { [WX.id]: WX, [rathaus.id]: rathaus } });
  assert(leaflet.some(args => args.length === 1 && typeof args[0] === "string" && args[0].includes("openstreetmap.org/copyright")),
    "OSM credit not added to the map");
  w.close();
  const without = await renderStadt({ entities: { [WX.id]: WX } });
  assert(!without.leaflet.some(args => typeof args[0] === "string" && args[0].includes("openstreetmap.org/copyright")),
    "OSM credit without OSM markers");
  assert(labels(without.d).length > 0);
  without.w.close();
};
