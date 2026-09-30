/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * A complete `Ctx` for running a ported connector's `run()` in a test.
 *
 * Built from the real kernel services (change gate, Orion client, geo view,
 * pruner, rate limiter) — only the process edges are scripted: the logger
 * records, Orion answers through {@link scriptedFetcher}, the database is a
 * {@link scriptedDb} or anything else implementing `Db`, and the environment
 * is a plain record. The registry entry is the real one from
 * platform/config/connectors.json.
 */

import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import { isArray } from "../../src/kernel/parse.js";
import { createSharedGeo, MasterDataCheck } from "../../src/kernel/geo.js";
import { createOrion } from "../../src/kernel/orion.js";
import { createPruner } from "../../src/kernel/prune.js";
import { createRateLimiter } from "../../src/kernel/rate-limit.js";
import { intervalMsOf, loadRegistry, resolveRegistryPath, sumRowBudgets } from "../../src/kernel/registry.js";
import { createConnectorState } from "../../src/kernel/state.js";
import type { Ctx, Db, Env, HttpResponse, IsoTime, RegistryEntry } from "../../src/kernel/types.js";
import { httpResponse, recordingLog, scriptedFetcher } from "./kernel.js";
import type { RecordedLog, SeenRequest } from "./kernel.js";

export const TEST_ORION_URL = "http://orion.test:1026";

/** An `Env` over a record; an empty value counts as unset, as in src/kernel/env.ts. */
export function recordEnv(values: Readonly<Record<string, string>> = {}): Env {
  const get = (name: string): string | undefined => {
    const value = values[name];
    return value === undefined || value === "" ? undefined : value;
  };
  return {
    get,
    require: (name) => {
      const value = get(name);
      if (value === undefined) throw new Error(`environment variable ${name} is not set`);
      return value;
    },
    number: (name, fallback) => {
      const parsed = Number(get(name));
      return get(name) === undefined || !Number.isFinite(parsed) ? fallback : parsed;
    },
    flag: (name, fallback) => {
      const value = get(name);
      return value === undefined ? fallback : value === "1" || value === "true";
    },
  };
}

/** The real registry entry of `id`. */
export function registryEntry(id: string): RegistryEntry {
  const entry = loadRegistry(resolveRegistryPath()).byId(id);
  if (entry === undefined) throw new Error(`no registry entry "${id}"`);
  return entry;
}

/** A database that must not be touched. */
const NO_DB: Db = {
  session: () => Promise.reject(new Error("this connector must not open a database session")),
};

export interface TestCtxOptions {
  readonly id: string;
  readonly db?: Db;
  readonly env?: Readonly<Record<string, string>>;
  /** Orion's answer; default 204 for everything. */
  readonly orion?: (request: SeenRequest) => HttpResponse | Error;
  readonly now?: IsoTime;
}

export interface TestCtx {
  readonly ctx: Ctx;
  readonly log: RecordedLog;
  /** Requests that reached the scripted Orion. */
  readonly seen: SeenRequest[];
}

export function testCtx(options: TestCtxOptions): TestCtx {
  const entry = registryEntry(options.id);
  const log = recordingLog();
  const signatures = new SignatureStore().scope(entry.id);
  const gate = createChangeGate(signatures, log);
  const { fetcher, seen } = scriptedFetcher(options.orion ?? (() => httpResponse(204)));
  const orion = createOrion(log, fetcher, gate, signatures, TEST_ORION_URL);
  const geo = createSharedGeo(log);
  const masterData = new MasterDataCheck();
  const now = options.now;
  const ctx: Ctx = {
    id: entry.id,
    entry,
    log,
    env: recordEnv(options.env),
    fetch: fetcher,
    limiter: createRateLimiter(log),
    orion,
    gate,
    geo: geo.view(log, masterData),
    prune: createPruner({
      log,
      orion,
      signatures,
      geo,
      masterData,
      defaultIntervalMs: intervalMsOf(entry),
      nowMs: Date.now,
    }),
    db: options.db ?? NO_DB,
    params: entry.params,
    enabledFor: entry.enabledFor,
    state: createConnectorState(),
    // What src/kernel/context.ts computes: the budgets of the whole registry.
    rowBudget: sumRowBudgets(loadRegistry(resolveRegistryPath()).entries),
    now: () => now ?? new Date().toISOString(),
    intervalMs: (runs?: number) => intervalMsOf(entry, runs),
    signal: new AbortController().signal,
  };
  return { ctx, log, seen };
}

/** The entities of every upsert that reached the scripted Orion, in order. */
export function upsertedEntities(seen: readonly SeenRequest[]): unknown[] {
  const entities: unknown[] = [];
  for (const request of seen) {
    if (request.method !== "POST" || !request.url.pathname.endsWith("/entityOperations/upsert")) continue;
    const body: unknown = JSON.parse(request.body ?? "[]");
    if (isArray(body)) entities.push(...body);
  }
  return entities;
}
