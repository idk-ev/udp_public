/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `wetter-dwd-station` — current observations of the official DWD stations in
 * Baden-Württemberg (via BrightSky), one `WeatherObserved` entity per station.
 *
 * Port of FN_DWD_STATIONEN and FN_DWD_BUILD in
 * the former Node-RED flow generator (see git history). The generator gives the reason for the
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
 *  * The master data check runs once, before any request; the old node
 *    checked (and warned) per station, after the requests.
 *  * A failed station request was an `[error]` of the http request node per
 *    station; here the failures are counted and reported in ONE `[warn]` per
 *    run. A station answering >= 400 or without `weather` is skipped silently,
 *    as before. No retries, as before.
 *  * Malformed data only: a source entry that is not an object, coordinates
 *    that are not numbers, a name that is not a string, and measured values
 *    that are not numbers count as absent. A station id with characters
 *    other than letters and digits is skipped (none is real): the prune and
 *    the seeding could not match it.
 *  * The station id is URL-encoded in the request (the old node concatenated
 *    it); identical bytes for every real id.
 *  * Warning texts are English (the code language of this service).
 *
 * ## Deliberate deviations (decided with the data review, 2026-10)
 *
 *  * **Observation time instead of fetch time.** The old node stamped every
 *    value and `dateObserved` with the run time, so a half-hourly SYNOP value
 *    looked up to 35 minutes fresher than it was, and a station that kept
 *    answering an old record looked current. Both now carry BrightSky's
 *    `weather.timestamp` ({@link observationTime}). A station without a
 *    readable timestamp, with one later than the run, or with one older than
 *    {@link MAX_AGE_MS} is not written — it cannot be a current measurement.
 *  * **Split change gate instead of an ungated write every hour**
 *    (src/kernel/split-gate.ts, as `uba-bw`): the master data (`stationName`,
 *    `dwdStationId`, `dataProvider`, `location`, `ags`, `gemeindeName`) and
 *    the six measured values are signed apart, so a run sends only the values
 *    that changed plus `dateObserved`, and a station whose values did not
 *    change only its `dateObserved`. The old write cost about thirteen TRoE
 *    rows per station and hour. The tables are always merged: a station that
 *    answers nothing current for a while keeps its signatures until the
 *    prune deletes it.
 *  * **Values a station no longer reports are deleted** from the broker
 *    ({@link valuesVanished}): an upsert cannot remove an attribute, so the
 *    last wind speed of a station that stopped sending wind stayed next to a
 *    fresh `dateObserved` and passed for current. The dynamic table is seeded
 *    once from the broker when it is empty (first run, lost state), so the
 *    values the old writes left behind are found as well; the static table
 *    is not seeded, so that first run writes every station in full once.
 *  * **Stale stations are pruned** ({@link PRUNE_PATTERN}): a station not
 *    written for {@link PRUNE_GRACE_MS} (it left the source list, or answers
 *    nothing usable any more) is deleted with the kernel's guards. The old
 *    flow kept such entities forever.
 *  * **Official station names** from DWD's station description files
 *    ({@link NAME_URLS}, at most weekly, persisted in `ctx.state`) instead of
 *    BrightSky's, which are cut to 20 characters ("Renng. Ihinger-Hof",
 *    "Wildbad, Bad-Calmbac"). Per station id the entry with the latest end
 *    date wins; without the files, or for an id they lack, BrightSky's name
 *    is used as before. Either way DWD's inversion "X, Bad" reads "Bad X"
 *    ({@link displayName}).
 *  * One batch upsert (default chunks) after all stations answered, instead
 *    of one POST per station.
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
import {
  applySplit,
  dynamicSignature,
  pointOf,
  propertyValue,
  reportSplit,
  staticSignatureOf,
  totalsOf,
} from "../kernel/split-gate.js";
import { persisted, stateKey } from "../kernel/state.js";
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

/** Log prefix of the run's own lines (the warnings read `DWD stations: …` as before). */
const LABEL = "DWD stations";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** BrightSky source list around the middle of BW (radius 200 km). */
export const SOURCES_URL = "https://api.brightsky.dev/sources?lat=48.6&lon=9.0&max_dist=200000";

/**
 * The station id comes out of the source list, so it is URL-encoded (the old
 * node concatenated it). The real ids are digits and letters — unchanged bytes.
 */
export function weatherUrl(stationId: string): string {
  return `https://api.brightsky.dev/current_weather?dwd_station_id=${encodeURIComponent(stationId)}`;
}

/** Box around Baden-Württemberg the old node filtered the sources with. */
const BOX = { south: 47.4, north: 49.9, west: 7.3, east: 10.7 } as const;

/** Gate tables of the split gate: master data and measured values apart. */
export const STATIC_KEY = "dwdStatic";
export const LIVE_KEY = "dwdLive";

/**
 * The ids this connector writes, for the prune and the seeding — `bw-dwd-`
 * plus the DWD station id. Its own label, type and pattern: no other prune
 * shares its bookkeeping.
 */
export const PRUNE_PATTERN = "^urn:ngsi-ld:WeatherObserved:bw-dwd-[0-9A-Za-z]+$";

/** A station not written for a week is gone (prune grace). */
export const PRUNE_GRACE_MS = 7 * DAY_MS;

/** An observation older than this is no current measurement and is not written. */
export const MAX_AGE_MS = PRUNE_GRACE_MS;

/** The measured attributes, in the order of the dynamic signature. */
export const LIVE_ATTRIBUTES: readonly string[] = [
  "temperature",
  "relativeHumidity",
  "atmosphericPressure",
  "windSpeed",
  "windDirection",
  "precipitation",
];

/* ------------------------------------------------------------------ Official names */

const CDC = "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate";

/**
 * DWD's station description files (ISO-8859-1, fixed width, one row per
 * station id with the period of its data). No single file lists every
 * station BrightSky reports: checked 2026-10-06 against the 197 stations of
 * the BW box, the hourly temperature file names 103, together with the daily
 * climate and the daily precipitation file 196 (only `K988`, no DWD id, is
 * missing).
 */
export const NAME_URLS: readonly string[] = [
  `${CDC}/hourly/air_temperature/recent/TU_Stundenwerte_Beschreibung_Stationen.txt`,
  `${CDC}/daily/kl/recent/KL_Tageswerte_Beschreibung_Stationen.txt`,
  `${CDC}/daily/more_precip/recent/RR_Tageswerte_Beschreibung_Stationen.txt`,
];

/** The names change rarely: one load a week. */
export const NAMES_REFRESH_MS = 7 * DAY_MS;

/** After a failed load, the next attempt at the earliest after this. */
export const NAMES_RETRY_MS = 6 * HOUR_MS;

/** The largest file is ~6.6 MB (2026-10). */
const NAMES_MAX_BYTES = 32 * 1024 * 1024;

/** Official names by DWD station id (5 digits), only stations near the BW box. */
export const NAMES = stateKey("dwdNames", () => new Map<string, string>(), persisted.stringMap);
/** When the names were last loaded completely (ms), persisted: weekly across restarts. */
export const NAMES_AT = stateKey("dwdNamesAt", () => 0, persisted.number);
/** The last attempt (ms), process lifetime: a failing source is not asked every hour. */
const NAMES_TRIED = stateKey("dwdNamesTried", () => 0);

/** One row of a station description file. */
export interface StationDescription {
  readonly id: string;
  /** `bis_datum`, `YYYYMMDD` — the end of the station's data. */
  readonly until: string;
  readonly lat: number;
  readonly lon: number;
  readonly name: string;
}

/** Width of the `Stationsname` column when the dash line does not tell (41 in 2026). */
const NAME_WIDTH = 41;

/** id, von_datum, bis_datum, Stationshoehe, geoBreite, geoLaenge, then the name column. */
const DESCRIPTION_ROW =
  /^(\w+) +(\d{8}) +(\d{8}) +-?\d+(?:\.\d+)? +(-?\d+(?:\.\d+)?) +(-?\d+(?:\.\d+)?) (.*)$/;

/** The ids of the files have five digits; BrightSky's mostly too, but not by contract. */
export function normalizedId(id: string): string {
  return /^\d{1,5}$/.test(id) ? id.padStart(5, "0") : id;
}

/**
 * The rows of one station description file (already decoded as ISO-8859-1).
 * The numeric columns are split on blanks; the name — which contains blanks
 * and fills its column at 41 characters, one blank before `Bundesland` — is
 * cut at the width of its dash group in the second header line. Lines that
 * do not look like a row are skipped.
 */
export function parseDescriptions(text: string): StationDescription[] {
  let width = NAME_WIDTH;
  const out: StationDescription[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^-+(?: +-+)+ *$/.test(line)) {
      const group = line.trim().split(/ +/)[6];
      if (group !== undefined) width = group.length;
      continue;
    }
    const match = DESCRIPTION_ROW.exec(line);
    if (match === null) continue;
    const [, id, , until, lat, lon, rest] = match;
    if (id === undefined || until === undefined || lat === undefined || lon === undefined) continue;
    const name = (rest ?? "").slice(0, width).trim();
    if (name === "") continue;
    out.push({ id: normalizedId(id), until, lat: Number(lat), lon: Number(lon), name });
  }
  return out;
}

/**
 * The files of one load merged: per station id the row with the latest end
 * date (a closed station's old row loses against the current one), on a tie
 * the earlier file.
 */
export function mergeDescriptions(
  lists: readonly (readonly StationDescription[])[],
): Map<string, StationDescription> {
  const byId = new Map<string, StationDescription>();
  for (const list of lists) {
    for (const row of list) {
      const known = byId.get(row.id);
      if (known === undefined || row.until > known.until) byId.set(row.id, row);
    }
  }
  return byId;
}

/** Margin around {@link BOX} for the stored names: a station on the edge keeps its name. */
const NAME_MARGIN = 0.25;

/** The names worth keeping: stations in and around the BW box. */
export function namesNearBw(rows: ReadonlyMap<string, StationDescription>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [id, row] of rows) {
    if (row.lat < BOX.south - NAME_MARGIN || row.lat > BOX.north + NAME_MARGIN) continue;
    if (row.lon < BOX.west - NAME_MARGIN || row.lon > BOX.east + NAME_MARGIN) continue;
    names.set(id, row.name);
  }
  return names;
}

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

/**
 * "X, Bad" → "Bad X": DWD sorts spa towns by their name ("Mergentheim, Bad",
 * "Waldsee, Bad-Reute", "Säckingen, Bad (Bergseestr.)"). The only inversion
 * in the files: the other suffixes after a comma ("Kr. Ravensburg", "Kreis
 * Biberach", "Kurort") qualify a name and stay where they are.
 */
const BAD_INVERSION = /^([^,]+?), *Bad(?=$|[\s\-/(])(.*)$/;

/** The name as the dashboard shows it: readable capitals, "Bad" in front. */
export function displayName(name: string): string {
  const readable = readableName(name.trim());
  const match = BAD_INVERSION.exec(readable);
  if (match === null) return readable;
  return `Bad ${(match[1] ?? "").trim()}${match[2] ?? ""}`;
}

/**
 * The files are ISO-8859-1 today. Should DWD switch to UTF-8, the latin-1
 * reading shows its typical pairs ("Ã¼" for "ü"): then the bytes are read
 * as UTF-8 instead of storing mojibake names.
 */
export function decodedDescriptions(latin1: string): string {
  return /Ã[\u0080-¿]/.test(latin1) ? Buffer.from(latin1, "latin1").toString("utf8") : latin1;
}

/** File name of a description URL, for log lines. */
function fileOf(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

/**
 * The official names, loaded at most weekly (after a failure again after
 * {@link NAMES_RETRY_MS}). A load adds to the stored names (a new name
 * replaces an id's old one); only a complete load counts as the weekly one.
 * Without any, the stored names (or none: BrightSky's) serve.
 */
export async function stationNames(ctx: Ctx): Promise<ReadonlyMap<string, string>> {
  const names = ctx.state.slot(NAMES);
  const loadedAt = ctx.state.slot(NAMES_AT);
  const tried = ctx.state.slot(NAMES_TRIED);
  const nowMs = Date.parse(ctx.now());
  const age = nowMs - loadedAt.get();
  if ((age >= 0 && age < NAMES_REFRESH_MS) || Math.abs(nowMs - tried.get()) < NAMES_RETRY_MS) {
    return names.get();
  }
  tried.set(nowMs);
  const lists: StationDescription[][] = [];
  const failures: string[] = [];
  for (const url of NAME_URLS) {
    if (ctx.signal.aborted) return names.get();
    try {
      const response = await ctx.fetch.text(url, {
        encoding: "latin1",
        maxBytes: NAMES_MAX_BYTES,
        retries: 1,
      });
      if (!response.ok) {
        failures.push(`${fileOf(url)} HTTP ${String(response.status)}`);
        continue;
      }
      const rows = parseDescriptions(decodedDescriptions(response.body));
      if (rows.length === 0) failures.push(`${fileOf(url)} without station rows`);
      else lists.push(rows);
    } catch (error) {
      failures.push(`${fileOf(url)} ${failureText(error)}`);
    }
  }
  if (lists.length > 0) {
    const loaded = namesNearBw(mergeDescriptions(lists));
    // Merged over the stored names, never replacing them: a truncated file or
    // a format change that still parses a few rows must not take the names
    // of every other station away (and rewrite every station twice).
    names.set(new Map([...names.get(), ...loaded]));
    if (failures.length === 0) loadedAt.set(nowMs);
    ctx.log.info(
      `${LABEL}: ${String(names.get().size)} official station names from ${String(lists.length)} of ` +
        `${String(NAME_URLS.length)} DWD station lists`,
    );
  }
  if (failures.length > 0) {
    ctx.log.warn(
      `${LABEL}: DWD station list not loadable (${failures.join("; ")}) — BrightSky names where missing`,
    );
  }
  return names.get();
}

/* ------------------------------------------------------------------ Types */

/** One DWD station of the run, `stationen[id]` of the old node. */
export interface Station {
  /** `dwd_station_id` as text (a number from the source is concatenated the same way). */
  readonly id: string;
  /** BrightSky's name, capitals made readable. */
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
}

/** The six values FN_DWD_BUILD reads of `payload.weather`; `null` = not reported. */
export interface Weather {
  /** `weather.timestamp` in UTC; `null` when missing or unreadable. */
  readonly timestamp: IsoTime | null;
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
  /** Official names by normalized DWD station id ({@link normalizedId}); may be empty. */
  readonly names?: ReadonlyMap<string, string> | undefined;
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

function stationOf(raw: unknown): Station | null {
  if (!isRecord(raw)) return null;
  const id = raw.dwd_station_id;
  const lat = raw.lat;
  const lon = raw.lon;
  // `if (!id || !s.lat || !s.lon) continue;` — a latitude of 0 is out as well.
  if (!(isString(id) || isFiniteNumber(id)) || !isTruthy(id)) return null;
  // Only ids the prune and the seeding can match (PRUNE_PATTERN); real ids are.
  if (!/^[0-9A-Za-z]+$/.test(String(id))) return null;
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

/** BrightSky's `"2026-10-06T11:00:00+00:00"` as UTC ISO time, or `null`. */
export function timestampOf(value: unknown): IsoTime | null {
  if (!isString(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  // Only a stamp with an explicit zone: a local reading would depend on the host.
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** `!msg.payload || !msg.payload.weather` → `null`. */
export function parseWeather(payload: unknown): Weather | null {
  const weather = field(payload, "weather");
  if (!isTruthy(weather)) return null;
  return {
    timestamp: timestampOf(field(weather, "timestamp")),
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
 * `{ sources: <BrightSky /sources answer>, weather: { <station id>: <current_weather answer> },
 * names?: [<station description file text>, …] }`.
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
  const files = isArray(record.names) ? record.names.filter(isString) : [];
  const names = namesNearBw(mergeDescriptions(files.map(parseDescriptions)));
  return { stations: parseSources(record.sources), observations, names };
}

/* ------------------------------------------------------------------ Build */

/**
 * The time an observation stands for: its own timestamp, if it is neither
 * later than `now` nor older than {@link MAX_AGE_MS}; else `null` (not written).
 */
export function observationTime(weather: Weather, now: IsoTime): IsoTime | null {
  if (weather.timestamp === null) return null;
  const age = Date.parse(now) - Date.parse(weather.timestamp);
  return age >= 0 && age <= MAX_AGE_MS ? weather.timestamp : null;
}

/** FN_DWD_BUILD for one station; `null` when the station reports nothing current. */
export function buildStation(
  station: Station,
  weather: Weather,
  geo: GeoIndex | null,
  now: IsoTime,
  officialName?: string,
): StationEntity | null {
  const at = observationTime(weather, now);
  if (at === null) return null;
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
    measuredValues[attribute] = { type: "Property", value, unitCode, observedAt: at };
  }
  // "Station meldet gerade nichts"
  if (Object.keys(measuredValues).length === 0) return null;

  const name = cleanText(displayName(officialName ?? station.name));
  return {
    id: `urn:ngsi-ld:WeatherObserved:bw-dwd-${station.id}`,
    type: "WeatherObserved",
    stationName: { type: "Property", value: name },
    dwdStationId: { type: "Property", value: station.id },
    dateObserved: dateObserved(at),
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

/** Pure: one entity per station that answered with at least one current value. */
export function build(raw: DwdRun, geo: GeoIndex | null, now: IsoTime): readonly StationEntity[] {
  const entities: StationEntity[] = [];
  for (const station of raw.stations) {
    const weather = raw.observations.get(station.id);
    if (weather === undefined) continue;
    const entity = buildStation(station, weather, geo, now, raw.names?.get(normalizedId(station.id)));
    if (entity !== null) entities.push(entity);
  }
  return entities;
}

/* ------------------------------------------------------------------ Write */

/**
 * Master data of a station — never a measured value. Works on a built entity
 * and on a broker record alike; `ags`/`gemeindeName` are optional (a station
 * outside every polygon has none). `null` when a required part is missing.
 */
export function stationStatic(entity: Readonly<Record<string, unknown>>): string | null {
  return staticSignatureOf([
    propertyValue(entity, "stationName"),
    propertyValue(entity, "dwdStationId"),
    propertyValue(entity, "dataProvider"),
    pointOf(entity),
    propertyValue(entity, "ags") ?? "",
    propertyValue(entity, "gemeindeName") ?? "",
  ]);
}

/**
 * The measured values the broker holds (per the stored dynamic signature,
 * {@link LIVE_ATTRIBUTES} order) that a station no longer reports.
 */
export function valuesVanished(
  entities: readonly StationEntity[],
  live: ReadonlyMap<string, unknown>,
): readonly (readonly [id: EntityId, attribute: string])[] {
  const out: (readonly [id: EntityId, attribute: string])[] = [];
  for (const entity of entities) {
    const signature = live.get(entity.id);
    if (typeof signature !== "string") continue;
    let stored: unknown;
    try {
      stored = JSON.parse(signature);
    } catch {
      continue; // Not a signature this connector wrote: nothing known about the broker.
    }
    if (!isArray(stored) || stored.length !== LIVE_ATTRIBUTES.length) continue;
    for (const [index, attribute] of LIVE_ATTRIBUTES.entries()) {
      const was = stored[index];
      if (was !== null && was !== undefined && propertyValue(entity, attribute) === undefined) {
        out.push([entity.id, attribute]);
      }
    }
  }
  return out;
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

  const names = await stationNames(ctx);

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

  const now = ctx.now();
  const entities = build({ stations, observations, names }, geo, now);
  if (entities.length === 0) return;
  const notCurrent = [...observations.values()].filter((weather) => observationTime(weather, now) === null);
  const status =
    `${String(entities.length)} of ${String(stations.length)} stations` +
    (notCurrent.length > 0 ? ` (${String(notCurrent.length)} without a current timestamp)` : "");
  ctx.log.status(status);

  // An empty dynamic table (first run, lost state): seeded from what the
  // broker holds, so values earlier writes left behind are found below. The
  // static table stays empty — every station is written in full once.
  await ctx.orion.seedSignatures({
    label: LABEL,
    queries: [{ type: "WeatherObserved", pattern: PRUNE_PATTERN }],
    attrs: LIVE_ATTRIBUTES,
    tables: { [LIVE_KEY]: (entity) => dynamicSignature(entity, LIVE_ATTRIBUTES) },
  });
  // Read before the gate drops what goes out: which values the broker holds.
  const liveBefore = ctx.gate.table(LIVE_KEY);
  const vanished = valuesVanished(entities, liveBefore);
  const split = applySplit(
    ctx.gate,
    entities,
    {
      staticKey: STATIC_KEY,
      dynamicKey: LIVE_KEY,
      staticSignature: (entity) => stationStatic(entity) ?? "",
      dynamic: LIVE_ATTRIBUTES,
      // Always merged: a station asked but not written in this run (404, no
      // current value) keeps its signatures, so its return is a partial write
      // and a value it no longer reports is still found then. The prune
      // forgets the signatures of what it deletes.
      replace: false,
      periodMs: ctx.intervalMs(),
    },
    Date.parse(now),
  );
  reportSplit(ctx.log, LABEL, totalsOf(split));
  // An upsert cannot remove an attribute: a value the station stopped sending
  // would stay next to the newer `dateObserved` and pass for current. Deleted
  // before the write; where a delete fails, the stored signature (which still
  // holds the value) is committed instead of the new one, so the next run
  // finds the value again and retries.
  let deleted = 0;
  const retry = new Set<string>();
  for (const [id, attribute] of vanished) {
    if (await ctx.orion.deleteAttribute(id, attribute, LABEL)) deleted += 1;
    else retry.add(id);
  }
  if (vanished.length > 0) {
    ctx.log.info(
      `${LABEL}: ${String(deleted)} of ${String(vanished.length)} values no longer reported deleted`,
    );
  }
  const plan =
    retry.size === 0
      ? split
      : {
          ...split,
          pending: split.pending.map((pending) =>
            pending[0] === LIVE_KEY && retry.has(pending[1])
              ? ([LIVE_KEY, pending[1], liveBefore.get(pending[1]) ?? null, pending[3]] as const)
              : pending,
          ),
        };
  await ctx.orion.upsert(plan);

  // Stations not written for a week: gone from the source list, or nothing
  // current to report. Not after a run in which most requests failed — the
  // grace period would protect them anyway, but such a run says nothing.
  if (failed * 2 >= stations.length) return;
  await ctx.prune.stale({
    label: LABEL,
    type: "WeatherObserved",
    pattern: PRUNE_PATTERN,
    attrs: ["dateObserved"],
    keep: new Set(entities.map((entity) => entity.id)),
    graceMs: PRUNE_GRACE_MS,
    // Gone for one to two weeks counts as recent (under the share cap); with
    // the default backlog age the grace period alone would make every
    // candidate backlog, and the cap would never apply.
    backlogMs: 2 * PRUNE_GRACE_MS,
    liveMs: 3 * HOUR_MS,
    signatureKey: STATIC_KEY,
    signatureKeys: [LIVE_KEY],
    intervalMs: ctx.intervalMs(),
    status,
  });
}

export const connector: ConnectorModule<DwdRun, readonly StationEntity[]> = {
  id: ID,
  parse,
  build,
  run,
};
