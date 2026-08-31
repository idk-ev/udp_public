/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Assembles the kernel and, from it, one {@link Ctx} per connector.
 *
 * The services below are shared deliberately. The rate limiter has to be, or it
 * would not know how hard a host is being hit in total; the geo store has to be,
 * because `stammdaten-bw` fills what twenty other connectors read; the change
 * gate has to be, because its keys are namespaced per connector anyway. Only the
 * logger is per connector — its component name is what
 * `scripts/healthcheck.sh` groups warnings by.
 */

import { createChangeGate } from "./change-gate.js";
import { createEnv } from "./env.js";
import { createFetcher } from "./fetcher.js";
import { createGeoStore } from "./geo.js";
import { createHttpServer } from "./http.js";
import type { HttpServer } from "./http.js";
import { createLog } from "./log.js";
import { createOrion, DEFAULT_ORION_URL } from "./orion.js";
import { createRateLimiter } from "./rate-limit.js";
import { createScheduler } from "./scheduler.js";
import type {
  ChangeGate,
  Ctx,
  Env,
  Fetcher,
  GeoStore,
  IsoTime,
  Log,
  Orion,
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
  readonly orion: Orion;
  readonly gate: ChangeGate;
  readonly geo: GeoStore;
  readonly registry: Registry;
  readonly http: HttpServer;
  readonly scheduler: Scheduler;
  /** Aborted on SIGTERM/SIGINT; handed to every connector as `ctx.signal`. */
  readonly shutdown: AbortController;
}

export function createKernel(registry: Registry, serviceName = "udp-connectors"): Kernel {
  const env = createEnv();
  const log = createLog(serviceName, env.get("LOG_LEVEL"));
  const limiter = createRateLimiter(log.child("rate-limit"));
  const fetcher = createFetcher(log.child("fetch"), limiter, env.get("UDP_USER_AGENT"));
  const orion = createOrion(log.child("orion"), fetcher, env.get("ORION_URL") ?? DEFAULT_ORION_URL);

  return {
    log,
    env,
    limiter,
    fetch: fetcher,
    orion,
    gate: createChangeGate(log.child("change-gate")),
    geo: createGeoStore(log.child("geo")),
    registry,
    http: createHttpServer(log.child("http")),
    scheduler: createScheduler(log.child("scheduler")),
    shutdown: new AbortController(),
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
  return {
    id: entry.id,
    entry,
    log: kernel.log.child(entry.id),
    env: kernel.env,
    fetch: kernel.fetch,
    limiter: kernel.limiter,
    orion: kernel.orion,
    gate: kernel.gate,
    geo: kernel.geo,
    params: entry.params,
    enabledFor: entry.enabledFor,
    now: nowIso,
    signal: kernel.shutdown.signal,
  };
}
