/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `pegel-bw` — water levels of the federal waterways (PEGELONLINE) in BW.
 *
 * Port of FN_PEGEL (`udp-rt-pe-fn`) and the nodes around it: the hourly inject,
 * the `http request` against the PEGELONLINE REST API, the "1 Anfrage/s" delay
 * in front of the upsert and the signature commit behind it (`upsert_commit`).
 *
 * One `WaterLevelObserved` per station that lies inside a BW municipality
 * polygon. The assignment is strict (PIP_ONLY in the old flow, `municipalities:
 * "optional"` here): gauges on the Main in Bavaria, in Basel or on the
 * Palatinate bank of the Rhine are discarded on purpose, and the master data
 * rows are only used for the display name — a missing row leaves the name
 * empty, it does not skip the run.
 *
 * The change gate (`pegelSig`, merge mode, as the old `gateChanged` call without
 * options) exists because, in the words of the original, "Pegel ändern sich bei
 * Trockenwetter über Stunden nicht — nur geänderte schreiben."
 *
 * Deliberate differences, only for input the old node could not digest:
 *
 *  * A station record that cannot be read (not an object, a `timeseries` that
 *    is not a list, a W series without a readable value) is skipped and
 *    counted with a `[warn]`. The old node threw a TypeError on it and lost the
 *    whole run — but only if the station survived the coordinate checks, so a
 *    malformed record far outside BW, which the old node never looked at, is
 *    counted here as well.
 *  * A request that fails without a response (DNS, timeout) is the same
 *    warning as an HTTP error. The old `http request` node passed the error
 *    text on as the payload, which then failed the array check and produced
 *    that warning with the error code in place of the status.
 */

import {
  isArray,
  isFiniteNumber,
  isRecord,
  isString,
  isTruthy,
  mapLenient,
  ParseError,
} from "../kernel/parse.js";
import { dateObserved, observed } from "../kernel/ngsi.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  ConnectorModule,
  Ctx,
  GeoIndex,
  GeoProperty,
  IsoTime,
  JsonResponse,
  NgsiDateTime,
  NgsiEntity,
  Property,
} from "../kernel/types.js";

export const ID = "pegel-bw";

export const SOURCE_URL =
  "https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json" +
  "?includeTimeseries=true&includeCurrentMeasurement=true";

/** Store key of the change gate, unchanged from the flow. */
export const GATE_KEY = "pegelSig";

/** As FN_PEGEL: `emitChunks(node, msg, geaendert, 50)`. */
export const CHUNK_SIZE = 50;

const DATA_PROVIDER = "WSV/PEGELONLINE (DL-DE→Zero-2.0)";

/** Label of the geo skip warning and of this connector's own warnings. */
const LABEL = "PEGELONLINE";

/** The current value of a station's W series in centimetres. */
export interface WaterLevel {
  readonly value: number;
  /** `stateMnwMhw`, or `null` if the source left it out or empty. */
  readonly state: string | null;
}

export interface Station {
  /** PEGELONLINE station number, the tail of the entity id. */
  readonly number: string;
  readonly shortname: string;
  /** `water.shortname`, `""` without one (`st.water && st.water.shortname || ''`). */
  readonly water: string;
  /** `null` when missing or not a finite number: the station is then out of range. */
  readonly latitude: number | null;
  readonly longitude: number | null;
  /** From the series `shortname === 'W' && unit === 'cm'`; `null` without a current value. */
  readonly level: WaterLevel | null;
}

export interface StationList {
  readonly stations: readonly Station[];
  /** Records that could not be read and were skipped. */
  readonly skipped: number;
}

export interface WaterLevelEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:WaterLevelObserved:bw-pegel-${string}`;
  readonly type: "WaterLevelObserved";
  readonly ags: Property<string>;
  readonly gemeindeName: Property<string>;
  readonly name: Property<string>;
  readonly water: Property<string>;
  readonly level: Property<number>;
  readonly levelState: Property<string>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly dataProvider: Property<string>;
  readonly location: GeoProperty;
  readonly "@context": string;
}

function station(raw: unknown, index: number): Station {
  const at = `stations[${String(index)}]`;
  if (!isRecord(raw)) throw new ParseError(at, "object", raw);

  // The entity id is `'…bw-pegel-' + st.number`; the API sends a string, a
  // number would concatenate the same way.
  const number = raw.number;
  if (!isString(number) && !isFiniteNumber(number)) throw new ParseError(`${at}.number`, "string", number);
  const shortname = raw.shortname;
  if (!isString(shortname)) throw new ParseError(`${at}.shortname`, "string", shortname);

  const waterName = isRecord(raw.water) ? raw.water.shortname : undefined;
  if (isTruthy(waterName) && !isString(waterName)) {
    throw new ParseError(`${at}.water.shortname`, "string", waterName);
  }

  return {
    number: String(number),
    shortname,
    water: isString(waterName) ? waterName : "",
    latitude: isFiniteNumber(raw.latitude) ? raw.latitude : null,
    longitude: isFiniteNumber(raw.longitude) ? raw.longitude : null,
    level: waterLevel(raw.timeseries, at),
  };
}

/**
 * The W series in centimetres — mandatory, and the comment of the original
 * says why:
 *
 *   > Zwingend die Wasserstandsreihe W (cm) nehmen. Stationen mit
 *   > Abflussmessung führen Q (m³/s) an erster Stelle — die frühere Auswahl
 *   > timeseries[0] hat dort Kubikmeter je Sekunde als Pegelstand ausgewiesen
 *   > (Maxau 524 statt 351).
 */
function waterLevel(raw: unknown, at: string): WaterLevel | null {
  // `(st.timeseries || [])`: missing or null means no series at all.
  if (!isTruthy(raw)) return null;
  if (!isArray(raw)) throw new ParseError(`${at}.timeseries`, "array", raw);
  const series = raw.find((entry) => {
    // `t.shortname` throws on null/undefined only; any other non-object simply
    // does not match.
    if (entry === null || entry === undefined) throw new ParseError(`${at}.timeseries[]`, "object", entry);
    return isRecord(entry) && entry.shortname === "W" && entry.unit === "cm";
  });
  if (!isRecord(series)) return null;
  const current = series.currentMeasurement;
  // `if (!cm || cm.value == null) continue;`
  if (!isRecord(current)) return null;
  const value = current.value;
  if (value === null || value === undefined) return null;
  if (!isFiniteNumber(value)) throw new ParseError(`${at}.W.currentMeasurement.value`, "number", value);
  const state = current.stateMnwMhw;
  if (isTruthy(state) && !isString(state)) {
    throw new ParseError(`${at}.W.currentMeasurement.stateMnwMhw`, "string", state);
  }
  return { value, state: isString(state) && state !== "" ? state : null };
}

/** Loud on a response that is not a station list; lenient per station (counted). */
export function parse(raw: unknown): StationList {
  if (!isArray(raw)) throw new ParseError("payload", "array of stations", raw);
  const { values, skipped } = mapLenient(raw, station);
  return { stations: values, skipped };
}

/** Pure: no network, no clock, no global state — this is what parity diffs. */
export function build(raw: StationList, geo: GeoIndex | null, now: IsoTime): readonly WaterLevelEntity[] {
  if (geo === null) return [];
  const entities: WaterLevelEntity[] = [];
  for (const st of raw.stations) {
    const lat = st.latitude;
    const lon = st.longitude;
    // `if (!lat || lat < 47.5 || lat > 49.85 || lon < 7.4 || lon > 10.6) continue;`
    // — a coarse box around BW before the polygon test.
    if (lat === null || lon === null || lat === 0 || lat < 47.5 || lat > 49.85 || lon < 7.4 || lon > 10.6) {
      continue;
    }
    const ags = geo.agsAt(lat, lon);
    // Outside BW (e.g. the Main in Bavaria) — discarded on purpose.
    if (ags === null) continue;
    const level = st.level;
    if (level === null) continue;
    entities.push({
      id: `urn:ngsi-ld:WaterLevelObserved:bw-pegel-${st.number}`,
      type: "WaterLevelObserved",
      ags: { type: "Property", value: ags },
      // `NAME[ags] || ''`: the master data may be missing (municipalities optional).
      gemeindeName: { type: "Property", value: geo.byAgs(ags)?.[1] ?? "" },
      name: { type: "Property", value: st.shortname },
      water: { type: "Property", value: st.water },
      level: observed(level.value, "CMT", now),
      levelState: { type: "Property", value: level.state ?? "unknown" },
      dateObserved: dateObserved(now),
      dataProvider: { type: "Property", value: DATA_PROVIDER },
      location: { type: "GeoProperty", value: { type: "Point", coordinates: [lon, lat] } },
      "@context": NGSI_CONTEXT,
    });
  }
  return entities;
}

/** `e.level.value + '|' + (e.levelState && e.levelState.value)` — the measured values only. */
export function signatureOf(entity: WaterLevelEntity): string {
  return `${String(entity.level.value)}|${entity.levelState.value}`;
}

export async function run(ctx: Ctx): Promise<void> {
  let response: JsonResponse;
  try {
    response = await ctx.fetch.json(SOURCE_URL);
  } catch (error) {
    ctx.log.warn(`${LABEL}: no data (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  if (!response.ok || !isArray(response.body)) {
    ctx.log.warn(`${LABEL}: no data (${String(response.status)})`);
    return;
  }

  // PIP_ONLY: boundaries required, master data only for the display name.
  const geo = ctx.geo.forRun(LABEL, { municipalities: "optional" });
  if (geo === null) return;

  const list = parse(response.body);
  if (list.skipped > 0) ctx.log.warn(`${LABEL}: ${String(list.skipped)} unreadable station records skipped`);
  const entities = build(list, geo, ctx.now());
  if (entities.length === 0) {
    ctx.log.warn(`${LABEL}: no BW stations`);
    return;
  }
  ctx.log.status(`${String(entities.length)} gauges in BW municipalities`);

  // check -> upsert -> commit: a gauge's signature takes effect only for the ids
  // Orion confirmed, so a lost write is repeated in the next run. The gate
  // reports "changed/total" itself; an empty plan sends nothing, as the old
  // `if (!geaendert.length) return null;`.
  const result = await ctx.orion.upsertChanged(GATE_KEY, entities, signatureOf, {
    chunkSize: CHUNK_SIZE,
    // Water levels in cm: most gauges move between two runs.
    volatile: true,
  });
  if (result.entities > 0) {
    ctx.log.info(
      `${String(result.entities)} of ${String(entities.length)} gauges upserted in ${String(result.chunks)} ` +
        `chunks (${String(result.failedChunks)} failed, ${String(result.committed)} signatures committed)`,
    );
  }
}

export const connector: ConnectorModule<StationList, readonly WaterLevelEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
