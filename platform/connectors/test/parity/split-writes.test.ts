/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Master data apart from measurements (src/kernel/split-gate.ts) and the
 * seeding of empty signature tables from the broker (`Orion.seedSignatures`).
 *
 * Orion-LD writes one TRoE row per attribute sent. A status change of an EV
 * charging station used to send all twelve attributes, a moved vehicle count
 * of a car sharing station all nine; now only the changed measurements plus
 * `dateObserved` go out. And a start on empty tables (fresh install, lost
 * state, the switch to the split tables) reads the broker first instead of
 * rewriting every entity.
 */

import assert from "node:assert/strict";

import { buildStatus, planStatus } from "../../src/connectors/carsharing-bw.js";
import type { StationCache } from "../../src/connectors/carsharing-bw.js";
import { build, COUNT_URL, pageUrl, planWrite, run } from "../../src/connectors/ladesaeulen-bw.js";
import type { ChargingRow, OcpdbRun } from "../../src/connectors/ladesaeulen-bw.js";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import type { SignatureScope } from "../../src/kernel/change-gate.js";
import { createOrion } from "../../src/kernel/orion.js";
import { planSplit } from "../../src/kernel/split-gate.js";
import { NGSI_CONTEXT } from "../../src/kernel/types.js";
import type { EntityId, NgsiEntity, UpsertPlan } from "../../src/kernel/types.js";
import { readFixture } from "../harness/fixtures.js";
import { httpResponse, recordingLog, scriptedFetcher } from "../harness/kernel.js";
import { fullGeo, HOUR, jsonAnswer, mobilityCtx } from "../harness/mobility.js";
import { isRecord } from "../harness/normalize.js";

const T0 = Date.parse("2026-09-29T09:00:00Z");
const BOOKKEEPING = new Set(["id", "type", "@context"]);

/** TRoE rows an upserted entity costs: one per attribute. */
function rows(entity: Readonly<Record<string, unknown>>): number {
  return Object.keys(entity).filter((key) => !BOOKKEEPING.has(key)).length;
}

function attributes(entity: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(entity)
    .filter((key) => !BOOKKEEPING.has(key))
    .sort();
}

/** The broker confirmed everything: what `Orion.upsert` commits after a 204. */
function confirmAll(store: SignatureScope, plan: UpsertPlan): void {
  store.commit(plan.pending, new Set<EntityId>(plan.entities.map((entity) => entity.id)));
}

function byId(plan: UpsertPlan, id: string): NgsiEntity | undefined {
  return plan.entities.find((entity) => entity.id === id);
}

/* ── the planner itself ──────────────────────────────────────────────────── */

function thing(id: string, name: string, a: number | undefined, b: number | undefined): NgsiEntity {
  return {
    id: `urn:ngsi-ld:Thing:${id}`,
    type: "Thing",
    "@context": NGSI_CONTEXT,
    name: { type: "Property", value: name },
    ...(a === undefined ? {} : { a: { type: "Property", value: a } }),
    ...(b === undefined ? {} : { b: { type: "Property", value: b } }),
    dateObserved: { type: "Property", value: { "@type": "DateTime", "@value": "2026-09-29T09:00:00Z" } },
  };
}

export function plannerSendsFullPartialOrStamp(): void {
  const spec = {
    staticKey: "s",
    dynamicKey: "d",
    staticSignature: (entity: NgsiEntity): string => JSON.stringify(entity.name),
    dynamic: ["a", "b"],
    replace: false,
  } as const;
  const first = planSplit([thing("1", "x", 1, 2)], new Map(), new Map(), spec, T0);
  assert.deepEqual([first.full, first.unknown, first.partial], [1, 1, 0]);
  assert.equal(first.pending.length, 2, "both signatures ride on a full write");

  const staticTable = new Map(first.pending.filter((p) => p[0] === "s").map((p) => [p[1], p[2] ?? ""]));
  const dynamicTable = new Map(first.pending.filter((p) => p[0] === "d").map((p) => [p[1], p[2] ?? ""]));

  const moved = planSplit([thing("1", "x", 1, 5)], staticTable, dynamicTable, spec, T0);
  assert.equal(moved.partial, 1);
  assert.deepEqual(attributes(moved.entities[0] ?? {}), ["b", "dateObserved"], "only b and the stamp");
  assert.deepEqual(
    moved.pending.map((p) => p[0]),
    ["d"],
    "a partial write carries the dynamic signature only",
  );
  assert.deepEqual([...moved.dropDynamic], ["urn:ngsi-ld:Thing:1"]);
  assert.deepEqual([...moved.dropStatic], [], "master data unchanged: its signature stays");

  const renamed = planSplit([thing("1", "y", 1, 2)], staticTable, dynamicTable, spec, T0);
  assert.equal(renamed.full, 1, "changed master data: full write");
  assert.equal(rows(renamed.entities[0] ?? {}), 4);

  const vanished = planSplit([thing("1", "x", 1, undefined)], staticTable, dynamicTable, spec, T0);
  assert.equal(vanished.full, 1, "a measurement that disappeared cannot be a partial update");

  const same = planSplit([thing("1", "x", 1, 2)], staticTable, dynamicTable, spec, T0);
  assert.deepEqual([same.unchanged, same.fresh, same.pending.length], [1, 1, 0]);
  assert.deepEqual(attributes(same.entities[0] ?? {}), ["dateObserved"], "freshness stamp only");
}

/* ── EVChargingStation / ChargingSummary ─────────────────────────────────── */

const STUTTGART: readonly [number, number] = [48.7758, 9.1829];

function ocpdb(rowsOfRun: readonly ChargingRow[]): OcpdbRun {
  return {
    expectedPages: 1,
    announced: rowsOfRun.length,
    pages: [{ ok: true, items: rowsOfRun.length, rows: rowsOfRun }],
  };
}

function charging(id: string, free: number, busy: number): ChargingRow {
  // [id, lat, lon, evses, live, free, defect, name, operator, address, charging]
  return [
    id,
    STUTTGART[0],
    STUTTGART[1],
    4,
    4,
    free,
    0,
    `Station ${id}`,
    "Betreiber",
    "Weg 1, 70173 Stuttgart",
    busy,
  ];
}

function register(id: string): ChargingRow {
  return [
    id,
    STUTTGART[0] + 0.001,
    STUTTGART[1],
    2,
    0,
    0,
    0,
    `Register ${id}`,
    "Betreiber",
    "Weg 2, 70173 Stuttgart",
    0,
  ];
}

/** A status-only change of one EV station: its changed counters and the stamp, 3 rows instead of 12. */
export function evStatusChangeIsAPartialWrite(): void {
  const store = new SignatureStore().scope("ladesaeulen-bw");
  const gate = createChangeGate(store, recordingLog(), () => T0);
  const geo = fullGeo().index;
  const now = new Date(T0).toISOString();

  const first = planWrite(gate, build(ocpdb([charging("1", 2, 2), register("2")]), geo, now), T0);
  const station = first.plan.entities.find((entity) => entity.id.endsWith("-ocpdb-1"));
  assert.ok(station !== undefined);
  assert.equal(rows(station), 12, "a new station goes out in full");
  assert.equal(first.stations.full, 2);
  confirmAll(store, first.plan);

  // One EVSE went from available to charging.
  const second = planWrite(gate, build(ocpdb([charging("1", 1, 3), register("2")]), geo, now), T0 + HOUR);
  const partial = byId(second.plan, station.id);
  assert.ok(partial !== undefined);
  assert.deepEqual(attributes(partial), ["availableEvse", "chargingEvse", "dateObserved"]);
  assert.equal(rows(partial), 3);
  assert.deepEqual(
    [second.stations.full, second.stations.partial, second.stations.partialAttributes],
    [0, 1, 2],
  );
  // The register entry has no stamp and nothing changed: not written at all.
  assert.equal(second.plan.entities.filter((entity) => entity.id.endsWith("-ocpdb-2")).length, 0);
  // The municipal sum moved the same way: two counters and the stamp.
  const sum = second.plan.entities.find((entity) => entity.type === "ChargingSummary");
  assert.ok(sum !== undefined);
  assert.deepEqual(attributes(sum), ["availableEvse", "chargingEvse", "dateObserved"]);
  confirmAll(store, second.plan);

  // Nothing changed: stamps only, in the rotation of every third run.
  const third = planWrite(gate, build(ocpdb([charging("1", 1, 3), register("2")]), geo, now), T0 + 2 * HOUR);
  assert.ok(third.plan.entities.every((entity) => attributes(entity).join() === "dateObserved"));
  assert.deepEqual([third.stations.full, third.stations.partial, third.summaries.partial], [0, 0, 0]);
}

/* ── CarSharingStation ───────────────────────────────────────────────────── */

const CACHE: StationCache = new Map([
  [
    "swu2go::st-1",
    { ags: "08421000", slug: "ulm", name: "Hauptbahnhof", lat: 48.3985, lon: 9.9831, kap: 4, sys: "swu2go" },
  ],
]);

function carsharing(available: number, now: string): ReturnType<typeof buildStatus> {
  return buildStatus(
    { system: "swu2go", stations: [{ stationId: "st-1", available }] },
    CACHE,
    new Map([["swu2go", "car"]]),
    now,
  );
}

/** A moved vehicle count: `availableVehicles` and the stamp, 2 rows instead of 9. */
export function carSharingCountChangeIsAPartialWrite(): void {
  const store = new SignatureStore().scope("carsharing-bw");
  const gate = createChangeGate(store, recordingLog(), () => T0);
  const now = new Date(T0).toISOString();
  const first = planStatus(gate, carsharing(2, now), T0);
  const full = first.plan.entities.find((entity) => entity.type === "CarSharingStation");
  assert.ok(full !== undefined);
  assert.equal(rows(full), 9);
  confirmAll(store, first.plan);

  const second = planStatus(gate, carsharing(3, now), T0 + HOUR);
  const partial = second.plan.entities.find((entity) => entity.type === "CarSharingStation");
  assert.ok(partial !== undefined);
  assert.deepEqual(attributes(partial), ["availableVehicles", "dateObserved"]);
  assert.equal(second.stations.partial, 1);
  // Fleets stay ungated: written in full every run.
  assert.ok(second.plan.entities.some((entity) => entity.type === "FleetStatus" && rows(entity) > 2));
}

/* ── seeding ─────────────────────────────────────────────────────────────── */

function items(payload: unknown): unknown[] {
  return isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
}

/** Both recorded OCPDB pages as one complete page (test input, as in ladesaeulen-bw.test.ts). */
function oneOcpdbPage(): { count: unknown; page: unknown } {
  const all = [
    ...items(readFixture("ladesaeulen-bw-offset10000").payload),
    ...items(readFixture("ladesaeulen-bw-offset20000").payload),
  ];
  const count = readFixture("ladesaeulen-bw-count").payload;
  return { count: { ...(isRecord(count) ? count : {}), total_count: all.length }, page: { items: all } };
}

/** What a broker holds after the upserts: attributes merged per entity, as `options=update` does. */
function brokerState(upserts: readonly unknown[][]): Map<string, Record<string, unknown>> {
  const held = new Map<string, Record<string, unknown>>();
  for (const entity of upserts.flat()) {
    if (!isRecord(entity) || typeof entity.id !== "string") continue;
    held.set(entity.id, { ...held.get(entity.id), ...entity });
  }
  return held;
}

/**
 * The restart after a state loss: empty tables, but the broker holds every
 * entity. The seeding reads them and the run writes no entity in full.
 */
export async function emptyTablesAreSeededFromTheBroker(): Promise<void> {
  const input = oneOcpdbPage();
  const before = mobilityCtx({ id: "ladesaeulen-bw", start: T0 });
  before.broker.sources.set(COUNT_URL, jsonAnswer(input.count));
  before.broker.sources.set(pageUrl(0), jsonAnswer(input.page));
  await run(before.ctx);
  const written = before.broker.upserts.flat().filter(isRecord);
  assert.ok(written.length > 20 && written.every((entity) => rows(entity) >= 3), "first run: all in full");

  // A new process, nothing in its tables; the broker kept what was written.
  const after = mobilityCtx({ id: "ladesaeulen-bw", start: T0 + HOUR });
  for (const [id, entity] of brokerState(before.broker.upserts)) after.broker.entities.set(id, entity);
  after.broker.sources.set(COUNT_URL, jsonAnswer(input.count));
  after.broker.sources.set(pageUrl(0), jsonAnswer(input.page));
  await run(after.ctx);

  const full = after.broker.upserts
    .flat()
    .filter(isRecord)
    .filter((entity) => attributes(entity).some((name) => name !== "dateObserved"));
  assert.deepEqual(full, [], "entities written again although the broker holds them unchanged");
  assert.ok(after.broker.upserts.flat().length > 0, "the run wrote its freshness stamps");
  assert.ok(after.broker.seedListings().length >= 2, "the broker was listed for the seeding");
  const seeded = after.log.lines
    .map((line) => /^OCPDB: (\d+) change signatures seeded from (\d+) entities/.exec(line.text))
    .find((match) => match !== null);
  assert.ok(seeded !== undefined, "no seeding line");
  assert.equal(Number(seeded[1]), 2 * written.length, "master data and live signature of every entity");
  assert.deepEqual(after.log.warnings(), []);
}

/** A listing that does not add up seeds nothing: the entities are written in full, as without seeding. */
export async function incompleteListingSeedsNothing(): Promise<void> {
  const log = recordingLog();
  const store = new SignatureStore().scope("x");
  const gate = createChangeGate(store, log);
  const { fetcher } = scriptedFetcher(() =>
    httpResponse(200, JSON.stringify([{ id: "urn:ngsi-ld:Thing:1", type: "Thing" }]), {
      "ngsild-results-count": "2",
    }),
  );
  const orion = createOrion(log, fetcher, gate, store, "http://orion.test");
  const options = {
    label: "Things",
    queries: [{ type: "Thing", pattern: "^urn:ngsi-ld:Thing:[0-9]+$" }],
    attrs: ["name"],
    tables: { thingSig: () => "x" },
  };
  const result = await orion.seedSignatures(options);
  assert.equal(result.seeded, 0);
  assert.match(result.skipped ?? "", /incomplete \(1\/2\)/);
  assert.equal(store.size("thingSig"), 0);
  assert.equal(log.warnings().filter((line) => line.includes("not seeded from the broker")).length, 1);

  // A table that holds anything is never touched, and costs no request.
  store.replace("thingSig", new Map([["urn:ngsi-ld:Thing:9", "y"]]));
  const again = await orion.seedSignatures(options);
  assert.deepEqual([again.seeded, again.skipped], [0, "no empty table"]);
  assert.deepEqual([...store.copy("thingSig")], [["urn:ngsi-ld:Thing:9", "y"]]);
}
