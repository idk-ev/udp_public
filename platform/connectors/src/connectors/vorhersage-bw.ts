/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `vorhersage-bw` — four-day forecast for every municipality of
 * Baden-Württemberg.
 *
 * Port of the node chain `udp-rt-bv-*` (FN_FC_BATCH, FN_WX_WRAP, FN_FC_BUILD in
 * scripts/generate-nodered-flows.py). The original explains the design:
 *
 *   > Ein Aufruf trägt ~140 Koordinaten; 8 Aufrufe je Lauf, 96 am Tag — die
 *   > Stufe-3-Vorhersage kostet damit landesweit weniger als früher die eine
 *   > stündliche Einzelabfrage für Reutlingen.
 *
 * The fan-out, its 15 s pacing and the join semantics (partial groups after
 * 240 s, late batches as a group of their own) live in ./open-meteo-batches.ts,
 * shared with `wetter-bw`, and are explained there. Like `wetter-bw` this
 * connector fetches `bw-gemeinden.json` itself and needs no geo context; unlike
 * it, it does not write the rows into the context. No change gate (CHUNK_HELPER
 * is spliced in, `gateChanged` never called): every run writes every entity, in
 * chunks of 100. `refireOnRestart: false` — delayed first run, see the
 * scheduler.
 *
 * Deliberate difference, only for input the source does not produce: a location
 * with malformed values (a daily series shorter than `time`, a missing
 * `tomorrow` value, a string where a number belongs) is skipped and counted with
 * a warning. The old node would have sent `undefined` values — or thrown on a
 * missing series and lost the whole group.
 */

import {
  ParseError,
  field,
  isArray,
  isRecord,
  isTruthy,
  requireArray,
  requireNumber,
  requireString,
} from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  Ags,
  ConnectorModule,
  Ctx,
  GeoIndex,
  IsoTime,
  MunicipalityRow,
  NgsiDateTime,
  NgsiEntity,
  Property,
} from "../kernel/types.js";
import {
  DEFAULT_JOIN_TIMING,
  OPEN_METEO_FORECAST_URL,
  UPSERT_CHUNK_SIZE,
  agsListOf,
  coordinateQuery,
  fetchBatch,
  joinGroups,
  loadMunicipalities,
  locationsOf,
  measurement,
  sliceBatches,
} from "./open-meteo-batches.js";
import type { BatchBody, JoinTiming } from "./open-meteo-batches.js";

export const ID = "vorhersage-bw";

/** Prefix of the warnings; the old nodes said `BW-Vorhersage:`. */
const LABEL = "BW forecast";

const QUERY =
  "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,uv_index_max," +
  "weather_code,sunrise,sunset" +
  "&current=apparent_temperature,uv_index" +
  "&forecast_days=4&timezone=Europe%2FBerlin";

const DATA_PROVIDER = "Open-Meteo (CC-BY 4.0)";

/* ------------------------------------------------------------------ batches */

export interface ForecastBatch {
  readonly url: string;
  readonly agsList: readonly Ags[];
}

/** FN_FC_BATCH as a pure function of the rows. */
export function planBatches(rows: readonly MunicipalityRow[]): readonly ForecastBatch[] {
  return sliceBatches(rows).map((part) => ({
    url: `${OPEN_METEO_FORECAST_URL}${coordinateQuery(part)}${QUERY}`,
    agsList: agsListOf(part),
  }));
}

/* ------------------------------------------------------------------ parsing */

/**
 * One day of the `days` compound, exactly the positions of the old node:
 * `[d, min, max, precipitation_sum, wind_speed_10m_max, uv_index_max,
 * weather_code]`. The names are what the dashboard's reader of `days` needs.
 */
export type ForecastDay = readonly [
  date: string,
  tempMin: number | null,
  tempMax: number | null,
  precipitation: number | null,
  windSpeedMax: number | null,
  uvIndexMax: number | null,
  /**
   * `(dl.weather_code || [])[j]`: `undefined` in the old node when the series
   * is missing or short, which JSON writes as `null` inside an array — so
   * `null` here is byte-identical on the wire.
   */
  weatherCode: number | null,
];

export interface ForecastLocation {
  readonly days: readonly ForecastDay[];
  /** Index 1 of the daily series. */
  readonly tomorrowTempMax: number | null;
  readonly tomorrowTempMin: number | null;
  readonly tomorrowPrecipitation: number | null;
  /** `null` = attribute omitted (`cur.apparent_temperature != null`). */
  readonly apparentTemperature: number | null;
  readonly uvIndex: number | null;
  /** `HH:MM` of the first day, or `null` = omitted. */
  readonly sunrise: string | null;
  readonly sunset: string | null;
}

export interface ForecastPart {
  readonly agsList: readonly Ags[];
  readonly data: readonly (ForecastLocation | null)[];
}

export interface ForecastParts {
  readonly parts: readonly ForecastPart[];
  /** Locations dropped as malformed (see the module comment). */
  readonly malformed: number;
}

/** Element `j` of a daily series that must cover every day. */
function dayValue(series: readonly unknown[], j: number, at: string): number | null {
  if (j >= series.length) throw new ParseError(`${at}[${String(j)}]`, "a value for every day", undefined);
  return measurement(series[j], `${at}[${String(j)}]`);
}

/** `x => (x || '').slice(11, 16)` on the first entry, if that is truthy. */
function clockOfFirst(raw: unknown, at: string): string | null {
  if (!isTruthy(raw)) return null;
  const first = requireArray(raw, at)[0];
  if (!isTruthy(first)) return null;
  return requireString(first, `${at}[0]`).slice(11, 16);
}

/** `x != null` on a current value: included whenever it is not null/undefined. */
function optionalCurrent(value: unknown, at: string): number | null {
  return value === undefined || value === null ? null : requireNumber(value, at);
}

/**
 * One Open-Meteo location. `null` where the build node skipped it —
 * `if (!dl || !Array.isArray(dl.time) || !dl.time.length) return;`. Throws
 * {@link ParseError} on malformed values.
 */
export function parseLocation(raw: unknown): ForecastLocation | null {
  const daily = field(raw, "daily");
  const time = field(daily, "time");
  if (!isTruthy(daily) || !isArray(time) || time.length === 0) return null;
  if (!isRecord(daily)) throw new ParseError("daily", "object", daily);

  const series = (key: string): readonly unknown[] => requireArray(daily[key], `daily.${key}`);
  const tempMin = series("temperature_2m_min");
  const tempMax = series("temperature_2m_max");
  const precipitation = series("precipitation_sum");
  const windSpeedMax = series("wind_speed_10m_max");
  const uvIndexMax = series("uv_index_max");
  // `(dl.weather_code || [])[j]`: an absent series is allowed, a non-array is not.
  const weatherCode = isTruthy(daily.weather_code) ? series("weather_code") : [];

  const days = time.map<ForecastDay>((date, j) => {
    const code = weatherCode[j];
    return [
      requireString(date, `daily.time[${String(j)}]`),
      dayValue(tempMin, j, "daily.temperature_2m_min"),
      dayValue(tempMax, j, "daily.temperature_2m_max"),
      dayValue(precipitation, j, "daily.precipitation_sum"),
      dayValue(windSpeedMax, j, "daily.wind_speed_10m_max"),
      dayValue(uvIndexMax, j, "daily.uv_index_max"),
      code === undefined ? null : measurement(code, `daily.weather_code[${String(j)}]`),
    ];
  });

  // `loc.current || {}`: a missing or non-object `current` omits both values.
  const current = field(raw, "current");
  return {
    days,
    // `dl.temperature_2m_max[1]` etc. — a one-day series would send `undefined`.
    tomorrowTempMax: dayValue(tempMax, 1, "daily.temperature_2m_max"),
    tomorrowTempMin: dayValue(tempMin, 1, "daily.temperature_2m_min"),
    tomorrowPrecipitation: dayValue(precipitation, 1, "daily.precipitation_sum"),
    apparentTemperature: optionalCurrent(
      field(current, "apparent_temperature"),
      "current.apparent_temperature",
    ),
    uvIndex: optionalCurrent(field(current, "uv_index"), "current.uv_index"),
    sunrise: clockOfFirst(daily.sunrise, "daily.sunrise"),
    sunset: clockOfFirst(daily.sunset, "daily.sunset"),
  };
}

function parseLocations(items: readonly unknown[]): {
  readonly data: (ForecastLocation | null)[];
  readonly malformed: number;
} {
  const data: (ForecastLocation | null)[] = [];
  let malformed = 0;
  for (const item of items) {
    try {
      data.push(parseLocation(item));
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      // Keep the position: data[i] must stay aligned with agsList[i].
      data.push(null);
      malformed += 1;
    }
  }
  return { data, malformed };
}

/** The wrap node ("bündeln"), see `wetter-bw`'s `partOf`. */
export function partOf(batch: ForecastBatch, body: BatchBody): { part: ForecastPart; malformed: number } {
  if (!body.ok) return { part: { agsList: batch.agsList, data: [] }, malformed: 0 };
  const { data, malformed } = parseLocations(locationsOf(body.body));
  return { part: { agsList: batch.agsList, data }, malformed };
}

/**
 * The joined array as the build node received it. Parts that are not objects
 * or carry no `agsList` are skipped (`if (!part || !part.agsList) continue;`);
 * the rest is this service's own structure and is narrowed strictly.
 */
export function parse(raw: unknown): ForecastParts {
  const items = requireArray(raw, "joined parts");
  const parts: ForecastPart[] = [];
  let malformed = 0;
  items.forEach((item, index) => {
    const at = `joined parts[${String(index)}]`;
    if (!isTruthy(item) || !isTruthy(field(item, "agsList"))) return;
    const agsList = requireArray(field(item, "agsList"), `${at}.agsList`).map((ags, i) =>
      requireString(ags, `${at}.agsList[${String(i)}]`),
    );
    const parsed = parseLocations(requireArray(field(item, "data"), `${at}.data`));
    malformed += parsed.malformed;
    parts.push({ agsList, data: parsed.data });
  });
  return { parts, malformed };
}

/* ------------------------------------------------------------------ build */

/** A measured value with unit, as the old node wrote it (`unitCode` present). */
interface Measured<T extends number | null> {
  readonly type: "Property";
  readonly value: T;
  readonly unitCode: string;
  readonly observedAt: IsoTime;
}

export interface WeatherForecastEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:WeatherForecast:bw-${string}`;
  readonly type: "WeatherForecast";
  readonly ags: Property<string>;
  readonly dateObserved: Property<NgsiDateTime>;
  /** No `unitCode` key at all — unlike the measured values. */
  readonly days: {
    readonly type: "Property";
    readonly value: readonly ForecastDay[];
    readonly observedAt: IsoTime;
  };
  readonly tomorrowTempMax: Measured<number | null>;
  readonly tomorrowTempMin: Measured<number | null>;
  readonly tomorrowPrecipitation: Measured<number | null>;
  readonly dataProvider: Property<string>;
  readonly "@context": string;
  readonly apparentTemperature?: Measured<number> | undefined;
  readonly uvIndex?:
    { readonly type: "Property"; readonly value: number; readonly observedAt: IsoTime } | undefined;
  readonly sunrise?: Property<string> | undefined;
  readonly sunset?: Property<string> | undefined;
}

function measured<T extends number | null>(value: T, unitCode: string, now: IsoTime): Measured<T> {
  return { type: "Property", value, unitCode, observedAt: now };
}

/** FN_FC_BUILD. Pure: no network, no clock — this is what parity diffs. */
export function build(
  raw: ForecastParts,
  _geo: GeoIndex | null,
  now: IsoTime,
): readonly WeatherForecastEntity[] {
  const entities: WeatherForecastEntity[] = [];
  for (const part of raw.parts) {
    part.agsList.forEach((ags, i) => {
      const loc = part.data[i];
      if (loc === undefined || loc === null) return;
      entities.push({
        id: `urn:ngsi-ld:WeatherForecast:bw-${ags}`,
        type: "WeatherForecast",
        ags: { type: "Property", value: ags },
        dateObserved: { type: "Property", value: { "@type": "DateTime", "@value": now } },
        days: { type: "Property", value: loc.days, observedAt: now },
        tomorrowTempMax: measured(loc.tomorrowTempMax, "CEL", now),
        tomorrowTempMin: measured(loc.tomorrowTempMin, "CEL", now),
        tomorrowPrecipitation: measured(loc.tomorrowPrecipitation, "MMT", now),
        dataProvider: { type: "Property", value: DATA_PROVIDER },
        "@context": NGSI_CONTEXT,
        // Apparent temperature, UV and sun times: "bisher Stufe-3-Vorrecht
        // einer einzigen Stadt, jetzt Teil der Landesbasis".
        ...(loc.apparentTemperature === null
          ? {}
          : { apparentTemperature: measured(loc.apparentTemperature, "CEL", now) }),
        ...(loc.uvIndex === null
          ? {}
          : { uvIndex: { type: "Property", value: loc.uvIndex, observedAt: now } }),
        ...(loc.sunrise === null ? {} : { sunrise: { type: "Property", value: loc.sunrise } }),
        ...(loc.sunset === null ? {} : { sunset: { type: "Property", value: loc.sunset } }),
      });
    });
  }
  return entities;
}

/* ------------------------------------------------------------------ run */

/** `run` with the join timing injectable — the tests cannot wait 240 s. */
export async function runWith(ctx: Ctx, timing: JoinTiming): Promise<void> {
  const rows = await loadMunicipalities(ctx, LABEL);
  if (rows === null) return;

  const batches = planBatches(rows);
  // All calls are started at once and queue in the token bucket in batch
  // order, one per 15 s — the delay node's queue.
  const tasks = batches.map(async (batch) => partOf(batch, await fetchBatch(ctx, batch.url)));

  const summary = await joinGroups(tasks, timing, ctx.signal, async (group) => {
    if (group.closedBy === "timeout") {
      ctx.log.warn(
        `${LABEL}: join timeout after ${String(timing.timeoutMs / 1000)} s — writing a partial result of ` +
          `${String(group.parts.length)}/${String(batches.length)} batches, late batches follow as their own group`,
      );
    } else if (group.sequence > 0) {
      ctx.log.info(`${LABEL}: ${String(group.parts.length)} late batches arrived after the join timeout`);
    }
    const malformed = group.parts.reduce((sum, entry) => sum + entry.malformed, 0);
    if (malformed > 0) ctx.log.warn(`${LABEL}: ${String(malformed)} malformed Open-Meteo locations skipped`);

    // The build node read its own clock after the join; so does the port.
    const entities = build({ parts: group.parts.map((entry) => entry.part), malformed }, null, ctx.now());
    if (entities.length === 0) {
      ctx.log.warn(`${LABEL}: no entities`);
      return;
    }
    ctx.log.status(`${String(entities.length)} municipalities with a 4-day forecast`);
    const result = await ctx.orion.upsert(ctx.gate.ungated(entities), { chunkSize: UPSERT_CHUNK_SIZE });
    ctx.log.info(
      `${String(result.entities)} WeatherForecast upserted in ${String(result.chunks)} chunks ` +
        `(${String(result.failedChunks)} failed)`,
    );
  });
  if (summary.abandoned > 0) {
    ctx.log.warn(`${LABEL}: shutdown — ${String(summary.abandoned)} fetched batches not written`);
  }
}

export async function run(ctx: Ctx): Promise<void> {
  await runWith(ctx, DEFAULT_JOIN_TIMING);
}

/** Checked against the contract by the compiler, as every ported module is. */
export const connector: ConnectorModule<ForecastParts, readonly WeatherForecastEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
