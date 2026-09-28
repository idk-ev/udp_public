/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `baustellen-bw` — road works state-wide (SVZ-BW via MobiData BW).
 *
 * Port of two chains of the old flow that shared a registry entry:
 *
 *  * FN_RW_BW (`udp-rt-br-fn`, with FN_RW_PREP setting the URL in front of it):
 *    one `RoadWork:bw-svz-<id>` per road work inside a BW municipality polygon,
 *    one `RoadWork:bw-kreis-<krs>-summary` with the count per district, the
 *    prune of what a complete run no longer produces, and the ungated upsert
 *    (no signature commit behind `udp-rt-br-post` — road works are written in
 *    full every six hours).
 *  * FN_RW_EXPIRE (`udp-rt-brx-fn`): the removal of road works whose end date
 *    has passed. The generator's reason: "Ohne diesen Lauf bleiben sie liegen,
 *    sobald der Feed sie nicht mehr ausliefert — die Kommune sähe dauerhaft
 *    Sperrungen, die es nicht mehr gibt."
 *
 * Deliberate differences:
 *
 *  * The expiry had its own inject (every 6 h, first 900 s after a start, i.e.
 *    ~700 s after the ingest). The registry knows one schedule per connector,
 *    so it now runs at the end of every run, after the upsert and the prune,
 *    and also when the ingest part returned early — as the independent inject
 *    did. Same cadence, same query, same 200-id cap; only the offset is gone.
 *  * The old prune was started without `await` next to the upsert; here the
 *    upsert completes first. `keep` protects every id of the run either way.
 *  * A feature the old node would have thrown on — a non-Point geometry
 *    without a coordinate list — is skipped and counted with a `[warn]`; the
 *    old node lost the whole run to the TypeError. A feature that is not an
 *    object still fails the run (the old node failed on it the same way).
 *  * A failed request (DNS, timeout) warns "data incomplete" with the error;
 *    the old `http request` node passed the error text on, which failed the
 *    same check.
 */

import { cleanText, dateObserved, observed } from "../kernel/ngsi.js";
import { field, isArray, isEntityId, isRecord, isString, isTruthy, ParseError } from "../kernel/parse.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  ConnectorModule,
  Ctx,
  EntityId,
  GeoIndex,
  GeoProperty,
  IsoTime,
  JsonResponse,
  KreisCode,
  NgsiDateTime,
  NgsiEntity,
  Property,
} from "../kernel/types.js";

export const ID = "baustellen-bw";

/** As FN_RW_PREP. */
export const SOURCE_URL = "https://api.mobidata-bw.de/datasets/traffic/roadworks/roadworks_geojson.json";

/** As FN_RW_BW: `emitChunks(node, msg, entities, 100)`. */
export const CHUNK_SIZE = 100;

const LABEL = "BW roadworks";

/**
 * Own ids: the road works and the district sums. Anchored — `bw-svz-1` must not
 * also match `bw-svz-10`.
 */
export const PRUNE_PATTERN = "^urn:ngsi-ld:RoadWork:bw-(svz-[A-Za-z0-9_-]+|kreis-[0-9]{5}-summary)$";

/**
 * The expiry query of `udp-rt-brx-get`, unchanged: unanchored, one page of
 * 1000, only `endDate`. It reads, the ids it deletes come from its own answer.
 */
export const EXPIRY_ID_PATTERN = "urn:ngsi-ld:RoadWork:bw-svz-.*";
export const EXPIRY_LIMIT = 1000;
/** FN_RW_EXPIRE: `msg.payload = ids.slice(0, 200)` — one request per run. */
export const EXPIRY_MAX_DELETE = 200;

/** A road work feature, narrowed to what the connector reads. */
export interface RoadworkFeature {
  /** `String(properties.endtime)` when truthy, else `null`. */
  readonly endtime: string | null;
  /**
   * `firstPoint(geometry)` with `Number()` applied to its first two elements —
   * `[x, y]` as the feed has it, before the lat/lon swap check. `null` when
   * there is no point (`if (!p0) continue;`).
   */
  readonly point: readonly [x: number, y: number] | null;
  /** `String(props.id || props.reference)` when either is truthy, else `null`. */
  readonly key: string | null;
  /**
   * `(props.name || props.street || props.description || 'Baustelle').slice(0, 90)`
   * as text. `null` when the chosen value has no `slice` — the old node threw
   * there; `build` does the same when it reaches that feature.
   */
  readonly label: string | null;
}

export interface RoadworkFeed {
  readonly features: readonly RoadworkFeature[];
  /** Features without a usable geometry (the old node threw on them). */
  readonly malformedGeometry: number;
}

export interface RoadworkEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:RoadWork:bw-svz-${string}`;
  readonly type: "RoadWork";
  readonly name: Property<string>;
  readonly ags: Property<string>;
  readonly gemeindeName: Property<string>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly location: GeoProperty;
  readonly "@context": string;
  readonly endDate?: Property<string> | undefined;
}

/** No `dateObserved`: the prune ages it by `activeCount.observedAt`. */
export interface RoadworkSummaryEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:RoadWork:bw-kreis-${string}-summary`;
  readonly type: "RoadWork";
  readonly ags: Property<string>;
  readonly name: Property<string>;
  readonly activeCount: Property<number>;
  readonly "@context": string;
}

export interface RoadworkBuild {
  readonly entities: readonly (RoadworkEntity | RoadworkSummaryEntity)[];
  readonly districts: number;
  /** Already ended, skipped (`abgelaufen`). */
  readonly ended: number;
  /** `[lat, lon]` records swapped back (`getauscht`). */
  readonly swapped: number;
  /** Outside the BW coordinate range, dropped (`ungueltig`). */
  readonly invalid: number;
  /** Inside the range but in no municipality polygon (`ausserhalb`). */
  readonly outside: number;
  /** `msg.payload.features.length` — the base of the invalid-share warning. */
  readonly features: number;
}

/* ------------------------------------------------------------------ JS semantics */

/**
 * `String(v)` for a JSON value, spelled out: the old node ran `String()` on
 * whatever the feed carried, and the ids and dates it built depend on that.
 */
export function jsString(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (isString(value)) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Array.prototype.toString: elements joined by ",", null/undefined as "".
  if (isArray(value))
    return value.map((item) => (item === null || item === undefined ? "" : jsString(item))).join(",");
  return "[object Object]";
}

/** `v[i]` on a JSON value: arrays and strings by index, objects by key. */
function elementAt(value: unknown, index: number): unknown {
  if (isArray(value)) return value[index];
  if (isString(value)) return index < value.length ? value.charAt(index) : undefined;
  if (isRecord(value)) return value[String(index)];
  return undefined;
}

/** `Number(v)` for a JSON value. */
function jsNumber(value: unknown): number {
  if (value === undefined) return Number.NaN;
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (isString(value) || isArray(value)) return Number(jsString(value));
  return Number.NaN;
}

class MalformedGeometry extends Error {}

/**
 * `firstPoint` of the original: a Point's coordinates as they are, otherwise
 * the MIDDLE point of the flattened coordinate list (`pts[floor(len/2)] ||
 * pts[0]`) — a road work drawn as a line is placed at its middle, not at its
 * start. Throws {@link MalformedGeometry} where the old code threw a TypeError
 * (`c[0]` of a missing list).
 */
function firstPoint(geometry: unknown): unknown {
  if (!isTruthy(geometry)) return null;
  if (field(geometry, "type") === "Point") return field(geometry, "coordinates");
  const coordinates = field(geometry, "coordinates");
  if (coordinates === null || coordinates === undefined) throw new MalformedGeometry();
  const flat = (c: unknown): unknown[] => {
    // `c[0]` of null throws, as does `c.map` on anything but a list.
    if (c === null || c === undefined) throw new MalformedGeometry();
    if (!isArray(elementAt(c, 0))) return [c];
    if (!isArray(c)) throw new MalformedGeometry();
    return c.flatMap((item) => flat(item));
  };
  const points = flat(coordinates);
  const middle = points[Math.floor(points.length / 2)];
  return isTruthy(middle) ? middle : points[0];
}

/** The first truthy of `name`, `street`, `description`, cut to 90 as `.slice(0, 90)` would. */
function labelOf(props: unknown): string | null {
  const candidates = [field(props, "name"), field(props, "street"), field(props, "description")];
  const chosen = candidates.find(isTruthy) ?? "Baustelle";
  if (isString(chosen)) return chosen.slice(0, 90);
  // Array.prototype.slice exists too; the result then goes through String().
  if (isArray(chosen)) return jsString(chosen.slice(0, 90));
  return null;
}

/* ------------------------------------------------------------------ parse */

function feature(raw: unknown, index: number): RoadworkFeature | null {
  // `f.properties` of a non-object throws in the original as well.
  if (!isRecord(raw)) throw new ParseError(`features[${String(index)}]`, "object", raw);
  // `(f.properties || {})` / `f.properties || {}`
  const props = isTruthy(raw.properties) ? raw.properties : {};
  const endtime = field(props, "endtime");
  let p0: unknown;
  try {
    p0 = firstPoint(raw.geometry);
  } catch (error) {
    if (error instanceof MalformedGeometry) return null;
    throw error;
  }
  const id = field(props, "id");
  const reference = field(props, "reference");
  const key = isTruthy(id) ? id : isTruthy(reference) ? reference : null;
  return {
    endtime: isTruthy(endtime) ? jsString(endtime) : null,
    point: isTruthy(p0) ? [jsNumber(elementAt(p0, 0)), jsNumber(elementAt(p0, 1))] : null,
    key: key === null ? null : jsString(key),
    label: labelOf(props),
  };
}

/** Loud when the feed is not a FeatureCollection; a feature without usable geometry is counted. */
export function parse(raw: unknown): RoadworkFeed {
  const features = field(raw, "features");
  if (!isArray(features)) throw new ParseError("payload.features", "array", features);
  const out: RoadworkFeature[] = [];
  let malformedGeometry = 0;
  features.forEach((item, index) => {
    const parsed = feature(item, index);
    if (parsed === null) malformedGeometry += 1;
    else out.push(parsed);
  });
  return { features: out, malformedGeometry };
}

/* ------------------------------------------------------------------ build */

// Coordinate sanity check. Some records carry [lat, lon] instead of GeoJSON's
// [lon, lat]; they are swapped back (also in the written location). Anything
// else outside the BW range is dropped.
const inLat = (v: number): boolean => v >= 47 && v <= 50;
const inLon = (v: number): boolean => v >= 7 && v <= 11;

/** Pure: no network, no clock, no global state — this is what parity diffs. */
export function build(raw: RoadworkFeed, geo: GeoIndex | null, now: IsoTime): RoadworkBuild {
  const entities: (RoadworkEntity | RoadworkSummaryEntity)[] = [];
  const byKreis = new Map<KreisCode, number>();
  let ended = 0;
  let swapped = 0;
  let invalid = 0;
  let outside = 0;
  const today = now.slice(0, 19);

  for (const f of raw.features) {
    // Bereits beendete Maßnahmen gar nicht erst aufnehmen — der Feed führt sie
    // teilweise noch mit, sie sind für die Kommune aber ohne Belang.
    // (String comparison of the first 19 characters, the offset ignored — as before.)
    if (f.endtime !== null && f.endtime.slice(0, 19) < today) {
      ended += 1;
      continue;
    }
    const p0 = f.point;
    if (p0 === null) continue;
    let [x, y] = p0;
    if (!inLat(y) && inLat(x) && inLon(y)) {
      [x, y] = [y, x];
      swapped += 1;
    } else if (!inLat(y) || !inLon(x)) {
      invalid += 1;
      continue;
    }
    // Strict point-in-polygon: a roadwork just across a municipal boundary no
    // longer lands in the neighbour with the closer centroid.
    const municipality = geo === null ? null : geo.municipalityAt(y, x);
    if (municipality === null) {
      outside += 1;
      continue;
    }
    const kreis = municipality[4];
    byKreis.set(kreis, (byKreis.get(kreis) ?? 0) + 1);
    // Free text never becomes an id unchanged: everything outside [A-Za-z0-9_-]
    // turns into '-'. Without id and reference, the running entity count.
    const key = (f.key ?? String(entities.length)).replace(/[^A-Za-z0-9_-]+/g, "-");
    if (f.label === null) {
      // `.slice` of a number or object: the old node threw here and lost the run.
      throw new ParseError(`features (road work ${key}).properties.name`, "string", f.label);
    }
    entities.push({
      id: `urn:ngsi-ld:RoadWork:bw-svz-${key}`,
      type: "RoadWork",
      name: { type: "Property", value: cleanText(f.label) },
      ags: { type: "Property", value: municipality[0] },
      gemeindeName: { type: "Property", value: cleanText(municipality[1]) },
      dateObserved: dateObserved(now),
      location: { type: "GeoProperty", value: { type: "Point", coordinates: [x, y] } },
      "@context": NGSI_CONTEXT,
      ...(f.endtime === null ? {} : { endDate: { type: "Property", value: f.endtime.slice(0, 19) } }),
    });
  }
  // `Object.keys(byKreis)`: the district codes start with a zero, so they are
  // not array-index keys and keep their insertion order — as the Map does.
  for (const [kreis, count] of byKreis) {
    entities.push({
      id: `urn:ngsi-ld:RoadWork:bw-kreis-${kreis}-summary`,
      type: "RoadWork",
      ags: { type: "Property", value: kreis },
      name: { type: "Property", value: `Baustellen Kreis ${kreis} (Summe)` },
      activeCount: observed(count, "C62", now),
      "@context": NGSI_CONTEXT,
    });
  }
  return {
    entities,
    districts: byKreis.size,
    ended,
    swapped,
    invalid,
    outside,
    features: raw.features.length,
  };
}

/** The status line of the old node, in English. */
export function statusText(result: RoadworkBuild): string {
  return (
    `${String(result.entities.length)} objects, ${String(result.districts)} districts` +
    (result.ended > 0 ? `, ${String(result.ended)} ended skipped` : "") +
    (result.swapped > 0 ? `, ${String(result.swapped)} coordinates swapped` : "") +
    (result.invalid > 0 ? `, ${String(result.invalid)} invalid` : "") +
    (result.outside > 0 ? `, ${String(result.outside)} outside BW` : "")
  );
}

/* ------------------------------------------------------------------ expiry */

/**
 * FN_RW_EXPIRE: ids from the listing whose `endDate` (plain or as `.value`)
 * lies before now — string comparison of the first 19 characters, as before.
 * Pure; `now` is the run's clock.
 */
export function expiredIds(listing: readonly unknown[], now: IsoTime): EntityId[] {
  const today = now.slice(0, 19);
  const ids: EntityId[] = [];
  for (const entity of listing) {
    const endDate = field(entity, "endDate");
    // `e.endDate && (e.endDate.value != null ? e.endDate.value : e.endDate)`
    const value = isTruthy(endDate) ? field(endDate, "value") : undefined;
    const end = isTruthy(endDate) ? (value ?? endDate) : endDate;
    const id = field(entity, "id");
    // The old node pushed `e.id` whatever it was; only an entity id can be deleted.
    if (isString(end) && end.slice(0, 19) < today && isEntityId(id)) ids.push(id);
  }
  return ids;
}

async function expire(ctx: Ctx): Promise<void> {
  let response: JsonResponse;
  try {
    response = await ctx.orion.find({
      type: "RoadWork",
      idPattern: EXPIRY_ID_PATTERN,
      attrs: ["endDate"],
      limit: EXPIRY_LIMIT,
    });
  } catch (error) {
    ctx.log.warn(`${LABEL} expiry: query failed (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  if (!response.ok || !isArray(response.body)) {
    ctx.log.warn(`${LABEL} expiry: query failed (${String(response.status)})`);
    return;
  }
  const ids = expiredIds(response.body, ctx.now());
  if (ids.length === 0) {
    ctx.log.status("nothing expired");
    return;
  }
  ctx.log.status(`${String(ids.length)} expired roadworks deleted`);
  // One request of at most 200 per run; the rest follows in the next one.
  await ctx.orion.delete(ids.slice(0, EXPIRY_MAX_DELETE), {
    chunkSize: EXPIRY_MAX_DELETE,
    label: `${LABEL} expiry`,
  });
}

/* ------------------------------------------------------------------ run */

async function ingest(ctx: Ctx): Promise<void> {
  let response: JsonResponse;
  try {
    response = await ctx.fetch.json(SOURCE_URL);
  } catch (error) {
    ctx.log.warn(`${LABEL}: data incomplete (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  if (!response.ok || !isArray(field(response.body, "features"))) {
    ctx.log.warn(`${LABEL}: data incomplete (${String(response.status)})`);
    return;
  }

  // Master data AND boundaries required: without them the run is skipped
  // instead of assigning by centroid.
  const geo = ctx.geo.forRun(LABEL);
  if (geo === null) return;

  const feed = parse(response.body);
  if (feed.malformedGeometry > 0) {
    ctx.log.warn(`${LABEL}: ${String(feed.malformedGeometry)} features without a usable geometry skipped`);
  }
  const result = build(feed, geo, ctx.now());
  const status = statusText(result);
  ctx.log.status(status);
  if (result.features > 0 && result.invalid > result.features * 0.05) {
    ctx.log.warn(
      `${LABEL}: ${String(result.invalid)} of ${String(result.features)} records with invalid coordinates — feed format changed?`,
    );
  }
  if (result.entities.length === 0) return;

  // Road works are written in full every run (no gate in the old flow either).
  await ctx.orion.upsert(ctx.gate.ungated(result.entities), { chunkSize: CHUNK_SIZE });

  // Complete feed, plausible master data, non-empty result -> remove own
  // roadworks and district sums this run no longer confirms (left the feed,
  // outside BW). The interval guard uses the registry interval (6 h), the
  // value the generator wrote into the old call. Never throws.
  await ctx.prune.stale({
    label: LABEL,
    type: "RoadWork",
    pattern: PRUNE_PATTERN,
    attrs: ["ags", "dateObserved", "activeCount"],
    keep: new Set(result.entities.map((entity) => entity.id)),
    graceMs: 24 * 3_600_000,
    status,
  });
}

export async function run(ctx: Ctx): Promise<void> {
  try {
    await ingest(ctx);
  } finally {
    // Independent of the ingest, as its own inject was.
    await expire(ctx);
  }
}

export const connector: ConnectorModule<RoadworkFeed, RoadworkBuild> = { id: ID, parse, build, run };
