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
 * Fixtures: wetter-dwd-station-sources.json (real BrightSky source list,
 * trimmed to 53 entries covering every filter branch), one real
 * current_weather answer for four of the seven kept stations (the other three
 * deliberately have none and are answered 404), and wetter-dwd-station-geo.json (the master data rows and
 * polygons of the stations' municipalities, extracted from gui/public).
 */

import assert from "node:assert/strict";
import { parse as parseBoundaries, build as buildBoundaries } from "../../src/connectors/grenzen-bw.js";
import { parse as parseMunicipalities } from "../../src/connectors/stammdaten-bw.js";
import { build, parse, SOURCES_URL } from "../../src/connectors/wetter-dwd-station.js";
import { run } from "../../src/connectors/wetter-dwd-station.js";
import { isArray } from "../../src/kernel/parse.js";
import type { HttpResponse } from "../../src/kernel/types.js";
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
import { assertClockStamps, assertEntitiesEqual, isRecord, openClock } from "../harness/normalize.js";
import { runFunctionNode } from "../harness/vm-runner.js";

const RECORDED = ["02159", "04160", "04931", "13965"] as const;

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

async function ported(geo: GeoState, weather: (station: string) => HttpResponse | Error): Promise<Side> {
  const sources = readFixture("wetter-dwd-station-sources");
  const network = recordingFetcher((request: GRequest) => {
    if (request.url.startsWith(ORION)) return httpResponse(204);
    if (request.url === SOURCES_URL) return jsonHttp(200, sources.payload);
    return weather(stationOf(request.url));
  });
  const g = rig(registryEntry("wetter-dwd-station"), network.fetcher);
  const { gemeinden, grenzen } = geoPayload();
  if (geo !== "none") g.kernel.geo.setMunicipalities(parseMunicipalities({ gemeinden }).gemeinden);
  if (geo === "boundaries")
    g.kernel.geo.setBoundaries(buildBoundaries(parseBoundaries(grenzen), null, ""), 0);
  await run(g.ctx);
  return {
    urls: network.seen
      .filter((request) => !request.url.startsWith(ORION) && request.url !== SOURCES_URL)
      .map((request) => request.url),
    entities: upsertedEntities(network.seen),
    warnings: g.log.warnings(),
  };
}

async function compare(
  geo: GeoState,
  weather: (station: string) => HttpResponse | Error = defaultWeather,
): Promise<Side> {
  const legacyClock = openClock();
  const old = await legacy(geo, weather);
  const legacyWindow = legacyClock.close();
  const portClock = openClock();
  const now = await ported(geo, weather);
  const portWindow = portClock.close();
  assert.deepEqual(now.urls, old.urls, `${geo}: station requests or their order differ`);
  assertEntitiesEqual(old.entities, now.entities, {
    labels: { left: `old FN_DWD_BUILD (${geo})`, right: `new run() (${geo})` },
  });
  if (old.entities.length > 0) {
    assertClockStamps(old.entities, now.entities, { legacy: legacyWindow, ported: portWindow });
  }
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
  assert.deepEqual(now.warnings, []);
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
  assert.deepEqual(now.warnings, ["DWD stations: 1 of 7 station requests failed"]);
}

function moduleParseAndBuild(): void {
  // The module's own entry point on the bundle of the recorded answers.
  const sources = readFixture("wetter-dwd-station-sources").payload;
  const weather = Object.fromEntries(
    RECORDED.map((station) => [station, readFixture(`wetter-dwd-station-${station}`).payload]),
  );
  const built = build(parse({ sources, weather }), null, "2026-09-28T03:30:00.000Z");
  assert.deepEqual(
    built.map((entity) => entity.id),
    ["13965", "02159", "04160", "04931"].map((id) => `urn:ngsi-ld:WeatherObserved:bw-dwd-${id}`),
  );
  const renningen = built.find((entity) => entity.id.endsWith("04160"));
  assert.equal(renningen?.stationName.value, "Renng. Ihinger-Hof", "names in capitals are made readable");
}

export {
  withBoundaries as "wetter-dwd-station: requests, order and entities with ags match the old nodes (master data + boundaries)",
  withoutBoundaries as "wetter-dwd-station: without boundaries the stations are written without ags, as before",
  withoutMasterData as "wetter-dwd-station: without master data nothing is written (one warning instead of one per station)",
  failedStationRequest as "wetter-dwd-station: a failed station request drops that station and is counted in one warning",
  moduleParseAndBuild as "wetter-dwd-station: module parse/build on the recorded bundle",
};
