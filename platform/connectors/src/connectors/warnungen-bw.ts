/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `warnungen-bw` — official warnings per district (DWD via BrightSky, BBK/NINA),
 * plus the calendar feed `GET /warnungen.ics?kreis=<KRS>`.
 *
 * Port of the chain `udp-rt-bk-*` and of the endpoint `udp-rt-wf-*`:
 *
 *   inject (30 min) -> bw-gemeinden.json -> FN_KREIS_MSGS (88 requests)
 *     -> delay "1 Anfrage/s" -> http request -> FN_WARN_WRAP -> join 88 (180 s)
 *     -> FN_WARN_BUILD -> upsert -> signature commit
 *
 *   http in /warnungen.ics -> FN_WARN_ICS_REQ -> http request (Orion)
 *     -> FN_WARN_ICS_BUILD -> http response
 *
 * The district centroid is the mean of its municipality centres (the file is
 * fetched here, not taken from the geo context — no polygon is involved). Per
 * district one DWD and one NINA request, 44 × 2 = 88, paced at one per second
 * over BOTH hosts together, as the single delay node did.
 *
 * ## The join, and why its timeout is kept
 *
 * The old `join` node collected 88 responses in ARRIVAL order and gave up
 * after 180 s, passing on what it had (docs/migration-konnektoren.md, risk
 * "join-Timeout": partial result, as today). Late responses then opened a new
 * group of their own, which was built and written once IT timed out. So a slow
 * source costs freshness, never the districts that did answer — and the late
 * ones still arrive, one batch later. {@link fanIn} reproduces exactly that,
 * with one difference: once every request has settled, an open group is
 * closed at once instead of waiting out its timer (same content, earlier).
 * A partial group is now logged as a `[warn]`; the old node was silent.
 *
 * ## Deliberate deviation (decided): no response is no data, not "no warnings"
 *
 * A DWD or NINA request that gets no response at all (DNS, timeout, refused —
 * the old node saw a non-numeric `msg.statusCode`) is skipped for its district,
 * which keeps its last value in Orion. The old FN_WARN_WRAP computed
 * `ok: !(msg.statusCode >= 400)`, which is `true` for such a string, and the
 * error text as body yielded zero items: an unreachable source overwrote a real
 * warning with "none". Counted and logged as a `[warn]` per group.
 *
 * The calendar had the same flaw and gets the same fix: when Orion cannot be
 * queried, `/warnungen.ics` answers 503 instead of a 200 "Keine amtlichen
 * Warnungen" (see {@link calendarResponse}). The cockpit nginx caches only
 * 200s, and a calendar client keeps its last events on an error.
 *
 * ## Deliberate differences, only for input the old code crashed on
 *
 *  * A response whose alert list is not a list, or whose entries are null or
 *    carry a non-text headline or severity, is skipped for its district and
 *    counted. The old FN_WARN_BUILD threw and lost the whole batch.
 *  * The severity rank is a `Map`: `RANK['constructor']` on the old object
 *    literal was a function and turned `maxSeverity` into NaN.
 *  * In the calendar, an Alert whose `headlines` is neither a list nor a
 *    string (or an entry that is null) is skipped; the old node threw, and the
 *    request hung without an answer until the proxy gave up.
 *
 * ## Deliberate deviation (licence): headlines in full, with a link
 *
 * Official warnings may only be passed on unaltered. The old nodes cut every
 * headline to 60 characters; now it is stored in full ({@link AlertHeadline}),
 * a NINA headline carries the link to its warning on warnung.bund.de
 * (`url`), and the calendar adds it as the event's `URL`. To stay below the
 * TRoE compound limit, the list (at most three, as before) is shortened by
 * entries, never inside a headline ({@link boundedHeadlines}).
 *
 * ## Deliberate deviations of the calendar (security review)
 *
 *  * TEXT escaping turns a lone `\r` into `\n` as well and drops the other
 *    control characters ({@link esc}); the old node passed a lone `\r`
 *    through, which let a headline forge `URL:` lines or whole events.
 *  * Content lines are folded at 75 octets (RFC 5545, {@link foldLine}); the
 *    old node sent them unfolded. Unfolded, the bytes are the old ones.
 *  * A failed Orion read is a `[warn]` at most once a minute (the rest at
 *    debug), no longer an `[error]` per request: public requests must not be
 *    able to drive the health check's counters.
 */

import { parse as parseMunicipalities } from "./stammdaten-bw.js";
import { COCKPIT_URL } from "../kernel/env.js";
import { weakEtag } from "../kernel/http.js";
import { WarnThrottle } from "../kernel/log.js";
import { cleanText, dateObserved } from "../kernel/ngsi.js";
import { field, isArray, isFiniteNumber, isRecord, isString, isTruthy, ParseError } from "../kernel/parse.js";
import { stateKey } from "../kernel/state.js";
import { NGSI_CONTEXT } from "../kernel/types.js";
import type {
  ConnectorModule,
  Ctx,
  GeoIndex,
  IsoTime,
  JsonResponse,
  KreisCode,
  MunicipalityRow,
  NgsiDateTime,
  NgsiEntity,
  OrionReadOptions,
  Property,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from "../kernel/types.js";

export const ID = "warnungen-bw";

/** Fetched by the connector itself (`udp-rt-bk-get`); overridable for a dev run. */
export const DEFAULT_MUNICIPALITIES_URL = `${COCKPIT_URL}/bw-gemeinden.json`;

/** `join 88`: the node's fixed count — not the number of requests actually sent. */
export const JOIN_COUNT = 88;

/** The join node's timeout, 180 s after the first response of a group. */
export const JOIN_TIMEOUT_MS = 180_000;

/**
 * Bucket of the delay node `udp-rt-bk-rate`: one request per second across both
 * hosts. The fetcher's per-host buckets apply on top and never bind here (each
 * host sees one request every two seconds).
 */
export const FAN_OUT_BUCKET = "warnungen-bw:fan-out";

/** Store key of the change gate, unchanged from the flow. */
export const GATE_KEY = "warnSig";

/** As FN_WARN_BUILD: `emitChunks(node, msg, geaendert, 100)`. */
export const CHUNK_SIZE = 100;

const LABEL = "BW warnings";

/* ------------------------------------------------------------------ requests */

export type WarnSource = "dwd" | "nina";

export interface WarnRequest {
  readonly url: string;
  readonly kreis: KreisCode;
  readonly quelle: WarnSource;
}

/**
 * FN_KREIS_MSGS: districts sorted by key, centroid = mean of the municipality
 * centres (summed in file order, as the old loop did, so the floating point
 * sums are the same), four decimals; DWD first, then NINA, per district.
 */
export function requestsFor(rows: readonly MunicipalityRow[]): readonly WarnRequest[] {
  const sums = new Map<KreisCode, { lat: number; lon: number; n: number }>();
  for (const [, , lat, lon, kreis] of rows) {
    const sum = sums.get(kreis) ?? { lat: 0, lon: 0, n: 0 };
    sum.lat += lat;
    sum.lon += lon;
    sum.n += 1;
    sums.set(kreis, sum);
  }
  const requests: WarnRequest[] = [];
  for (const kreis of [...sums.keys()].sort()) {
    const sum = sums.get(kreis);
    if (sum === undefined) continue;
    const lat = (sum.lat / sum.n).toFixed(4);
    const lon = (sum.lon / sum.n).toFixed(4);
    requests.push({ url: `https://api.brightsky.dev/alerts?lat=${lat}&lon=${lon}`, kreis, quelle: "dwd" });
    requests.push({
      url: `https://warnung.bund.de/api31/dashboard/${kreis}0000000.json`,
      kreis,
      quelle: "nina",
    });
  }
  return requests;
}

/**
 * One element of the join array — what FN_WARN_WRAP made of a response:
 * `{ kreis, quelle, ok: !(msg.statusCode >= 400), body: msg.payload }`.
 */
export interface WarnResponse {
  readonly kreis: KreisCode;
  readonly quelle: WarnSource;
  readonly ok: boolean;
  /** Parsed JSON, or the raw text when it is none (`ret: obj` of the http request node). */
  readonly body: unknown;
  /** Set when the request failed without a response (not part of the old message). */
  readonly failure?: string | undefined;
}

function jsonOrText(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return text;
  }
}

async function fetchPart(ctx: Ctx, request: WarnRequest): Promise<WarnResponse> {
  const { kreis, quelle, url } = request;
  try {
    const response = await ctx.fetch.text(url);
    return { kreis, quelle, ok: !(response.status >= 400), body: jsonOrText(response.body) };
  } catch (error) {
    return noResponse(request, error);
  }
}

/**
 * A request without a response: `ok: false`, so {@link parse} drops it and the
 * district keeps its last value. Deliberate deviation — the old node read it
 * as "no warnings" (see the module header).
 */
function noResponse(request: WarnRequest, error: unknown): WarnResponse {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kreis: request.kreis,
    quelle: request.quelle,
    ok: false,
    body: `${message} : ${request.url}`,
    failure: message,
  };
}

/* ------------------------------------------------------------------ fan-in */

export type GroupEnd = "count" | "timeout" | "settled";

export interface FanInOptions {
  /** Messages per group (`count` of the join node). */
  readonly count: number;
  /** Measured from the ARRIVAL of a group's first message. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  /** Milliseconds clock; `Date.now` by default. */
  readonly nowMs?: (() => number) | undefined;
}

/**
 * The `join` node in custom mode (`build: array`, `count`, `timeout`,
 * `useparts: false`): messages in arrival order; a group opens with its first
 * message and closes on `count` messages or `timeoutMs` after it opened,
 * whatever it holds then. Messages arriving after that open the next group.
 * Additionally, a group closes as soon as every task has settled — nothing can
 * join it any more, so waiting out the timer would only delay the same result.
 *
 * `onGroup` runs once per group, in order; messages keep arriving meanwhile.
 * A rejected task counts as a message that never arrived. On `signal` abort
 * the fan-in stops without handing on the open group.
 */
export async function fanIn<T>(
  tasks: readonly Promise<T>[],
  options: FanInOptions,
  onGroup: (group: readonly T[], end: GroupEnd) => Promise<void>,
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now;
  const signal = options.signal;
  // A function, not a property read: the flag changes across the awaits below.
  const aborted = (): boolean => signal?.aborted === true;
  const queue: { readonly value: T; readonly at: number }[] = [];
  let pending = tasks.length;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const current = wake;
    wake = null;
    current?.();
  };
  for (const task of tasks) {
    task.then(
      (value) => {
        queue.push({ value, at: nowMs() });
        pending -= 1;
        notify();
      },
      () => {
        pending -= 1;
        notify();
      },
    );
  }

  /** Resolves on the next arrival, on abort, or after `ms` (never, for `null`). */
  const nextEvent = (ms: number | null): Promise<void> =>
    new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        wake = null;
        resolve();
      };
      wake = done;
      if (ms !== null) timer = setTimeout(done, Math.max(0, ms));
      signal?.addEventListener("abort", done, { once: true });
    });

  while (pending > 0 || queue.length > 0) {
    if (aborted()) return;
    const first = queue[0];
    if (first === undefined) {
      await nextEvent(null);
      continue;
    }
    const deadline = first.at + options.timeoutMs;
    const group: T[] = [];
    let end: GroupEnd;
    for (;;) {
      while (group.length < options.count) {
        const next = queue.shift();
        if (next === undefined) break;
        group.push(next.value);
      }
      if (group.length >= options.count) {
        end = "count";
        break;
      }
      if (pending === 0) {
        end = "settled";
        break;
      }
      const left = deadline - nowMs();
      if (left <= 0) {
        end = "timeout";
        break;
      }
      await nextEvent(left);
      if (aborted()) return;
    }
    await onGroup(group, end);
  }
}

/* ------------------------------------------------------------------ parse */

/**
 * One headline as it is written into `headlines` — `{ h, sev }`, in that key
 * order, plus `url` (the original warning) where the source has one.
 *
 * `h` is the headline of the issuing service IN FULL: official warnings may
 * only be passed on unaltered (DWD, BBK). The old nodes cut it to 60
 * characters; a page that needs a short line shortens it for display only
 * (CSS), with the full text one click away. The only change left is the
 * apostrophe swap of {@link cleanText}, which keeps the TRoE insert alive
 * (docs/betrieb.md, Orion-LD pitfalls).
 */
// A type alias, not an interface: only an alias is assignable to the JSON value type of a Property.
export type AlertHeadline = Readonly<Record<"h" | "sev", string>> & { readonly url?: string };

/** Page of a NINA warning on warnung.bund.de, by the warning's identifier. */
export const NINA_WARNING_URL = "https://warnung.bund.de/meldungen/";

/** A NINA warning id as the dashboard lists it (`mow.DE-BW-…`, `dwdmap.…`); anything else gets no link. */
const NINA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * Budget for the serialised `headlines` value. Orion-LD drops compound values
 * over ~2 KB from TRoE without a word (docs/betrieb.md); with full headlines
 * the list is cut by ENTRIES to stay below it, never inside a headline.
 * `activeCount` keeps the true number.
 */
export const HEADLINES_MAX_BYTES = 1800;

/** At most three headlines, fewer if their JSON would exceed {@link HEADLINES_MAX_BYTES}; at least one. */
export function boundedHeadlines(headlines: readonly AlertHeadline[]): readonly AlertHeadline[] {
  const out: AlertHeadline[] = [];
  for (const headline of headlines.slice(0, 3)) {
    const next = [...out, headline];
    if (out.length > 0 && Buffer.byteLength(JSON.stringify(next), "utf8") > HEADLINES_MAX_BYTES) break;
    out.push(headline);
  }
  return out;
}

export interface WarnItem {
  readonly headline: AlertHeadline;
  /** `a.expires` as epoch ms (NaN if unparseable); `null` when falsy — never expires. */
  readonly expiresMs: number | null;
}

export interface WarnPart {
  readonly kreis: KreisCode;
  readonly quelle: string;
  readonly items: readonly WarnItem[];
}

export interface WarnParts {
  readonly parts: readonly WarnPart[];
  /** Responses the old node would have crashed on; skipped per district. */
  readonly skipped: number;
}

/** `x || ''` of a text field — anything but text there made the old node throw. */
function textField(value: unknown, at: string): string {
  if (!isTruthy(value)) return "";
  if (!isString(value)) throw new ParseError(at, "string", value);
  return value;
}

/** `new Date(a.expires).getTime()` for a JSON value. */
function epochMs(value: unknown): number {
  if (isString(value) || isFiniteNumber(value)) return new Date(value).getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  return Number.NaN;
}

function dwdItems(body: unknown, at: string): WarnItem[] {
  // `((part.body && part.body.alerts) || [])`
  const alerts = isTruthy(body) ? field(body, "alerts") : undefined;
  if (!isTruthy(alerts)) return [];
  if (!isArray(alerts)) throw new ParseError(`${at}.alerts`, "array", alerts);
  return alerts.map((alert, index) => {
    const where = `${at}.alerts[${String(index)}]`;
    if (alert === null || alert === undefined) throw new ParseError(where, "object", alert);
    const headline = field(alert, "headline_de");
    const event = field(alert, "event_de");
    const text = textField(isTruthy(headline) ? headline : event, `${where}.headline_de`);
    const expires = field(alert, "expires");
    return {
      headline: {
        h: cleanText(text),
        sev: textField(field(alert, "severity"), `${where}.severity`).toLowerCase(),
      },
      expiresMs: isTruthy(expires) ? epochMs(expires) : null,
    };
  });
}

function ninaItems(body: unknown, at: string): WarnItem[] {
  if (!isArray(body)) return [];
  return body.map((warning, index) => {
    const where = `${at}[${String(index)}]`;
    if (warning === null || warning === undefined) throw new ParseError(where, "object", warning);
    // `(w.payload && w.payload.data) || {}`
    const payload = field(warning, "payload");
    const data = isTruthy(payload) ? field(payload, "data") : undefined;
    const id = field(warning, "id");
    const headline: AlertHeadline = {
      h: cleanText(textField(field(data, "headline"), `${where}.payload.data.headline`)),
      sev: textField(field(data, "severity"), `${where}.payload.data.severity`).toLowerCase(),
    };
    return {
      headline:
        isString(id) && NINA_ID.test(id) ? { ...headline, url: `${NINA_WARNING_URL}${id}` } : headline,
      expiresMs: null,
    };
  });
}

/**
 * The join array in, the items per district out. Loud when the array is not
 * one; a response the old node would have thrown on is skipped and counted.
 * Failed parts (`!ok`) and parts without a district are dropped silently, as
 * `if (!part || !part.kreis || !part.ok) continue;` did.
 */
export function parse(raw: unknown): WarnParts {
  if (!isArray(raw)) throw new ParseError("payload", "array of responses", raw);
  const parts: WarnPart[] = [];
  let skipped = 0;
  raw.forEach((part, index) => {
    const kreis = field(part, "kreis");
    if (!isTruthy(part) || !isTruthy(kreis) || !isTruthy(field(part, "ok"))) return;
    const at = `payload[${String(index)}]`;
    if (!isString(kreis)) throw new ParseError(`${at}.kreis`, "string", kreis);
    const quelle = field(part, "quelle");
    const body = field(part, "body");
    try {
      const items = quelle === "dwd" ? dwdItems(body, `${at}.body`) : ninaItems(body, `${at}.body`);
      parts.push({ kreis, quelle: isString(quelle) ? quelle : String(quelle), items });
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      skipped += 1;
    }
  });
  return { parts, skipped };
}

/* ------------------------------------------------------------------ build */

export interface AlertEntity extends NgsiEntity {
  readonly id: `urn:ngsi-ld:Alert:bw-kreis-${string}`;
  readonly type: "Alert";
  readonly ags: Property<string>;
  readonly category: Property<string>;
  readonly activeCount: Property<number>;
  readonly maxSeverity: Property<number>;
  readonly headlines: Property<readonly AlertHeadline[]>;
  readonly dateObserved: Property<NgsiDateTime>;
  readonly "@context": string;
}

const RANK: ReadonlyMap<string, number> = new Map([
  ["minor", 1],
  ["moderate", 2],
  ["severe", 3],
  ["extreme", 4],
]);

/** Pure: no network, no clock, no global state — this is what parity diffs. */
export function build(raw: WarnParts, _geo: GeoIndex | null, now: IsoTime): readonly AlertEntity[] {
  // The old node compared DWD `expires` against `Date.now()`; the run's clock is
  // the same instant, handed in.
  const nowMs = Date.parse(now);
  return raw.parts.map((part) => {
    const headlines = part.items
      .filter((item) => part.quelle !== "dwd" || item.expiresMs === null || item.expiresMs > nowMs)
      .map((item) => item.headline);
    let maxSeverity = 0;
    for (const headline of headlines) maxSeverity = Math.max(maxSeverity, RANK.get(headline.sev) ?? 0);
    return {
      id: `urn:ngsi-ld:Alert:bw-kreis-${part.kreis}-${part.quelle}`,
      type: "Alert",
      ags: { type: "Property", value: part.kreis },
      category: { type: "Property", value: part.quelle === "dwd" ? "weather" : "safety" },
      activeCount: { type: "Property", value: headlines.length, unitCode: "C62", observedAt: now },
      maxSeverity: { type: "Property", value: maxSeverity, observedAt: now },
      headlines: { type: "Property", value: boundedHeadlines(headlines), observedAt: now },
      dateObserved: dateObserved(now),
      "@context": NGSI_CONTEXT,
    };
  });
}

/**
 * Warnings are unchanged most of the time (often zero active warnings for
 * hours) — only a changed picture is written. The headlines are part of the
 * signature so that new or changed messages get through at the same count.
 */
export function signatureOf(entity: AlertEntity): string {
  return (
    `${String(entity.activeCount.value)}|${String(entity.maxSeverity.value)}|` +
    JSON.stringify(entity.headlines.value)
  );
}

/* ------------------------------------------------------------------ run */

async function writeGroup(ctx: Ctx, group: readonly WarnResponse[], end: GroupEnd): Promise<void> {
  if (end === "timeout") {
    ctx.log.warn(
      `${LABEL}: join timed out after ${String(JOIN_TIMEOUT_MS / 1000)} s with ${String(group.length)} of ` +
        `${String(JOIN_COUNT)} responses — writing the partial set, late responses follow as their own batch`,
    );
  }
  const failed = group.filter((part) => part.failure !== undefined);
  if (failed.length > 0) {
    ctx.log.warn(
      `${LABEL}: ${String(failed.length)} requests without a response, skipped — those districts keep ` +
        `their last value (first: ${failed[0]?.failure ?? ""})`,
    );
  }
  const parts = parse(group);
  if (parts.skipped > 0) ctx.log.warn(`${LABEL}: ${String(parts.skipped)} unreadable responses skipped`);
  const entities = build(parts, null, ctx.now());
  if (entities.length === 0) return;
  ctx.log.status(`${String(entities.length)} district warning situations`);
  const result = await ctx.orion.upsertChanged(GATE_KEY, entities, signatureOf, { chunkSize: CHUNK_SIZE });
  if (result.entities > 0) {
    ctx.log.info(
      `${String(result.entities)} of ${String(entities.length)} district warnings upserted ` +
        `(${String(result.failedChunks)} chunks failed, ${String(result.committed)} signatures committed)`,
    );
  }
}

export async function run(ctx: Ctx): Promise<void> {
  const url = ctx.env.get("UDP_MUNICIPALITIES_URL") ?? DEFAULT_MUNICIPALITIES_URL;
  let response: JsonResponse;
  try {
    response = await ctx.fetch.json(url);
  } catch (error) {
    ctx.log.warn(
      `${LABEL}: bw-gemeinden.json not loadable (${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }
  if (!response.ok || !isArray(field(response.body, "gemeinden"))) {
    ctx.log.warn(`${LABEL}: bw-gemeinden.json not loadable`);
    return;
  }
  const requests = requestsFor(parseMunicipalities(response.body).gemeinden);

  // The delay node: requests leave one per second, each without waiting for
  // the previous answer.
  // The bucket only spaces the starts (no concurrency cap), so the acquisition
  // is released right away.
  let pace: Promise<void> = Promise.resolve();
  const tasks = requests.map((request) => {
    pace = pace.then(async () => {
      const release = await ctx.limiter.acquire(FAN_OUT_BUCKET, { minIntervalMs: 1000 });
      release();
    });
    return pace.then(
      () => fetchPart(ctx, request),
      (error: unknown): WarnResponse => noResponse(request, error),
    );
  });

  await fanIn(tasks, { count: JOIN_COUNT, timeoutMs: JOIN_TIMEOUT_MS, signal: ctx.signal }, (group, end) =>
    writeGroup(ctx, group, end),
  );
}

/* ------------------------------------------------------------------ /warnungen.ics */

const BAD_REQUEST_TEXT = "Parameter kreis=<5-stelliger Kreisschlüssel> fehlt.";

/**
 * `String(msg.req.query.kreis || '')` with Express's query parsing: a repeated
 * parameter is an array, whose `String()` joins with commas. The bracket forms
 * of `qs` (`kreis[]=…`) are not reproduced; they are a different key here.
 */
export function kreisParameter(query: URLSearchParams): string {
  return query
    .getAll("kreis")
    .join(",")
    .replace(/[^0-9]/g, "");
}

/** `String(x)` for a value read back from Orion (keyValues). */
function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (isString(value)) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isArray(value)) return value.map(text).join(",");
  return "[object Object]";
}

/**
 * iCalendar TEXT escaping (RFC 5545, 3.3.11): `, ; \` escaped as in the old
 * node, and EVERY line break — `\r\n`, `\n` and a lone `\r` — as `\n`. The old
 * node let a lone `\r` through, so a headline with `\rURL:…` or
 * `\rBEGIN:VEVENT` forged a property or an event of its own for a lenient
 * parser. The other control characters (CONTROL of RFC 5545: U+0000–U+0008,
 * U+000A–U+001F, U+007F) are dropped; a tab stays, TEXT allows it.
 */
export function esc(value: string): string {
  const escaped = value.replace(/([,;\\])/g, "\\$1").replace(/\r\n|\r|\n/g, "\\n");
  let out = "";
  for (const char of escaped) {
    const code = char.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) continue;
    out += char;
  }
  return out;
}

/** RFC 5545, 3.1: content lines longer than this many octets are folded. */
export const FOLD_OCTETS = 75;

/**
 * Folds one content line at {@link FOLD_OCTETS} octets of UTF-8: CRLF plus a
 * space before each continuation, the space counting towards its line; never
 * inside a code point. The old node did not fold; unfolding (removing every
 * CRLF followed by a space) gives its line back.
 */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= FOLD_OCTETS) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  let limit = FOLD_OCTETS;
  for (const char of line) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (size + bytes > limit) {
      parts.push(current);
      current = "";
      size = 0;
      limit = FOLD_OCTETS - 1;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/**
 * The `url` of a headline as an iCalendar URL value (RFC 5545, 3.3.13, not
 * TEXT-escaped): only a link to a warning page on warnung.bund.de, and only
 * characters of an id ({@link NINA_ID}) — anything else is dropped, so a
 * value read back from Orion cannot break the line or point elsewhere.
 */
export function calendarUrl(value: unknown): string | null {
  if (!isString(value) || !value.startsWith(NINA_WARNING_URL)) return null;
  return NINA_ID.test(value.slice(NINA_WARNING_URL.length)) ? value : null;
}

/** `a.headlines || []` iterated as the old `for…of` did: a list, or a string's characters. */
function headlinesOf(alert: Readonly<Record<string, unknown>>): readonly unknown[] {
  const headlines = alert.headlines;
  if (!isTruthy(headlines)) return [];
  if (isArray(headlines)) return headlines;
  // `for…of` over a string walks its code points, as Array.from does.
  if (isString(headlines)) return Array.from(headlines);
  return [];
}

/**
 * FN_WARN_ICS_BUILD: one VEVENT per current headline, or one "Keine amtlichen
 * Warnungen" event. Pure — `now` is the request's clock; `stamp` goes into
 * UID, DTSTAMP and DTSTART, so a calendar sees a new state on every fetch.
 */
export function renderCalendar(kreis: string, alerts: readonly unknown[], now: IsoTime): string {
  const stamp = `${now.replace(/[-:]/g, "").slice(0, 15)}Z`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//UDP//Warnungen//DE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:Warnungen Kreis ${kreis}`,
  ];
  let n = 0;
  for (const alert of alerts) {
    if (!isRecord(alert)) continue;
    const id = alert.id;
    const quelle = text(isTruthy(id) ? id : "").endsWith("-nina") ? "BBK/NINA" : "DWD";
    for (const headline of headlinesOf(alert)) {
      if (headline === null || headline === undefined) continue;
      n += 1;
      const title = [field(headline, "h"), field(headline, "headline")].find(isTruthy) ?? "Warnung";
      const description = [field(headline, "desc"), field(headline, "description")].find(isTruthy) ?? "";
      const link = calendarUrl(field(headline, "url"));
      lines.push(
        "BEGIN:VEVENT",
        `UID:${kreis}-${String(n)}-${stamp}@udp`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${stamp}`,
        `SUMMARY:${esc(`${quelle}: ${text(title)}`)}`,
        `DESCRIPTION:${esc(`${text(description)} (Quelle: ${quelle}, amtliche Warnung)`)}`,
        ...(link === null ? [] : [`URL:${link}`]),
        "END:VEVENT",
      );
    }
  }
  if (n === 0) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:none-${kreis}-${stamp}@udp`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${stamp}`,
      "SUMMARY:Keine amtlichen Warnungen",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/**
 * The bytes the old `http response` node sent: `msg.statusCode`, `msg.headers`,
 * and what Express's `res.send` added to a string body — `; charset=utf-8` on a
 * bare `text/plain`, the weak ETag (kept so a calendar client's cache sees the
 * same validator). A conditional request that matches it is answered with 304
 * by the kernel's server, as Express did; the body changes every second
 * through its stamp, so a match is rare anyway.
 */
function sendText(status: number, contentType: string, body: string): RouteResponse {
  return { status, contentType, body, headers: { ETag: weakEtag(body) } };
}

/** Answer when Orion cannot be queried (deliberate deviation, see the module header). */
export const UNAVAILABLE_TEXT = "Warnungen derzeit nicht abrufbar.";

/**
 * One Orion read for the calendar. No retry and the fetcher's 30 s timeout:
 * the cockpit nginx gives up after 60 s, and the read is unpaced, so it never
 * waits behind a write backlog (src/kernel/orion.ts).
 */
const CALENDAR_READ: OrionReadOptions = { retries: 0 };

/** A failing calendar read is a `[warn]` at most this often. */
export const CALENDAR_WARN_MS = 60_000;

const CALENDAR_FAILURES = stateKey("icsFailureLog", () => new WarnThrottle(CALENDAR_WARN_MS));

/**
 * Logs a failed calendar read. Every request of the public can cause one, and
 * the health check counts `[warn]`/`[error]` lines — so at most one `[warn]`
 * per {@link CALENDAR_WARN_MS}, the rest at debug (security review). The old
 * node logged an `[error]` per request.
 */
function calendarFailure(ctx: Ctx, message: string): void {
  ctx.state.slot(CALENDAR_FAILURES).get().warn(ctx.log, message, Date.parse(ctx.now()));
}

export async function calendarResponse(ctx: Ctx, request: RouteRequest): Promise<RouteResponse> {
  const kreis = kreisParameter(request.query);
  if (!/^\d{5}$/.test(kreis)) {
    // msg.headers = { 'Content-Type': 'text/plain' }; Express appended the charset.
    return sendText(400, "text/plain; charset=utf-8", BAD_REQUEST_TEXT);
  }
  let alerts: readonly unknown[];
  try {
    // `type=Alert&q=ags=="<krs>"&options=keyValues`, no limit (Orion's default).
    const response = await ctx.orion.find(
      { type: "Alert", q: `ags=="${kreis}"`, options: "keyValues" },
      CALENDAR_READ,
    );
    if (!response.ok || !isArray(response.body)) {
      // Deliberate deviation: the old node read an error answer as "no
      // alerts" and served "Keine amtlichen Warnungen" while Orion was down.
      calendarFailure(ctx, `/warnungen.ics: Orion answered HTTP ${String(response.status)} — 503`);
      return sendText(503, "text/plain; charset=utf-8", UNAVAILABLE_TEXT);
    }
    alerts = response.body;
  } catch (error) {
    // No longer a 200 calendar claiming there are no warnings. A `[warn]`,
    // throttled, instead of the old `[error]` per request (see calendarFailure).
    calendarFailure(
      ctx,
      `/warnungen.ics: Orion query failed (${error instanceof Error ? error.message : String(error)}) — 503`,
    );
    return sendText(503, "text/plain; charset=utf-8", UNAVAILABLE_TEXT);
  }
  return sendText(200, "text/calendar; charset=utf-8", renderCalendar(kreis, alerts, ctx.now()));
}

export function routes(ctx: Ctx): readonly RouteDefinition[] {
  return [{ method: "GET", path: "/warnungen.ics", handle: (request) => calendarResponse(ctx, request) }];
}

export const connector: ConnectorModule<WarnParts, readonly AlertEntity[]> = {
  id: ID,
  parse,
  build,
  run,
  routes,
};
