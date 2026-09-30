/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Kernel stand-ins for tests: a logger that records instead of printing, and a
 * scripted Orion endpoint behind the real `Fetcher` interface.
 *
 * The kernel services themselves (change gate, Orion client, pruner, geo) are
 * used for real — only the process edges (console, network) are replaced. A
 * test that mocked the gate would pin the mock, not the port.
 */

import type { Fetcher, FetchOptions, HttpResponse, JsonResponse, Log } from "../../src/kernel/types.js";

export interface RecordedLog extends Log {
  readonly lines: { readonly level: "debug" | "info" | "warn" | "error" | "status"; readonly text: string }[];
  warnings(): string[];
}

export function recordingLog(): RecordedLog {
  const lines: { level: "debug" | "info" | "warn" | "error" | "status"; text: string }[] = [];
  const log: RecordedLog = {
    lines,
    warnings: () => lines.filter((line) => line.level === "warn").map((line) => line.text),
    debug: (text) => lines.push({ level: "debug", text }),
    info: (text) => lines.push({ level: "info", text }),
    warn: (text) => lines.push({ level: "warn", text }),
    error: (text) => lines.push({ level: "error", text }),
    status: (text) => lines.push({ level: "status", text }),
    child: () => log,
  };
  return log;
}

/** One request as the fake endpoint saw it. */
export interface SeenRequest {
  readonly method: string;
  readonly url: URL;
  /** The request target exactly as sent (path and query), for byte comparisons. */
  readonly target: string;
  readonly body: string | undefined;
  /** Redirect policy the caller asked the fetcher for; `undefined` from the fake `http`. */
  readonly redirect?: "follow" | "error" | undefined;
}

/**
 * A `Fetcher` whose answers come from `respond`. Returning an `Error` makes the
 * call throw it — a timeout or a refused connection, as the real fetcher
 * reports them once its retries are spent.
 */
export function scriptedFetcher(respond: (request: SeenRequest) => HttpResponse | Error): {
  readonly fetcher: Fetcher;
  readonly seen: SeenRequest[];
} {
  const seen: SeenRequest[] = [];
  const text = (url: string, options?: FetchOptions): Promise<HttpResponse> => {
    const parsed = new URL(url);
    const request: SeenRequest = {
      method: options?.method ?? "GET",
      url: parsed,
      target: url.slice(parsed.origin.length),
      body: options?.body,
      redirect: options?.redirect,
    };
    seen.push(request);
    const answer = respond(request);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
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
  return { fetcher, seen };
}

type Listener = (value?: unknown) => void;

/** `typeof x === "function"` as a predicate — the only thing a sandbox callback can be checked for. */
function isListener(value: unknown): value is Listener {
  return typeof value === "function";
}

function methodOf(options: unknown): string {
  if (typeof options !== "object" || options === null || !("method" in options)) return "GET";
  return typeof options.method === "string" ? options.method : "GET";
}

/**
 * A stand-in for `node:http` inside an old function node — `http.request` and
 * `http.get` as PRUNE_HELPER and the city pulse call them — answering from the
 * same `respond` function {@link scriptedFetcher} takes. One scripted broker
 * can therefore serve the old node (through this) and the port (through the
 * fetcher), and a parity test compares what both did to it.
 *
 * Pass it as `runFunctionNode(id, { modules: { http: fakeHttpModule(respond) } })`.
 * An `Error` from `respond` is emitted as the request's `error` event, as a
 * refused connection is.
 */
export function fakeHttpModule(
  respond: (request: SeenRequest) => HttpResponse | Error,
): Record<string, unknown> {
  const request = (url: unknown, options: unknown, callback: unknown): Record<string, unknown> => {
    const listeners = new Map<string, Listener>();
    const body: Buffer[] = [];
    let sent = false;
    const handle: Record<string, unknown> = {
      on: (event: unknown, listener: unknown): Record<string, unknown> => {
        if (isListener(listener)) listeners.set(String(event), listener);
        return handle;
      },
      setTimeout: (): Record<string, unknown> => handle,
      destroy: (): void => undefined,
      write: (data: unknown): boolean => {
        if (data instanceof Uint8Array || typeof data === "string") body.push(Buffer.from(data));
        return true;
      },
      end: (): Record<string, unknown> => {
        if (sent) return handle;
        sent = true;
        // Asynchronous, as a real socket: the caller registers its handlers
        // after `http.request()` returns.
        setImmediate(() => {
          const parsed = new URL(String(url));
          const answer = respond({
            method: methodOf(options),
            url: parsed,
            target: String(url).slice(parsed.origin.length),
            body: body.length > 0 ? Buffer.concat(body).toString("utf8") : undefined,
          });
          if (answer instanceof Error) {
            listeners.get("error")?.(answer);
            return;
          }
          const responseListeners = new Map<string, Listener>();
          const response: Record<string, unknown> = {
            statusCode: answer.status,
            headers: { ...answer.headers },
            on: (event: unknown, listener: unknown): Record<string, unknown> => {
              if (isListener(listener)) responseListeners.set(String(event), listener);
              return response;
            },
          };
          if (isListener(callback)) callback(response);
          setImmediate(() => {
            responseListeners.get("data")?.(Buffer.from(answer.body, "utf8"));
            responseListeners.get("end")?.();
          });
        });
        return handle;
      },
    };
    return handle;
  };
  return {
    request,
    // http.get() ends the request itself.
    get: (url: unknown, options: unknown, callback: unknown): Record<string, unknown> => {
      const handle = request(url, options, callback);
      const end = handle.end;
      if (isListener(end)) end();
      return handle;
    },
  };
}

/** A response literal with sensible defaults. */
export function httpResponse(
  status: number,
  body = "",
  headers: Readonly<Record<string, string>> = {},
): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers, body };
}
