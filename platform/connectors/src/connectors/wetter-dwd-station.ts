/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `wetter-dwd-station` — current observations of the official DWD stations in
 * Baden-Württemberg (via BrightSky), one `WeatherObserved` entity per station.
 *
 * Port of FN_DWD_STATIONEN and FN_DWD_BUILD in
 * scripts/generate-nodered-flows.py. The generator gives the reason for the
 * shape:
 *
 *   > Vorher: eine fest verdrahtete Abfrage für Reutlingen. Eine Abfrage je Gemeinde
 *   > wäre mit 1.103 Aufrufen alle 10 Minuten maßlos gegenüber einem frei
 *   > betriebenen Dienst. Stattdessen je DWD-Station eine Entität (197 in BW) —
 *   > das Dashboard wählt daraus die nächstgelegene, genau wie bei den Pegeln.
 *
 * The station list comes from BrightSky's `/sources` around the middle of the
 * state, filtered to `current`/`synop` stations inside a box around BW; each
 * station is then asked for its `current_weather`, one request per second (the
 * delay node "1 Anfrage/s", now the kernel's per-host bucket for
 * api.brightsky.dev, which is the default pace).
 *
 * The municipality is assigned strictly (polygon or nothing) and is OPTIONAL:
 * `ctx.geo.forRun("DWD", { boundaries: "optional" })`, the
 * `geo_helper("DWD", require_boundaries=False)` of the generator. A station is
 * useful without an `ags` — the dashboard picks the nearest one by location —
 * so the run does not wait for the boundaries; a station outside every polygon
 * simply carries no `ags`/`gemeindeName`. The master data rows, however, are
 * required, as the old node's `Array.isArray(GEM)` check was.
 *
 * ## Deliberate deviations
 *
 *  * One batch upsert (chunks of 150) after all stations answered, instead of
 *    one POST per station; the entities are identical, the write is ungated
 *    as before. Consequently one clock reading per run.
 *  * The master data check runs once, before any request; the old node
 *    checked (and warned) per station, after the requests.
 *  * A failed station request was an `[error]` of the http request node per
 *    station; here the failures are counted and reported in ONE `[warn]` per
 *    run. A station answering >= 400 or without `weather` is skipped silently,
 *    as before. No retries, as before.
 *  * Malformed data only: a source entry that is not an object, coordinates
 *    that are not numbers, a name that is not a string, and measured values
 *    that are not numbers count as absent.
 *  * Warning texts are English (the code language of this service).
 */

import { cleanText, dateObserved } from "../kernel/ngsi.js";
import {
  field,
  isArray,
  isFiniteNumber,
  isRecord,
  isString,
  isTruthy,
  optNumber,
  ParseError,
  requireRecord,
} from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  ConnectorModule,
  Ctx,
  EntityId,
  GeoIndex,
  GeoJsonPoint,
  HttpResponse,
  IsoTime,
  NgsiDateTime,
  NgsiEntity,
  Property,
} from "../kernel/types.js";
import { failureText, nodePayload } from "./http-payload.js";

export const ID = "wetter-dwd-station";

/** BrightSky source list around the middle of BW (radius 200 km). */
export const SOURCES_URL = "https://api.brightsky.dev/sources?lat=48.6&lon=9.0&max_dist=200000";

export function weatherUrl(stationId: string): string {
  return `https://api.brightsky.dev/current_weather?dwd_station_id=${stationId}`;
}

/** Box around Baden-Württemberg the old node filtered the sources with. */
const BOX = { south: 47.4, north: 49.9, west: 7.3, east: 10.7 } as const;

/** One DWD station of the run, `stationen[id]` of the old node. */
export interface Station {
  /** `dwd_station_id` as text (a number from the source is concatenated the same way). */
  readonly id: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
}

/** The six values FN_DWD_BUILD reads of `payload.weather`; `null` = not reported. */
export interface Weather {
  readonly temperature: number | null;
  readonly relativeHumidity: number | null;
  readonly pressureMsl: number | null;
  readonly windSpeed10: number | null;
  readonly windDirection10: number | null;
  readonly precipitation10: number | null;
}

export interface DwdRun {
  readonly stations: readonly Station[];
  /** Weather by station id; stations without an entry did not answer usably. */
  readonly observations: ReadonlyMap<string, Weather>;
}

export interface StationEntity extends NgsiEntity {
  readonly id: EntityId;
  readonly type: "WeatherObserved";
  readonly stationName: Property<string>;
  readonly dwdStationId: Property<string>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly dataProvider: Property<string>;
  readonly location: { readonly type: "GeoProperty"; readonly value: GeoJsonPoint };
  readonly "@context": string;
  readonly ags?: Property<string> | undefined;
  readonly gemeindeName?: Property<string> | undefined;
  readonly temperature?: Property<number> | undefined;
  readonly relativeHumidity?: Property<number> | undefined;
  readonly atmosphericPressure?: Property<number> | undefined;
  readonly windSpeed?: Property<number> | undefined;
  readonly windDirection?: Property<number> | undefined;
  readonly precipitation?: Property<number> | undefined;
}

/* ------------------------------------------------------------------ Stations */

/**
 * DWD liefert Namen teils in Versalien (DACHSBERG-WOLPADINGE) — für die Kachel
 * lesbar machen, Bindestrich-Teile einzeln.
 */
export function readableName(name: string): string {
  if (name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .replace(
      /(^|[\s\-/(])([a-zäöüß])/g,
      (_match, before: string, letter: string) => before + letter.toUpperCase(),
    );
}

function stationOf(raw: unknown): Station | null {
  if (!isRecord(raw)) return null;
  const id = raw.dwd_station_id;
  const lat = raw.lat;
  const lon = raw.lon;
  // `if (!id || !s.lat || !s.lon) continue;` — a latitude of 0 is out as well.
  if (!(isString(id) || isFiniteNumber(id)) || !isTruthy(id)) return null;
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon) || lat === 0 || lon === 0) return null;
  if (raw.observation_type !== "current" && raw.observation_type !== "synop") return null;
  if (lat < BOX.south || lat > BOX.north || lon < BOX.west || lon > BOX.east) return null;
  const text = String(id);
  const name = raw.station_name;
  return {
    id: text,
    name: readableName(isString(name) && name !== "" ? name : `Station ${text}`),
    lat,
    lon,
  };
}

/**
 * FN_DWD_STATIONEN: the BW stations of the source list, the first entry per
 * station winning. Loud when `payload.sources` is not an array.
 *
 * The ORDER is that of the old node's `Object.keys(stationen)`, not the order
 * of first appearance: JavaScript lists integer-like keys first, ascending,
 * so a station id without a leading zero (`13965`) is requested before
 * `02159`. Going through an object keeps that exactly.
 */
export function parseSources(payload: unknown): readonly Station[] {
  const sources = field(payload, "sources");
  if (!isArray(sources)) throw new ParseError("payload.sources", "array", sources);
  const byId = new Map<string, Station>();
  for (const source of sources) {
    const station = stationOf(source);
    if (station !== null && !byId.has(station.id)) byId.set(station.id, station);
  }
  const ordered: Station[] = [];
  for (const id of Object.keys(Object.fromEntries(byId))) {
    const station = byId.get(id);
    if (station !== undefined) ordered.push(station);
  }
  return ordered;
}

/* ------------------------------------------------------------------ Weather */

function measured(weather: unknown, key: string): number | null {
  return optNumber(field(weather, key)) ?? null;
}

/** `!msg.payload || !msg.payload.weather` → `null`. */
export function parseWeather(payload: unknown): Weather | null {
  const weather = field(payload, "weather");
  if (!isTruthy(weather)) return null;
  return {
    temperature: measured(weather, "temperature"),
    relativeHumidity: measured(weather, "relative_humidity"),
    pressureMsl: measured(weather, "pressure_msl"),
    windSpeed10: measured(weather, "wind_speed_10"),
    windDirection10: measured(weather, "wind_direction_10"),
    precipitation10: measured(weather, "precipitation_10"),
  };
}

/**
 * The bundle of one run as the parity harness hands it in:
 * `{ sources: <BrightSky /sources answer>, weather: { <station id>: <current_weather answer> } }`.
 * `run` fetches and narrows piece by piece instead.
 */
export function parse(raw: unknown): DwdRun {
  const record = requireRecord(raw, "run");
  const weather = requireRecord(record.weather, "run.weather");
  const observations = new Map<string, Weather>();
  for (const [id, answer] of Object.entries(weather)) {
    const parsed = parseWeather(answer);
    if (parsed !== null) observations.set(id, parsed);
  }
  return { stations: parseSources(record.sources), observations };
}

/* ------------------------------------------------------------------ Build */

/** FN_DWD_BUILD for one station; `null` when the station reports nothing. */
export function buildStation(
  station: Station,
  weather: Weather,
  geo: GeoIndex | null,
  now: IsoTime,
): StationEntity | null {
  // Strict: stations outside BW or without boundaries get no municipality.
  const municipality = geo?.municipalityAt(station.lat, station.lon) ?? null;
  const values: readonly (readonly [attribute: string, value: number | null, unitCode: string])[] = [
    ["temperature", weather.temperature, "CEL"],
    ["relativeHumidity", weather.relativeHumidity === null ? null : weather.relativeHumidity / 100, "P1"],
    ["atmosphericPressure", weather.pressureMsl, "A97"],
    ["windSpeed", weather.windSpeed10, "KMH"],
    ["windDirection", weather.windDirection10, "DD"],
    ["precipitation", weather.precipitation10, "MMT"],
  ];
  const measuredValues: Record<string, Property<number>> = {};
  for (const [attribute, value, unitCode] of values) {
    if (value === null) continue;
    measuredValues[attribute] = { type: "Property", value, unitCode, observedAt: now };
  }
  // "Station meldet gerade nichts"
  if (Object.keys(measuredValues).length === 0) return null;

  const name = cleanText(station.name);
  return {
    id: `urn:ngsi-ld:WeatherObserved:bw-dwd-${station.id}`,
    type: "WeatherObserved",
    stationName: { type: "Property", value: name },
    dwdStationId: { type: "Property", value: station.id },
    dateObserved: dateObserved(now),
    dataProvider: { type: "Property", value: `BrightSky/DWD (${name})` },
    location: { type: "GeoProperty", value: { type: "Point", coordinates: [station.lon, station.lat] } },
    "@context": NGSI_CONTEXT,
    ...(municipality === null
      ? {}
      : {
          ags: { type: "Property", value: municipality[0] },
          gemeindeName: { type: "Property", value: cleanText(municipality[1]) },
        }),
    ...measuredValues,
  };
}

/** Pure: one entity per station that answered and reports at least one value. */
export function build(raw: DwdRun, geo: GeoIndex | null, now: IsoTime): readonly StationEntity[] {
  const entities: StationEntity[] = [];
  for (const station of raw.stations) {
    const weather = raw.observations.get(station.id);
    if (weather === undefined) continue;
    const entity = buildStation(station, weather, geo, now);
    if (entity !== null) entities.push(entity);
  }
  return entities;
}

/* ------------------------------------------------------------------ Run */

export async function run(ctx: Ctx): Promise<void> {
  const geo = ctx.geo.forRun("DWD", { boundaries: "optional" });
  if (geo === null) return; // already logged

  let sourcesResponse: HttpResponse;
  try {
    sourcesResponse = await ctx.fetch.text(SOURCES_URL, { retries: 0 });
  } catch (error) {
    ctx.log.warn(`DWD stations: source list not loadable (${failureText(error)})`);
    return;
  }
  let stations: readonly Station[] | null = null;
  if (sourcesResponse.status < 400) {
    try {
      stations = parseSources(nodePayload(sourcesResponse));
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
    }
  }
  if (stations === null) {
    // The old node printed the status here too, a 200 without `sources` included.
    ctx.log.warn(`DWD stations: source list not loadable (${String(sourcesResponse.status)})`);
    return;
  }
  if (stations.length === 0) {
    ctx.log.warn("DWD stations: no BW station found");
    return;
  }
  ctx.log.status(`${String(stations.length)} BW stations`);

  const observations = new Map<string, Weather>();
  let failed = 0;
  for (const station of stations) {
    if (ctx.signal.aborted) return;
    let response: HttpResponse;
    try {
      // Paced by the kernel's bucket for api.brightsky.dev: one per second.
      response = await ctx.fetch.text(weatherUrl(station.id), { retries: 0 });
    } catch {
      failed += 1;
      continue;
    }
    if (response.status >= 400) continue;
    const weather = parseWeather(nodePayload(response));
    if (weather !== null) observations.set(station.id, weather);
  }
  if (failed > 0) {
    ctx.log.warn(`DWD stations: ${String(failed)} of ${String(stations.length)} station requests failed`);
  }

  const entities = build({ stations, observations }, geo, ctx.now());
  if (entities.length === 0) return;
  // Ungated, as the old upsert node had no commit node behind it.
  await ctx.orion.upsert(ctx.gate.ungated(entities));
}

export const connector: ConnectorModule<DwdRun, readonly StationEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
