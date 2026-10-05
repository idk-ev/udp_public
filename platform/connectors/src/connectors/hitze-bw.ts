/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `hitze-bw` — DWD thermal hazard index (heat stress) for the five
 * Baden-Württemberg representative cities.
 *
 * Port of FN_HITZE (`udp-rt-hz-fn`) from the former Node-RED flow generator (see git history). The
 * generator's note: a health-relevant summer warning, clean JSON (`gt.json`),
 * city-based — the dashboard picks the nearest of the five, as it does for the
 * DWD stations and the gauges. Hence the fixed coordinates below and no
 * municipality lookup.
 *
 * No change gate and no chunking: five entities, written in full in one
 * request twice a day, as the old upsert node did.
 *
 * Deliberate differences:
 *
 *  * The day the forecast is for: DWD updates `gt.json` at about 07:30 local
 *    time, so a run before that fetched YESTERDAY's file and stamped it with
 *    today's `dateObserved` — the page then showed yesterday's "today". Now
 *    `forecastDay` carries the file's `forecast_day` (the day "today" means),
 *    and `dateObserved` is the file's `last_update` (Berlin local time); only
 *    without it the run time, as before. The cron moved from `5 6,11 * * *`
 *    to `40 7,11 * * *` (registry), after the morning update.
 *
 * And two only for input the source does not produce:
 *
 *  * The city and level tables are `Map`s, not object literals —
 *    `CITIES["constructor"]` would find something on an object literal.
 *  * A content entry that is not an object, or whose level is neither a string
 *    nor empty, is skipped and counted with a warning ({@link parse}). The old
 *    node crashed on the former and wrote the latter as it came.
 */

import {
  ParseError,
  field,
  isArray,
  isString,
  isTruthy,
  mapLenient,
  optString,
  requireArray,
  requireRecord,
} from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  ConnectorModule,
  Ctx,
  GeoIndex,
  GeoJsonPoint,
  IsoTime,
  NgsiDateTime,
  NgsiEntity,
  Property,
} from "../kernel/types.js";

export const ID = "hitze-bw";

export const SOURCE_URL = "https://opendata.dwd.de/climate_environment/health/alerts/gt.json";

const DATA_PROVIDER = "DWD Thermischer Gefahrenindex (CC BY 4.0)";

/** Representative cities of the DWD index with fixed coordinates; slug for the id. */
const CITIES = new Map<string, readonly [lat: number, lon: number]>([
  ["Stuttgart", [48.78, 9.18]],
  ["Freiburg", [47.99, 7.85]],
  ["Mannheim", [49.49, 8.47]],
  ["Konstanz", [47.66, 9.18]],
  ["Ulm", [48.4, 9.99]],
]);

/** Levels of the index, as DWD spells them (attribute VALUES, hence German). */
const RANK = new Map<string, number>([
  ["keine", 0],
  ["gering", 1],
  ["mittel", 2],
  ["hoch", 3],
  ["extrem", 4],
]);

/** `|| 'keine'` of the old node. */
const NO_LEVEL = "keine";

export interface HeatForecast {
  /** `null` when the entry has no string city — never one of ours. */
  readonly city: string | null;
  /** Level at the warmest time of day (15 MEZ), today and tomorrow. */
  readonly today: string;
  readonly tomorrow: string;
}

export interface HeatIndex {
  readonly forecasts: readonly HeatForecast[];
  /** `forecast_day` (`YYYY-MM-DD`): the day "today" refers to; `null` if absent or malformed. */
  readonly forecastDay: string | null;
  /** `last_update` (Berlin local time) as an instant; `null` if absent or malformed. */
  readonly issuedAt: IsoTime | null;
  /** Entries dropped as malformed (see the module comment). */
  readonly malformed: number;
}

function level(raw: unknown, at: string): string {
  if (!isTruthy(raw)) return NO_LEVEL;
  if (!isString(raw)) throw new ParseError(at, "string", raw);
  return raw;
}

function parseForecast(raw: unknown, index: number): HeatForecast {
  const at = `content[${String(index)}]`;
  const entry = requireRecord(raw, at);
  // `r.forecast || {}`: a missing or non-object forecast yields 'keine' twice.
  const forecast = entry.forecast;
  return {
    city: optString(entry.city) ?? null,
    today: level(field(forecast, "today_15MEZ"), `${at}.forecast.today_15MEZ`),
    tomorrow: level(field(forecast, "tomorrow_15MEZ"), `${at}.forecast.tomorrow_15MEZ`),
  };
}

/**
 * A Berlin wall-clock time without zone (`2026-09-27T07:30:00`, as `gt.json`
 * gives it) as an ISO instant, or `null`.
 */
export function berlinLocalToIso(local: unknown): IsoTime | null {
  if (!isString(local) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(local)) return null;
  const asUtc = Date.parse(`${local}Z`);
  if (!Number.isFinite(asUtc)) return null;
  // Berlin's offset at that moment: its wall clock read back as if it were UTC.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(asUtc));
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return new Date(asUtc - (wall - asUtc)).toISOString();
}

/** Narrows `gt.json`. Loud on the outer shape, lenient per entry. */
export function parse(raw: unknown): HeatIndex {
  const content = requireArray(field(raw, "content"), "content");
  const { values, skipped } = mapLenient(content, parseForecast);
  const day = field(raw, "forecast_day");
  return {
    forecasts: values,
    malformed: skipped,
    forecastDay: isString(day) && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null,
    issuedAt: berlinLocalToIso(field(raw, "last_update")),
  };
}

/** `r.city.toLowerCase().replace(/ä/g, 'ae')…replace(/[^a-z0-9]+/g, '-')`. */
export function slugOf(city: string): string {
  return city
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/[^a-z0-9]+/g, "-");
}

export interface HeatHealthWarningEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:HeatHealthWarning:bw-${string}`;
  readonly type: "HeatHealthWarning";
  readonly name: Property<string>;
  readonly todayLevel: { readonly type: "Property"; readonly value: string; readonly observedAt: IsoTime };
  readonly tomorrowLevel: { readonly type: "Property"; readonly value: string; readonly observedAt: IsoTime };
  readonly maxRank: { readonly type: "Property"; readonly value: number; readonly observedAt: IsoTime };
  /** The day `todayLevel` is for; absent when the file names none. */
  readonly forecastDay?: Property<string>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly dataProvider: Property<string>;
  readonly location: { readonly type: "GeoProperty"; readonly value: GeoJsonPoint };
  readonly "@context": string;
}

/** FN_HITZE. Pure: no network, no clock — this is what parity diffs. */
export function build(
  raw: HeatIndex,
  _geo: GeoIndex | null,
  now: IsoTime,
): readonly HeatHealthWarningEntity[] {
  const entities: HeatHealthWarningEntity[] = [];
  for (const forecast of raw.forecasts) {
    if (forecast.city === null) continue;
    const coordinates = CITIES.get(forecast.city);
    if (coordinates === undefined) continue;
    const [lat, lon] = coordinates;
    entities.push({
      id: `urn:ngsi-ld:HeatHealthWarning:bw-${slugOf(forecast.city)}`,
      type: "HeatHealthWarning",
      name: { type: "Property", value: forecast.city },
      todayLevel: { type: "Property", value: forecast.today, observedAt: now },
      tomorrowLevel: { type: "Property", value: forecast.tomorrow, observedAt: now },
      maxRank: {
        type: "Property",
        value: Math.max(RANK.get(forecast.today) ?? 0, RANK.get(forecast.tomorrow) ?? 0),
        observedAt: now,
      },
      ...(raw.forecastDay === null ? {} : { forecastDay: { type: "Property", value: raw.forecastDay } }),
      dateObserved: { type: "Property", value: { "@type": "DateTime", "@value": raw.issuedAt ?? now } },
      dataProvider: { type: "Property", value: DATA_PROVIDER },
      // GeoJSON order: longitude before latitude, the table the other way round.
      location: { type: "GeoProperty", value: { type: "Point", coordinates: [lon, lat] } },
      "@context": NGSI_CONTEXT,
    });
  }
  return entities;
}

export async function run(ctx: Ctx): Promise<void> {
  const response = await ctx.fetch.json(SOURCE_URL);
  // `if (msg.statusCode >= 400 || !msg.payload || !Array.isArray(msg.payload.content))`
  if (!response.ok || !isArray(field(response.body, "content"))) {
    ctx.log.warn(`DWD heat: no data (HTTP ${String(response.status)})`);
    return;
  }
  const index = parse(response.body);
  if (index.malformed > 0) ctx.log.warn(`DWD heat: ${String(index.malformed)} malformed entries skipped`);
  const entities = build(index, null, ctx.now());
  if (entities.length === 0) {
    ctx.log.warn("DWD heat: no BW cities");
    return;
  }
  ctx.log.status(`${String(entities.length)} representative cities`);
  const result = await ctx.orion.upsert(ctx.gate.ungated(entities));
  ctx.log.info(
    `${String(result.entities)} HeatHealthWarning upserted (${String(result.failedChunks)} chunks failed)`,
  );
}

/** Checked against the contract by the compiler, as every ported module is. */
export const connector: ConnectorModule<HeatIndex, readonly HeatHealthWarningEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
