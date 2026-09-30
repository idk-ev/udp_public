/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: sharing-bw — the system list node (`udp-rt-bg-msgs`), FN_GBFS_FF
 * (`udp-rt-bg-fn`) and the commit node (`udp-rt-bg-commit`) against the port.
 *
 * Pinned: the per-system summaries on two real feeds, the zero tables
 * `ffLast:<system>` through a sequence of runs with confirmed and failed
 * commits (the confirmed zero written once, an empty feed zeroing nothing, a
 * failed zero written again), the dropping of tables of systems that left
 * the list, the age prune, and the skip without boundaries.
 *
 * DELIBERATE DEVIATION (module header, "Form factors and docked vehicles"):
 * every summary carries `vehiclesByFormFactor`, and docked vehicles of
 * station-based systems are not counted. The comparison with the old node strips the
 * new attribute ({@link withoutSplit}) — none of the recorded vehicles is
 * docked — and the tests at the end pin the new behaviour.
 *
 * Fixtures: test/fixtures/gbfs-systems.json, sharing-bw-hopp_konstanz.json,
 * sharing-bw-zeus_tuttlingen.json and their -vehicle_types.json (see their
 * `note`s). The zero-table sequence uses vehicles placed in Stuttgart and
 * Reutlingen — test inputs, the same points as the generator's static test.
 */

import assert from "node:assert/strict";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import type { SignatureScope } from "../../src/kernel/change-gate.js";
import {
  build,
  FORM_FACTORS,
  formFactorKey,
  lastKey,
  parse,
  parseVehicleTypes,
  planSystem,
  run,
  TYPES_MAX_AGE_MS,
  TYPES_RETRY_MS,
  typesStale,
} from "../../src/connectors/sharing-bw.js";
import type { SharingSummaryEntity, Vehicle } from "../../src/connectors/sharing-bw.js";
import type { EntityId, UpsertPlan } from "../../src/kernel/types.js";
import { readFixture } from "../harness/fixtures.js";
import { fakeHttpModule, httpResponse, recordingLog } from "../harness/kernel.js";
import {
  Broker,
  flowObject,
  fullGeo,
  HOUR,
  jsonAnswer,
  legacyGlobal,
  mobilityCtx,
  staleOptions,
  tableObject,
} from "../harness/mobility.js";
import { assertPruneSettings, legacyPruneSettings } from "../harness/prune-settings.js";
import {
  assertClockStamps,
  assertEntitiesEqual,
  fixedClock,
  isRecord,
  normalize,
  openClock,
} from "../harness/normalize.js";
import { messagesOf, runFunctionNode } from "../harness/vm-runner.js";

const LIST_NODE = "udp-rt-bg-msgs";
const BUILD_NODE = "udp-rt-bg-fn";
const COMMIT_NODE = "udp-rt-bg-commit";
const FEEDS = {
  hopp_konstanz: "sharing-bw-hopp_konstanz",
  zeus_tuttlingen: "sharing-bw-zeus_tuttlingen",
} as const;

function feedPayload(system: keyof typeof FEEDS): unknown {
  return structuredClone(readFixture(FEEDS[system]).payload);
}

function feedUrl(system: keyof typeof FEEDS): string {
  return readFixture(FEEDS[system]).source;
}

function typesFixture(system: keyof typeof FEEDS): { source: string; payload: unknown } {
  return readFixture(`${FEEDS[system]}-vehicle_types`);
}

/** The deliberate new attribute removed, for the comparison with the old node. */
function withoutSplit(entities: readonly unknown[]): unknown[] {
  return entities.map((entity) => {
    if (!isRecord(entity)) return entity;
    return Object.fromEntries(Object.entries(entity).filter(([key]) => key !== "vehiclesByFormFactor"));
  });
}

interface LegacyWrite {
  readonly message: Record<string, unknown> | null;
  readonly flow: Record<string, unknown>;
  readonly warnings: readonly string[];
}

async function legacySystem(
  system: string,
  payload: unknown,
  flow: Readonly<Record<string, unknown>>,
  withBoundaries = true,
): Promise<LegacyWrite> {
  const run = await runFunctionNode(BUILD_NODE, {
    msg: { _msgid: "parity", statusCode: 200, system, payload },
    global: legacyGlobal(fullGeo(), withBoundaries),
    flow,
  });
  const messages = messagesOf(run).filter(isRecord);
  return { message: messages[0] ?? null, flow: flowObject(run.flow), warnings: run.warnings };
}

async function legacyCommit(write: LegacyWrite, statusCode: number): Promise<Record<string, unknown>> {
  if (write.message === null) return write.flow;
  const commit = await runFunctionNode(COMMIT_NODE, {
    msg: { ...write.message, statusCode, payload: "" },
    flow: write.flow,
  });
  return flowObject(commit.flow);
}

function ported(system: string, payload: unknown, store: SignatureScope): UpsertPlan {
  const feed = parse({ system, payload });
  const geo = fullGeo().index;
  const now = new Date().toISOString();
  const gate = createChangeGate(store, recordingLog());
  return planSystem(feed, build(feed, geo, now), gate.table(lastKey(feed.system)), geo, now);
}

function assertWriteMatches(legacy: LegacyWrite, plan: UpsertPlan, when: string): void {
  if (legacy.message === null) {
    assert.equal(plan.entities.length, 0, `${when}: the old node wrote nothing`);
    return;
  }
  assertEntitiesEqual(legacy.message.payload, withoutSplit(plan.entities));
  assert.deepEqual(normalize(legacy.message.sigCommit), normalize(plan.pending), `${when}: pending differs`);
}

/* ── 1. the real feeds ───────────────────────────────────────────────────── */

async function realFeedsBuildTheSameSummaries(): Promise<void> {
  for (const system of ["hopp_konstanz", "zeus_tuttlingen"] as const) {
    const legacy = await legacySystem(system, feedPayload(system), {});
    const plan = ported(system, feedPayload(system), new SignatureStore().scope("sharing-bw"));
    assert.deepEqual(legacy.warnings, []);
    assert.ok(plan.entities.length > 0, `${system}: nothing assigned`);
    assertWriteMatches(legacy, plan, system);
  }
}

/* ── 2. zero tables ──────────────────────────────────────────────────────── */

const STUTTGART = [48.7758, 9.1829] as const;
const REUTLINGEN = [48.49388, 9.18829] as const;

function feedOf(points: readonly (readonly [number, number])[]): unknown {
  return {
    data: { bikes: points.map(([lat, lon]) => ({ lat, lon, is_disabled: false, is_reserved: false })) },
  };
}

async function zeroTablesFollowTheOldSequence(): Promise<void> {
  const system = "testsys";
  const key = lastKey(system);
  const store = new SignatureStore().scope("sharing-bw");
  let flow: Record<string, unknown> = {};

  const step = async (
    points: readonly (readonly [number, number])[],
    statusCode: number,
    when: string,
  ): Promise<UpsertPlan> => {
    const legacy = await legacySystem(system, feedOf(points), flow);
    const plan = ported(system, feedOf(points), store);
    assertWriteMatches(legacy, plan, when);
    flow = await legacyCommit(legacy, statusCode);
    const ok = statusCode >= 200 && statusCode < 300;
    store.commit(plan.pending, new Set<EntityId>(ok ? plan.entities.map((entity) => entity.id) : []));
    assert.deepEqual(
      normalize(tableObject(store, key)),
      normalize(flow[key] ?? {}),
      `${when}: ${key} differs`,
    );
    return plan;
  };
  const counts = (plan: UpsertPlan): Record<string, unknown> =>
    Object.fromEntries(plan.pending.map(([, ags, value]) => [ags, value]));

  let plan = await step([STUTTGART, STUTTGART, REUTLINGEN], 201, "first sighting");
  assert.deepEqual(counts(plan), { "08111000": 2, "08415061": 1 });
  plan = await step([STUTTGART], 204, "Reutlingen emptied");
  assert.deepEqual(
    counts(plan),
    { "08111000": 1, "08415061": null },
    "no zero for the vanished municipality",
  );
  plan = await step([STUTTGART], 204, "zero confirmed");
  assert.deepEqual(counts(plan), { "08111000": 1 }, "zero written again after it was confirmed");
  plan = await step([], 204, "empty feed");
  assert.equal(plan.entities.length, 0, "an empty feed zeroes every municipality");
  plan = await step([REUTLINGEN], 500, "Stuttgart emptied, write failed");
  assert.deepEqual(counts(plan), { "08415061": 1, "08111000": null });
  plan = await step([REUTLINGEN], 204, "failed zero repeated");
  assert.deepEqual(counts(plan), { "08415061": 1, "08111000": null }, "failed zero write not repeated");
}

/* ── 3. run(): list, dropped tables, prune, upserts ──────────────────────── */

const OLD_SUMMARY = "urn:ngsi-ld:SharingSummary:bw-08111000-ff-gone";
const LIVE_SUMMARY = "urn:ngsi-ld:SharingSummary:bw-08111000-ff-hopp_konstanz";

function seed(broker: Broker, now: number): void {
  const stamp = (ms: number): Record<string, unknown> => ({
    type: "Property",
    value: { "@type": "DateTime", "@value": new Date(ms).toISOString() },
  });
  broker.entities.set(OLD_SUMMARY, {
    id: OLD_SUMMARY,
    type: "SharingSummary",
    dateObserved: stamp(now - 30 * HOUR),
  });
  broker.entities.set(LIVE_SUMMARY, {
    id: LIVE_SUMMARY,
    type: "SharingSummary",
    dateObserved: stamp(now - HOUR),
  });
}

function serveFeeds(broker: Broker): void {
  const list = readFixture("gbfs-systems");
  broker.sources.set(list.source, jsonAnswer(list.payload));
  for (const system of ["hopp_konstanz", "zeus_tuttlingen"] as const) {
    broker.sources.set(feedUrl(system), jsonAnswer(feedPayload(system)));
    const types = typesFixture(system);
    broker.sources.set(types.source, jsonAnswer(types.payload));
  }
}

async function runMatchesTheOldFlow(): Promise<void> {
  const list = readFixture("gbfs-systems");
  const now = Date.now();
  // Old: the list node with a table of a vanished system and one of an active
  // one, the prune interval satisfied as if the previous hour had run.
  const oldBroker = new Broker(fullGeo().municipalities.length);
  seed(oldBroker, now);
  const tables = {
    "ffLast:gone": { "08111000": 3 },
    "ffLast:hopp_konstanz": { "08335043": 2 },
  };
  const legacyList = await runFunctionNode(LIST_NODE, {
    msg: { _msgid: "parity", statusCode: 200, payload: structuredClone(list.payload) },
    global: legacyGlobal(fullGeo()),
    flow: { ...structuredClone(tables), pruneLastRun_GBFS_BW: now - HOUR },
    modules: { http: fakeHttpModule(oldBroker.respond) },
  });
  await oldBroker.idle();
  const requested = messagesOf(legacyList).map((message) => (isRecord(message) ? message.url : undefined));

  // Port: two runs an hour apart (the first one only arms the interval).
  const world = mobilityCtx({ id: "sharing-bw", start: now - HOUR });
  seed(world.broker, now);
  serveFeeds(world.broker);
  for (const [key, table] of Object.entries(tables)) world.store.replace(key, new Map(Object.entries(table)));
  await run(world.ctx);
  world.clock.now = now;
  world.broker.requests.length = 0;
  world.broker.upserts.length = 0;
  await run(world.ctx);

  assert.deepEqual(
    world.broker.requests
      .filter((request) => request.url.pathname.endsWith("/free_bike_status"))
      .map((r) => r.url.href),
    requested,
    "free_bike_status requests differ",
  );
  // The table of the vanished system is gone on both sides, the active one stays.
  for (const key of Object.keys(tables)) {
    assert.equal(
      world.store.keys().includes(key),
      legacyList.flow.get(key) !== undefined,
      `${key}: dropped on one side only`,
    );
  }
  assert.ok(!world.store.keys().includes("ffLast:gone"));
  // The settings themselves, against the old pruneStale option objects.
  assertPruneSettings("sharing-bw", legacyPruneSettings(LIST_NODE), staleOptions(world), world.ctx);
  assert.deepEqual(world.broker.deletes.flat(), oldBroker.deletes.flat(), "pruned ids differ");
  assert.deepEqual(oldBroker.deletes.flat(), [OLD_SUMMARY]);
  assert.deepEqual(world.broker.listings(), oldBroker.listings(), "prune listings differ");

  // What each system wrote: the old build node on the same feeds, with the
  // tables the list node left behind.
  let flow = flowObject(legacyList.flow);
  const expected: unknown[] = [];
  const legacyClock = openClock();
  for (const system of ["hopp_konstanz", "zeus_tuttlingen"] as const) {
    const legacy = await legacySystem(system, feedPayload(system), flow);
    if (legacy.message !== null) expected.push(JSON.parse(JSON.stringify(legacy.message.payload)));
    flow = await legacyCommit(legacy, 204);
  }
  const legacyWindow = legacyClock.close();
  assert.deepEqual(normalize(world.broker.upserts.map(withoutSplit)), normalize(expected), "upserts differ");
  // Both recorded systems rent e-scooters only; the split says so.
  for (const entity of world.broker.upserts.flat()) {
    assert.ok(
      isRecord(entity) && isRecord(entity.vehiclesByFormFactor) && isRecord(entity.availableVehicles),
    );
    const split = entity.vehiclesByFormFactor.value;
    assert.ok(isRecord(split));
    assert.deepEqual(Object.keys(split), [...FORM_FACTORS]);
    assert.equal(split.scooter_standing, entity.availableVehicles.value);
  }
  assertClockStamps(expected, world.broker.upserts.map(withoutSplit), {
    legacy: legacyWindow,
    ported: fixedClock(now),
  });
  for (const key of ["ffLast:hopp_konstanz", "ffLast:zeus_tuttlingen"]) {
    assert.deepEqual(
      normalize(tableObject(world.store, key)),
      normalize(flow[key] ?? {}),
      `${key} after commit`,
    );
  }
  // One line confirms the run (the old node logged nothing on success).
  const written = world.broker.upserts.flat();
  const zeroed = written.filter(
    (entity) =>
      isRecord(entity) && isRecord(entity.availableVehicles) && entity.availableVehicles.value === 0,
  ).length;
  const summary = world.log.lines.filter((line) => line.level === "info").at(-1)?.text;
  assert.equal(
    summary,
    `GBFS-BW: ${String(messagesOf(legacyList).length)} systems, ${String(written.length)} summaries written ` +
      `(${String(zeroed)} of them zeroed), prune: 1 deleted`,
  );
}

async function brokenListWarnsOnce(): Promise<void> {
  const legacy = await runFunctionNode(LIST_NODE, {
    msg: { _msgid: "parity", statusCode: 503, payload: "" },
    global: legacyGlobal(fullGeo()),
    modules: { http: fakeHttpModule(new Broker(0).respond) },
  });
  assert.equal(messagesOf(legacy).length, 0);
  assert.equal(legacy.warnings.length, 1);

  const world = mobilityCtx({ id: "sharing-bw", start: Date.now() });
  world.broker.sources.set(readFixture("gbfs-systems").source, httpResponse(503, ""));
  await run(world.ctx);
  assert.deepEqual(world.log.warnings(), ["GBFS-BW: system list not loadable"]);
  assert.equal(world.broker.requests.length, 1, "went on after a broken list");
}

async function noBoundariesSkipsEverySystem(): Promise<void> {
  const legacy = await legacySystem("hopp_konstanz", feedPayload("hopp_konstanz"), {}, false);
  assert.equal(legacy.message, null);
  assert.equal(legacy.warnings.length, 1);

  const world = mobilityCtx({ id: "sharing-bw", start: Date.now(), boundaries: false });
  serveFeeds(world.broker);
  await run(world.ctx);
  assert.deepEqual(world.broker.upserts, [], "wrote without boundaries");
  // One warning per system with a readable feed, as the old build node.
  assert.equal(
    world.log.warnings().filter((line) => line.includes("municipality boundaries (bwGrenzen) not loaded"))
      .length,
    2,
  );
}

/* ── 4. form factors and docked vehicles (deliberate, module header) ───────── */

/** Test input shaped like a real mixed system (mopeds, e-scooters, bikes, as stella's list). */
const MIXED_TYPES = {
  data: {
    vehicle_types: [
      { vehicle_type_id: "T:moped", form_factor: "moped" },
      { vehicle_type_id: "T:moped2", form_factor: "moped" },
      { vehicle_type_id: "T:scooter", form_factor: "scooter" },
      { vehicle_type_id: "T:bike", form_factor: "bicycle" },
      { vehicle_type_id: "T:cargo", form_factor: "cargo_bicycle" },
      { vehicle_type_id: "T:car", form_factor: "car" },
      { vehicle_type_id: "T:seated", form_factor: "scooter_seated" },
      { form_factor: "car" },
    ],
  },
};

/** Test input: a station-based bike system. */
const BIKE_TYPES = {
  data: {
    vehicle_types: [
      { vehicle_type_id: "T:bike", form_factor: "bicycle" },
      { vehicle_type_id: "T:cargo", form_factor: "cargo_bicycle" },
      { vehicle_type_id: "T:bike2", form_factor: "bicycle" },
    ],
  },
};

function mixedFeed(): unknown {
  const at = ([lat, lon]: readonly [number, number], extra: Record<string, unknown>): unknown => ({
    lat,
    lon,
    is_disabled: false,
    is_reserved: false,
    ...extra,
  });
  return {
    data: {
      bikes: [
        at(STUTTGART, { vehicle_type_id: "T:scooter" }),
        at(STUTTGART, { vehicle_type_id: "T:scooter" }),
        at(STUTTGART, { vehicle_type_id: "T:moped2" }),
        at(STUTTGART, { vehicle_type_id: "T:bike" }),
        at(STUTTGART, { vehicle_type_id: "T:cargo" }),
        at(STUTTGART, { vehicle_type_id: "T:car" }),
        at(STUTTGART, { vehicle_type_id: "T:seated" }),
        // Unknown type id and none at all: the prevailing form factor (moped).
        at(STUTTGART, { vehicle_type_id: "T:new" }),
        at(STUTTGART, {}),
        // Docked: left out only in a station-based system (see BIKE_TYPES).
        at(STUTTGART, { vehicle_type_id: "T:bike", station_id: "st-1" }),
        at(REUTLINGEN, { vehicle_type_id: "T:bike", station_id: 7 }),
        // Not rentable: counted by neither.
        at(REUTLINGEN, { vehicle_type_id: "T:scooter", is_disabled: true }),
      ],
    },
  };
}

function splitOf(entity: SharingSummaryEntity | undefined): Record<string, number> {
  assert.ok(entity !== undefined);
  return { ...entity.vehiclesByFormFactor.value };
}

async function formFactorsSplitTheTotal(): Promise<void> {
  const geo = fullGeo().index;
  const now = new Date().toISOString();
  // Mopeds prevail: docked vehicles are nobody else's, they stay in.
  const feed = parse({ system: "mixed", payload: mixedFeed(), vehicleTypes: MIXED_TYPES });
  assert.equal(feed.reported, 12);
  assert.equal(feed.docked, 2);
  const summaries = build(feed, geo, now);
  assert.deepEqual(
    summaries.map((entity) => [entity.ags.value, entity.availableVehicles.value]),
    [
      ["08111000", 10],
      ["08415061", 1],
    ],
  );
  assert.deepEqual(splitOf(summaries[0]), {
    scooter_standing: 2,
    bicycle: 2,
    cargo_bicycle: 1,
    moped: 3,
    car: 1,
    other: 1,
  });

  // A bike system: its docked bikes are the station side's (Leihräder).
  const bikes = parse({ system: "bikes", payload: mixedFeed(), vehicleTypes: BIKE_TYPES });
  const stationBased = build(bikes, geo, now);
  // Reutlingen only had a docked and a disabled vehicle: no summary.
  assert.deepEqual(
    stationBased.map((entity) => [entity.ags.value, entity.availableVehicles.value]),
    [["08111000", 9]],
  );
  // The old node counted the docked bike as well.
  const legacy = await legacySystem("bikes", mixedFeed(), {});
  const payload = legacy.message?.payload;
  assert.ok(Array.isArray(payload));
  const old: unknown = payload.find(
    (entity) => isRecord(entity) && isRecord(entity.ags) && entity.ags.value === "08111000",
  );
  assert.ok(isRecord(old) && isRecord(old.availableVehicles));
  assert.equal(old.availableVehicles.value, 10);

  // Without vehicle_types every vehicle is "other"; the total is the same.
  const blind = build(parse({ system: "mixed", payload: mixedFeed() }), geo, now);
  assert.equal(blind[0]?.availableVehicles.value, 10);
  assert.deepEqual(splitOf(blind[0]), {
    scooter_standing: 0,
    bicycle: 0,
    cargo_bicycle: 0,
    moped: 0,
    car: 0,
    other: 10,
  });
  // A zero summary carries an all-zero split.
  const zero: unknown = planSystem(feed, [], new Map([["08111000", 4]]), geo, now).entities[0];
  assert.ok(
    isRecord(zero) && isRecord(zero.vehiclesByFormFactor) && isRecord(zero.vehiclesByFormFactor.value),
  );
  assert.deepEqual(Object.values(zero.vehiclesByFormFactor.value), [0, 0, 0, 0, 0, 0]);
}

function vehicleTypesAreNarrowed(): void {
  assert.equal(formFactorKey("scooter"), "scooter_standing");
  assert.equal(formFactorKey("scooter_standing"), "scooter_standing");
  assert.equal(formFactorKey("scooter_seated"), "other");
  assert.equal(formFactorKey(undefined), "other");
  assert.equal(formFactorKey("constructor"), "other");
  for (const system of ["hopp_konstanz", "zeus_tuttlingen"] as const) {
    const types = parseVehicleTypes(typesFixture(system).payload);
    assert.ok(types.byId.size > 0, `${system}: no vehicle types`);
    assert.equal(types.prevailing, "scooter_standing");
  }
  const mixed = parseVehicleTypes(MIXED_TYPES);
  assert.equal(mixed.byId.size, 7, "an entry without an id is skipped");
  assert.equal(mixed.prevailing, "moped");
  assert.equal(parseVehicleTypes({ data: {} }).prevailing, null);
  assert.equal(parseVehicleTypes("<html/>").byId.size, 0);
}

async function vehicleTypesAreFetchedOnceAndOnlyForBw(): Promise<void> {
  const now = Date.now();
  const world = mobilityCtx({ id: "sharing-bw", start: now });
  serveFeeds(world.broker);
  await run(world.ctx);
  const typeRequests = (): string[] =>
    world.broker.requests.filter((r) => r.url.pathname.endsWith("/vehicle_types")).map((r) => r.url.href);
  // Only the two systems with a readable feed and vehicles in BW; the other
  // systems of the fixture list answer 404 for free_bike_status.
  assert.deepEqual(typeRequests().sort(), [
    typesFixture("hopp_konstanz").source,
    typesFixture("zeus_tuttlingen").source,
  ]);
  world.broker.requests.length = 0;
  world.clock.now = now + HOUR;
  await run(world.ctx);
  assert.deepEqual(typeRequests(), [], "kept types fetched again within a day");
  world.broker.requests.length = 0;
  world.clock.now = now + TYPES_MAX_AGE_MS + 2 * HOUR;
  await run(world.ctx);
  assert.equal(typeRequests().length, 2, "types older than a day not fetched again");

  // A system without a usable list is asked again after TYPES_RETRY_MS, not every run.
  const bare = mobilityCtx({ id: "sharing-bw", start: now });
  serveFeeds(bare.broker);
  bare.broker.sources.delete(typesFixture("hopp_konstanz").source);
  await run(bare.ctx);
  const bareTypes = (): number =>
    bare.broker.requests.filter((r) => r.url.pathname.endsWith("/vehicle_types")).length;
  assert.equal(bareTypes(), 2);
  bare.broker.requests.length = 0;
  bare.clock.now = now + HOUR;
  await run(bare.ctx);
  assert.equal(bareTypes(), 0, "a failed vehicle_types fetched again the next run");
  bare.broker.requests.length = 0;
  bare.clock.now = now + TYPES_RETRY_MS + 2 * HOUR;
  await run(bare.ctx);
  assert.equal(bareTypes(), 1, "a failed vehicle_types not retried");

  // A type id the kept list lacks fetches again.
  const feed = parse({ system: "hopp_konstanz", payload: feedPayload("hopp_konstanz") });
  const kept = { types: parseVehicleTypes(typesFixture("hopp_konstanz").payload), fetchedMs: now };
  assert.equal(typesStale(kept, feed, now + HOUR), false);
  assert.equal(typesStale(undefined, feed, now), true);
  // An unknown type id or an empty list: fetched again, but not before TYPES_RETRY_MS.
  const newType: Vehicle = [47.66, 9.17, true, "HOP:VehicleType:new", false];
  const withNew = { ...feed, vehicles: [newType] };
  assert.equal(typesStale(kept, withNew, now + HOUR), false);
  assert.equal(typesStale(kept, withNew, now + TYPES_RETRY_MS + HOUR), true);
  const empty = { types: parseVehicleTypes({}), fetchedMs: now };
  assert.equal(typesStale(empty, feed, now + HOUR), false);
  assert.equal(typesStale(empty, feed, now + TYPES_RETRY_MS + HOUR), true);
}

export {
  formFactorsSplitTheTotal as "sharing-bw: vehiclesByFormFactor splits the total, docked vehicles of station-based systems are not counted (deliberate)",
  vehicleTypesAreNarrowed as "sharing-bw: vehicle_types narrowed to the six form factors, prevailing one per system",
  vehicleTypesAreFetchedOnceAndOnlyForBw as "sharing-bw: vehicle_types fetched only for systems with BW vehicles and kept for a day",
  realFeedsBuildTheSameSummaries as "sharing-bw: old FN_GBFS_FF and port build the same summaries and pending entries on two live feeds",
  zeroTablesFollowTheOldSequence as "sharing-bw: ffLast zero tables — confirmed zero once, empty feed no zeros, failed zero repeated",
  runMatchesTheOldFlow as "sharing-bw: run() requests, drops vanished tables, prunes and upserts as the old flow",
  brokenListWarnsOnce as "sharing-bw: an unreadable system list warns and stops, on both sides",
  noBoundariesSkipsEverySystem as "sharing-bw: without boundaries every system run is skipped with a warning",
};
