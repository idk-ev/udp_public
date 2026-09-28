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
 * Fixtures: test/fixtures/uba-bw.json (station list) and
 * uba-bw-airquality.json (the 40 per-station answers), see their notes.
 */

import assert from "node:assert/strict";
import { build, parse, planRequests, run, wrapResponse } from "../../src/connectors/uba-bw.js";
import type { UbaPart } from "../../src/connectors/uba-bw.js";
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
import { assertEntitiesEqual, isRecord, normalize } from "../harness/normalize.js";
import { messagesOf, runFunctionNode } from "../harness/vm-runner.js";

const MSGS_NODE = "udp-rt-bu-msgs";
const WRAP_NODE = "udp-rt-bu-wrap";
const BUILD_NODE = "udp-rt-bu-build";

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
  const legacyRequests = normalize(
    messagesOf(legacy).map((message) =>
      isRecord(message) ? { url: message.url, station: message.station } : null,
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
  assertEntitiesEqual(legacyEntities(legacy), ported);
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
  assertEntitiesEqual(legacyEntities(legacy), ported);
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
  assertEntitiesEqual(legacyEntities(legacy), ported);
  assert.equal(ported.length, 1);
  assert.equal(ported[0]?.stationName.value, "Test’Station");
}

async function aDriftedValueFails(): Promise<void> {
  const geo = fixtureGeo();
  const parts = await legacyParts();
  const legacy = await legacyBuild(parts, geo);
  const ported = build(parse(parts), index(geo), new Date().toISOString()).map((entity, i) =>
    i === 3 ? { ...entity, ags: { type: "Property" as const, value: "08000000" } } : entity,
  );
  assert.throws(() => {
    assertEntitiesEqual(legacyEntities(legacy), ported);
  }, /\[3\]\.ags\.value/);
}

async function runWritesWhatTheOldNodesWrote(): Promise<void> {
  const geo = fixtureGeo();
  const recorded = answers();
  const broker = new Broker();
  const respond = (request: SeenRequest): HttpResponse | Error => {
    if (request.url.host === "www.umweltbundesamt.de") {
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
  await run(ctx);

  const parts = (await legacyParts()).map((part) =>
    isRecord(part) && isRecord(part.station) && part.station.id === "286"
      ? { ...part, ok: true, data: null }
      : part,
  );
  const legacy = await legacyBuild(parts, geo);
  assert.deepEqual(log.warnings(), []);
  assert.equal(broker.upserts.length, 1);
  assertEntitiesEqual(legacyEntities(legacy), broker.upserts[0]);
  assert.equal(broker.upserts[0]?.length, 37);
  const stationRequests = seen.filter((request) => request.url.pathname.includes("/airquality/"));
  assert.equal(stationRequests.length, 40, "one request per station, no retry");
}

export {
  stationSelectionIsIdentical as "uba-bw: old udp-rt-bu-msgs and planRequests select the same 40 stations with the same URLs",
  wrapperIsIdentical as "uba-bw: old udp-rt-bu-wrap and wrapResponse agree on ok, failed and unreadable answers",
  entitiesAreIdenticalWithStrictAndCentroidAssignment as "uba-bw: old build node and ported build() agree — strict polygon hits and centroid fallback",
  withoutBoundariesEveryStationGoesByCentroid as "uba-bw: without boundaries both assign every station by centroid instead of skipping",
  partialAndMalformedSeries as "uba-bw: null index, valueless and unknown components, failed parts are handled alike",
  aDriftedValueFails as "uba-bw: a drifted field fails the comparison with its path",
  runWritesWhatTheOldNodesWrote as "uba-bw: run(ctx) writes what the old nodes wrote, a refused station is skipped",
};
