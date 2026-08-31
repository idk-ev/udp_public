/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Client for Orion-LD — batch upsert, batch delete, entity query.
 *
 * Replaces the three node types the flows used for this: the `http request`
 * node pointed at
 * `…/entityOperations/upsert?options=update` with `Content-Type:
 * application/ld+json`, the one pointed at `…/entityOperations/delete` with
 * `application/json`, and the plain GET against `/entities?type=…` that
 * `baustellen-bw` uses to find expired road works.
 *
 * ## Chunking
 *
 * The entity array is split before sending, exactly as `emitChunks` did in
 * CHUNK_HELPER: "Entities in Batch-Chunks aufteilen (Orion-Payload-Limit)". The
 * default of 150 is the size FN_MUNI passes; most other connectors pass 100 and
 * the two gauge connectors 50. A caller that cares says so.
 *
 * ## options=update
 *
 * Kept verbatim. It is what makes the change gate work at all: with
 * `options=update` Orion-LD only replaces the attributes actually sent, so an
 * unchanged entity can be refreshed with its `dateObserved` alone and costs one
 * TRoE row instead of a dozen. See src/kernel/change-gate.ts.
 *
 * ## Rate limiting
 *
 * Goes through the ordinary fetcher and therefore through the token bucket for
 * the Orion host — which is precisely the "1 Anfrage/s" delay node that sat
 * between every chunking function and its upsert node.
 */

import type {
  DeleteResult,
  EntityId,
  Fetcher,
  JsonResponse,
  Log,
  NgsiEntity,
  Orion,
  OrionQuery,
  UpsertOptions,
  UpsertResult,
} from "./types.js";

export const DEFAULT_ORION_URL = "http://orion-ld:1026";

/** As FN_MUNI: `emitChunks(node, msg, geaendert, 150)`. */
export const DEFAULT_CHUNK_SIZE = 150;

/** As FN_RW_EXPIRE: `msg.payload = ids.slice(0, 200)`. */
export const DELETE_CHUNK_SIZE = 200;

export function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const out: (readonly T[])[] = [];
  const step = Math.max(1, size);
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

class OrionClient implements Orion {
  readonly #log: Log;
  readonly #fetch: Fetcher;
  readonly #base: string;

  constructor(log: Log, fetcher: Fetcher, baseUrl: string) {
    this.#log = log;
    this.#fetch = fetcher;
    this.#base = baseUrl.replace(/\/+$/, "");
  }

  async upsert(entities: readonly NgsiEntity[], options?: UpsertOptions): Promise<UpsertResult> {
    if (entities.length === 0) return { entities: 0, chunks: 0, failedChunks: 0 };
    const chunks = chunk(entities, options?.chunkSize ?? DEFAULT_CHUNK_SIZE);
    const url = `${this.#base}/ngsi-ld/v1/entityOperations/upsert?options=update`;
    let failed = 0;

    // Sequential, not Promise.all: the chunks are paced by the token bucket
    // anyway, and a burst of parallel batches against Orion-LD is what the delay
    // node in front of the upsert existed to prevent.
    for (const part of chunks) {
      const response = await this.#fetch.text(url, {
        method: "POST",
        headers: { "Content-Type": "application/ld+json" },
        body: JSON.stringify(part),
      });
      // 201 for created, 204 for updated, 207 for a partially successful batch.
      if (!response.ok && response.status !== 207) {
        failed += 1;
        this.#log.warn(
          `orion upsert: ${String(part.length)} entities rejected with HTTP ${String(response.status)} — ` +
            response.body.slice(0, 300),
        );
      }
    }
    return { entities: entities.length, chunks: chunks.length, failedChunks: failed };
  }

  async delete(ids: readonly EntityId[]): Promise<DeleteResult> {
    if (ids.length === 0) return { requested: 0, chunks: 0, failedChunks: 0 };
    const chunks = chunk(ids, DELETE_CHUNK_SIZE);
    const url = `${this.#base}/ngsi-ld/v1/entityOperations/delete`;
    let failed = 0;

    for (const part of chunks) {
      const response = await this.#fetch.text(url, {
        method: "POST",
        // application/json, not ld+json: the payload is a bare list of ids, it
        // carries no context. The old batch_delete node set the same header.
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(part),
      });
      if (!response.ok && response.status !== 207) {
        failed += 1;
        this.#log.warn(
          `orion delete: ${String(part.length)} ids rejected with HTTP ${String(response.status)} — ` +
            response.body.slice(0, 300),
        );
      }
    }
    return { requested: ids.length, chunks: chunks.length, failedChunks: failed };
  }

  async find(query: OrionQuery): Promise<JsonResponse> {
    const search = new URLSearchParams({ type: query.type });
    if (query.idPattern !== undefined) search.set("idPattern", query.idPattern);
    if (query.attrs !== undefined && query.attrs.length > 0) search.set("attrs", query.attrs.join(","));
    if (query.q !== undefined) search.set("q", query.q);
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    if (query.count === true) search.set("count", "true");
    return this.#fetch.json(`${this.#base}/ngsi-ld/v1/entities?${search.toString()}`);
  }
}

export function createOrion(log: Log, fetcher: Fetcher, baseUrl?: string): Orion {
  return new OrionClient(log, fetcher, baseUrl ?? DEFAULT_ORION_URL);
}
