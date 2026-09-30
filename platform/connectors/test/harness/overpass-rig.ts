/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Test rig of the three Overpass connectors (group D of phase 3): the geo
 * context both sides assign against, the flattening of the old chunk messages,
 * and a real `Ctx` whose only scripted edge is the network.
 *
 * The rig's fetcher answers Overpass from a callback and Orion with 204, and it
 * records what the connector asked for: the URL, the fetch options (pacing,
 * retries, timeout, User-Agent — the politeness towards Overpass is behaviour
 * and is asserted) and how many requests were in flight at once. It answers
 * asynchronously, so a connector that fired its tiles in parallel would show
 * up in `maxInFlight`.
 *
 * Everything else is the real kernel from src/kernel/ — geo view, change gate,
 * Orion client with its chunking — so a `run()` test pins the port, not a mock.
 */

import { join } from "node:path";
import { parse as parseBoundaries } from "../../src/connectors/grenzen-bw.js";
import { SignatureStore } from "../../src/kernel/change-gate.js";
import { StateStore } from "../../src/kernel/state.js";
import { createCtx } from "../../src/kernel/context.js";
import type { Kernel } from "../../src/kernel/context.js";
import { createDb } from "../../src/kernel/db.js";
import { createEnv } from "../../src/kernel/env.js";
import { createGeoIndex, createSharedGeo } from "../../src/kernel/geo.js";
import { createHttpServer } from "../../src/kernel/http.js";
import { createRateLimiter } from "../../src/kernel/rate-limit.js";
import { loadRegistry } from "../../src/kernel/registry.js";
import { createScheduler } from "../../src/kernel/scheduler.js";
import type {
  BoundarySet,
  Ctx,
  Fetcher,
  FetchOptions,
  GeoIndex,
  HttpResponse,
  JsonResponse,
} from "../../src/kernel/types.js";
import { readFixture, repositoryRoot } from "./fixtures.js";
import { httpResponse, recordingLog } from "./kernel.js";
import type { RecordedLog } from "./kernel.js";
import { isRecord } from "./normalize.js";
import { messagesOf } from "./vm-runner.js";
import type { FunctionNodeRun } from "./vm-runner.js";

/** The boundary fixture: raw for `global.bwGrenzen` of the old node, parsed for the port. */
export interface BoundaryFixture {
  readonly raw: unknown;
  readonly boundaries: BoundarySet;
}

export function boundaryFixture(): BoundaryFixture {
  const fixture = readFixture("grenzen-bw");
  const parsed = parseBoundaries(fixture.payload);
  if (parsed.skipped > 0) throw new Error("grenzen-bw fixture: unusable polygons");
  return { raw: structuredClone(fixture.payload), boundaries: parsed.boundaries };
}

/** What `ctx.geo.forRun` hands the port when only boundaries are loaded (PIP_ONLY). */
export function fixtureGeo(): GeoIndex {
  return createGeoIndex([], boundaryFixture().boundaries);
}

/**
 * The entities of all chunk messages the old build node emitted, in order —
 * what its upsert node would have sent, one chunk after the other.
 */
export function emittedEntities(run: FunctionNodeRun): unknown[] {
  return messagesOf(run).flatMap((message): unknown[] => {
    const payload = isRecord(message) ? message.payload : undefined;
    return Array.isArray(payload) ? payload : [];
  });
}

/** Sizes of the old chunk messages, for comparing the chunking. */
export function emittedChunkSizes(run: FunctionNodeRun): number[] {
  return messagesOf(run).map((message) => {
    const payload = isRecord(message) ? message.payload : undefined;
    return Array.isArray(payload) ? payload.length : -1;
  });
}

/** One request as the rig's fetcher saw it. */
export interface SeenFetch {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
  readonly options: FetchOptions | undefined;
}

export interface OverpassRig {
  readonly ctx: Ctx;
  readonly log: RecordedLog;
  readonly kernel: Kernel;
  /** Every request, Overpass and Orion, in order. */
  readonly seen: readonly SeenFetch[];
  overpass(): SeenFetch[];
  /** The entities of every upsert body, flattened, in order. */
  upserted(): unknown[];
  /** Entities per upsert request. */
  upsertSizes(): number[];
  /** Largest number of Overpass requests that were open at the same time. */
  maxInFlight(): number;
}

export interface RigOptions {
  /** Load the boundary fixture into the geo context. Default true. */
  readonly boundaries?: boolean;
  /** Called before the n-th Overpass request is answered (e.g. to abort). */
  readonly beforeAnswer?: (index: number, rig: OverpassRig) => void;
}

const ORION = "http://orion-ld:1026";

function isOverpass(url: string): boolean {
  return new URL(url).host === "overpass-api.de";
}

/**
 * A real `Ctx` for registry entry `id`, answering Overpass request n from
 * `answer(url, n)` (an `Error` = no response at all) and every Orion write
 * with 204.
 */
export function overpassRig(
  id: string,
  answer: (url: string, index: number) => HttpResponse | Error,
  options?: RigOptions,
): OverpassRig {
  const log = recordingLog();
  const seen: SeenFetch[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let overpassCount = 0;

  const text = async (url: string, fetchOptions?: FetchOptions): Promise<HttpResponse> => {
    seen.push({
      url,
      method: fetchOptions?.method ?? "GET",
      body: fetchOptions?.body,
      options: fetchOptions,
    });
    if (!isOverpass(url)) return httpResponse(204);
    const index = overpassCount;
    overpassCount += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      // Answer on a later turn, as a socket would: parallel requests overlap here.
      await new Promise((resolve) => setImmediate(resolve));
      // `rig` is assigned below, long before the first request is answered.
      options?.beforeAnswer?.(index, rig);
      const response = answer(url, index);
      if (response instanceof Error) throw response;
      return response;
    } finally {
      inFlight -= 1;
    }
  };
  const fetcher: Fetcher = {
    text,
    json: async (url: string, fetchOptions?: FetchOptions): Promise<JsonResponse> => {
      const response = await text(url, fetchOptions);
      if (!response.ok) return { status: response.status, ok: false, body: null };
      const body: unknown = JSON.parse(response.body);
      return { status: response.status, ok: true, body };
    },
  };

  const registry = loadRegistry(join(repositoryRoot(), "platform", "config", "connectors.json"));
  const entry = registry.byId(id);
  if (entry === undefined) throw new Error(`registry has no connector "${id}"`);
  const env = createEnv();
  const kernel: Kernel = {
    log,
    env,
    limiter: createRateLimiter(log),
    fetch: fetcher,
    orionUrl: ORION,
    signatures: new SignatureStore(),
    state: new StateStore(),
    geo: createSharedGeo(log),
    registry,
    publicHttp: createHttpServer(log),
    adminHttp: createHttpServer(log),
    scheduler: createScheduler(log),
    db: createDb(env),
    shutdown: new AbortController(),
    nowMs: Date.now,
  };
  if (options?.boundaries !== false) kernel.geo.setBoundaries(boundaryFixture().boundaries, 0);

  const upserts = (): unknown[][] =>
    seen
      .filter((request) => request.method === "POST" && request.url.includes("/entityOperations/upsert"))
      .map((request): unknown[] => {
        const parsed: unknown = JSON.parse(request.body ?? "[]");
        return Array.isArray(parsed) ? parsed : [];
      });

  const rig: OverpassRig = {
    ctx: createCtx(kernel, entry),
    log,
    kernel,
    seen,
    overpass: () => seen.filter((request) => isOverpass(request.url)),
    upserted: () => upserts().flat(),
    upsertSizes: () => upserts().map((entities) => entities.length),
    maxInFlight: () => maxInFlight,
  };
  return rig;
}

/** An Overpass answer carrying `payload` as its JSON body. */
export function overpassAnswer(payload: unknown, status = 200): HttpResponse {
  return httpResponse(status, JSON.stringify(payload), { "content-type": "application/json" });
}
