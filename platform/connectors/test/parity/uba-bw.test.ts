/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: uba-bw — the station selection `udp-rt-bu-msgs`, the wrapper
 * `udp-rt-bu-wrap` and the build node `udp-rt-bu-build` against
 * `planRequests`, `wrapResponse` and `parse` + `build` of the port, and a whole
 * `run(ctx)` against what the old nodes would have written.
 *
 * The point of interest is the assignment: this is the one connector allowed
 * to fall back to the nearest municipality centre. On the trimmed geo fixture
 * (Upper Rhine strip, Mannheim, Ulm, Aalen, Heidenheim) the stations in those
 * places hit a polygon, the other ~25 DEBW stations (Stuttgart, Karlsruhe,
 * Konstanz, …) have none and go by centroid — both paths are asserted to be
 * exercised, and a run without any boundaries puts every station on the
 * centroid path.
 *
 * DELIBERATE DEVIATIONS (module header): the requests go to the target of
 * the old URLs' 301 ({@link moved}); every value carries the end of its own
 * measurement hour as `observedAt` and the entity a `dateObserved`, where the
 * old node stamped the run time and wrote no `dateObserved` — compared old
 * against new without it ({@link asOld}; `observedAt` is blanked by the
 * normalisation either way), pinned by {@link measurementTimeOfEachValue} and
 * {@link cetStampsToUtc}; and the write goes through the split gate, pinned
 * by {@link splitGateWritesOnlyWhatChanged}. A first run has no signatures,
 * so it writes in full — what the old node wrote every hour.
 *
 * Fixtures: test/fixtures/uba-bw.json (station list) and
 * uba-bw-airquality.json (the 40 per-station answers), see their notes.
 */

import assert from "node:assert/strict";
import {
  build,
  cetToUtc,
  LIVE_KEY,
  parse,
  planRequests,
  run,
  STATIC_KEY,
  wrapResponse,
} from "../../src/connectors/uba-bw.js";
import type { UbaPart } from "../../src/connectors/uba-bw.js";
import { SignatureStore } from "../../src/kernel/change-gate.js";
import { isArray } from "../../src/kernel/parse.js";
import { needsRefresh } from "../../src/kernel/split-gate.js";
import type { GeoIndex, HttpResponse } from "../../src/kernel/types.js";
import {
  Broker,
  fixtureGeo,
  legacyChunkSizes,
  legacyEntities,
  legacyGlobal,
  sharedGeo,
  testCtx,
} from "../harness/air-energy-kernel.js";
import type { RawGeo } from "../harness/air-energy-kernel.js";
import { messageFromFixture, readFixture } from "../harness/fixtures.js";
import { httpResponse } from "../harness/kernel.js";
import type { SeenRequest } from "../harness/kernel.js";
import { assertEntitiesEqual, isRecord, normalize, openClock } from "../harness/normalize.js";
import { messagesOf, runFunctionNode } from "../harness/vm-runner.js";

const MSGS_NODE = "udp-rt-bu-msgs";
const WRAP_NODE = "udp-rt-bu-wrap";
const BUILD_NODE = "udp-rt-bu-build";

/** The host the port fetches from: the target of the old URLs' 301. */
const HOST = "luftdaten.umweltbundesamt.de";
const OLD_BASE = "https://www.umweltbundesamt.de/api/air_data/v3/";
const NEW_BASE = "https://luftdaten.umweltbundesamt.de/api/air-data/v3/";

/** An old URL where its 301 leads (deviation, see the header); anything else unchanged. */
function moved(url: unknown): unknown {
  return typeof url === "string" && url.startsWith(OLD_BASE) ? NEW_BASE + url.slice(OLD_BASE.length) : url;
}

/** Ported entities without `dateObserved`, which the old node did not write (see the header). */
function asOld(entities: readonly unknown[] | undefined): unknown[] {
  return (entities ?? []).map((entity) =>
    isRecord(entity)
      ? Object.fromEntries(Object.entries(entity).filter(([key]) => key !== "dateObserved"))
      : entity,
  );
}

/** `{ statusCode, payload }` per station id, as recorded. */
function answers(): Map<string, { statusCode: number; payload: unknown }> {
  const payload = readFixture("uba-bw-airquality").payload;
  assert.ok(isRecord(payload));
  const out = new Map<string, { statusCode: number; payload: unknown }>();
  for (const [id, answer] of Object.entries(payload)) {
    assert.ok(isRecord(answer) && typeof answer.statusCode === "number");
    out.set(id, { statusCode: answer.statusCode, payload: answer.payload });
  }
  return out;
}

/** The joined parts as the old wrap node produced them, in request order. */
async function legacyParts(): Promise<unknown[]> {
  const requests = planRequests(readFixture("uba-bw").payload, Date.now());
  assert.ok(requests !== null);
  const recorded = answers();
  const parts: unknown[] = [];
  for (const request of requests) {
    const answer = recorded.get(request.station.id);
    assert.ok(answer !== undefined, `no recorded answer for station ${request.station.id}`);
    const wrapped = await runFunctionNode(WRAP_NODE, {
      msg: {
        _msgid: "parity",
        station: request.station,
        statusCode: answer.statusCode,
        payload: structuredClone(answer.payload),
      },
    });
    const message = messagesOf(wrapped)[0];
    parts.push(isRecord(message) ? message.payload : undefined);
  }
  return parts;
}

async function legacyBuild(parts: unknown, geo: RawGeo, boundaries = true) {
  return runFunctionNode(BUILD_NODE, {
    msg: { _msgid: "parity", payload: structuredClone(parts) },
    global: legacyGlobal(geo, { boundaries }),
  });
}

function index(geo: RawGeo, boundaries = true): GeoIndex {
  return sharedGeo(geo, { boundaries }).index();
}

async function stationSelectionIsIdentical(): Promise<void> {
  const fixture = readFixture("uba-bw");
  const before = Date.now();
  const legacy = await runFunctionNode(MSGS_NODE, { msg: messageFromFixture(fixture) });
  const after = Date.now();
  assert.ok(
    messagesOf(legacy).every((message) => isRecord(message) && String(message.url).startsWith(OLD_BASE)),
    "the old node no longer requests the old base URL – revisit the deviation",
  );
  const legacyRequests = normalize(
    messagesOf(legacy).map((message) =>
      isRecord(message) ? { url: moved(message.url), station: message.station } : null,
    ),
  );
  // The dates come from the clock; the two runs straddle midnight at most once.
  const candidates = [before, after].map((ms) => normalize(planRequests(fixture.payload, ms)));
  assert.ok(
    candidates.some((ported) => JSON.stringify(ported) === JSON.stringify(legacyRequests)),
    `station requests differ:\n${JSON.stringify(legacyRequests).slice(0, 400)}\n${JSON.stringify(candidates[0]).slice(0, 400)}`,
  );
  assert.equal(messagesOf(legacy).length, 40, "40 active DEBW stations of 45; the 8 foreign ones dropped");
  assert.deepEqual(normalize(legacy.status), [{ text: "40 BW-Stationen" }]);

  // An unusable list: the old node warned and stopped, the port answers null.
  const broken = await runFunctionNode(MSGS_NODE, {
    msg: { ...messageFromFixture(fixture), statusCode: 503, payload: "busy" },
  });
  assert.equal(broken.warnings.length, 1);
  assert.equal(planRequests("busy", Date.now()), null);
}

async function wrapperIsIdentical(): Promise<void> {
  const requests = planRequests(readFixture("uba-bw").payload, Date.now());
  assert.ok(requests !== null);
  const station = requests[0]?.station;
  assert.ok(station !== undefined);
  const cases: [status: number, payload: unknown][] = [
    [200, answers().get(station.id)?.payload],
    [200, { data: {} }],
    [200, "<html>not json</html>"],
    [404, { data: { x: 1 } }],
    [500, null],
  ];
  for (const [status, payload] of cases) {
    const legacy = await runFunctionNode(WRAP_NODE, {
      msg: { _msgid: "parity", station, statusCode: status, payload },
    });
    const message = messagesOf(legacy)[0];
    assert.deepEqual(
      normalize(isRecord(message) ? message.payload : undefined),
      normalize(wrapResponse(station, status, payload)),
      `wrap differs for HTTP ${String(status)}`,
    );
  }
}

async function entitiesAreIdenticalWithStrictAndCentroidAssignment(): Promise<void> {
  const geo = fixtureGeo();
  const parts = await legacyParts();
  const legacy = await legacyBuild(parts, geo);
  const geoIndex = index(geo);
  const ported = build(parse(parts), geoIndex, new Date().toISOString());

  assert.deepEqual(legacy.warnings, []);
  // 40 stations requested; DEBW118 and DEBW117 answered without data.
  assert.equal(ported.length, 38);
  assertEntitiesEqual(legacyEntities(legacy), asOld(ported));
  assert.deepEqual(legacyChunkSizes(legacy), [38]);

  // Both assignment paths must really be exercised.
  const strict = ported.filter((entity) => {
    const [lon, lat] = entity.location.value.coordinates;
    return geoIndex.agsAt(lat, lon) !== null;
  });
  assert.ok(strict.length >= 8, `strict polygon hits: ${String(strict.length)}`);
  assert.ok(ported.length - strict.length >= 15, "stations outside the fixture polygons go by centroid");
  const byCode = new Map(ported.map((entity) => [entity.id, entity.ags.value]));
  assert.equal(
    byCode.get("urn:ngsi-ld:AirQualityObserved:bw-uba-DEBW084"),
    "08311000",
    "Freiburg by polygon",
  );
  // Stuttgart has no polygon in the trimmed fixture: nearest centre among the 167 rows.
  const stuttgart = byCode.get("urn:ngsi-ld:AirQualityObserved:bw-uba-DEBW013");
  assert.ok(stuttgart !== undefined && stuttgart !== "", "Stuttgart still gets a municipality (centroid)");
}

async function withoutBoundariesEveryStationGoesByCentroid(): Promise<void> {
  const geo = fixtureGeo();
  const parts = await legacyParts();
  const legacy = await legacyBuild(parts, geo, false);
  const ported = build(parse(parts), index(geo, false), new Date().toISOString());
  assert.deepEqual(legacy.warnings, [], "the old node did not skip without boundaries");
  assertEntitiesEqual(legacyEntities(legacy), asOld(ported));
  assert.ok(ported.every((entity) => entity.ags.value !== ""));
}

async function partialAndMalformedSeries(): Promise<void> {
  // Rows with a null total index, a component without value and an unknown
  // component id; a part that failed; a part for a station without series.
  const station = { id: "900", code: "DEBW900", name: "Test'Station", lon: 7.85, lat: 48.0 };
  const other = { id: "901", code: "DEBW901", name: "Leer", lon: 9.18, lat: 48.77 };
  const parts: UbaPart[] = [
    {
      station,
      ok: true,
      data: {
        "900": {
          "2026-09-28 01:00:00": ["2026-09-28 02:00:00", null, 0, [3, null, 1, "1"], [7, 5, 0, "0.1"]],
          "2026-09-28 00:00:00": ["2026-09-28 01:00:00", 2, 0, [3, 40, 1, "1"], [9, 6, 0, "0.5"]],
        },
      },
    },
    { station: other, ok: false, data: null },
    { station: other, ok: true, data: { "999": {} } },
  ];
  const geo = fixtureGeo();
  const legacy = await legacyBuild(parts, geo);
  const ported = build(parse(parts), index(geo), new Date().toISOString());
  assertEntitiesEqual(legacyEntities(legacy), asOld(ported));
  assert.equal(ported.length, 1);
  assert.equal(ported[0]?.stationName.value, "Test’Station");
}

async function crossesTheChunkBoundary(): Promise<void> {
  // Three copies of the recorded station list and answers under new station
  // ids and codes (a synthetic test input): more stations than one chunk of
  // 100, through run() and through the old wrap and build nodes.
  const stations = structuredClone(readFixture("uba-bw").payload);
  assert.ok(isRecord(stations) && isRecord(stations.data));
  const data = stations.data;
  const original = new Map<string, string>();
  for (const copy of [1, 2]) {
    for (const [key, entry] of Object.entries(data)) {
      if (!isArray(entry) || key.includes("-")) continue;
      const id = `${String(entry[0])}00${String(copy)}`;
      original.set(id, String(entry[0]));
      data[`${key}-${String(copy)}`] = [id, `${String(entry[1])}${String(copy)}`, ...entry.slice(2)];
    }
  }
  const recorded = answers();
  /** The recorded answer of the station a copy was made from, re-keyed to the copy's id. */
  const answerFor = (id: string): { statusCode: number; payload: unknown } | undefined => {
    const from = original.get(id) ?? id;
    const answer = recorded.get(from);
    if (answer === undefined) return undefined;
    const payload = answer.payload;
    if (!isRecord(payload) || !isRecord(payload.data)) return answer;
    return { statusCode: answer.statusCode, payload: { ...payload, data: { [id]: payload.data[from] } } };
  };

  const broker = new Broker();
  const respond = (request: SeenRequest): HttpResponse | Error => {
    if (request.url.host !== HOST) return broker.respond(request);
    if (request.url.pathname.includes("/stations/")) return httpResponse(200, JSON.stringify(stations));
    const answer = answerFor(request.url.searchParams.get("station") ?? "");
    return answer === undefined
      ? httpResponse(404)
      : httpResponse(answer.statusCode, JSON.stringify(answer.payload));
  };
  const geo = fixtureGeo();
  await run(testCtx("uba-bw", sharedGeo(geo), respond).ctx);

  const requests = planRequests(stations, Date.now());
  assert.ok(requests !== null);
  const parts: unknown[] = [];
  for (const request of requests) {
    const answer = answerFor(request.station.id);
    assert.ok(answer !== undefined, `no answer for station ${request.station.id}`);
    const wrapped = await runFunctionNode(WRAP_NODE, {
      msg: {
        _msgid: "parity",
        station: request.station,
        statusCode: answer.statusCode,
        payload: structuredClone(answer.payload),
      },
    });
    const message = messagesOf(wrapped)[0];
    parts.push(isRecord(message) ? message.payload : undefined);
  }
  const legacy = await legacyBuild(parts, geo);
  assert.ok(legacyEntities(legacy).length > 100, `${String(legacyEntities(legacy).length)} entities`);
  assertEntitiesEqual(legacyEntities(legacy), asOld(broker.upserts.flat()));
  assert.deepEqual(
    broker.upserts.map((body) => body.length),
    legacyChunkSizes(legacy),
    "run() chunks differently from the old node",
  );
}

async function aDriftedValueFails(): Promise<void> {
  const geo = fixtureGeo();
  const parts = await legacyParts();
  const legacy = await legacyBuild(parts, geo);
  const ported = build(parse(parts), index(geo), new Date().toISOString()).map((entity, i) =>
    i === 3 ? { ...entity, ags: { type: "Property" as const, value: "08000000" } } : entity,
  );
  assert.throws(() => {
    assertEntitiesEqual(legacyEntities(legacy), asOld(ported));
  }, /\[3\]\.ags\.value/);
}

async function runWritesWhatTheOldNodesWrote(): Promise<void> {
  const geo = fixtureGeo();
  const recorded = answers();
  const broker = new Broker();
  const respond = (request: SeenRequest): HttpResponse | Error => {
    if (request.url.host === HOST) {
      if (request.url.pathname.includes("/stations/")) {
        return httpResponse(200, JSON.stringify(readFixture("uba-bw").payload));
      }
      const answer = recorded.get(request.url.searchParams.get("station") ?? "");
      // One station refuses the connection: skipped, the rest is written.
      if (request.url.searchParams.get("station") === "286") return new Error("connect ECONNREFUSED");
      return answer === undefined
        ? httpResponse(404)
        : httpResponse(answer.statusCode, JSON.stringify(answer.payload));
    }
    return broker.respond(request);
  };
  const { ctx, log, seen } = testCtx("uba-bw", sharedGeo(geo), respond);
  const portClock = openClock();
  await run(ctx);
  const portWindow = portClock.close();

  const parts = (await legacyParts()).map((part) =>
    isRecord(part) && isRecord(part.station) && part.station.id === "286"
      ? { ...part, ok: true, data: null }
      : part,
  );
  const legacy = await legacyBuild(parts, geo);
  assert.deepEqual(log.warnings(), []);
  assert.equal(broker.upserts.length, 1);
  assertEntitiesEqual(legacyEntities(legacy), asOld(broker.upserts[0]));
  assertMeasurementStamps(broker.upserts[0] ?? [], portWindow);
  assert.equal(broker.upserts[0]?.length, 37);
  const stationRequests = seen.filter((request) => request.url.pathname.includes("/airquality/"));
  assert.equal(stationRequests.length, 40, "one request per station, no retry");
}

/* ------------------------------------------------------------------ deliberate deviations */

const HOUR = 3_600_000;

/** `dateObserved` of a written entity, or `undefined`. */
function dateObservedOf(entity: unknown): unknown {
  if (!isRecord(entity) || !isRecord(entity.dateObserved) || !isRecord(entity.dateObserved.value)) {
    return undefined;
  }
  return entity.dateObserved.value["@value"];
}

/**
 * Per entity id, the end of the newest fixture row with a total index in UTC
 * — read here independently of the port: the CET wall time with a fixed
 * `+01:00` offset (Date.parse accepts `24:00`).
 */
function expectedIndexHours(): Map<string, string> {
  const requests = planRequests(readFixture("uba-bw").payload, Date.now());
  assert.ok(requests !== null);
  const recorded = answers();
  const out = new Map<string, string>();
  for (const { station } of requests) {
    const payload = recorded.get(station.id)?.payload;
    const series = isRecord(payload) && isRecord(payload.data) ? payload.data[station.id] : undefined;
    if (!isRecord(series)) continue;
    for (const key of Object.keys(series).sort().reverse()) {
      const row = series[key];
      if (!isArray(row) || row[1] === null || typeof row[0] !== "string") continue;
      const iso = new Date(Date.parse(`${row[0].replace(" ", "T")}+01:00`)).toISOString();
      out.set(`urn:ngsi-ld:AirQualityObserved:bw-uba-${station.code}`, iso);
      break;
    }
  }
  return out;
}

/**
 * The stamps of a run are measurement hours, not clock readings: full hours,
 * not later than the run, the index's `observedAt` and `dateObserved` the
 * end of the newest row with an index.
 */
function assertMeasurementStamps(entities: readonly unknown[], run: { readonly endMs: number }): void {
  const expected = expectedIndexHours();
  let checked = 0;
  for (const entity of entities) {
    assert.ok(isRecord(entity) && typeof entity.id === "string");
    const stamp = dateObservedOf(entity);
    assert.ok(typeof stamp === "string", `${entity.id}: no dateObserved`);
    for (const value of Object.values(entity)) {
      if (!isRecord(value) || value.observedAt === undefined) continue;
      const at = value.observedAt;
      assert.ok(typeof at === "string", entity.id + ": observedAt is no string");
      assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/, `${entity.id}: ${at} is no full hour`);
      assert.ok(Date.parse(at) <= run.endMs, `${entity.id}: ${at} lies after the run`);
      assert.ok(
        at <= stamp || !isRecord(entity.airQualityIndex),
        `${entity.id}: a value newer than the index`,
      );
    }
    if (!isRecord(entity.airQualityIndex)) continue;
    assert.equal(entity.airQualityIndex.observedAt, expected.get(entity.id), `${entity.id}: index hour`);
    assert.equal(stamp, entity.airQualityIndex.observedAt, `${entity.id}: dateObserved is the index hour`);
    checked += 1;
  }
  assert.ok(checked >= 30, `only ${String(checked)} stations with an index checked`);
}

function cetStampsToUtc(): void {
  const cases: [stamp: unknown, utc: string | null][] = [
    // CET all year round: summer and winter alike UTC+1.
    ["2026-10-05 09:00:00", "2026-10-05T08:00:00.000Z"],
    ["2026-01-15 12:30:00", "2026-01-15T11:30:00.000Z"],
    // The end of the last hour of a day.
    ["2026-09-27 24:00:00", "2026-09-27T23:00:00.000Z"],
    ["2026-12-31 24:00:00", "2026-12-31T23:00:00.000Z"],
    ["2026-01-01 00:00:00", "2025-12-31T23:00:00.000Z"],
    // The hour local time skips on the spring change exists in CET.
    ["2026-03-29 02:00:00", "2026-03-29T01:00:00.000Z"],
    ["2026-09-27 24:00:01", null],
    ["2026-09-27 25:00:00", null],
    ["2026-09-27 10:60:00", null],
    ["2026-02-30 10:00:00", null],
    ["2026-13-01 00:00:00", null],
    ["2026-09-27T10:00:00", null],
    ["2026-09-27 10:00", null],
    ["", null],
    [null, null],
    [1790550000000, null],
  ];
  for (const [stamp, utc] of cases) assert.equal(cetToUtc(stamp), utc, `cetToUtc(${JSON.stringify(stamp)})`);
}

function measurementTimeOfEachValue(): void {
  const station = { id: "900", code: "DEBW900", name: "Test", lon: 7.85, lat: 48.0 };
  const noIndex = { id: "901", code: "DEBW901", name: "Ohne Index", lon: 9.18, lat: 48.77 };
  const parts: UbaPart[] = [
    {
      station,
      ok: true,
      data: {
        "900": {
          // Ends after the run: no measurement, skipped.
          "2026-09-28 12:00:00": ["2026-09-28 13:00:00", 4, 0, [5, 99, 4, "4"]],
          "2026-09-27 23:00:00": ["2026-09-27 24:00:00", 1, 1, [5, 20, 0, "1"]],
          "2026-09-27 22:00:00": ["2026-09-27 23:00:00", 2, 0, [5, 25, 0, "1"], [3, 50, 0, "1"]],
          // Column 0 unreadable: the start key + 1 h.
          "2026-09-27 21:00:00": ["?", 3, 0, [9, 7, 0, "1"]],
        },
      },
    },
    {
      station: noIndex,
      ok: true,
      data: {
        "901": {
          "2026-09-27 23:00:00": ["2026-09-27 24:00:00", null, 1, [3, 40, 0, "1"]],
          "2026-09-27 22:00:00": ["2026-09-27 23:00:00", null, 1, [5, 30, 0, "1"]],
        },
      },
    },
  ];
  const [first, second] = build(parse(parts), index(fixtureGeo()), "2026-09-28T10:30:00.000Z");
  assert.ok(first !== undefined && second !== undefined);
  assert.deepEqual(normalize(first.airQualityIndex, { volatileKeys: [] }), {
    type: "Property",
    value: 1,
    unitCode: "",
    observedAt: "2026-09-27T23:00:00.000Z",
  });
  const at = (entity: unknown, name: string): unknown => {
    const attribute = isRecord(entity) ? entity[name] : undefined;
    return isRecord(attribute) ? [attribute.value, attribute.observedAt] : undefined;
  };
  assert.deepEqual(at(first, "no2"), [20, "2026-09-27T23:00:00.000Z"]);
  assert.deepEqual(at(first, "o3"), [50, "2026-09-27T22:00:00.000Z"]);
  assert.deepEqual(at(first, "pm25"), [7, "2026-09-27T21:00:00.000Z"]);
  assert.equal(dateObservedOf(first), "2026-09-27T23:00:00.000Z");
  // Without an index: the hour of the newest component.
  assert.equal(second.airQualityIndex, undefined);
  assert.equal(dateObservedOf(second), "2026-09-27T23:00:00.000Z");
}

async function splitGateWritesOnlyWhatChanged(): Promise<void> {
  const geo = sharedGeo(fixtureGeo());
  const recorded = answers();
  const override = new Map<string, { statusCode: number; payload: unknown } | Error>();
  const respond =
    (broker: Broker) =>
    (request: SeenRequest): HttpResponse | Error => {
      if (request.url.host !== HOST) return broker.respond(request);
      if (request.url.pathname.includes("/stations/")) {
        return httpResponse(200, JSON.stringify(readFixture("uba-bw").payload));
      }
      const id = request.url.searchParams.get("station") ?? "";
      const answer = override.get(id) ?? recorded.get(id);
      if (answer instanceof Error) return answer;
      return answer === undefined
        ? httpResponse(404)
        : httpResponse(answer.statusCode, JSON.stringify(answer.payload));
    };
  const store = new SignatureStore();
  const tableSizes = (): number[] => [STATIC_KEY, LIVE_KEY].map((key) => store.scope("uba-bw").size(key));
  const deleted: string[] = [];
  const respondOrDelete =
    (broker: Broker) =>
    (request: SeenRequest): HttpResponse | Error => {
      if (request.method !== "DELETE") return respond(broker)(request);
      deleted.push(decodeURIComponent(request.url.pathname));
      return httpResponse(204);
    };
  const runAt = async (nowMs: number): Promise<Broker> => {
    const broker = new Broker();
    const { ctx, log } = testCtx("uba-bw", geo, respondOrDelete(broker), { nowMs: () => nowMs, store });
    await run(ctx);
    assert.deepEqual(log.warnings(), []);
    return broker;
  };
  const base = Date.parse("2026-09-28T03:11:10Z");

  // First run: no signatures, every station in full.
  const first = await runAt(base);
  const full = first.upserts.flat();
  assert.equal(full.length, 38);
  assert.deepEqual(tableSizes(), [38, 38]);

  // Same answers an hour later (UBA has not published): the unchanged
  // dateObserved only, except a station whose weekly full write falls on it.
  const second = await runAt(base + HOUR);
  for (const entity of second.upserts.flat()) {
    assert.ok(isRecord(entity) && typeof entity.id === "string");
    if (needsRefresh(entity.id, base + HOUR)) continue;
    assert.deepEqual(Object.keys(entity).sort(), ["@context", "dateObserved", "id", "type"]);
    const before = full.find((e) => isRecord(e) && e.id === entity.id);
    assert.equal(dateObservedOf(entity), dateObservedOf(before), `${entity.id}: dateObserved moved`);
  }
  assert.equal(second.upserts.flat().length, 38);

  // A new hour for station 215 with a new index and O3: only those two and dateObserved.
  const id = "215";
  const entityId = "urn:ngsi-ld:AirQualityObserved:bw-uba-DEBW004";
  const answer = recorded.get(id);
  assert.ok(answer !== undefined && isRecord(answer.payload) && isRecord(answer.payload.data));
  const series = answer.payload.data[id];
  assert.ok(isRecord(series));
  const before = full.find((e) => isRecord(e) && e.id === entityId);
  assert.ok(
    isRecord(before) && isRecord(before.airQualityIndex) && isRecord(before.o3),
    "fixture station changed",
  );
  const newIndex = before.airQualityIndex.value === 2 ? 3 : 2;
  const newO3 = Number(before.o3.value) + 1;
  override.set(id, {
    statusCode: 200,
    payload: {
      ...answer.payload,
      data: {
        [id]: { ...series, "2026-09-28 03:00:00": ["2026-09-28 04:00:00", newIndex, 0, [3, newO3, 0, "1"]] },
      },
    },
  });
  let nowMs = base + 2 * HOUR;
  while (needsRefresh(entityId, nowMs)) nowMs += HOUR;
  const third = await runAt(nowMs);
  const partial = third.upserts.flat().find((e) => isRecord(e) && e.id === entityId);
  assert.ok(isRecord(partial));
  assert.deepEqual(Object.keys(partial).sort(), [
    "@context",
    "airQualityIndex",
    "dateObserved",
    "id",
    "o3",
    "type",
  ]);
  assert.equal(dateObservedOf(partial), "2026-09-28T03:00:00.000Z");
  assert.ok(isRecord(partial.o3) && partial.o3.observedAt === "2026-09-28T03:00:00.000Z");
  assert.deepEqual(tableSizes(), [38, 38]);

  assert.deepEqual(deleted, []);

  // The index leaves the 24 h window, the components stay: the index is deleted
  // from the broker instead of staying next to a newer dateObserved.
  const withoutIndex = Object.fromEntries(
    Object.entries(series).map(([key, row]) => [key, isArray(row) ? [row[0], null, ...row.slice(2)] : row]),
  );
  override.set(id, { statusCode: 200, payload: { ...answer.payload, data: { [id]: withoutIndex } } });
  nowMs += HOUR;
  await runAt(nowMs);
  assert.deepEqual(deleted, [`/ngsi-ld/v1/entities/${entityId}/attrs/airQualityIndex`]);
  await runAt(nowMs + HOUR);
  assert.equal(deleted.length, 1, "deleted again although the signature no longer holds an index");

  // A station without an answer: merge mode, its signatures survive.
  override.set(id, new Error("connect ECONNREFUSED"));
  await runAt(nowMs + 2 * HOUR);
  assert.deepEqual(tableSizes(), [38, 38]);
  // Every station answered, one with an empty series: replace mode drops it.
  override.set(id, { statusCode: 200, payload: { data: {} } });
  await runAt(nowMs + 3 * HOUR);
  assert.deepEqual(tableSizes(), [37, 37]);
}

export {
  stationSelectionIsIdentical as "uba-bw: old udp-rt-bu-msgs and planRequests select the same 40 stations with the same URLs",
  wrapperIsIdentical as "uba-bw: old udp-rt-bu-wrap and wrapResponse agree on ok, failed and unreadable answers",
  entitiesAreIdenticalWithStrictAndCentroidAssignment as "uba-bw: old build node and ported build() agree — strict polygon hits and centroid fallback",
  withoutBoundariesEveryStationGoesByCentroid as "uba-bw: without boundaries both assign every station by centroid instead of skipping",
  partialAndMalformedSeries as "uba-bw: null index, valueless and unknown components, failed parts are handled alike",
  crossesTheChunkBoundary as "uba-bw: more stations than one chunk of 100 (synthetic copies) are chunked as by the old node",
  aDriftedValueFails as "uba-bw: a drifted field fails the comparison with its path",
  runWritesWhatTheOldNodesWrote as "uba-bw: run(ctx) writes what the old nodes wrote, a refused station is skipped",
  cetStampsToUtc as "uba-bw: CET stamps to UTC all year round, 24:00 as the end of the day, garbage refused (deliberate deviation)",
  measurementTimeOfEachValue as "uba-bw: every value carries the end of its own hour, dateObserved the index's hour (deliberate deviation)",
  splitGateWritesOnlyWhatChanged as "uba-bw: split gate — full first run, unchanged hour stamp-only, new hour only the changed values, a vanished index deleted (deliberate deviation)",
};
