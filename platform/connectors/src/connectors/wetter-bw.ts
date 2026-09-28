/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `wetter-bw` — current weather for every municipality of Baden-Württemberg.
 *
 * Port of the node chain `udp-rt-bw-*` (FN_WX_BATCH, FN_WX_WRAP, FN_WX_BUILD in
 * scripts/generate-nodered-flows.py): `bw-gemeinden.json` -> 8 Open-Meteo
 * batches of ~140 coordinates -> join -> one `WeatherObserved:bw-<ags>` per
 * municipality. The fan-out, its pacing and the join semantics (partial groups
 * after 375 s, was 240 s; late batches as a group of their own) live in
 * ./open-meteo-batches.ts, shared with `vorhersage-bw`, and are explained there.
 *
 * Particulars of this connector, all carried over:
 *
 *  * It fetches `bw-gemeinden.json` itself and also puts the rows into the geo
 *    context (`global.set('bwGemeinden', g)` in the batch node), so that the
 *    master data are refreshed even when `stammdaten-bw` had nothing to write.
 *  * The entities carry no `location` and no `dateObserved` — "ohne location,
 *    TRoE-schonend": every attribute sent is a TRoE row, and the measured values
 *    carry their own `observedAt`.
 *  * Daily max/min/UV are requested only in every second 3-hour slot
 *    ({@link withDailyAt}): "Tages-Vorhersagewerte bei jedem 2. Lauf".
 *  * No change gate: the build node spliced CHUNK_HELPER in but never called
 *    `gateChanged`, so every run writes all values (ungated upsert, chunks of 100).
 *  * `refireOnRestart: false` — the scheduler fires the first run delayed, not
 *    never; Open-Meteo's HTTP 429 of 21.07. came from restarts firing at once.
 *
 * Deliberate difference, only for input the source does not produce: a location
 * whose values are malformed (a missing key, a string where a number belongs) is
 * skipped and counted with a warning. The old node wrote whatever it found — or
 * threw on a missing daily array and lost the whole group.
 */

import { observed } from "../kernel/ngsi.js";
import { ParseError, field, isRecord, isTruthy, requireArray, requireString } from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  Ags,
  ConnectorModule,
  Ctx,
  GeoIndex,
  IsoTime,
  MunicipalityRow,
  NgsiEntity,
  Property,
} from "../kernel/types.js";
import {
  OPEN_METEO_FORECAST_URL,
  UPSERT_CHUNK_SIZE,
  agsListOf,
  coordinateQuery,
  fetchBatch,
  joinGroups,
  joinTimingFor,
  loadMunicipalities,
  locationsOf,
  measurement,
  sliceBatches,
} from "./open-meteo-batches.js";
import type { BatchBody, JoinTiming } from "./open-meteo-batches.js";

export const ID = "wetter-bw";

/** Prefix of the warnings; the old nodes said `BW-Wetter:`. */
const LABEL = "BW weather";

const CURRENT = "&current=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation";
const DAILY = "&daily=temperature_2m_max,temperature_2m_min,uv_index_max&forecast_days=1";
const TIMEZONE = "&timezone=Europe%2FBerlin";

/* ------------------------------------------------------------------ batches */

/** One Open-Meteo call as the batch node emitted it (`url`, `agsList`, `withDaily`). */
export interface WeatherBatch {
  readonly url: string;
  readonly agsList: readonly Ags[];
  readonly withDaily: boolean;
}

const BERLIN_HOUR = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  hourCycle: "h23",
});

/**
 * `new Date().getHours() % 6 < 3` of the batch node — true in the hours 0–2,
 * 6–8, 12–14 and 18–20. `getHours()` is the container's local time, and
 * Node-RED ran with `TZ=Europe/Berlin` (Compose and Helm alike). The port pins
 * Europe/Berlin explicitly instead of trusting the process time zone, so the
 * result is the same whatever the service's `TZ` says.
 */
export function withDailyAt(now: IsoTime): boolean {
  return Number(BERLIN_HOUR.format(new Date(now))) % 6 < 3;
}

/** FN_WX_BATCH as a pure function of the rows and the daily switch. */
export function planBatches(rows: readonly MunicipalityRow[], withDaily: boolean): readonly WeatherBatch[] {
  return sliceBatches(rows).map((part) => ({
    url: `${OPEN_METEO_FORECAST_URL}${coordinateQuery(part)}${CURRENT}${withDaily ? DAILY : ""}${TIMEZONE}`,
    agsList: agsListOf(part),
    withDaily,
  }));
}

/* ------------------------------------------------------------------ parsing */

export interface CurrentValues {
  readonly temperature: number | null;
  readonly windSpeed: number | null;
  readonly windDirection: number | null;
  readonly precipitation: number | null;
}

/** First (and with `forecast_days=1` only) value of each daily series. */
export interface DailyValues {
  readonly tempMax: number | null;
  readonly tempMin: number | null;
  readonly uvIndexMax: number | null;
}

export interface ObservedLocation {
  readonly current: CurrentValues;
  /** `null` when the batch did not ask for it or the location has none. */
  readonly daily: DailyValues | null;
}

/**
 * One wrapped batch, the element of the joined array — `{ agsList, withDaily,
 * data }` of the wrap node. `data[i]` belongs to `agsList[i]`; `null` marks a
 * location the build node skips.
 */
export interface WeatherPart {
  readonly agsList: readonly Ags[];
  readonly withDaily: boolean;
  readonly data: readonly (ObservedLocation | null)[];
}

export interface WeatherParts {
  readonly parts: readonly WeatherPart[];
  /** Locations dropped as malformed (see the module comment). */
  readonly malformed: number;
}

function firstValue(series: unknown, at: string): number | null {
  const values = requireArray(series, at);
  if (values.length === 0) throw new ParseError(at, "at least one value", series);
  return measurement(values[0], `${at}[0]`);
}

/**
 * One Open-Meteo location. `null` where the build node skipped it —
 * `if (!loc || !loc.current) return;`, which is also what became of the error
 * text of a failed call. Throws {@link ParseError} on malformed values.
 */
export function parseLocation(raw: unknown, withDaily: boolean): ObservedLocation | null {
  const current = field(raw, "current");
  if (!isTruthy(current)) return null;
  if (!isRecord(current)) throw new ParseError("current", "object", current);
  const values: CurrentValues = {
    temperature: measurement(current.temperature_2m, "current.temperature_2m"),
    windSpeed: measurement(current.wind_speed_10m, "current.wind_speed_10m"),
    windDirection: measurement(current.wind_direction_10m, "current.wind_direction_10m"),
    precipitation: measurement(current.precipitation, "current.precipitation"),
  };
  // `part.withDaily && loc.daily && loc.daily.temperature_2m_max`
  const daily = field(raw, "daily");
  if (!withDaily || !isTruthy(daily) || !isTruthy(field(daily, "temperature_2m_max"))) {
    return { current: values, daily: null };
  }
  return {
    current: values,
    daily: {
      tempMax: firstValue(field(daily, "temperature_2m_max"), "daily.temperature_2m_max"),
      tempMin: firstValue(field(daily, "temperature_2m_min"), "daily.temperature_2m_min"),
      uvIndexMax: firstValue(field(daily, "uv_index_max"), "daily.uv_index_max"),
    },
  };
}

function parseLocations(
  items: readonly unknown[],
  withDaily: boolean,
): { readonly data: (ObservedLocation | null)[]; readonly malformed: number } {
  const data: (ObservedLocation | null)[] = [];
  let malformed = 0;
  for (const item of items) {
    try {
      data.push(parseLocation(item, withDaily));
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      // Keep the position: data[i] must stay aligned with agsList[i].
      data.push(null);
      malformed += 1;
    }
  }
  return { data, malformed };
}

/**
 * The wrap node ("bündeln"): a failed call becomes `{ agsList, data: [] }`, a
 * successful one carries its locations — a bare object for a single coordinate.
 */
export function partOf(batch: WeatherBatch, body: BatchBody): { part: WeatherPart; malformed: number } {
  if (!body.ok) return { part: { agsList: batch.agsList, withDaily: false, data: [] }, malformed: 0 };
  const { data, malformed } = parseLocations(locationsOf(body.body), batch.withDaily);
  return { part: { agsList: batch.agsList, withDaily: batch.withDaily, data }, malformed };
}

/**
 * The joined array as the build node received it (`msg.payload` after the
 * join). Parts that are not objects or carry no `agsList` are skipped
 * (`if (!part || !part.agsList) continue;`); the rest is this service's own
 * structure and is narrowed strictly.
 */
export function parse(raw: unknown): WeatherParts {
  const items = requireArray(raw, "joined parts");
  const parts: WeatherPart[] = [];
  let malformed = 0;
  items.forEach((item, index) => {
    const at = `joined parts[${String(index)}]`;
    if (!isTruthy(item) || !isTruthy(field(item, "agsList"))) return;
    const agsList = requireArray(field(item, "agsList"), `${at}.agsList`).map((ags, i) =>
      requireString(ags, `${at}.agsList[${String(i)}]`),
    );
    const withDaily = isTruthy(field(item, "withDaily"));
    const parsed = parseLocations(requireArray(field(item, "data"), `${at}.data`), withDaily);
    malformed += parsed.malformed;
    parts.push({ agsList, withDaily, data: parsed.data });
  });
  return { parts, malformed };
}

/* ------------------------------------------------------------------ build */

export interface WeatherObservedEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:WeatherObserved:bw-${string}`;
  readonly type: "WeatherObserved";
  readonly ags: Property<string>;
  readonly temperature: Property<number | null>;
  readonly windSpeed: Property<number | null>;
  readonly windDirection: Property<number | null>;
  readonly precipitation: Property<number | null>;
  readonly "@context": string;
  readonly tempMax?: Property<number | null> | undefined;
  readonly tempMin?: Property<number | null> | undefined;
  readonly uvIndexMax?: Property<number | null> | undefined;
}

/** FN_WX_BUILD. Pure: no network, no clock — this is what parity diffs. */
export function build(
  raw: WeatherParts,
  _geo: GeoIndex | null,
  now: IsoTime,
): readonly WeatherObservedEntity[] {
  const entities: WeatherObservedEntity[] = [];
  for (const part of raw.parts) {
    part.agsList.forEach((ags, i) => {
      const loc = part.data[i];
      if (loc === undefined || loc === null) return;
      const daily = part.withDaily ? loc.daily : null;
      entities.push({
        id: `urn:ngsi-ld:WeatherObserved:bw-${ags}`,
        type: "WeatherObserved",
        ags: { type: "Property", value: ags },
        temperature: observed(loc.current.temperature, "CEL", now),
        windSpeed: observed(loc.current.windSpeed, "KMH", now),
        windDirection: observed(loc.current.windDirection, "DD", now),
        precipitation: observed(loc.current.precipitation, "MMT", now),
        "@context": NGSI_CONTEXT,
        ...(daily === null
          ? {}
          : {
              tempMax: observed(daily.tempMax, "CEL", now),
              tempMin: observed(daily.tempMin, "CEL", now),
              // `P(…, '')`: an empty unit code, as the old node sent it.
              uvIndexMax: observed(daily.uvIndexMax, "", now),
            }),
      });
    });
  }
  return entities;
}

/* ------------------------------------------------------------------ run */

/**
 * `run` with the join timing injectable — the tests cannot wait minutes.
 * Without one, the window is derived from the batch count and the shared
 * Open-Meteo bucket ({@link joinTimingFor}, explained in ./open-meteo-batches.ts).
 */
export async function runWith(ctx: Ctx, timing?: JoinTiming): Promise<void> {
  const rows = await loadMunicipalities(ctx, LABEL);
  if (rows === null) return;

  // Before the batches, as in the batch node: the master data reach the geo
  // context even when every Open-Meteo call fails.
  ctx.geo.setMunicipalities(rows);

  const batches = planBatches(rows, withDailyAt(ctx.now()));
  // All calls are started at once and queue in the token bucket in batch
  // order, one per 15 s — the delay node's queue.
  const tasks = batches.map(async (batch) => partOf(batch, await fetchBatch(ctx, batch.url)));
  const join = timing ?? joinTimingFor(batches.length);

  const summary = await joinGroups(tasks, join, ctx.signal, async (group) => {
    if (group.closedBy === "timeout") {
      ctx.log.warn(
        `${LABEL}: join timeout after ${String(join.timeoutMs / 1000)} s — writing a partial result of ` +
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
    ctx.log.status(`${String(entities.length)} municipalities with weather`);
    const result = await ctx.orion.upsert(ctx.gate.ungated(entities), { chunkSize: UPSERT_CHUNK_SIZE });
    ctx.log.info(
      `${String(result.entities)} WeatherObserved upserted in ${String(result.chunks)} chunks ` +
        `(${String(result.failedChunks)} failed)`,
    );
  });
  if (summary.abandoned > 0) {
    ctx.log.warn(`${LABEL}: shutdown — ${String(summary.abandoned)} fetched batches not written`);
  }
}

export async function run(ctx: Ctx): Promise<void> {
  await runWith(ctx);
}

/** Checked against the contract by the compiler, as every ported module is. */
export const connector: ConnectorModule<WeatherParts, readonly WeatherObservedEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
