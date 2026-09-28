/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: feinstaub-bw — `udp-rt-bs-fn` ("→ Median je Gemeinde") and its commit
 * node `udp-rt-bs-commit` against the ported module plus the kernel's change
 * gate, pruner and cadence.
 *
 * Pinned: the medians (odd and even counts, the one-decimal rounding), the
 * choice of the newest plausible reading per sensor (an older record never
 * replaces a newer one; an implausible newer one leaves the older standing),
 * the strict assignment (the box reaches into Alsace, Basel and the
 * Palatinate), the single sensors of every fourth run, the gate cycle over a
 * confirmed upsert, and the prune of the detail runs — with its interval of
 * four runs — against the old node on the full master data.
 *
 * Fixture: test/fixtures/feinstaub-bw.json, see its note.
 */

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  build,
  CADENCE,
  DETAIL_EVERY,
  GATE_KEY,
  parse,
  run,
  signatureOf,
  summarize,
} from "../../src/connectors/feinstaub-bw.js";
import type { SensorBox } from "../../src/connectors/feinstaub-bw.js";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import type { SignatureScope } from "../../src/kernel/change-gate.js";
import { chunk } from "../../src/kernel/orion.js";
import type { GeoIndex, HttpResponse, UpsertPlan } from "../../src/kernel/types.js";
import {
  Broker,
  fixtureGeo,
  flowOf,
  fullGeo,
  legacyChunkSizes,
  legacyEntities,
  legacyGlobal,
  legacyPending,
  registryEntry,
  sharedGeo,
  testCtx,
} from "../harness/air-energy-kernel.js";
import type { RawGeo } from "../harness/air-energy-kernel.js";
import { messageFromFixture, readFixture } from "../harness/fixtures.js";
import { fakeHttpModule, httpResponse, recordingLog } from "../harness/kernel.js";
import type { SeenRequest } from "../harness/kernel.js";
import { assertEntitiesEqual, isRecord, normalize } from "../harness/normalize.js";
import { messagesOf, runFunctionNode } from "../harness/vm-runner.js";
import type { FunctionNodeRun } from "../harness/vm-runner.js";

const NODE_ID = "udp-rt-bs-fn";
const COMMIT_NODE_ID = "udp-rt-bs-commit";
const SOURCE = "https://data.sensor.community/airrohr/v1/filter/box=47.5,7.4,49.8,10.6";
const HOUR = 3_600_000;

interface LegacyOptions {
  readonly flow?: Record<string, unknown>;
  readonly context?: Record<string, unknown>;
  readonly geo?: RawGeo;
  readonly respond?: (request: SeenRequest) => HttpResponse | Error;
}

async function runLegacy(payload: unknown, options: LegacyOptions = {}): Promise<FunctionNodeRun> {
  const fixture = readFixture("feinstaub-bw");
  return runFunctionNode(NODE_ID, {
    msg: { ...messageFromFixture(fixture), payload: structuredClone(payload) },
    flow: options.flow ?? {},
    context: options.context ?? {},
    global: legacyGlobal(options.geo ?? fixtureGeo()),
    modules: { http: fakeHttpModule(options.respond ?? (() => new Error("no broker in this test"))) },
  });
}

/** As `run` builds it: the detail list is `sensorDetailFor` of the registry entry. */
function box(payload: unknown, detailRun: boolean): SensorBox {
  return { ...parse(payload), detailRun, detailFor: registryEntry("feinstaub-bw").sensorDetailFor };
}

function ported(payload: unknown, detailRun: boolean, index: GeoIndex, store: SignatureScope): UpsertPlan {
  const entities = build(box(payload, detailRun), index, new Date().toISOString());
  return createChangeGate(store, recordingLog()).check(GATE_KEY, entities, signatureOf);
}

function assertPlanMatches(legacy: FunctionNodeRun, plan: UpsertPlan): void {
  assertEntitiesEqual(legacyEntities(legacy), plan.entities);
  assert.deepEqual(normalize(legacyPending(legacy)), normalize(plan.pending), "pending signatures differ");
  assert.deepEqual(
    legacyChunkSizes(legacy),
    chunk(plan.entities, 100).map((part) => part.length),
    "chunking differs",
  );
}

async function medianRunIsIdentical(): Promise<void> {
  const payload = readFixture("feinstaub-bw").payload;
  const index = sharedGeo(fixtureGeo()).index();
  // Empty flow context: scTakt becomes 1, a median-only run.
  const legacy = await runLegacy(payload);
  const plan = ported(payload, false, index, new SignatureStore().scope("test"));
  assert.deepEqual(legacy.warnings, []);
  assertPlanMatches(legacy, plan);

  const result = summarize(box(payload, false), index, new Date().toISOString());
  assert.equal(result.sensorEntities, 0);
  assert.ok(result.entities.length >= 20, `municipalities with sensors: ${String(result.entities.length)}`);
  assert.ok(result.discarded > 0, "the fixture carries implausible readings");
  assert.ok(result.outside > 0, "the fixture carries sensors outside every polygon");
  // The old status line with the same counters.
  const statusLine = normalize(legacy.status[0]);
  assert.ok(isRecord(statusLine) && typeof statusLine.text === "string");
  assert.match(
    statusLine.text,
    new RegExp(`^${String(result.entities.length)} Gemeinden mit Sensoren · 0 Einzelsensoren`),
  );
  assert.match(statusLine.text, new RegExp(` ${String(result.discarded)} unplausibel verworfen`));
  assert.match(statusLine.text, new RegExp(` ${String(result.outside)} außerhalb BW$`));
}

async function detailRunIsIdentical(): Promise<void> {
  const payload = readFixture("feinstaub-bw").payload;
  const index = sharedGeo(fixtureGeo()).index();
  // scTakt 3 → 0: the fourth run, single sensors included.
  const legacy = await runLegacy(payload, { flow: { scTakt: 3 } });
  assert.equal(legacy.flow.get("scTakt"), 0);
  const plan = ported(payload, true, index, new SignatureStore().scope("test"));
  assertPlanMatches(legacy, plan);
  const sensors = plan.entities.filter((entity) => entity.id.includes(":bw-sensor-"));
  assert.ok(sensors.length > 50, `single sensors: ${String(sensors.length)}`);
  assert.ok(legacyChunkSizes(legacy).length >= 2, "more than 100 entities: several chunks");
}

async function commitThenFreshnessOnly(): Promise<void> {
  const payload = readFixture("feinstaub-bw").payload;
  const index = sharedGeo(fixtureGeo()).index();
  const store = new SignatureStore().scope("test");
  const first = await runLegacy(payload, { flow: { scTakt: 3 } });
  const firstPlan = ported(payload, true, index, store);
  let flow = flowOf(first);
  for (const message of messagesOf(first)) {
    if (!isRecord(message)) continue;
    const commit = await runFunctionNode(COMMIT_NODE_ID, {
      msg: { ...message, statusCode: 204, payload: "" },
      flow,
    });
    flow = flowOf(commit);
  }
  store.commit(firstPlan.pending, new Set(firstPlan.entities.map((entity) => entity.id)));
  assert.deepEqual(
    normalize(flow[GATE_KEY]),
    normalize(Object.fromEntries(store.copy(GATE_KEY))),
    "committed tables differ",
  );

  // Next detail run, same data: medians go out as freshness stamps, the
  // single sensors (no dateObserved) not at all.
  const second = await runLegacy(payload, { flow: { ...flow, scTakt: 3 } });
  const secondPlan = ported(payload, true, index, store);
  assertPlanMatches(second, secondPlan);
  assert.equal(secondPlan.pending.length, 0);
  assert.ok(
    secondPlan.entities.every((entity) => entity.id.includes(":bw-sc-") && Object.keys(entity).length === 4),
  );
}

/** Synthetic readings on real coordinates (Freiburg, Basel), to pin the choice rules. */
function reading(
  sensor: number,
  timestamp: string,
  p1: string,
  p2: string,
  lat = "47.9959",
  lon = "7.8494",
): unknown {
  return {
    location: { latitude: lat, longitude: lon },
    sensordatavalues: [
      { value: p1, value_type: "P1" },
      { value: p2, value_type: "P2" },
    ],
    timestamp,
    sensor: { id: sensor, sensor_type: { name: "SDS011" } },
  };
}

async function newestPlausibleReadingAndMedians(): Promise<void> {
  const payload = [
    reading(30, "2026-09-28 10:05:00", "12.4", "6.1"),
    reading(30, "2026-09-28 10:00:00", "99", "50"), // older: never replaces
    reading(31, "2026-09-28 10:00:00", "20.0", "10.0"),
    reading(31, "2026-09-28 10:05:00", "450", "10"), // newer but saturated: the older stays
    reading(32, "2026-09-28 10:05:00", "8", "9.5"), // PM2.5 > 1.05 × PM10: discarded
    reading(33, "2026-09-28 10:05:00", "7.3", "abc"), // PM10 only
    reading(4, "2026-09-28 10:05:00", "5.05", "2.2"), // small id: first in object order
    reading(40, "2026-09-28 10:05:00", "30", "20", "47.5582", "7.5878"), // Basel: outside BW
    reading(41, "2026-09-28 10:05:00", "-1", "600"), // no plausible channel at all
    { sensor: { id: 50, sensor_type: { name: "DHT22" } }, sensordatavalues: [], timestamp: "x" },
  ];
  const index = sharedGeo(fixtureGeo()).index();
  for (const detail of [false, true]) {
    const legacy = await runLegacy(payload, { flow: { scTakt: detail ? 3 : 0 } });
    assertPlanMatches(legacy, ported(payload, detail, index, new SignatureStore().scope("test")));
  }
  const result = summarize(box(payload, true), index, new Date().toISOString());
  const median = result.entities.find((entity) => entity.id.endsWith("bw-sc-08311000"));
  assert.ok(median?.sensorCount !== undefined);
  // PM10 of sensors 4, 30, 31, 33: 5.05, 12.4, 20, 7.3 → (7.3 + 12.4) / 2 = 9.85 → 9.9
  assert.equal(median.pm10?.value, 9.9);
  assert.equal(median.pm25?.value, 6.1);
  assert.equal(result.discarded, 2);
  assert.equal(result.outside, 1);
  assert.equal(result.entities[0]?.id, "urn:ngsi-ld:AirQualityObserved:bw-sensor-08311000-4");
}

async function aDriftedMedianFails(): Promise<void> {
  const payload = readFixture("feinstaub-bw").payload;
  const legacy = await runLegacy(payload);
  const plan = ported(payload, false, sharedGeo(fixtureGeo()).index(), new SignatureStore().scope("test"));
  const drifted = plan.entities.map((entity, i) =>
    i === 2 ? { ...entity, sensorCount: { type: "Property" as const, value: 99, unitCode: "C62" } } : entity,
  );
  assert.throws(() => {
    assertEntitiesEqual(legacyEntities(legacy), drifted);
  }, /\[2\]\.sensorCount\.value/);
}

/** Own stale entities of both schemes, a foreign one, and nothing else. */
function staleBroker(): Broker {
  const old = {
    type: "Property",
    value: { "@type": "DateTime", "@value": new Date(Date.now() - 72 * HOUR).toISOString() },
  };
  return new Broker([
    {
      id: "urn:ngsi-ld:AirQualityObserved:bw-sc-08436001",
      type: "AirQualityObserved",
      ags: { type: "Property", value: "08436001" },
      dateObserved: old,
    },
    {
      id: "urn:ngsi-ld:AirQualityObserved:bw-sensor-08311000-1",
      type: "AirQualityObserved",
      ags: { type: "Property", value: "08311000" },
      pm10: { type: "Property", value: 3, observedAt: new Date(Date.now() - 72 * HOUR).toISOString() },
    },
    { id: "urn:ngsi-ld:AirQualityObserved:bw-uba-DEBW084", type: "AirQualityObserved", dateObserved: old },
  ]);
}

async function pruneEveryFourthRunOnFullMasterData(): Promise<void> {
  const geo = fullGeo();
  const payload = readFixture("feinstaub-bw").payload;
  const rows = geo.municipalities;
  assert.ok(Array.isArray(rows));

  // The old node: eight runs, flow and node context carried over; its prune is
  // fire-and-forget, so each run is given a moment to settle.
  const legacyBroker = staleBroker();
  legacyBroker.municipalityCount = rows.length;
  let flow: Record<string, unknown> = {};
  let context: Record<string, unknown> = {};
  const legacyDeletes: number[] = [];
  for (let i = 1; i <= 8; i += 1) {
    const legacy = await runLegacy(payload, { flow, context, geo, respond: legacyBroker.respond });
    await sleep(150);
    flow = flowOf(legacy);
    context = Object.fromEntries(legacy.context);
    legacyDeletes.push(legacyBroker.deletes.flat().length);
  }

  // The port: eight runs of run(ctx) against its own copy.
  const portBroker = staleBroker();
  portBroker.municipalityCount = rows.length;
  const respond = (request: SeenRequest): HttpResponse | Error =>
    request.url.href === SOURCE ? httpResponse(200, JSON.stringify(payload)) : portBroker.respond(request);
  const { ctx, log, seen } = testCtx("feinstaub-bw", sharedGeo(geo), respond);
  assert.equal(ctx.intervalMs(DETAIL_EVERY), 3_600_000, "prune interval: four runs of 15 minutes");
  const portDeletes: number[] = [];
  for (let i = 1; i <= 8; i += 1) {
    await run(ctx);
    portDeletes.push(portBroker.deletes.flat().length);
  }

  // Armed in run 4 (first detail run), deleting in run 8 — on both sides.
  assert.deepEqual(portDeletes, [0, 0, 0, 0, 0, 0, 0, 2]);
  assert.deepEqual(portDeletes, legacyDeletes, "deletions per run differ");
  assert.deepEqual(portBroker.deletes.flat().sort(), legacyBroker.deletes.flat().sort());
  assert.ok(
    portBroker.entities.has("urn:ngsi-ld:AirQualityObserved:bw-uba-DEBW084"),
    "a foreign id was deleted",
  );
  assert.deepEqual(log.warnings(), []);
  // The listing both sent: same type, pattern and attributes.
  const listing = (requests: readonly SeenRequest[]): (string | null)[][] =>
    requests
      .filter((request) => request.method === "GET" && request.url.searchParams.get("options") === "sysAttrs")
      .map((request) => ["type", "idPattern", "attrs"].map((key) => request.url.searchParams.get(key)));
  const seenLegacy: SeenRequest[] = [];
  const legacyAgain = staleBroker();
  await runLegacy(payload, {
    flow: { ...flow, scTakt: 3 },
    context,
    geo,
    respond: (request) => {
      seenLegacy.push(request);
      return legacyAgain.respond(request);
    },
  });
  await sleep(150);
  assert.equal(listing(seen).length, 1);
  assert.deepEqual(listing(seenLegacy), listing(seen), "prune listing query differs");
}

/**
 * `sensorDetailFor` of the registry decides which municipalities get single
 * sensors — `DETAIL_AGS` of the old node, which the generator spliced in from
 * the same field. `run` reads it from `ctx.entry`; no module constant.
 */
async function detailListComesFromTheRegistry(): Promise<void> {
  assert.equal(registryEntry("feinstaub-bw").sensorDetailFor, "*");
  const payload = readFixture("feinstaub-bw").payload;
  const index = sharedGeo(fixtureGeo()).index();
  const all = summarize(box(payload, true), index, new Date().toISOString());
  const sensorAgs = all.entities
    .filter((entity) => entity.id.includes(":bw-sensor-"))
    .map((entity) => entity.ags.value);
  const chosen = sensorAgs[0];
  assert.ok(chosen !== undefined);
  const restricted = summarize(
    { ...box(payload, true), detailFor: [chosen] },
    index,
    new Date().toISOString(),
  );
  assert.equal(restricted.sensorEntities, sensorAgs.filter((ags) => ags === chosen).length);
  assert.ok(restricted.sensorEntities < all.sensorEntities);
  assert.equal(
    summarize({ ...box(payload, true), detailFor: [] }, index, new Date().toISOString()).sensorEntities,
    0,
  );

  // Through run(): a registry entry listing one municipality, fourth run.
  const broker = new Broker([]);
  const respond = (request: SeenRequest): HttpResponse | Error =>
    request.url.href === SOURCE ? httpResponse(200, JSON.stringify(payload)) : broker.respond(request);
  const { ctx } = testCtx("feinstaub-bw", sharedGeo(fixtureGeo()), respond);
  const narrowed = { ...ctx, entry: { ...ctx.entry, sensorDetailFor: [chosen] } };
  ctx.state.slot(CADENCE).set(DETAIL_EVERY - 1);
  await run(narrowed);
  const sensorIds = broker.upserts
    .flat()
    .map((entity) => (isRecord(entity) ? entity.id : undefined))
    .filter((id): id is string => typeof id === "string" && id.includes(":bw-sensor-"));
  assert.equal(sensorIds.length, restricted.sensorEntities);
  assert.ok(sensorIds.every((id) => id.includes(`:bw-sensor-${chosen}-`)));
}

export {
  detailListComesFromTheRegistry as "feinstaub-bw: single sensors only for the municipalities in the registry's sensorDetailFor",
  medianRunIsIdentical as "feinstaub-bw: old node and ported build() + gate agree on a median run (strict, implausible, outside BW)",
  detailRunIsIdentical as "feinstaub-bw: every fourth run adds the single sensors, identically chunked",
  commitThenFreshnessOnly as "feinstaub-bw: commit after a confirmed upsert matches, next run is freshness only, sensors drop out",
  newestPlausibleReadingAndMedians as "feinstaub-bw: newest plausible reading per sensor, id order and even-count median rounding agree",
  aDriftedMedianFails as "feinstaub-bw: a drifted sensor count fails the comparison with its path",
  pruneEveryFourthRunOnFullMasterData as "feinstaub-bw: prune in the detail runs only, armed then deleting, as the old node on full master data",
};
