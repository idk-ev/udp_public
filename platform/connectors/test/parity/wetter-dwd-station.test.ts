/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: wetter-dwd-station — FN_DWD_STATIONEN (`udp-rt-w-msgs`) and
 * FN_DWD_BUILD (`udp-rt-w-fn`) against `run(ctx)` on a scripted network.
 *
 * Compared: the station requests (URLs and their ORDER — the old node's
 * `Object.keys` puts an integer-like station id first) and the upserted
 * `WeatherObserved` entities, with the geo context in each of the states the
 * module asks `forRun("DWD", { boundaries: "optional" })` for: master data and
 * boundaries (stations get `ags`/`gemeindeName` by strict lookup), master data
 * only (no assignment, but the stations are written), and no master data (the
 * run is skipped). Plus a station answering 404 and one whose request fails.
 *
 * DELIBERATE DEVIATIONS (module header, data review 2026-10): the values and
 * `dateObserved` carry BrightSky's observation time instead of the run time
 * (the normalisation blanks both stamps; {@link assertObservationStamps} pins
 * them to the recorded `weather.timestamp`, {@link observationTimeOfBrightSky}
 * the edge cases); the names come from DWD's station description files —
 * the old-against-new comparison runs WITHOUT them (answered 404, one
 * `[warn]`), which is BrightSky's name as before, and
 * {@link officialNamesFromTheDescriptionFiles} / {@link namesLoadedWeekly}
 * pin the official ones; the write goes through the split gate with values a
 * station no longer reports deleted ({@link splitGateWritesOnlyWhatChanged});
 * stale stations are pruned ({@link staleStationsArePruned}). A first run has
 * no signatures, so it writes in full — what the old node wrote every hour.
 *
 * Fixtures: wetter-dwd-station-sources.json (real BrightSky source list,
 * trimmed to 53 entries covering every filter branch), one real
 * current_weather answer for four of the seven kept stations (the other three
 * deliberately have none and are answered 404), wetter-dwd-station-geo.json
 * (the master data rows and polygons of the stations' municipalities,
 * extracted from gui/public), and wetter-dwd-station-names-{tu,kl,rr}.json
 * (DWD's station description files, trimmed).
 */

import assert from "node:assert/strict";
import { parse as parseBoundaries, build as buildBoundaries } from "../../src/connectors/grenzen-bw.js";
import { parse as parseMunicipalities } from "../../src/connectors/stammdaten-bw.js";
import {
  build,
  buildStation,
  displayName,
  LIVE_KEY,
  mergeDescriptions,
  NAME_URLS,
  NAMES,
  NAMES_AT,
  namesNearBw,
  normalizedId,
  parse,
  parseDescriptions,
  parseWeather,
  PRUNE_GRACE_MS,
  PRUNE_PATTERN,
  SOURCES_URL,
  STATIC_KEY,
  timestampOf,
} from "../../src/connectors/wetter-dwd-station.js";
import type { StationDescription, Weather } from "../../src/connectors/wetter-dwd-station.js";
import { run } from "../../src/connectors/wetter-dwd-station.js";
import { SignatureStore } from "../../src/kernel/change-gate.js";
import { isArray } from "../../src/kernel/parse.js";
import { needsRefresh } from "../../src/kernel/split-gate.js";
import { persisted } from "../../src/kernel/state.js";
import type { HttpResponse } from "../../src/kernel/types.js";
import { Broker, fixtureGeo, fullGeo, sharedGeo, testCtx } from "../harness/air-energy-kernel.js";
import { messageFromFixture, readFixture } from "../harness/fixtures.js";
import type { GRequest } from "../harness/g-transport.js";
import {
  afterHttpRequest,
  jsonHttp,
  ORION,
  recordingFetcher,
  registryEntry,
  rig,
  upsertedEntities,
} from "../harness/g-transport.js";
import { httpResponse } from "../harness/kernel.js";
import type { SeenRequest } from "../harness/kernel.js";
import { assertEntitiesEqual, isRecord } from "../harness/normalize.js";
import { assertPruneSettings, recordPrunes } from "../harness/prune-settings.js";
import type { PruneSetting } from "../harness/prune-settings.js";
import { runFunctionNode } from "../harness/vm-runner.js";

const RECORDED = ["02159", "04160", "04931", "13965"] as const;

/** Half an hour after the recorded answers' `weather.timestamp` (2026-09-28T03:00Z). */
const FIXTURE_NOW = Date.parse("2026-09-28T03:30:00.000Z");
const FIXTURE_STAMP = "2026-09-28T03:00:00.000Z";
const HOUR = 3_600_000;

/** The one warning of a run without the description files. */
const NAMES_MISSING = /^DWD stations: DWD station list not loadable \(.+\) — BrightSky names where missing$/;

type GeoState = "boundaries" | "municipalities" | "none";

function geoPayload(): { gemeinden: unknown; grenzen: unknown } {
  const payload = readFixture("wetter-dwd-station-geo").payload;
  assert.ok(isRecord(payload));
  return { gemeinden: payload.gemeinden, grenzen: payload.grenzen };
}

/** Station id from a current_weather URL. */
function stationOf(url: string): string {
  return new URL(url).searchParams.get("dwd_station_id") ?? "";
}

function defaultWeather(station: string): HttpResponse | Error {
  const recorded: readonly string[] = RECORDED;
  if (!recorded.includes(station)) return httpResponse(404, '{"detail":"no data"}');
  const fixture = readFixture(`wetter-dwd-station-${station}`);
  return jsonHttp(fixture.statusCode, fixture.payload);
}

/** The text of a recorded description file, in {@link NAME_URLS} order. */
function nameFile(index: number): string {
  const payload = readFixture(`wetter-dwd-station-names-${["tu", "kl", "rr"][index] ?? ""}`).payload;
  assert.ok(typeof payload === "string");
  return payload;
}

/** The description files: served from the fixtures, or `false` for 404. */
function nameAnswer(url: string, served: boolean | ((index: number) => boolean)): HttpResponse {
  const index = NAME_URLS.indexOf(url);
  const serve = typeof served === "function" ? served(index) : served;
  return serve ? httpResponse(200, nameFile(index)) : httpResponse(404, "Not Found");
}

/** An Orion that holds nothing: listings empty, writes confirmed. */
function emptyOrion(request: GRequest): HttpResponse {
  return request.method === "GET" ? jsonHttp(200, [], { "ngsild-results-count": "0" }) : httpResponse(204);
}

interface Side {
  readonly urls: readonly string[];
  readonly entities: unknown[];
  readonly warnings: readonly string[];
}

async function legacy(geo: GeoState, weather: (station: string) => HttpResponse | Error): Promise<Side> {
  const sources = readFixture("wetter-dwd-station-sources");
  const list = await runFunctionNode("udp-rt-w-msgs", { msg: messageFromFixture(sources) });
  const outputs = list.returned;
  assert.ok(Array.isArray(outputs) && Array.isArray(outputs[0]), "one output carrying an array of messages");
  const messages: readonly unknown[] = outputs[0];
  const { gemeinden, grenzen } = geoPayload();
  const global: Record<string, unknown> =
    geo === "none"
      ? {}
      : geo === "municipalities"
        ? { bwGemeinden: gemeinden }
        : { bwGemeinden: gemeinden, bwGrenzen: grenzen };
  const urls: string[] = [];
  const entities: unknown[] = [];
  const warnings: string[] = list.warnings.slice();
  for (const message of messages) {
    assert.ok(isRecord(message) && typeof message.url === "string");
    urls.push(message.url);
    const built = await runFunctionNode("udp-rt-w-fn", {
      msg: afterHttpRequest({ _msgid: "parity", ...message }, weather(stationOf(message.url))),
      flow: Object.fromEntries(list.flow),
      global,
    });
    warnings.push(...built.warnings);
    const returned = built.returned;
    const payload = isRecord(returned) ? returned.payload : undefined;
    if (isArray(payload)) entities.push(...payload);
  }
  return { urls, entities, warnings };
}

async function ported(
  geo: GeoState,
  weather: (station: string) => HttpResponse | Error,
  names = false,
): Promise<Side> {
  const sources = readFixture("wetter-dwd-station-sources");
  const network = recordingFetcher((request: GRequest) => {
    if (request.url.startsWith(ORION)) return emptyOrion(request);
    if (request.url === SOURCES_URL) return jsonHttp(200, sources.payload);
    if (NAME_URLS.includes(request.url)) return nameAnswer(request.url, names);
    return weather(stationOf(request.url));
  });
  const g = rig(registryEntry("wetter-dwd-station"), network.fetcher, () => FIXTURE_NOW);
  const { gemeinden, grenzen } = geoPayload();
  if (geo !== "none") g.kernel.geo.setMunicipalities(parseMunicipalities({ gemeinden }).gemeinden);
  if (geo === "boundaries")
    g.kernel.geo.setBoundaries(buildBoundaries(parseBoundaries(grenzen), null, ""), 0);
  // ctx.now reads the wall clock; the recorded stamps need the fixture's.
  await run({ ...g.ctx, now: () => new Date(FIXTURE_NOW).toISOString() });
  return {
    urls: network.seen
      .filter(
        (request) =>
          !request.url.startsWith(ORION) && request.url !== SOURCES_URL && !NAME_URLS.includes(request.url),
      )
      .map((request) => request.url),
    entities: upsertedEntities(network.seen),
    warnings: g.log.warnings(),
  };
}

/** `dateObserved` of a written entity, or `undefined`. */
function dateObservedOf(entity: unknown): unknown {
  if (!isRecord(entity) || !isRecord(entity.dateObserved) || !isRecord(entity.dateObserved.value)) {
    return undefined;
  }
  return entity.dateObserved.value["@value"];
}

/** Deliberate deviation: every stamp is the recorded observation time, not the run time. */
function assertObservationStamps(entities: readonly unknown[]): void {
  for (const entity of entities) {
    assert.ok(isRecord(entity) && typeof entity.id === "string");
    assert.equal(dateObservedOf(entity), FIXTURE_STAMP, `${entity.id}: dateObserved`);
    for (const [key, value] of Object.entries(entity)) {
      if (isRecord(value) && "observedAt" in value) {
        assert.equal(value.observedAt, FIXTURE_STAMP, `${entity.id}.${key}: observedAt`);
      }
    }
  }
}

async function compare(
  geo: GeoState,
  weather: (station: string) => HttpResponse | Error = defaultWeather,
): Promise<Side> {
  const old = await legacy(geo, weather);
  const now = await ported(geo, weather);
  assert.deepEqual(now.urls, old.urls, `${geo}: station requests or their order differ`);
  assertEntitiesEqual(old.entities, now.entities, {
    labels: { left: `old FN_DWD_BUILD (${geo})`, right: `new run() (${geo})` },
  });
  assertObservationStamps(now.entities);
  return now;
}

async function withBoundaries(): Promise<void> {
  const now = await compare("boundaries");
  assert.equal(now.entities.length, 4, "four stations answered, three got a 404");
  assert.ok(
    now.entities.some((entity) => isRecord(entity) && "ags" in entity),
    "the strict lookup assigned at least one station",
  );
  assert.equal(
    now.urls[0],
    "https://api.brightsky.dev/current_weather?dwd_station_id=13965",
    "Object.keys order",
  );
  assert.equal(now.warnings.length, 1);
  assert.match(now.warnings[0] ?? "", NAMES_MISSING);
}

async function withoutBoundaries(): Promise<void> {
  const now = await compare("municipalities");
  assert.equal(now.entities.length, 4, "boundaries are optional: the stations are still written");
  assert.ok(now.entities.every((entity) => isRecord(entity) && !("ags" in entity)));
}

async function withoutMasterData(): Promise<void> {
  const old = await legacy("none", defaultWeather);
  const now = await ported("none", defaultWeather);
  assert.equal(old.entities.length, 0);
  assert.equal(now.entities.length, 0);
  // The old node warned once per answering station; the port once per run, before any request.
  assert.equal(old.warnings.length, 4);
  assert.equal(now.warnings.length, 1);
  assert.match(now.warnings[0] ?? "", /^DWD: bwGemeinden not in context yet/);
  assert.equal(now.urls.length, 0);
}

async function failedStationRequest(): Promise<void> {
  const now = await compare("boundaries", (station) =>
    station === "04160" ? new Error("connect ETIMEDOUT") : defaultWeather(station),
  );
  assert.equal(now.entities.length, 3);
  assert.equal(now.warnings.length, 2);
  assert.match(now.warnings[0] ?? "", NAMES_MISSING);
  assert.equal(now.warnings[1], "DWD stations: 1 of 7 station requests failed");
}

function recordedBundle(names?: readonly string[]): unknown {
  const sources = readFixture("wetter-dwd-station-sources").payload;
  const weather = Object.fromEntries(
    RECORDED.map((station) => [station, readFixture(`wetter-dwd-station-${station}`).payload]),
  );
  return names === undefined ? { sources, weather } : { sources, weather, names };
}

function moduleParseAndBuild(): void {
  // The module's own entry point on the bundle of the recorded answers.
  const built = build(parse(recordedBundle()), null, "2026-09-28T03:30:00.000Z");
  assert.deepEqual(
    built.map((entity) => entity.id),
    ["13965", "02159", "04160", "04931"].map((id) => `urn:ngsi-ld:WeatherObserved:bw-dwd-${id}`),
  );
  const renningen = built.find((entity) => entity.id.endsWith("04160"));
  assert.equal(
    renningen?.stationName.value,
    "Renng. Ihinger-Hof",
    "without the description files: BrightSky's name, capitals made readable",
  );
}

/* ------------------------------------------------------------------ deliberate deviations */

function weatherAt(timestamp: string | null): Weather {
  return {
    timestamp,
    temperature: 10.5,
    relativeHumidity: 50,
    pressureMsl: null,
    windSpeed10: null,
    windDirection10: null,
    precipitation10: null,
  };
}

function observationTimeOfBrightSky(): void {
  const cases: [stamp: unknown, utc: string | null][] = [
    ["2026-10-06T11:00:00+00:00", "2026-10-06T11:00:00.000Z"],
    ["2026-10-06T13:30:00+02:00", "2026-10-06T11:30:00.000Z"],
    ["2026-10-06T11:00:00Z", "2026-10-06T11:00:00.000Z"],
    // Without a zone the reading would depend on the host.
    ["2026-10-06T11:00:00", null],
    ["2026-10-06", null],
    ["2026-13-45T11:00:00+00:00", null],
    ["", null],
    [null, null],
    [1791284400000, null],
  ];
  for (const [stamp, utc] of cases)
    assert.equal(timestampOf(stamp), utc, `timestampOf(${JSON.stringify(stamp)})`);
  assert.equal(parseWeather(readFixture("wetter-dwd-station-04160").payload)?.timestamp, FIXTURE_STAMP);

  const station = { id: "04160", name: "Renng. Ihinger-Hof", lat: 48.7425, lon: 8.924 };
  const now = "2026-10-06T11:20:00.000Z";
  const entity = buildStation(station, weatherAt("2026-10-06T11:00:00.000Z"), null, now);
  assert.ok(entity !== null);
  assert.equal(dateObservedOf(entity), "2026-10-06T11:00:00.000Z");
  assert.equal(entity.temperature?.observedAt, "2026-10-06T11:00:00.000Z");
  assert.equal(entity.relativeHumidity?.observedAt, "2026-10-06T11:00:00.000Z");
  assert.equal(entity.relativeHumidity.value, 0.5);
  // Later than the run: no measurement. No stamp: cannot be dated. A week old: not current.
  assert.equal(buildStation(station, weatherAt("2026-10-06T11:30:00.000Z"), null, now), null);
  assert.equal(buildStation(station, weatherAt(null), null, now), null);
  const week = new Date(Date.parse(now) - PRUNE_GRACE_MS).toISOString();
  assert.ok(buildStation(station, weatherAt(week), null, now) !== null, "exactly a week is still written");
  const older = new Date(Date.parse(now) - PRUNE_GRACE_MS - 1).toISOString();
  assert.equal(buildStation(station, weatherAt(older), null, now), null);
}

function officialNamesFromTheDescriptionFiles(): void {
  const [tu, kl, rr] = [0, 1, 2].map((index) => parseDescriptions(nameFile(index)));
  assert.ok(tu !== undefined && kl !== undefined && rr !== undefined);
  assert.deepEqual([tu.length, kl.length, rr.length], [10, 11, 13], "every row, the two header lines not");
  // ISO-8859-1 decoded by the fetcher: the umlaut is a character, not a replacement.
  assert.deepEqual(
    tu.find((row) => row.id === "01076"),
    { id: "01076", until: "20090101", lat: 48.0135, lon: 8.5343, name: "Dürrheim, Bad" },
  );
  // A name that fills its 41-character column, one blank before the Bundesland.
  assert.equal(rr.find((row) => row.id === "19289")?.name, "Hannover (Kleingartenverein Farrelheide)");

  // Per id the latest end date: Herrenberg's daily climate row ended in 1985,
  // its precipitation row is current.
  const merged = mergeDescriptions([tu, kl, rr]);
  assert.equal(merged.get("02159")?.until, "20261005");
  assert.equal(merged.get("01076")?.until, "20090101");
  const row = (until: string, name: string): StationDescription => ({
    id: "00001",
    until,
    lat: 48,
    lon: 9,
    name,
  });
  assert.equal(
    mergeDescriptions([[row("20001231", "Alt")], [row("20261005", "Neu")]]).get("00001")?.name,
    "Neu",
  );
  assert.equal(
    mergeDescriptions([[row("20261005", "Erst")], [row("20261005", "Zweit")]]).get("00001")?.name,
    "Erst",
  );
  assert.equal(
    mergeDescriptions([[row("20261005", "Neu")], [row("20001231", "Alt")]]).get("00001")?.name,
    "Neu",
  );

  // Only stations in and around the BW box are kept.
  const names = namesNearBw(merged);
  assert.equal(names.get("04160"), "Renningen-Ihinger Hof");
  assert.equal(names.get("03257"), "Mergentheim, Bad");
  assert.ok(!names.has("00003"), "Aachen kept");
  assert.ok(!names.has("19289"), "Hannover kept");

  // The name column is as wide as its dash group; lines that are no row are skipped.
  const narrow = [
    "Stations_id von_datum bis_datum Stationshoehe geoBreite geoLaenge Stationsname Bundesland Abgabe",
    "----- -------- -------- --- ---- --- ---------- ----------------- ----",
    "00001 20000101 20261005 100 48.0 9.0 Bad Name X Baden-Württemberg Frei",
    "",
    "keine Zeile",
    "00002 2000 20261005 100 48.0 9.0 Kaputt",
  ].join("\r\n");
  assert.deepEqual(
    parseDescriptions(narrow).map((r) => r.name),
    ["Bad Name X"],
  );
  assert.deepEqual(parseDescriptions(""), []);

  assert.equal(normalizedId("4160"), "04160");
  assert.equal(normalizedId("04160"), "04160");
  assert.equal(normalizedId("K988"), "K988");

  const display: [raw: string, shown: string][] = [
    ["Mergentheim, Bad", "Bad Mergentheim"],
    ["Waldsee, Bad-Reute", "Bad Waldsee-Reute"],
    ["Säckingen, Bad (Bergseestr.)", "Bad Säckingen (Bergseestr.)"],
    ["Dürrheim, Bad", "Bad Dürrheim"],
    // BrightSky's own spellings, the fallback.
    ["BAD BERGZABERN", "Bad Bergzabern"],
    ["Wildbad, Bad-Calmbac", "Bad Wildbad-Calmbac"],
    ["RENNG. IHINGER-HOF", "Renng. Ihinger-Hof"],
    // Qualifiers after a comma are no inversion.
    ["Altheim, Kreis Biberach", "Altheim, Kreis Biberach"],
    ["Buchen, Kr. Neckar-Odenwald", "Buchen, Kr. Neckar-Odenwald"],
    ["Badenweiler", "Badenweiler"],
    ["Baden-Baden-Geroldsau", "Baden-Baden-Geroldsau"],
    ["Feldberg/Schwarzwald", "Feldberg/Schwarzwald"],
  ];
  for (const [raw, shown] of display) assert.equal(displayName(raw), shown, `displayName(${raw})`);

  // Through the module's entry point: the official names, BrightSky's where
  // the files lack the id.
  const built = build(parse(recordedBundle([0, 1, 2].map(nameFile))), null, "2026-09-28T03:30:00.000Z");
  assert.deepEqual(
    built.map((entity) => [entity.dwdStationId.value, entity.stationName.value, entity.dataProvider.value]),
    [
      ["13965", "Balingen-Bronnhaupten", "BrightSky/DWD (Balingen-Bronnhaupten)"],
      ["02159", "Herrenberg", "BrightSky/DWD (Herrenberg)"],
      ["04160", "Renningen-Ihinger Hof", "BrightSky/DWD (Renningen-Ihinger Hof)"],
      ["04931", "Stuttgart-Echterdingen", "BrightSky/DWD (Stuttgart-Echterdingen)"],
    ],
  );
  const fallback = build(
    parse(recordedBundle([nameFile(0).replace(/^04160 .*$/m, "")])),
    null,
    "2026-09-28T03:30:00.000Z",
  );
  assert.equal(
    fallback.find((entity) => entity.id.endsWith("04160"))?.stationName.value,
    "Renng. Ihinger-Hof",
  );

  // The persisted form of the names survives a round trip.
  const codec = persisted.stringMap;
  const stored = new Map([
    ["04160", "Renningen-Ihinger Hof"],
    ["01076", "Dürrheim, Bad"],
  ]);
  assert.deepEqual(codec.decode(JSON.parse(JSON.stringify(codec.encode(stored)))), stored);
  assert.equal(codec.decode([["04160", 7]]), undefined);
}

async function namesLoadedWeekly(): Promise<void> {
  const sources = readFixture("wetter-dwd-station-sources");
  let clock = FIXTURE_NOW;
  let served: (index: number) => boolean = () => false;
  const network = recordingFetcher((request: GRequest) => {
    if (request.url.startsWith(ORION)) return emptyOrion(request);
    if (request.url === SOURCES_URL) return jsonHttp(200, sources.payload);
    if (NAME_URLS.includes(request.url)) return nameAnswer(request.url, served);
    return defaultWeather(stationOf(request.url));
  });
  const g = rig(registryEntry("wetter-dwd-station"), network.fetcher, () => clock);
  g.kernel.geo.setMunicipalities(parseMunicipalities({ gemeinden: geoPayload().gemeinden }).gemeinden);
  const ctx = { ...g.ctx, now: () => new Date(clock).toISOString() };
  const nameRequests = (): GRequest[] => network.seen.filter((request) => NAME_URLS.includes(request.url));
  const nameOf = (id: string): unknown => {
    const entity = upsertedEntities(network.seen)
      .filter((e) => isRecord(e) && e.id === `urn:ngsi-ld:WeatherObserved:bw-dwd-${id}`)
      .at(-1);
    return isRecord(entity) && isRecord(entity.stationName) ? entity.stationName.value : undefined;
  };

  // Unavailable: BrightSky's names, one warning, no new attempt for six hours.
  await run(ctx);
  assert.equal(nameRequests().length, 3);
  assert.equal(nameRequests()[0]?.options?.encoding, "latin1", "the files are ISO-8859-1");
  assert.equal(nameOf("04160"), "Renng. Ihinger-Hof");
  assert.equal(g.log.warnings().filter((w) => NAMES_MISSING.test(w)).length, 1);
  clock += HOUR;
  await run(ctx);
  assert.equal(nameRequests().length, 3, "asked again within six hours");

  // Partly available: the names of the files that came, but no week of rest.
  served = (index) => index !== 0;
  clock = FIXTURE_NOW + 6 * HOUR;
  await run(ctx);
  assert.equal(nameRequests().length, 6);
  assert.equal(g.ctx.state.slot(NAMES).get().get("04160"), "Renningen-Ihinger Hof");
  assert.equal(g.ctx.state.slot(NAMES_AT).get(), 0, "a partial load counts as complete");

  // Complete: stored, and not asked again for a week.
  served = () => true;
  clock = FIXTURE_NOW + 12 * HOUR;
  await run(ctx);
  assert.equal(nameRequests().length, 9);
  assert.equal(g.ctx.state.slot(NAMES_AT).get(), clock);
  clock += 24 * HOUR;
  await run(ctx);
  clock = FIXTURE_NOW + 12 * HOUR + 7 * 24 * HOUR - 1;
  await run(ctx);
  assert.equal(nameRequests().length, 9, "asked again within the week");
  clock += 1;
  await run(ctx);
  assert.equal(nameRequests().length, 12, "not asked again after a week");
}

/** The recorded answer of a station, its `weather` changed by `edit`. */
function editedWeather(
  station: string,
  edit: (weather: Record<string, unknown>) => Record<string, unknown>,
): HttpResponse {
  const payload = structuredClone(readFixture(`wetter-dwd-station-${station}`).payload);
  assert.ok(isRecord(payload) && isRecord(payload.weather));
  return jsonHttp(200, { ...payload, weather: edit(payload.weather) });
}

async function splitGateWritesOnlyWhatChanged(): Promise<void> {
  const geo = sharedGeo(fixtureGeo());
  const sources = readFixture("wetter-dwd-station-sources").payload;
  const override = new Map<string, HttpResponse>();
  const deleted: string[] = [];
  const store = new SignatureStore();
  const tableSizes = (): number[] =>
    [STATIC_KEY, LIVE_KEY].map((key) => store.scope("wetter-dwd-station").size(key));
  // The broker as the old writes left it: Renningen with a wind speed it no longer reports.
  const broker = new Broker([
    {
      id: "urn:ngsi-ld:WeatherObserved:bw-dwd-04160",
      type: "WeatherObserved",
      temperature: { type: "Property", value: 14.8, observedAt: "2026-09-28T03:12:00.000Z" },
      windSpeed: { type: "Property", value: 3.2, observedAt: "2026-09-20T10:12:00.000Z" },
    },
  ]);
  const respond = (request: SeenRequest): HttpResponse | Error => {
    const url = request.url.href;
    if (url === SOURCES_URL) return jsonHttp(200, sources);
    if (NAME_URLS.includes(url)) return nameAnswer(url, true);
    if (request.url.host === "api.brightsky.dev") {
      const station = request.url.searchParams.get("dwd_station_id") ?? "";
      return override.get(station) ?? defaultWeather(station);
    }
    if (request.method === "DELETE") {
      deleted.push(decodeURIComponent(request.url.pathname));
      return httpResponse(204);
    }
    return broker.respond(request);
  };
  const runAt = async (nowMs: number): Promise<unknown[]> => {
    const before = broker.upserts.length;
    const { ctx, log } = testCtx("wetter-dwd-station", geo, respond, { nowMs: () => nowMs, store });
    await run(ctx);
    assert.deepEqual(log.warnings(), []);
    return broker.upserts.slice(before).flat();
  };
  const renningen = "urn:ngsi-ld:WeatherObserved:bw-dwd-04160";
  const echterdingen = "urn:ngsi-ld:WeatherObserved:bw-dwd-04931";

  // First run: the dynamic table seeded from the broker, the static one not —
  // every station in full once, and the value left behind deleted.
  const first = await runAt(FIXTURE_NOW);
  assert.equal(first.length, 4);
  assert.ok(first.every((entity) => isRecord(entity) && "stationName" in entity && "location" in entity));
  assert.deepEqual(deleted, [`/ngsi-ld/v1/entities/${renningen}/attrs/windSpeed`]);
  assert.deepEqual(tableSizes(), [4, 4]);

  // An hour later, nothing new from BrightSky: the unchanged dateObserved only,
  // except a station whose weekly full write falls on this run.
  let nowMs = FIXTURE_NOW + HOUR;
  const second = await runAt(nowMs);
  assert.equal(second.length, 4);
  for (const entity of second) {
    assert.ok(isRecord(entity) && typeof entity.id === "string");
    if (needsRefresh(entity.id, nowMs)) continue;
    assert.deepEqual(Object.keys(entity).sort(), ["@context", "dateObserved", "id", "type"]);
    assert.equal(dateObservedOf(entity), FIXTURE_STAMP);
  }
  assert.equal(deleted.length, 1, "deleted again although the signature no longer holds it");

  // A new observation at Echterdingen with one changed value: that value and dateObserved.
  override.set(
    "04931",
    editedWeather("04931", (weather) => ({
      ...weather,
      timestamp: "2026-09-28T04:00:00+00:00",
      temperature: 12.4,
    })),
  );
  nowMs = FIXTURE_NOW + 2 * HOUR;
  while (needsRefresh(echterdingen, nowMs)) nowMs += HOUR;
  const third = await runAt(nowMs);
  const partial = third.find((entity) => isRecord(entity) && entity.id === echterdingen);
  assert.ok(isRecord(partial));
  assert.deepEqual(Object.keys(partial).sort(), ["@context", "dateObserved", "id", "temperature", "type"]);
  assert.equal(dateObservedOf(partial), "2026-09-28T04:00:00.000Z");
  assert.ok(isRecord(partial.temperature) && partial.temperature.observedAt === "2026-09-28T04:00:00.000Z");

  // Echterdingen stops reporting wind: written in full, both wind values deleted.
  override.set(
    "04931",
    editedWeather("04931", (weather) => ({
      ...weather,
      timestamp: "2026-09-28T04:30:00+00:00",
      temperature: 12.4,
      wind_speed_10: null,
      wind_direction_10: null,
    })),
  );
  nowMs += HOUR;
  const fourth = await runAt(nowMs);
  const full = fourth.find((entity) => isRecord(entity) && entity.id === echterdingen);
  assert.ok(isRecord(full) && "stationName" in full && !("windSpeed" in full));
  assert.deepEqual(deleted.slice(1), [
    `/ngsi-ld/v1/entities/${echterdingen}/attrs/windSpeed`,
    `/ngsi-ld/v1/entities/${echterdingen}/attrs/windDirection`,
  ]);
  await runAt(nowMs + HOUR);
  assert.equal(deleted.length, 3, "deleted again");

  // A station whose request fails: merge mode, its signatures survive.
  override.set("04931", httpResponse(503, "busy"));
  await runAt(nowMs + 2 * HOUR);
  assert.deepEqual(tableSizes(), [4, 4]);
  // Every station answered, one with a 404: replace mode drops it.
  override.set("04931", httpResponse(404, '{"detail":"no data"}'));
  await runAt(nowMs + 3 * HOUR);
  assert.deepEqual(tableSizes(), [3, 3]);
}

async function staleStationsArePruned(): Promise<void> {
  const geo = sharedGeo(fullGeo());
  const sources = readFixture("wetter-dwd-station-sources").payload;
  const tenDaysAgo = new Date(FIXTURE_NOW - 10 * 24 * HOUR).toISOString();
  const stale = (id: string): Record<string, unknown> => ({
    id,
    type: "WeatherObserved",
    dateObserved: { type: "Property", value: { "@type": "DateTime", "@value": tenDaysAgo } },
  });
  const gone = "urn:ngsi-ld:WeatherObserved:bw-dwd-04016";
  // wetter-bw's entity of a municipality: the same type, never this prune's.
  const foreign = "urn:ngsi-ld:WeatherObserved:bw-08415061";
  const broker = new Broker([stale(gone), stale(foreign)]);
  const respond = (request: SeenRequest): HttpResponse | Error => {
    const url = request.url.href;
    if (url === SOURCES_URL) return jsonHttp(200, sources);
    if (NAME_URLS.includes(url)) return nameAnswer(url, true);
    if (request.url.host === "api.brightsky.dev") {
      return defaultWeather(request.url.searchParams.get("dwd_station_id") ?? "");
    }
    return broker.respond(request);
  };
  let clock = FIXTURE_NOW;
  const base = testCtx("wetter-dwd-station", geo, respond, { nowMs: () => clock });
  const { ctx, calls } = recordPrunes(base.ctx);

  await run(ctx);
  assert.deepEqual(broker.deletes, [], "the first run of a prune never deletes");
  clock += HOUR;
  await run(ctx);
  assert.deepEqual(broker.deletes, [[gone]]);
  assert.ok(broker.entities.has(foreign), "a foreign WeatherObserved was touched");
  assert.deepEqual(base.log.warnings(), []);

  // The old flow had no prune here (deliberate deviation): the settings are
  // compared against the decision instead of an old option object.
  const decided: PruneSetting[] = [
    {
      type: "WeatherObserved",
      pattern: PRUNE_PATTERN,
      attrs: ["dateObserved"],
      exclude: null,
      graceMs: 7 * 24 * HOUR,
      confirmKey: null,
      confirmMs: null,
      liveMs: 3 * HOUR,
      maxFraction: 0.3,
      intervalMs: HOUR,
      forgetsSignatures: true,
      keep: true,
      accept: false,
    },
  ];
  assertPruneSettings("wetter-dwd-station", decided, calls, ctx);
  // Its own bookkeeping: a label, type and pattern no other connector uses.
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.label, "DWD stations");
  assert.equal(call.type, "WeatherObserved");
  assert.equal(call.pattern, PRUNE_PATTERN);
  assert.equal(call.graceMs, 7 * 24 * HOUR);
  assert.equal(call.backlogMs, 14 * 24 * HOUR);
  assert.equal(call.liveMs, 3 * HOUR);
  assert.equal(call.signatureKey, STATIC_KEY);
  assert.deepEqual(call.signatureKeys, [LIVE_KEY]);
  assert.deepEqual(
    [...(call.keep ?? [])].sort(),
    ["02159", "04160", "04931", "13965"].map((id) => `urn:ngsi-ld:WeatherObserved:bw-dwd-${id}`),
  );
  const pattern = new RegExp(PRUNE_PATTERN);
  assert.ok(pattern.test("urn:ngsi-ld:WeatherObserved:bw-dwd-04160"));
  assert.ok(!pattern.test(foreign));
  assert.ok(!pattern.test("urn:ngsi-ld:WeatherObserved:demo-station-1"));
  assert.ok(!pattern.test("urn:ngsi-ld:WeatherObserved:bw-dwd-04160x:y"));
}

export {
  withBoundaries as "wetter-dwd-station: requests, order and entities with ags match the old nodes (master data + boundaries)",
  withoutBoundaries as "wetter-dwd-station: without boundaries the stations are written without ags, as before",
  withoutMasterData as "wetter-dwd-station: without master data nothing is written (one warning instead of one per station)",
  failedStationRequest as "wetter-dwd-station: a failed station request drops that station and is counted in one warning",
  moduleParseAndBuild as "wetter-dwd-station: module parse/build on the recorded bundle",
  observationTimeOfBrightSky as "wetter-dwd-station: BrightSky's observation time, not the run time; future, undated and week-old stamps not written (deliberate deviation)",
  officialNamesFromTheDescriptionFiles as "wetter-dwd-station: official names from DWD's description files — latin-1, fixed width, latest end date, 'X, Bad' inverted, BrightSky as fallback (deliberate deviation)",
  namesLoadedWeekly as "wetter-dwd-station: the description files are loaded weekly, a failure retried after 6 h, a partial load not counted (deliberate deviation)",
  splitGateWritesOnlyWhatChanged as "wetter-dwd-station: split gate — full first run, stamp-only, only the changed value, values no longer reported deleted (deliberate deviation)",
  staleStationsArePruned as "wetter-dwd-station: stations not written for 7 days are pruned with their own bookkeeping, foreign ids untouched (deliberate deviation)",
};
