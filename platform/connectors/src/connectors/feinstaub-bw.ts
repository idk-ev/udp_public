/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `feinstaub-bw` — particulate matter median per municipality from the citizen
 * sensors of sensor.community, plus the single sensors once an hour.
 *
 * Port of `udp-rt-bs-fn` ("→ Median je Gemeinde") and the commit node behind
 * its upsert in the former Node-RED flow generator (see git history). One request for the whole
 * BW box every 15 minutes; per SDS011 sensor the newest plausible reading;
 * sensors assigned STRICTLY to a municipality polygon (the box also covers
 * Alsace, Basel, the Palatinate and Bavaria — outside every BW polygon means
 * skipped, for the median and as a single sensor); per municipality the median
 * of PM10 and PM2.5 with the sensor count and a `dateObserved`.
 *
 * ## The cadence
 *
 * The single sensors (~930 statewide) are written only in every fourth run,
 * i.e. hourly: writing them every 15 minutes would more than double the
 * time-series database without the map layer profiting. The old node counted
 * runs in the flow context (`scTakt`), starting from 0, so the first detail
 * run is the fourth run. The counter lives in `ctx.state` ({@link cadenceOf})
 * and is persisted, so a restart continues the count as the flow context did
 * under Compose (in Kubernetes it started over). The prune runs in the detail runs only, so
 * its interval guard gets `ctx.intervalMs(4)`. Which municipalities get single
 * sensors is `sensorDetailFor` of the registry entry.
 *
 * ## Deviations
 *
 *  * The prune runs AFTER the upsert, not concurrently before it. The prune
 *    keeps every id of the run, so the two touch disjoint ids; the order only
 *    makes the run sequential.
 *  * Malformed records are skipped instead of taking the run down: a record
 *    without `location`, or `null` inside `sensordatavalues`, made the old node
 *    throw (no entity at all that run). The recorded fixtures contain none.
 */

import { observed } from "../kernel/ngsi.js";
import { isArray, isRecord, isString } from "../kernel/parse.js";
import { persisted, stateKey } from "../kernel/state.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  Ags,
  ConnectorModule,
  Ctx,
  GeoIndex,
  GeoJsonPoint,
  IsoTime,
  JsonResponse,
  NgsiDateTime,
  NgsiEntity,
  Property,
} from "../kernel/types.js";

export const ID = "feinstaub-bw";

export const SOURCE_URL = "https://data.sensor.community/airrohr/v1/filter/box=47.5,7.4,49.8,10.6";

/** Log prefix, as the old warnings read. */
const LABEL = "sensor.community BW";

/** As the old node: `emitChunks(node, msg, geaendert, 100)`. */
const CHUNK_SIZE = 100;

/** Store key of the change gate, unchanged from the flow. */
export const GATE_KEY = "feinstaubSig";

/** Every n-th run is a detail run (single sensors + prune). */
export const DETAIL_EVERY = 4;

/** Readings above this are a saturated or broken SDS011 (it maxes out near 500 µg/m³). */
const PLAUSIBLE_MAX = 400;

/**
 * One SDS011 reading as the old loop saw it. Only records of that sensor type
 * are kept; everything else was the loop's first `continue`.
 */
export interface SensorReading {
  /** `rec.sensor.id` as an object key (`String(id)`). */
  readonly sensorKey: string;
  /** `rec.timestamp`; compared as a string (`"2026-09-28 03:09:03"`). */
  readonly timestamp: string | undefined;
  /** `[value_type, parseFloat(value)]` in the order of `sensordatavalues`. */
  readonly values: readonly (readonly [valueType: unknown, value: number])[];
  /** `parseFloat(rec.location.latitude)` — `NaN` for garbage. */
  readonly lat: number;
  readonly lon: number;
}

/** The input of one run: the box, whether this run is a detail run, and for which municipalities. */
export interface SensorBox {
  readonly readings: readonly SensorReading[];
  /** Set by `run` from the cadence; `parse` cannot know it and says `false`. */
  readonly detailRun: boolean;
  /**
   * `sensorDetailFor` of the registry entry (`"*"` or a list of AGS): the
   * municipalities whose single sensors become entities — `DETAIL_AGS`, which
   * the generator spliced into the node. Set by `run` from `ctx.entry`;
   * `parse` cannot know it and says none.
   */
  readonly detailFor: "*" | readonly Ags[];
}

export interface MedianEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:AirQualityObserved:bw-sc-${string}`;
  readonly type: "AirQualityObserved";
  readonly ags: Property<string>;
  readonly sensorCount: Property<number>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly pm10?: Property<number> | undefined;
  readonly pm25?: Property<number> | undefined;
  readonly "@context": string;
}

export interface SensorEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:AirQualityObserved:bw-sensor-${string}`;
  readonly type: "AirQualityObserved";
  readonly ags: Property<string>;
  readonly name: Property<string>;
  readonly location: { readonly type: "GeoProperty"; readonly value: GeoJsonPoint };
  readonly pm10?: Property<number> | undefined;
  readonly pm25?: Property<number> | undefined;
  /** Only the medians carry a count; spelled out so the signature can read it off the union. */
  readonly sensorCount?: undefined;
  readonly "@context": string;
}

export type FeinstaubEntity = SensorEntity | MedianEntity;

/** What one run produced, with the counters of the status line. */
export interface FeinstaubResult {
  readonly entities: readonly FeinstaubEntity[];
  readonly sensorEntities: number;
  /** Implausible readings discarded (`verworfen`). */
  readonly discarded: number;
  /** Sensors outside every BW municipality polygon (`fremd`). */
  readonly outside: number;
}

/* ------------------------------------------------------------------ parse */

/** JavaScript's `String(x)` for a foreign value. */
function jsString(value: unknown): string {
  return String(value);
}

/** `parseFloat(x)` of the old node, for any value: `ToString`, then parse. */
function parseFloatOf(value: unknown): number {
  return Number.parseFloat(jsString(value));
}

function parseReading(raw: unknown): SensorReading | null {
  if (!isRecord(raw)) return null;
  const sensor = raw.sensor;
  if (!isRecord(sensor)) return null;
  const type = sensor.sensor_type;
  if (!isRecord(type) || type.name !== "SDS011") return null;
  const values: (readonly [valueType: unknown, value: number])[] = [];
  const list = raw.sensordatavalues;
  if (isArray(list)) {
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      values.push([entry.value_type, parseFloatOf(entry.value)]);
    }
  }
  const location = raw.location;
  const timestamp = raw.timestamp;
  return {
    sensorKey: jsString(sensor.id),
    timestamp: isString(timestamp) ? timestamp : undefined,
    values,
    lat: isRecord(location) ? parseFloatOf(location.latitude) : Number.NaN,
    lon: isRecord(location) ? parseFloatOf(location.longitude) : Number.NaN,
  };
}

/**
 * Narrows the box response. Not an array is loud (the old node warned and
 * stopped there, which `run` does before parsing); single records it cannot
 * use are dropped, as the node's loop skipped them.
 */
export function parse(raw: unknown): SensorBox {
  if (!isArray(raw)) throw new Error(`${LABEL}: response is not an array`);
  const readings: SensorReading[] = [];
  for (const record of raw) {
    const reading = parseReading(record);
    if (reading !== null) readings.push(reading);
  }
  return { readings, detailRun: false, detailFor: [] };
}

/* ------------------------------------------------------------------ build */

interface Sensor {
  readonly timestamp: string | undefined;
  readonly lat: number;
  readonly lon: number;
  readonly pm10: number | undefined;
  readonly pm25: number | undefined;
  ags?: Ags;
}

/** An array index key (`"26209"`), which a JS object enumerates first and in numeric order. */
function isIndexKey(key: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 4_294_967_295;
}

/**
 * The key order of `Object.keys` on an object filled in `keys` order: integer
 * keys ascending, then the rest in insertion order. The sensor ids are
 * integers, so the old node walked its `bySensor` object in ascending id order
 * whatever order the records came in — and the order of the municipalities
 * (first sensor seen) and of the entities follows from it.
 */
function objectKeyOrder(keys: Iterable<string>): string[] {
  const indices: string[] = [];
  const others: string[] = [];
  for (const key of keys) (isIndexKey(key) ? indices : others).push(key);
  indices.sort((a, b) => Number(a) - Number(b));
  return [...indices, ...others];
}

/** The old `median`: sorts in place; even count → mean of the middle two, one decimal. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((x, y) => x - y);
  const m = Math.floor(values.length / 2);
  const upper = values[m];
  const lower = values[m - 1];
  if (upper === undefined) return null;
  if (values.length % 2 === 1 || lower === undefined) return upper;
  return Math.round(((lower + upper) / 2) * 10) / 10;
}

/**
 * Pure. Newest plausible reading per sensor, strict municipality assignment,
 * medians per municipality, single sensors in detail runs. `geo` null (not a
 * case `run` produces: it skips without boundaries) assigns nothing.
 */
export function summarize(raw: SensorBox, geo: GeoIndex | null, now: IsoTime): FeinstaubResult {
  const bySensor = new Map<string, Sensor>();
  let discarded = 0;
  for (const reading of raw.readings) {
    const previous = bySensor.get(reading.sensorKey);
    // `bySensor[id].timestamp > rec.timestamp`: an older record never replaces
    // a newer one (string comparison; undefined compares false).
    if (
      previous?.timestamp !== undefined &&
      reading.timestamp !== undefined &&
      previous.timestamp > reading.timestamp
    ) {
      continue;
    }
    let pm10: number | undefined;
    let pm25: number | undefined;
    for (const [valueType, value] of reading.values) {
      if (!Number.isFinite(value) || value < 0 || value > 500) continue;
      if (valueType === "P1") pm10 = value;
      if (valueType === "P2") pm25 = value;
    }
    if (pm10 === undefined && pm25 === undefined) continue;
    // Plausibility: an SDS011 in saturation or with a defect reports both
    // channels near the maximum (~500 µg/m³). Real values in BW stay well below
    // 400 even with Saharan dust. PM2.5 is physically a subset of PM10 and can
    // never be larger. Such sensors would distort the municipal median — in
    // small places with a single sensor completely — and are discarded.
    if ((pm10 !== undefined && pm10 > PLAUSIBLE_MAX) || (pm25 !== undefined && pm25 > PLAUSIBLE_MAX)) {
      discarded += 1;
      continue;
    }
    if (pm10 !== undefined && pm25 !== undefined && pm25 > pm10 * 1.05) {
      discarded += 1;
      continue;
    }
    bySensor.set(reading.sensorKey, {
      timestamp: reading.timestamp,
      lat: reading.lat,
      lon: reading.lon,
      pm10,
      pm25,
    });
  }

  const sensorOrder = objectKeyOrder(bySensor.keys());
  const byMunicipality = new Map<Ags, { readonly pm10: number[]; readonly pm25: number[] }>();
  let outside = 0;
  for (const key of sensorOrder) {
    const sensor = bySensor.get(key);
    if (sensor === undefined) continue;
    // The query box also covers Alsace, Basel, the Palatinate and Bavaria:
    // sensors outside every BW polygon are skipped (median and single sensor).
    const municipality = geo === null ? null : geo.municipalityAt(sensor.lat, sensor.lon);
    if (municipality === null) {
      outside += 1;
      continue;
    }
    const ags = municipality[0];
    sensor.ags = ags;
    let bucket = byMunicipality.get(ags);
    if (bucket === undefined) {
      bucket = { pm10: [], pm25: [] };
      byMunicipality.set(ags, bucket);
    }
    if (sensor.pm10 !== undefined) bucket.pm10.push(sensor.pm10);
    if (sensor.pm25 !== undefined) bucket.pm25.push(sensor.pm25);
  }

  const entities: FeinstaubEntity[] = [];
  let sensorEntities = 0;
  if (raw.detailRun) {
    for (const key of sensorOrder) {
      const sensor = bySensor.get(key);
      const ags = sensor?.ags;
      if (sensor === undefined || ags === undefined) continue;
      if (raw.detailFor !== "*" && !raw.detailFor.includes(ags)) continue;
      entities.push({
        id: `urn:ngsi-ld:AirQualityObserved:bw-sensor-${ags}-${key}`,
        type: "AirQualityObserved",
        ags: { type: "Property", value: ags },
        name: { type: "Property", value: `Sensor ${key}` },
        location: { type: "GeoProperty", value: { type: "Point", coordinates: [sensor.lon, sensor.lat] } },
        "@context": NGSI_CONTEXT,
        ...(sensor.pm10 === undefined ? {} : { pm10: observed(sensor.pm10, "GQ", now) }),
        ...(sensor.pm25 === undefined ? {} : { pm25: observed(sensor.pm25, "GQ", now) }),
      });
      sensorEntities += 1;
    }
  }
  for (const [ags, bucket] of byMunicipality) {
    const pm10 = median(bucket.pm10);
    const pm25 = median(bucket.pm25);
    entities.push({
      id: `urn:ngsi-ld:AirQualityObserved:bw-sc-${ags}`,
      type: "AirQualityObserved",
      ags: { type: "Property", value: ags },
      sensorCount: observed(Math.max(bucket.pm10.length, bucket.pm25.length), "C62", now),
      // Timestamp so the dashboard recognises stale values: if the last sensor
      // of a municipality drops out or is discarded as implausible, the old
      // value would otherwise stand as supposedly current.
      dateObserved: { type: "Property", value: { "@type": "DateTime", "@value": now } },
      "@context": NGSI_CONTEXT,
      ...(pm10 === null ? {} : { pm10: observed(pm10, "GQ", now) }),
      ...(pm25 === null ? {} : { pm25: observed(pm25, "GQ", now) }),
    });
  }
  return { entities, sensorEntities, discarded, outside };
}

/** Pure — this is what the parity harness diffs against the old node. */
export function build(raw: SensorBox, geo: GeoIndex | null, now: IsoTime): readonly FeinstaubEntity[] {
  return summarize(raw, geo, now).entities;
}

/**
 * The medians change only marginally every 15 minutes — only real changes are
 * written. Over the measured values and the count, never `dateObserved`.
 * Single sensors carry no `dateObserved`, so an unchanged one is not written
 * at all.
 */
export function signatureOf(entity: FeinstaubEntity): string {
  const pm25 = entity.pm25 === undefined ? "" : String(entity.pm25.value);
  const pm10 = entity.pm10 === undefined ? "" : String(entity.pm10.value);
  const count = entity.sensorCount === undefined ? "" : String(entity.sensorCount.value);
  return `${pm25}|${pm10}|${count}`;
}

/** The status line of the old node, in English. */
export function statusText(result: FeinstaubResult): string {
  return (
    `${String(result.entities.length - result.sensorEntities)} municipalities with sensors · ` +
    `${String(result.sensorEntities)} single sensors` +
    (result.discarded > 0 ? ` · ${String(result.discarded)} implausible discarded` : "") +
    (result.outside > 0 ? ` · ${String(result.outside)} outside BW` : "")
  );
}

/* ------------------------------------------------------------------ run */

/** `scTakt` of the flow context, in `ctx.state`, persisted across restarts. */
export const CADENCE = stateKey("scTakt", () => 0, persisted.number);

/** Advances the run counter and says whether this run is a detail run (`takt === 0`). */
export function cadenceOf(ctx: Ctx): boolean {
  const cadence = ctx.state.slot(CADENCE);
  const takt = (cadence.get() + 1) % DETAIL_EVERY;
  cadence.set(takt);
  return takt === 0;
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
  // Master data and boundaries required: without polygons the run is skipped
  // instead of assigning by centroid.
  const geo = ctx.geo.forRun(LABEL);
  if (geo === null) return;

  const detailRun = cadenceOf(ctx);
  const result = summarize(
    { ...parse(response.body), detailRun, detailFor: ctx.entry.sensorDetailFor },
    geo,
    ctx.now(),
  );
  if (result.entities.length === 0) return;
  const status = statusText(result);
  ctx.log.status(status);

  await ctx.orion.upsertChanged(GATE_KEY, result.entities, signatureOf, {
    chunkSize: CHUNK_SIZE,
    // Municipal means of particulate matter: most move every run.
    volatile: true,
  });

  // Hourly (detail run: medians AND single sensors produced): remove own
  // entities not confirmed for 24 h, e.g. sensors outside BW that were counted
  // in a border municipality before the strict lookup.
  if (detailRun) {
    await ctx.prune.stale({
      label: LABEL,
      type: "AirQualityObserved",
      pattern: "^urn:ngsi-ld:AirQualityObserved:bw-(sc-[0-9]{8}|sensor-[0-9]{8}-[0-9]+)$",
      attrs: ["ags", "dateObserved", "pm10", "pm25"],
      keep: new Set(result.entities.map((entity) => entity.id)),
      graceMs: 24 * 3_600_000,
      signatureKey: GATE_KEY,
      intervalMs: ctx.intervalMs(DETAIL_EVERY),
      status,
    });
  }
}

/** Checked against the contract by the compiler, as every ported module is. */
export const connector: ConnectorModule<SensorBox, readonly FeinstaubEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
