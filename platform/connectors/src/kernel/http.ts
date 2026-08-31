/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * HTTP server of the service — `node:http`, no framework.
 *
 * Two built-in routes:
 *
 *   GET  /healthz       liveness and readiness, plus the list of scheduled jobs
 *   POST /trigger/:id   runs one connector immediately
 *
 * `/trigger/:id` replaces the detour that `scripts/trigger-connector.sh` has to
 * take today: it reads `nodePrefixes` from the registry, pulls the whole flow
 * definition from the Node-RED admin API, searches it for an inject node whose
 * id starts with that prefix, and posts to `/inject/<node>`. Three requests and
 * a registry field to keep in sync, in order to say "run ausflug-bw now". With
 * the id as the route, `nodePrefixes` loses its last reader
 * (docs/migration-konnektoren.md, "Was am Ende verschwindet"). Rewiring the
 * script is phase 5; the route exists from here on.
 *
 * Connector routes are registered through {@link RouteRegistry}. Phase 3 needs
 * that for the two `http in` nodes of the old flows: `GET /abfahrten` and
 * `GET /warnungen.ics`.
 */

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
 * Same container-internal port as Node-RED serves on. The cockpit nginx reaches
 * `/abfahrten` and `/warnungen.ics` through `UDP_NODERED_UPSTREAM:
 * "node-red:1880"`; keeping the port means the cutover in phase 5 changes the
 * host in one place and nothing else.
 */
export const DEFAULT_PORT = 1880;

/** Guard against an endpoint being fed a large body; the routes take none. */
const MAX_BODY_BYTES = 1_000_000;

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
    if (pattern.startsWith(":")) params[pattern.slice(1)] = decodeURIComponent(actual);
    else if (pattern !== actual) return null;
  }
  return params;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, result: RouteResponse): void {
  response.writeHead(result.status, {
    "Content-Type": result.contentType,
    "Content-Length": String(Buffer.byteLength(result.body)),
    ...result.headers,
  });
  response.end(result.body);
}

export function jsonResponse(status: number, body: unknown): RouteResponse {
  return { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) };
}

export function textResponse(status: number, body: string): RouteResponse {
  return { status, contentType: "text/plain; charset=utf-8", body };
}

export interface HttpServer extends RouteRegistry {
  listen(port: number): Promise<void>;
  close(): Promise<void>;
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

  async listen(port: number): Promise<void> {
    const server = createServer((request, response) => {
      this.#handle(request, response);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.#log.info(`listening on port ${String(port)}`);
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
    void this.#route(request)
      .then((result) => {
        send(response, result);
      })
      .catch((error: unknown) => {
        this.#log.error(`request ${request.method ?? "?"} ${request.url ?? "?"} failed`, error);
        send(response, textResponse(500, "internal error\n"));
      });
  }

  async #route(request: IncomingMessage): Promise<RouteResponse> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter((segment) => segment !== "");
    const method = request.method ?? "GET";

    for (const route of this.#routes) {
      const params = match(route, method, segments);
      if (params === null) continue;
      const body = method === "GET" || method === "HEAD" ? "" : await readBody(request);
      const routeRequest: RouteRequest = {
        method,
        path: url.pathname,
        query: url.searchParams,
        params,
        body,
      };
      return route.definition.handle(routeRequest);
    }
    return textResponse(404, "not found\n");
  }
}

export function createHttpServer(log: Log): HttpServer {
  return new KernelHttpServer(log);
}
