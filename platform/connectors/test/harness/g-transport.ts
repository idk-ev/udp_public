/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Harness pieces of group G (ÖPNV & endpoints): a real connector ctx on a
 * scripted network, and a stand-in for what Node-RED's `http request` and
 * `http response` nodes did around the old function nodes.
 *
 * The two HTTP node stand-ins are what makes the `/abfahrten` comparison
 * meaningful: the old answer was not the function node's return value but
 * what `http response` (Node-RED 4.1, 21-httpin.js) made of it through
 * Express 4 — `res.set(msg.headers)`, then `res.jsonp(payload)` for an object,
 * which sets `application/json`, lets Express append the charset, and has
 * `res.send` add `Content-Length` and a weak ETag. Replicated here, from those
 * sources, independently of the port.
 */

import { createHash } from "node:crypto";
import { SignatureStore } from "../../src/kernel/change-gate.js";
import { StateStore } from "../../src/kernel/state.js";
import type { Kernel } from "../../src/kernel/context.js";
import { createCtx } from "../../src/kernel/context.js";
import { createDb } from "../../src/kernel/db.js";
import { createEnv } from "../../src/kernel/env.js";
import { createSharedGeo } from "../../src/kernel/geo.js";
import { createHttpServer } from "../../src/kernel/http.js";
import { createRateLimiter } from "../../src/kernel/rate-limit.js";
import { loadRegistry, resolveRegistryPath } from "../../src/kernel/registry.js";
import { createScheduler } from "../../src/kernel/scheduler.js";
import type {
  Ctx,
  Fetcher,
  FetchOptions,
  HttpResponse,
  JsonResponse,
  RegistryEntry,
} from "../../src/kernel/types.js";
import { recordingLog } from "./kernel.js";
import type { RecordedLog } from "./kernel.js";
import { isArray } from "../../src/kernel/parse.js";
import { isRecord } from "./normalize.js";

export const ORION = "http://orion-ld:1026";

/** One request with the options the connector passed — rate limit, retries, headers. */
export interface GRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
  readonly options: FetchOptions | undefined;
}

export type GResponder = (request: GRequest) => HttpResponse | Error;

/**
 * A `Fetcher` answering from `respond`, recording every request with its
 * options. `delayMs` holds each answer back, so tests can watch how many
 * requests a connector keeps in flight.
 */
export function recordingFetcher(
  respond: GResponder,
  delayMs = 0,
): { readonly fetcher: Fetcher; readonly seen: GRequest[]; readonly maxInFlight: () => number } {
  const seen: GRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const text = async (url: string, options?: FetchOptions): Promise<HttpResponse> => {
    const request: GRequest = { url, method: options?.method ?? "GET", body: options?.body, options };
    seen.push(request);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const answer = respond(request);
      if (answer instanceof Error) throw answer;
      return answer;
    } finally {
      inFlight -= 1;
    }
  };
  const fetcher: Fetcher = {
    text,
    json: async (url: string, options?: FetchOptions): Promise<JsonResponse> => {
      const response = await text(url, options);
      if (!response.ok) return { status: response.status, ok: false, body: null };
      const body: unknown = JSON.parse(response.body);
      return { status: response.status, ok: true, body };
    },
  };
  return { fetcher, seen, maxInFlight: () => maxInFlight };
}

export interface GRig {
  readonly kernel: Kernel;
  readonly ctx: Ctx;
  readonly log: RecordedLog;
}

/** The real registry entry of `id`, optionally with fields replaced. */
export function registryEntry(id: string, override: Partial<RegistryEntry> = {}): RegistryEntry {
  const entry = loadRegistry(resolveRegistryPath()).byId(id);
  if (entry === undefined) throw new Error(`registry has no connector "${id}"`);
  return { ...entry, ...override };
}

/**
 * A kernel whose only fake is the network: real change gate, Orion client,
 * geo store, rate limiter and environment; one ctx for `entry`. `nowMs`
 * replaces the clock (for recorded answers whose own timestamps matter).
 */
export function rig(entry: RegistryEntry, fetcher: Fetcher, nowMs: () => number = Date.now): GRig {
  const log = recordingLog();
  const env = createEnv();
  const limiter = createRateLimiter(log);
  const kernel: Kernel = {
    log,
    env,
    limiter,
    fetch: fetcher,
    orionUrl: ORION,
    signatures: new SignatureStore(),
    state: new StateStore(),
    geo: createSharedGeo(log),
    registry: {
      entries: [entry],
      byId: (id) => (id === entry.id ? entry : undefined),
      activeEntries: () => [],
    },
    publicHttp: createHttpServer(log),
    adminHttp: createHttpServer(log),
    scheduler: createScheduler(log),
    db: createDb(env),
    shutdown: new AbortController(),
    nowMs,
  };
  return { kernel, ctx: createCtx(kernel, entry), log };
}

/** Bodies of the upserts the connector sent, flattened to one entity list. */
export function upsertedEntities(seen: readonly GRequest[]): unknown[] {
  const out: unknown[] = [];
  for (const request of seen) {
    if (request.method !== "POST" || !request.url.startsWith(`${ORION}/ngsi-ld/v1/entityOperations/upsert`)) {
      continue;
    }
    const parsed: unknown = JSON.parse(request.body ?? "[]");
    if (isArray(parsed)) out.push(...parsed);
  }
  return out;
}

export function jsonHttp(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

/* ------------------------------------------------------------------ Node-RED http nodes */

/** Marker the http request node leaves in `msg.headers` (a hash-sum there; the JSON here). */
const REQUEST_NODE_MARK = "x-node-red-request-node";

/**
 * `msg` after an `http request` node with `ret: "obj"`, `senderr: false`:
 * status, the response headers (marked), and the parsed body — or the text
 * when it is not JSON. A transport error leaves the error text in `payload`
 * and the error code in `statusCode`, and the message still goes on.
 */
export function afterHttpRequest(
  msg: Record<string, unknown>,
  answer: HttpResponse | Error,
): Record<string, unknown> {
  if (answer instanceof Error) {
    return { ...msg, statusCode: "ECONNREFUSED", payload: `${answer.message} : ${String(msg.url)}` };
  }
  let payload: unknown = answer.body;
  try {
    payload = JSON.parse(answer.body);
  } catch {
    // ret "obj" keeps the text when it is not JSON.
  }
  const headers = { ...answer.headers };
  return {
    ...msg,
    statusCode: answer.status,
    headers: { ...headers, [REQUEST_NODE_MARK]: JSON.stringify(headers) },
    payload,
  };
}

/** A response as it reached the client, header names in lower case. */
export interface WireResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Weak ETag of Express 4 (`etag` package, `weak: true`) — reference implementation. */
export function weakEtag(body: string): string {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length === 0) return 'W/"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';
  return `W/"${bytes.length.toString(16)}-${createHash("sha1").update(bytes).digest("base64").substring(0, 27)}"`;
}

/** Express `res.set`: a content type without charset gets the one of its mime type. */
function expressSet(headers: Record<string, string>, name: string, value: string): void {
  const key = name.toLowerCase();
  if (key === "content-type" && !/;\s*charset\s*=/.test(value)) {
    const type = value.split(";")[0]?.trim() ?? "";
    // mime.charsets.lookup: text/* and application/json(-ish) are UTF-8.
    if (type.startsWith("text/") || type === "application/json" || type === "application/javascript") {
      headers[key] = `${value}; charset=utf-8`;
      return;
    }
  }
  headers[key] = value;
}

/**
 * The `http response` node (no configured status or headers) on `msg`, as the
 * client received it. Only object payloads are modelled — the one kind the
 * `/abfahrten` flow produces.
 */
export function httpResponseNode(msg: unknown): WireResponse {
  if (!isRecord(msg)) throw new Error("http response node: msg is not an object");
  const headers: Record<string, string> = {};
  const incoming = msg.headers;
  if (isRecord(incoming)) {
    const mark = incoming[REQUEST_NODE_MARK];
    const copy = Object.fromEntries(Object.entries(incoming).filter(([name]) => name !== REQUEST_NODE_MARK));
    // Unchanged upstream headers are dropped: the hash still matches.
    const drop = mark !== undefined && mark === JSON.stringify(copy);
    if (!drop) for (const [name, value] of Object.entries(copy)) expressSet(headers, name, String(value));
  }
  const parsedStatus = Number.parseInt(String(msg.statusCode), 10);
  const status = Number.isFinite(parsedStatus) && parsedStatus !== 0 ? parsedStatus : 200;
  const payload = msg.payload;
  if (typeof payload !== "object" || payload === null || Buffer.isBuffer(payload)) {
    throw new Error("http response node: only object payloads are modelled");
  }
  // res.jsonp without a callback parameter: JSON.stringify, default content type.
  const body = JSON.stringify(payload);
  if (headers["content-type"] === undefined) expressSet(headers, "Content-Type", "application/json");
  // res.send: ETag and Content-Length.
  headers.etag = weakEtag(body);
  headers["content-length"] = String(Buffer.byteLength(body));
  return { status, headers, body };
}

/** Headers every Node HTTP server adds on its own; not part of the comparison. */
const TRANSPORT_HEADERS = new Set(["date", "connection", "keep-alive", "transfer-encoding"]);

/** A response of the port, fetched over a real socket. */
export async function wire(url: string): Promise<WireResponse> {
  const response = await fetch(url);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (!TRANSPORT_HEADERS.has(name)) headers[name] = value;
  });
  return { status: response.status, headers, body: await response.text() };
}
