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
 * scripts/generate-nodered-flows.py. The generator explains why there is no
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
 * (`location = /abfahrten`, 60 s for 200, 30 s for 404/502/503). Status codes,
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
 *  * EFA requests go through the shared rate limiter of `www.efa-bw.de` (see
 *    src/connectors/efa.ts), no retry, 30 s timeout. The old request had no
 *    pacing and Node-RED's 120 s timeout, i.e. a hanging EFA ended in the
 *    nginx 504 after 60 s; now it is the node's own 502 after 30 s.
 *  * No JSONP: Express's `res.jsonp` wrapped the body into a script when the
 *    query carried `callback=…`. Nothing uses that, and a JSONP endpoint on a
 *    cached public URL is an injection surface, not a feature.
 *  * A stop directory whose `halte` is not an object is refused with the
 *    "not loadable" warning and the previous directory stays; the old node
 *    stored whatever truthy value came. An entry without a string `stopId` is
 *    a 404 in both.
 *  * Transport failures towards EFA are logged as `[warn]` (the http request
 *    node logged them as an error of its own); the client gets the 502 either
 *    way.
 */

import { COCKPIT_URL } from "../kernel/env.js";
import { weakEtag } from "../kernel/http.js";
import { isRecord, isString, isTruthy, ParseError, requireRecord } from "../kernel/parse.js";
import { stateKey } from "../kernel/state.js";
import type {
  ConnectorModule,
  Ctx,
  GeoIndex,
  HttpResponse,
  IsoTime,
  JsonObject,
  JsonValue,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
} from "../kernel/types.js";
import { EFA_DM_URL, EFA_MIN_INTERVAL_MS, parseDepartureMonitor } from "./efa.js";
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

/** One entry of `oepnv-halte.json`: `{ stopId, stopName, qualitaet, art }`. */
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

/** Kept from the original: the fix is to run the script that writes the file. */
function notLoadable(ctx: Ctx, status: string): void {
  ctx.log.warn(`stop directory not loadable (${status}) — run scripts/efa-haltestellen.py`);
}

export async function run(ctx: Ctx): Promise<void> {
  let response: HttpResponse;
  try {
    response = await ctx.fetch.text(DIRECTORY_URL);
  } catch (error) {
    notLoadable(ctx, failureText(error));
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
    zeit: shown.slice(11, 16),
    verspaetung: delay,
  };
}

/** FN_ABF_BAUEN: the slim departure list, or 502 when EFA did not deliver. */
export function departuresResponse(halt: Halt, upstream: Upstream, now: IsoTime): RouteResponse {
  const name = halt.stopName ?? "";
  let monitor: DepartureMonitor | null = null;
  if (upstream.status === null || upstream.status < 400) {
    try {
      monitor = parseDepartureMonitor(upstream.payload);
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
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

async function answer(ctx: Ctx, request: RouteRequest): Promise<RouteResponse> {
  const resolution = resolve(ctx.state.slot(DIRECTORY).get(), request.query);
  if (resolution.kind === "answer") return resolution.response;
  let upstream: Upstream;
  try {
    const response = await ctx.fetch.text(resolution.url, { minIntervalMs: EFA_MIN_INTERVAL_MS, retries: 0 });
    upstream = { status: response.status, payload: nodePayload(response) };
  } catch (error) {
    ctx.log.warn(`EFA-BW on demand ${resolution.stopId}: request failed (${failureText(error)})`);
    upstream = { status: null, payload: null };
  }
  return departuresResponse(resolution.halt, upstream, ctx.now());
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
