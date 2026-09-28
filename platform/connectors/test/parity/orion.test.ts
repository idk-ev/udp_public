/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The Orion client: complete paged listing, the exact query the old pager
 * sent, chunk size validation and the redirect policy of writes.
 *
 * The listing is what both the prune and the city pulse act on, and both exist
 * to NOT act on a partial picture — so the page arithmetic is pinned at its
 * edges: a total that is an exact multiple of the page size, a total the
 * broker cannot deliver, a missing count header, too many pages, duplicates.
 */

import assert from "node:assert/strict";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import { createOrion } from "../../src/kernel/orion.js";
import type { EntityId, HttpResponse, ListResult, NgsiEntity, Orion } from "../../src/kernel/types.js";
import { fakeHttpModule, httpResponse, recordingLog, scriptedFetcher } from "../harness/kernel.js";
import type { SeenRequest } from "../harness/kernel.js";
import { contextApi, evaluateSnippetAsync, extractSnippet } from "../harness/vm-runner.js";

const CONTEXT = "https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.6.jsonld";

interface Listing {
  /** What the broker holds, in order. */
  readonly ids: readonly string[];
  /** Overrides the count header; `null` leaves it out. */
  readonly header?: number | null;
  /** Per page offset: the ids to return instead of the plain slice. */
  readonly pages?: ReadonlyMap<number, readonly string[]>;
}

function orionOver(respond: (request: SeenRequest) => HttpResponse | Error): {
  orion: Orion;
  seen: SeenRequest[];
} {
  const store = new SignatureStore().scope("test");
  const log = recordingLog();
  const { fetcher, seen } = scriptedFetcher(respond);
  return { orion: createOrion(log, fetcher, createChangeGate(store, log), store), seen };
}

function listingBroker(listing: Listing): (request: SeenRequest) => HttpResponse {
  return (request) => {
    const offset = Number(request.url.searchParams.get("offset"));
    const limit = Number(request.url.searchParams.get("limit"));
    const ids = listing.pages?.get(offset) ?? listing.ids.slice(offset, offset + limit);
    const header = listing.header === undefined ? listing.ids.length : listing.header;
    return httpResponse(
      200,
      JSON.stringify(ids.map((id) => ({ id, type: "T" }))),
      header === null ? {} : { "ngsild-results-count": String(header) },
    );
  };
}

async function list(listing: Listing, maxPages: number, dedupe = false): Promise<ListResult> {
  const { orion } = orionOver(listingBroker(listing));
  return orion.list({ type: "T" }, { pageSize: 2, maxPages, dedupe });
}

function idsOf(result: ListResult): unknown[] {
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result.entities.map((entity) =>
    typeof entity === "object" && entity !== null && "id" in entity ? entity.id : null,
  );
}

async function listingEdgesOfThePageArithmetic(): Promise<void> {
  // 4 of page size 2: two full pages, then an empty one ends the listing.
  assert.deepEqual(idsOf(await list({ ids: ["a", "b", "c", "d"] }, 10)), ["a", "b", "c", "d"]);
  assert.deepEqual(idsOf(await list({ ids: ["a", "b", "c", "d", "e"] }, 10)), ["a", "b", "c", "d", "e"]);
  // The broker claims more than it delivers.
  assert.deepEqual(await list({ ids: ["a", "b", "c"], header: 4 }, 10), {
    ok: false,
    reason: "incomplete (3/4)",
  });
  // Without a count header there is nothing to check against; the short page ends it.
  const headless = await list({ ids: ["a", "b", "c"], header: null }, 10);
  assert.deepEqual(idsOf(headless), ["a", "b", "c"]);
  assert.equal(headless.ok && headless.total, null);
  // Out of pages before a short one came: incomplete, never "all there is".
  assert.deepEqual(await list({ ids: ["a", "b", "c", "d", "e"] }, 2), {
    ok: false,
    reason: "incomplete (4/5)",
  });
}

async function dedupeAndTheCountCheck(): Promise<void> {
  // Offset paging while others write: "b" shows up twice, "c" is skipped.
  const shifted = { ids: ["a", "b", "c", "d"], pages: new Map([[2, ["b", "d"]]]) };
  assert.deepEqual(await list(shifted, 10, true), { ok: false, reason: "incomplete (3/4)" });
  // Without dedupe the duplicate is counted and the gap goes unnoticed — which
  // is why the pulse deduplicates.
  assert.deepEqual(idsOf(await list(shifted, 10, false)), ["a", "b", "b", "d"]);
  // A duplicate within a complete picture is collapsed, keeping its first place.
  const repeated = { ids: ["a", "b", "c"], header: 3, pages: new Map([[2, ["c", "a"]]]) };
  assert.deepEqual(idsOf(await list(repeated, 10, true)), ["a", "b", "c"]);
}

async function listingQueryIsByteIdenticalToTheOldPager(): Promise<void> {
  const pattern = "^urn:ngsi-ld:RoadWork:bw-(svz-[A-Za-z0-9_-]+|kreis-[0-9]{5}-summary)$";
  const attrs = ["ags", "dateObserved", "activeCount"];
  const empty = (): HttpResponse => httpResponse(200, "[]", { "ngsild-results-count": "0" });

  const legacySeen: SeenRequest[] = [];
  await evaluateSnippetAsync(
    extractSnippet("udp-rt-br-fn", "async function pruneStale(o) {", "    return deletedIds.length;\n}"),
    {
      http: fakeHttpModule((request) => {
        legacySeen.push(request);
        return empty();
      }),
      flow: contextApi(new Map()),
      node: { warn: () => undefined, log: () => undefined, status: () => undefined },
      Buffer,
      __o__: { label: "L", type: "RoadWork", pattern, attrs: attrs.join(",") },
    },
    "pruneStale(__o__)",
  );

  const { orion, seen } = orionOver(empty);
  await orion.list({ type: "RoadWork", idPattern: pattern, attrs, options: "sysAttrs" }, { maxPages: 100 });
  assert.equal(seen[0]?.target, legacySeen[0]?.target);
  assert.match(
    seen[0]?.target ?? "",
    /bw-\(svz-/,
    "parentheses stay unescaped, as encodeURIComponent leaves them",
  );
}

function entities(count: number): NgsiEntity[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `urn:ngsi-ld:T:${String(i)}`,
    type: "T",
    "@context": CONTEXT,
  }));
}

async function chunkSizeMustBeAPositiveInteger(): Promise<void> {
  for (const [chunkSize, chunks] of [
    [0, 2],
    [-3, 2],
    [Number.NaN, 2],
    [2.5, 2],
    [50, 4],
  ] as const) {
    const { orion } = orionOver(() => httpResponse(204));
    const result = await orion.upsert({ entities: entities(160), pending: [] }, { chunkSize });
    assert.equal(result.chunks, chunks, `upsert chunkSize ${String(chunkSize)}`);
  }
  const { orion } = orionOver(() => httpResponse(204));
  const ids: EntityId[] = entities(250).map((entity) => entity.id);
  assert.equal((await orion.delete(ids, { chunkSize: 0 })).chunks, 2, "delete falls back to 200");
}

async function writesRefuseRedirects(): Promise<void> {
  const { orion, seen } = orionOver((request) =>
    request.method === "GET" ? httpResponse(200, "[]") : httpResponse(204),
  );
  await orion.upsert({ entities: entities(1), pending: [] });
  await orion.delete(["urn:ngsi-ld:T:0"]);
  await orion.find({ type: "T" });
  assert.deepEqual(
    seen.map((request) => [request.method, request.redirect]),
    [
      ["POST", "error"],
      ["POST", "error"],
      ["GET", undefined],
    ],
  );
}

export {
  listingEdgesOfThePageArithmetic as "orion: list over pages — exact multiples, short counts, no header, page limit",
  dedupeAndTheCountCheck as "orion: list dedupe collapses repeats and still catches a skipped entity",
  listingQueryIsByteIdenticalToTheOldPager as "orion: listing query is byte-identical to the one PRUNE_HELPER sent",
  chunkSizeMustBeAPositiveInteger as "orion: chunk size must be a positive integer, else the default",
  writesRefuseRedirects as "orion: upsert and delete refuse redirects, reads follow them",
};
