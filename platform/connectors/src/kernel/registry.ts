/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Reads platform/config/connectors.json — the single place of maintenance for
 * cadence, scope, activation and monitoring of all connectors.
 *
 * The file is **not** copied into this package; a static test
 * (tests/static/type-discipline.test.js, "Registry and service share the same
 * place of maintenance") fails if a second copy shows up here. As long as both
 * runtimes stand side by side, a second copy would let schedules and the set of
 * active connectors drift apart. In the image the file is mounted at
 * /app/config/connectors.json (see Dockerfile); in the checkout it is read
 * relative to this module.
 *
 * It is external JSON, so it is narrowed, never asserted. The guard below is
 * long-winded on purpose: every field the service acts on is checked once, here,
 * and everything downstream is typed. Fields the service does not read
 * (`nodePrefixes`, `supersededBy`, `sensorDetailFor`, `_doc`) are ignored rather
 * than rejected — the same file is read by the flow generator and exported to
 * the frontend and will keep carrying members this service does not care about.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  isAgs,
  isArray,
  isBoolean,
  isEntityId,
  isFiniteNumber,
  isRecord,
  isString,
  requireString,
} from "./parse.js";
import type {
  Ags,
  ConnectorId,
  ConnectorParams,
  ConnectorRuntime,
  EntityId,
  JsonValue,
  Registry,
  RegistryEntry,
} from "./types.js";

/** Env var pointing at the registry; set to /app/config/connectors.json in the image. */
export const REGISTRY_PATH_ENV = "UDP_CONNECTORS_REGISTRY";

/**
 * Candidate paths, in order — a short explicit list, not a search of the file
 * system. A registry found by accident would be worse than a clear failure: the
 * service would then schedule a foreign set of connectors against a
 * digest-pinned image.
 *
 *   1. `/app/config/connectors.json` — where the Dockerfile copies it.
 *   2. four levels up from the compiled module (dist/src/kernel/ → platform/).
 *   3. three levels up from the source module (src/kernel/ → platform/).
 */
function candidatePaths(): readonly string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    "/app/config/connectors.json",
    resolve(here, "..", "..", "..", "..", "config", "connectors.json"),
    resolve(here, "..", "..", "..", "config", "connectors.json"),
  ];
}

/** `UDP_CONNECTORS_REGISTRY` wins; otherwise the first candidate that exists. */
export function resolveRegistryPath(fromEnv?: string): string {
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const candidates = candidatePaths();
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`connector registry not found — set ${REGISTRY_PATH_ENV}; tried ${candidates.join(", ")}`);
}

/* ------------------------------------------------------------------ Guards */

function optionalString(raw: unknown, at: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (!isString(raw)) throw new Error(`${at}: expected string or null`);
  return raw;
}

function optionalNumber(raw: unknown, at: string): number | null {
  if (raw === undefined || raw === null) return null;
  if (!isFiniteNumber(raw)) throw new Error(`${at}: expected number or null`);
  return raw;
}

function optionalBoolean(raw: unknown, at: string): boolean | null {
  if (raw === undefined || raw === null) return null;
  if (!isBoolean(raw)) throw new Error(`${at}: expected boolean or null`);
  return raw;
}

function enabledFor(raw: unknown, at: string): "*" | readonly Ags[] | null {
  if (raw === undefined || raw === null) return null;
  if (raw === "*") return "*";
  if (!isArray(raw)) throw new Error(`${at}: expected "*", a list of AGS or null`);
  return raw.map((item, index) => {
    if (!isAgs(item)) throw new Error(`${at}[${String(index)}]: expected an 8-digit AGS`);
    return item;
  });
}

function stringList(raw: unknown, at: string): readonly string[] {
  if (raw === undefined || raw === null) return [];
  if (!isArray(raw)) throw new Error(`${at}: expected a list of strings`);
  return raw.map((item, index) => requireString(item, `${at}[${String(index)}]`));
}

function runtime(raw: unknown, at: string): ConnectorRuntime | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "nodered" || raw === "app") return raw;
  throw new Error(`${at}: expected "nodered" or "app"`);
}

function sampleEntity(raw: unknown, at: string): EntityId | null {
  if (raw === undefined || raw === null) return null;
  if (!isEntityId(raw)) throw new Error(`${at}: expected an urn:ngsi-ld: id or null`);
  return raw;
}

function rowBudget(raw: unknown, at: string): Readonly<Record<string, number>> | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) throw new Error(`${at}: expected an object of entity type to row count`);
  const budget: Record<string, number> = {};
  for (const [type, value] of Object.entries(raw)) {
    if (!isFiniteNumber(value)) throw new Error(`${at}.${type}: expected a number`);
    budget[type] = value;
  }
  return budget;
}

/** JSON values in `params` stay data — they are handed to connectors unchanged. */
function jsonValue(raw: unknown, at: string): JsonValue {
  if (raw === null || isString(raw) || isFiniteNumber(raw) || isBoolean(raw)) return raw;
  if (isArray(raw)) return raw.map((item, index) => jsonValue(item, `${at}[${String(index)}]`));
  if (isRecord(raw)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(raw)) out[key] = jsonValue(value, `${at}.${key}`);
    return out;
  }
  throw new Error(`${at}: expected a JSON value`);
}

/** Two levels: parameter name, then AGS — `params.stopId["08111000"]`. */
function params(raw: unknown, at: string): ConnectorParams {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new Error(`${at}: expected an object`);
  const byName: Record<string, Record<Ags, JsonValue>> = {};
  for (const [name, perAgs] of Object.entries(raw)) {
    if (!isRecord(perAgs)) throw new Error(`${at}.${name}: expected an object keyed by AGS`);
    const values: Record<Ags, JsonValue> = {};
    for (const [ags, value] of Object.entries(perAgs)) {
      values[ags] = jsonValue(value, `${at}.${name}.${ags}`);
    }
    byName[name] = values;
  }
  return byName;
}

function parseEntry(raw: unknown, index: number): RegistryEntry {
  const at = `connectors[${String(index)}]`;
  if (!isRecord(raw)) throw new Error(`${at}: expected an object`);
  const id = requireString(raw.id, `${at}.id`);
  const entryRuntime = runtime(raw.runtime, `${at}.runtime`);
  return {
    id,
    name: requireString(raw.name, `${at}.name`),
    scope: requireString(raw.scope, `${at}.scope`),
    enabledFor: enabledFor(raw.enabledFor, `${at}.enabledFor`),
    intervalSeconds: optionalNumber(raw.intervalSeconds, `${at}.intervalSeconds`),
    cron: optionalString(raw.cron, `${at}.cron`),
    refireOnRestart: optionalBoolean(raw.refireOnRestart, `${at}.refireOnRestart`),
    // Missing means active: the generator reads it the same way
    // (`if not c.get("active", True): continue`).
    active: optionalBoolean(raw.active, `${at}.active`) ?? true,
    ...(entryRuntime === undefined ? {} : { runtime: entryRuntime }),
    requiresSecret: optionalString(raw.requiresSecret, `${at}.requiresSecret`),
    pending: optionalBoolean(raw.pending, `${at}.pending`) ?? false,
    sollMinutes: optionalNumber(raw.sollMinutes, `${at}.sollMinutes`),
    sampleEntity: sampleEntity(raw.sampleEntity, `${at}.sampleEntity`),
    healthUrl: optionalString(raw.healthUrl, `${at}.healthUrl`),
    attribution: optionalString(raw.attribution, `${at}.attribution`),
    provides: stringList(raw.provides, `${at}.provides`),
    rowBudget24h: rowBudget(raw.rowBudget24h, `${at}.rowBudget24h`),
    params: params(raw.params, `${at}.params`),
  };
}

/** Narrows the parsed file. Throws with the offending path on malformed input. */
export function parseRegistry(raw: unknown): readonly RegistryEntry[] {
  if (!isRecord(raw)) throw new Error("registry: expected an object");
  const list = raw.connectors;
  if (!isArray(list)) throw new Error("registry.connectors: expected an array");
  const entries = list.map(parseEntry);
  const seen = new Set<ConnectorId>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`registry: duplicate connector id "${entry.id}"`);
    seen.add(entry.id);
  }
  return entries;
}

/** Missing `runtime` means `"nodered"` — see platform/connectors/README.md. */
export function runtimeOf(entry: RegistryEntry): ConnectorRuntime {
  return entry.runtime ?? "nodered";
}

class FileRegistry implements Registry {
  readonly entries: readonly RegistryEntry[];
  readonly #byId: ReadonlyMap<ConnectorId, RegistryEntry>;

  constructor(entries: readonly RegistryEntry[]) {
    this.entries = entries;
    this.#byId = new Map(entries.map((entry) => [entry.id, entry]));
  }

  byId(id: ConnectorId): RegistryEntry | undefined {
    return this.#byId.get(id);
  }

  appEntries(): readonly RegistryEntry[] {
    return this.entries.filter((entry) => entry.active && runtimeOf(entry) === "app");
  }
}

export function createRegistry(entries: readonly RegistryEntry[]): Registry {
  return new FileRegistry(entries);
}

/** Reads and narrows the registry. Synchronous — it happens once, at startup. */
export function loadRegistry(path: string): Registry {
  const text = readFileSync(path, "utf8");
  const raw: unknown = JSON.parse(text);
  return createRegistry(parseRegistry(raw));
}
