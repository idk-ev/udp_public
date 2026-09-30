/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `pegel-lubw` — water levels of the state waters (LUBW, Hochwasservorhersage-
 * zentrale BW).
 *
 * Port of FN_PEGEL_LUBW (`udp-rt-pl-fn`) and the nodes around it: the hourly
 * inject, the `http request` for the master data file (`ret: txt`), the
 * "1 Anfrage/s" delay in front of the upsert and the signature commit behind it.
 *
 * The HVZ publishes no API, only the JavaScript file its gauge page loads:
 * `HVZ_Site.PEG_DB = [ [...], [...], … ];`, one array literal per gauge. The
 * original parses it with a regex and a small quote-aware splitter
 * (`parseRow`), and both are ported verbatim — including their blind spots (no
 * escaped quotes, no brackets inside strings), because a "better" parser would
 * read a changed file differently from the one it replaces.
 *
 * Field positions, from the original (after hvz_peg_var.js): 0 id, 1 name,
 * 2 water, 4 W, 5 unit, 6 time, 7 Q, 20 longitude, 21 latitude, 30–34 flood
 * warning levels, 40 mean water level, 43 mean low water level. Numbers come
 * as text with a decimal comma or point; `'--'` means "no current value".
 *
 * The assignment is strict (PIP_ONLY, `municipalities: "optional"`): a gauge
 * outside every BW municipality polygon is counted and skipped, the master
 * data only supply the display name.
 *
 * Deliberate difference: a failed request (DNS, timeout) warns "no data". The
 * old `http request` node handed the error text on as the payload, which then
 * failed the PEG_DB match — a warning either way, with different wording.
 */

import { ParseError, isString } from "../kernel/parse.js";
import { dateObserved, observed } from "../kernel/ngsi.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  ConnectorModule,
  Ctx,
  GeoIndex,
  GeoProperty,
  HttpResponse,
  IsoTime,
  NgsiDateTime,
  NgsiEntity,
  Property,
} from "../kernel/types.js";

export const ID = "pegel-lubw";

export const SOURCE_URL = "https://www.hvz.baden-wuerttemberg.de/js/hvz_peg_stmn.js";

/** Store key of the change gate, unchanged from the flow. */
export const GATE_KEY = "hvzSig";

/** As FN_PEGEL_LUBW: `emitChunks(node, msg, geaendert, 50)`. */
export const CHUNK_SIZE = 50;

const DATA_PROVIDER = "LUBW / Hochwasservorhersagezentrale BW";

const LABEL = "HVZ";

/** Rows with fewer fields are not gauge records (the trailing `[]`, for one). */
const MIN_FIELDS = 45;

/**
 * One PEG_DB row with the fields the connector reads, still as the text the
 * file carries — the numbers are read in `build`, exactly where the old node
 * applied `num()`.
 */
export interface HvzRow {
  /** 0 — "Kennung", the tail of the entity id. */
  readonly id: string;
  /** 1 */
  readonly name: string;
  /** 2 */
  readonly water: string;
  /** 4 — W, `'--'` without a current value. */
  readonly level: string;
  /** 5 — `'cm'`, otherwise metres above sea level (`'müNN'`). */
  readonly unit: string;
  /** 6 — local time of the measurement, as text. */
  readonly measuredAt: string;
  /** 7 — Q in m³/s. */
  readonly discharge: string;
  /** 20 */
  readonly longitude: string;
  /** 21 */
  readonly latitude: string;
  /** 30–34 — flood warning levels 1 to 5, `0` where a level is not defined. */
  readonly floodLevels: readonly [string, string, string, string, string];
  /** 40 — MW */
  readonly meanLevel: string;
  /** 43 — MNW */
  readonly meanLowLevel: string;
}

export interface HvzFile {
  readonly rows: readonly HvzRow[];
  /** Array literals in PEG_DB with fewer than 45 fields (skipped as in the old node). */
  readonly shortRows: number;
}

export interface HvzEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:WaterLevelObserved:bw-hvz-${string}`;
  readonly type: "WaterLevelObserved";
  readonly ags: Property<string>;
  readonly gemeindeName: Property<string>;
  readonly name: Property<string>;
  readonly water: Property<string>;
  readonly level: Property<number>;
  readonly levelState: Property<string>;
  readonly measuredAt: Property<string>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly dataProvider: Property<string>;
  readonly location: GeoProperty;
  readonly "@context": string;
  readonly discharge?: Property<number> | undefined;
  readonly floodLevels?: Property<readonly number[]> | undefined;
  readonly meanLevel?: Property<number> | undefined;
  readonly meanLowLevel?: Property<number> | undefined;
}

/** Result of `build`: the entities plus the count the status line reports. */
export interface HvzBuild {
  readonly entities: readonly HvzEntity[];
  /** Gauges with a value but outside every municipality polygon. */
  readonly outsidePolygons: number;
}

/**
 * `parseRow` of the original, verbatim: splits an array literal at the commas
 * outside single quotes and drops the quotes. No escapes — the file has none,
 * and reading one differently from the old node would be a silent change.
 */
export function parseRow(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const c of line) {
    if (c === "'") {
      quoted = !quoted;
      continue;
    }
    if (c === "," && !quoted) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  out.push(current.trim());
  return out;
}

/**
 * `num` of the original: decimal comma or point, `parseFloat` semantics
 * (leading number wins), `null` for anything not finite — `'--'` above all.
 * Only the FIRST comma is replaced, as `String.replace` with a string pattern
 * does; a value with two commas reads as its part before the second.
 */
export function num(value: string): number | null {
  const parsed = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

const PEG_DB = /PEG_DB\s*=\s*\[([\s\S]*?)\n\];/;
const ROW = /\[([^[\]]*)\]/g;

function field(fields: readonly string[], index: number): string {
  // Only called for rows with at least MIN_FIELDS fields and indices below it.
  return fields[index] ?? "";
}

/**
 * Loud when the file is not text or PEG_DB cannot be found — the old node's
 * "PEG_DB nicht gefunden (Format geändert?)". Rows too short to be a gauge are
 * counted, not rejected.
 */
export function parse(raw: unknown): HvzFile {
  if (!isString(raw)) throw new ParseError("payload", "text of hvz_peg_stmn.js", raw);
  const block = PEG_DB.exec(raw);
  const body = block?.[1];
  if (body === undefined) throw new ParseError("PEG_DB", "the PEG_DB array (format changed?)", raw);
  const rows: HvzRow[] = [];
  let shortRows = 0;
  for (const match of body.matchAll(ROW)) {
    const fields = parseRow(match[1] ?? "");
    if (fields.length < MIN_FIELDS) {
      shortRows += 1;
      continue;
    }
    rows.push({
      id: field(fields, 0),
      name: field(fields, 1),
      water: field(fields, 2),
      level: field(fields, 4),
      unit: field(fields, 5),
      measuredAt: field(fields, 6),
      discharge: field(fields, 7),
      longitude: field(fields, 20),
      latitude: field(fields, 21),
      floodLevels: [
        field(fields, 30),
        field(fields, 31),
        field(fields, 32),
        field(fields, 33),
        field(fields, 34),
      ],
      meanLevel: field(fields, 40),
      meanLowLevel: field(fields, 43),
    });
  }
  return { rows, shortRows };
}

/** Pure: no network, no clock, no global state — this is what parity diffs. */
export function build(raw: HvzFile, geo: GeoIndex | null, now: IsoTime): HvzBuild {
  const entities: HvzEntity[] = [];
  let outsidePolygons = 0;
  if (geo === null) return { entities, outsidePolygons };
  for (const row of raw.rows) {
    const lon = num(row.longitude);
    const lat = num(row.latitude);
    const level = num(row.level);
    // '--' = no current value
    if (lat === null || lon === null || level === null) continue;
    const ags = geo.agsAt(lat, lon);
    if (ags === null) {
      outsidePolygons += 1;
      continue;
    }
    const floodLevels = row.floodLevels
      .map(num)
      .filter((value): value is number => value !== null && value > 0);
    const meanLow = num(row.meanLowLevel);
    const mean = num(row.meanLevel);
    // State: flood from the first warning level on; below MNW low water.
    let state = "normal";
    const firstLevel = floodLevels[0];
    if (firstLevel !== undefined && level >= firstLevel) state = "high";
    else if (meanLow !== null && level < meanLow) state = "low";
    const discharge = num(row.discharge);
    entities.push({
      id: `urn:ngsi-ld:WaterLevelObserved:bw-hvz-${row.id}`,
      type: "WaterLevelObserved",
      ags: { type: "Property", value: ags },
      gemeindeName: { type: "Property", value: geo.byAgs(ags)?.[1] ?? "" },
      name: { type: "Property", value: row.name },
      water: { type: "Property", value: row.water },
      level: observed(level, row.unit === "cm" ? "CMT" : "MTR", now),
      levelState: { type: "Property", value: state },
      measuredAt: { type: "Property", value: row.measuredAt },
      dateObserved: dateObserved(now),
      dataProvider: { type: "Property", value: DATA_PROVIDER },
      location: { type: "GeoProperty", value: { type: "Point", coordinates: [lon, lat] } },
      "@context": NGSI_CONTEXT,
      ...(discharge === null ? {} : { discharge: observed(discharge, "MQS", now) }),
      ...(floodLevels.length === 0 ? {} : { floodLevels: { type: "Property", value: floodLevels } }),
      ...(mean === null ? {} : { meanLevel: { type: "Property", value: mean, unitCode: "CMT" } }),
      ...(meanLow === null ? {} : { meanLowLevel: { type: "Property", value: meanLow, unitCode: "CMT" } }),
    });
  }
  return { entities, outsidePolygons };
}

/** Level, state and discharge — the measured values, never `dateObserved`. */
export function signatureOf(entity: HvzEntity): string {
  const discharge = entity.discharge === undefined ? "" : String(entity.discharge.value);
  return `${String(entity.level.value)}|${entity.levelState.value}|${discharge}`;
}

export async function run(ctx: Ctx): Promise<void> {
  let response: HttpResponse;
  try {
    response = await ctx.fetch.text(SOURCE_URL);
  } catch (error) {
    ctx.log.warn(`${LABEL}: no data (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  // `msg.statusCode >= 400`, as the old guard (not `!ok`).
  if (response.status >= 400) {
    ctx.log.warn(`${LABEL}: no data (${String(response.status)})`);
    return;
  }
  let file: HvzFile;
  try {
    file = parse(response.body);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    ctx.log.warn(`${LABEL}: PEG_DB not found (format changed?)`);
    return;
  }

  // PIP_ONLY: boundaries required, master data only for the display name.
  const geo = ctx.geo.forRun(LABEL, { municipalities: "optional" });
  if (geo === null) return;

  const { entities, outsidePolygons } = build(file, geo, ctx.now());
  if (entities.length === 0) {
    ctx.log.warn(`${LABEL}: no entities`);
    return;
  }
  ctx.log.status(
    `${String(entities.length)} state gauges (${String(outsidePolygons)} outside BW municipality polygons)`,
  );

  const result = await ctx.orion.upsertChanged(GATE_KEY, entities, signatureOf, { chunkSize: CHUNK_SIZE });
  if (result.entities > 0) {
    ctx.log.info(
      `${String(result.entities)} of ${String(entities.length)} state gauges upserted in ` +
        `${String(result.chunks)} chunks (${String(result.failedChunks)} failed, ` +
        `${String(result.committed)} signatures committed)`,
    );
  }
}

export const connector: ConnectorModule<HvzFile, HvzBuild> = { id: ID, parse, build, run };
