/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: sharing-bw — the system list node (`udp-rt-bg-msgs`), FN_GBFS_FF
 * (`udp-rt-bg-fn`) and the commit node (`udp-rt-bg-commit`) against the port.
 *
 * Pinned: the per-system summaries on two real feeds, the tables
 * `ffLast:<system>` through a sequence of runs with confirmed and failed
 * commits (the old confirmed zero once, the port's deletion in its place;
 * an empty feed emptying nothing; a failed one repeated), the dropping of
 * tables of systems that left the list, the age prune, and the skip without
 * boundaries.
 *
 * DELIBERATE DEVIATION (module header, "Form factors and docked vehicles"):
 * every summary carries `vehiclesByFormFactor`, and docked vehicles of
 * station-based systems are not counted. The comparison with the old node strips the
 * new attribute ({@link withoutSplit}) — none of the recorded vehicles is
 * docked — and the tests at the end pin the new behaviour.
 *
 * DELIBERATE DEVIATION (module header, "The tables"): where the old node
 * wrote a zero summary, the port deletes the summary (`emptied`); a confirmed
 * deletion drops the table entry as a confirmed zero did. The comparison
 * takes the old node's zeros out of its write and holds them against the
 * port's `emptied` ({@link assertWriteMatches}); section 5 pins the deletion
 * in `run()`, and the deletion of excluded systems' summaries.
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
import type { SharingSummaryEntity, SystemPlan, Vehicle } from "../../src/connectors/sharing-bw.js";
import { formFactorOf as formFactorOfCarsharing } from "../../src/connectors/carsharing-bw.js";
import { SYSTEMS_URL } from "../../src/connectors/gbfs.js";
import { isArray } from "../../src/kernel/parse.js";
import type { EntityId, HttpResponse, UpsertPlan } from "../../src/kernel/types.js";
import { readFixture } from "../harness/fixtures.js";
import { fakeHttpModule, httpResponse, recordingLog } from "../harness/kernel.js";
import {
  arrayField,
  Broker,
  flowObject,
  fullGeo,
  HOUR,
  jsonAnswer,
  legacyGlobal,
  mobilityCtx,
  type MobilityWorld,
  staleOptions,
  tableObject,
  withoutExcludedSystems,
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

function ported(system: string, payload: unknown, store: SignatureScope): SystemPlan {
  const feed = parse({ system, payload });
  const geo = fullGeo().index;
  const now = new Date().toISOString();
  const gate = createChangeGate(store, recordingLog());
  return planSystem(feed, build(feed, geo, now), gate.table(lastKey(feed.system)), geo);
}

function isZero(entity: unknown): boolean {
  return isRecord(entity) && isRecord(entity.availableVehicles) && entity.availableVehicles.value === 0;
}

/**
 * The old write against the port's: DELIBERATE DEVIATION (module header,
 * "The tables") — the old zeros and their `null` entries are the port's
 * `emptied`, the rest is compared as it is.
 */
function assertWriteMatches(legacy: LegacyWrite, plan: SystemPlan, when: string): void {
  if (legacy.message === null) {
    assert.equal(plan.entities.length, 0, `${when}: the old node wrote nothing`);
    assert.equal(plan.emptied.length, 0, `${when}: the old node zeroed nothing`);
    return;
  }
  const payload = arrayField(legacy.message, "payload");
  assertEntitiesEqual(
    payload.filter((entity) => !isZero(entity)),
    withoutSplit(plan.entities),
  );
  assert.deepEqual(
    normalize(payload.filter(isZero).map((entity) => (isRecord(entity) ? entity.id : undefined))),
    normalize(plan.emptied.map(([, id]) => id)),
    `${when}: the old zeros are not the emptied summaries`,
  );
  const sigCommit = arrayField(legacy.message, "sigCommit");
  const removal = (row: unknown): boolean => isArray(row) && row[2] === null;
  assert.deepEqual(
    normalize(sigCommit.filter((row) => !removal(row))),
    normalize(plan.pending),
    `${when}: pending differs`,
  );
  assert.deepEqual(
    normalize(sigCommit.filter(removal).map((row): unknown => (isArray(row) ? row[1] : undefined))),
    normalize(plan.emptied.map(([ags]) => ags)),
    `${when}: the old removals are not the emptied municipalities`,
  );
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

/* ── 2. ffLast tables ──────────────────────────────────────────────────────── */

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

  // The status code answers the old write and, for the port, the write AND
  // the deletion of the emptied summaries (confirmed: the entry goes, as
  // run() drops it; see section 5 for run() itself).
  const step = async (
    points: readonly (readonly [number, number])[],
    statusCode: number,
    when: string,
  ): Promise<SystemPlan> => {
    const legacy = await legacySystem(system, feedOf(points), flow);
    const plan = ported(system, feedOf(points), store);
    assertWriteMatches(legacy, plan, when);
    flow = await legacyCommit(legacy, statusCode);
    const ok = statusCode >= 200 && statusCode < 300;
    store.commit(plan.pending, new Set<EntityId>(ok ? plan.entities.map((entity) => entity.id) : []));
    const deleted = new Set(ok ? plan.emptied.map(([ags]) => ags) : []);
    store.retain(key, (field) => !deleted.has(field));
    assert.deepEqual(
      normalize(tableObject(store, key)),
      normalize(flow[key] ?? {}),
      `${when}: ${key} differs`,
    );
    return plan;
  };
  const counts = (plan: UpsertPlan): Record<string, unknown> =>
    Object.fromEntries(plan.pending.map(([, ags, value]) => [ags, value]));
  const emptied = (plan: SystemPlan): string[] => plan.emptied.map(([ags]) => ags);

  let plan = await step([STUTTGART, STUTTGART, REUTLINGEN], 201, "first sighting");
  assert.deepEqual(counts(plan), { "08111000": 2, "08415061": 1 });
  assert.deepEqual(emptied(plan), []);
  plan = await step([STUTTGART], 204, "Reutlingen emptied");
  assert.deepEqual(counts(plan), { "08111000": 1 });
  assert.deepEqual(emptied(plan), ["08415061"], "the vanished municipality not emptied");
  plan = await step([STUTTGART], 204, "deletion confirmed");
  assert.deepEqual(emptied(plan), [], "emptied again after the deletion was confirmed");
  plan = await step([], 204, "empty feed");
  assert.equal(plan.entities.length + plan.emptied.length, 0, "an empty feed empties every municipality");
  plan = await step([REUTLINGEN], 500, "Stuttgart emptied, write and deletion failed");
  assert.deepEqual(counts(plan), { "08415061": 1 });
  assert.deepEqual(emptied(plan), ["08111000"]);
  plan = await step([REUTLINGEN], 204, "failed deletion repeated");
  assert.deepEqual(emptied(plan), ["08111000"], "failed deletion not repeated");
  plan = await step([STUTTGART, REUTLINGEN], 204, "Stuttgart back");
  assert.deepEqual(counts(plan), { "08111000": 1, "08415061": 1 }, "a returning municipality not written");
  assert.deepEqual(emptied(plan), []);
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
  // The old node sees the list the port works on: without the systems the
  // registry excludes (licence terms; bird-basel in the fixture).
  const legacyList = await runFunctionNode(LIST_NODE, {
    msg: { _msgid: "parity", statusCode: 200, payload: withoutExcludedSystems("sharing-bw", list.payload) },
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
  // One line confirms the run (the old node logged nothing on success). The
  // port never writes a zero (module header, "The tables").
  const written = world.broker.upserts.flat();
  assert.equal(written.filter(isZero).length, 0, "a zero summary was written");
  const summary = world.log.lines.filter((line) => line.level === "info").at(-1)?.text;
  assert.equal(
    summary,
    `GBFS-BW: ${String(messagesOf(legacyList).length)} systems (1 excluded by the registry), ` +
      `${String(written.length)} summaries written, 0 emptied ones deleted, prune: 1 deleted`,
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
  // An emptied municipality gets no zero summary (and so no all-zero split):
  // its summary is deleted (module header, "The tables").
  const zero = planSystem(feed, [], new Map([["08111000", 4]]), geo);
  assert.deepEqual(zero.entities, []);
  assert.deepEqual(zero.emptied, [["08111000", "urn:ngsi-ld:SharingSummary:bw-08111000-ff-mixed"]]);
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
  const kept = {
    types: parseVehicleTypes(typesFixture("hopp_konstanz").payload),
    fetchedMs: now,
    complete: true,
  };
  assert.equal(typesStale(kept, feed, now + HOUR), false);
  assert.equal(typesStale(undefined, feed, now), true);
  // An unknown type id or an empty list: fetched again, but not before TYPES_RETRY_MS.
  const newType: Vehicle = [47.66, 9.17, true, "HOP:VehicleType:new", false];
  const withNew = { ...feed, vehicles: [newType] };
  assert.equal(typesStale(kept, withNew, now + HOUR), false);
  assert.equal(typesStale(kept, withNew, now + TYPES_RETRY_MS + HOUR), true);
  const empty = { types: parseVehicleTypes({}), fetchedMs: now, complete: false };
  assert.equal(typesStale(empty, feed, now + HOUR), false);
  assert.equal(typesStale(empty, feed, now + TYPES_RETRY_MS + HOUR), true);
  // A failed refetch that kept the older list: retried after TYPES_RETRY_MS too.
  const failed = { ...kept, complete: false };
  assert.equal(typesStale(failed, feed, now + HOUR), false);
  assert.equal(typesStale(failed, feed, now + TYPES_RETRY_MS + HOUR), true);

  // In run(): the list goes missing after a successful fetch; the old one is
  // kept and asked for again after TYPES_RETRY_MS, not only after a day.
  const later = mobilityCtx({ id: "sharing-bw", start: now });
  serveFeeds(later.broker);
  await run(later.ctx);
  const laterTypes = (): number =>
    later.broker.requests.filter((r) => r.url.pathname.endsWith("/vehicle_types")).length;
  later.broker.sources.delete(typesFixture("hopp_konstanz").source);
  later.broker.requests.length = 0;
  later.clock.now = now + TYPES_MAX_AGE_MS + HOUR;
  await run(later.ctx);
  assert.equal(laterTypes(), 2, "a day old: both fetched again");
  later.broker.requests.length = 0;
  later.clock.now = now + TYPES_MAX_AGE_MS + TYPES_RETRY_MS + 2 * HOUR;
  await run(later.ctx);
  assert.equal(laterTypes(), 1, "the failed refetch not retried after TYPES_RETRY_MS");
  const split = later.broker.upserts
    .flat()
    .filter(
      (entity) => isRecord(entity) && isRecord(entity.system) && entity.system.value === "hopp_konstanz",
    )
    .at(-1);
  assert.ok(
    isRecord(split) && isRecord(split.vehiclesByFormFactor) && isRecord(split.vehiclesByFormFactor.value),
  );
  assert.equal(split.vehiclesByFormFactor.value.other, 0, "the older list was not used");
}

function prevailingFormFactorIsShared(): void {
  // The review example: one bicycle, one seated scooter, one "other". On the
  // raw strings the bicycle prevails (first sighting), for carsharing-bw
  // (FleetStatus "Leihräder") and for sharing-bw alike, so the docked bike is
  // counted once — mapping first would make "other" prevail here.
  const types = {
    data: {
      vehicle_types: [
        { vehicle_type_id: "a", form_factor: "bicycle" },
        { vehicle_type_id: "b", form_factor: "scooter_seated" },
        { vehicle_type_id: "c", form_factor: "other" },
      ],
    },
  };
  assert.equal(formFactorOfCarsharing({ system: "x", payload: types }).formFactor, "bicycle");
  assert.equal(parseVehicleTypes(types).prevailing, "bicycle");
  const feed = parse({
    system: "x",
    vehicleTypes: types,
    payload: {
      data: {
        bikes: [
          { lat: STUTTGART[0], lon: STUTTGART[1], vehicle_type_id: "a", station_id: "s" },
          { lat: STUTTGART[0], lon: STUTTGART[1], vehicle_type_id: "b" },
        ],
      },
    },
  });
  const summaries = build(feed, fullGeo().index, new Date().toISOString());
  assert.equal(summaries[0]?.availableVehicles.value, 1, "the docked bike counted by both sides");
  // Unknown values stay unknown for both: carsharing "unbekannt", sharing "other".
  const unknown = { data: { vehicle_types: [{ vehicle_type_id: "u" }] } };
  assert.equal(formFactorOfCarsharing({ system: "x", payload: unknown }).formFactor, "unbekannt");
  assert.equal(parseVehicleTypes(unknown).prevailing, "other");
}

/* ── 5. emptied summaries and excluded systems (deliberate, module header) ── */

const TEST_LIST = {
  systems: [
    { id: "testsys", url: "https://api.mobidata-bw.de/sharing/gbfs/v2/testsys/gbfs" },
    { id: "lime_bw", url: "https://api.mobidata-bw.de/sharing/gbfs/v2/lime_bw/gbfs" },
  ],
};
const TEST_FEED = "https://api.mobidata-bw.de/sharing/gbfs/v2/testsys/free_bike_status";
const STUTTGART_ID = "urn:ngsi-ld:SharingSummary:bw-08111000-ff-testsys";
const REUTLINGEN_ID = "urn:ngsi-ld:SharingSummary:bw-08415061-ff-testsys";
const RUNS_FROM = Date.parse("2026-10-06T08:00:00Z");

/** One run at `hour`; the broker keeps what it upserted (it does not by itself). */
async function runAt(world: MobilityWorld, hour: number, feed: HttpResponse): Promise<void> {
  world.clock.now = RUNS_FROM + hour * HOUR;
  world.broker.sources.set(TEST_FEED, feed);
  const before = world.broker.upserts.length;
  await run(world.ctx);
  for (const entity of world.broker.upserts.slice(before).flat()) {
    if (isRecord(entity) && typeof entity.id === "string") world.broker.entities.set(entity.id, entity);
  }
}

function testWorld(): MobilityWorld {
  const world = mobilityCtx({ id: "sharing-bw", start: RUNS_FROM });
  world.broker.sources.set(SYSTEMS_URL, jsonAnswer(TEST_LIST));
  return world;
}

async function emptiedSummaryIsDeletedNotZeroed(): Promise<void> {
  const world = testWorld();
  const key = lastKey("testsys");
  const table = (): Record<string, unknown> => tableObject(world.store, key);
  const deletes = (): string[] => world.broker.deletes.flat();
  const lastLine = (): string | undefined => world.log.lines.filter((l) => l.level === "info").at(-1)?.text;

  await runAt(world, 0, jsonAnswer(feedOf([STUTTGART, STUTTGART, REUTLINGEN])));
  assert.deepEqual(table(), { "08111000": 2, "08415061": 1 });

  // Reutlingen emptied: its summary is deleted, no zero written, the entry goes.
  await runAt(world, 1, jsonAnswer(feedOf([STUTTGART])));
  assert.deepEqual(deletes(), [REUTLINGEN_ID]);
  assert.ok(!world.broker.entities.has(REUTLINGEN_ID));
  assert.equal(world.broker.upserts.flat().filter(isZero).length, 0, "a zero summary was written");
  assert.deepEqual(table(), { "08111000": 1 });
  assert.ok(
    world.pruneCalls.some((call) => call.kind === "remove" && call.removed?.includes(REUTLINGEN_ID) === true),
  );
  assert.match(lastLine() ?? "", /, 1 emptied ones deleted, /);

  // A day later the age prune has nothing to count against its share cap.
  for (let hour = 2; hour <= 27; hour += 1) await runAt(world, hour, jsonAnswer(feedOf([STUTTGART])));
  const prune = staleOptions(world).length;
  const lastStale = world.pruneCalls.filter((call) => call.kind === "stale").at(-1)?.result;
  assert.ok(prune > 0 && lastStale?.skipped === null, `prune skipped: ${String(lastStale?.skipped)}`);
  assert.equal(lastStale.listed?.candidates, 0, "the emptied municipality aged into the prune");
  assert.deepEqual(deletes(), [REUTLINGEN_ID]);

  // Vehicles there again: the summary is written anew.
  await runAt(world, 28, jsonAnswer(feedOf([STUTTGART, REUTLINGEN])));
  const rewritten = world.broker.upserts.at(-1) ?? [];
  assert.ok(rewritten.some((entity) => isRecord(entity) && entity.id === REUTLINGEN_ID));
  assert.deepEqual(table(), { "08111000": 1, "08415061": 1 });

  // A failed, an unreadable and an empty feed delete nothing.
  await runAt(world, 29, httpResponse(503, ""));
  await runAt(world, 30, jsonAnswer({ data: {} }));
  await runAt(world, 31, jsonAnswer(feedOf([])));
  assert.deepEqual(deletes(), [REUTLINGEN_ID], "deleted on a failed or empty feed");
  assert.deepEqual(table(), { "08111000": 1, "08415061": 1 });

  // A refused deletion of a summary the broker still holds: the entry stays,
  // the next run tries again.
  world.broker.deleteAnswer = () => httpResponse(500, "");
  await runAt(world, 32, jsonAnswer(feedOf([STUTTGART])));
  assert.ok(world.broker.entities.has(REUTLINGEN_ID));
  assert.deepEqual(table(), { "08111000": 1, "08415061": 1 });
  world.broker.deleteAnswer = () => httpResponse(204);
  await runAt(world, 33, jsonAnswer(feedOf([STUTTGART])));
  assert.deepEqual(deletes(), [REUTLINGEN_ID, REUTLINGEN_ID, REUTLINGEN_ID]);
  assert.ok(!world.broker.entities.has(REUTLINGEN_ID));
  assert.deepEqual(table(), { "08111000": 1 });

  // Already gone (an operator, the age prune): refused as not found, the
  // entry goes all the same — no deletion run after run.
  await runAt(world, 34, jsonAnswer(feedOf([STUTTGART, REUTLINGEN])));
  world.broker.entities.delete(REUTLINGEN_ID);
  world.broker.deleteAnswer = (ids) =>
    httpResponse(
      207,
      JSON.stringify({
        success: [],
        errors: ids.map((entityId) => ({ entityId, error: { type: "ResourceNotFound", status: 404 } })),
      }),
    );
  await runAt(world, 35, jsonAnswer(feedOf([STUTTGART])));
  assert.deepEqual(table(), { "08111000": 1 });
  const tried = deletes().length;
  await runAt(world, 36, jsonAnswer(feedOf([STUTTGART])));
  assert.equal(deletes().length, tried, "a gone summary deleted again");
  assert.ok(world.broker.entities.has(STUTTGART_ID));
}

async function emptiedSummaryIsZeroedWhileItMayNotBeDeleted(): Promise<void> {
  // Master data not plausible (Orion counts far more municipalities than the
  // geo context holds): no deletion; the old count must not stay on show.
  const world = testWorld();
  world.broker.municipalityCount = 100_000;
  await runAt(world, 0, jsonAnswer(feedOf([STUTTGART, REUTLINGEN])));
  await runAt(world, 1, jsonAnswer(feedOf([STUTTGART])));
  assert.deepEqual(world.broker.deletes.flat(), []);
  const zero = world.broker.upserts
    .flat()
    .find((entity) => isRecord(entity) && entity.id === REUTLINGEN_ID && isZero(entity));
  assert.ok(isRecord(zero) && isRecord(zero.vehiclePositions), "no zero written");
  assert.deepEqual(zero.vehiclePositions.value, []);
  // The entry stays: the deletion is tried again in the next run.
  assert.deepEqual(tableObject(world.store, lastKey("testsys")), { "08111000": 1, "08415061": 1 });
}

async function excludedSystemsSummariesAreDeleted(): Promise<void> {
  const world = testWorld();
  const lime = [
    "urn:ngsi-ld:SharingSummary:bw-08111000-ff-lime_bw",
    "urn:ngsi-ld:SharingSummary:bw-08415061-ff-lime_bw",
  ];
  // Not lime_bw: another system (excluded, but not in this list), a system
  // whose key merely contains it, and a kept one.
  const others = [
    "urn:ngsi-ld:SharingSummary:bw-08111000-ff-lime_bw-2",
    "urn:ngsi-ld:SharingSummary:bw-08111000-ff-sublime_bw",
    STUTTGART_ID,
  ];
  // The excluded system's summaries stopped a day ago; the others are fresh,
  // so the age prune of the second run leaves them alone.
  for (const id of [...lime, ...others]) {
    const observedAt = new Date(RUNS_FROM - (lime.includes(id) ? 30 : 1) * HOUR).toISOString();
    world.broker.entities.set(id, {
      id,
      type: "SharingSummary",
      availableVehicles: { type: "Property", value: 3, observedAt },
    });
  }
  // The first run: its age prune only arms the interval, the deletion is deliberate.
  await runAt(world, 0, jsonAnswer(feedOf([STUTTGART])));
  assert.deepEqual(world.broker.deletes.flat().sort(), [...lime].sort());
  for (const id of others) assert.ok(world.broker.entities.has(id), `${id} deleted`);
  assert.ok(
    world.pruneCalls.some(
      (call) => call.kind === "remove" && call.key.includes("lime_bw") && call.removed?.length === 2,
    ),
  );
  assert.ok(
    !world.broker.requests.some((request) => request.url.href.includes("/lime_bw/")),
    "the excluded system was requested",
  );
  // Nothing left: listed again, nothing deleted.
  await runAt(world, 1, jsonAnswer(feedOf([STUTTGART])));
  assert.deepEqual(world.broker.deletes.flat().sort(), [...lime].sort());
}

export {
  emptiedSummaryIsZeroedWhileItMayNotBeDeleted as "sharing-bw: an emptied summary that may not be deleted (master data) is zeroed, its entry kept",
  emptiedSummaryIsDeletedNotZeroed as "sharing-bw: an emptied summary is deleted, not zeroed — outside the age prune, retried, written anew (deliberate)",
  excludedSystemsSummariesAreDeleted as "sharing-bw: summaries of an excluded system are deleted deliberately, other systems untouched (deliberate)",
  prevailingFormFactorIsShared as "sharing-bw / carsharing-bw: one prevailing form factor on the raw strings",
  formFactorsSplitTheTotal as "sharing-bw: vehiclesByFormFactor splits the total, docked vehicles of station-based systems are not counted (deliberate)",
  vehicleTypesAreNarrowed as "sharing-bw: vehicle_types narrowed to the six form factors, prevailing one per system",
  vehicleTypesAreFetchedOnceAndOnlyForBw as "sharing-bw: vehicle_types fetched only for systems with BW vehicles and kept for a day",
  realFeedsBuildTheSameSummaries as "sharing-bw: old FN_GBFS_FF and port build the same summaries and pending entries on two live feeds",
  zeroTablesFollowTheOldSequence as "sharing-bw: ffLast tables — old zeros are the emptied summaries, confirmed once, empty feed none, failed repeated",
  runMatchesTheOldFlow as "sharing-bw: run() requests, drops vanished tables, prunes and upserts as the old flow",
  brokenListWarnsOnce as "sharing-bw: an unreadable system list warns and stops, on both sides",
  noBoundariesSkipsEverySystem as "sharing-bw: without boundaries every system run is skipped with a warning",
};
