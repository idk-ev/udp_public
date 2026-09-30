/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Test kernel for the parity tests of group F (air & energy): a real `Ctx`
 * over a scripted network, a scripted Orion broker both runtimes can talk to,
 * and the geo context out of the fixtures.
 *
 * As in test/harness/kernel.ts, only the process edges are replaced — the
 * change gate, the Orion client, the geo view and the pruner are the kernel's
 * own. `run(ctx)` of a ported module therefore goes through exactly the code
 * the service runs, and the old function node, given the same broker through
 * a fake `node:http`, can be compared against it request for request.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseBoundaries } from "../../src/connectors/grenzen-bw.js";
import { parse as parseMunicipalities } from "../../src/connectors/stammdaten-bw.js";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import type { SignatureScope } from "../../src/kernel/change-gate.js";
import { createEnv } from "../../src/kernel/env.js";
import { createSharedGeo, MasterDataCheck } from "../../src/kernel/geo.js";
import type { SharedGeo } from "../../src/kernel/geo.js";
import { createOrion } from "../../src/kernel/orion.js";
import { createPruner } from "../../src/kernel/prune.js";
import { intervalMsOf, loadRegistry, sumRowBudgets } from "../../src/kernel/registry.js";
import { memoryQuota } from "../../src/kernel/quota.js";
import { createConnectorState } from "../../src/kernel/state.js";
import type { Ctx, HttpResponse, RateLimiter, RegistryEntry } from "../../src/kernel/types.js";
import { readFixture, repositoryRoot } from "./fixtures.js";
import { httpResponse, recordingLog, scriptedFetcher } from "./kernel.js";
import type { RecordedLog, SeenRequest } from "./kernel.js";
import { isRecord } from "./normalize.js";
import { messagesOf } from "./vm-runner.js";
import type { FunctionNodeRun } from "./vm-runner.js";

/* ── geo ─────────────────────────────────────────────────────────────────────*/

/** Raw master data and boundaries as the old nodes find them in `global`. */
export interface RawGeo {
  readonly municipalities: unknown;
  readonly boundaries: unknown;
}

/** The trimmed geo fixtures (167 municipalities of the Upper Rhine strip plus four). */
export function fixtureGeo(): RawGeo {
  const rows = readFixture("stammdaten-bw").payload;
  return {
    municipalities: isRecord(rows) ? rows.gemeinden : undefined,
    boundaries: readFixture("grenzen-bw").payload,
  };
}

/**
 * The full files the cockpit serves (1,103 municipalities) — for the prune
 * paths, which need plausible master data (at least 1,000 municipalities).
 */
export function fullGeo(): RawGeo {
  const root = repositoryRoot();
  const rows: unknown = JSON.parse(readFileSync(join(root, "gui", "public", "bw-gemeinden.json"), "utf8"));
  const boundaries: unknown = JSON.parse(
    readFileSync(join(root, "gui", "public", "bw-grenzen.json"), "utf8"),
  );
  return { municipalities: isRecord(rows) ? rows.gemeinden : undefined, boundaries };
}

/** A shared geo context filled from raw data; `boundaries: false` leaves the cache empty. */
export function sharedGeo(raw: RawGeo, options: { readonly boundaries?: boolean } = {}): SharedGeo {
  const geo = createSharedGeo(recordingLog());
  geo.setMunicipalities(parseMunicipalities({ gemeinden: raw.municipalities }).gemeinden);
  if (options.boundaries !== false) {
    const file = parseBoundaries(raw.boundaries);
    geo.setBoundaries(file.boundaries, file.skipped);
  }
  return geo;
}

/** `global` of the old nodes for the same geo context. */
export function legacyGlobal(
  raw: RawGeo,
  options: { readonly boundaries?: boolean } = {},
): Record<string, unknown> {
  return options.boundaries === false
    ? { bwGemeinden: raw.municipalities }
    : { bwGemeinden: raw.municipalities, bwGrenzen: raw.boundaries };
}

/* ── ctx ─────────────────────────────────────────────────────────────────────*/

const NO_LIMIT: RateLimiter = {
  acquire: () => Promise.resolve(() => undefined),
  run: (_host, task) => task(),
  pause: () => undefined,
};

export interface TestCtx {
  readonly ctx: Ctx;
  readonly log: RecordedLog;
  readonly seen: SeenRequest[];
  readonly signatures: SignatureScope;
}

function registryPath(): string {
  return join(repositoryRoot(), "platform", "config", "connectors.json");
}

export function registryEntry(id: string): RegistryEntry {
  const entry = loadRegistry(registryPath()).byId(id);
  if (entry === undefined) throw new Error(`registry has no entry "${id}"`);
  return entry;
}

/**
 * A `Ctx` as src/kernel/context.ts assembles it, over `respond` instead of the
 * network and without pacing (a scripted source answers at once).
 */
export function testCtx(
  id: string,
  geo: SharedGeo,
  respond: (request: SeenRequest) => HttpResponse | Error,
  options: { readonly nowMs?: () => number; readonly store?: SignatureStore } = {},
): TestCtx {
  const entry = registryEntry(id);
  const log = recordingLog();
  const nowMs = options.nowMs ?? Date.now;
  const signatures = (options.store ?? new SignatureStore()).scope(id);
  const { fetcher, seen } = scriptedFetcher(respond);
  const gate = createChangeGate(signatures, log, nowMs);
  const orion = createOrion(log, fetcher, gate, signatures);
  const masterData = new MasterDataCheck();
  const ctx: Ctx = {
    id,
    entry,
    log,
    env: createEnv(),
    fetch: fetcher,
    limiter: NO_LIMIT,
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
      nowMs,
    }),
    db: { session: () => Promise.reject(new Error("no database in the parity tests")) },
    params: entry.params,
    enabledFor: entry.enabledFor,
    state: createConnectorState(),
    quota: memoryQuota(entry.id),
    rowBudget: sumRowBudgets(loadRegistry(registryPath()).entries),
    now: () => new Date(nowMs()).toISOString(),
    intervalMs: (runs?: number) => intervalMsOf(entry, runs),
    signal: new AbortController().signal,
  };
  return { ctx, log, seen, signatures };
}

/* ── the scripted broker ─────────────────────────────────────────────────────*/

type Entity = Record<string, unknown>;

/**
 * Orion-LD as far as these connectors use it: listing with `type`,
 * `idPattern` (ignored for a prune's listing, see there), `count`,
 * `limit`/`offset`; batch upsert (`options=update`
 * merges the attributes sent); batch delete. Entities are returned as stored —
 * keyValues-shaped for the listings the pulse reads, normalised for what a
 * connector upserted.
 */
export class Broker {
  readonly entities = new Map<string, Entity>();
  /** Every upsert body, in order. */
  readonly upserts: unknown[][] = [];
  readonly deletes: string[][] = [];
  /** What Orion reports as the number of Municipality entities (seed of the prune ratchet). */
  municipalityCount = 1103;
  /** Replaces the answer of a listing of this type (e.g. an HTTP 503 or a short count). */
  readonly listAnswer = new Map<string, (request: SeenRequest) => HttpResponse | undefined>();

  constructor(entities: Iterable<Entity> = []) {
    for (const entity of entities) this.add(entity);
  }

  add(entity: Entity): void {
    const id = entity.id;
    if (typeof id !== "string") throw new Error("broker: entity without id");
    this.entities.set(id, structuredClone(entity));
  }

  /** An independent copy — one broker per runtime, the same content. */
  clone(): Broker {
    const copy = new Broker(this.entities.values());
    copy.municipalityCount = this.municipalityCount;
    for (const [type, answer] of this.listAnswer) copy.listAnswer.set(type, answer);
    return copy;
  }

  readonly respond = (request: SeenRequest): HttpResponse | Error => {
    const path = request.url.pathname;
    if (request.method === "GET" && path === "/ngsi-ld/v1/entities") return this.#list(request);
    if (request.method === "POST" && path === "/ngsi-ld/v1/entityOperations/upsert") {
      const body: unknown = JSON.parse(request.body ?? "[]");
      const list = Array.isArray(body) ? body : [];
      this.upserts.push(list);
      for (const entity of list) {
        if (!isRecord(entity) || typeof entity.id !== "string") continue;
        this.entities.set(entity.id, { ...(this.entities.get(entity.id) ?? {}), ...entity });
      }
      return httpResponse(204);
    }
    if (request.method === "POST" && path === "/ngsi-ld/v1/entityOperations/delete") {
      const body: unknown = JSON.parse(request.body ?? "[]");
      const ids = Array.isArray(body) ? body.filter((id): id is string => typeof id === "string") : [];
      this.deletes.push(ids);
      for (const id of ids) this.entities.delete(id);
      return httpResponse(204);
    }
    return httpResponse(404, `broker: no route for ${request.method} ${path}`);
  };

  #list(request: SeenRequest): HttpResponse {
    const params = request.url.searchParams;
    const type = params.get("type") ?? "";
    if (type === "Municipality") {
      return httpResponse(200, "[]", { "ngsild-results-count": String(this.municipalityCount) });
    }
    const override = this.listAnswer.get(type)?.(request);
    if (override !== undefined) return override;
    // A prune's listing (`options=sysAttrs`) gets every entity of the type,
    // idPattern IGNORED as by the other test brokers: the local re-check of
    // the kernel (and of the old PRUNE_HELPER) is then what keeps a foreign id
    // from being deleted. The city pulse's input listings are filtered as
    // Orion does — it scores what the broker returns.
    const pattern = params.get("options") === "sysAttrs" ? null : params.get("idPattern");
    const matcher = pattern === null ? null : new RegExp(pattern);
    const all = [...this.entities.values()].filter(
      (entity) => entity.type === type && (matcher === null || matcher.test(String(entity.id))),
    );
    const offset = Number(params.get("offset") ?? "0");
    const limit = Number(params.get("limit") ?? "1000");
    return httpResponse(200, JSON.stringify(all.slice(offset, offset + limit)), {
      "ngsild-results-count": String(all.length),
    });
  }

  /** The listing requests seen, as decoded parameter lists (for comparing both runtimes). */
  static listings(seen: readonly SeenRequest[]): string[][][] {
    return seen
      .filter(
        (request) => request.method === "GET" && request.url.searchParams.get("type") !== "Municipality",
      )
      .map((request) => [...request.url.searchParams.entries()]);
  }
}

/* ── the old side ────────────────────────────────────────────────────────────*/

function arrayField(message: unknown, key: string): unknown[] {
  if (!isRecord(message)) return [];
  const value = message[key];
  return Array.isArray(value) ? value : [];
}

/** All entities the old node emitted, over all its chunk messages. */
export function legacyEntities(run: FunctionNodeRun): unknown[] {
  return messagesOf(run).flatMap((message) => arrayField(message, "payload"));
}

/** All pending signatures (`sigCommit`) the old node emitted. */
export function legacyPending(run: FunctionNodeRun): unknown[] {
  return messagesOf(run).flatMap((message) => arrayField(message, "sigCommit"));
}

/** Entities per emitted chunk — the chunking both runtimes must agree on. */
export function legacyChunkSizes(run: FunctionNodeRun): number[] {
  return messagesOf(run).map((message) => arrayField(message, "payload").length);
}

/** The flow context of a run, to hand to the next one. */
export function flowOf(run: FunctionNodeRun): Record<string, unknown> {
  return Object.fromEntries(run.flow);
}
