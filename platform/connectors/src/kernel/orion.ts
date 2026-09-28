/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Client for Orion-LD — batch upsert with signature commit, batch delete,
 * entity query and complete paged listing.
 *
 * Replaces the node types the flows used for this: the `http request` node
 * pointed at `…/entityOperations/upsert?options=update` with the "Signaturen
 * bestätigen" function node behind it (`upsert_commit`, SIG_COMMIT), the one
 * pointed at `…/entityOperations/delete` with `application/json`, the plain GET
 * against `/entities?type=…`, and the two hand-written `http.request` pagers of
 * PRUNE_HELPER and the city pulse.
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
 * ## Commit after confirm
 *
 * Every chunk carries the pending signatures of its entities (`sigsFor(chunk)`
 * in the old flows). After the broker answered, those of the CONFIRMED ids are
 * committed and the rest dropped — see {@link confirmedByUpsert} for what counts
 * as confirmed. The reason is the incident this replaced: signatures stored
 * before the write froze values for weeks during Orion outages.
 *
 * ## No retries on writes
 *
 * The old upsert and delete nodes sent once. A retried upsert whose first
 * attempt did reach the broker but timed out on the way back would write every
 * attribute row into TRoE twice; the next run resends what was not confirmed
 * anyway. Reads (`find`, `list`) keep the fetcher's retries.
 *
 * ## Rate limiting
 *
 * Goes through the ordinary fetcher and therefore through the token bucket for
 * the Orion host — which is precisely the "1 Anfrage/s" delay node that sat
 * between every chunking function and its upsert node.
 */

import { isArray, isRecord, isString, isTruthy } from "./parse.js";
import type { SignatureScope } from "./change-gate.js";
import type {
  ChangeGate,
  ChangeGateOptions,
  DeleteOptions,
  DeleteResult,
  EntityId,
  Fetcher,
  HttpResponse,
  JsonResponse,
  ListOptions,
  ListResult,
  Log,
  NgsiEntity,
  Orion,
  OrionQuery,
  PendingSignature,
  SignatureValue,
  UpsertOptions,
  UpsertPlan,
  UpsertResult,
} from "./types.js";

export const DEFAULT_ORION_URL = "http://orion-ld:1026";

/** As FN_MUNI: `emitChunks(node, msg, geaendert, 150)`. */
export const DEFAULT_CHUNK_SIZE = 150;

/** As FN_RW_EXPIRE: `msg.payload = ids.slice(0, 200)`. */
export const DELETE_CHUNK_SIZE = 200;

/** Page size of both old pagers. */
export const LIST_PAGE_SIZE = 1000;

const NONE: ReadonlySet<EntityId> = new Set();

/**
 * A chunk or page size as given, if it is a positive whole number, else the
 * default — `chunkSize: 0` or `NaN` must not turn into one request per entity
 * or an endless loop.
 */
export function sizeOr(size: number | undefined, fallback: number): number {
  return size !== undefined && Number.isInteger(size) && size > 0 ? size : fallback;
}

export function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const out: (readonly T[])[] = [];
  const step = Math.max(1, size);
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

/** `idOf` of SIG_COMMIT: a batch result lists ids as strings or as `{ entityId }` / `{ id }`. */
function idOf(item: unknown): unknown {
  if (isString(item)) return item;
  if (!isRecord(item)) return undefined;
  // `x.entityId || x.id`: an empty or missing entityId falls through to id.
  return isTruthy(item.entityId) ? item.entityId : item.id;
}

/**
 * Which ids of an upsert chunk the broker confirmed — the decision of SIG_COMMIT:
 *
 *  * 207 Multi-Status: per entity. `success` lists the confirmed ids; without
 *    it, every id not listed in `errors` counts. A body that is not JSON, or
 *    carries neither list: nothing is confirmed.
 *  * any other 2xx: the whole chunk.
 *  * everything else — 4xx, 5xx, and (via `status: null`) a timeout or refused
 *    connection, which the old node saw as a non-numeric statusCode: nothing.
 *
 * The result is limited to the ids of the chunk.
 */
export function confirmedByUpsert(
  status: number | null,
  body: string,
  sent: readonly EntityId[],
): ReadonlySet<EntityId> {
  if (status === 207) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body === "" ? "{}" : body);
    } catch {
      return NONE;
    }
    if (!isRecord(parsed)) return NONE;
    const success = parsed.success;
    if (isArray(success)) {
      const ok = new Set(success.map(idOf));
      return new Set(sent.filter((id) => ok.has(id)));
    }
    const errors = parsed.errors;
    if (isArray(errors)) {
      const bad = new Set(errors.map(idOf));
      return new Set(sent.filter((id) => !bad.has(id)));
    }
    return NONE;
  }
  if (status !== null && status >= 200 && status < 300) return new Set(sent);
  return NONE;
}

/** `x && (x.entityId || x.id)` of the prune's delete: strings in `errors` count as nothing. */
function deleteErrorId(item: unknown): unknown {
  if (!isRecord(item)) return undefined;
  return idOf(item);
}

/**
 * Which ids of a delete chunk the broker confirmed — the decision of
 * PRUNE_HELPER, which differs from the upsert's in two details and is kept
 * that way: only 204 and 200 confirm the whole chunk, and a 207 whose body
 * carries neither list confirms EVERY id (nothing reported as failed), while
 * an unparseable body or one whose `errors` is not a list confirms none.
 */
export function confirmedByDelete(
  status: number,
  body: string,
  sent: readonly EntityId[],
): readonly EntityId[] {
  if (status === 204 || status === 200) return sent;
  if (status !== 207) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body === "" ? "{}" : body);
  } catch {
    return [];
  }
  // `b.errors` on null throws in the original, which its catch turns into [].
  if (parsed === null) return [];
  // `(b.errors || [])`, and `.map` on anything else throws -> [].
  const errors = isRecord(parsed) ? parsed.errors : undefined;
  const errorList: unknown = isTruthy(errors) ? errors : [];
  if (!isArray(errorList)) return [];
  const bad = new Set(errorList.map(deleteErrorId));
  const success = isRecord(parsed) ? parsed.success : undefined;
  if (isArray(success)) return sent.filter((id) => success.includes(id));
  return sent.filter((id) => !bad.has(id));
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class OrionClient implements Orion {
  readonly #log: Log;
  readonly #fetch: Fetcher;
  readonly #gate: ChangeGate;
  readonly #signatures: SignatureScope;
  readonly #base: string;

  constructor(log: Log, fetcher: Fetcher, gate: ChangeGate, signatures: SignatureScope, baseUrl: string) {
    this.#log = log;
    this.#fetch = fetcher;
    this.#gate = gate;
    this.#signatures = signatures;
    this.#base = baseUrl.replace(/\/+$/, "");
  }

  async upsert(plan: UpsertPlan, options?: UpsertOptions): Promise<UpsertResult> {
    if (plan.entities.length === 0) {
      return { entities: 0, chunks: 0, failedChunks: 0, confirmed: NONE, committed: 0, dropped: 0 };
    }
    const chunks = chunk(plan.entities, sizeOr(options?.chunkSize, DEFAULT_CHUNK_SIZE));
    const url = `${this.#base}/ngsi-ld/v1/entityOperations/upsert?options=update`;
    const confirmedAll = new Set<EntityId>();
    let failed = 0;
    let committed = 0;
    let dropped = 0;

    // Sequential, not Promise.all: the chunks are paced by the token bucket
    // anyway, and a burst of parallel batches against Orion-LD is what the delay
    // node in front of the upsert existed to prevent.
    for (const part of chunks) {
      const ids = part.map((entity) => entity.id);
      const idSet = new Set(ids);
      const pending: PendingSignature[] = plan.pending.filter((signature) => idSet.has(signature[3]));

      let response: HttpResponse | null = null;
      let failure = "";
      try {
        response = await this.#fetch.text(url, {
          method: "POST",
          headers: { "Content-Type": "application/ld+json" },
          body: JSON.stringify(part),
          retries: 0,
          redirect: "error",
        });
      } catch (error) {
        failure = describeFailure(error);
      }

      const status = response === null ? null : response.status;
      const body = response === null ? "" : response.body;
      const confirmed = confirmedByUpsert(status, body, ids);
      for (const id of confirmed) confirmedAll.add(id);
      const outcome = this.#signatures.commit(pending, confirmed);
      committed += outcome.committed;
      dropped += outcome.dropped;

      const statusText = status === null ? `no response: ${failure}` : String(status);
      const chunkFailed = status === null || ((status < 200 || status >= 300) && status !== 207);
      if (chunkFailed) failed += 1;
      if (outcome.dropped > 0) {
        // Wording of SIG_COMMIT, so the warning reads the same in both runtimes.
        this.#log.warn(
          `Upsert not confirmed (${statusText}): ${String(outcome.dropped)} change signatures dropped, ` +
            `entities will be sent again${body === "" ? "" : ` — ${body.slice(0, 200)}`}`,
        );
      } else if (chunkFailed) {
        this.#log.warn(
          `orion upsert: ${String(part.length)} entities not confirmed (${statusText})` +
            (body === "" ? "" : ` — ${body.slice(0, 300)}`),
        );
      }
      if (pending.length > 0) {
        this.#log.status(
          `${String(outcome.committed)} committed` +
            (outcome.dropped > 0 ? `, ${String(outcome.dropped)} dropped` : "") +
            ` (${statusText})`,
        );
      }
    }
    return {
      entities: plan.entities.length,
      chunks: chunks.length,
      failedChunks: failed,
      confirmed: confirmedAll,
      committed,
      dropped,
    };
  }

  async upsertChanged<T extends NgsiEntity>(
    key: string,
    entities: readonly T[],
    sigOf: (entity: T) => SignatureValue,
    options?: ChangeGateOptions & UpsertOptions,
  ): Promise<UpsertResult> {
    const plan = this.#gate.check(key, entities, sigOf, options);
    return this.upsert(plan, options);
  }

  async delete(ids: readonly EntityId[], options?: DeleteOptions): Promise<DeleteResult> {
    if (ids.length === 0) return { requested: 0, chunks: 0, failedChunks: 0, deleted: NONE };
    const label = options?.label ?? "orion";
    const chunks = chunk(ids, sizeOr(options?.chunkSize, DELETE_CHUNK_SIZE));
    const url = `${this.#base}/ngsi-ld/v1/entityOperations/delete`;
    const deleted = new Set<EntityId>();
    let failed = 0;

    for (const part of chunks) {
      let response: HttpResponse;
      try {
        response = await this.#fetch.text(url, {
          method: "POST",
          // application/json, not ld+json: the payload is a bare list of ids, it
          // carries no context. The old batch_delete node set the same header.
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(part),
          retries: 0,
          redirect: "error",
        });
      } catch (error) {
        failed += 1;
        this.#log.warn(`${label} delete failed (${describeFailure(error)})`);
        continue;
      }
      const ok = confirmedByDelete(response.status, response.body, part);
      for (const id of ok) deleted.add(id);
      if (response.status === 207) {
        if (ok.length < part.length) {
          this.#log.warn(`${label} delete, ${String(part.length - ok.length)} ids failed`);
        }
      } else if (ok.length === 0) {
        failed += 1;
        this.#log.warn(`${label} delete HTTP ${String(response.status)}`);
      }
    }
    return { requested: ids.length, chunks: chunks.length, failedChunks: failed, deleted };
  }

  /**
   * Built with `encodeURIComponent` per value, in the parameter order of
   * PRUNE_HELPER — byte for byte what the old pager sent. (`URLSearchParams`
   * would encode a space as `+` and escape `(`, `)`, `!`, `'`, `~`, which an
   * idPattern such as `bw-(svz-…|kreis-…)` contains.)
   */
  #entitiesUrl(query: OrionQuery): string {
    const parts: string[] = [`type=${encodeURIComponent(query.type)}`];
    const add = (name: string, value: string): void => {
      parts.push(`${name}=${encodeURIComponent(value)}`);
    };
    if (query.idPattern !== undefined) add("idPattern", query.idPattern);
    if (query.attrs !== undefined && query.attrs.length > 0) add("attrs", query.attrs.join(","));
    if (query.q !== undefined) add("q", query.q);
    if (query.options !== undefined) add("options", query.options);
    if (query.count === true) add("count", "true");
    if (query.limit !== undefined) add("limit", String(query.limit));
    if (query.offset !== undefined) add("offset", String(query.offset));
    return `${this.#base}/ngsi-ld/v1/entities?${parts.join("&")}`;
  }

  async count(query: OrionQuery): Promise<number | null> {
    try {
      const response = await this.#fetch.text(this.#entitiesUrl({ ...query, count: true, limit: 1 }), {
        headers: { Accept: "application/json" },
      });
      if (response.status !== 200) return null;
      const total = Number.parseInt(response.headers["ngsild-results-count"] ?? "", 10);
      return Number.isFinite(total) && total >= 0 ? total : null;
    } catch {
      return null;
    }
  }

  async find(query: OrionQuery): Promise<JsonResponse> {
    return this.#fetch.json(this.#entitiesUrl(query));
  }

  /**
   * Port of the two pagers (PRUNE_HELPER step 1, `alle()` of the city pulse):
   * `count=true`, pages of 1000 by `offset`, done when a page comes back short,
   * and the collected number checked against `NGSILD-Results-Count`.
   */
  async list(query: OrionQuery, options: ListOptions): Promise<ListResult> {
    const pageSize = sizeOr(options.pageSize, LIST_PAGE_SIZE);
    const collected: unknown[] = [];
    const byId = new Map<unknown, unknown>();
    let total: number | null = null;
    let first = true;

    try {
      for (let page = 0; page < options.maxPages; page += 1) {
        const response = await this.#fetch.text(
          this.#entitiesUrl({ ...query, count: true, limit: pageSize, offset: page * pageSize }),
          { headers: { Accept: "application/json" } },
        );
        if (response.status !== 200) return { ok: false, reason: `HTTP ${String(response.status)}` };
        const parsed: unknown = JSON.parse(response.body);
        if (!isArray(parsed)) return { ok: false, reason: "is not an array" };
        if (first) {
          first = false;
          const header = Number.parseInt(response.headers["ngsild-results-count"] ?? "", 10);
          total = Number.isFinite(header) ? header : null;
        }
        for (const record of parsed) {
          if (options.dedupe !== true) {
            collected.push(record);
            continue;
          }
          // `if (e && e.id) byId.set(e.id, e)` — a later duplicate replaces the
          // earlier one in place, keeping the first position.
          const id = isRecord(record) ? record.id : undefined;
          if (isString(id) && id !== "") byId.set(id, record);
        }
        const count = options.dedupe === true ? byId.size : collected.length;
        if (parsed.length < pageSize) {
          if (total !== null && count < total) {
            return { ok: false, reason: `incomplete (${String(count)}/${String(total)})` };
          }
          return { ok: true, entities: options.dedupe === true ? [...byId.values()] : collected, total };
        }
      }
    } catch (error) {
      return { ok: false, reason: `failed (${describeFailure(error)})` };
    }
    const count = options.dedupe === true ? byId.size : collected.length;
    return { ok: false, reason: `incomplete (${String(count)}/${total === null ? "NaN" : String(total)})` };
  }
}

/**
 * One client per connector: its warnings carry the connector's name, which is
 * what `scripts/healthcheck.sh` groups them by. The signature store behind it
 * is shared.
 */
export function createOrion(
  log: Log,
  fetcher: Fetcher,
  gate: ChangeGate,
  signatures: SignatureScope,
  baseUrl?: string,
): Orion {
  return new OrionClient(log, fetcher, gate, signatures, baseUrl ?? DEFAULT_ORION_URL);
}
