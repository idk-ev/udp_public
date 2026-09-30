/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The self-healing prune (src/kernel/prune.ts, "Recent candidates and
 * backlog"). A backlog that piled up before any prune existed used to block
 * the prune for good: over the 30 % cap in every run, skipped in every run,
 * growing. Now the cap counts only RECENT candidates against the fresh stock,
 * and the backlog is drained oldest first in bounded batches — but only while
 * every guard holds and the fresh stock does, so an upstream outage never
 * drains anything.
 */

import assert from "node:assert/strict";

import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import { createSharedGeo, MasterDataCheck } from "../../src/kernel/geo.js";
import { confirmedByDelete, createOrion } from "../../src/kernel/orion.js";
import { BLOCKED_AFTER, createPruner, PruneBookkeeping } from "../../src/kernel/prune.js";
import type {
  BoundaryEntry,
  EntityId,
  HttpResponse,
  MunicipalityRow,
  PruneOptions,
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
    return httpResponse(204);
  };

  deletedIds(): string[] {
    return this.deleted.flat();
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
  prune(options?: Partial<PruneOptions>): ReturnType<ReturnType<typeof createPruner>["stale"]>;
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
    prune: (options) =>
      pruner.stale({
        label: "Stations",
        type: "Station",
        pattern: "^urn:ngsi-ld:Station:bw-[a-z]+-[0-9]+$",
        graceMs: DAY,
        liveMs: 3 * HOUR,
        backlogBatch,
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

export async function backlogDrainsOldestFirstInBatches(): Promise<void> {
  const r = rig();
  world(r);
  // Before: 270 of 370 candidates, far over 30 % — the prune could never run.
  const armed = await r.prune();
  assert.equal(armed.skipped, "no successful run within the last 2.5 intervals");

  nextRun(r);
  const first = await r.prune();
  assert.equal(first.skipped, null);
  assert.deepEqual(
    r.broker.deletedIds().sort(),
    Array.from({ length: 20 }, (_, n) => ID("recent", n)).sort(),
    "the recent ones go at once (20 of 100 fresh: within the cap)",
  );
  assert.equal(first.backlogDeleted, 0, "no previous fresh stock recorded: the backlog waits a run");
  assert.ok(r.log.lines.some((line) => line.text.includes("backlog of 250 not drained")));

  nextRun(r);
  await r.prune();
  const batch = r.broker.deleted.at(-1) ?? [];
  assert.equal(batch.length, 100, "one batch");
  // Oldest first: the old stations were written n hours apart, the highest n the longest ago.
  assert.deepEqual(
    batch,
    Array.from({ length: 100 }, (_, n) => ID("old", 249 - n)),
  );

  nextRun(r);
  await r.prune();
  nextRun(r);
  const last = await r.prune();
  assert.equal(last.backlogDeleted, 50);
  assert.equal([...r.broker.written.keys()].filter((id) => id.includes("-old-")).length, 0, "drained");
  assert.equal([...r.broker.written.keys()].filter((id) => id.includes("-live-")).length, 100, "live kept");
  assert.equal(r.log.warnings().length, 0);
}

/**
 * An upstream outage: a third of the live stations stops being written. Once
 * they are past the grace they are RECENT candidates over the cap: nothing at
 * all is deleted — the backlog neither — the skips are counted and, from the
 * third on, an [error]. They could only become backlog after a week without a
 * write while the connector runs.
 */
export async function outageNeverDrainsTheBacklog(): Promise<void> {
  const r = rig(5);
  world(r);
  await r.prune();
  nextRun(r);
  await r.prune();
  const drained = r.broker.deletedIds().length;
  assert.equal(drained, 20);

  const silent = (id: string): boolean => Number(id.split("-").at(-1)) >= 40;
  for (let hour = 0; hour < 30; hour += 1) {
    nextRun(r, silent);
    await r.prune();
  }
  const oldGone = r.broker.deletedIds().filter((id) => id.includes("-old-")).length;
  // Drained while the stock held (the hours before the silent ones passed the grace) …
  assert.ok(oldGone > 0 && oldGone < 250, `backlog drained ${String(oldGone)}`);
  const stoppedAt = r.broker.deleted.length;
  const skips = r.book.blocked();
  assert.equal(skips.length, 1, "the blocked prune is listed");
  assert.ok((skips[0]?.[1] ?? 0) >= BLOCKED_AFTER);
  assert.ok(r.log.lines.some((line) => line.level === "error" && line.text.includes("prune blocked")));
  assert.equal(
    r.broker.deletedIds().filter((id) => id.includes("-live-")).length,
    0,
    "no live station deleted",
  );

  // Nothing more while it lasts.
  nextRun(r, silent);
  await r.prune();
  assert.equal(r.broker.deleted.length, stoppedAt);

  // The connector itself is down: nothing written any more. Within liveMs
  // (3 h) the long-gone backlog still drains; after that, every run is
  // skipped and nothing is touched.
  const down = rig(5);
  world(down);
  await down.prune();
  nextRun(down);
  await down.prune();
  let skipped: string | null = null;
  for (let hour = 0; hour < 5 && skipped === null; hour += 1) {
    down.clock.now += HOUR;
    skipped = (await down.prune()).skipped;
  }
  assert.match(skipped ?? "", /connector down/);
  const deletedWhenDown = down.broker.deletedIds().length;
  for (let hour = 0; hour < 3; hour += 1) {
    down.clock.now += HOUR;
    await down.prune();
  }
  assert.equal(down.broker.deletedIds().length, deletedWhenDown, "drained while the connector was down");
  assert.equal(down.broker.deletedIds().filter((id) => id.includes("-live-")).length, 0);
}

/** A drop of the fresh stock by more than 5 % pauses the drain, even within the cap. */
export async function shrinkingFreshStockPausesTheDrain(): Promise<void> {
  const r = rig(5);
  world(r);
  await r.prune();
  nextRun(r);
  await r.prune();
  // Ten live stations stop being written; after the grace they are recent
  // candidates (10 of 90 fresh: within the cap), the fresh stock fell to 90 %.
  const writes = (id: string): boolean => Number(id.split("-").at(-1)) >= 10;
  let shrinking: string[] | undefined;
  for (let hour = 0; hour < 30 && shrinking === undefined; hour += 1) {
    nextRun(r, writes);
    const before = r.broker.deleted.length;
    await r.prune();
    const run = r.broker.deleted.slice(before).flat();
    if (run.some((id) => id.includes("-live-"))) shrinking = run;
  }
  assert.ok(shrinking !== undefined, "the silent stations never became candidates");
  assert.equal(shrinking.length, 10);
  assert.ok(
    shrinking.every((id) => id.includes("-live-")),
    `drained while shrinking: ${shrinking.join(",")}`,
  );
  assert.ok(
    r.log.lines.some((line) => /backlog of \d+ not drained .*fresh stock 90, previous 100/.test(line.text)),
  );
  // The next run sees a steady stock again and goes on.
  const oldBefore = r.broker.deletedIds().filter((id) => id.includes("-old-")).length;
  nextRun(r, writes);
  await r.prune();
  assert.ok(r.broker.deletedIds().filter((id) => id.includes("-old-")).length > oldBefore);
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

/** Bookkeeping written before the backlog drain restores; fresh stock and skips survive a restart. */
export function bookkeepingKeepsFreshStockAndSkips(): void {
  const book = new PruneBookkeeping();
  assert.equal(book.restore({ lastRun: [["a|T|^x$", 1]], confirmations: [], masterDataCount: null }), true);
  assert.equal(book.fresh("a|T|^x$"), undefined);
  book.setFresh("a|T|^x$", 42);
  book.setCapSkips("a|T|^x$", 4);
  const copy = new PruneBookkeeping();
  assert.equal(copy.restore(JSON.parse(JSON.stringify(book.snapshot()))), true);
  assert.equal(copy.fresh("a|T|^x$"), 42);
  assert.deepEqual(copy.blocked(), [["a|T|^x$", 4]]);
  assert.equal(copy.restore({ lastRun: [], confirmations: [], fresh: [["a", "x"]] }), false);
}

/**
 * A 207 to a delete that carries neither `success` nor `errors` says nothing
 * about any id: none counts as deleted, none loses its signature.
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
