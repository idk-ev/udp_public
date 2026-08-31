/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * HTTP client of the service: timeout, retry, User-Agent, rate limiting.
 *
 * This module is where a whole class of handwork disappears. The ParkAPI
 * connector had to build its own HTTP client inside the function node, and its
 * comment explains why:
 *
 *   > Warum node:https statt fetch(): Der Function-Node läuft in einem eigenen
 *   > vm-Kontext (Node-RED 4.1, 10-function.js: vm.createContext(sandbox)). Der
 *   > Sandbox enthält console/util/Buffer/URL/Date/RED/setTimeout — die
 *   > Node-Globals werden NICHT vererbt, fetch ist dort undefined.
 *
 * So it assembled request options by hand, collected chunks into a Buffer,
 * inspected `content-encoding` and called `zlib.gunzipSync` itself, and armed a
 * socket timeout with `request.setTimeout(30000, …)`. Outside the sandbox
 * `fetch` does all of that: gzip is transparent, `AbortSignal.timeout` replaces
 * the socket timer, and the response body arrives decoded. The 30 s and the
 * `Accept-Encoding: gzip` intent survive as defaults below.
 *
 * Non-2xx does not throw. Every `http request` node in the flows runs with
 * `senderr: false`, hands the status to the function node and lets it decide —
 * which is why every ported function begins with `if (msg.statusCode >= 400)`.
 * Keeping that contract keeps the ports readable next to their originals. Only
 * network errors and timeouts throw, and only once the retries are used up.
 */

import type { Fetcher, FetchOptions, HttpResponse, JsonResponse, RateLimiter } from "./types.js";
import type { Log } from "./types.js";

/** As the ParkAPI node's socket timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Attempts after the first one. */
export const DEFAULT_RETRIES = 2;

export const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * Identifies the service to the providers. Overpass demands a contact address
 * and blocks anonymous bulk traffic; the old flows set the same string by hand
 * on the three Overpass connectors (`OVERPASS_UA` in the generator) and nothing
 * at all everywhere else.
 */
export const DEFAULT_USER_AGENT = "UDP-BW-Dashboard/1.0 (kommunale Referenzplattform; tk@idkev.de)";

export class FetchError extends Error {
  readonly url: string;

  constructor(message: string, url: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FetchError";
    this.url = url;
  }
}

/** `AbortSignal.timeout` fired: the source did not answer in time. */
export class FetchTimeoutError extends FetchError {
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(`${url}: no response within ${String(timeoutMs)} ms`, url, options);
    this.name = "FetchTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** DNS, TCP, TLS — the request never produced a response. */
export class FetchNetworkError extends FetchError {
  constructor(url: string, options?: { cause?: unknown }) {
    super(`${url}: request failed`, url, options);
    this.name = "FetchNetworkError";
  }
}

/** The body was not JSON. Separate from a transport fault: the source answered. */
export class JsonParseError extends FetchError {
  readonly status: number;

  constructor(url: string, status: number, options?: { cause?: unknown }) {
    super(`${url}: response with status ${String(status)} is not valid JSON`, url, options);
    this.name = "JsonParseError";
    this.status = status;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // A malformed URL still needs a bucket key; it will fail in fetch() anyway
    // and should not take the rate limiter down on the way.
    return url;
  }
}

function headersOf(response: Response): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

class RetryingFetcher implements Fetcher {
  readonly #log: Log;
  readonly #limiter: RateLimiter;
  readonly #userAgent: string;

  constructor(log: Log, limiter: RateLimiter, userAgent: string) {
    this.#log = log;
    this.#limiter = limiter;
    this.#userAgent = userAgent;
  }

  async text(url: string, options?: FetchOptions): Promise<HttpResponse> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = options?.retries ?? DEFAULT_RETRIES;
    const host = hostOf(url);
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      await this.#limiter.acquire(host, {
        ...(options?.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
      });
      try {
        return await this.#once(url, options, timeoutMs);
      } catch (error) {
        lastError = error;
        if (attempt === retries) break;
        const delay = DEFAULT_RETRY_DELAY_MS * (attempt + 1);
        this.#log.debug(
          `${url}: attempt ${String(attempt + 1)}/${String(retries + 1)} failed, retrying in ${String(delay)} ms`,
        );
        await sleep(delay);
      }
    }
    throw lastError;
  }

  async json(url: string, options?: FetchOptions): Promise<JsonResponse> {
    const response = await this.text(url, {
      ...options,
      headers: { Accept: "application/json", ...options?.headers },
    });
    // A non-2xx answer is very often an HTML error page. Parsing it would throw
    // and hide the status the caller actually wants to see, so the body is only
    // decoded on success — the status still reaches the connector's guard.
    if (!response.ok) return { status: response.status, ok: false, body: null };
    try {
      const body: unknown = JSON.parse(response.body);
      return { status: response.status, ok: true, body };
    } catch (error) {
      throw new JsonParseError(url, response.status, { cause: error });
    }
  }

  async #once(url: string, options: FetchOptions | undefined, timeoutMs: number): Promise<HttpResponse> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: options?.method ?? "GET",
        headers: {
          // fetch negotiates and decodes gzip itself; the header only documents
          // the intent the old node had to implement with zlib.gunzipSync.
          "Accept-Encoding": "gzip, deflate",
          "User-Agent": options?.userAgent ?? this.#userAgent,
          ...options?.headers,
        },
        ...(options?.body === undefined ? {} : { body: options.body }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new FetchTimeoutError(url, timeoutMs, { cause: error });
      }
      throw new FetchNetworkError(url, { cause: error });
    }

    // Reading the body can still fail (connection dropped mid-stream); that is a
    // transport fault and belongs to the retry, not to the caller's guard.
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new FetchTimeoutError(url, timeoutMs, { cause: error });
      }
      throw new FetchNetworkError(url, { cause: error });
    }

    return { status: response.status, ok: response.ok, headers: headersOf(response), body };
  }
}

export function createFetcher(log: Log, limiter: RateLimiter, userAgent?: string): Fetcher {
  return new RetryingFetcher(log, limiter, userAgent ?? DEFAULT_USER_AGENT);
}
