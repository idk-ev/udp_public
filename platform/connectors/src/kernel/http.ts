/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * HTTP servers of the service — `node:http`, no framework. There are two, and
 * the split is a security decision (see src/kernel/admin.ts):
 *
 *   public  UDP_CONNECTORS_PORT (1880)        only the routes connectors register
 *   admin   UDP_CONNECTORS_ADMIN_PORT (1881)  GET /healthz, POST /trigger/:id
 *
 * `/trigger/:id` takes the registry id as the route: "run ausflug-bw now" is
 * one request (`scripts/trigger-connector.sh`), where the Node-RED detour
 * needed three and a registry field (`nodePrefixes`) to keep in sync.
 *
 * Connector routes are registered through {@link RouteRegistry}. Phase 3 needs
 * that for the two `http in` nodes of the old flows: `GET /abfahrten` and
 * `GET /warnungen.ics`.
 *
 * ## What Express answered around those nodes
 *
 * Node-RED serves `http in` nodes through Express 4, which added three things
 * a client (or the cockpit nginx, `limit_except GET HEAD OPTIONS`) may rely on.
 * They are reproduced here for every route, so a module does not have to:
 *
 *  * `HEAD` on a `GET` route runs the route and sends its status and headers
 *    (`Content-Length` of the body included), without the body.
 *  * `OPTIONS` answers what Express's router sent when no route handled it:
 *    200, `Allow` with the methods of the routes on that path (`GET` brings
 *    `HEAD`), the same list as a `text/html` body, and its weak ETag. No CORS
 *    headers — Node-RED's `httpNodeCors` is not set.
 *  * `res.send` answered a `GET`/`HEAD` with 304 and no body when the request
 *    was fresh against the response's `ETag` ({@link isFresh}, the `fresh`
 *    package). Routes that set an ETag get the same.
 *
 * ## Request bodies, peers, disconnects (security review)
 *
 * A body is read only for a route that declares `readsBody` (none does), at
 * most {@link MAX_BODY_BYTES}; more is a 413, never a 500 with an `[error]`
 * line. A body nobody reads is left unread and the connection closed after the
 * answer. Every route sees the TCP peer (`remoteAddress`, what the trigger's
 * loopback check reads) and a `signal` that aborts when the client disconnects.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type {
  HttpMethod,
  Log,
  RouteDefinition,
  RouteRegistry,
  RouteRequest,
  RouteResponse,
} from "./types.js";

/**
 * Same container-internal port as Node-RED served these routes on. The cockpit
 * nginx reaches `/abfahrten` and `/warnungen.ics` through
 * `UDP_CONNECTORS_UPSTREAM` (default `connectors:1880`).
 */
export const DEFAULT_PORT = 1880;

/**
 * A path segment that is not valid percent-encoding (`/trigger/%E0%A4%A`).
 * The client's fault, so a 400 — not a 500 with an `[error]` line that the
 * health check would count as a fault of the service.
 */
class MalformedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedRequestError";
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new MalformedRequestError("malformed percent-encoding in the path");
  }
}

/**
 * A body larger than a route that reads bodies accepts. The client's doing, so
 * a 413 — not a 500 with an `[error]` line (a 2 MB POST used to produce both).
 */
class PayloadTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "PayloadTooLargeError";
  }
}

/** Guard against an endpoint being fed a large body; the routes take none. */
export const MAX_BODY_BYTES = 1_000_000;

/** Whether the request announces or streams a body (`Content-Length` > 0 or chunked). */
function carriesBody(request: IncomingMessage): boolean {
  const length = Number.parseInt(request.headers["content-length"] ?? "", 10);
  return (Number.isFinite(length) && length > 0) || request.headers["transfer-encoding"] !== undefined;
}

interface CompiledRoute {
  readonly method: HttpMethod;
  readonly segments: readonly string[];
  readonly definition: RouteDefinition;
}

function compile(definition: RouteDefinition): CompiledRoute {
  return {
    method: definition.method,
    segments: definition.path.split("/").filter((segment) => segment !== ""),
    definition,
  };
}

/** `/trigger/:id` against `/trigger/parken-bw` yields `{ id: "parken-bw" }`. */
function match(
  route: CompiledRoute,
  method: string,
  segments: readonly string[],
): Record<string, string> | null {
  if (route.method !== method) return null;
  if (route.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i += 1) {
    const pattern = route.segments[i];
    const actual = segments[i];
    if (pattern === undefined || actual === undefined) return null;
    if (pattern.startsWith(":")) params[pattern.slice(1)] = decodeSegment(actual);
    else if (pattern !== actual) return null;
  }
  return params;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const announced = Number.parseInt(request.headers["content-length"] ?? "", 10);
  if (Number.isFinite(announced) && announced > MAX_BODY_BYTES) throw new PayloadTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `IncomingMessage.headers` as {@link RouteRequest.headers}: Node already
 * lowercases the names; a header that arrived as a list is joined.
 */
function headersOf(request: IncomingMessage): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    out[name] = typeof value === "string" ? value : value.join(", ");
  }
  return out;
}

/** A response header by case-insensitive name. */
function headerOf(result: RouteResponse, name: string): string | undefined {
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** `parseTokenList` of the `fresh` package: a comma-separated list, spaces around items dropped. */
function tokenList(value: string): readonly string[] {
  const list: string[] = [];
  let start = 0;
  let end = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x20) {
      if (start === end) {
        start = i + 1;
        end = i + 1;
      }
    } else if (code === 0x2c) {
      list.push(value.substring(start, end));
      start = i + 1;
      end = i + 1;
    } else {
      end = i + 1;
    }
  }
  list.push(value.substring(start, end));
  return list;
}

const NO_CACHE = /(?:^|,)\s*?no-cache\s*?(?:,|$)/;

/**
 * `req.fresh` of Express 4 (the `fresh` package), for a `GET`/`HEAD` request:
 * the answer is 2xx (or 304), the request carries `If-None-Match` or
 * `If-Modified-Since` and no `Cache-Control: no-cache`, an `If-None-Match`
 * other than `*` names the response's `ETag` (weak and strong compared alike),
 * and an `If-Modified-Since` is not older than its `Last-Modified`.
 */
export function isFresh(request: Readonly<Record<string, string>>, result: RouteResponse): boolean {
  if (!((result.status >= 200 && result.status < 300) || result.status === 304)) return false;
  const noneMatch = request["if-none-match"] ?? "";
  const modifiedSince = request["if-modified-since"] ?? "";
  if (noneMatch === "" && modifiedSince === "") return false;
  const cacheControl = request["cache-control"] ?? "";
  if (cacheControl !== "" && NO_CACHE.test(cacheControl)) return false;
  if (noneMatch !== "" && noneMatch !== "*") {
    const etag = headerOf(result, "etag") ?? "";
    if (etag === "") return false;
    const matches = tokenList(noneMatch).some(
      (token) => token === etag || token === `W/${etag}` || `W/${token}` === etag,
    );
    if (!matches) return false;
  }
  if (modifiedSince !== "") {
    const lastModified = headerOf(result, "last-modified") ?? "";
    if (lastModified === "" || !(Date.parse(lastModified) <= Date.parse(modifiedSince))) return false;
  }
  return true;
}

/**
 * Express's default ETag (`etag` package, weak): `W/"<byte length in hex>-<first
 * 27 characters of the base64 SHA-1>"`, which `res.send` put on every body the
 * `http response` nodes sent.
 */
export function weakEtag(body: string): string {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length === 0) return 'W/"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';
  const hash = createHash("sha1").update(bytes).digest("base64").slice(0, 27);
  return `W/"${bytes.length.toString(16)}-${hash}"`;
}

/**
 * Writes a result. 204 and 304 carry neither body nor `Content-Type` /
 * `Content-Length` (Express removed both); a `HEAD` answer carries the headers
 * of the `GET` answer, `Content-Length` included, and no body.
 */
function send(response: ServerResponse, result: RouteResponse, head: boolean, close = false): void {
  if (response.headersSent || response.destroyed) return;
  const bodyless = result.status === 204 || result.status === 304;
  response.writeHead(result.status, {
    ...(bodyless
      ? {}
      : { "Content-Type": result.contentType, "Content-Length": String(Buffer.byteLength(result.body)) }),
    ...result.headers,
    // An unread request body stays on the socket; closing it after the answer
    // is cheaper than reading (and discarding) whatever the client sends.
    ...(close ? { Connection: "close" } : {}),
  });
  if (bodyless || head) response.end();
  else response.end(result.body);
}

export function jsonResponse(status: number, body: unknown): RouteResponse {
  return { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) };
}

export function textResponse(status: number, body: string): RouteResponse {
  return { status, contentType: "text/plain; charset=utf-8", body };
}

export interface HttpServer extends RouteRegistry {
  /** `host` defaults to all interfaces, as `server.listen(port)` does. */
  listen(port: number, host?: string): Promise<void>;
  close(): Promise<void>;
  /** The port actually bound (useful after `listen(0)`), or `null` before. */
  port(): number | null;
}

class KernelHttpServer implements HttpServer {
  readonly #log: Log;
  readonly #routes: CompiledRoute[] = [];
  #server: Server | null = null;

  constructor(log: Log) {
    this.#log = log;
  }

  register(route: RouteDefinition): void {
    const compiled = compile(route);
    const clash = this.#routes.find(
      (existing) =>
        existing.method === compiled.method && existing.segments.join("/") === compiled.segments.join("/"),
    );
    if (clash !== undefined) {
      throw new Error(`route ${route.method} ${route.path} is already registered`);
    }
    this.#routes.push(compiled);
    this.#log.debug(`route registered: ${route.method} ${route.path}`);
  }

  async listen(port: number, host?: string): Promise<void> {
    const server = createServer((request, response) => {
      this.#handle(request, response);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      const done = (): void => {
        server.removeListener("error", reject);
        resolve();
      };
      if (host === undefined) server.listen(port, done);
      else server.listen(port, host, done);
    });
    this.#log.info(`listening on ${host ?? "*"}:${String(this.port() ?? port)}`);
  }

  port(): number | null {
    const address = this.#server?.address();
    return address === undefined || address === null || typeof address === "string" ? null : address.port;
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    this.#server = null;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    // A route handler must never take the process down: the server also answers
    // /healthz, and an endpoint fault must not look like a dead container.
    const head = request.method === "HEAD";
    // Aborted when the client goes away before the answer is written, so a
    // route can drop an upstream request nobody waits for.
    const gone = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) gone.abort();
    });
    const state = { bodyRead: false };
    void this.#route(request, gone.signal, state)
      .then((result) => {
        send(response, result, head, !state.bodyRead && carriesBody(request));
      })
      .catch((error: unknown) => {
        if (error instanceof MalformedRequestError) {
          send(response, textResponse(400, `bad request: ${error.message}\n`), head, carriesBody(request));
          return;
        }
        if (error instanceof PayloadTooLargeError) {
          send(response, textResponse(413, "request body too large\n"), head, true);
          return;
        }
        this.#log.error(`request ${request.method ?? "?"} ${request.url ?? "?"} failed`, error);
        send(response, textResponse(500, "internal error\n"), head, carriesBody(request));
      });
  }

  /** Express's automatic OPTIONS answer for `segments`, or `null` if no route lives there. */
  #options(segments: readonly string[]): RouteResponse | null {
    const methods: string[] = [];
    for (const route of this.#routes) {
      if (match(route, route.method, segments) === null) continue;
      if (!methods.includes(route.method)) methods.push(route.method);
      if (route.method === "GET" && !methods.includes("HEAD")) methods.push("HEAD");
    }
    if (methods.length === 0) return null;
    const allow = methods.join(",");
    return {
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: allow,
      headers: { Allow: allow, ETag: weakEtag(allow) },
    };
  }

  async #route(
    request: IncomingMessage,
    signal: AbortSignal,
    state: { bodyRead: boolean },
  ): Promise<RouteResponse> {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      throw new MalformedRequestError("unparseable request target");
    }
    const segments = url.pathname.split("/").filter((segment) => segment !== "");
    const method = request.method ?? "GET";
    if (method === "OPTIONS") return this.#options(segments) ?? textResponse(404, "not found\n");
    // HEAD runs the GET route; `send` drops the body.
    const lookup = method === "HEAD" ? "GET" : method;
    const readOnly = lookup === "GET";

    for (const route of this.#routes) {
      const params = match(route, lookup, segments);
      if (params === null) continue;
      const headers = headersOf(request);
      // Only a route that asks for it gets the body read (at most
      // MAX_BODY_BYTES); none of today's does, `/trigger` included.
      const wantsBody = !readOnly && route.definition.readsBody === true;
      const body = wantsBody ? await readBody(request) : "";
      state.bodyRead = wantsBody;
      const remoteAddress = request.socket.remoteAddress;
      const routeRequest: RouteRequest = {
        method,
        path: url.pathname,
        query: url.searchParams,
        params,
        headers,
        body,
        signal,
        ...(remoteAddress === undefined ? {} : { remoteAddress }),
      };
      const result = await route.definition.handle(routeRequest);
      if (readOnly && result.status !== 304 && isFresh(headers, result)) {
        return { status: 304, contentType: result.contentType, body: "", headers: result.headers };
      }
      return result;
    }
    return textResponse(404, "not found\n");
  }
}

export function createHttpServer(log: Log): HttpServer {
  return new KernelHttpServer(log);
}
