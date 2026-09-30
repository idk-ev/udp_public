/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* Tile values of the city and district pages (stadt.html, kreis.html): what a
   tile's main value, hint and detail say for given entities. Sharing split by
   form factor, uncapped totals, heat tile (level, colour, distance), the small
   values (humidity, cycling, ÖPNV, warnings, pollen, parking) and the tile
   order with empty "Noch nicht verfügbar" tiles last.

   Runs in jsdom (page-harness.js); skips without gui/node_modules. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM, PUB, GEM, json, renderStadt, renderPage, labels, tileOf } = require("./page-harness");

const AGS = "08415061";
const P = (value, extra = {}) => ({ type: "Property", value, ...extra });
const nowIso = () => new Date().toISOString();
// Berlin calendar day, `offset` days from today, as YYYY-MM-DD.
const berlinDay = offset => new Date(Date.now() + offset * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
// Berlin clock HH:MM, `min` minutes from now.
const berlinClock = min => new Date(Date.now() + min * 6e4).toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const WX = { id: "urn:ngsi-ld:WeatherObserved:bw-" + AGS, type: "WeatherObserved",
  temperature: P(14.2, { observedAt: nowIso() }), windSpeed: P(8, { observedAt: nowIso() }) };
const base = (extra = {}) => ({ entities: { [WX.id]: WX, ...(extra.entities || {}) }, ...extra });

const summary = (system, n, split, positions = [[48.49, 9.21]]) => ({
  id: `urn:ngsi-ld:SharingSummary:bw-${AGS}-ff-${system}`, type: "SharingSummary",
  ags: P(AGS), system: P(system), availableVehicles: P(n, { observedAt: nowIso() }),
  ...(split ? { vehiclesByFormFactor: P(split, { observedAt: nowIso() }) } : {}),
  vehiclePositions: P(positions),
});
const split = (s = {}) => ({ scooter_standing: 0, bicycle: 0, cargo_bicycle: 0, moped: 0, car: 0, other: 0, ...s });

/* ---------- Sharing (E1, D4) ---------- */

exports["stadt.html: Sharing tile shows the free-floating total, split by form factor"] = async () => {
  if (!JSDOM) return;
  const { w, d } = await renderStadt(base({ types: {
    SharingSummary: [
      summary("bolt_reutlingen_tuebingen", 300, split({ scooter_standing: 300 })),
      summary("stella", 57, split({ scooter_standing: 12, bicycle: 40, moped: 5 })),
    ],
    // Station-based bikes: their own tile, not in Sharing (sharing-bw drops docked vehicles).
    FleetStatus: [{ id: "urn:ngsi-ld:FleetStatus:reutlingen-regiorad", type: "FleetStatus", ags: P(AGS),
      operator: P("RegioRad"), vehicleType: P("bicycle"), availableVehicles: P(20), stationCount: P(4) }],
  } }));
  assert(!labels(d).includes("E-Scooter"), "the old tile name is still there");
  const t = tileOf(d, "Sharing");
  assert(t, "no Sharing tile");
  assert.strictEqual(t.value, "357");
  assert.strictEqual(t.hint, "312 E-Scooter · 40 Räder · 5 Mopeds");
  assert.strictEqual(tileOf(d, "Leihräder").value, "20", "station bikes not on their own tile");
  // The detail: split as bars and in the text, providers as a list.
  w.SC.openDetailByKey("sharing");
  assert.match(d.getElementById("sc-modal-explain").textContent, /Davon 312 E-Scooter · 40 Räder · 5 Mopeds\./);
  assert(d.querySelector("#modal-bars"), "no split bars in the detail");
  assert.match(d.querySelector("#sc-modal-body .m-list").textContent, /bolt 300/);
  w.close();
};

exports["stadt.html: Sharing without the split (older summaries) shows the total only"] = async () => {
  if (!JSDOM) return;
  const { w, d } = await renderStadt(base({ types: {
    SharingSummary: [summary("bolt_reutlingen_tuebingen", 30, split({ scooter_standing: 30 })), summary("voi_de", 12, null)],
  } }));
  const t = tileOf(d, "Sharing");
  assert.strictEqual(t.value, "42");
  assert(!/E-Scooter|Räder/.test(t.hint), `a split although one summary has none: ${t.hint}`);
  assert.match(t.hint, /bolt 30/, "provider chips as the hint");
  w.close();
};

exports["kreis.html: Sharing and Parken show the same split and the realtime value"] = async () => {
  if (!JSDOM) return;
  const KREIS = { KREIS: { slug: "kreis-reutlingen", krs: "08415" } };
  const kv = (id, extra) => ({ id, type: "X", ags: AGS, ...extra });
  const types = {
    SharingSummary: [kv("s1", { availableVehicles: 300, vehiclesByFormFactor: split({ scooter_standing: 300 }) }),
      kv("s2", { availableVehicles: 57, vehiclesByFormFactor: split({ scooter_standing: 12, bicycle: 40, moped: 5 }) })],
    ParkingSummary: [kv("p1", { siteCount: 10, totalCapacity: 1500, realtimeFree: 120, realtimeSites: 4, dateObserved: nowIso() }),
      kv("p2", { siteCount: 3, totalCapacity: 200 })],
  };
  const w = await renderPage("kreis.html", "https://udp.example/kreis-reutlingen", null, KREIS, types);
  const d = w.document;
  assert.strictEqual(tileOf(d, "Sharing").value, "357");
  assert.strictEqual(tileOf(d, "Sharing").hint, "312 E-Scooter · 40 Räder · 5 Mopeds");
  assert.match(tileOf(d, "Parken").value, /^120\s*frei$/);
  assert.match(tileOf(d, "Parken").hint, /in 4 Anlagen mit Echtzeit · 1\.700 Stellplätze/);
  w.close();
  // Old realtime (> 6 h) or none: the capacity, labelled as such.
  types.ParkingSummary[0].dateObserved = new Date(Date.now() - 8 * 3600e3).toISOString();
  types.SharingSummary[1] = kv("s2", { availableVehicles: 57 });
  const old = await renderPage("kreis.html", "https://udp.example/kreis-reutlingen", null, KREIS, types);
  assert.match(tileOf(old.document, "Parken").value, /^1\.700\s*Stellplätze$/);
  assert.strictEqual(tileOf(old.document, "Sharing").hint, "verfügbare Leihfahrzeuge");
  old.close();
  // Only zero summaries (with a split): the total 0 and the plain hint.
  types.SharingSummary = [kv("s1", { availableVehicles: 0, vehiclesByFormFactor: split() })];
  const zero = await renderPage("kreis.html", "https://udp.example/kreis-reutlingen", null, KREIS, types);
  assert.strictEqual(tileOf(zero.document, "Sharing").value, "0");
  assert.strictEqual(tileOf(zero.document, "Sharing").hint, "verfügbare Leihfahrzeuge");
  zero.close();
};

/* ---------- capped counts (E2) ---------- */

exports["stadt.html: Versorgung and Ausflugsziele show the uncapped totals"] = async () => {
  if (!JSDOM) return;
  const amen = Array.from({ length: 50 }, (_, i) => [`Spielplatz ${i}`, "Spielplatz", 48.49, 9.21]);
  const ziele = Array.from({ length: 25 }, (_, i) => [`Ziel ${i}`, "Museum", 48.49, 9.21]);
  const { w, d } = await renderStadt(base({ entities: {
    ["urn:ngsi-ld:PublicAmenity:bw-" + AGS]: { id: "urn:ngsi-ld:PublicAmenity:bw-" + AGS, type: "PublicAmenity",
      amenities: P(amen), counts: P({ Spielplatz: 60, Apotheke: 24 }), totalCount: P(50) },
    ["urn:ngsi-ld:TouristDestination:bw-" + AGS]: { id: "urn:ngsi-ld:TouristDestination:bw-" + AGS, type: "TouristDestination",
      ziele: P(ziele), zielCount: P(120) },
  } }));
  assert.strictEqual(tileOf(d, "Familie & Versorgung").value, "84", "the capped list length (50) is shown");
  assert.strictEqual(tileOf(d, "Ausflugsziele").value, "120", "the capped list length (25) is shown");
  w.close();
};

/* ---------- Hitze (E3, A7) ---------- */

const heat = (name, lon, lat, today, tomorrow) => ({ id: "urn:ngsi-ld:HeatHealthWarning:bw-" + name, type: "HeatHealthWarning",
  name, todayLevel: today, tomorrowLevel: tomorrow,
  maxRank: Math.max(["keine", "gering", "mittel", "hoch", "extrem"].indexOf(today), ["keine", "gering", "mittel", "hoch", "extrem"].indexOf(tomorrow)),
  forecastDay: berlinDay(0), location: { type: "Point", coordinates: [lon, lat] } });
const STUTTGART = (today, tomorrow) => heat("Stuttgart", 9.18, 48.78, today, tomorrow);
// Active segment of the step display: its index is the level the tile is coloured by.
const activeStep = t => [...t.el.querySelectorAll(".mini-steps span")].findIndex(s => !/rgba\(255, ?255, ?255/.test(s.getAttribute("style")));

exports["stadt.html: Hitze tile only from 'gering', coloured by today, distance in the hint"] = async () => {
  if (!JSDOM) return;
  const none = await renderStadt(base({ types: { HeatHealthWarning: [STUTTGART("keine", "keine")] } }));
  assert(!labels(none.d).includes("Hitzebelastung"), "tile without any heat");
  none.w.close();

  // Only tomorrow: today's level as value and colour, tomorrow in the hint.
  const tomorrow = await renderStadt(base({ types: { HeatHealthWarning: [STUTTGART("keine", "mittel")] } }));
  let t = tileOf(tomorrow.d, "Hitzebelastung");
  assert(t, "no tile although tomorrow is 'mittel'");
  assert.match(t.value, /keine/);
  assert.strictEqual(activeStep(t), 0, "coloured by tomorrow instead of today");
  assert.match(t.hint, /^morgen: mittel \(Vertreterstadt Stuttgart, ~3\d km\)$/);
  tomorrow.w.close();

  const today = await renderStadt(base({ types: { HeatHealthWarning: [STUTTGART("hoch", "gering"), heat("Ulm", 9.99, 48.4, "keine", "keine")] } }));
  t = tileOf(today.d, "Hitzebelastung");
  assert.match(t.value, /hoch/);
  assert.strictEqual(activeStep(t), 3);
  assert.match(t.hint, /Vertreterstadt Stuttgart/, "not the nearest representative city");
  today.w.close();
};

exports["stadt.html: Hitze: 'today' is the file's forecastDay; yesterday's file shifts, none is not shown"] = async () => {
  if (!JSDOM) return;
  // DWD updates gt.json at about 07:30: a file of yesterday makes its "tomorrow" today.
  const yesterday = await renderStadt(base({ types: { HeatHealthWarning: [{ ...STUTTGART("keine", "hoch"), forecastDay: berlinDay(-1) }] } }));
  const t = tileOf(yesterday.d, "Hitzebelastung");
  assert(t, "yesterday's 'tomorrow: hoch' not shown as today");
  assert.match(t.value, /hoch/);
  assert.strictEqual(activeStep(t), 3);
  assert.match(t.hint, /^\(Vertreterstadt Stuttgart, ~\d+ km\)$/, "a 'tomorrow' that is not known");
  yesterday.w.close();
  // forecastDay wins over dateObserved (a run before 07:30 stamped today on yesterday's file).
  const stamped = await renderStadt(base({ types: { HeatHealthWarning: [{ ...STUTTGART("hoch", "keine"),
    forecastDay: berlinDay(-1), dateObserved: { "@type": "DateTime", "@value": nowIso() } }] } }));
  assert(!labels(stamped.d).includes("Hitzebelastung"), "yesterday's 'today: hoch' shown as today");
  stamped.w.close();
  const old = await renderStadt(base({ types: { HeatHealthWarning: [{ ...STUTTGART("hoch", "hoch"), forecastDay: berlinDay(-3) }] } }));
  assert(!labels(old.d).includes("Hitzebelastung"), "a three-day-old forecast shown");
  old.w.close();
  // Entities from before forecastDay: the day of dateObserved; neither: not current.
  const legacy = await renderStadt(base({ types: { HeatHealthWarning: [{ ...STUTTGART("mittel", "keine"), forecastDay: undefined,
    dateObserved: { "@type": "DateTime", "@value": nowIso() } }] } }));
  assert.match(tileOf(legacy.d, "Hitzebelastung").value, /mittel/);
  legacy.w.close();
  const undated = await renderStadt(base({ types: { HeatHealthWarning: [{ ...STUTTGART("hoch", "hoch"), forecastDay: undefined }] } }));
  assert(!labels(undated.d).includes("Hitzebelastung"), "a forecast without any date shown");
  undated.w.close();
};

exports["stadt.html: Hitze beyond 50 km stays, marked regional with the distance"] = async () => {
  if (!JSDOM) return;
  const CITIES = [[48.78, 9.18], [47.99, 7.85], [49.49, 8.47], [47.66, 9.18], [48.4, 9.99]];
  const km = (a, b) => { const dy = (a[0] - b[0]) * 111, dx = (a[1] - b[1]) * 111 * Math.cos(a[0] * Math.PI / 180); return Math.hypot(dx, dy); };
  const far = GEM.gemeinden.find(g => Math.min(...CITIES.map(c => km([g[2], g[3]], c))) > 60);
  assert(far, "no municipality far from all five cities");
  const { w, d } = await renderStadt({ row: far, types: { HeatHealthWarning: CITIES.map(([lat, lon], i) => heat("S" + i, lon, lat, "extrem", "extrem")) } });
  const t = tileOf(d, "Hitzebelastung");
  assert(t, `${far[1]}: the warning is hidden`);
  assert.match(t.value, /extrem/);
  assert.match(t.hint, /^morgen: extrem \(regional: Vertreterstadt S\d, ~(\d+) km\)$/);
  assert(Number(t.hint.match(/~(\d+) km/)[1]) > 50);
  w.close();
};

/* ---------- small tile values (E4) ---------- */

exports["stadt.html: humidity, cycling, warnings, pollen and ÖPNV values"] = async () => {
  if (!JSDOM) return;
  const station = { id: "urn:ngsi-ld:WeatherObserved:bw-dwd-04160", type: "WeatherObserved", stationName: P("Metzingen"),
    temperature: P(13), relativeHumidity: P(0.62), location: P({ type: "Point", coordinates: [9.28, 48.53] }) };
  const radSum = { id: "urn:ngsi-ld:TrafficFlowObserved:bw-" + AGS + "-summary", type: "TrafficFlowObserved", ags: P(AGS),
    dailyTotal: P(1234), siteCount: P(2), dateObserved: P({ "@type": "DateTime", "@value": "2026-09-28T00:00:00Z" }) };
  const pollen = { id: "urn:ngsi-ld:PollenForecast:bw-region-112", type: "PollenForecast", name: P("Hohenlohe"),
    kreise: P(["08415"]), arten: P([["Birke", "1", "1"], ["Graeser", "2-3", "2"], ["Beifuss", "2-3", "1"], ["Hasel", "0", "0"]]) };
  const { w, d } = await renderStadt(base({
    types: { WeatherObserved: [station], TrafficFlowObserved: [radSum], PollenForecast: [pollen] },
    abfahrten: () => json({ halt: "Reutlingen ZOB", stopId: "x", stand: nowIso(), medianVerspaetung: null,
      echtzeitAbfahrten: 0, quelle: "EFA-BW", abfahrten: [
        { linie: "7", ziel: "Hauptbahnhof", zeit: berlinClock(5), verspaetung: null },
        { linie: "4", ziel: "Orschel-Hagen", zeit: berlinClock(8), verspaetung: null }] }),
  }));
  assert.match(tileOf(d, "Luftfeuchte").hint, /^Metzingen · \d+,\d km entfernt$/);
  assert.strictEqual(tileOf(d, "Radverkehr").hint, "2 Zählstellen · am 28.09.");
  assert.strictEqual(tileOf(d, "Warnungen").hint, "DWD + NINA, Landkreis Reutlingen");
  const pol = tileOf(d, "Pollenflug");
  assert.match(pol.value, /mittel–hoch/);
  assert.strictEqual(pol.hint, "Gräser, Beifuß");
  const oe = tileOf(d, "ÖPNV");
  assert.strictEqual(oe.value, berlinClock(5) + " · 7", "the query limit instead of the next departure");
  assert.strictEqual(oe.hint, "→ Hauptbahnhof · Reutlingen ZOB");
  w.close();
};

exports["stadt.html: ÖPNV value only from departures still ahead, else '–' with the stand"] = async () => {
  if (!JSDOM) return;
  // /abfahrten has no stop (404): the fallback list of the PublicTransportStop entity.
  const stop = (departures, observedAt = nowIso()) => ({ id: "urn:ngsi-ld:PublicTransportStop:bw-" + AGS, type: "PublicTransportStop",
    ags: P(AGS), name: P("Reutlingen ZOB"), departures: P(departures, { observedAt }),
    dateObserved: P({ "@type": "DateTime", "@value": observedAt }) });
  const dep = (min, line) => ({ line, destination: "Ziel " + line, estimated: berlinClock(min), delayMinutes: null });
  const mixed = await renderStadt(base({ types: { PublicTransportStop: [stop([dep(-30, "1"), dep(-5, "2"), dep(12, "3")])] } }));
  let t = tileOf(mixed.d, "ÖPNV");
  assert.strictEqual(t.value, berlinClock(12) + " · 3", "a past departure as the next one");
  assert.strictEqual(t.hint, "→ Ziel 3 · Reutlingen ZOB");
  mixed.w.close();
  const past = await renderStadt(base({ types: { PublicTransportStop: [stop([dep(-40, "1"), dep(-10, "2")])] } }));
  t = tileOf(past.d, "ÖPNV");
  assert.strictEqual(t.value, "–");
  assert.match(t.hint, /^Reutlingen ZOB · Stand \d\d:\d\d$/);
  past.w.close();
  // An entity older than 3 h: its departures do not count at all.
  const old = await renderStadt(base({ types: { PublicTransportStop: [stop([dep(30, "4")], new Date(Date.now() - 4 * 3600e3).toISOString())] } }));
  t = tileOf(old.d, "ÖPNV");
  assert.strictEqual(t.value, "–");
  assert.match(t.hint, /^Reutlingen ZOB · Stand: /);
  old.w.close();
};

exports["stadt.html: Parken shows free spaces while realtime is current, else the capacity"] = async () => {
  if (!JSDOM) return;
  const pk = (observedAt, free) => ({ id: "urn:ngsi-ld:ParkingSummary:bw-" + AGS, type: "ParkingSummary", ags: P(AGS),
    siteCount: P(12, { observedAt }), totalCapacity: P(2500, { observedAt }),
    ...(free == null ? {} : { realtimeFree: P(free, { observedAt }), realtimeSites: P(5, { observedAt }) }),
    dateObserved: P({ "@type": "DateTime", "@value": observedAt }) });
  const live = await renderStadt(base({ types: { ParkingSummary: [pk(nowIso(), 321)] } }));
  let t = tileOf(live.d, "Parken");
  assert.match(t.value, /^321\s*frei$/);
  assert.strictEqual(t.hint, "in 5 von 12 Anlagen (Echtzeit) · 2.500 Stellplätze");
  live.w.close();
  const stale = await renderStadt(base({ types: { ParkingSummary: [pk(new Date(Date.now() - 9 * 3600e3).toISOString(), 321)] } }));
  t = tileOf(stale.d, "Parken");
  assert.match(t.value, /^2\.500\s*Stellplätze$/);
  assert.match(t.hint, /^12 Anlagen · zuletzt 321 frei \(Stand: /);
  stale.w.close();
  // Realtime gone: parken-bw writes the summary without realtimeFree, the old
  // one stays in the broker (upsert = update), siteCount gets a new observedAt.
  const left = pk(new Date(Date.now() - 9 * 3600e3).toISOString(), 321);
  left.siteCount = P(12, { observedAt: nowIso() });
  left.totalCapacity = P(2500, { observedAt: nowIso() });
  const gone = await renderStadt(base({ types: { ParkingSummary: [left] } }));
  assert.match(tileOf(gone.d, "Parken").value, /^2\.500\s*Stellplätze$/, "an old realtimeFree shown as live");
  gone.w.close();
  const none = await renderStadt(base({ types: { ParkingSummary: [pk(nowIso(), null)] } }));
  assert.match(tileOf(none.d, "Parken").value, /^2\.500\s*Stellplätze$/);
  assert.strictEqual(tileOf(none.d, "Parken").hint, "12 Anlagen · ohne Echtzeit");
  none.w.close();
};

exports["stadt.html: district names match bw-gemeinden.json"] = () => {
  const html = fs.readFileSync(path.join(PUB, "stadt.html"), "utf8");
  const names = new Function(`return ${html.match(/const KREIS_NAME = (\{[\s\S]*?\});/)[1]}`)();
  // The display rule of dashboard.html / kreis.html.
  const expected = Object.fromEntries(GEM.kreise.map(k => [k[0],
    k[4] === "SK" ? "Stadtkreis " + k[1] : /kreis$/i.test(k[1]) ? k[1] : "Landkreis " + k[1]]));
  assert.deepStrictEqual(names, expected);
};

/* ---------- tile order (E5) ---------- */

exports["stadt.html: empty tiles come after every data tile, error tiles keep their place"] = async () => {
  if (!JSDOM) return;
  const { w, d } = await renderStadt(base({
    fail: u => /type=ParkingSummary/.test(u),
    storage: { ["sc-tiles:stadt:" + AGS]: '["parken"]' },
  }));
  const tiles = [...d.querySelectorAll("#tiles > *")];
  const firstEmpty = tiles.findIndex(t => t.classList.contains("tile-empty"));
  assert(firstEmpty > 0, "no empty tile or nothing before it");
  assert(tiles.slice(firstEmpty).every(t => t.classList.contains("tile-empty")), "a data tile after an empty one");
  const order = labels(d);
  assert(order.indexOf("Parken") < order.indexOf("Temperatur"), "the error tile lost its place");
  assert(d.querySelector("#tiles .tile-error"), "no error tile for Parken");
  w.close();
};
