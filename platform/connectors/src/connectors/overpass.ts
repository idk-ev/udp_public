/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * What the three Overpass connectors (`rathaus-bw`, `ausflug-bw`, `poi-bw`)
 * share: the request, its pacing, the narrowing of an Overpass response, and
 * the "bündeln" node (FN_AUSFLUG_WRAP) that the two tiled connectors put
 * behind every request. Not a connector itself.
 *
 * ## Why the pacing is this strict
 *
 * Overpass grants only a few slots per IP and answers overload with 504 (the
 * comment of FN_AUSFLUG_REQ), too many requests with 429. On 21.07.2026 a run of
 * restarts drove it into both. The flows answered with a `delay` node of one
 * request per 90 s in front of every tiled request, a fine 4×3 grid for the
 * volume-heavy amenities (the four coarse quadrants "kippte Overpass
 * reproduzierbar in 504"), a weekly cron, and 600 s of delay after a restart.
 *
 * Here every Overpass request goes through {@link fetchOverpass}, which is
 * at least as polite in every respect:
 *
 *  * One request per 90 s towards `overpass-api.de`, by the kernel's token
 *    bucket (`minIntervalMs`, i.e. `ctx.limiter`). The bucket is keyed by host
 *    and shared by all connectors, so the three of them together keep that
 *    pace; the delay nodes paced each wire on its own, and `rathaus-bw` had
 *    none at all. After a restart all three fire 600 s later — in the flows
 *    `rathaus-bw` and `ausflug-bw` then sent their first requests in the same
 *    second.
 *  * Strictly one after another, across all three connectors: at most
 *    {@link OVERPASS_MAX_CONCURRENT} request towards the host in flight
 *    (`maxConcurrent` of the shared bucket), and within a connector the next
 *    tile is only requested once the previous one answered. The delay node
 *    only spaced the STARTS, so a tile slower than 90 s overlapped the next.
 *  * No retries (the fetcher would retry twice by default). The `http request`
 *    nodes sent once; a retry into an overloaded Overpass is exactly what its
 *    rate limit punishes.
 *  * 120 s client timeout — Node-RED's default `httpRequestTimeout`, which the
 *    nodes ran with (settings.js leaves it commented out).
 *
 * ## Coordinates
 *
 * `out tags center`: nodes carry `lat`/`lon`, ways and relations a `center`.
 * The old nodes read `el.lat != null ? el.lat : (el.center && el.center.lat)`;
 * {@link parseElement} resolves exactly that once, so the builds see one pair.
 */

import { ParseError, isArray, isRecord, mapLenient } from "../kernel/parse.js";
import type { Ctx } from "../kernel/types.js";

/** `https://overpass-api.de/api/interpreter?data=` of all three request nodes. */
export const OVERPASS_INTERPRETER = "https://overpass-api.de/api/interpreter?data=";

/**
 * `OVERPASS_UA` of the generator. Overpass demands a contact address; the
 * request nodes set it by hand, and it is set here explicitly as well, so a
 * service-wide `UDP_USER_AGENT` without one cannot strip it.
 */
export const OVERPASS_USER_AGENT = "UDP-BW-Dashboard/1.0 (kommunale Referenzplattform; tk@idkev.de)";

/** `delay_slow(…, 90)`: "1 Anfrage/90s" in front of the tiled requests. */
export const OVERPASS_MIN_INTERVAL_MS = 90_000;

/**
 * Overpass requests in flight at once, across `rathaus-bw`, `ausflug-bw` and
 * `poi-bw` (one bucket per host): a request waits until the previous one has
 * answered, and then for the 90 s spacing.
 */
export const OVERPASS_MAX_CONCURRENT = 1;

/** Node-RED's default `httpRequestTimeout`, which the `http request` nodes ran with. */
export const OVERPASS_TIMEOUT_MS = 120_000;

/**
 * Body cap of one Overpass answer (security review; the nodes read without a
 * limit). `out tags center` is compact, but a tile or quadrant of dense
 * tourism/amenity data runs into tens of MB: the recorded fixtures extrapolate
 * to ~25 MB for the densest ausflug-bw quadrant. 128 MiB is five times that.
 */
export const OVERPASS_MAX_BYTES = 128 * 1024 * 1024;

/** `'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query)`. */
export function overpassUrl(query: string): string {
  return OVERPASS_INTERPRETER + encodeURIComponent(query);
}

/** One OSM object of an `out tags center` answer, narrowed. */
export interface OverpassElement {
  /** `el.tags || {}`. OSM tag values are strings by definition. */
  readonly tags: ReadonlyMap<string, string>;
  /** `el.lat != null ? el.lat : (el.center && el.center.lat)`; `null` when neither is there. */
  readonly lat: number | null;
  readonly lon: number | null;
}

/** A narrowed answer: the usable elements, and how many were malformed. */
export interface OverpassResult {
  readonly elements: readonly OverpassElement[];
  /** Elements that were not an object, carried a non-string tag or a non-numeric coordinate. */
  readonly skipped: number;
}

/**
 * `el.lat != null ? el.lat : (el.center && el.center.lat)` — `??` is exactly
 * the `!= null` test. A present value that is not a number is malformed: the
 * old nodes would have skipped the element (the strict lookup rejects anything
 * that is not a number), so rejecting it here ends the same way, only counted.
 */
function coordinate(direct: unknown, center: unknown, key: "lat" | "lon", at: string): number | null {
  const value = direct ?? (isRecord(center) ? center[key] : undefined);
  if (value === undefined || value === null) return null;
  if (typeof value !== "number") throw new ParseError(`${at}.${key}`, "number", value);
  return value;
}

function parseTags(raw: unknown, at: string): ReadonlyMap<string, string> {
  const tags = new Map<string, string>();
  // `el.tags || {}`: a missing tag set is an empty one.
  if (raw === undefined || raw === null) return tags;
  if (!isRecord(raw)) throw new ParseError(`${at}.tags`, "object", raw);
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") throw new ParseError(`${at}.tags.${key}`, "string", value);
    tags.set(key, value);
  }
  return tags;
}

export function parseElement(raw: unknown, index: number): OverpassElement {
  const at = `elements[${String(index)}]`;
  if (!isRecord(raw)) throw new ParseError(at, "object", raw);
  return {
    tags: parseTags(raw.tags, at),
    lat: coordinate(raw.lat, raw.center, "lat", at),
    lon: coordinate(raw.lon, raw.center, "lon", at),
  };
}

/**
 * The guard the old nodes opened with — `!msg.payload ||
 * !Array.isArray(msg.payload.elements)` — as a predicate.
 */
export function hasElements(body: unknown): body is { readonly elements: readonly unknown[] } {
  return isRecord(body) && isArray(body.elements);
}

/**
 * Lenient per element: one malformed OSM object must not cost the other
 * municipalities their weekly update. The count is reported by the caller.
 */
export function parseElements(elements: readonly unknown[]): OverpassResult {
  const { values, skipped } = mapLenient(elements, parseElement);
  return { elements: values, skipped };
}

/* ------------------------------------------------------------------ Tiles */

/** One request of a tiled connector: `kind` is `Q1`…`Q4` resp. `K1`…`K12`. */
export interface OverpassQuery {
  readonly kind: string;
  readonly url: string;
}

/**
 * What FN_AUSFLUG_WRAP ("bündeln") hands to the join: `{ kind, elements }`,
 * with `elements` still raw — the build node reads them, so they are narrowed
 * by the connector's `parse`, not here.
 */
export interface RawPart {
  readonly kind: string;
  readonly elements: readonly unknown[];
}

/** A narrowed part, as the build sees it. */
export interface OverpassPart {
  readonly kind: string;
  /** Elements the source delivered — what `p.elements.length` counted for the "sources ok" list. */
  readonly received: number;
  readonly elements: readonly OverpassElement[];
  readonly skipped: number;
}

/** The answer of one Overpass request, before any interpretation. */
export interface OverpassResponse {
  /** `null` when no response arrived at all (timeout, refused, DNS). */
  readonly status: number | null;
  /** The JSON body; `undefined` when there was none or it was not JSON. */
  readonly body: unknown;
  /** For the warning: `HTTP 504`, `not JSON`, or the transport error. */
  readonly detail: string;
}

/**
 * FN_AUSFLUG_WRAP: the elements of an answer below 400 that carries an
 * `elements` array, otherwise none. Whether a warning is due is the caller's
 * business (`elements.length === 0`, as in the old node — an empty answer
 * warns just like a failed one).
 */
export function wrapPart(kind: string, response: OverpassResponse): RawPart {
  const body = response.body;
  if (response.status !== null && response.status < 400 && hasElements(body)) {
    return { kind, elements: body.elements };
  }
  return { kind, elements: [] };
}

/**
 * The joined parts as the build node received them (`msg.payload` behind the
 * join). Loud on a shape the wrap never produces; `!part || !part.elements`
 * parts are skipped as in the old loop.
 */
export function parseParts(raw: unknown): readonly OverpassPart[] {
  if (!isArray(raw)) throw new ParseError("payload", "array of parts", raw);
  const parts: OverpassPart[] = [];
  raw.forEach((part, index) => {
    const at = `payload[${String(index)}]`;
    if (!isRecord(part)) return;
    const elements = part.elements;
    if (elements === undefined || elements === null) return;
    if (!isArray(elements)) throw new ParseError(`${at}.elements`, "array", elements);
    const kind = part.kind;
    if (typeof kind !== "string") throw new ParseError(`${at}.kind`, "string", kind);
    const parsed = parseElements(elements);
    parts.push({ kind, received: elements.length, elements: parsed.elements, skipped: parsed.skipped });
  });
  return parts;
}

/**
 * `okKinds` of the build nodes: kinds of the parts that delivered anything,
 * de-duplicated, in order.
 */
export function okKinds(parts: readonly OverpassPart[]): readonly string[] {
  return [...new Set(parts.filter((part) => part.received > 0).map((part) => part.kind))];
}

/* ------------------------------------------------------------------ I/O */

/**
 * One Overpass request with the pacing described in the module header. Never
 * throws for a source fault — the nodes ran with `senderr: false` and let the
 * next function decide; a network error or timeout comes back as
 * `status: null`.
 */
export async function fetchOverpass(ctx: Ctx, url: string): Promise<OverpassResponse> {
  try {
    const response = await ctx.fetch.text(url, {
      userAgent: OVERPASS_USER_AGENT,
      timeoutMs: OVERPASS_TIMEOUT_MS,
      retries: 0,
      minIntervalMs: OVERPASS_MIN_INTERVAL_MS,
      maxConcurrent: OVERPASS_MAX_CONCURRENT,
      maxBytes: OVERPASS_MAX_BYTES,
    });
    const detail = `HTTP ${String(response.status)}`;
    if (response.status >= 400) return { status: response.status, body: undefined, detail };
    try {
      const body: unknown = JSON.parse(response.body);
      return { status: response.status, body, detail };
    } catch {
      // `ret: "obj"` left an unparseable body as a string, which fails the
      // `Array.isArray(payload.elements)` guard — the same as no data.
      return { status: response.status, body: undefined, detail: `${detail}, not JSON` };
    }
  } catch (error) {
    return { status: null, body: undefined, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The requests of a tiled connector, strictly one after another, each wrapped
 * as FN_AUSFLUG_WRAP did, with its warning for an empty or failed tile.
 *
 * ## The join timeout, decided
 *
 * The flows collected the answers in a `join` node that emitted after 900 s
 * (`ausflug-bw`, 4 parts) resp. 1,500 s (`poi-bw`, 12 parts) even if parts were
 * missing. It is not reproduced as a deadline. A join needs a timeout because a
 * message can get lost on the way; here every request settles — answer, HTTP
 * error, or the 120 s timeout without retry — so the loop always ends, and a
 * failed tile is already the counted partial result the join produced
 * ("Teilausfälle sind unkritisch — Entitäten früherer Läufe bleiben in Orion
 * bestehen"). What a timed-out join ALSO did is not carried over: the late
 * answers formed a second, partial group that was built and upserted after
 * another timeout, overwriting complete per-municipality lists with a fragment.
 *
 * Aborted on shutdown between tiles (`null`), so a stop is not held up for
 * the remaining tiles; nothing is written then.
 */
export async function fetchTiles(ctx: Ctx, queries: readonly OverpassQuery[]): Promise<RawPart[] | null> {
  const parts: RawPart[] = [];
  for (const query of queries) {
    if (ctx.signal.aborted) return null;
    const response = await fetchOverpass(ctx, query.url);
    const part = wrapPart(query.kind, response);
    if (part.elements.length === 0)
      ctx.log.warn(`Overpass ${query.kind}: empty or failed (${response.detail})`);
    parts.push(part);
  }
  return parts;
}

/** The number of malformed elements, reported once per run instead of silently dropped. */
export function reportSkipped(ctx: Ctx, label: string, skipped: number): void {
  if (skipped > 0) ctx.log.warn(`${label}: ${String(skipped)} malformed Overpass elements skipped`);
}
