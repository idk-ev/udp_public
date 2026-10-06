/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Test helpers of group E (mobility: `parken-bw`, `sharing-bw`,
 * `carsharing-bw`, `ladesaeulen-bw`).
 *
 * Three pieces, all built from the real kernel with only the process edges
 * replaced (see test/harness/kernel.ts for why nothing inside is mocked):
 *
 *  * {@link fullGeo} — the complete master data and boundary files the cockpit
 *    serves (gui/public), once as the raw JSON the old nodes read from the
 *    global context and once as the kernel's `GeoIndex`. The mobility sources
 *    are statewide and border-heavy (Basel, Kreuzlingen, Neu-Ulm), so a
 *    trimmed geo fixture would decide the outcome instead of the code.
 *  * {@link Broker} — one scripted endpoint for sources AND Orion-LD. The old
 *    function nodes reach it through `fakeHttpModule` (as `http` and
 *    `https`), the ports through `scriptedFetcher`; both see the same state.
 *  * {@link mobilityCtx} — a complete `Ctx` over that broker, with a clock the
 *    test moves, so the prune's interval and confirmation guards can be run
 *    through several runs in milliseconds.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseBoundaries } from "../../src/connectors/grenzen-bw.js";
import { exclusionOf } from "../../src/connectors/gbfs.js";
import { parse as parseMunicipalities } from "../../src/connectors/stammdaten-bw.js";
import { createChangeGate, SignatureStore } from "../../src/kernel/change-gate.js";
import type { SignatureScope } from "../../src/kernel/change-gate.js";
import { createGeoIndex, createSharedGeo, MasterDataCheck } from "../../src/kernel/geo.js";
import { isArray } from "../../src/kernel/parse.js";
import { createOrion } from "../../src/kernel/orion.js";
import { createPruner } from "../../src/kernel/prune.js";
import { needsRefresh } from "../../src/kernel/split-gate.js";
import { createRateLimiter } from "../../src/kernel/rate-limit.js";
import { intervalMsOf, loadRegistry, sumRowBudgets } from "../../src/kernel/registry.js";
import { memoryQuota } from "../../src/kernel/quota.js";
import { createConnectorState } from "../../src/kernel/state.js";
import type {
  BoundarySet,
  Ctx,
  Env,
  GeoIndex,
  HttpResponse,
  MunicipalityRow,
  PruneOptions,
  PruneResult,
  Pruner,
  RegistryEntry,
} from "../../src/kernel/types.js";
import { repositoryRoot } from "./fixtures.js";
import { httpResponse, recordingLog, scriptedFetcher } from "./kernel.js";
import type { RecordedLog, SeenRequest } from "./kernel.js";
import { isRecord } from "./normalize.js";

export const ORION = "http://orion-ld:1026";
export const HOUR = 3_600_000;

/* ------------------------------------------------------------------ geo */

export interface FullGeo {
  /** `global.bwGemeinden` of the old nodes: the rows as the file has them. */
  readonly rowsRaw: unknown;
  /** `global.bwGrenzen`: the boundary file as parsed JSON. */
  readonly boundariesRaw: unknown;
  readonly municipalities: readonly MunicipalityRow[];
  readonly boundaries: BoundarySet;
  readonly index: GeoIndex;
}

let cachedGeo: FullGeo | undefined;

export function fullGeo(): FullGeo {
  if (cachedGeo !== undefined) return cachedGeo;
  const root = join(repositoryRoot(), "gui", "public");
  const file: unknown = JSON.parse(readFileSync(join(root, "bw-gemeinden.json"), "utf8"));
  const boundariesRaw: unknown = JSON.parse(readFileSync(join(root, "bw-grenzen.json"), "utf8"));
  const municipalities = parseMunicipalities(file).gemeinden;
  const boundaries = parseBoundaries(boundariesRaw).boundaries;
  cachedGeo = {
    rowsRaw: isRecord(file) ? file.gemeinden : undefined,
    boundariesRaw,
    municipalities,
    boundaries,
    index: createGeoIndex(municipalities, boundaries),
  };
  return cachedGeo;
}

/** The global context the old nodes read. */
export function legacyGlobal(geo: FullGeo, withBoundaries = true): Record<string, unknown> {
  return withBoundaries
    ? { bwGemeinden: geo.rowsRaw, bwGrenzen: geo.boundariesRaw }
    : { bwGemeinden: geo.rowsRaw };
}

/* ------------------------------------------------------------------ broker */

type Answer = HttpResponse | Error;

/**
 * Scripted sources plus a small Orion-LD: listing by type with offset paging
 * and `NGSILD-Results-Count`, batch upsert and batch delete. Like the prune
 * test's broker it IGNORES `idPattern` — the local re-check has to hold.
 */
export class Broker {
  readonly entities = new Map<string, Record<string, unknown>>();
  readonly requests: SeenRequest[] = [];
  /** Source answers by full URL; a function is asked per request. */
  readonly sources = new Map<string, Answer | ((request: SeenRequest) => Answer)>();
  /** Bodies of the upserts, one per request. */
  readonly upserts: unknown[][] = [];
  /** Id lists of the deletes, one per request. */
  readonly deletes: string[][] = [];
  municipalityCount: number;
  upsertAnswer: (entities: readonly unknown[]) => HttpResponse = () => httpResponse(204);
  /** Answer of a batch delete; the entities go only on a 2xx other than 207. */
  deleteAnswer: (ids: readonly string[]) => HttpResponse = () => httpResponse(204);

  constructor(municipalityCount: number) {
    this.municipalityCount = municipalityCount;
  }

  /** Orion requests except the municipality count of the prune's seed. */
  orionRequests(): SeenRequest[] {
    return this.requests.filter(
      (request) => request.url.origin === ORION && request.url.searchParams.get("type") !== "Municipality",
    );
  }

  /**
   * Targets of the prune listings, in order — what a prune asked the broker.
   * A prune lists with `options=sysAttrs` (as the old pager did); the
   * seeding of empty signature tables does not, see {@link seedListings}.
   */
  listings(): string[] {
    return this.orionRequests()
      .filter((request) => request.method === "GET" && request.url.searchParams.get("options") === "sysAttrs")
      .map((request) => request.target);
  }

  /** Targets of the other listings: `Orion.seedSignatures`. */
  seedListings(): string[] {
    return this.orionRequests()
      .filter((request) => request.method === "GET" && request.url.searchParams.get("options") === null)
      .map((request) => request.target);
  }

  readonly respond = (request: SeenRequest): Answer => {
    this.requests.push(request);
    if (request.url.origin !== ORION) {
      const source = this.sources.get(request.url.href);
      if (source === undefined) return httpResponse(404, `no fixture for ${request.url.href}`);
      return typeof source === "function" ? source(request) : source;
    }
    const path = request.url.pathname;
    if (request.method === "GET" && path === "/ngsi-ld/v1/entities") {
      const type = request.url.searchParams.get("type");
      if (type === "Municipality") {
        return httpResponse(200, "[]", { "ngsild-results-count": String(this.municipalityCount) });
      }
      const all = [...this.entities.values()].filter((entity) => entity.type === type);
      const offset = Number(request.url.searchParams.get("offset") ?? "0");
      const limit = Number(request.url.searchParams.get("limit") ?? "1000");
      return httpResponse(200, JSON.stringify(all.slice(offset, offset + limit)), {
        "ngsild-results-count": String(all.length),
      });
    }
    if (request.method === "POST" && path === "/ngsi-ld/v1/entityOperations/upsert") {
      const parsed: unknown = JSON.parse(request.body ?? "[]");
      const list = Array.isArray(parsed) ? parsed : [];
      this.upserts.push(list);
      return this.upsertAnswer(list);
    }
    if (request.method === "POST" && path === "/ngsi-ld/v1/entityOperations/delete") {
      const parsed: unknown = JSON.parse(request.body ?? "[]");
      const ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
      this.deletes.push(ids);
      const answer = this.deleteAnswer(ids);
      if (answer.status >= 200 && answer.status < 300 && answer.status !== 207) {
        for (const id of ids) this.entities.delete(id);
      }
      return answer;
    }
    return httpResponse(404, `unexpected ${request.method} ${request.target}`);
  };

  /** Waits until no request arrived for a few rounds — for fire-and-forget prunes of the old nodes. */
  async idle(rounds = 4): Promise<void> {
    let quiet = 0;
    let seen = this.requests.length;
    while (quiet < rounds) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (this.requests.length === seen) quiet += 1;
      else {
        quiet = 0;
        seen = this.requests.length;
      }
    }
  }
}

/** A JSON source answer. */
export function jsonAnswer(payload: unknown, status = 200): HttpResponse {
  return httpResponse(status, JSON.stringify(payload), { "content-type": "application/json" });
}

/* ------------------------------------------------------------------ ctx */

export interface PruneCall {
  readonly kind: "stale" | "reset" | "remove";
  readonly key: string;
  readonly options?: PruneOptions;
  readonly result?: PruneResult;
  /** `remove`: the ids the broker confirmed as deleted. */
  readonly removed?: readonly string[];
}

export interface MobilityWorld {
  readonly ctx: Ctx;
  readonly log: RecordedLog;
  readonly store: SignatureScope;
  readonly broker: Broker;
  readonly clock: { now: number };
  /** Every `ctx.prune` call of the port, in order. */
  readonly pruneCalls: PruneCall[];
}

const NO_ENV: Env = {
  get: () => undefined,
  require: (name) => {
    throw new Error(`test env: ${name} is not set`);
  },
  number: (_name, fallback) => fallback,
  flag: (_name, fallback) => fallback,
};

let cachedEntries: ReadonlyMap<string, RegistryEntry> | undefined;

/** The real registry entry — interval, budgets and params as deployed. */
export function registryEntry(id: string): RegistryEntry {
  if (cachedEntries === undefined) {
    const registry = loadRegistry(join(repositoryRoot(), "platform", "config", "connectors.json"));
    cachedEntries = new Map(registry.entries.map((entry) => [entry.id, entry]));
  }
  const entry = cachedEntries.get(id);
  if (entry === undefined) throw new Error(`registry: no entry ${id}`);
  return entry;
}

/**
 * A GBFS system list without the systems the registry entry of `id` excludes
 * (`excludeSystems`, licence terms). Deliberate deviation of both GBFS ports:
 * the old list nodes saw every system; the parity tests hand them the list
 * the port actually works on, so the rest stays comparable.
 */
export function withoutExcludedSystems(id: string, payload: unknown): unknown {
  if (!isRecord(payload) || !isArray(payload.systems)) return payload;
  const rules = registryEntry(id).excludeSystems;
  return {
    ...payload,
    systems: payload.systems.filter(
      (system) =>
        !(isRecord(system) && typeof system.id === "string" && exclusionOf(system.id, rules) !== null),
    ),
  };
}

export interface WorldOptions {
  readonly id: string;
  readonly start: number;
  readonly geo?: FullGeo | null;
  readonly boundaries?: boolean;
}

/** A `Ctx` for `run` over the {@link Broker}, with the test's clock. */
export function mobilityCtx(options: WorldOptions): MobilityWorld {
  const entry = registryEntry(options.id);
  const clock = { now: options.start };
  const nowMs = (): number => clock.now;
  const log = recordingLog();
  const store = new SignatureStore().scope(options.id);
  const gate = createChangeGate(store, log, nowMs);
  const geo = options.geo === undefined ? fullGeo() : options.geo;
  const broker = new Broker(geo === null ? 0 : geo.municipalities.length);
  const { fetcher } = scriptedFetcher(broker.respond);
  const orion = createOrion(log, fetcher, gate, store, ORION);
  const shared = createSharedGeo(recordingLog());
  if (geo !== null) {
    shared.setMunicipalities(geo.municipalities);
    if (options.boundaries !== false) shared.setBoundaries(geo.boundaries, 0);
  }
  const masterData = new MasterDataCheck();
  const pruner = createPruner({
    log,
    orion,
    signatures: store,
    geo: shared,
    masterData,
    defaultIntervalMs: intervalMsOf(entry),
    nowMs,
  });
  const pruneCalls: PruneCall[] = [];
  const recording: Pruner = {
    masterDataPlausible: () => pruner.masterDataPlausible(),
    stale: async (pruneOptions) => {
      const result = await pruner.stale(pruneOptions);
      pruneCalls.push({ kind: "stale", key: pruneOptions.label, options: pruneOptions, result });
      return result;
    },
    resetConfirmations: (key) => {
      pruneCalls.push({ kind: "reset", key });
      pruner.resetConfirmations(key);
    },
    remove: async (removeOptions) => {
      const result = await pruner.remove(removeOptions);
      pruneCalls.push({ kind: "remove", key: removeOptions.label, removed: [...result.deleted] });
      return result;
    },
  };
  const ctx: Ctx = {
    id: options.id,
    entry,
    log,
    env: NO_ENV,
    fetch: fetcher,
    limiter: createRateLimiter(recordingLog()),
    orion,
    gate,
    geo: shared.view(log, masterData),
    prune: recording,
    db: { session: () => Promise.reject(new Error("no database in this test")) },
    params: entry.params,
    enabledFor: entry.enabledFor,
    state: createConnectorState(),
    quota: memoryQuota(entry.id),
    rowBudget: sumRowBudgets(
      loadRegistry(join(repositoryRoot(), "platform", "config", "connectors.json")).entries,
    ),
    now: () => new Date(clock.now).toISOString(),
    intervalMs: (runs) => intervalMsOf(entry, runs),
    signal: new AbortController().signal,
  };
  return { ctx, log, store, broker, clock, pruneCalls };
}

/* ------------------------------------------------------------------ old-node output */

export function arrayField(message: unknown, key: string): unknown[] {
  if (!isRecord(message)) return [];
  const value = message[key];
  return Array.isArray(value) ? value : [];
}

/** Flow context of a finished old run as a plain object, to hand to the next run. */
export function flowObject(flow: ReadonlyMap<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(flow);
}

/** A signature table of the port as a plain object, for comparison with the flow context. */
export function tableObject(store: SignatureScope, key: string): Record<string, unknown> {
  return Object.fromEntries(store.copy(key));
}

/** A flow-context table as a plain object (`undefined` and a missing key read as empty). */
export function flowTable(flow: ReadonlyMap<string, unknown>, key: string): Record<string, unknown> {
  const table = flow.get(key);
  return isRecord(table) ? { ...table } : {};
}

/** The measured values of a split gate's dynamic signature (a JSON array, src/kernel/split-gate.ts). */
export function liveValues(signature: unknown): readonly unknown[] {
  const parsed: unknown = JSON.parse(String(signature));
  return isArray(parsed) ? parsed : [];
}

/**
 * Without the entities whose weekly full write (src/kernel/split-gate.ts,
 * `needsRefresh`) falls into the hour of `nowMs`: the port sends those in
 * full by design, where the old nodes sent a stamp or nothing. Parity tests
 * with a wall clock compare the rest.
 */
export function withoutWeeklyRefresh(entities: readonly unknown[], nowMs: number): unknown[] {
  return entities.filter(
    (entity) => !(isRecord(entity) && typeof entity.id === "string" && needsRefresh(entity.id, nowMs)),
  );
}

/** The options of every `ctx.prune.stale` call of the port, in order. */
export function staleOptions(world: MobilityWorld): PruneOptions[] {
  return world.pruneCalls.flatMap((call) => (call.options === undefined ? [] : [call.options]));
}
