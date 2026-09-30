/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * carsharing-bw: stations gone from their system's COMPLETE station list in
 * two consecutive runs are deleted (src/connectors/carsharing-bw.ts, "Vanished
 * stations") — ephemeral free-floating "virtual stations" are gone after about
 * two hours instead of piling up. Never on a failed or empty feed, never more
 * than half of a system's stations, only that system's own ids.
 */

import assert from "node:assert/strict";

import {
  diffSystems,
  LIVE_KEY,
  MAX_MISSING_RUNS,
  run,
  STATIC_KEY,
  systemPattern,
} from "../../src/connectors/carsharing-bw.js";
import { readFixture } from "../harness/fixtures.js";
import { httpResponse } from "../harness/kernel.js";
import { HOUR, jsonAnswer, mobilityCtx } from "../harness/mobility.js";
import type { MobilityWorld } from "../harness/mobility.js";
import { isRecord } from "../harness/normalize.js";

const ID = (slug: string, system: string, station: string): string =>
  `urn:ngsi-ld:CarSharingStation:${slug}-${system}-${station}`;

/* ── the diff itself ─────────────────────────────────────────────────────── */

export function missingTwiceIsRemoved(): void {
  const a = ID("ulm", "swu2go", "1");
  const b = ID("ulm", "swu2go", "2");
  const c = ID("ulm", "swu2go", "3");
  const first = diffSystems(new Map(), new Map(), new Map([["swu2go", [a, b, c]]]));
  assert.deepEqual([...first.remove], [], "the first run only records");
  assert.deepEqual(first.known.get("swu2go"), [a, b, c]);

  const once = diffSystems(first.known, first.missing, new Map([["swu2go", [a, b]]]));
  assert.deepEqual([...once.remove], [], "missing once is not enough");
  assert.equal(once.missing.get(c), 1);
  assert.deepEqual(once.known.get("swu2go"), [a, b, c], "known until it is deleted");

  const twice = diffSystems(once.known, once.missing, new Map([["swu2go", [a, b]]]));
  assert.deepEqual([...twice.remove], [["swu2go", [c]]]);

  // Back in the list after one miss: the streak starts over.
  const back = diffSystems(once.known, once.missing, new Map([["swu2go", [a, b, c]]]));
  assert.deepEqual([...back.remove], []);
  assert.equal(back.missing.has(c), false);
}

export function failedFeedBreaksTheStreak(): void {
  const a = ID("ulm", "swu2go", "1");
  const b = ID("ulm", "swu2go", "2");
  const c = ID("ulm", "swu2go", "3");
  const first = diffSystems(new Map(), new Map(), new Map([["swu2go", [a, b, c]]]));
  const once = diffSystems(first.known, first.missing, new Map([["swu2go", [a, b]]]));
  const failed = diffSystems(once.known, once.missing, new Map([["swu2go", null]]));
  assert.deepEqual([...failed.remove], [], "never on a failed or empty feed");
  assert.equal(failed.missing.has(c), false, "consecutive means consecutive");
  // A system that left the system list is not looked at either.
  const absent = diffSystems(once.known, once.missing, new Map([["other", [ID("ulm", "other", "9")]]]));
  assert.equal(absent.missing.has(c), false);
  const again = diffSystems(failed.known, failed.missing, new Map([["swu2go", [a, b]]]));
  assert.deepEqual([...again.remove], [], "one miss after the failure");
}

export function capAndOwnSchemeHold(): void {
  const ids = ["1", "2", "3", "4"].map((n) => ID("ulm", "swu2go", n));
  const first = diffSystems(new Map(), new Map(), new Map([["swu2go", ids]]));
  const keep = ids.slice(0, 1);
  const once = diffSystems(first.known, first.missing, new Map([["swu2go", keep]]));
  const twice = diffSystems(once.known, once.missing, new Map([["swu2go", keep]]));
  assert.deepEqual([...twice.remove], [], "three of four at once: over the 50 % cap");
  assert.deepEqual(twice.capped, [["swu2go", 3, 4]]);

  // An id of another scheme in the persisted list is never a candidate.
  const foreign = "urn:ngsi-ld:CarSharingStation:ulm-stadtwerke-1";
  const known = new Map([["swu2go", [...ids, foreign]]]);
  const diff = diffSystems(known, new Map([[foreign, 5]]), new Map([["swu2go", ids]]));
  assert.ok(![...diff.remove.values()].flat().includes(foreign));
  assert.ok(!new RegExp(systemPattern("swu2go")).test(foreign));
  assert.ok(new RegExp(systemPattern("swu2go")).test(ids[0] ?? ""));
}

/**
 * An id that is live in ANY system's list is never deleted (system "a" with
 * station "b-1" and system "a-b" with station "1" share an id), and an id
 * that stays missing without being deleted is let go after two days.
 */
export function liveElsewhereAndLongMissing(): void {
  const shared = ID("ulm", "a-b", "1");
  const other = ID("ulm", "a", "2");
  const first = diffSystems(new Map(), new Map(), new Map([["a", [shared, other, ID("ulm", "a", "3")]]]));
  const lists = new Map([
    ["a", [other, ID("ulm", "a", "3")]],
    ["a-b", [shared]],
  ]);
  const once = diffSystems(first.known, first.missing, lists);
  const twice = diffSystems(once.known, once.missing, lists);
  assert.deepEqual([...twice.remove], [], "deleted an id another system still lists");

  const gone = ID("ulm", "a", "9");
  const stuck = diffSystems(
    new Map([["a", [other, gone]]]),
    new Map([[gone, MAX_MISSING_RUNS]]),
    new Map([["a", [other]]]),
  );
  assert.equal(stuck.missing.has(gone), false);
  assert.deepEqual(stuck.known.get("a"), [other], "let go after two days");
}

/* ── through run(), on the recorded feeds ────────────────────────────────── */

const SYSTEMS = ["teilauto_schwaebisch_hall", "swu2go", "conficars_ulm"] as const;

function serve(world: MobilityWorld, withoutSwu: readonly string[] = [], swuFails = false): void {
  const list = readFixture("gbfs-systems");
  world.broker.sources.set(list.source, jsonAnswer(list.payload));
  for (const system of SYSTEMS) {
    for (const feed of ["station_information", "vehicle_types", "station_status"] as const) {
      const recorded = readFixture(`carsharing-bw-${system}-${feed}`);
      const payload = structuredClone(recorded.payload);
      if (system === "swu2go" && feed !== "vehicle_types") {
        if (swuFails && feed === "station_information") {
          world.broker.sources.set(recorded.source, httpResponse(503, ""));
          continue;
        }
        const data = isRecord(payload) && isRecord(payload.data) ? payload.data : {};
        const stations = Array.isArray(data.stations) ? data.stations : [];
        data.stations = stations.filter(
          (station: unknown) => !(isRecord(station) && withoutSwu.includes(String(station.station_id))),
        );
      }
      world.broker.sources.set(recorded.source, jsonAnswer(payload));
    }
  }
}

/** swu2go stations the connector wrote, as `[station_id, entity id]`. */
function swuStations(world: MobilityWorld): [string, string][] {
  const info = readFixture("carsharing-bw-swu2go-station_information").payload;
  const data = isRecord(info) && isRecord(info.data) ? info.data : {};
  const stations = Array.isArray(data.stations) ? data.stations : [];
  const written = new Set(
    world.broker.upserts
      .flat()
      .flatMap((entity) => (isRecord(entity) && typeof entity.id === "string" ? [entity.id] : [])),
  );
  const out: [string, string][] = [];
  for (const station of stations) {
    if (!isRecord(station)) continue;
    const stationId = String(station.station_id);
    const suffix = `-swu2go-${stationId.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
    const id = [...written].find((entity) => entity.endsWith(suffix));
    if (id !== undefined) out.push([stationId, id]);
  }
  return out;
}

/**
 * Only stations the broker holds are tracked: a station of
 * `station_information` without a status was never written, and deleting it
 * would fail run after run.
 */
export function onlyWrittenStationsAreDiffed(): void {
  const one = ID("ulm", "a", "1");
  const never = ID("ulm", "a", "2");
  const first = diffSystems(new Map(), new Map(), new Map([["a", [one, never]]]), new Map([[one, "s"]]));
  assert.deepEqual(first.known.get("a"), [one], "a never written station is tracked");
  const gone = diffSystems(first.known, first.missing, new Map([["a", [one]]]), new Map([[one, "s"]]));
  assert.equal(gone.missing.has(never), false);
  // The cap counts the stations the list had before they went missing, not
  // the ids still waiting for their deletion.
  const ids = ["1", "2", "3", "4"].map((n) => ID("ulm", "a", n));
  const waiting = ["7", "8", "9"].map((n) => ID("ulm", "a", n));
  const known = new Map([["a", [...ids, ...waiting]]]);
  const missing = new Map<string, number>([
    ...waiting.map((id): [string, number] => [id, MAX_MISSING_RUNS]),
    [ids[3] ?? "", 1],
  ]);
  const diff = diffSystems(known, missing, new Map([["a", ids.slice(0, 3)]]));
  assert.deepEqual([...diff.remove], [["a", [ids[3]]]], "one of four gone: within the cap");
  const inflated = diffSystems(
    new Map([["a", [...ids, ...waiting]]]),
    new Map<string, number>([
      ...waiting.map((id): [string, number] => [id, MAX_MISSING_RUNS]),
      ...ids.slice(1).map((id): [string, number] => [id, 1]),
    ]),
    new Map([["a", ids.slice(0, 1)]]),
  );
  assert.deepEqual(inflated.capped, [["a", 3, 4]], "the waiting ids do not raise the cap");
}

/**
 * A station sent in full (new, changed master data, weekly refresh) has no
 * signature until the broker confirmed it. Two failed upserts of its system
 * in a row must not make a station that is still in the feed "missing":
 * liveness comes from the feed, not from the tables.
 */
export function transientlyMissingSignatureIsNoLoss(): void {
  const ids = ["1", "2", "3", "4"].map((n) => ID("ulm", "a", n));
  const all = new Map(ids.map((id): [string, string] => [id, "s"]));
  const first = diffSystems(new Map(), new Map(), new Map([["a", ids]]), all);
  // Upserts of system a fail twice: two of its signatures are dropped for now.
  const partly = new Map(ids.slice(2).map((id): [string, string] => [id, "s"]));
  const once = diffSystems(first.known, first.missing, new Map([["a", ids]]), partly);
  const twice = diffSystems(once.known, once.missing, new Map([["a", ids]]), partly);
  assert.deepEqual([...twice.remove], [], "live feed stations deleted");
  assert.equal(twice.missing.size, 0);
  assert.deepEqual(twice.known.get("a"), ids, "still tracked");
}

export async function vanishedStationIsDeletedAfterTwoRuns(): Promise<void> {
  const start = Date.parse("2026-09-29T09:00:00Z");
  // The first run writes; only then does the diff know the stations.
  const world = mobilityCtx({ id: "carsharing-bw", start: start - HOUR });
  serve(world);
  await run(world.ctx);
  world.clock.now = start;
  await run(world.ctx);
  const stations = swuStations(world);
  assert.ok(stations.length >= 4, `swu2go stations in BW: ${String(stations.length)}`);
  const [goneStation, goneId] = stations[0] ?? ["", ""];
  assert.ok(world.store.copy(STATIC_KEY).has(goneId));

  for (const hour of [1, 2]) {
    world.clock.now = start + hour * HOUR;
    serve(world, [goneStation]);
    await run(world.ctx);
  }
  assert.deepEqual(world.broker.deletes.flat(), [goneId], "deleted after the second run without it");
  assert.ok(
    world.pruneCalls.some((call) => call.kind === "remove" && call.removed?.includes(goneId) === true),
  );
  for (const key of [STATIC_KEY, LIVE_KEY]) assert.ok(!world.store.copy(key).has(goneId), `${key} kept`);

  // Deleted once: gone from the known list, not deleted again.
  world.clock.now = start + 3 * HOUR;
  serve(world, [goneStation]);
  await run(world.ctx);
  assert.deepEqual(world.broker.deletes.flat(), [goneId]);
}

export async function failedFeedAndCapDeleteNothing(): Promise<void> {
  const start = Date.parse("2026-09-29T09:00:00Z");
  const world = mobilityCtx({ id: "carsharing-bw", start: start - HOUR });
  serve(world);
  await run(world.ctx);
  world.clock.now = start;
  await run(world.ctx);
  const stations = swuStations(world);
  const [goneStation] = stations[0] ?? [""];

  // Missing, then the feed fails, then missing again: not two consecutive runs.
  world.clock.now = start + HOUR;
  serve(world, [goneStation]);
  await run(world.ctx);
  world.clock.now = start + 2 * HOUR;
  serve(world, [], true);
  await run(world.ctx);
  world.clock.now = start + 3 * HOUR;
  serve(world, [goneStation]);
  await run(world.ctx);
  assert.deepEqual(world.broker.deletes.flat(), [], "deleted across a failed feed");

  // More than half of the system at once: warned, not deleted.
  const capped = mobilityCtx({ id: "carsharing-bw", start: start - HOUR });
  serve(capped);
  await run(capped.ctx);
  capped.clock.now = start;
  await run(capped.ctx);
  const most = stations.slice(0, Math.floor(stations.length / 2) + 2).map(([station]) => station);
  for (const hour of [1, 2]) {
    capped.clock.now = start + hour * HOUR;
    serve(capped, most);
    await run(capped.ctx);
  }
  assert.deepEqual(capped.broker.deletes.flat(), [], "over the per-system cap");
  assert.ok(capped.log.warnings().some((line) => line.includes("over the per-system cap")));
}
