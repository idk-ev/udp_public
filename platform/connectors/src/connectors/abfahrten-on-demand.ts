/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * `abfahrten-on-demand` — `GET /abfahrten?ags=<AGS>`: the live departures of
 * a municipality's central stop, fetched from EFA-BW when a dashboard asks.
 *
 * Port of the `http in` → FN_ABF_HALT → `http request` → FN_ABF_BAUEN →
 * `http response` chain and of FN_ABF_HALTE_LADEN in
 * the former Node-RED flow generator (see git history). The generator explains why there is no
 * periodic fetch for all municipalities:
 *
 *   > Warum kein Dauerabruf: 1.103 Gemeinden alle 5 Minuten wären 318.000 Anfragen
 *   > am Tag bzw. 3,7 je Sekunde gegen die EFA-BW-Auskunft — ohne Vereinbarung mit
 *   > dem NVBW nicht vertretbar (die Klärung steht aus, Sprint 3.5). Der Abruf
 *   > erfolgt deshalb erst, wenn jemand ein Dashboard öffnet. Die Last skaliert
 *   > damit mit tatsächlichen Seitenaufrufen statt mit der Zahl der Gemeinden, und
 *   > die Anzeige ist dabei sekundenaktuell statt bis zu 5 Minuten alt.
 *   > Der Micro-Cache des Cockpit-nginx (60 s, proxy_cache_lock) fängt Andrang auf
 *   > denselben Halt ab, sodass gleichzeitige Aufrufe zu einer Anfrage werden.
 *
 * `run` is the daily job that loads the stop directory (`oepnv-halte.json`,
 * written by scripts/efa-haltestellen.py, served by the cockpit) — the old
 * `global.set('oepnvHalte', …)`. The directory lives in `ctx.state`
 * ({@link DIRECTORY}), which `run` and the route share; until the first run
 * the route answers 503, as before.
 *
 * ## The answer, byte for byte
 *
 * `gui/public/stadt.html` consumes this, and the cockpit nginx caches it
 * (`location = /abfahrten`, 60 s for 200, 30 s for 404; on 5xx the last good
 * answer is served stale, a 5xx itself is not cached). Status codes,
 * JSON shape and error bodies are those of the old nodes. Headers are those
 * Node-RED's `http response` node produced through Express 4: `Content-Type:
 * application/json; charset=utf-8` (`res.jsonp` on an object payload; the 200
 * path set the same value itself) and a weak `ETag` over the body, which
 * `res.send` generates for every status (`weakEtag`, src/kernel/http.ts). The
 * kernel's server answers `HEAD`, `OPTIONS` and a matching `If-None-Match`
 * (304) around the route as Express did. An upstream
 * header never reached the client: the http request node tags the headers it
 * copies into `msg.headers`, and the response node drops them while unchanged.
 *
 * ## The `ags` parameter
 *
 * At least as strict as before: the old node looked `req.query.ags` up in the
 * directory, so anything that is not a stored AGS was a 404 echoing the value.
 * The port validates `^\d{8}$` before the lookup and answers the same 404 with
 * the same echo. Stricter where Express's query parser was lenient:
 * `?ags[]=08111000` (an array the old lookup coerced back to "08111000") is no
 * longer found. A repeated `?ags=a&ags=b` stays a 404 echoing both values, as
 * the array Express produced.
 *
 * ## Deliberate deviations
 *
 *  * `zeit` is the departure's wall-clock time in Europe/Berlin. EFA answers
 *    in UTC (`…Z`), and the old node cut `HH:MM` out of that string, so the
 *    board showed times one or two hours early. `efa-abfahrten` already
 *    converted ({@link clock}, the same formatting).
 *  * EFA requests go through the shared rate limiter of `www.efa-bw.de` (see
 *    src/connectors/efa.ts), no retry, 30 s timeout. The old request had no
 *    pacing and Node-RED's 120 s timeout, i.e. a hanging EFA ended in the
 *    nginx 504 after 60 s; now it is the node's own 502 after 30 s.
 *  * No departures is not an outage: a valid EFA answer that resolved the
 *    requested stop but carries no `stopEvents` (night, weekday-only stops;
 *    EFA's error -4050 "no serving lines found") is a 200 with
 *    `abfahrten: []` ({@link isEmptyDepartureMonitor}). The old node answered
 *    502 "Auskunft nicht erreichbar", so the dashboard dropped the board as if
 *    EFA were down, and the nginx kept serving the last evening's departures
 *    stale. Anything else without `stopEvents` stays a 502.
 *  * Departures of the requested stop only: EFA resolves an unknown or
 *    removed id to some other stop or POI and answers with that place's
 *    departures; the old node showed them under this stop's name. Now 502
 *    ("gestört" on the page), see {@link parseDepartureMonitor}. And -4030 "no
 *    matching departure" counts as no departures like -4050.
 *  * No JSONP: Express's `res.jsonp` wrapped the body into a script when the
 *    query carried `callback=…`. Nothing uses that, and a JSONP endpoint on a
 *    cached public URL is an injection surface, not a feature.
 *  * A stop directory whose `halte` is not an object is refused with the
 *    "not loadable" warning and the previous directory stays; the old node
 *    stored whatever truthy value came. An entry without a string `stopId` is
 *    a 404 in both.
 *  * Transport failures towards EFA are logged as `[warn]` (the http request
 *    node logged them as an error of its own), at most one per
 *    {@link FAILURE_WARN_MS} — public requests must not drive the health
 *    check's counters; the rest go to debug. The client gets the 502 either
 *    way.
 *  * Load shedding (security review). The nginx cache used to be bypassable
 *    with extra query parameters, and every bypass reached EFA-BW through the
 *    bucket `efa-abfahrten` shares — enough to starve the periodic run. Now:
 *     - concurrent requests for the same stop share ONE upstream request, and
 *       its answer (success or failure) is reused for {@link COALESCE_MS};
 *     - the endpoint has its own slots ({@link ON_DEMAND_CONCURRENCY} in
 *       flight, {@link ON_DEMAND_QUEUE} waiting), so it holds at most two
 *       places in the host bucket and can never fill its queue; beyond that
 *       it answers 503 (`Retry-After: 30`) at once, logged at debug;
 *     - when every client waiting for an upstream request has disconnected,
 *       the request is aborted.
 *    The `stand` of a reused answer is the time EFA answered, not the time of
 *    the page view. The old path had none of this: one unpaced EFA request
 *    per nginx cache miss.
 *  * A daily cap on the EFA requests (below). The old path had none.
 *
 * ## Daily cap
 *
 * The cockpit's 60 s cache and per-client limit bound the rate per stop and
 * client, not the day: crawlers walking all ~1,100 municipalities can still
 * cause one EFA request per stop and minute — far beyond what the
 * generator's comment above calls acceptable without an agreement with the
 * provider. The endpoint therefore counts its
 * upstream requests per UTC day in `ctx.quota` (host {@link EFA_HOST},
 * persisted, survives a restart; the precedent is Open-Meteo, see
 * src/kernel/quota.ts) against {@link DEFAULT_DAILY_CAP} calls
 * (`UDP_EFA_ON_DEMAND_DAILY_CAP`). A request is charged when its upstream
 * request is started, aborted or not (the safe direction); a coalesced one
 * costs nothing.
 *
 *  * Used up: 503 with `Retry-After` until 00:00 UTC and the stop's name
 *    (`{ fehler, halt }`, as the 502), no EFA request. The cockpit serves the
 *    stop's last good answer stale on a 503 (`proxy_cache_use_stale`); a
 *    stop without one gets the 503, which the city page shows as
 *    "Fahrplanauskunft derzeit gestört" because the answer names the stop.
 *  * Stretched: from half the cap on, departure answers carry
 *    `X-Accel-Expires` ({@link CACHE_STRETCH}: 5, 10, then 20 minutes), so
 *    the cockpit asks EFA-BW less often per stop and the remaining budget
 *    lasts longer, e.g. against one actor cycling through all stops.
 *  * Visible: once a day a `[warn]` at {@link CAP_WARN_SHARE} of the cap and
 *    an `[error]` when it is reached, both starting with
 *    {@link CAP_LOG_PREFIX} — what a log-based alert matches. While it stays
 *    used up, every hourly run repeats it as a `[warn]`, so the health
 *    check's 70-minute window never loses it. `ops-host` publishes the day's
 *    count and the cap on `PlatformStatus:udp`.
 *  * `efa-abfahrten` takes no part: its volume is fixed by the registry, and
 *    public traffic must not be able to starve it (see efa.ts).
 *
 * The refused requests themselves are public traffic: debug only.
 */

import { COCKPIT_URL } from "../kernel/env.js";
import { FetchAbortedError } from "../kernel/fetcher.js";
import { weakEtag } from "../kernel/http.js";
import { WarnThrottle } from "../kernel/log.js";
import { isRecord, isString, isTruthy, ParseError, requireRecord } from "../kernel/parse.js";
import { nextUtcDayMs, utcDay } from "../kernel/quota.js";
import { stateKey } from "../kernel/state.js";
import type {
  ConnectorModule,
  Ctx,
  Env,
  GeoIndex,
  HttpResponse,
  IsoTime,
  JsonObject,
  JsonValue,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from "../kernel/types.js";
import {
  berlinClock,
  EFA_DM_URL,
  EFA_HOST,
  EFA_MIN_INTERVAL_MS,
  isEmptyDepartureMonitor,
  parseDepartureMonitor,
} from "./efa.js";
import type { DepartureMonitor } from "./efa.js";
import { failureText, nodePayload } from "./http-payload.js";
import type { Scalar } from "./http-payload.js";

export const ID = "abfahrten-on-demand";

/** Served by the cockpit; built by scripts/efa-haltestellen.py. */
export const DIRECTORY_URL = `${COCKPIT_URL}/oepnv-halte.json`;

export const ROUTE_PATH = "/abfahrten";

const SOURCE = "EFA-BW (naldo/bwegt)";

/** What `res.jsonp` sets on an object payload (Express adds the charset). */
export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/** One entry of `oepnv-halte.json`: `{ stopId, stopName, lat, lon, entfernungM, art }`; only the first two are read. */
export interface Halt {
  /** EFA stop id; `undefined` answers 404 as `!h.stopId` did. */
  readonly stopId: string | undefined;
  readonly stopName: string | undefined;
}

/** The directory by AGS. */
export type StopDirectory = ReadonlyMap<string, Halt>;

export interface StopDirectoryFile {
  readonly halte: StopDirectory;
}

/** One departure as the dashboard reads it. */
export interface DepartureRow extends JsonObject {
  readonly linie: Scalar;
  readonly ziel: Scalar;
  readonly zeit: string;
  readonly verspaetung: number | null;
}

/* ------------------------------------------------------------------ Directory */

function parseHalt(raw: unknown): Halt {
  if (!isRecord(raw)) return { stopId: undefined, stopName: undefined };
  const stopId = raw.stopId;
  const stopName = raw.stopName;
  return {
    stopId: isString(stopId) && stopId !== "" ? stopId : undefined,
    stopName: isString(stopName) ? stopName : undefined,
  };
}

/**
 * `msg.statusCode >= 400 || !msg.payload || !msg.payload.halte` of
 * FN_ABF_HALTE_LADEN, as a narrowing: `halte` has to be an object keyed by AGS.
 */
export function parse(raw: unknown): StopDirectoryFile {
  const halte = requireRecord(raw, "payload").halte;
  if (!isRecord(halte)) throw new ParseError("payload.halte", "object keyed by AGS", halte);
  return { halte: new Map(Object.entries(halte).map(([ags, halt]) => [ags, parseHalt(halt)])) };
}

/** Pure: the directory the route resolves against. */
export function build(raw: StopDirectoryFile, _geo: GeoIndex | null, _now: IsoTime): StopDirectory {
  return raw.halte;
}

/**
 * The loaded directory — the old `global.get('oepnvHalte')`; `null` until the
 * first successful run. In `ctx.state`, which `run` and `routes` share.
 */
export const DIRECTORY = stateKey<StopDirectory | null>("stopDirectory", () => null);

/**
 * Validators of the loaded file (`ETag`, `Last-Modified`), sent back as a
 * conditional GET: the hourly reload costs a 304 while the file is unchanged.
 */
export interface DirectoryValidators {
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
}
export const VALIDATORS = stateKey<DirectoryValidators | null>("stopDirectoryValidators", () => null);

function conditionalHeaders(validators: DirectoryValidators | null): Record<string, string> {
  if (validators === null) return {};
  return {
    ...(validators.etag === undefined ? {} : { "If-None-Match": validators.etag }),
    ...(validators.lastModified === undefined ? {} : { "If-Modified-Since": validators.lastModified }),
  };
}

/** Kept from the original: the fix is to run the script that writes the file. */
function notLoadable(ctx: Ctx, status: string): void {
  ctx.log.warn(`stop directory not loadable (${status}) — run scripts/efa-haltestellen.py`);
}

/**
 * Loads the stop directory — hourly (registry), not once a day: during a
 * rolling update the first load can reach a cockpit that still serves the old
 * file, and that old directory used to stay for a day. Conditional, so an
 * unchanged file is a 304 and is not parsed again.
 */
export async function run(ctx: Ctx): Promise<void> {
  reportCap(ctx);
  const loaded = ctx.state.slot(DIRECTORY).get();
  const validators = ctx.state.slot(VALIDATORS);
  let response: HttpResponse;
  try {
    // Validators only with a directory in memory: a 304 must never leave none.
    const headers = loaded === null ? {} : conditionalHeaders(validators.get());
    response = await ctx.fetch.text(DIRECTORY_URL, Object.keys(headers).length > 0 ? { headers } : undefined);
  } catch (error) {
    notLoadable(ctx, failureText(error));
    return;
  }
  if (response.status === 304 && loaded !== null) {
    ctx.log.status(`${String(loaded.size)} stops (unchanged)`);
    return;
  }
  let file: StopDirectoryFile | null = null;
  if (response.status < 400) {
    try {
      file = parse(nodePayload(response));
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
    }
  }
  // A failed load keeps the previous directory, as the old node returned
  // before `global.set`.
  if (file === null) {
    notLoadable(ctx, String(response.status));
    return;
  }
  const directory = build(file, null, ctx.now());
  ctx.state.slot(DIRECTORY).set(directory);
  const etag = response.headers.etag;
  const lastModified = response.headers["last-modified"];
  validators.set(etag === undefined && lastModified === undefined ? null : { etag, lastModified });
  ctx.log.status(`${String(directory.size)} stops`);
}

/* ------------------------------------------------------------------ Endpoint */

/**
 * The `http response` node on an object payload: `res.status(code).jsonp(payload)`,
 * with the weak ETag Express's `res.send` put on every body.
 */
export function nodeRedJson(status: number, payload: JsonValue): RouteResponse {
  const body = JSON.stringify(payload);
  return { status, contentType: JSON_CONTENT_TYPE, body, headers: { ETag: weakEtag(body) } };
}

/** `req.query.ags`: the single value, all values of a repeated key, or `""`. */
function agsParameter(query: URLSearchParams): string | readonly string[] {
  const values = query.getAll("ags");
  if (values.length > 1) return values;
  return values[0] ?? "";
}

export type Resolution =
  | { readonly kind: "answer"; readonly response: RouteResponse }
  | { readonly kind: "fetch"; readonly halt: Halt; readonly stopId: string; readonly url: string };

/** FN_ABF_HALT: 503 without directory, 404 for an unknown or malformed AGS. */
export function resolve(directory: StopDirectory | null, query: URLSearchParams): Resolution {
  const ags = agsParameter(query);
  if (directory === null) {
    return {
      kind: "answer",
      response: nodeRedJson(503, { fehler: "Haltestellenverzeichnis noch nicht geladen" }),
    };
  }
  const halt = isString(ags) && /^\d{8}$/.test(ags) ? directory.get(ags) : undefined;
  if (halt?.stopId === undefined) {
    return {
      kind: "answer",
      response: nodeRedJson(404, { fehler: "Für diese Gemeinde ist kein Halt hinterlegt", ags }),
    };
  }
  return {
    kind: "fetch",
    halt,
    stopId: halt.stopId,
    url:
      `${EFA_DM_URL}?outputFormat=rapidJSON&type_dm=any&name_dm=${encodeURIComponent(halt.stopId)}` +
      "&mode=direct&useRealtime=1&limit=12",
  };
}

/** What came back from EFA: a status (`null` = no response at all) and the payload. */
export interface Upstream {
  readonly status: number | null;
  readonly payload: unknown;
}

/** `HH:MM` in Europe/Berlin, as `efa-abfahrten` shows it; an unparseable time keeps the old cut. */
export function clock(iso: string): string {
  return Number.isFinite(Date.parse(iso)) ? berlinClock(iso) : iso.slice(11, 16);
}

function departureRow(monitorEvent: DepartureMonitor["stopEvents"][number]): DepartureRow {
  const line = [monitorEvent.lineNumber, monitorEvent.lineName].find((value) => isTruthy(value));
  const planned = monitorEvent.planned ?? "";
  const estimated = monitorEvent.estimated;
  const shown = estimated !== undefined && estimated !== "" ? estimated : planned;
  // Verspätung nur bei echter Echtzeitmeldung. Ohne sie ist der Wert
  // unbekannt — nicht null Minuten. Sonst meldete ein Halt ohne
  // Echtzeitanbindung dauerhaft »pünktlich«.
  let delay: number | null = null;
  if (planned !== "" && estimated !== undefined && estimated !== "" && monitorEvent.realtimeControlled) {
    const minutes = Math.round((Date.parse(estimated) - Date.parse(planned)) / 60000);
    // Dieselbe Plausibilitätsgrenze wie beim Dauerabruf: einzelne Halte
    // melden systematisch unsinnige Planzeiten; das sind Datenartefakte.
    if (Number.isFinite(minutes) && Math.abs(minutes) <= 60) delay = minutes;
  }
  return {
    linie: line ?? "",
    ziel: isTruthy(monitorEvent.destination) ? (monitorEvent.destination ?? "") : "",
    zeit: clock(shown),
    verspaetung: delay,
  };
}

/**
 * FN_ABF_BAUEN: the slim departure list, or 502 when EFA did not deliver. A
 * valid answer without departures is an empty list (see the deviations).
 */
export function departuresResponse(halt: Halt, upstream: Upstream, now: IsoTime): RouteResponse {
  const name = halt.stopName ?? "";
  let monitor: DepartureMonitor | null = null;
  if (upstream.status === null || upstream.status < 400) {
    try {
      monitor = parseDepartureMonitor(upstream.payload, halt.stopId ?? "");
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      // A WrongStopError (EFA guessed another place) is never "empty": 502.
      if (isEmptyDepartureMonitor(upstream.payload, halt.stopId ?? "")) monitor = { stopEvents: [] };
    }
  }
  if (monitor === null) return nodeRedJson(502, { fehler: "Auskunft nicht erreichbar", halt: name });

  const rows = monitor.stopEvents.map(departureRow);
  const known = rows
    .map((row) => row.verspaetung)
    .filter((delay): delay is number => delay !== null)
    .sort((a, b) => a - b);
  return nodeRedJson(200, {
    halt: name,
    stopId: halt.stopId ?? "",
    stand: now,
    medianVerspaetung: known[Math.floor(known.length / 2)] ?? null,
    echtzeitAbfahrten: known.length,
    quelle: SOURCE,
    abfahrten: rows,
  });
}

/* ------------------------------------------------------------------ Load shedding */

/** How long an upstream answer per stop is reused (success and failure alike). */
export const COALESCE_MS = 30_000;

/** On-demand EFA requests in flight at once. */
export const ON_DEMAND_CONCURRENCY = 2;

/** On-demand requests waiting for a slot; one more is answered 503 at once. */
export const ON_DEMAND_QUEUE = 8;

/** A transport failure towards EFA is a `[warn]` at most this often. */
export const FAILURE_WARN_MS = 60_000;

/** Answer when the on-demand queue is full (the EFA-BW load is shed here, not upstream). */
export const BUSY_TEXT = "Auskunft ausgelastet, bitte gleich erneut versuchen";

/** An upstream answer, or why there is none to show. */
type FlightResult =
  | { readonly kind: "upstream"; readonly upstream: Upstream; readonly stand: IsoTime }
  | { readonly kind: "aborted" };

/* ------------------------------------------------------------------ Daily cap */

/** EFA-BW requests the endpoint may start per UTC day — default of {@link DAILY_CAP_ENV}. */
export const DEFAULT_DAILY_CAP = 20_000;
export const DAILY_CAP_ENV = "UDP_EFA_ON_DEMAND_DAILY_CAP";

/** Share of the cap at which the endpoint warns, once a day. */
export const CAP_WARN_SHARE = 0.8;

/** Start of every log line about the cap: what a log-based alert matches on. */
export const CAP_LOG_PREFIX = "EFA-BW on-demand daily cap";

/** Answer while the cap is used up. */
export const CAPPED_TEXT = "Tageskontingent der Fahrplanauskunft aufgebraucht";

/** The configured cap; a value that is not a positive number falls back to the default. */
export function dailyCapOf(env: Env): number {
  const cap = Math.floor(env.number(DAILY_CAP_ENV, DEFAULT_DAILY_CAP));
  return cap > 0 ? cap : DEFAULT_DAILY_CAP;
}

function capFields(used: number, cap: number, nowMs: number): string {
  return `used=${String(used)} cap=${String(cap)} day=${utcDay(nowMs)} (UTC)`;
}

function reachedText(used: number, cap: number, nowMs: number): string {
  return (
    `${CAP_LOG_PREFIX} reached: ${capFields(used, cap, nowMs)} — /abfahrten answers 503 until ` +
    `${new Date(nextUtcDayMs(nowMs)).toISOString()}; raise ${DAILY_CAP_ENV} only with the provider's consent`
  );
}

/**
 * The cap's log lines, each at most once per UTC day and process (a restart
 * repeats them once, which is wanted). In `ctx.state`, shared by run and route.
 */
export class DailyCap {
  #day = "";
  #warned = false;
  #reached = false;
  #invalidReported = false;

  /** The cap, with one `[warn]` per process for a value that is not a positive number. */
  cap(ctx: Ctx): number {
    const raw = ctx.env.number(DAILY_CAP_ENV, DEFAULT_DAILY_CAP);
    const cap = dailyCapOf(ctx.env);
    if (cap !== raw && !this.#invalidReported) {
      this.#invalidReported = true;
      ctx.log.warn(`${DAILY_CAP_ENV}=${String(raw)} is not a positive whole number, using ${String(cap)}`);
    }
    return cap;
  }

  /**
   * Whether one more upstream request fits into today's cap; if so, it is
   * charged. Logs the {@link CAP_WARN_SHARE} and the full mark once a day.
   */
  admit(ctx: Ctx, nowMs: number): boolean {
    const cap = this.cap(ctx);
    this.#rollover(nowMs);
    const used = ctx.quota.used(EFA_HOST);
    if (used >= cap) {
      this.#reach(ctx, used, cap, nowMs);
      return false;
    }
    ctx.quota.charge(EFA_HOST, 1);
    const charged = used + 1;
    if (charged >= cap) this.#reach(ctx, charged, cap, nowMs);
    else if (!this.#warned && charged >= Math.ceil(cap * CAP_WARN_SHARE)) {
      this.#warned = true;
      ctx.log.warn(
        `${CAP_LOG_PREFIX} at ${String(Math.round(CAP_WARN_SHARE * 100))}%: ${capFields(charged, cap, nowMs)}`,
      );
    }
    return true;
  }

  #reach(ctx: Ctx, used: number, cap: number, nowMs: number): void {
    this.#warned = true;
    if (this.#reached) return;
    this.#reached = true;
    ctx.log.error(reachedText(used, cap, nowMs));
  }

  #rollover(nowMs: number): void {
    const day = utcDay(nowMs);
    if (day === this.#day) return;
    this.#day = day;
    this.#warned = false;
    this.#reached = false;
  }
}

export const DAILY_CAP = stateKey("abfahrtenDailyCap", () => new DailyCap());

/**
 * The hourly run's word on the cap: the day's count in the status line, and
 * while the cap is used up a `[warn]` in every run.
 */
function reportCap(ctx: Ctx): void {
  const cap = ctx.state.slot(DAILY_CAP).get().cap(ctx);
  const used = ctx.quota.used(EFA_HOST);
  if (used >= cap) ctx.log.warn(reachedText(used, cap, nowMsOf(ctx)));
  else ctx.log.status(`EFA-BW on demand: ${String(used)}/${String(cap)} calls today (UTC)`);
}

/**
 * How long the cockpit may cache a departure answer once the day's cap fills:
 * [share of the cap used, seconds], highest share first. Below the first
 * share the cockpit's own 60 s apply. The nginx in front honours
 * `X-Accel-Expires` over its proxy_cache_valid (and never passes it on), so
 * one actor cycling through all stops costs fewer EFA requests per hour and
 * the rest of the day's budget lasts longer; the `stand` of each answer shows
 * its age.
 */
export const CACHE_STRETCH: readonly (readonly [number, number])[] = [
  [0.9, 1200],
  [0.75, 600],
  [0.5, 300],
];

/** Cache lifetime in seconds for `used` of `cap` calls, `null` = the cockpit's default. */
export function stretchedCacheSeconds(used: number, cap: number): number | null {
  for (const [share, seconds] of CACHE_STRETCH) if (used >= cap * share) return seconds;
  return null;
}

/** A 200 answer, with `X-Accel-Expires` while the day's cap is half used or more. */
function withStretchedCache(ctx: Ctx, response: RouteResponse): RouteResponse {
  if (response.status !== 200) return response;
  const seconds = stretchedCacheSeconds(ctx.quota.used(EFA_HOST), ctx.state.slot(DAILY_CAP).get().cap(ctx));
  if (seconds === null) return response;
  return { ...response, headers: { ...response.headers, "X-Accel-Expires": String(seconds) } };
}

/** 503 while the cap is used up: the stop's name, as the 502, and when to come back. */
export function cappedResponse(halt: Halt, nowMs: number): RouteResponse {
  const response = nodeRedJson(503, { fehler: CAPPED_TEXT, halt: halt.stopName ?? "" });
  const seconds = Math.max(1, Math.ceil((nextUtcDayMs(nowMs) - nowMs) / 1000));
  return { ...response, headers: { ...response.headers, "Retry-After": String(seconds) } };
}

/** One upstream request for a stop, shared by every client asking for it. */
interface Flight {
  readonly result: Promise<FlightResult>;
  readonly abort: AbortController;
  /** Clients waiting for `result`; when the last one leaves, the request is aborted. */
  waiters: number;
  /** Epoch ms the result arrived; `null` while in flight. */
  settledAt: number | null;
}

/** Slots and the shared flights of the endpoint — per connector, in `ctx.state`. */
export class OnDemandGate {
  readonly flights = new Map<string, Flight>();
  inFlight = 0;
  readonly #queue: (() => void)[] = [];

  /** A slot, `"busy"` when the queue is full, `"aborted"` when `signal` fired first. */
  async slot(signal: AbortSignal): Promise<"ok" | "busy" | "aborted"> {
    if (this.inFlight < ON_DEMAND_CONCURRENCY) {
      this.inFlight += 1;
      return "ok";
    }
    if (this.#queue.length >= ON_DEMAND_QUEUE) return "busy";
    return new Promise((resolve) => {
      const wake = (): void => {
        signal.removeEventListener("abort", leave);
        this.inFlight += 1;
        resolve("ok");
      };
      const leave = (): void => {
        const at = this.#queue.indexOf(wake);
        if (at >= 0) this.#queue.splice(at, 1);
        resolve("aborted");
      };
      signal.addEventListener("abort", leave, { once: true });
      this.#queue.push(wake);
    });
  }

  release(): void {
    this.inFlight -= 1;
    this.#queue.shift()?.();
  }

  /** Whether a new flight could start or queue right now. */
  hasRoom(): boolean {
    return this.inFlight < ON_DEMAND_CONCURRENCY || this.#queue.length < ON_DEMAND_QUEUE;
  }

  /** Drops settled flights older than {@link COALESCE_MS}. */
  expire(nowMs: number): void {
    for (const [stopId, flight] of this.flights) {
      if (flight.settledAt !== null && nowMs - flight.settledAt >= COALESCE_MS) this.flights.delete(stopId);
    }
  }
}

/** The endpoint's gate — shared by all its requests, invisible to other connectors. */
export const ON_DEMAND = stateKey("abfahrtenGate", () => new OnDemandGate());

const FAILURE_LOG = stateKey("abfahrtenFailureLog", () => new WarnThrottle(FAILURE_WARN_MS));

function nowMsOf(ctx: Ctx): number {
  return Date.parse(ctx.now());
}

function startFlight(ctx: Ctx, gate: OnDemandGate, stopId: string, url: string): Flight {
  const abort = new AbortController();
  const flight: Flight = {
    abort,
    waiters: 0,
    settledAt: null,
    result: (async (): Promise<FlightResult> => {
      const slot = await gate.slot(abort.signal);
      if (slot !== "ok") return { kind: "aborted" };
      try {
        const response = await ctx.fetch.text(url, {
          minIntervalMs: EFA_MIN_INTERVAL_MS,
          retries: 0,
          signal: abort.signal,
        });
        return {
          kind: "upstream",
          upstream: { status: response.status, payload: nodePayload(response) },
          stand: ctx.now(),
        };
      } catch (error) {
        if (error instanceof FetchAbortedError) return { kind: "aborted" };
        ctx.state
          .slot(FAILURE_LOG)
          .get()
          .warn(ctx.log, `EFA-BW on demand ${stopId}: request failed (${failureText(error)})`, nowMsOf(ctx));
        return { kind: "upstream", upstream: { status: null, payload: null }, stand: ctx.now() };
      } finally {
        gate.release();
      }
    })(),
  };
  void flight.result.then((result) => {
    // An aborted flight is nobody's answer; the next request starts afresh.
    if (result.kind === "aborted") {
      if (gate.flights.get(stopId) === flight) gate.flights.delete(stopId);
    } else flight.settledAt = nowMsOf(ctx);
  });
  return flight;
}

/**
 * Waits for `flight` on behalf of one client. When the client disconnects it
 * stops waiting; when the LAST waiter of a flight still in progress leaves,
 * the upstream request is aborted.
 */
async function waitFor(flight: Flight, signal: AbortSignal | undefined): Promise<FlightResult> {
  if (signal?.aborted === true) return { kind: "aborted" };
  flight.waiters += 1;
  if (signal === undefined) {
    try {
      return await flight.result;
    } finally {
      flight.waiters -= 1;
    }
  }
  let waiting = true;
  const done = (): void => {
    if (!waiting) return;
    waiting = false;
    flight.waiters -= 1;
  };
  let leave: () => void = done;
  const left = new Promise<FlightResult>((resolve) => {
    leave = (): void => {
      done();
      if (flight.waiters === 0 && flight.settledAt === null) flight.abort.abort();
      resolve({ kind: "aborted" });
    };
    signal.addEventListener("abort", leave, { once: true });
  });
  try {
    return await Promise.race([flight.result, left]);
  } finally {
    signal.removeEventListener("abort", leave);
    done();
  }
}

async function answer(ctx: Ctx, request: RouteRequest): Promise<RouteResponse> {
  const resolution = resolve(ctx.state.slot(DIRECTORY).get(), request.query);
  if (resolution.kind === "answer") return resolution.response;

  const gate = ctx.state.slot(ON_DEMAND).get();
  gate.expire(nowMsOf(ctx));
  let flight = gate.flights.get(resolution.stopId);
  if (flight === undefined) {
    if (!gate.hasRoom()) {
      // Public traffic, not an operator's problem: debug, never [warn].
      ctx.log.debug(`EFA-BW on demand ${resolution.stopId}: queue full, 503`);
      return busy();
    }
    const nowMs = nowMsOf(ctx);
    if (!ctx.state.slot(DAILY_CAP).get().admit(ctx, nowMs)) {
      // The cap is logged once a day (DailyCap); each refusal is public traffic.
      ctx.log.debug(`EFA-BW on demand ${resolution.stopId}: daily cap used up, 503`);
      return cappedResponse(resolution.halt, nowMs);
    }
    flight = startFlight(ctx, gate, resolution.stopId, resolution.url);
    gate.flights.set(resolution.stopId, flight);
  }
  const result = await waitFor(flight, request.signal);
  if (result.kind === "aborted") {
    // The client is gone (nothing is sent), or the flight it joined was dropped.
    ctx.log.debug(`EFA-BW on demand ${resolution.stopId}: client gone, request dropped`);
    return busy();
  }
  return withStretchedCache(ctx, departuresResponse(resolution.halt, result.upstream, result.stand));
}

/** 503 of the shed load, with a hint when to come back. */
function busy(): RouteResponse {
  const response = nodeRedJson(503, { fehler: BUSY_TEXT });
  return { ...response, headers: { ...response.headers, "Retry-After": "30" } };
}

export function routes(ctx: Ctx): readonly RouteDefinition[] {
  return [{ method: "GET", path: ROUTE_PATH, handle: (request) => answer(ctx, request) }];
}

export const connector: ConnectorModule<StopDirectoryFile, StopDirectory> = {
  id: ID,
  parse,
  build,
  run,
  routes,
};
