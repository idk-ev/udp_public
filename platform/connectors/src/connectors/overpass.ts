/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * What the three Overpass connectors (`rathaus-bw`, `ausflug-bw`, `poi-bw`)
 * share: the request, its pacing and retries, the narrowing of an Overpass
 * response, the "bündeln" node (FN_AUSFLUG_WRAP) that the two tiled
 * connectors put behind every request, and the two guards in front of their
 * writes. Not a connector itself.
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
 *    none at all.
 *  * Strictly one after another, across all three connectors: at most
 *    {@link OVERPASS_MAX_CONCURRENT} request towards the host in flight
 *    (`maxConcurrent` of the shared bucket), and within a connector the next
 *    tile is only requested once the previous one answered. The delay node
 *    only spaced the STARTS, so a tile slower than 90 s overlapped the next.
 *  * No transport retries (the fetcher would retry twice within seconds). A
 *    request is retried only when Overpass REFUSED it — see below.
 *  * 120 s client timeout — Node-RED's default `httpRequestTimeout`, which the
 *    nodes ran with; the queries themselves ask for {@link OVERPASS_QUERY_TIMEOUT_S}.
 *
 * ## Why the 504s, and what the queries declare (deliberate deviation)
 *
 * The 504 of a busy Overpass is its admission control: a query is only
 * started when the server can reserve the memory and time the query DECLARES.
 * The flows declared `[timeout:120]` resp. `[timeout:90]` and no `[maxsize:]`,
 * so every request asked for the default 512 MiB, and a busy server refused it
 * at once ("Dispatcher_Client::request_read_and_idx::timeout. The server is
 * probably too busy to handle your request."). Every query now declares
 * `[timeout:60]` and a `[maxsize:]` sized per connector from measurements
 * (2026-10, {@link overpassSettings}); a query that needs more than it
 * declared ends with a `remark` and counts as a failed tile (below).
 *
 * ## Retries (deliberate deviation)
 *
 * A tile answered with HTTP 429, or with a 504 that came back faster than the
 * query could have run (< {@link OVERPASS_FAST_FAILURE_MS}, or naming the busy
 * dispatcher), was refused, not attempted — so it is worth asking again, after
 * a pause: {@link OVERPASS_RETRY_DELAYS_MS} (2, 3.5, 5 min), longer when
 * `Retry-After` asks for it (up to {@link OVERPASS_MAX_RETRY_AFTER_MS}; a
 * longer one is not waited for). The pause is set on the SHARED bucket
 * (`ctx.limiter.pause`), so every Overpass connector waits, and the retry
 * itself is paced like any request. At most {@link OVERPASS_RUN_RETRY_BUDGET}
 * retries per run, and a refusal after those (or a `Retry-After` beyond the
 * cap) ends the run's requests: the remaining tiles are not sent and count as
 * failed. So a day on which Overpass refuses everything costs a bounded time,
 * and Overpass is not asked again and again. A timeout, a remark, a body that
 * is no JSON or any other status is not retried: the same query would end the
 * same way.
 *
 * Worst case of one run (every request at the 120 s client timeout, every
 * retry used, each after the longest `Retry-After` waited for, plus the
 * `Retry-After` pause of the two tiles whose own retries ran out): tiles ×
 * 120 s + 6 × (600 s + 120 s) + 2 × 600 s — `poi-bw` (12 tiles) ~1 h 56 min,
 * `ausflug-bw` (15 tiles) ~2 h 2 min, `rathaus-bw` (one request, three
 * retries) ~38 min. With the own waits only (2 + 3.5 + 5 min for at most two
 * requests) it is about an hour for the tiled ones. The Sunday crons (01:40, 04:40, 05:10)
 * stay apart even then; where they meet, the shared bucket queues them. The
 * scheduler never starts a second run of a connector while one is active (a
 * cron firing or `/trigger` meanwhile is skipped resp. answered "running").
 *
 * ## Failed tiles and the two write guards (deliberate deviation)
 *
 * A tile counts as failed when no answer arrived, the status is 400 or more,
 * the body is not JSON or has no `elements` array, or the answer carries a
 * `remark` — Overpass's way of saying "runtime error: Query timed out / ran
 * out of memory", with whatever elements it had collected until then. The
 * flows took such a truncated answer as complete.
 *
 * The flows' comment held partial failures to be harmless ("Entitäten früherer
 * Läufe bleiben in Orion bestehen"). They are not: a municipality on a tile
 * border got its entity rewritten from the tiles that did answer, with a
 * fraction of its destinations (in 2026-10: Stuttgart with 1 of ~1,600). So:
 *
 *  * {@link partialWrites}: after a partial failure, only municipalities whose
 *    bounding box (`bw-grenzen` `b`, plus {@link TILE_GUARD_MARGIN_DEG}) does
 *    not touch a failed tile are written; the others keep their entity.
 *  * {@link implausibleDrop}: a municipality whose count falls by more than
 *    80 % from a previous value of at least 20 is not written either — the
 *    second line of defence against a truncated answer that looks complete.
 *    The previous values are read from the broker before the write
 *    ({@link storedCounts}, one listing per run); a listing that fails writes
 *    nothing, since the guard cannot be evaluated.
 *
 * ## Coordinates
 *
 * `out tags center`: nodes carry `lat`/`lon`, ways and relations a `center`.
 * The old nodes read `el.lat != null ? el.lat : (el.center && el.center.lat)`;
 * {@link parseElement} resolves exactly that once, so the builds see one pair.
 */

import { ParseError, isArray, isRecord, mapLenient } from "../kernel/parse.js";
import type { BoundarySet, Ctx, GeoIndex, RateLimitRelease } from "../kernel/types.js";
import { retryAfterMs } from "./open-meteo-batches.js";

/** The one Overpass instance (no mirror, by decision); also the key of its rate limit bucket. */
export const OVERPASS_HOST = "overpass-api.de";

/** `https://overpass-api.de/api/interpreter?data=` of all three request nodes. */
export const OVERPASS_INTERPRETER = `https://${OVERPASS_HOST}/api/interpreter?data=`;

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
 * `[timeout:60]` of the tiled queries: the run time a query declares, and
 * reserves, at Overpass's admission control. The densest tiles answer in
 * 10–15 s (measured 2026-10), so 60 s is four times that; the flows declared
 * 120 s resp. 90 s.
 */
export const OVERPASS_QUERY_TIMEOUT_S = 60;

export const MIB = 1024 * 1024;

/**
 * `[out:json][timeout:60][maxsize:…]` — the settings every tiled query opens
 * with. `maxsize` is in bytes; the connectors say how they sized theirs.
 */
export function overpassSettings(maxsizeBytes: number): string {
  return `[out:json][timeout:${String(OVERPASS_QUERY_TIMEOUT_S)}][maxsize:${String(maxsizeBytes)}]`;
}

/**
 * Body cap of one Overpass answer (security review; the nodes read without a
 * limit). `out tags center` is compact: the densest tile measured (2026-10,
 * `poi-bw` around Stuttgart, 13,823 elements) is 4.1 MB. 128 MiB is far
 * beyond any tile.
 */
export const OVERPASS_MAX_BYTES = 128 * MIB;

/** Waits before the 1st, 2nd and 3rd retry of a refused request; their number is the per-request limit. */
export const OVERPASS_RETRY_DELAYS_MS: readonly number[] = [120_000, 210_000, 300_000];

/** A `Retry-After` longer than this is not waited for: the request fails, the bucket pauses this long. */
export const OVERPASS_MAX_RETRY_AFTER_MS = 600_000;

/** Retries of one run in total, over all its requests. */
export const OVERPASS_RUN_RETRY_BUDGET = 6;

/**
 * A 504 faster than this was refused at admission, not run into a timeout:
 * the query's own `[timeout:60]` ends a running query with HTTP 200 and a
 * `remark`, so a 504 inside that time never ran.
 */
export const OVERPASS_FAST_FAILURE_MS = OVERPASS_QUERY_TIMEOUT_S * 1000;

/** Characters of the body that a failure's log line quotes. */
const EXCERPT_LENGTH = 100;

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
  /** `type/id` (`way/123`), or `null` without both. Two answers can list the same object. */
  readonly osmId: string | null;
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
    osmId:
      typeof raw.type === "string" && typeof raw.id === "number" ? `${raw.type}/${String(raw.id)}` : null,
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

/** `[south, west, north, east]`, the order of Overpass's `bbox`. */
export type Box = readonly [south: number, west: number, north: number, east: number];

/** One request of a tiled connector: `kind` is `T1`…`T15` resp. `K1`…`K12`. */
export interface OverpassQuery {
  readonly kind: string;
  readonly url: string;
  /** The tile, for the partial-write guard. */
  readonly box: Box;
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
  /** For the warning: `HTTP 504`, `HTTP 200, not JSON`, or the transport error. */
  readonly detail: string;
  /** Milliseconds from sending the request (after the wait for the bucket) to the end of the body. */
  readonly latencyMs: number;
  /** The start of the body (or the remark) as one line, for the log; see {@link excerptOf}. */
  readonly excerpt: string;
  /** `Retry-After` in milliseconds, `null` without a usable one. */
  readonly retryAfterMs: number | null;
  /** The body names Overpass's busy dispatcher ("The server is probably too busy"). */
  readonly busy: boolean;
}

/** An answer with nothing but status and body — what the flows' wrap node saw. */
export function plainResponse(status: number | null, body: unknown, detail = ""): OverpassResponse {
  return { status, body, detail, latencyMs: 0, excerpt: "", retryAfterMs: null, busy: false };
}

/** `remark` of an answer — Overpass's report of a runtime error — or `null` without one. */
export function remarkOf(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const remark = body.remark;
  if (remark === undefined || remark === null) return null;
  const text = typeof remark === "string" ? remark : JSON.stringify(remark);
  return text.trim() === "" ? null : text;
}

/**
 * Why an answer is no usable tile, or `null` when it is one. No answer, an
 * HTTP error, no JSON, no `elements` array — as in the old wrap — and, the
 * deliberate deviation, a `remark`: its elements are whatever Overpass had
 * collected when the query died.
 */
export function failureOf(response: OverpassResponse): string | null {
  if (response.status === null || response.status >= 400) return response.detail;
  if (!hasElements(response.body)) return `${response.detail}, no elements`;
  return remarkOf(response.body) === null ? null : "remark";
}

/**
 * FN_AUSFLUG_WRAP: the elements of a usable answer ({@link failureOf}),
 * otherwise none. Whether a warning is due is the caller's business.
 */
export function wrapPart(kind: string, response: OverpassResponse): RawPart {
  const body = response.body;
  if (failureOf(response) === null && hasElements(body)) return { kind, elements: body.elements };
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

/** How much of a body is looked at for the excerpt and the busy marker. */
const SCAN_LENGTH = 20_000;

/**
 * The start of a body as one line for the log: the HTML head, scripts and
 * markup dropped, whitespace collapsed, from Overpass's "Error:" on where an
 * error page has one, cut to {@link EXCERPT_LENGTH} characters. Control
 * characters are escaped by the logger itself.
 */
export function excerptOf(text: string): string {
  const plain = text
    .slice(0, SCAN_LENGTH)
    .replace(/<(head|script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(strong|em|b|i|span|code)\b[^>]*>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const error = plain.search(/\bError:/);
  return (error > 0 ? plain.slice(error) : plain).slice(0, EXCERPT_LENGTH);
}

function headerOf(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}

/**
 * One Overpass request with the pacing described in the module header. Never
 * throws for a source fault — the nodes ran with `senderr: false` and let the
 * next function decide; a network error or timeout comes back as
 * `status: null`, and so does a shutdown while waiting for the bucket.
 *
 * The token is taken here rather than by the fetcher (`bucket: null` there):
 * so the wait for it — the 90 s spacing, a pause after a refusal — ends on
 * shutdown, and the latency is that of the request alone, which is what tells
 * a refused 504 from a slow one ({@link retryDelayMs}). `beforeRelease` sees
 * the answer while the token is still held: a pause it sets is in place
 * before any other Overpass request can take the next token.
 */
export async function fetchOverpass(
  ctx: Ctx,
  url: string,
  beforeRelease?: (response: OverpassResponse) => void,
): Promise<OverpassResponse> {
  let release: RateLimitRelease;
  try {
    release = await ctx.limiter.acquire(OVERPASS_HOST, {
      minIntervalMs: OVERPASS_MIN_INTERVAL_MS,
      maxConcurrent: OVERPASS_MAX_CONCURRENT,
      signal: ctx.signal,
    });
  } catch (error) {
    // Shutdown while waiting, or a queue that is full: nothing was sent.
    return plainResponse(null, undefined, error instanceof Error ? error.message : String(error));
  }
  try {
    const response = await requestOnce(ctx, url);
    beforeRelease?.(response);
    return response;
  } finally {
    release();
  }
}

/** The request itself, with the token held by the caller. Never throws. */
async function requestOnce(ctx: Ctx, url: string): Promise<OverpassResponse> {
  const started = Date.now();
  try {
    const response = await ctx.fetch.text(url, {
      bucket: null,
      userAgent: OVERPASS_USER_AGENT,
      timeoutMs: OVERPASS_TIMEOUT_MS,
      retries: 0,
      maxBytes: OVERPASS_MAX_BYTES,
    });
    const now = Date.now();
    const answer = {
      status: response.status,
      latencyMs: now - started,
      excerpt: excerptOf(response.body),
      retryAfterMs: retryAfterMs(headerOf(response.headers, "retry-after"), now),
      busy: /too busy|Dispatcher_Client/i.test(response.body.slice(0, SCAN_LENGTH)),
    };
    const detail = `HTTP ${String(response.status)}`;
    if (response.status >= 400) return { ...answer, body: undefined, detail };
    try {
      const body: unknown = JSON.parse(response.body);
      const remark = remarkOf(body);
      if (remark === null) return { ...answer, body, detail };
      return { ...answer, body, detail: `${detail}, remark`, excerpt: excerptOf(remark) };
    } catch {
      // `ret: "obj"` left an unparseable body as a string, which fails the
      // `Array.isArray(payload.elements)` guard — the same as no data. A body
      // cut off in the middle ends here too.
      return { ...answer, body: undefined, detail: `${detail}, not JSON` };
    }
  } catch (error) {
    return {
      ...plainResponse(null, undefined, error instanceof Error ? error.message : String(error)),
      latencyMs: Date.now() - started,
    };
  }
}

/** Overpass refused the request rather than ran it: a 429, or a fast or "too busy" 504. */
export function refused(response: OverpassResponse): boolean {
  return (
    response.status === 429 ||
    (response.status === 504 && (response.busy || response.latencyMs < OVERPASS_FAST_FAILURE_MS))
  );
}

/**
 * The wait before retry number `retry` (0-based) of a failed answer, or
 * `null` when it is not retried: not {@link refused}, the retries of the
 * request used up, or a `Retry-After` beyond {@link OVERPASS_MAX_RETRY_AFTER_MS}.
 * `Retry-After` lengthens the wait, never shortens it.
 */
export function retryDelayMs(response: OverpassResponse, retry: number): number | null {
  if (!refused(response)) return null;
  const base = OVERPASS_RETRY_DELAYS_MS[retry];
  if (base === undefined) return null;
  const asked = response.retryAfterMs;
  if (asked !== null && asked > OVERPASS_MAX_RETRY_AFTER_MS) return null;
  return Math.max(base, asked ?? 0);
}

/** `HTTP 504 after 2.1 s: Error: runtime error: …` — status, latency and the start of the body. */
export function describeAnswer(response: OverpassResponse): string {
  const seconds = (response.latencyMs / 1000).toFixed(1);
  const excerpt = response.excerpt === "" ? "" : `: ${response.excerpt}`;
  return `${response.detail} after ${seconds} s${excerpt}`;
}

/** Retries left in one run ({@link OVERPASS_RUN_RETRY_BUDGET}), and whether to give up. */
export interface RetryBudget {
  remaining: number;
  /**
   * Set once Overpass refuses again after the run's retries are used up, or
   * asks for a pause beyond {@link OVERPASS_MAX_RETRY_AFTER_MS}: the
   * remaining requests of the run are not sent ({@link fetchTiles}).
   */
  givenUp: boolean;
}

export function retryBudget(): RetryBudget {
  return { remaining: OVERPASS_RUN_RETRY_BUDGET, givenUp: false };
}

/** A request's last answer, and how many attempts it took. */
export interface Attempted {
  readonly response: OverpassResponse;
  readonly attempts: number;
}

/** What to do after a failed attempt — decided while its token is still held. */
interface Decision {
  /** Wait before the retry; `null` = no retry. */
  readonly delay: number | null;
  /** The run's retries are used up (logged by the caller). */
  readonly budgetSpent: boolean;
}

/**
 * One request, retried while Overpass refuses it ({@link retryDelayMs}) and
 * the run's budget lasts. The wait is a pause of the shared bucket, set before
 * the attempt's token is released, so the next attempt — and every other
 * Overpass connector — waits for it inside the limiter, and the attempt itself
 * is paced as always. A `Retry-After` that is not waited for still pauses the
 * bucket (up to {@link OVERPASS_MAX_RETRY_AFTER_MS}). `null` on shutdown.
 */
export async function fetchOverpassRetrying(
  ctx: Ctx,
  label: string,
  url: string,
  budget: RetryBudget,
): Promise<Attempted | null> {
  for (let retry = 0; ; retry += 1) {
    let decision: Decision = { delay: null, budgetSpent: false };
    const response = await fetchOverpass(ctx, url, (answer) => {
      if (failureOf(answer) === null) return;
      const delay = retryDelayMs(answer, retry);
      const budgetSpent = delay !== null && budget.remaining <= 0;
      if (delay !== null && !budgetSpent) {
        budget.remaining -= 1;
        ctx.limiter.pause(OVERPASS_HOST, delay);
        decision = { delay, budgetSpent };
        return;
      }
      if (answer.status === 429 && answer.retryAfterMs !== null) {
        // Not waited for here, but honoured by every later Overpass request.
        ctx.limiter.pause(OVERPASS_HOST, Math.min(answer.retryAfterMs, OVERPASS_MAX_RETRY_AFTER_MS));
      }
      const tooLong = answer.retryAfterMs !== null && answer.retryAfterMs > OVERPASS_MAX_RETRY_AFTER_MS;
      if (refused(answer) && (budget.remaining <= 0 || tooLong)) budget.givenUp = true;
      decision = { delay: null, budgetSpent };
    });
    if (ctx.signal.aborted) return null;
    const attempts = retry + 1;
    if (decision.budgetSpent) {
      ctx.log.info(
        `${label}: ${describeAnswer(response)} — not retried, the run's ` +
          `${String(OVERPASS_RUN_RETRY_BUDGET)} retries are used up`,
      );
    }
    if (decision.delay === null) return { response, attempts };
    ctx.log.info(
      `${label}: ${describeAnswer(response)} — retry ${String(attempts)}/` +
        `${String(OVERPASS_RETRY_DELAYS_MS.length)} in ${String(Math.round(decision.delay / 1000))} s`,
    );
  }
}

/** What {@link fetchTiles} brought home: the parts in request order, and the tiles that failed. */
export interface FetchedTiles {
  readonly parts: readonly RawPart[];
  readonly failed: readonly OverpassQuery[];
}

export interface TileOptions {
  /**
   * An answer without elements counts as a failed tile. For a connector whose
   * every tile holds land of the state and plenty of objects (`ausflug-bw`):
   * an empty answer there is more likely a fault than the truth.
   */
  readonly emptyIsFailure?: boolean;
}

/**
 * The requests of a tiled connector, strictly one after another, each wrapped
 * as FN_AUSFLUG_WRAP did and retried as {@link fetchOverpassRetrying} does;
 * a `[warn]` for every failed tile (status, latency, the start of the body)
 * and for an answer without elements. Once Overpass keeps refusing after the
 * run's retries ({@link RetryBudget.givenUp}), the remaining tiles are not
 * requested and count as failed — that bounds a run on a day Overpass
 * refuses everything, and spares it the requests.
 *
 * ## The join timeout, decided
 *
 * The flows collected the answers in a `join` node that emitted after 900 s
 * (`ausflug-bw`, 4 parts) resp. 1,500 s (`poi-bw`, 12 parts) even if parts were
 * missing. It is not reproduced as a deadline. A join needs a timeout because a
 * message can get lost on the way; here every request settles — answer, HTTP
 * error, or the 120 s timeout — so the loop always ends. The failed tiles are
 * handed to the caller, which writes only the municipalities they cannot have
 * falsified ({@link guardWrites}): the flows wrote whatever had arrived, on the
 * belief that partial failures were harmless, and they were not (module
 * header). What a timed-out join ALSO did is not carried over either: the late
 * answers formed a second, partial group that was built and upserted after
 * another timeout.
 *
 * Aborted on shutdown between tiles and before a retry (`null`), so a stop is
 * not held up for the remaining tiles; nothing is written then.
 */
export async function fetchTiles(
  ctx: Ctx,
  queries: readonly OverpassQuery[],
  options: TileOptions = {},
): Promise<FetchedTiles | null> {
  const parts: RawPart[] = [];
  const failed: OverpassQuery[] = [];
  const budget = retryBudget();
  for (const [index, query] of queries.entries()) {
    if (ctx.signal.aborted) return null;
    if (budget.givenUp) {
      const rest = queries.slice(index);
      failed.push(...rest);
      parts.push(...rest.map((skipped) => ({ kind: skipped.kind, elements: [] })));
      ctx.log.warn(
        `Overpass ${rest.map((skipped) => skipped.kind).join(",")}: not requested — ` +
          "Overpass keeps refusing after the run's retries",
      );
      break;
    }
    const attempted = await fetchOverpassRetrying(ctx, `Overpass ${query.kind}`, query.url, budget);
    if (attempted === null) return null;
    const { response, attempts } = attempted;
    const part = wrapPart(query.kind, response);
    const empty = failureOf(response) === null && part.elements.length === 0;
    if (failureOf(response) !== null || (empty && options.emptyIsFailure === true)) {
      failed.push(query);
      const tries = attempts > 1 ? ` after ${String(attempts)} attempts` : "";
      const what = empty ? "answer without elements" : describeAnswer(response);
      ctx.log.warn(
        `Overpass ${query.kind}: failed${tries} — ${what}${empty ? ` (${describeAnswer(response)})` : ""}`,
      );
    } else if (empty) {
      ctx.log.warn(`Overpass ${query.kind}: answer without elements (${describeAnswer(response)})`);
    }
    parts.push(part);
  }
  return { parts, failed };
}

/** The number of malformed elements, reported once per run instead of silently dropped. */
export function reportSkipped(ctx: Ctx, label: string, skipped: number): void {
  if (skipped > 0) ctx.log.warn(`${label}: ${String(skipped)} malformed Overpass elements skipped`);
}

/* ------------------------------------------------------------------ Write guards */

/**
 * Degrees around a municipality's bounding box that must not touch a failed
 * tile either (~1 km). A way is returned by every tile it crosses, but its
 * `center` — what the municipality is assigned by — can lie outside them; and
 * the boundaries are simplified.
 */
export const TILE_GUARD_MARGIN_DEG = 0.01;

/** A previous count below this is never held against a new one: small numbers move a lot. */
export const PLAUSIBLE_MIN_PREVIOUS = 20;

/** A fall below this share of the previous count is refused — a drop of more than 80 %. */
export const PLAUSIBLE_MIN_SHARE = 0.2;

/** Whether the bounding box `[west, south, east, north]`, widened by `margin`, touches the tile. */
export function touches(
  bbox: readonly [west: number, south: number, east: number, north: number],
  box: Box,
  margin = TILE_GUARD_MARGIN_DEG,
): boolean {
  const [west, south, east, north] = bbox;
  const [boxSouth, boxWest, boxNorth, boxEast] = box;
  return (
    west - margin <= boxEast &&
    east + margin >= boxWest &&
    south - margin <= boxNorth &&
    north + margin >= boxSouth
  );
}

/**
 * The municipalities a run with failed tiles may write: those whose bounding
 * box (widened by {@link TILE_GUARD_MARGIN_DEG}) touches no failed tile, so
 * every one of their objects came from tiles that answered. Without failed
 * tiles: all. Without a boundary entry, after a failure: not written.
 */
export function partialWrites<T>(
  entities: readonly T[],
  agsOf: (entity: T) => string,
  failed: readonly OverpassQuery[],
  boundaries: BoundarySet | null,
): { readonly write: readonly T[]; readonly skipped: readonly T[] } {
  if (failed.length === 0) return { write: entities, skipped: [] };
  const write: T[] = [];
  const skipped: T[] = [];
  for (const entity of entities) {
    const entry = boundaries === null ? undefined : boundaries[agsOf(entity)];
    const safe = entry !== undefined && !failed.some((query) => touches(entry.b, query.box));
    (safe ? write : skipped).push(entity);
  }
  return { write, skipped };
}

/**
 * A count that fell by more than 80 % from a previous one of at least 20 —
 * more likely a truncated answer than a municipality that lost four fifths of
 * its objects in a week.
 */
export function implausibleDrop(previous: number | undefined, next: number): boolean {
  return (
    previous !== undefined && previous >= PLAUSIBLE_MIN_PREVIOUS && next < previous * PLAUSIBLE_MIN_SHARE
  );
}

/** Pages of the listing in {@link storedCounts}: ~1,100 municipalities, 1,000 per page. */
const STORED_COUNTS_MAX_PAGES = 5;

/**
 * The count attribute of every `type` entity `bw-…` in the broker, by id —
 * what the plausibility guard compares with. One listing per run (`keyValues`,
 * one attribute, two pages). Read from the broker rather than kept in the
 * connector's state: right after a restart, a lost state or a correction by
 * hand, and on the first run after this change. The reason when the listing
 * failed or was incomplete.
 */
export async function storedCounts(
  ctx: Ctx,
  type: string,
  attribute: string,
): Promise<{ readonly counts: ReadonlyMap<string, number> } | { readonly reason: string }> {
  const listing = await ctx.orion.list(
    { type, idPattern: `^urn:ngsi-ld:${type}:bw-`, attrs: [attribute], options: "keyValues" },
    { maxPages: STORED_COUNTS_MAX_PAGES, dedupe: true },
  );
  if (!listing.ok) return { reason: listing.reason };
  const counts = new Map<string, number>();
  for (const record of listing.entities) {
    if (!isRecord(record) || typeof record.id !== "string") continue;
    // keyValues gives the plain number; a normalized Property is read as well.
    const raw = record[attribute];
    const value = isRecord(raw) ? raw.value : raw;
    if (typeof value === "number" && Number.isFinite(value)) counts.set(record.id, value);
  }
  return { counts };
}

/** What the two guards need to know about a connector's entities. */
export interface GuardOptions<T> {
  /** Log prefix. */
  readonly label: string;
  /** Entity type and count attribute in the broker (`TouristDestination`, `zielCount`). */
  readonly type: string;
  readonly attribute: string;
  readonly idOf: (entity: T) => string;
  readonly agsOf: (entity: T) => string;
  readonly countOf: (entity: T) => number;
  readonly failed: readonly OverpassQuery[];
  readonly geo: GeoIndex;
}

/** Examples quoted in the plausibility guard's log line. */
const GUARD_EXAMPLES = 5;

function municipalities(count: number): string {
  return `${String(count)} ${count === 1 ? "municipality" : "municipalities"}`;
}

/**
 * The entities a run may write, after both guards ({@link partialWrites},
 * {@link implausibleDrop}), every refusal with a `[warn]`. `null` (with a
 * `[warn]`) when the previous counts cannot be read: then nothing is written,
 * and every municipality keeps its entity until the next run.
 */
export async function guardWrites<T>(
  ctx: Ctx,
  entities: readonly T[],
  options: GuardOptions<T>,
): Promise<readonly T[] | null> {
  const { label } = options;
  const partial = partialWrites(entities, options.agsOf, options.failed, options.geo.boundaries);
  if (partial.skipped.length > 0) {
    ctx.log.warn(
      `${label}: ${String(partial.skipped.length)} of ${municipalities(entities.length)} not written — ` +
        `they touch the failed tiles ${options.failed.map((query) => query.kind).join(",")}; previous values kept`,
    );
  }
  if (partial.write.length === 0) return [];

  const stored = await storedCounts(ctx, options.type, options.attribute);
  if ("reason" in stored) {
    ctx.log.warn(
      `${label}: previous counts not readable (${stored.reason}) — nothing written, previous values kept`,
    );
    return null;
  }
  const write: T[] = [];
  const dropped: string[] = [];
  for (const entity of partial.write) {
    const previous = stored.counts.get(options.idOf(entity));
    const next = options.countOf(entity);
    if (implausibleDrop(previous, next)) {
      dropped.push(`${options.agsOf(entity)}: ${String(previous)} → ${String(next)}`);
    } else {
      write.push(entity);
    }
  }
  if (dropped.length > 0) {
    const more = dropped.length > GUARD_EXAMPLES ? ", …" : "";
    ctx.log.warn(
      `${label}: ${municipalities(dropped.length)} not written — count fell by more than 80 % ` +
        `(${dropped.slice(0, GUARD_EXAMPLES).join(", ")}${more}); previous values kept`,
    );
  }
  return write;
}
