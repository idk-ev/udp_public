/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Test rig of group C (water & warnings): a real {@link Ctx} from the real
 * kernel services, with only the process edges replaced — the network by a
 * scripted fetcher, the rate limiter by a pass-through (the pacing is not what
 * these tests pin, and a 1/s bucket would make them take minutes), the clock of
 * the gate and the prune by a settable one.
 *
 * Plus the helpers the gated connectors share in their parity tests: reading
 * the old node's chunk messages, and the geo context of the fixtures.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseBoundaries } from "../../src/connectors/grenzen-bw.js";
import { parse as parseMunicipalities } from "../../src/connectors/stammdaten-bw.js";
import { isArray } from "../../src/kernel/parse.js";
import { SignatureStore } from "../../src/kernel/change-gate.js";
import { StateStore } from "../../src/kernel/state.js";
import type { Kernel } from "../../src/kernel/context.js";
import { createCtx } from "../../src/kernel/context.js";
import { createDb } from "../../src/kernel/db.js";
import { createEnv } from "../../src/kernel/env.js";
import { createSharedGeo } from "../../src/kernel/geo.js";
import type { SharedGeo } from "../../src/kernel/geo.js";
import { createHttpServer } from "../../src/kernel/http.js";
import { createRegistry, parseRegistry } from "../../src/kernel/registry.js";
import { createScheduler } from "../../src/kernel/scheduler.js";
import type {
  BoundarySet,
  Ctx,
  HttpResponse,
  MunicipalityRow,
  RateLimiter,
  RegistryEntry,
} from "../../src/kernel/types.js";
import { readFixture, repositoryRoot } from "./fixtures.js";
import { recordingLog, scriptedFetcher } from "./kernel.js";
import type { RecordedLog, SeenRequest } from "./kernel.js";
import { isRecord } from "./normalize.js";
import type { FunctionNodeRun } from "./vm-runner.js";
import { messagesOf } from "./vm-runner.js";

/** Grants every token at once. */
export const passThroughLimiter: RateLimiter = {
  acquire: () => Promise.resolve(() => undefined),
  run: (_host, task) => task(),
  pause: () => undefined,
};

export interface Rig {
  readonly ctx: Ctx;
  readonly log: RecordedLog;
  readonly seen: SeenRequest[];
  readonly signatures: SignatureStore;
  readonly geo: SharedGeo;
  readonly clock: { now: number };
}

/** The connector's own entry of platform/config/connectors.json. */
export function registryEntry(id: string): RegistryEntry {
  const file = join(repositoryRoot(), "platform", "config", "connectors.json");
  const entries = parseRegistry(JSON.parse(readFileSync(file, "utf8")));
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no registry entry "${id}"`);
  return entry;
}

/** Where {@link Rig.clock} starts. Times in test data belong on this clock, not on `Date.now()`. */
export const RIG_START_MS = Date.parse("2026-09-28T06:00:00Z");

export function rig(id: string, respond: (request: SeenRequest) => HttpResponse | Error): Rig {
  const log = recordingLog();
  const { fetcher, seen } = scriptedFetcher(respond);
  const clock = { now: RIG_START_MS };
  const env = createEnv();
  const entry = registryEntry(id);
  const signatures = new SignatureStore();
  const geo = createSharedGeo(log);
  const kernel: Kernel = {
    log,
    env,
    limiter: passThroughLimiter,
    fetch: fetcher,
    orionUrl: "http://orion-ld:1026",
    signatures,
    state: new StateStore(),
    geo,
    registry: createRegistry([entry]),
    publicHttp: createHttpServer(log),
    adminHttp: createHttpServer(log),
    scheduler: createScheduler(log, () => clock.now),
    db: createDb(env),
    shutdown: new AbortController(),
    nowMs: () => clock.now,
  };
  return { ctx: createCtx(kernel, entry), log, seen, signatures, geo, clock };
}

/* ── geo context of the fixtures ─────────────────────────────────────────────*/

export interface FixtureGeo {
  /** As the old nodes read them: `global.bwGemeinden`, `global.bwGrenzen`. */
  readonly rawRows: unknown;
  readonly rawBoundaries: unknown;
  readonly rows: readonly MunicipalityRow[];
  readonly boundaries: BoundarySet;
}

/** The trimmed geo fixtures (167 municipalities along the Upper Rhine and a few more). */
export function fixtureGeo(): FixtureGeo {
  const municipalities = readFixture("stammdaten-bw").payload;
  const rawBoundaries = readFixture("grenzen-bw").payload;
  return {
    rawRows: isRecord(municipalities) ? municipalities.gemeinden : undefined,
    rawBoundaries,
    rows: parseMunicipalities(municipalities).gemeinden,
    boundaries: parseBoundaries(rawBoundaries).boundaries,
  };
}

/** The full files the cockpit serves (gui/public), for the tests that need PRUNE_OK. */
export function fullGeo(): FixtureGeo {
  const root = repositoryRoot();
  const municipalities: unknown = JSON.parse(
    readFileSync(join(root, "gui", "public", "bw-gemeinden.json"), "utf8"),
  );
  const rawBoundaries: unknown = JSON.parse(
    readFileSync(join(root, "gui", "public", "bw-grenzen.json"), "utf8"),
  );
  return {
    rawRows: isRecord(municipalities) ? municipalities.gemeinden : undefined,
    rawBoundaries,
    rows: parseMunicipalities(municipalities).gemeinden,
    boundaries: parseBoundaries(rawBoundaries).boundaries,
  };
}

/* ── the old node's output ───────────────────────────────────────────────────*/

function arrayField(message: unknown, key: string): unknown[] {
  if (!isRecord(message)) return [];
  const value = message[key];
  return Array.isArray(value) ? value : [];
}

export interface LegacyChunks {
  readonly messages: unknown[];
  /** All entities of all chunk messages, in order. */
  readonly entities: unknown[];
  /** All `sigCommit` entries, in order. */
  readonly pending: unknown[];
  readonly sizes: number[];
}

/** What an old chunking node (`emitChunks`) sent towards the upsert. */
export function legacyChunks(run: FunctionNodeRun): LegacyChunks {
  const messages = messagesOf(run);
  return {
    messages,
    entities: messages.flatMap((message) => arrayField(message, "payload")),
    pending: messages.flatMap((message) => arrayField(message, "sigCommit")),
    sizes: messages.map((message) => arrayField(message, "payload").length),
  };
}

/** Upsert request bodies the rig's Orion saw, parsed. */
export function upsertBodies(seen: readonly SeenRequest[]): unknown[][] {
  return seen
    .filter(
      (request) => request.method === "POST" && request.url.pathname.endsWith("/entityOperations/upsert"),
    )
    .map((request) => {
      const parsed: unknown = JSON.parse(request.body ?? "[]");
      return isArray(parsed) ? [...parsed] : [];
    });
}

/** Delete request bodies the rig's Orion saw, parsed. */
export function deleteBodies(seen: readonly SeenRequest[]): unknown[][] {
  return seen
    .filter(
      (request) => request.method === "POST" && request.url.pathname.endsWith("/entityOperations/delete"),
    )
    .map((request) => {
      const parsed: unknown = JSON.parse(request.body ?? "[]");
      return isArray(parsed) ? [...parsed] : [];
    });
}
