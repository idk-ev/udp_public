/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `uba-bw` — air quality of all active UBA stations in Baden-Württemberg.
 *
 * Port of the five nodes `udp-rt-bu-*` in scripts/generate-nodered-flows.py:
 * the station list (`udp-rt-bu-stations`), the selection of the active DEBW
 * stations (`udp-rt-bu-msgs`, {@link planRequests}), one airquality request
 * per station behind a "1 Anfrage/s" delay, the wrapper `udp-rt-bu-wrap`
 * ({@link wrapResponse}), the join and the build node `udp-rt-bu-build`
 * ({@link parse} + {@link build}). One `AirQualityObserved:bw-uba-<code>` per
 * station with the newest value of each component within the last 24 h.
 *
 * ## The one centroid fallback of the service
 *
 * Every other connector assigns strictly — polygon or nothing — and the kernel
 * deliberately has no centroid lookup (see `GeoIndex` in src/kernel/types.ts):
 * the former fallback put rental bikes from Basel into Lörrach. This connector
 * keeps it, in {@link nearestOrCentroid} on top of `geo.municipalities`, and it
 * is allowed here for the reason the generator gives (CENTROID_FALLBACK): the
 * stations are pre-selected by their `DEBW` code and are therefore guaranteed
 * to lie in Baden-Württemberg. A station that falls into a sliver between
 * simplified polygons, or a run during a boundary outage, should still get its
 * municipality rather than none — there is no Basel to be wrongly counted in.
 * `udp-rt-bu-build` is the only entry on the whitelist of the static flow tests
 * (tests/static/flow-invarianten.test.js), and this module is its port.
 * Hence the run declares `boundaries: "optional"`: without boundaries every
 * station is assigned by centroid, as before.
 *
 * ## Fan-out and the join
 *
 * The old flow sent the ~40 station requests through a delay node (one per
 * second, requests overlapping when UBA was slow) into a `join` with a 150 s
 * timeout. A timed-out join emitted the parts it had, and the stragglers then
 * formed a second group that was built and written on its own 150 s later —
 * so in the end every answered station was written. The port therefore waits
 * for every request instead of cutting off at 150 s: the requests are paced by
 * the token bucket of the host (the delay node), at most
 * {@link MAX_IN_FLIGHT} overlap, each is bounded by the fetcher's timeout, and
 * the run is bounded by their number. One write instead of two, same content.
 * Each station request is sent once (`retries: 0`), as the `http request` node
 * did; a failed one is skipped like a non-ok part was. The count of failed
 * stations goes into the status line, not into a warning — the old flow did
 * not warn for them either, and the health check counts warnings.
 *
 * No change gate and no prune: the old build node wrote every station in full
 * every hour and carried no `dateObserved` (freshness comes from `observedAt`).
 */

import { cleanText, observed } from "../kernel/ngsi.js";
import { isArray, isRecord, isTruthy } from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  ConnectorModule,
  Ctx,
  GeoIndex,
  GeoJsonPoint,
  IsoTime,
  JsonResponse,
  JsonValue,
  MunicipalityRow,
  NgsiEntity,
  Property,
} from "../kernel/types.js";

export const ID = "uba-bw";

export const STATIONS_URL =
  "https://www.umweltbundesamt.de/api/air_data/v3/stations/json?use=airquality&lang=de";

const AIRQUALITY_URL = "https://www.umweltbundesamt.de/api/air_data/v3/airquality/json";

/** Log prefix, as the old warnings read (`UBA-BW: …`). */
const LABEL = "UBA-BW";

/** As the build node: `emitChunks(node, msg, entities, 100)`. */
const CHUNK_SIZE = 100;

/**
 * Station requests in flight at once. The delay node released one request per
 * second and let slow ones overlap without a bound; the token bucket paces the
 * starts the same way, and this caps the overlap.
 */
const MAX_IN_FLIGHT = 8;

/** UBA component ids of the airquality rows, as the build node's `COMP`. */
const COMPONENTS: ReadonlyMap<string, string> = new Map([
  ["1", "pm10"],
  ["2", "co"],
  ["3", "o3"],
  ["4", "so2"],
  ["5", "no2"],
  ["9", "pm25"],
]);

/** One selected station, as `udp-rt-bu-msgs` put it on the request message. */
export interface UbaStation {
  /** Column 0, the numeric station id as the API keys it (`"286"`). */
  readonly id: string;
  /** Column 1, e.g. `"DEBW084"` — the entity id is built from it. */
  readonly code: string;
  /** Column 2, raw (cleaned when the entity is built). */
  readonly name: string;
  /** `parseFloat` of columns 7 and 8; `NaN` for garbage, as before. */
  readonly lon: number;
  readonly lat: number;
}

/** One airquality request of the fan-out. */
export interface UbaRequest {
  readonly url: string;
  readonly station: UbaStation;
}

/**
 * One wrapped airquality answer — the payload `udp-rt-bu-wrap` hands to the
 * join: `{ station, ok, data }`. This array, in request order, is the raw
 * input of {@link parse}.
 */
export interface UbaPart {
  readonly station: UbaStation;
  readonly ok: boolean;
  readonly data: unknown;
}

/**
 * A row of the airquality series: `[dateEnd, totalIndex, incomplete,
 * [componentId, value, index, yValue], …]` — only what the build node reads.
 */
interface SeriesRow {
  /** Column 1, the total index; `undefined` for null/absent (the node skipped both). */
  readonly index: JsonValue | undefined;
  readonly components: readonly (readonly [componentId: string, value: JsonValue | undefined])[];
}

/** One station with its measurements, newest row first, as the build node walked them. */
export interface StationSeries {
  readonly station: UbaStation;
  readonly rows: readonly SeriesRow[];
}

export interface UbaEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:AirQualityObserved:bw-uba-${string}`;
  readonly type: "AirQualityObserved";
  readonly ags: Property<string>;
  readonly stationName: Property<string>;
  readonly location: { readonly type: "GeoProperty"; readonly value: GeoJsonPoint };
  readonly airQualityIndex?: Property | undefined;
  readonly "@context": string;
}

/* ------------------------------------------------------------------ helpers */

/** `parseFloat(x)` of the old nodes, for any value: `ToString`, then parse. */
function parseFloatOf(value: unknown): number {
  return Number.parseFloat(String(value));
}

/** JavaScript's `String(x)` / `'' + x` for a foreign value, exactly as the old node coerced it. */
function jsString(value: unknown): string {
  return String(value);
}

/** `String(s == null ? '' : s)` — the argument of the old `clean`. */
function textOf(value: unknown): string {
  return value === null || value === undefined ? "" : jsString(value);
}

/**
 * A value out of `JSON.parse`, narrowed to the JSON type it already is.
 * `undefined` for anything that is not JSON (never the case for a parsed body).
 */
function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (isArray(value)) {
    const out: JsonValue[] = [];
    for (const element of value) {
      const narrowed = jsonValue(element);
      if (narrowed === undefined) return undefined;
      out.push(narrowed);
    }
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, element] of Object.entries(value)) {
      const narrowed = jsonValue(element);
      if (narrowed === undefined) return undefined;
      out[key] = narrowed;
    }
    return out;
  }
  return undefined;
}

/** `d.toISOString().slice(0, 10)` of the old node. */
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ fan-out plan */

/**
 * Port of `udp-rt-bu-msgs`: one request per ACTIVE Baden-Württemberg station —
 * code starting with `DEBW` and no end date in column 6 — for the last 24 h
 * (`date_from` yesterday, `date_to` today, UTC days as `toISOString` gives
 * them). `null` when the list is unusable (the node warned and stopped).
 *
 * Station order is `Object.keys(payload.data)`: the ids are integer-like keys,
 * so the engine walks them in ascending numeric order — the same order the
 * parsed body has here.
 */
export function planRequests(stationList: unknown, nowMs: number): readonly UbaRequest[] | null {
  if (!isRecord(stationList)) return null;
  const data = stationList.data;
  // `!msg.payload.data`: any truthy value passes. Object.keys of a truthy
  // primitive yields no station rows, so only objects and arrays matter.
  if (!isTruthy(data)) return null;
  if (!isRecord(data) && !isArray(data)) return [];
  const from = isoDay(nowMs - 24 * 3_600_000);
  const to = isoDay(nowMs);
  const requests: UbaRequest[] = [];
  for (const entry of Object.values(data)) {
    // [id, code, name, city, synonym, von, bis, lon, lat, ...]
    if (!isArray(entry)) continue;
    const code = entry[1];
    // `!String(s[1] || '').startsWith('DEBW') || s[6]`: BW only, and no end date.
    if (!String(isTruthy(code) ? code : "").startsWith("DEBW") || isTruthy(entry[6])) continue;
    const id = String(entry[0]);
    requests.push({
      url:
        `${AIRQUALITY_URL}?date_from=${from}&time_from=1&date_to=${to}&time_to=24&station=` +
        // `'&station=' + s[0]`: string concatenation of the raw column.
        id,
      station: {
        id,
        code: String(code),
        name: textOf(entry[2]),
        lon: parseFloatOf(entry[7]),
        lat: parseFloatOf(entry[8]),
      },
    });
  }
  return requests;
}

/**
 * Port of `udp-rt-bu-wrap`: `{ station, ok: !(statusCode >= 400), data:
 * (payload && payload.data) || null }`. `status: null` is a request that
 * produced no response (the node saw a non-numeric status code, which is not
 * `>= 400`, and an error string as payload, which has no `data`).
 */
export function wrapResponse(station: UbaStation, status: number | null, body: unknown): UbaPart {
  const data = isRecord(body) ? body.data : undefined;
  return { station, ok: !(status !== null && status >= 400), data: isTruthy(data) ? data : null };
}

/* ------------------------------------------------------------------ parse / build */

function parseStation(raw: unknown): UbaStation | null {
  if (!isRecord(raw)) return null;
  const lon = raw.lon;
  const lat = raw.lat;
  return {
    id: textOf(raw.id),
    code: textOf(raw.code),
    name: textOf(raw.name),
    lon: typeof lon === "number" ? lon : Number.NaN,
    lat: typeof lat === "number" ? lat : Number.NaN,
  };
}

function parseRow(raw: unknown): SeriesRow | null {
  if (!isArray(raw)) return null;
  const index = raw[1];
  const components: (readonly [componentId: string, value: JsonValue | undefined])[] = [];
  for (let i = 3; i < raw.length; i += 1) {
    const component = raw[i];
    // `row[i][0]` on a non-array: the old node would have thrown on null and
    // read `undefined` on anything else; neither names a component.
    if (!isArray(component)) continue;
    const value = component[1];
    // `row[i][1] !== null`: null is "no value", and so is a missing one here
    // (the node would have stored undefined, which JSON cannot carry).
    components.push([String(component[0]), value === null ? undefined : jsonValue(value)]);
  }
  return { index: index === null ? undefined : jsonValue(index), components };
}

/**
 * Narrows the joined parts (`msg.payload` of the build node) to the stations
 * with a usable series. Lenient like the node: a part that is not ok, has no
 * data or no series for its own station is skipped (`continue`).
 */
export function parse(raw: unknown): readonly StationSeries[] {
  if (!isArray(raw)) throw new Error("UBA-BW: joined parts are not an array");
  const out: StationSeries[] = [];
  for (const part of raw) {
    if (!isRecord(part) || part.ok !== true) continue;
    const station = parseStation(part.station);
    if (station === null) continue;
    const data = part.data;
    if (!isRecord(data)) continue;
    const series = data[station.id];
    if (!isRecord(series)) continue;
    // `Object.keys(series).sort().reverse()`: newest start time first.
    const stamps = Object.keys(series).sort().reverse();
    const rows: SeriesRow[] = [];
    for (const stamp of stamps) {
      const row = parseRow(series[stamp]);
      if (row !== null) rows.push(row);
    }
    out.push({ station, rows });
  }
  return out;
}

/**
 * CENTROID_FALLBACK of the generator — allowed for this connector only (see
 * the module header): the strict polygon hit if there is one, else the
 * municipality whose centre is nearest, longitude scaled by 0.66 (≈ cos 48.5°).
 * `null` only without master data or for non-finite coordinates.
 */
export function nearestOrCentroid(geo: GeoIndex, lat: number, lon: number): MunicipalityRow | null {
  const hit = geo.municipalityAt(lat, lon);
  if (hit !== null) return hit;
  let best: MunicipalityRow | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of geo.municipalities) {
    const dy = row[2] - lat;
    const dx = (row[3] - lon) * 0.66;
    const distance = dy * dy + dx * dx;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = row;
    }
  }
  return best;
}

/**
 * Pure: the newest total index and the newest value of each component per
 * station, walking the rows from the newest start time backwards. A station
 * with neither is left out. `geo` null (not a case `run` produces) means no
 * assignment: `ags` is empty, as for an empty master data list.
 */
export function build(
  raw: readonly StationSeries[],
  geo: GeoIndex | null,
  now: IsoTime,
): readonly UbaEntity[] {
  const entities: UbaEntity[] = [];
  for (const { station, rows } of raw) {
    const latest = new Map<string, JsonValue>();
    let index: JsonValue | undefined;
    for (const row of rows) {
      if (index === undefined && row.index !== undefined) index = row.index;
      for (const [componentId, value] of row.components) {
        const name = COMPONENTS.get(componentId);
        if (name !== undefined && !latest.has(name) && value !== undefined) latest.set(name, value);
      }
    }
    if (index === undefined && latest.size === 0) continue;
    const municipality = geo === null ? null : nearestOrCentroid(geo, station.lat, station.lon);
    const components: Record<string, Property> = {};
    for (const [name, value] of latest) components[name] = observed(value, "GQ", now);
    entities.push({
      id: `urn:ngsi-ld:AirQualityObserved:bw-uba-${station.code}`,
      type: "AirQualityObserved",
      ags: { type: "Property", value: municipality === null ? "" : municipality[0] },
      stationName: { type: "Property", value: cleanText(station.name) },
      location: { type: "GeoProperty", value: { type: "Point", coordinates: [station.lon, station.lat] } },
      "@context": NGSI_CONTEXT,
      // `P(aqi, '')`: an empty unit code, not an absent one.
      ...(index === undefined ? {} : { airQualityIndex: observed(index, "", now) }),
      ...components,
    });
  }
  return entities;
}

/* ------------------------------------------------------------------ run */

/**
 * Runs `work` over `items` with at most `limit` in flight, results in item
 * order. The pacing itself is the token bucket inside the fetcher; this only
 * bounds how many answers may be outstanding. Stops starting new items once
 * `signal` is aborted (their result is `undefined`).
 */
async function inOrder<T, R>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  work: (item: T) => Promise<R>,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = items.map(() => undefined);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length && !signal.aborted) {
      const at = next;
      next += 1;
      const item = items[at];
      if (item !== undefined) results[at] = await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

export async function run(ctx: Ctx): Promise<void> {
  let list: JsonResponse;
  try {
    list = await ctx.fetch.json(STATIONS_URL);
  } catch (error) {
    ctx.log.warn(
      `${LABEL}: station list not loadable (${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }
  const requests = list.ok ? planRequests(list.body, Date.parse(ctx.now())) : null;
  if (requests === null) {
    ctx.log.warn(`${LABEL}: station list not loadable (${String(list.status)})`);
    return;
  }
  ctx.log.status(`${String(requests.length)} BW stations`);

  const answers = await inOrder(requests, MAX_IN_FLIGHT, ctx.signal, async (request) => {
    try {
      const response = await ctx.fetch.json(request.url, { retries: 0 });
      return wrapResponse(request.station, response.status, response.body);
    } catch {
      // Timeout, refused connection, or a body that is not JSON: the old
      // part then had no usable `data` and was skipped by the build node.
      return wrapResponse(request.station, null, null);
    }
  });
  const parts = answers.filter((part): part is UbaPart => part !== undefined);
  const failed = parts.filter((part) => !part.ok || part.data === null).length;

  // As the build node: the master data are required, the boundaries are not —
  // without them every station goes by centroid (see the module header).
  const geo = ctx.geo.forRun(LABEL, { boundaries: "optional" });
  if (geo === null) return;

  const entities = build(parse(parts), geo, ctx.now());
  if (entities.length === 0) return;
  ctx.log.status(
    `${String(entities.length)} stations` + (failed > 0 ? ` (${String(failed)} requests without data)` : ""),
  );
  // Written in full every hour, as before: the old flow had no gate here.
  await ctx.orion.upsert(ctx.gate.ungated(entities), { chunkSize: CHUNK_SIZE });
}

/** Checked against the contract by the compiler, as every ported module is. */
export const connector: ConnectorModule<readonly StationSeries[], readonly UbaEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
