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
 * flow context of the connector's own function nodes, and `ctx.state` — one
 * per connector id from the shared {@link StateStore}, so the ctx a route is
 * built with and the one `run` gets hold the same values.
 *
 * Signatures, prune bookkeeping and persisted state keys are persisted per
 * connector by the kernel's {@link Persistence} (src/kernel/persistence.ts);
 * the Orion client of a ctx is guarded by it, and every scheduled run goes
 * through {@link runConnector}, which loads the state first.
 *
 * Computed here from the registry: `ctx.rowBudget`, the budgets of all
 * entries summed per type (`ROW_BUDGET` of the generator).
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
import { Persistence } from "./persistence.js";
import { createPgStateBackend } from "./persistence-pg.js";
import { createPruner, PruneBookkeeping } from "./prune.js";
import { createRateLimiter } from "./rate-limit.js";
import { intervalMsOf, sumRowBudgets } from "./registry.js";
import { createScheduler } from "./scheduler.js";
import { StateStore, StateUnavailableError } from "./state.js";
import type {
  ConnectorRunner,
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
  /** `ctx.state` of every connector, one scope per id. */
  readonly state: StateStore;
  /**
   * Persists signatures, prune bookkeeping and persisted state keys in
   * PostgreSQL. Missing (test kernels): everything stays in memory.
   */
  readonly persistence?: Persistence | undefined;
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
    state: new StateStore(),
    persistence: new Persistence(createPgStateBackend(env, log.child("state")), log.child("state")),
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
  const persisted = kernel.persistence?.connector(entry.id, {
    log,
    signatures: kernel.signatures,
    state: kernel.state,
  });
  const plainOrion = createOrion(log, kernel.fetch, gate, signatures, kernel.orionUrl);
  const orion = persisted === undefined ? plainOrion : persisted.guard(plainOrion, gate);
  const bookkeeping = persisted?.bookkeeping ?? new PruneBookkeeping(new MasterDataCheck());
  const masterData = bookkeeping.masterData;
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
      bookkeeping,
      store: persisted,
    }),
    db: kernel.db,
    params: entry.params,
    enabledFor: entry.enabledFor,
    state: kernel.state.scope(entry.id),
    rowBudget: sumRowBudgets(kernel.registry.entries),
    now: nowIso,
    intervalMs: (runs?: number): number => intervalMsOf(entry, runs),
    signal: kernel.shutdown.signal,
  };
}

/**
 * One scheduled (or triggered) run: load the connector's persisted state,
 * run, write what changed.
 *
 * A connector whose state cannot be loaded is not run at all once it is
 * known to need it (it used the gate or a persisted state key before); a
 * connector the process has not seen yet runs until it first touches its
 * state, which then throws {@link StateUnavailableError}. Either way the run
 * ends with one `[warn]` under the connector's name and is retried on the next
 * schedule — running on empty tables would write every gated entity in full.
 * Connectors that never touch their state run regardless.
 */
export async function runConnector(kernel: Kernel, ctx: Ctx, runner: ConnectorRunner): Promise<void> {
  const persistence = kernel.persistence;
  if (persistence !== undefined) {
    const ready = await persistence.prepare(ctx.id);
    const reason = persistence.connectorReason(ctx.id);
    if (!ready && persistence.needsState(ctx.id)) {
      ctx.log.warn(`run skipped, state store not usable (${reason}) — retried on the next run`);
      return;
    }
  }
  try {
    await runner.run(ctx);
  } catch (error) {
    if (!(error instanceof StateUnavailableError)) throw error;
    ctx.log.warn(`run skipped, ${error.message} — retried on the next run`);
  } finally {
    // Also after a failed run: what the broker confirmed is committed.
    if (persistence !== undefined) await persistence.flush(ctx.id);
  }
}
