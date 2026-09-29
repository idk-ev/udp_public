/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Recorded source responses: file format, paths, reading and writing.
 *
 * A fixture is exactly what the Node-RED `http request` node would put into the
 * message — status code, headers, body — plus its provenance. That way the same
 * file feeds both sides of a parity test: the old function node gets it as
 * `msg`, the new module gets `fixture.payload` as its `raw` argument.
 *
 * The order is binding (`docs/migration-konnektoren.md`): fixtures are recorded
 * BEFORE anything is deleted. Once all 29 connectors are ported, `flows.json`
 * disappears and this directory is the regression suite that the project has
 * never had.
 *
 * The old side of that suite is `legacy-flows.json` in the same directory: the
 * generated flows frozen at the last commit before the first connector was
 * switched over (see `legacy-flows.README.md` there). Every parity test reads
 * old node code from it, never from the live `platform/config/nodered/flows.json`,
 * which loses a connector's nodes the moment it runs in the service.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./normalize.js";

/**
 * The frozen Node-RED flows, relative to the repository root — anchor for the
 * paths below. It is committed test data, not build output, so it exists for
 * the source tree and for `dist/` alike, and it outlives the live flow file.
 */
const LEGACY_FLOWS_RELATIVE = join("platform", "connectors", "test", "fixtures", "legacy-flows.json");

let cachedRoot: string | undefined;

/**
 * Walks upwards from this module until the frozen flow file appears.
 * Deliberately not a relative `../../..`: this file runs compiled from
 * `dist/test/harness/` and, for a type check, from `test/harness/` — the depth
 * differs, the anchor does not.
 */
export function repositoryRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, LEGACY_FLOWS_RELATIVE))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`repository root not found above ${start}: no ${LEGACY_FLOWS_RELATIVE}`);
    }
    dir = parent;
  }
}

/**
 * The OLD flows every parity test reads its old node code from: the generated
 * `flows.json` frozen before the first cutover. Never regenerated, never
 * deployed — the live file drops a connector's nodes once it runs in the
 * service, the comparison must not lose its old side with it.
 */
export function legacyFlowsPath(): string {
  return join(repositoryRoot(), LEGACY_FLOWS_RELATIVE);
}

/**
 * Always the SOURCE tree, never the `dist/` copy — fixtures are committed data,
 * not build output, and a recording has to land where git sees it.
 */
export function fixturesDir(): string {
  return join(repositoryRoot(), "platform", "connectors", "test", "fixtures");
}

export function fixturePath(name: string): string {
  return join(fixturesDir(), `${name}.json`);
}

export interface Fixture {
  /** URL the response came from. */
  readonly source: string;
  /** ISO instant of the recording. */
  readonly recordedAt: string;
  /** Trims, redactions, anything that makes this file differ from the response. */
  readonly note?: string;
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  /** `json` — `payload` is the parsed body; `text` — `payload` is the raw text. */
  readonly format: "json" | "text";
  /** What the `http request` node would put into `msg.payload`. */
  readonly payload: unknown;
}

function readString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${where}: field "${key}" must be a string, got ${typeof value}`);
  }
  return value;
}

function readHeaders(value: unknown, where: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${where}: field "headers" must be an object`);
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`${where}: header "${key}" must be a string`);
    }
    headers[key] = entry;
  }
  return headers;
}

/** External data is narrowed, never asserted — the same rule as for the connectors. */
export function parseFixture(raw: unknown, where: string): Fixture {
  if (!isRecord(raw)) throw new Error(`${where}: fixture must be a JSON object`);
  const statusCode = raw.statusCode;
  if (typeof statusCode !== "number") {
    throw new Error(`${where}: field "statusCode" must be a number`);
  }
  const format = raw.format;
  if (format !== "json" && format !== "text") {
    throw new Error(`${where}: field "format" must be "json" or "text"`);
  }
  const note = raw.note;
  if (note !== undefined && typeof note !== "string") {
    throw new Error(`${where}: field "note" must be a string`);
  }
  return {
    source: readString(raw, "source", where),
    recordedAt: readString(raw, "recordedAt", where),
    statusCode,
    headers: readHeaders(raw.headers, where),
    format,
    payload: raw.payload,
    ...(note === undefined ? {} : { note }),
  };
}

export function readFixture(name: string): Fixture {
  const file = fixturePath(name);
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  return parseFixture(parsed, file);
}

/** Writes `test/fixtures/<name>.json`; returns the path written. */
export function writeFixture(name: string, fixture: Fixture): string {
  const file = fixturePath(name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  return file;
}

/**
 * Builds the message the old function node sees. The payload is cloned: the
 * node overwrites `msg.payload` and may mutate it, and the fixture must not
 * carry that over into the second side of the comparison.
 */
export function messageFromFixture(fixture: Fixture): Record<string, unknown> {
  return {
    _msgid: "parity",
    topic: fixture.source,
    url: fixture.source,
    statusCode: fixture.statusCode,
    headers: { ...fixture.headers },
    payload: structuredClone(fixture.payload),
  };
}
