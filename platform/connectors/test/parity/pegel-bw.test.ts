/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: pegel-bw — FN_PEGEL (`udp-rt-pe-fn`) and its signature commit node
 * (`udp-rt-pe-commit`) against the ported module plus the kernel's change gate.
 *
 * Compared: the emitted chunks (entities, pending signatures, chunk sizes of
 * 50), the gate cycle (first run, commit of a confirmed upsert, freshness-only
 * second run, one changed gauge), the run without master data (names empty,
 * run not skipped), and `run()` end to end against a scripted Orion.
 *
 * Fixture: test/fixtures/pegel-bw.json — 17 real PEGELONLINE stations (see its
 * `note`), with the trimmed geo fixtures as geo context. The branches the
 * fixture has to exercise are asserted, so a re-recording cannot quietly stop
 * covering them.
 */

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { build, CHUNK_SIZE, GATE_KEY, parse, run, signatureOf } from "../../src/connectors/pegel-bw.js";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import type { SignatureScope } from "../../src/kernel/change-gate.js";
import { createGeoIndex } from "../../src/kernel/geo.js";
import { chunk } from "../../src/kernel/orion.js";
import { isArray } from "../../src/kernel/parse.js";
import type { HttpResponse, UpsertPlan } from "../../src/kernel/types.js";
import { messageFromFixture, readFixture } from "../harness/fixtures.js";
import { httpResponse, recordingLog } from "../harness/kernel.js";
import {
  assertClockStamps,
  assertEntitiesEqual,
  assertStampsWithin,
  isRecord,
  normalize,
  openClock,
} from "../harness/normalize.js";
import { runFunctionNode } from "../harness/vm-runner.js";
import type { FunctionNodeRun } from "../harness/vm-runner.js";
import { fixtureGeo, fullGeo, legacyChunks, rig, upsertBodies } from "../harness/water-warnings-rig.js";
import type { LegacyChunks } from "../harness/water-warnings-rig.js";

const NODE_ID = "udp-rt-pe-fn";
const COMMIT_NODE_ID = "udp-rt-pe-commit";
const FIXTURE = "pegel-bw";

interface Legacy extends LegacyChunks {
  readonly run: FunctionNodeRun;
}

async function runLegacy(
  payload: unknown,
  flow: Readonly<Record<string, unknown>> = {},
  withMunicipalities = true,
): Promise<Legacy> {
  const geo = fixtureGeo();
  const msg = { ...messageFromFixture(readFixture(FIXTURE)), payload: structuredClone(payload) };
  const run = await runFunctionNode(NODE_ID, {
    msg,
    flow,
    global: withMunicipalities
      ? { bwGrenzen: geo.rawBoundaries, bwGemeinden: geo.rawRows }
      : { bwGrenzen: geo.rawBoundaries },
  });
  return { run, ...legacyChunks(run) };
}

function ported(payload: unknown, store: SignatureScope, withMunicipalities = true): UpsertPlan {
  const geo = fixtureGeo();
  const index = createGeoIndex(withMunicipalities ? geo.rows : [], geo.boundaries);
  const entities = build(parse(payload), index, new Date().toISOString());
  return createChangeGate(store, recordingLog()).check(GATE_KEY, entities, signatureOf);
}

function assertPlanMatches(legacy: Legacy, plan: UpsertPlan): void {
  assertEntitiesEqual(legacy.entities, plan.entities);
  assert.deepEqual(normalize(legacy.pending), normalize(plan.pending), "pending signatures differ");
  assert.deepEqual(
    legacy.sizes,
    chunk(plan.entities, CHUNK_SIZE).map((part) => part.length),
    "chunking differs",
  );
}

/** Commits like a confirmed upsert (HTTP 204) of every chunk, on both sides. */
async function commitAll(
  legacy: Legacy,
  plan: UpsertPlan,
  store: SignatureScope,
): Promise<Record<string, unknown>> {
  let flow = Object.fromEntries(legacy.run.flow);
  for (const message of legacy.messages) {
    if (!isRecord(message)) continue;
    const commit = await runFunctionNode(COMMIT_NODE_ID, {
      msg: { ...message, statusCode: 204, payload: "" },
      flow,
    });
    assert.deepEqual(commit.warnings, []);
    flow = Object.fromEntries(commit.flow);
  }
  store.commit(plan.pending, new Set(plan.entities.map((entity) => entity.id)));
  return flow;
}

function stationNumbers(plan: UpsertPlan): string[] {
  return plan.entities.map((entity) => entity.id.replace("urn:ngsi-ld:WaterLevelObserved:bw-pegel-", ""));
}

async function firstRunIsIdentical(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const legacy = await runLegacy(fixture.payload);
  const plan = ported(fixture.payload, new SignatureStore().scope("test"));

  assert.deepEqual(legacy.run.warnings, []);
  assertPlanMatches(legacy, plan);

  // What the fixture has to exercise — facts about the recording.
  const numbers = stationNumbers(plan);
  for (const inside of ["23300130", "23300320", "23300900", "23700700", "23800900"]) {
    assert.ok(numbers.includes(inside), `${inside} must be assigned`);
  }
  // Basel (Switzerland), Worms/Speyer (Rhineland-Palatinate), Maxau (no polygon
  // in the trimmed geo fixture), Celle (outside the box) are not.
  for (const outside of ["2310010", "23900200", "23700600", "23700200", "48300105"]) {
    assert.ok(!numbers.includes(outside), `${outside} must not be assigned`);
  }
  // Kehl-Kronenhof lists Q (m³/s) first: the level is the W series in cm.
  const kehl = plan.entities.find((entity) => entity.id.endsWith("-23300900"));
  assert.ok(kehl !== undefined && isRecord(kehl.level));
  const source = normalize(fixture.payload);
  const kehlSource = isArray(source)
    ? source.find((station: unknown) => isRecord(station) && station.number === "23300900")
    : undefined;
  const series = isRecord(kehlSource) && isArray(kehlSource.timeseries) ? kehlSource.timeseries : [];
  const first: unknown = series[0];
  const w: unknown = series.find((entry: unknown) => isRecord(entry) && entry.shortname === "W");
  assert.ok(isRecord(first) && first.shortname === "Q", "Q first in the recording");
  assert.ok(isRecord(w) && isRecord(w.currentMeasurement));
  assert.equal(kehl.level.value, w.currentMeasurement.value);
  assert.equal(plan.pending.length, plan.entities.length);
}

/**
 * The recording holds 17 stations, seven of them assigned — one chunk of 50.
 * Nine copies under new station numbers (a synthetic test input) cross the
 * chunk boundary.
 */
function multiplied(payload: unknown, copies: number): unknown[] {
  assert.ok(isArray(payload));
  const out: unknown[] = [];
  for (let copy = 0; copy < copies; copy += 1) {
    for (const station of payload) {
      assert.ok(isRecord(station) && typeof station.number === "string");
      out.push({
        ...structuredClone(station),
        number: copy === 0 ? station.number : `${station.number}9${String(copy)}`,
      });
    }
  }
  return out;
}

async function crossesTheChunkBoundary(): Promise<void> {
  const payload = multiplied(readFixture(FIXTURE).payload, 9);
  const legacy = await runLegacy(payload);
  const plan = ported(payload, new SignatureStore().scope("test"));
  assert.ok(
    plan.entities.length > CHUNK_SIZE,
    `${String(plan.entities.length)} entities, more than one chunk`,
  );
  assert.ok(legacy.sizes.length > 1);
  assertPlanMatches(legacy, plan);
}

async function commitThenFreshnessOnly(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const store = new SignatureStore().scope("test");
  const first = await runLegacy(fixture.payload);
  const flow = await commitAll(first, ported(fixture.payload, store), store);
  assert.deepEqual(normalize(flow[GATE_KEY]), normalize(Object.fromEntries(store.copy(GATE_KEY))));

  const second = await runLegacy(fixture.payload, flow);
  const plan = ported(fixture.payload, store);
  assertPlanMatches(second, plan);
  assert.equal(plan.pending.length, 0);
  assert.deepEqual(Object.keys(plan.entities[0] ?? {}).sort(), ["@context", "dateObserved", "id", "type"]);
}

async function oneChangedGauge(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const store = new SignatureStore().scope("test");
  const flow = await commitAll(await runLegacy(fixture.payload), ported(fixture.payload, store), store);

  // Test input: Breisach's water level one centimetre higher.
  const changed = structuredClone(fixture.payload);
  const breisach: unknown = isArray(changed)
    ? changed.find((station: unknown) => isRecord(station) && station.number === "23300320")
    : undefined;
  assert.ok(isRecord(breisach) && isArray(breisach.timeseries));
  const series: unknown = breisach.timeseries.find(
    (entry: unknown) => isRecord(entry) && entry.shortname === "W",
  );
  assert.ok(isRecord(series) && isRecord(series.currentMeasurement));
  const measurement = series.currentMeasurement;
  assert.ok(typeof measurement.value === "number");
  measurement.value = measurement.value + 1;
  delete measurement.stateMnwMhw; // and without a state: 'unknown'

  const legacy = await runLegacy(changed, flow);
  const plan = ported(changed, store);
  assertPlanMatches(legacy, plan);
  assert.equal(plan.pending.length, 1);
  const full = plan.entities.find((entity) => "level" in entity);
  assert.ok(full !== undefined && isRecord(full.levelState));
  assert.equal(full.levelState.value, "unknown");
}

async function withoutMasterDataNamesAreEmpty(): Promise<void> {
  // PIP_ONLY reads bwGemeinden with `|| []`: the run goes ahead, names are ''.
  const fixture = readFixture(FIXTURE);
  const legacy = await runLegacy(fixture.payload, {}, false);
  const plan = ported(fixture.payload, new SignatureStore().scope("test"), false);
  assertPlanMatches(legacy, plan);
  assert.ok(plan.entities.length > 0);
  for (const entity of plan.entities)
    assert.deepEqual(normalize(entity.gemeindeName), normalize({ type: "Property", value: "" }));
}

async function badResponsesWriteNothing(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  for (const [statusCode, payload] of [
    [503, "<html>busy</html>"],
    [200, { not: "a list" }],
  ] as const) {
    const legacy = await runFunctionNode(NODE_ID, {
      msg: { ...messageFromFixture(fixture), statusCode, payload },
      global: { bwGrenzen: fixtureGeo().rawBoundaries },
    });
    assert.equal(legacy.returned, null);
    assert.equal(legacy.warnings.length, 1);

    const r = rig("pegel-bw", () =>
      httpResponse(statusCode, typeof payload === "string" ? payload : JSON.stringify(payload)),
    );
    await run(r.ctx);
    assert.equal(r.log.warnings().length, 1);
    assert.match(r.log.warnings()[0] ?? "", /^PEGELONLINE: no data \((503|200)\)$/);
    assert.equal(upsertBodies(r.seen).length, 0);
  }
}

async function runUpsertsWhatTheOldFlowSent(): Promise<void> {
  const fixture = readFixture(FIXTURE);
  const geo = fixtureGeo();
  const legacyClock = openClock();
  const legacy = await runLegacy(fixture.payload);
  const legacyWindow = legacyClock.close();
  const r = rig("pegel-bw", (request) => {
    if (request.url.host === "www.pegelonline.wsv.de")
      return httpResponse(200, JSON.stringify(fixture.payload));
    return httpResponse(204);
  });

  // Without boundaries the run is skipped (PIP_ONLY: "Grenzen-Cache fehlt").
  await run(r.ctx);
  assert.equal(upsertBodies(r.seen).length, 0);
  assert.match(r.log.warnings()[0] ?? "", /PEGELONLINE: municipality boundaries \(bwGrenzen\) not loaded/);

  r.geo.setMunicipalities(geo.rows);
  r.geo.setBoundaries(geo.boundaries, 0);
  const firstClock = openClock();
  await run(r.ctx);
  const firstWindow = firstClock.close();
  const bodies = upsertBodies(r.seen);
  assertEntitiesEqual(legacy.entities, bodies.flat());
  // ctx.now() is the real clock (src/kernel/context.ts), not the rig's.
  assertClockStamps(legacy.entities, bodies.flat(), { legacy: legacyWindow, ported: firstWindow });
  assert.deepEqual(
    bodies.map((body) => body.length),
    legacy.sizes,
  );
  // Confirmed by 204: the next run sends freshness stamps only — stamped with
  // the clock of THAT run, not carried over from the first.
  await sleep(5);
  const secondClock = openClock();
  await run(r.ctx);
  const secondWindow = secondClock.close();
  const second = upsertBodies(r.seen).slice(bodies.length).flat();
  assert.equal(second.length, legacy.entities.length);
  assert.ok(second.every((entity) => isRecord(entity) && !("level" in entity)));
  assertStampsWithin(second, secondWindow, legacy.entities);
}

/** 60 synthetic gauges in Stuttgart: two chunks of 50 and 10. */
function stuttgartGauges(level: (index: number) => number): unknown[] {
  return Array.from({ length: 60 }, (_, i) => ({
    latitude: 48.7758,
    longitude: 9.1829,
    number: String(i + 1),
    shortname: `P${String(i + 1)}`,
    water: { shortname: "NECKAR" },
    timeseries: [
      { shortname: "W", unit: "cm", currentMeasurement: { value: level(i), stateMnwMhw: "normal" } },
    ],
  }));
}

/**
 * The fix for values frozen during Orion outages, end to end through run():
 * a signature takes effect only for what the broker confirmed — per chunk, and
 * per entity on a 207 — so everything else is sent in full again next run.
 */
async function onlyConfirmedWritesAreGated(): Promise<void> {
  let stations: unknown[] = [];
  const answers: (HttpResponse | Error)[] = [];
  const r = rig("pegel-bw", (request) => {
    if (request.url.host === "www.pegelonline.wsv.de") return httpResponse(200, JSON.stringify(stations));
    return answers.shift() ?? httpResponse(204);
  });
  const geo = fullGeo();
  r.geo.setMunicipalities(geo.rows);
  r.geo.setBoundaries(geo.boundaries, 0);
  const table = (): Map<string, unknown> => r.signatures.scope("pegel-bw").copy(GATE_KEY);
  const runWith = async (
    payload: unknown[],
    ...brokerAnswers: (HttpResponse | Error)[]
  ): Promise<{ sizes: number[]; full: string[] }> => {
    stations = payload;
    answers.push(...brokerAnswers);
    const before = upsertBodies(r.seen).length;
    await run(r.ctx);
    const bodies = upsertBodies(r.seen).slice(before);
    const full = bodies
      .flat()
      .filter((entity) => isRecord(entity) && "level" in entity)
      .map((entity) => (isRecord(entity) ? String(entity.id) : ""));
    return { sizes: bodies.map((body) => body.length), full };
  };
  const id = (n: number): string => `urn:ngsi-ld:WaterLevelObserved:bw-pegel-${String(n)}`;

  // Orion down: both chunks refused, nothing committed, and said so.
  let sent = await runWith(
    stuttgartGauges(() => 100),
    new Error("connect ECONNREFUSED"),
    new Error("x"),
  );
  assert.deepEqual(sent.sizes, [50, 10]);
  assert.equal(table().size, 0, "signatures stored although the upsert failed");
  assert.ok(r.log.warnings().some((line) => line.startsWith("Upsert not confirmed")));

  // Everything is resent; the first chunk times out, the second is confirmed.
  sent = await runWith(
    stuttgartGauges(() => 100),
    new Error("ETIMEDOUT"),
    httpResponse(204),
  );
  assert.equal(sent.full.length, 60, "values not resent after a failed upsert");
  assert.equal(table().size, 10);

  // Only the entities of the failed chunk go out in full again.
  sent = await runWith(stuttgartGauges(() => 100));
  assert.deepEqual(
    sent.full,
    Array.from({ length: 50 }, (_, i) => id(i + 1)),
    "failed chunk not resent, or confirmed ones resent",
  );
  sent = await runWith(stuttgartGauges(() => 100));
  assert.deepEqual(sent.full, [], "unchanged values written again");
  assert.deepEqual(sent.sizes, [50, 10], "freshness stamps not written");

  // 207: gauge 1 fails, gauge 2 is confirmed — only gauge 1 is resent.
  const changed = (i: number): number => (i < 2 ? 200 : 100);
  sent = await runWith(
    stuttgartGauges(changed),
    httpResponse(
      207,
      JSON.stringify({ success: [id(2)], errors: [{ entityId: id(1), error: { status: 400 } }] }),
    ),
  );
  assert.deepEqual(sent.full, [id(1), id(2)]);
  sent = await runWith(stuttgartGauges(changed));
  assert.deepEqual(sent.full, [id(1)], "207: failed entity not resent, or confirmed one resent");
}

export {
  onlyConfirmedWritesAreGated as "pegel-bw: a failed upsert resends, a confirmed one gates — per chunk, and per entity on a 207",
  firstRunIsIdentical as "pegel-bw: old FN_PEGEL and ported build() + change gate emit identical chunks and signatures",
  crossesTheChunkBoundary as "pegel-bw: more stations than one chunk of 50 (synthetic copies) are chunked as by the old node",
  commitThenFreshnessOnly as "pegel-bw: commit after a confirmed upsert matches the old commit node, next run is freshness only",
  oneChangedGauge as "pegel-bw: one changed gauge (and a missing state) is sent in full on both sides",
  withoutMasterDataNamesAreEmpty as "pegel-bw: without master data the run goes ahead with empty names, on both sides",
  badResponsesWriteNothing as "pegel-bw: an HTTP error or a non-list answer warns and writes nothing",
  runUpsertsWhatTheOldFlowSent as "pegel-bw: run() skips without boundaries, then upserts exactly what the old flow sent",
};
