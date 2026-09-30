/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The self-healing prune (src/kernel/prune.ts, "Recent candidates and
 * backlog", "Blocked losses"). A backlog that piled up before any prune
 * existed used to block the prune for good: over the 30 % cap in every run,
 * skipped in every run, growing. Now the cap counts only RECENT candidates
 * against the fresh stock, and the backlog is drained oldest first in
 * bounded batches — but only after the prune ran a week without a gap, while
 * the fresh stock holds, and never a loss that blocked the prune: that one
 * waits for an operator.
 */

import assert from "node:assert/strict";

import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import type { SignatureScope } from "../../src/kernel/change-gate.js";
import { createSharedGeo, MasterDataCheck } from "../../src/kernel/geo.js";
import { confirmedByDelete, createOrion } from "../../src/kernel/orion.js";
import { BLOCKED_AFTER, createPruner, PruneBookkeeping } from "../../src/kernel/prune.js";
import type {
  BoundaryEntry,
  EntityId,
  HttpResponse,
  MunicipalityRow,
  PruneOptions,
  PruneResult,
} from "../../src/kernel/types.js";
import { httpResponse, recordingLog, scriptedFetcher } from "../harness/kernel.js";
import type { RecordedLog, SeenRequest } from "../harness/kernel.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse("2026-09-01T00:00:00Z");
const ID = (group: string, n: number): EntityId => `urn:ngsi-ld:Station:bw-${group}-${String(n)}`;

class Broker {
  /** id -> time of the last write */
  readonly written = new Map<string, number>();
  readonly deleted: string[][] = [];
  /** Deletes happen, but the 207 says nothing about them. */
  ambiguous = false;

  readonly respond = (request: SeenRequest): HttpResponse => {
    const params = request.url.searchParams;
    if (request.method === "GET" && params.get("type") === "Municipality") {
      return httpResponse(200, "[]", { "ngsild-results-count": "1100" });
    }
    if (request.method === "GET") {
      const all = [...this.written].map(([id, at]) => ({
        id,
        type: "Station",
        dateObserved: {
          type: "Property",
          value: { "@type": "DateTime", "@value": new Date(at).toISOString() },
        },
      }));
      const offset = Number(params.get("offset"));
      const limit = Number(params.get("limit"));
      return httpResponse(200, JSON.stringify(all.slice(offset, offset + limit)), {
        "ngsild-results-count": String(all.length),
      });
    }
    const parsed: unknown = JSON.parse(request.body ?? "[]");
    const ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    this.deleted.push(ids);
    for (const id of ids) this.written.delete(id);
    return this.ambiguous ? httpResponse(207, "{}") : httpResponse(204);
  };

  deletedIds(): string[] {
    return this.deleted.flat();
  }

  count(group: string): number {
    return [...this.written.keys()].filter((id) => id.includes(`-${group}-`)).length;
  }
}

function plausibleGeo(): { rows: MunicipalityRow[]; boundaries: Record<string, BoundaryEntry> } {
  const rows: MunicipalityRow[] = [];
  const boundaries: Record<string, BoundaryEntry> = {};
  for (let i = 0; i < 1100; i += 1) {
    const ags = `08${String(100000 + i)}`;
    rows.push([ags, `G ${String(i)}`, 48, 9, ags.slice(0, 5), "G", 1000, null, `g-${String(i)}`]);
    boundaries[ags] = {
      b: [0, 0, 1, 1],
      r: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    };
  }
  return { rows, boundaries };
}

interface Rig {
  readonly broker: Broker;
  readonly clock: { now: number };
  readonly log: RecordedLog;
  readonly book: PruneBookkeeping;
  readonly store: SignatureScope;
  prune(options?: Partial<PruneOptions>): Promise<PruneResult>;
}

function rig(backlogBatch = 100): Rig {
  const log = recordingLog();
  const clock = { now: START };
  const broker = new Broker();
  const store = new SignatureStore().scope("stations");
  const gate = createChangeGate(store, log);
  const orion = createOrion(log, scriptedFetcher(broker.respond).fetcher, gate, store, "http://orion.test");
  const geo = createSharedGeo(log);
  const master = plausibleGeo();
  geo.setMunicipalities(master.rows);
  geo.setBoundaries(master.boundaries, 0);
  const masterData = new MasterDataCheck();
  const book = new PruneBookkeeping(masterData);
  const pruner = createPruner({
    log,
    orion,
    signatures: store,
    geo,
    masterData,
    defaultIntervalMs: HOUR,
    nowMs: () => clock.now,
    bookkeeping: book,
  });
  return {
    broker,
    clock,
    log,
    book,
    store,
    prune: (options) =>
      pruner.stale({
        label: "Stations",
        type: "Station",
        pattern: "^urn:ngsi-ld:Station:bw-[a-z]+-[0-9]+$",
        graceMs: DAY,
        liveMs: 3 * HOUR,
        backlogBatch,
        signatureKey: "stationSig",
        ...options,
      }),
  };
}

/**
 * 100 live stations written every run, 20 gone for three days (recent), 250
 * gone for months (backlog: more than twice the whole live stock).
 */
function world(r: Rig): void {
  for (let n = 0; n < 100; n += 1) r.broker.written.set(ID("live", n), r.clock.now - HOUR);
  for (let n = 0; n < 20; n += 1) r.broker.written.set(ID("recent", n), r.clock.now - 3 * DAY);
  for (let n = 0; n < 250; n += 1) r.broker.written.set(ID("old", n), r.clock.now - 60 * DAY - n * HOUR);
}

/** An hour passes; the connector wrote its live stations (all, or the ones `writes` accepts). */
function nextRun(r: Rig, writes: (id: string) => boolean = () => true): void {
  r.clock.now += HOUR;
  for (const id of r.broker.written.keys()) {
    if (id.includes("-live-") && writes(id)) r.broker.written.set(id, r.clock.now - 60_000);
  }
}

async function hours(
  r: Rig,
  count: number,
  writes?: (id: string) => boolean,
  options?: Partial<PruneOptions>,
): Promise<void> {
  for (let hour = 0; hour < count; hour += 1) {
    nextRun(r, writes);
    await r.prune(options);
  }
}

/** Only the live stations numbered below `count` are still written: the others are lost upstream. */
const writtenBelow =
  (count: number) =>
  (id: string): boolean =>
    Number(id.split("-").at(-1)) < count;

/** Stations 0 to `count - 1` are no longer written. */
const lostBelow =
  (count: number) =>
  (id: string): boolean =>
    Number(id.split("-").at(-1)) >= count;

/* ── the drain ───────────────────────────────────────────────────────────── */

/** Recent ones at once; the backlog only after a week without a gap, then oldest first in batches. */
export async function backlogDrainsAfterAWeekOfRunning(): Promise<void> {
  const r = rig();
  world(r);
  const armed = await r.prune();
  assert.equal(armed.skipped, "no successful run within the last 2.5 intervals");

  nextRun(r);
  await r.prune();
  assert.equal(r.broker.count("recent"), 0, "the recent ones go at once (20 of 100 fresh: within the cap)");
  assert.equal(r.broker.count("old"), 250, "the backlog waits: running for an hour only");
  assert.ok(r.log.lines.some((line) => line.text.includes("backlog of 250 not drained")));

  await hours(r, 7 * 24 - 3);
  assert.equal(r.broker.count("old"), 250, "drained before a week of running");
  await hours(r, 2);
  const batch = r.broker.deleted.at(-1) ?? [];
  assert.equal(batch.length, 100, "one batch");
  // Oldest first: the old stations were written n hours apart, the highest n the longest ago.
  assert.deepEqual(
    batch,
    Array.from({ length: 100 }, (_, n) => ID("old", 249 - n)),
  );
  await hours(r, 2);
  assert.equal(r.broker.count("old"), 0, "drained");
  assert.equal(r.broker.count("live"), 100, "live kept");
  assert.equal(r.log.warnings().length, 0);
}

/**
 * A downtime longer than the backlog period: every entity looks a week old
 * after the restart. The gap resets the running week, so nothing is drained
 * until the connector has rewritten what it still has. (Before: 150 of 1,000
 * live entities deleted in the second prune after the restart.)
 */
export async function longDowntimeDeletesNoLiveEntity(): Promise<void> {
  for (const withReference of [false, true]) {
    const r = rig();
    for (let n = 0; n < 1000; n += 1) r.broker.written.set(ID("live", n), r.clock.now - HOUR);
    await r.prune();
    if (withReference) await hours(r, 5);
    r.clock.now += 8 * DAY;
    // After the restart the connector rewrites its stations over three runs,
    // and prunes BEFORE its writes (as carsharing-bw does).
    for (let hour = 0; hour < 48; hour += 1) {
      r.clock.now += HOUR;
      await r.prune();
      for (const id of r.broker.written.keys()) {
        if ((Number(id.split("-").at(-1)) + hour) % 3 === 0) r.broker.written.set(id, r.clock.now - 60_000);
      }
    }
    assert.deepEqual(
      r.broker.deletedIds(),
      [],
      `live entities deleted (reference: ${String(withReference)})`,
    );
  }
}

/** A drop of the fresh stock pauses the drain for a few runs, not just one. */
export async function shrinkingFreshStockPausesTheDrain(): Promise<void> {
  const r = rig(5);
  world(r);
  const options = { backlogMs: 2 * DAY };
  await r.prune(options);
  await hours(r, 3 * 24 + 2, undefined, options);
  const oldBefore = r.broker.count("old");
  assert.ok(oldBefore < 250, "drained after the (shortened) backlog period");
  // Ten live stations stop being written; after the grace they are recent
  // candidates (10 of 90 fresh: within the cap), the fresh stock falls to 90 %.
  let shrinking: string[] | undefined;
  for (let hour = 0; hour < 30 && shrinking === undefined; hour += 1) {
    nextRun(r, lostBelow(10));
    const before = r.broker.deleted.length;
    await r.prune(options);
    const run = r.broker.deleted.slice(before).flat();
    if (run.some((id) => id.includes("-live-"))) shrinking = run;
  }
  assert.ok(shrinking !== undefined, "the silent stations never became candidates");
  assert.ok(
    shrinking.every((id) => id.includes("-live-")),
    `drained while shrinking: ${shrinking.join(",")}`,
  );
  assert.ok(r.log.lines.some((line) => /not drained .*fresh stock 90, reference 100/.test(line.text)));
  const pausedAt = r.broker.count("old");
  let paused = 0;
  for (let hour = 0; hour < 10 && r.broker.count("old") === pausedAt; hour += 1) {
    nextRun(r, lostBelow(10));
    await r.prune(options);
    paused += 1;
  }
  assert.ok(paused >= 2 && paused < 10, `paused for ${String(paused)} runs`);
}

/* ── blocked losses ──────────────────────────────────────────────────────── */

/**
 * An upstream loss of 60 of 100 live stations (no keep, grace mode — car
 * sharing, sharing-bw) blocks the prune. Once they have aged into backlog the
 * cap passes again — but they are HELD: never deleted automatically, the
 * prune stays listed and logs an [error], while the old backlog from before
 * the block drains as usual. A release lets them go.
 */
export async function blockedLossIsHeldUntilReleased(): Promise<void> {
  const r = rig();
  world(r);
  await r.prune();
  await hours(r, 10);
  // The loss.
  await hours(r, 12 * 24, writtenBelow(40));
  assert.equal(r.broker.count("live"), 100, "a blocked loss was deleted");
  assert.equal(r.broker.count("old"), 0, "the backlog from before the block did not drain");
  const [block] = r.book.blocked();
  assert.ok(block !== undefined, "the blocked prune is no longer listed");
  assert.ok(block.since !== null && block.held === 60, JSON.stringify(block));
  assert.equal(block.skips, 0, "the cap passes again by now");
  const errors = r.log.lines.filter((line) => line.level === "error");
  assert.ok(errors.some((line) => line.text.includes("prune blocked by its share cap")));
  assert.equal(errors.at(-1)?.text.includes("holds back 60 entities"), true);

  // The operator checked the source: the loss is real.
  assert.equal(r.book.release(), 1);
  await hours(r, 2, writtenBelow(40));
  assert.equal(r.broker.count("live"), 40, "released: drained under the ordinary rules");
  assert.deepEqual(r.book.blocked(), []);
}

/** Should the lost stations come back, the block clears itself. */
export async function blockedLossThatComesBackClearsItself(): Promise<void> {
  const r = rig();
  world(r);
  await r.prune();
  await hours(r, 10);
  await hours(r, 2 * 24, writtenBelow(40));
  assert.ok((r.book.blocked()[0]?.skips ?? 0) >= BLOCKED_AFTER, "blocked");
  await hours(r, 3);
  assert.deepEqual(r.book.blocked(), [], "block kept after the loss came back");
  assert.equal(r.broker.count("live"), 100);
  assert.ok(r.log.lines.some((line) => line.text.includes("block cleared")));
}

/**
 * Without a grace period (keep + confirmation: register entries are written
 * once and never again) the age of a candidate is how long it has been one —
 * not the age of its last write. A mass loss from a "complete" source is
 * therefore RECENT, over the cap, and blocked for good; the confirmations
 * start over with every skip, so it never ages into backlog.
 */
export async function keepBasedMassLossStaysBlocked(): Promise<void> {
  const r = rig();
  for (let n = 0; n < 1000; n += 1) r.broker.written.set(ID("reg", n), r.clock.now - 90 * DAY);
  const options = (keep: number): Partial<PruneOptions> => ({
    graceMs: undefined,
    liveMs: undefined,
    confirmKey: "regGone",
    confirmMs: DAY,
    keep: new Set(Array.from({ length: keep }, (_, n) => ID("reg", n))),
  });
  await r.prune(options(1000));
  // 600 of the 1,000 register entries drop out upstream, for eight days.
  for (let hour = 0; hour < 8 * 24; hour += 1) {
    r.clock.now += HOUR;
    await r.prune(options(400));
  }
  assert.deepEqual(r.broker.deletedIds(), [], "a mass loss drained as backlog");
  assert.ok((r.book.blocked()[0]?.skips ?? 0) >= 8 * 24 - 1);

  // A few gone for good: deleted after the 24 h confirmation, as before.
  const few = rig();
  for (let n = 0; n < 1000; n += 1) few.broker.written.set(ID("reg", n), few.clock.now - 90 * DAY);
  await few.prune(options(1000));
  for (let hour = 0; hour < 26; hour += 1) {
    few.clock.now += HOUR;
    await few.prune(options(950));
  }
  assert.equal(few.broker.deletedIds().length, 50);
}

/** No cap (maxFraction 1, the parking legacy cleanup): no backlog, everything past the grace at once. */
export async function uncappedPruneHasNoBacklog(): Promise<void> {
  const r = rig();
  world(r);
  await r.prune({ maxFraction: 1 });
  nextRun(r);
  const result = await r.prune({ maxFraction: 1 });
  assert.equal(result.deleted, 270);
  assert.equal(result.backlogDeleted, 0);
}

/* ── bookkeeping, deletes ────────────────────────────────────────────────── */

/** Bookkeeping written before the backlog drain restores; the new fields survive a restart. */
export function bookkeepingKeepsItsNewFields(): void {
  const key = "a|T|^x$";
  const book = new PruneBookkeeping();
  assert.equal(book.restore({ lastRun: [[key, 1]], confirmations: [], masterDataCount: null }), true);
  assert.equal(book.fresh(key), undefined);
  book.setFresh(key, 42);
  book.setCapSkips(key, 4);
  book.setRunningSince(key, 7);
  book.setBlocked(key, 9, 3);
  const copy = new PruneBookkeeping();
  assert.equal(copy.restore(JSON.parse(JSON.stringify(book.snapshot()))), true);
  assert.equal(copy.fresh(key), 42);
  assert.equal(copy.runningSince(key), 7);
  assert.deepEqual(copy.blocked(), [{ key, skips: 4, since: 9, held: 3 }]);
  assert.equal(copy.restore({ lastRun: [], confirmations: [], fresh: [["a", "x"]] }), false);
}

/**
 * After another writer may have held the lock (or this process skipped a
 * generation itself), the store's bookkeeping is taken — never in the
 * direction that deletes sooner.
 */
export function reconciledBookkeepingIsConservative(): void {
  const key = "a|T|^x$";
  const memory = new PruneBookkeeping();
  memory.setConfirmations("gone", new Map());
  memory.setBlocked(key, 500, 7);
  memory.setFresh(key, 90);
  const store = new PruneBookkeeping();
  store.setConfirmations("gone", new Map([["urn:ngsi-ld:T:1", [100, 1] as const]]));
  store.setRunningSince(key, 1);
  store.setFresh(key, 80);
  store.mergeConservatively(memory.snapshot());
  assert.equal(
    store.confirmations("gone"),
    undefined,
    "an older confirmation would shorten 'two runs' to one",
  );
  assert.equal(store.runningSince(key), undefined, "the running week starts over");
  assert.equal(store.blockedSince(key), 500, "the block of the memory side is kept");
  assert.equal(store.fresh(key), 90, "the higher reference");
}

/**
 * A 207 to a delete that carries neither `success` nor `errors` says nothing
 * about any id: none counts as deleted.
 */
export function deleteWithoutAnswerListsConfirmsNothing(): void {
  const ids: EntityId[] = [ID("x", 1), ID("x", 2)];
  assert.deepEqual(confirmedByDelete(207, "{}", ids), []);
  assert.deepEqual(confirmedByDelete(207, "", ids), []);
  assert.deepEqual(confirmedByDelete(207, JSON.stringify({ errors: [] }), ids), ids);
  assert.deepEqual(confirmedByDelete(207, JSON.stringify({ success: [ID("x", 2)] }), ids), [ID("x", 2)]);
  assert.deepEqual(confirmedByDelete(207, JSON.stringify({ errors: [{ entityId: ID("x", 1) }] }), ids), [
    ID("x", 2),
  ]);
  assert.deepEqual(confirmedByDelete(204, "", ids), ids);
}

/**
 * …but every ATTEMPTED id loses its change signature: the delete may still
 * have happened, and a kept signature would turn the entity's return into a
 * partial write onto nothing — a skeleton entity.
 */
export async function unconfirmedDeleteForgetsSignatures(): Promise<void> {
  const r = rig();
  world(r);
  r.store.replace(
    "stationSig",
    new Map([...r.broker.written.keys()].map((id): [string, string] => [id, "sig"])),
  );
  r.broker.ambiguous = true;
  await r.prune();
  nextRun(r);
  const result = await r.prune();
  assert.equal(result.deleted, 0, "nothing confirmed");
  assert.equal(r.broker.deletedIds().length, 20, "the recent ones were attempted");
  const table = r.store.copy("stationSig");
  for (const id of r.broker.deletedIds()) assert.equal(table.has(id), false, `${id} kept its signature`);
  assert.equal(table.has(ID("live", 0)), true);
}
