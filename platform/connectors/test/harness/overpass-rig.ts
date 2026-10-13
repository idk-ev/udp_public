/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Test rig of the three Overpass connectors (group D of phase 3): the geo
 * context both sides assign against, the flattening of the old chunk messages,
 * and a real `Ctx` whose only scripted edge is the network.
 *
 * The rig's fetcher answers Overpass from a callback, Orion listings from
 * `stored` (none by default) and every other Orion request with 204, and it
 * records what the connector asked for: the URL, the fetch options (retries,
 * timeout, User-Agent — the politeness towards Overpass is behaviour and is
 * asserted) and how many requests were in flight at once. It answers
 * asynchronously, so a connector that fired its tiles in parallel would show
 * up in `maxInFlight`.
 *
 * The rate limiter records every token taken and every pause asked for
 * (`acquired`, `pauses`). By default it hands out tokens at once, so a test
 * does not wait out the 90 s spacing; with `clock` it is the real limiter on
 * that simulated clock, and `seen[].at` tells when each request went out.
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
  RateLimiter,
  RateLimitOptions,
} from "../../src/kernel/types.js";
import { readFixture, repositoryRoot } from "./fixtures.js";
import { httpResponse, recordingLog } from "./kernel.js";
import type { RecordedLog } from "./kernel.js";
import { isRecord } from "./normalize.js";
import type { VirtualClock } from "./virtual-clock.js";
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
  /** When it went out: the simulated time with `clock`, else `Date.now()`. */
  readonly at: number;
}

/** A token the connector took from the rate limiter. */
export interface SeenAcquire {
  readonly host: string;
  readonly minIntervalMs: number | undefined;
  readonly maxConcurrent: number | undefined;
  readonly signal: boolean;
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
  /** Tokens taken from the rate limiter, in order. */
  readonly acquired: readonly SeenAcquire[];
  /** `limiter.pause(host, ms)` calls, in order. */
  readonly pauses: readonly { readonly host: string; readonly ms: number }[];
  /** `acquire` (granted), `release` and `pause` in the order they happened. */
  readonly events: readonly ("acquire" | "release" | "pause")[];
}

export interface RigOptions {
  /** Load the boundary fixture into the geo context. Default true. */
  readonly boundaries?: boolean;
  /** Called before the n-th Overpass request is answered (e.g. to abort). */
  readonly beforeAnswer?: (index: number, rig: OverpassRig) => void;
  /** The real rate limiter on this clock instead of one that never waits. */
  readonly clock?: VirtualClock;
  /** What an Orion listing of an entity type answers (keyValues records); none by default. */
  readonly stored?: Readonly<Record<string, readonly unknown[]>>;
  /** Status of every Orion listing instead of 200 (a broker fault). */
  readonly listingStatus?: number;
}

/**
 * A rate limiter that records what it is asked: tokens at once, or — with a
 * clock — the real limiter's tokens and pauses.
 */
function recordingLimiter(
  log: RecordedLog,
  clock: VirtualClock | undefined,
  acquired: SeenAcquire[],
  pauses: { host: string; ms: number }[],
  events: ("acquire" | "release" | "pause")[],
): RateLimiter {
  const real = clock === undefined ? null : createRateLimiter(log, clock);
  const acquire = async (host: string, options?: RateLimitOptions): Promise<() => void> => {
    acquired.push({
      host,
      minIntervalMs: options?.minIntervalMs,
      maxConcurrent: options?.maxConcurrent,
      signal: options?.signal !== undefined,
    });
    const release = real === null ? null : await real.acquire(host, options);
    if (release === null) await Promise.resolve();
    events.push("acquire");
    return () => {
      events.push("release");
      release?.();
    };
  };
  return {
    acquire,
    run: async <T>(host: string, task: () => Promise<T>, options?: RateLimitOptions): Promise<T> => {
      const release = await acquire(host, options);
      try {
        return await task();
      } finally {
        release();
      }
    },
    pause: (host: string, ms: number): void => {
      pauses.push({ host, ms });
      events.push("pause");
      real?.pause(host, ms);
    },
  };
}

/** An Orion entity listing answered from `stored`, paged as the broker would. */
function listingAnswer(url: URL, options: RigOptions | undefined): HttpResponse {
  if (options?.listingStatus !== undefined) return httpResponse(options.listingStatus, "");
  const records = options?.stored?.[url.searchParams.get("type") ?? ""] ?? [];
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "1000");
  return httpResponse(200, JSON.stringify(records.slice(offset, offset + limit)), {
    "ngsild-results-count": String(records.length),
  });
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

  const acquired: SeenAcquire[] = [];
  const pauses: { host: string; ms: number }[] = [];
  const events: ("acquire" | "release" | "pause")[] = [];
  const clock = options?.clock;

  const text = async (url: string, fetchOptions?: FetchOptions): Promise<HttpResponse> => {
    const method = fetchOptions?.method ?? "GET";
    seen.push({
      url,
      method,
      body: fetchOptions?.body,
      options: fetchOptions,
      at: clock === undefined ? Date.now() : clock.now(),
    });
    if (!isOverpass(url)) {
      const parsed = new URL(url);
      if (method === "GET" && parsed.pathname === "/ngsi-ld/v1/entities")
        return listingAnswer(parsed, options);
      return httpResponse(204);
    }
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
    limiter: recordingLimiter(log, clock, acquired, pauses, events),
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
    acquired,
    pauses,
    events,
  };
  return rig;
}

/** An Overpass answer carrying `payload` as its JSON body. */
export function overpassAnswer(payload: unknown, status = 200): HttpResponse {
  return httpResponse(status, JSON.stringify(payload), { "content-type": "application/json" });
}
