/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Assembles the kernel and, from it, one {@link Ctx} per connector.
 *
 * Shared deliberately: the rate limiter, or it would not know how hard a host
 * is being hit in total; the geo context, because `stammdaten-bw` fills what
 * twenty other connectors read; the signature store, of which every connector
 * only ever sees its own namespace.
 *
 * Per connector: the logger — its component name is what
 * `scripts/healthcheck.sh` groups warnings by — and therefore every service
 * that logs on the connector's behalf (change gate, Orion client, geo view,
 * pruner), plus the prune bookkeeping, which the old flows kept in node and
 * flow context of the connector's own function nodes.
 */

import { createChangeGate, SignatureStore } from "./change-gate.js";
import { createDb } from "./db.js";
import { createEnv } from "./env.js";
import { createFetcher } from "./fetcher.js";
import { createSharedGeo, MasterDataCheck } from "./geo.js";
import type { SharedGeo } from "./geo.js";
import { createHttpServer } from "./http.js";
import type { HttpServer } from "./http.js";
import { createLog } from "./log.js";
import { createOrion, DEFAULT_ORION_URL } from "./orion.js";
import { createPruner } from "./prune.js";
import { createRateLimiter } from "./rate-limit.js";
import { intervalMsOf } from "./registry.js";
import { createScheduler } from "./scheduler.js";
import type {
  Ctx,
  Db,
  Env,
  Fetcher,
  IsoTime,
  Log,
  RateLimiter,
  Registry,
  RegistryEntry,
  Scheduler,
} from "./types.js";

export interface Kernel {
  readonly log: Log;
  readonly env: Env;
  readonly limiter: RateLimiter;
  readonly fetch: Fetcher;
  readonly orionUrl: string;
  readonly signatures: SignatureStore;
  readonly geo: SharedGeo;
  readonly registry: Registry;
  /** Connector routes only (`/abfahrten`, `/warnungen.ics`); proxied to the internet. */
  readonly publicHttp: HttpServer;
  /** `/healthz` and `/trigger/:id`; never proxied — see src/kernel/admin.ts. */
  readonly adminHttp: HttpServer;
  readonly scheduler: Scheduler;
  /** Shared by the two SQL connectors; connects per session, lazily. */
  readonly db: Db;
  /** Aborted on SIGTERM/SIGINT; handed to every connector as `ctx.signal`. */
  readonly shutdown: AbortController;
  /** Milliseconds clock of the gate rotation and the prune guards. */
  readonly nowMs: () => number;
}

export function createKernel(registry: Registry, serviceName = "udp-connectors"): Kernel {
  const env = createEnv();
  const log = createLog(serviceName, env.get("LOG_LEVEL"));
  const limiter = createRateLimiter(log.child("rate-limit"));

  return {
    log,
    env,
    limiter,
    fetch: createFetcher(log.child("fetch"), limiter, env.get("UDP_USER_AGENT")),
    orionUrl: env.get("ORION_URL") ?? DEFAULT_ORION_URL,
    signatures: new SignatureStore(),
    geo: createSharedGeo(log.child("geo")),
    registry,
    publicHttp: createHttpServer(log.child("http")),
    adminHttp: createHttpServer(log.child("admin")),
    scheduler: createScheduler(log.child("scheduler")),
    db: createDb(env),
    shutdown: new AbortController(),
    nowMs: Date.now,
  };
}

/**
 * The clock lives here and nowhere else in a connector: `run` reads it once and
 * hands the value to `build`, which is what keeps `build` diffable against the
 * old function node on a recorded fixture.
 */
function nowIso(): IsoTime {
  return new Date().toISOString();
}

export function createCtx(kernel: Kernel, entry: RegistryEntry): Ctx {
  const log = kernel.log.child(entry.id);
  const signatures = kernel.signatures.scope(entry.id);
  const gate = createChangeGate(signatures, log, kernel.nowMs);
  const orion = createOrion(log, kernel.fetch, gate, signatures, kernel.orionUrl);
  const masterData = new MasterDataCheck();
  return {
    id: entry.id,
    entry,
    log,
    env: kernel.env,
    fetch: kernel.fetch,
    limiter: kernel.limiter,
    orion,
    gate,
    geo: kernel.geo.view(log, masterData),
    prune: createPruner({
      log,
      orion,
      signatures,
      geo: kernel.geo,
      masterData,
      defaultIntervalMs: intervalMsOf(entry),
      nowMs: kernel.nowMs,
    }),
    db: kernel.db,
    params: entry.params,
    enabledFor: entry.enabledFor,
    now: nowIso,
    intervalMs: (runs?: number): number => intervalMsOf(entry, runs),
    signal: kernel.shutdown.signal,
  };
}
