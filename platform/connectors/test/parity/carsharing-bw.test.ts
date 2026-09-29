/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Parity: carsharing-bw — master data (`udp-rt-cs-msgs`, `udp-rt-cs-fn`) and
 * status (`udp-rt-cz-msgs`, `udp-rt-cz-fn`, `udp-rt-cz-commit`) against the
 * port.
 *
 * Pinned: the station cache and the form factors after three real systems
 * (two of them around Ulm, where the Neu-Ulm stations must stay out), the
 * rule that a list without a station in BW leaves the cache alone, the status
 * entities with the change gate in MERGE mode and `freshEvery: 3` across two
 * runs, and a whole run: requests, upserts, and the age prunes with the
 * `ownGbfs` ownership check and the `csSig` signatures they forget.
 *
 * Fixtures: test/fixtures/gbfs-systems.json and carsharing-bw-<system>-
 * {station_information,vehicle_types,station_status}.json for swu2go,
 * conficars_ulm and teilauto_schwaebisch_hall (see their `note`s).
 */

import assert from "node:assert/strict";
import { createChangeGate, mergePlans, SignatureStore } from "../../src/kernel/change-gate.js";
import type { SignatureScope } from "../../src/kernel/change-gate.js";
import {
  build,
  buildStatus,
  formFactorOf,
  GATE_KEY,
  parse,
  parseStatus,
  replaceSystem,
  run,
  stationSignature,
} from "../../src/connectors/carsharing-bw.js";
import type { StationCache } from "../../src/connectors/carsharing-bw.js";
import type { EntityId, UpsertPlan } from "../../src/kernel/types.js";
import { readFixture } from "../harness/fixtures.js";
import { fakeHttpModule, recordingLog } from "../harness/kernel.js";
import {
  Broker,
  flowObject,
  fullGeo,
  HOUR,
  jsonAnswer,
  legacyGlobal,
  mobilityCtx,
  staleOptions,
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

const INFO_LIST_NODE = "udp-rt-cs-msgs";
const INFO_NODE = "udp-rt-cs-fn";
const STATUS_LIST_NODE = "udp-rt-cz-msgs";
const STATUS_NODE = "udp-rt-cz-fn";
const COMMIT_NODE = "udp-rt-cz-commit";
const SYSTEMS = ["teilauto_schwaebisch_hall", "swu2go", "conficars_ulm"] as const;
type System = (typeof SYSTEMS)[number];
type Feed = "station_information" | "vehicle_types" | "station_status";

function fixture(system: System, feed: Feed): { readonly url: string; readonly payload: unknown } {
  const recorded = readFixture(`carsharing-bw-${system}-${feed}`);
  return { url: recorded.source, payload: structuredClone(recorded.payload) };
}

/* ── the old master data run ─────────────────────────────────────────────── */

async function legacyMasterData(
  inputs: readonly { readonly system: string; readonly feed: "info" | "typen"; readonly payload: unknown }[],
  withBoundaries = true,
): Promise<{ flow: Record<string, unknown>; warnings: string[] }> {
  let flow: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const input of inputs) {
    const result = await runFunctionNode(INFO_NODE, {
      msg: { _msgid: "parity", statusCode: 200, ...input },
      global: legacyGlobal(fullGeo(), withBoundaries),
      flow,
    });
    warnings.push(...result.warnings);
    flow = flowObject(result.flow);
  }
  return { flow, warnings };
}

function realInputs(): { system: System; feed: "info" | "typen"; payload: unknown }[] {
  return SYSTEMS.flatMap((system) => [
    { system, feed: "info" as const, payload: fixture(system, "station_information").payload },
    { system, feed: "typen" as const, payload: fixture(system, "vehicle_types").payload },
  ]);
}

/** The port's master data over the same messages. */
function portedMasterData(
  inputs: readonly { readonly system: string; readonly feed: "info" | "typen"; readonly payload: unknown }[],
): { cache: StationCache | null; formFactors: Map<string, string> } {
  let cache: StationCache | null = null;
  const formFactors = new Map<string, string>();
  for (const input of inputs) {
    if (input.feed === "typen") {
      const types = formFactorOf({ system: input.system, payload: input.payload });
      if (types.formFactor !== null) formFactors.set(types.system, types.formFactor);
      continue;
    }
    const feed = parse({ system: input.system, payload: input.payload });
    const entries = build(feed, fullGeo().index, new Date().toISOString());
    if (entries.length > 0) cache = replaceSystem(cache ?? new Map(), feed.system, entries);
  }
  return { cache, formFactors };
}

function cacheObject(cache: StationCache | null): unknown {
  return cache === null ? undefined : normalize(Object.fromEntries(cache));
}

async function masterDataMatches(): Promise<void> {
  const inputs = realInputs();
  const legacy = await legacyMasterData(inputs);
  const ported = portedMasterData(inputs);
  assert.deepEqual(legacy.warnings, []);
  assert.deepEqual(cacheObject(ported.cache), normalize(legacy.flow.csStationen), "station cache differs");
  assert.deepEqual(
    normalize(Object.fromEntries(ported.formFactors)),
    normalize(legacy.flow.csBauform),
    "form factors differ",
  );

  // The strict lookup keeps Neu-Ulm (Bavaria) out of the cache.
  const conficars = fixture("conficars_ulm", "station_information").payload;
  const total =
    isRecord(conficars) && isRecord(conficars.data) && Array.isArray(conficars.data.stations)
      ? conficars.data.stations.length
      : 0;
  const cached = [...(ported.cache?.keys() ?? [])].filter((key) => key.startsWith("conficars_ulm::")).length;
  assert.ok(
    cached > 0 && cached < total,
    `conficars_ulm: ${String(cached)} of ${String(total)} stations cached`,
  );
}

async function listWithoutBwStationKeepsTheCache(): Promise<void> {
  // Test input: swu2go's list replaced by one station in Basel.
  const basel = { data: { stations: [{ station_id: "x", lat: 47.5596, lon: 7.5886, name: "Basel" }] } };
  const inputs = [...realInputs(), { system: "swu2go", feed: "info" as const, payload: basel }];
  const legacy = await legacyMasterData(inputs);
  const ported = portedMasterData(inputs);
  assert.deepEqual(cacheObject(ported.cache), normalize(legacy.flow.csStationen));
  assert.ok(
    [...(ported.cache?.keys() ?? [])].some((key) => key.startsWith("swu2go::")),
    "swu2go stations dropped",
  );
}

/* ── status ──────────────────────────────────────────────────────────────── */

interface StatusRound {
  readonly flow: Record<string, unknown>;
  readonly payloads: unknown[];
}

async function legacyStatus(
  master: Record<string, unknown>,
  flowIn: Record<string, unknown>,
): Promise<StatusRound> {
  let flow: Record<string, unknown> = {
    ...flowIn,
    csStationen: master.csStationen,
    csBauform: master.csBauform,
  };
  const payloads: unknown[] = [];
  for (const system of SYSTEMS) {
    const result = await runFunctionNode(STATUS_NODE, {
      msg: { _msgid: "parity", statusCode: 200, system, payload: fixture(system, "station_status").payload },
      flow,
    });
    flow = flowObject(result.flow);
    for (const message of messagesOf(result)) {
      if (!isRecord(message)) continue;
      payloads.push(message.payload);
      const commit = await runFunctionNode(COMMIT_NODE, {
        msg: { ...message, statusCode: 204, payload: "" },
        flow,
      });
      flow = flowObject(commit.flow);
    }
  }
  return { flow, payloads };
}

function portedStatus(
  cache: StationCache,
  formFactors: ReadonlyMap<string, string>,
  store: SignatureScope,
): UpsertPlan[] {
  const gate = createChangeGate(store, recordingLog());
  const plans: UpsertPlan[] = [];
  for (const system of SYSTEMS) {
    const built = buildStatus(
      parseStatus({ system, payload: fixture(system, "station_status").payload }),
      cache,
      formFactors,
      new Date().toISOString(),
    );
    const plan = mergePlans(
      gate.check(GATE_KEY, built.stations, stationSignature, { freshEvery: 3, periodMs: HOUR }),
      gate.ungated(built.fleets),
    );
    if (plan.entities.length === 0) continue;
    plans.push(plan);
    store.commit(plan.pending, new Set<EntityId>(plan.entities.map((entity) => entity.id)));
  }
  return plans;
}

/** Runs `body` so that it starts and ends within one clock hour (the freshTurn rotation). */
async function withinOneHour<T>(body: () => Promise<T>): Promise<T> {
  for (;;) {
    const before = Math.floor(Date.now() / HOUR);
    const result = await body();
    if (Math.floor(Date.now() / HOUR) === before) return result;
  }
}

async function statusMatchesAcrossTwoRuns(): Promise<void> {
  const inputs = realInputs();
  const master = (await legacyMasterData(inputs)).flow;
  const { cache, formFactors } = portedMasterData(inputs);
  assert.ok(cache !== null);

  await withinOneHour(async () => {
    const store = new SignatureStore().scope("carsharing-bw");
    const first = await legacyStatus(master, {});
    const firstPlans = portedStatus(cache, formFactors, store);
    assertEntitiesEqual(
      first.payloads.flat(),
      firstPlans.flatMap((plan) => plan.entities),
    );
    assert.deepEqual(
      normalize(Object.fromEntries(store.copy(GATE_KEY))),
      normalize(first.flow.csSig),
      "csSig",
    );

    // Second run, nothing changed: stations only as freshness, one in three.
    const second = await legacyStatus(master, first.flow);
    const secondPlans = portedStatus(cache, formFactors, store);
    assertEntitiesEqual(
      second.payloads.flat(),
      secondPlans.flatMap((plan) => plan.entities),
    );
    const stations = secondPlans
      .flatMap((plan) => plan.entities)
      .filter((e) => e.type === "CarSharingStation");
    assert.ok(
      stations.every((entity) => !("availableVehicles" in entity)),
      "unchanged station written in full",
    );
    // MERGE: the table holds all three systems, not only the last one.
    const systems = new Set([...store.copy(GATE_KEY).keys()].map((id) => id.split("-")[1]));
    assert.ok(systems.size > 1, "csSig was replaced per system");
  });
}

/* ── run() ───────────────────────────────────────────────────────────────── */

const STALE = "urn:ngsi-ld:CarSharingStation:ulm-swu2go-SWU-Station-0";
const FRESH = "urn:ngsi-ld:CarSharingStation:ulm-swu2go-SWU-Station-1";
const FOREIGN = "urn:ngsi-ld:CarSharingStation:ulm-stadtwerke-1";
const STALE_FLEET = "urn:ngsi-ld:FleetStatus:ulm-gone";

function seed(broker: Broker, now: number): void {
  const stamp = (ms: number): Record<string, unknown> => ({
    type: "Property",
    value: { "@type": "DateTime", "@value": new Date(ms).toISOString() },
  });
  const own = { type: "Property", value: "MobiData BW GBFS" };
  broker.entities.set(STALE, {
    id: STALE,
    type: "CarSharingStation",
    dataProvider: own,
    dateObserved: stamp(now - 30 * HOUR),
  });
  broker.entities.set(FRESH, {
    id: FRESH,
    type: "CarSharingStation",
    dataProvider: own,
    dateObserved: stamp(now - HOUR),
  });
  broker.entities.set(FOREIGN, {
    id: FOREIGN,
    type: "CarSharingStation",
    dataProvider: { type: "Property", value: "Stadtwerke Ulm" },
    dateObserved: stamp(now - 30 * HOUR),
  });
  broker.entities.set(STALE_FLEET, {
    id: STALE_FLEET,
    type: "FleetStatus",
    dataProvider: own,
    dateObserved: stamp(now - 30 * HOUR),
  });
  broker.entities.set(`${STALE_FLEET}-2`, {
    id: `${STALE_FLEET}-2`,
    type: "FleetStatus",
    dataProvider: own,
    dateObserved: stamp(now - HOUR),
  });
}

function serveAll(broker: Broker): void {
  const list = readFixture("gbfs-systems");
  broker.sources.set(list.source, jsonAnswer(list.payload));
  for (const system of SYSTEMS) {
    for (const feed of ["station_information", "vehicle_types", "station_status"] as const) {
      const recorded = fixture(system, feed);
      broker.sources.set(recorded.url, jsonAnswer(recorded.payload));
    }
  }
}

async function runMatchesTheOldFlows(): Promise<void> {
  const list = readFixture("gbfs-systems");
  const now = Date.now();
  const master = (await legacyMasterData(realInputs())).flow;

  // Old list nodes: the requests they fan out, and the status list node's prunes.
  const infoList = await runFunctionNode(INFO_LIST_NODE, {
    msg: { _msgid: "parity", statusCode: 200, payload: structuredClone(list.payload) },
  });
  const oldBroker = new Broker(fullGeo().municipalities.length);
  seed(oldBroker, now);
  const statusList = await runFunctionNode(STATUS_LIST_NODE, {
    msg: { _msgid: "parity", statusCode: 200, payload: structuredClone(list.payload) },
    global: legacyGlobal(fullGeo()),
    flow: {
      ...master,
      csSig: { [STALE]: "1", [FRESH]: "2" },
      pruneLastRun_Carsharing_stations: now - HOUR,
      pruneLastRun_Carsharing_fleets: now - HOUR,
    },
    modules: { http: fakeHttpModule(oldBroker.respond) },
  });
  await oldBroker.idle();
  const oldUrls = [...messagesOf(infoList), ...messagesOf(statusList)].map((message) =>
    isRecord(message) ? message.url : undefined,
  );

  // Port: two runs an hour apart, the first one arms the prune intervals.
  const world = mobilityCtx({ id: "carsharing-bw", start: now - HOUR });
  seed(world.broker, now);
  serveAll(world.broker);
  world.store.replace(
    GATE_KEY,
    new Map([
      [STALE, "1"],
      [FRESH, "2"],
    ]),
  );
  await withinOneHour(async () => {
    await run(world.ctx);
    world.clock.now = now;
    world.broker.requests.length = 0;
    world.broker.upserts.length = 0;
    await run(world.ctx);
    // The second run's writes are the old status node's second round:
    // freshness for the unchanged stations, fleets in full.
    const legacyClock = openClock();
    const first = await legacyStatus(master, {});
    const second = await legacyStatus(master, first.flow);
    const legacyWindow = legacyClock.close();
    assert.deepEqual(
      normalize(world.broker.upserts),
      normalize(JSON.parse(JSON.stringify(second.payloads))),
      "upserts of the second run differ",
    );
    // Stamped with the port's clock of THAT run (the test clock, `now`).
    assertClockStamps(second.payloads, world.broker.upserts, {
      legacy: legacyWindow,
      ported: fixedClock(now),
    });
  });

  const feedRequests = world.broker.requests
    .filter((request) => request.url.origin !== "http://orion-ld:1026" && request.url.href !== list.source)
    .map((request) => request.url.href);
  assert.deepEqual(feedRequests, oldUrls, "feed requests differ");
  // The settings themselves, against the old pruneStale option objects.
  assertPruneSettings("carsharing-bw", legacyPruneSettings(STATUS_LIST_NODE), staleOptions(world), world.ctx);
  assert.deepEqual(world.broker.deletes.flat().sort(), oldBroker.deletes.flat().sort(), "pruned ids differ");
  assert.deepEqual(oldBroker.deletes.flat().sort(), [STALE_FLEET, STALE].sort());
  assert.ok(world.broker.entities.has(FOREIGN), "a foreign station was pruned");
  assert.deepEqual(world.broker.listings(), oldBroker.listings(), "prune listings differ");
  const oldSig = statusList.flow.get("csSig");
  assert.ok(isRecord(oldSig) && !(STALE in oldSig) && FRESH in oldSig);
  assert.ok(!world.store.copy(GATE_KEY).has(STALE), "the pruned station keeps its signature");
}

async function statusWaitsForMasterData(): Promise<void> {
  const list = readFixture("gbfs-systems");
  const legacy = await runFunctionNode(STATUS_LIST_NODE, {
    msg: { _msgid: "parity", statusCode: 200, payload: structuredClone(list.payload) },
    global: legacyGlobal(fullGeo()),
    modules: { http: fakeHttpModule(new Broker(0).respond) },
  });
  assert.equal(messagesOf(legacy).length, 0);
  assert.equal(legacy.warnings.length, 1);

  // Port: master data feeds unavailable -> warn once, no status request, no prune.
  const world = mobilityCtx({ id: "carsharing-bw", start: Date.now() });
  world.broker.sources.set(list.source, jsonAnswer(list.payload));
  await run(world.ctx);
  assert.deepEqual(world.log.warnings(), ["Carsharing: master data not loaded yet — run skipped"]);
  assert.ok(!world.broker.requests.some((request) => request.url.pathname.endsWith("/station_status")));
  assert.deepEqual(world.pruneCalls, []);
}

export {
  masterDataMatches as "carsharing-bw: station cache and form factors match the old master data node on three live systems",
  listWithoutBwStationKeepsTheCache as "carsharing-bw: a station list without a station in BW leaves the cache alone",
  statusMatchesAcrossTwoRuns as "carsharing-bw: stations and fleets match across two runs (merge gate, freshEvery 3)",
  runMatchesTheOldFlows as "carsharing-bw: run() requests, upserts and prunes (ownGbfs, csSig) as the two old flows",
  statusWaitsForMasterData as "carsharing-bw: without master data the status run is skipped with a warning",
};
