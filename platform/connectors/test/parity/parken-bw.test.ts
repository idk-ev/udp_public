/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: parken-bw — the cursor fetch node (`udp-rt-bp-fetch`), the build
 * node (`udp-rt-bp-build`) and the commit node behind the upsert
 * (`udp-rt-bp-commit`) against the port.
 *
 * The connector of the ParkAPI incident, so the fetch is replayed page by page
 * on both sides through one scripted endpoint — the old node through a fake
 * `https`, the port through a scripted fetcher — including every way the old
 * node aborts (overlap, stalled cursor, HTTP error, malformed page). Then the
 * build: entities, pending signatures and the own tables across two runs with
 * commits in between; the incomplete run that must not prune and must reset
 * the confirmations; and a complete run whose prunes (three regular, two
 * legacy) delete the same ids on both sides.
 *
 * Fixtures: test/fixtures/parken-bw-page{1,2,3}.json — a live three-page
 * cursor sequence, trimmed as described in their `note`s. Several tests derive
 * inputs from them (a changed occupancy, a vanished site, a consistent
 * `total_count`); those are test inputs, never fixture data.
 */

import assert from "node:assert/strict";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import type { SignatureScope } from "../../src/kernel/change-gate.js";
import {
  build,
  CONFIRM_KEYS,
  fetchInventory,
  MAX_PAGES,
  OCCUPANCY_TABLE,
  PAGE_SIZE,
  pageUrl,
  parse,
  planWrite,
  run,
  STATIC_TABLE,
  SUMMARY_GATE,
} from "../../src/connectors/parken-bw.js";
import type { ParkInventory } from "../../src/connectors/parken-bw.js";
import { createGeoIndex } from "../../src/kernel/geo.js";
import { chunk } from "../../src/kernel/orion.js";
import type { HttpResponse, UpsertPlan } from "../../src/kernel/types.js";
import { readFixture } from "../harness/fixtures.js";
import { fakeHttpModule, httpResponse, recordingLog, scriptedFetcher } from "../harness/kernel.js";
import type { SeenRequest } from "../harness/kernel.js";
import {
  arrayField,
  Broker,
  flowObject,
  flowTable,
  fullGeo,
  HOUR,
  jsonAnswer,
  legacyGlobal,
  mobilityCtx,
  ORION,
  tableObject,
} from "../harness/mobility.js";
import type { MobilityWorld } from "../harness/mobility.js";
import { assertEntitiesEqual, isRecord, normalize } from "../harness/normalize.js";
import { loadFunctionNode, messagesOf, runFunctionNode } from "../harness/vm-runner.js";
import type { FunctionNodeRun } from "../harness/vm-runner.js";

const FETCH_NODE = "udp-rt-bp-fetch";
const BUILD_NODE = "udp-rt-bp-build";
const COMMIT_NODE = "udp-rt-bp-commit";
const FIXTURES = ["parken-bw-page1", "parken-bw-page2", "parken-bw-page3"] as const;
/** The old fetch node sleeps 1 s between pages in the vm; give it room. */
const FETCH_TIMEOUT_MS = 20_000;

/* ── inputs ──────────────────────────────────────────────────────────────── */

interface Page {
  readonly url: string;
  payload: Record<string, unknown>;
}

/** The recorded pages, deep copies — a test may change them. */
function recordedPages(): Page[] {
  return FIXTURES.map((name) => {
    const fixture = readFixture(name);
    const payload = structuredClone(fixture.payload);
    assert.ok(isRecord(payload), `${name}: payload is an object`);
    return { url: fixture.source, payload };
  });
}

function itemsOf(page: Page): Record<string, unknown>[] {
  const items = page.payload.items;
  assert.ok(Array.isArray(items));
  return items.filter(isRecord);
}

/** `total_count` set to what the sequence holds, so the run counts as complete. */
function consistent(pages: Page[]): Page[] {
  const total = pages.reduce((sum, page) => sum + itemsOf(page).length, 0);
  for (const page of pages) page.payload.total_count = total;
  return pages;
}

function serve(broker: Broker, pages: readonly Page[]): void {
  broker.sources.clear();
  for (const page of pages) broker.sources.set(page.url, jsonAnswer(page.payload));
}

function sourceTargets(requests: readonly SeenRequest[]): string[] {
  return requests.filter((request) => request.url.origin !== ORION).map((request) => request.url.href);
}

/* ── the old nodes ───────────────────────────────────────────────────────── */

async function legacyFetch(broker: Broker): Promise<FunctionNodeRun> {
  return runFunctionNode(FETCH_NODE, {
    msg: { _msgid: "parity", payload: Date.now() },
    modules: { https: fakeHttpModule(broker.respond) },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
}

interface LegacyBuild {
  readonly run: FunctionNodeRun;
  readonly messages: unknown[];
  readonly entities: unknown[];
  readonly pending: unknown[];
}

async function legacyBuild(
  inventory: ParkInventory,
  broker: Broker,
  flow: Readonly<Record<string, unknown>> = {},
  withBoundaries = true,
): Promise<LegacyBuild> {
  // The old fetch node's output; test 1 pins that the port folds the same.
  const records: unknown = JSON.parse(JSON.stringify(inventory.records));
  const run = await runFunctionNode(BUILD_NODE, {
    msg: {
      _msgid: "parity",
      payload: records,
      parkSeiten: inventory.pages,
      parkGesamt: inventory.total,
      parkVollstaendig: inventory.complete,
    },
    global: legacyGlobal(fullGeo(), withBoundaries),
    flow,
    modules: { http: fakeHttpModule(broker.respond) },
  });
  const messages = messagesOf(run);
  return {
    run,
    messages,
    entities: messages.flatMap((message) => arrayField(message, "payload")),
    pending: messages.flatMap((message) => arrayField(message, "sigCommit")),
  };
}

/** Confirms every chunk (HTTP 204) through the old commit node. */
async function legacyCommit(legacy: LegacyBuild): Promise<Record<string, unknown>> {
  let flow = flowObject(legacy.run.flow);
  for (const message of legacy.messages) {
    if (!isRecord(message)) continue;
    const commit = await runFunctionNode(COMMIT_NODE, {
      msg: { ...message, statusCode: 204, payload: "" },
      flow,
    });
    assert.deepEqual(commit.warnings, [], "the old commit node warned on a confirmed upsert");
    flow = flowObject(commit.flow);
  }
  return flow;
}

/* ── the port, pure ──────────────────────────────────────────────────────── */

/** What `run` does between fetch and upsert, over a given signature store. */
function portedPlan(
  inventory: ParkInventory,
  store: SignatureScope,
  now: string,
  geo = fullGeo().index,
): UpsertPlan {
  const gate = createChangeGate(store, recordingLog());
  return planWrite(gate, build(inventory, geo, now), now).upsert;
}

const TABLES = [STATIC_TABLE, OCCUPANCY_TABLE, SUMMARY_GATE] as const;

function assertTablesEqual(flow: ReadonlyMap<string, unknown>, store: SignatureScope, when: string): void {
  for (const key of TABLES) {
    assert.deepEqual(tableObject(store, key), flowTable(flow, key), `${when}: table ${key} differs`);
  }
}

/** JSON round trip: what actually reaches Orion (drops `unitCode: undefined`). */
function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/* ── 1. fetch ────────────────────────────────────────────────────────────── */

async function compareFetch(pages: readonly Page[], expectComplete: boolean): Promise<void> {
  const oldBroker = new Broker(0);
  serve(oldBroker, pages);
  const legacy = await legacyFetch(oldBroker);

  const newBroker = new Broker(0);
  serve(newBroker, pages);
  const log = recordingLog();
  const inventory = await fetchInventory(scriptedFetcher(newBroker.respond).fetcher, log);
  assert.ok(inventory !== null, "the port aborted a valid sequence");

  assert.deepEqual(sourceTargets(newBroker.requests), sourceTargets(oldBroker.requests), "request sequence");
  assert.deepEqual(sourceTargets(newBroker.requests), [pageUrl(null), pageUrl(1436), pageUrl(9290)]);
  const message = legacy.returned;
  assert.ok(isRecord(message), "the old node emitted no message");
  assertEntitiesEqual(message.payload, inventory.records);
  assert.equal(inventory.pages, message.parkSeiten);
  assert.equal(inventory.total, message.parkGesamt);
  assert.equal(inventory.complete, message.parkVollstaendig);
  assert.equal(inventory.complete, expectComplete);
  assert.equal(log.warnings().length, legacy.warnings.length, "one side warned, the other did not");
  // The recorded pages parse to the same inventory offline.
  assert.deepEqual(normalize(parse(pages.map((page) => page.payload))), normalize(inventory));
}

async function cursorPagesFoldIdentically(): Promise<void> {
  // total_count as recorded (32,019): 71 records are far below 90 % -> incomplete, one warning.
  await compareFetch(recordedPages(), false);
  // Consistent total: complete on both sides, no warning.
  await compareFetch(consistent(recordedPages()), true);
}

/* ── 2. aborts ───────────────────────────────────────────────────────────── */

async function compareAbort(
  pages: readonly Page[],
  override: (broker: Broker) => void,
  error: RegExp,
): Promise<void> {
  const oldBroker = new Broker(0);
  serve(oldBroker, pages);
  override(oldBroker);
  const legacy = await legacyFetch(oldBroker);
  assert.equal(legacy.returned, null, "the old node did not abort");
  assert.equal(legacy.errors.length, 1, `old node: ${legacy.errors.join(" | ")}`);

  const newBroker = new Broker(0);
  serve(newBroker, pages);
  override(newBroker);
  const log = recordingLog();
  const inventory = await fetchInventory(scriptedFetcher(newBroker.respond).fetcher, log);
  assert.equal(inventory, null, "the port did not abort");
  const errors = log.lines.filter((line) => line.level === "error").map((line) => line.text);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", error);
  assert.deepEqual(sourceTargets(newBroker.requests), sourceTargets(oldBroker.requests), "request sequence");
}

async function everyAbortOfTheOldNodeAbortsThePort(): Promise<void> {
  const pages = recordedPages();
  const [first, second] = pages;
  assert.ok(first !== undefined && second !== undefined);

  // Overlap: the second request answers with the first page again — exactly
  // what the ignored offset did for a month. Loud abort, nothing written.
  await compareAbort(
    pages,
    (broker) => broker.sources.set(second.url, jsonAnswer(first.payload)),
    /^ParkAPI: page 2 overlaps the previous pages in 25 of 25 records/,
  );
  // Stalled cursor: page 2 hands back the cursor it was requested with.
  await compareAbort(
    pages,
    (broker) => broker.sources.set(second.url, jsonAnswer({ ...second.payload, next_id: 1436 })),
    /^ParkAPI: cursor stalled \(next_id 1436 as before\)/,
  );
  await compareAbort(
    pages,
    (broker) => broker.sources.set(second.url, httpResponse(503, "busy")),
    /^ParkAPI: HTTP 503 on page 2/,
  );
  await compareAbort(
    pages,
    (broker) => broker.sources.set(second.url, jsonAnswer({ results: [] })),
    /^ParkAPI: page 2 without items array/,
  );
  await compareAbort(
    pages,
    (broker) => broker.sources.set(second.url, httpResponse(200, "<html>gateway</html>")),
    /^ParkAPI: page 2 is not valid JSON/,
  );
  // parse() refuses the same sequences offline.
  assert.throws(() => parse([first.payload, first.payload]), /overlaps the previous pages/);
}

async function pageCapIsLoudAndIncomplete(): Promise<void> {
  // The constants of the old node, read out of flows.json.
  const old = loadFunctionNode(FETCH_NODE).func;
  assert.equal(/const MAX_SEITEN = (\d+);/.exec(old)?.[1], String(MAX_PAGES));
  assert.equal(/const PRO_SEITE = (\d+);/.exec(old)?.[1], String(PAGE_SIZE));

  // An endless cursor chain (synthetic, new side only — the old node would
  // sleep two minutes for it): exactly MAX_PAGES requests, a warning, and the
  // run counts as incomplete, so nothing is pruned.
  const { fetcher, seen } = scriptedFetcher((request): HttpResponse => {
    const start = Number(request.url.searchParams.get("start") ?? "0");
    return jsonAnswer({ items: [{ id: start, purpose: "CAR", lat: 48.7, lon: 9.1 }], next_id: start + 1 });
  });
  const log = recordingLog();
  const inventory = await fetchInventory(fetcher, log);
  assert.ok(inventory !== null);
  assert.equal(seen.length, MAX_PAGES);
  assert.equal(inventory.complete, false);
  assert.match(log.warnings()[0] ?? "", /^ParkAPI: page cap 120 reached, stock incomplete/);
  assert.ok(
    seen.every((request) => !request.url.searchParams.has("offset")),
    "offset= is back",
  );
}

/* ── 3. build and tables ─────────────────────────────────────────────────── */

interface Changed {
  readonly pages: Page[];
  readonly moved: Record<string, unknown>;
  readonly renamed: Record<string, unknown>;
  readonly vanished: Record<string, unknown>;
}

/**
 * Test input derived from the fixtures: one site's occupancy moved, one
 * site's name changed, one realtime bike site vanished.
 */
function changedPages(): Changed {
  const pages = recordedPages();
  const [p1, , p3] = pages;
  assert.ok(p1 !== undefined && p3 !== undefined);
  const realtime = itemsOf(p1).filter((item) => item.has_realtime_data === true);
  const [moved, renamed] = realtime;
  assert.ok(moved !== undefined && renamed !== undefined);
  moved.realtime_free_capacity = Number(moved.realtime_free_capacity) + 1;
  renamed.name = `${String(renamed.name)} (neu)`;
  const bikes = itemsOf(p3).filter((item) => item.has_realtime_data === true && item.purpose === "BIKE");
  const vanished = bikes[0];
  assert.ok(vanished !== undefined);
  p3.payload.items = itemsOf(p3).filter((item) => item !== vanished);
  return { pages, moved, renamed, vanished };
}

async function buildAndTablesMatchAcrossRuns(): Promise<void> {
  const now = new Date().toISOString();
  const broker = new Broker(0);
  const store = new SignatureStore().scope("parken-bw");

  // Run 1: empty tables, everything is new.
  const firstInventory = parse(recordedPages().map((page) => page.payload));
  const first = await legacyBuild(firstInventory, broker);
  const firstPlan = portedPlan(firstInventory, store, now);
  assert.deepEqual(first.run.warnings, []);
  assertEntitiesEqual(first.entities, firstPlan.entities);
  assert.deepEqual(normalize(first.pending), normalize(firstPlan.pending), "pending signatures differ");
  assert.deepEqual(
    first.messages.map((message) => arrayField(message, "payload").length),
    chunk(firstPlan.entities, 100).map((part) => part.length),
    "chunking differs",
  );
  assertTablesEqual(first.run.flow, store, "run 1 before commit");
  // Incomplete run on both sides: the confirmation tables are cleared.
  for (const key of CONFIRM_KEYS) assert.deepEqual(flowTable(first.run.flow, key), {}, key);

  const flow = await legacyCommit(first);
  store.commit(firstPlan.pending, new Set(firstPlan.entities.map((entity) => entity.id)));
  assertTablesEqual(new Map(Object.entries(flow)), store, "run 1 after commit");

  const { pages, moved, renamed, vanished } = changedPages();
  const secondInventory = parse(pages.map((page) => page.payload));
  const second = await legacyBuild(secondInventory, broker, flow);
  const secondPlan = portedPlan(secondInventory, store, now);
  assertEntitiesEqual(second.entities, secondPlan.entities);
  assert.deepEqual(normalize(second.pending), normalize(secondPlan.pending), "pending signatures differ");
  assertTablesEqual(second.run.flow, store, "run 2 before commit");
  const vanishedId = `urn:ngsi-ld:BikeParking:parkapi-${String(vanished.id)}`;
  assert.ok(!(vanishedId in tableObject(store, STATIC_TABLE)), "a vanished site keeps its signature");

  // What the second run wrote: full for the renamed site, occupancy only for
  // the moved one, freshness for the other realtime sites, nothing for static ones.
  const byId = new Map(secondPlan.entities.map((entity) => [entity.id, entity]));
  const full = byId.get(`urn:ngsi-ld:ParkingSite:parkapi-${String(renamed.id)}`);
  const occupancy = byId.get(`urn:ngsi-ld:ParkingSite:parkapi-${String(moved.id)}`);
  assert.ok(full !== undefined && "name" in full && "availableSpotNumber" in full);
  assert.ok(occupancy !== undefined && !("name" in occupancy) && "availableSpotNumber" in occupancy);
  assert.equal(
    secondPlan.entities.filter((entity) => entity.type !== "ParkingSummary" && !("dateObserved" in entity))
      .length,
    0,
  );
}

async function missingBoundariesOnlyUseTheArs(): Promise<void> {
  // Without boundaries the ARS still assigns; records without one stay
  // unassigned instead of being guessed. The prune is off (PRUNE_OK needs the
  // boundaries), so a complete run still clears the confirmations.
  const now = new Date().toISOString();
  const inventory = parse(consistent(recordedPages()).map((page) => page.payload));
  const legacy = await legacyBuild(inventory, new Broker(0), {}, false);
  const geo = createGeoIndex(fullGeo().municipalities, null);
  const store = new SignatureStore().scope("parken-bw");
  const plan = portedPlan(inventory, store, now, geo);
  assertEntitiesEqual(legacy.entities, plan.entities);
  assert.deepEqual(normalize(legacy.pending), normalize(plan.pending), "pending signatures differ");
  assert.ok(build(inventory, geo, now).counts.unassigned > 0, "the fixture has records without ARS");
  for (const key of CONFIRM_KEYS) assert.deepEqual(flowTable(legacy.run.flow, key), {}, key);

  // The port: the same, run() resets the three confirmations, no stale() at all.
  const world = mobilityCtx({
    id: "parken-bw",
    start: Date.parse("2026-09-01T00:00:00Z"),
    boundaries: false,
  });
  serve(world.broker, consistent(recordedPages()));
  await run(world.ctx);
  assert.deepEqual(
    world.pruneCalls.map((call) => `${call.kind}:${call.key}`),
    CONFIRM_KEYS.map((key) => `reset:${key}`),
  );
  assert.deepEqual(world.broker.listings(), [], "listed for a prune without boundaries");
}

/* ── 4. run(): the whole cycle through the broker ────────────────────────── */

async function runWritesWhatTheOldFlowWrites(): Promise<void> {
  const oldBroker = new Broker(0);
  const world = mobilityCtx({ id: "parken-bw", start: Date.parse("2026-09-01T00:00:00Z") });
  serve(world.broker, recordedPages());

  // Run 1 on both sides.
  const inventory = parse(recordedPages().map((page) => page.payload));
  const first = await legacyBuild(inventory, oldBroker);
  await run(world.ctx);
  assert.deepEqual(
    normalize(world.broker.upserts),
    normalize(first.messages.map((message) => wire(arrayField(message, "payload")))),
    "upserted chunks differ",
  );
  const flow = await legacyCommit(first);
  assertTablesEqual(new Map(Object.entries(flow)), world.store, "after run 1");
  // Incomplete (recorded total_count): no prune, the three confirmations reset.
  assert.deepEqual(
    world.pruneCalls.map((call) => `${call.kind}:${call.key}`),
    CONFIRM_KEYS.map((key) => `reset:${key}`),
  );

  // Run 2: occupancy moved, a name changed, a site vanished — the tables must
  // be reduced to the current stock (replace), not merged.
  const { pages } = changedPages();
  serve(world.broker, pages);
  world.broker.upserts.length = 0;
  world.clock.now += 3 * HOUR;
  const second = await legacyBuild(parse(pages.map((page) => page.payload)), oldBroker, flow);
  await run(world.ctx);
  assert.deepEqual(
    normalize(world.broker.upserts),
    normalize(second.messages.map((message) => wire(arrayField(message, "payload")))),
    "upserted chunks of the changed run differ",
  );
  const secondFlow = await legacyCommit(second);
  assertTablesEqual(new Map(Object.entries(secondFlow)), world.store, "after run 2");

  // Run 3: nothing changed. Freshness for realtime sites and sums only.
  world.broker.upserts.length = 0;
  world.clock.now += 3 * HOUR;
  const third = await legacyBuild(parse(pages.map((page) => page.payload)), oldBroker, secondFlow);
  await run(world.ctx);
  assert.deepEqual(
    normalize(world.broker.upserts),
    normalize(third.messages.map((message) => wire(arrayField(message, "payload")))),
    "upserted chunks of the unchanged run differ",
  );
  assert.equal(third.pending.length, 0);
  assertTablesEqual(third.run.flow, world.store, "after run 3 (nothing pending)");
}

/* ── 5. prunes of a complete run ─────────────────────────────────────────── */

const STALE_SITE = "urn:ngsi-ld:ParkingSite:parkapi-999999";
const STALE_SUMMARY = "urn:ngsi-ld:ParkingSummary:bw-08000000";
const LEGACY_SITE = "urn:ngsi-ld:ParkingSite:stuttgart-hauptbahnhof";
const MUNICIPAL_BR = "urn:ngsi-ld:BikeParking:stuttgart-br-hbf";

function seedBroker(broker: Broker, withLegacy: boolean): void {
  const provider = { type: "Property", value: "MobiData BW ParkAPI" };
  broker.entities.set(STALE_SITE, { id: STALE_SITE, type: "ParkingSite", dataProvider: provider });
  broker.entities.set(STALE_SUMMARY, { id: STALE_SUMMARY, type: "ParkingSummary" });
  if (withLegacy) {
    broker.entities.set(LEGACY_SITE, {
      id: LEGACY_SITE,
      type: "ParkingSite",
      dataProvider: provider,
      createdAt: "2026-07-01T00:00:00Z",
      modifiedAt: "2025-12-01T00:00:00Z",
    });
  }
  // A municipal B+R connector with the documented slug-prefixed ids: never touched.
  broker.entities.set(MUNICIPAL_BR, {
    id: MUNICIPAL_BR,
    type: "BikeParking",
    dataProvider: { type: "Property", value: "Stadt Stuttgart" },
    createdAt: "2026-07-01T00:00:00Z",
    modifiedAt: "2025-12-01T00:00:00Z",
  });
}

/**
 * The old node in one run, with its flow context seeded as if the previous
 * runs had happened (intervals satisfied, candidates confirmed 25 h ago) —
 * the vm clock cannot be moved.
 */
async function legacyCompleteRun(withLegacy: boolean): Promise<{ broker: Broker; run: FunctionNodeRun }> {
  const broker = new Broker(fullGeo().municipalities.length);
  seedBroker(broker, withLegacy);
  const now = Date.now();
  const flow: Record<string, unknown> = {
    pruneLastRun_Parken_BW_ParkingSite: now - 3 * HOUR,
    pruneLastRun_Parken_BW_BikeParking: now - 3 * HOUR,
    pruneLastRun_Parken_BW_ParkingSummary: now - 3 * HOUR,
    pruneLastRun_Parken_BW_legacy_ParkingSite: now - 24 * HOUR,
    pruneLastRun_Parken_BW_legacy_BikeParking: now - 24 * HOUR,
    parkPruneSite: { [STALE_SITE]: [now - 25 * HOUR, 1] },
    parkPruneSummary: { [STALE_SUMMARY]: [now - 25 * HOUR, 1] },
  };
  const inventory = parse(consistent(recordedPages()).map((page) => page.payload));
  assert.ok(inventory.complete);
  const legacy = await legacyBuild(inventory, broker, flow);
  await broker.idle();
  return { broker, run: legacy.run };
}

/** The port, run every 3 h over `hours`, starting cold (no prune state). */
async function portedRuns(withLegacy: boolean, hours: number): Promise<MobilityWorld> {
  const world = mobilityCtx({ id: "parken-bw", start: Date.parse("2026-09-01T00:00:00Z") });
  seedBroker(world.broker, withLegacy);
  serve(world.broker, consistent(recordedPages()));
  for (let hour = 0; hour <= hours; hour += 3) {
    world.clock.now = Date.parse("2026-09-01T00:00:00Z") + hour * HOUR;
    await run(world.ctx);
  }
  return world;
}

async function completeRunPrunesTheSameIds(): Promise<void> {
  const legacy = await legacyCompleteRun(true);
  assert.deepEqual(legacy.run.warnings, [], `old warnings: ${legacy.run.warnings.join(" | ")}`);
  const ported = await portedRuns(true, 30);
  assert.deepEqual(
    ported.log.warnings().filter((line) => !line.startsWith("Upsert")),
    [],
  );

  const deleted = (broker: Broker): string[] => broker.deletes.flat().sort();
  assert.deepEqual(deleted(ported.broker), deleted(legacy.broker), "deleted ids differ");
  assert.deepEqual(deleted(legacy.broker), [LEGACY_SITE, STALE_SUMMARY, STALE_SITE].sort());
  assert.ok(ported.broker.entities.has(MUNICIPAL_BR), "a municipal B+R entity was deleted");
  // The same five listings, byte for byte (idPattern, attrs, options).
  assert.deepEqual(
    [...new Set(ported.broker.listings().map((target) => target.replace(/&offset=\d+$/, "")))].sort(),
    [...new Set(legacy.broker.listings().map((target) => target.replace(/&offset=\d+$/, "")))].sort(),
    "listing requests differ",
  );
  assert.equal(new Set(legacy.broker.listings()).size, 5);
}

async function legacyCleanupSwitchesItselfOff(): Promise<void> {
  // Old: a complete listing without legacy entities sets parkLegacyDone.
  const legacy = await legacyCompleteRun(false);
  assert.equal(legacy.run.flow.get("parkLegacyDone"), true);
  assert.ok(legacy.run.logs.some((line) => line.includes("no legacy parking ids left")));

  // Port: the first daily check lists nothing, switches off, and no legacy
  // listing follows in the next two days.
  const world = await portedRuns(false, 66);
  const legacyListings = world.broker
    .listings()
    .filter((target) => target.includes(encodeURIComponent("[a-z0-9][a-z0-9.-]*$")));
  assert.equal(legacyListings.length, 2, "one daily check (site + bike), then off");
  assert.ok(
    world.log.lines.some(
      (line) => line.text === "Parken-BW: no legacy parking ids left, cleanup switched off",
    ),
  );
}

export {
  cursorPagesFoldIdentically as "parken-bw: old cursor fetch node and port request the same pages and fold the same records",
  everyAbortOfTheOldNodeAbortsThePort as "parken-bw: overlap, stalled cursor, HTTP error and malformed pages abort both sides",
  pageCapIsLoudAndIncomplete as "parken-bw: the page cap is the old one, warns, and leaves the run incomplete",
  buildAndTablesMatchAcrossRuns as "parken-bw: entities, pending signatures and parkStatik/parkFrei/parkSummenSig match across two runs",
  missingBoundariesOnlyUseTheArs as "parken-bw: without boundaries only the ARS assigns, and nothing is pruned",
  runWritesWhatTheOldFlowWrites as "parken-bw: run() upserts the old chunks and resets the confirmations on an incomplete run",
  completeRunPrunesTheSameIds as "parken-bw: a complete run prunes the same ids (sites, sums, legacy), never a municipal entity",
  legacyCleanupSwitchesItselfOff as "parken-bw: the legacy cleanup switches itself off after an empty listing",
};
