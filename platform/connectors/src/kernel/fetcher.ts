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
 *
 * ## Deliberate deviations (security review)
 *
 *  * **Body cap.** The body is read as a stream and counted in DECOMPRESSED
 *    bytes ({@link DEFAULT_MAX_BYTES}, per call `maxBytes`): a 0.4 MB gzip
 *    body inflated to ~400 MB in `response.text()`. An announced
 *    `Content-Length` above the cap is refused before reading; a body growing
 *    past it aborts the request. {@link FetchTooLargeError}, not retried. The
 *    old `http request` nodes read without a limit.
 *  * **Redirects are refused by default** ({@link FetchRedirectError}); the
 *    nodes followed every one. A call opts in with `redirect: "follow"` where
 *    a source is known to redirect (the GBFS feeds of third parties; `uba-bw`
 *    did until it moved to the target of its 301).
 *    Followed hop by hop here (at most {@link MAX_REDIRECTS}), http(s) only,
 *    every target checked against `allowUrl`, and every header except content
 *    negotiation and User-Agent dropped when the origin changes. Credentials
 *    (hystreet) and Orion writes never follow.
 *  * **Caller abort.** `signal` aborts the request — a public route whose
 *    client went away. {@link FetchAbortedError}, not retried.
 */

import type {
  Fetcher,
  FetchOptions,
  HttpResponse,
  JsonResponse,
  RateLimiter,
  RateLimitRelease,
} from "./types.js";
import type { Log } from "./types.js";

/** Release of an unpaced request: nothing was acquired. */
const NO_RELEASE: RateLimitRelease = () => undefined;

/** As the ParkAPI node's socket timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Attempts after the first one. */
export const DEFAULT_RETRIES = 2;

export const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * Decompressed body cap unless a call sets its own. The largest regular
 * answers measured (2026-09) are below 2 MB (sensor.community box 1.8 MB, a
 * ladesaeulen-bw page of 1,000 locations 1.5 MB); 32 MiB leaves an order of
 * magnitude of headroom and still stops a decompression bomb long before it
 * hurts.
 */
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** Hops followed with `redirect: "follow"`. The sources that redirect need one. */
export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Headers kept when a followed redirect changes the origin. */
const CROSS_ORIGIN_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
]);

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

/** The body exceeds the cap (announced or while reading). Not retried. */
export class FetchTooLargeError extends FetchError {
  readonly maxBytes: number;

  constructor(url: string, maxBytes: number) {
    super(`${url}: response body larger than ${String(maxBytes)} bytes, request aborted`, url);
    this.name = "FetchTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/** A redirect that was not followed (policy, hop limit, scheme). Not retried. */
export class FetchRedirectError extends FetchError {
  readonly location: string;

  constructor(url: string, location: string, reason: string) {
    super(`${url}: redirect to ${location} not followed (${reason})`, url);
    this.name = "FetchRedirectError";
    this.location = location;
  }
}

/** `allowUrl` refused the URL or a redirect target; nothing was sent there. Not retried. */
export class FetchUrlRefusedError extends FetchError {
  readonly target: string;

  constructor(url: string, target: string) {
    super(`${url}: ${target === url ? "URL" : `redirect target ${target}`} refused by the URL policy`, url);
    this.name = "FetchUrlRefusedError";
    this.target = target;
  }
}

/** The caller's `signal` aborted the request. Not retried. */
export class FetchAbortedError extends FetchError {
  constructor(url: string, options?: { cause?: unknown }) {
    super(`${url}: request aborted by the caller`, url, options);
    this.name = "FetchAbortedError";
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

/** Deterministic outcomes: another attempt would end the same way (or is unwanted). */
function retryable(error: unknown): boolean {
  return !(
    error instanceof FetchTooLargeError ||
    error instanceof FetchRedirectError ||
    error instanceof FetchUrlRefusedError ||
    error instanceof FetchAbortedError
  );
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

/** A usable byte cap: a positive whole number, else the default. */
function capOf(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_BYTES;
}

/** Drops an unread body so the connection is released; a failure does not matter here. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The request may already be aborted; nothing is left to release.
  }
}

/** Headers without the ones that must not follow a redirect to another origin. */
function crossOriginHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (CROSS_ORIGIN_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/** One attempt's request while redirects are walked. */
interface Hop {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
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
    const bucket = options?.bucket === undefined ? hostOf(url) : options.bucket;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (options?.signal?.aborted === true) throw new FetchAbortedError(url);
      // One acquisition per attempt, held until the response body is read, so
      // a concurrency cap covers the whole request; released before the retry
      // pause. `bucket: null` is unpaced (see FetchOptions.bucket).
      const release =
        bucket === null
          ? NO_RELEASE
          : await this.#limiter.acquire(bucket, {
              ...(options?.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
              ...(options?.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
            });
      try {
        return await this.#once(url, options, timeoutMs);
      } catch (error) {
        if (!retryable(error)) throw error;
        lastError = error;
      } finally {
        release();
      }
      if (attempt === retries) break;
      const delay = DEFAULT_RETRY_DELAY_MS * (attempt + 1);
      this.#log.debug(
        `${url}: attempt ${String(attempt + 1)}/${String(retries + 1)} failed, retrying in ${String(delay)} ms`,
      );
      await sleep(delay);
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
    const maxBytes = capOf(options?.maxBytes);
    const timeout = AbortSignal.timeout(timeoutMs);
    // Aborted by the fetcher itself when the body outgrows the cap.
    const cap = new AbortController();
    const caller = options?.signal;
    const signal = AbortSignal.any(
      caller === undefined ? [timeout, cap.signal] : [timeout, cap.signal, caller],
    );
    const failure = (error: unknown): FetchError => {
      if (caller?.aborted === true) return new FetchAbortedError(url, { cause: error });
      if (timeout.aborted) return new FetchTimeoutError(url, timeoutMs, { cause: error });
      return new FetchNetworkError(url, { cause: error });
    };

    let hop: Hop = {
      url,
      method: options?.method ?? "GET",
      headers: {
        // fetch negotiates and decodes gzip itself; the header only documents
        // the intent the old node had to implement with zlib.gunzipSync.
        "Accept-Encoding": "gzip, deflate",
        "User-Agent": options?.userAgent ?? this.#userAgent,
        ...options?.headers,
      },
      body: options?.body,
    };
    for (let hops = 0; ; hops += 1) {
      let target: URL;
      try {
        target = new URL(hop.url);
      } catch (error) {
        throw new FetchNetworkError(url, { cause: error });
      }
      if (options?.allowUrl !== undefined && !options.allowUrl(target)) {
        throw new FetchUrlRefusedError(url, hop.url);
      }

      let response: Response;
      try {
        response = await fetch(hop.url, {
          method: hop.method,
          headers: hop.headers,
          ...(hop.body === undefined ? {} : { body: hop.body }),
          signal,
          redirect: "manual",
        });
      } catch (error) {
        throw failure(error);
      }

      const location = response.headers.get("location");
      if (REDIRECT_STATUSES.has(response.status) && location !== null) {
        await discard(response);
        hop = nextHop(url, hop, target, response.status, location, options?.redirect, hops);
        continue;
      }

      const body = await readCapped(url, response, maxBytes, cap, failure, options?.encoding);
      return { status: response.status, ok: response.ok, headers: headersOf(response), body };
    }
  }
}

/** The next hop of a redirect, or the refusal. */
function nextHop(
  url: string,
  hop: Hop,
  from: URL,
  status: number,
  location: string,
  policy: "follow" | "error" | undefined,
  hops: number,
): Hop {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new FetchRedirectError(url, location, "unparseable Location");
  }
  if (policy !== "follow") throw new FetchRedirectError(url, next.href, "redirects are not followed");
  if (hops >= MAX_REDIRECTS) {
    throw new FetchRedirectError(url, next.href, `more than ${String(MAX_REDIRECTS)} hops`);
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw new FetchRedirectError(url, next.href, "not http(s)");
  }
  // fetch's rules: 303, and 301/302 after a POST, continue as a GET without body.
  const toGet = status === 303 || ((status === 301 || status === 302) && hop.method === "POST");
  const kept = next.origin === from.origin ? hop.headers : crossOriginHeaders(hop.headers);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(kept)) {
    if (!(toGet && name.toLowerCase() === "content-type")) headers[name] = value;
  }
  return { url: next.href, method: toGet ? "GET" : hop.method, headers, body: toGet ? undefined : hop.body };
}

/**
 * The body as text, counted in decompressed bytes. Reading can still fail
 * (connection dropped mid-stream); that is a transport fault and belongs to the
 * retry, not to the caller's guard.
 */
async function readCapped(
  url: string,
  response: Response,
  maxBytes: number,
  cap: AbortController,
  failure: (error: unknown) => FetchError,
  encoding: "utf-8" | "latin1" = "utf-8",
): Promise<string> {
  const announced = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(announced) && announced > maxBytes) {
    cap.abort();
    await discard(response);
    throw new FetchTooLargeError(url, maxBytes);
  }
  const stream = response.body;
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw failure(error);
    }
    if (chunk.done) break;
    // Typed `any` by the fetch declarations; undici delivers Uint8Array chunks.
    const value: unknown = chunk.value;
    if (!(value instanceof Uint8Array)) throw failure(new TypeError("response body chunk is not bytes"));
    size += value.byteLength;
    if (size > maxBytes) {
      cap.abort();
      try {
        await reader.cancel();
      } catch {
        // Already aborted.
      }
      throw new FetchTooLargeError(url, maxBytes);
    }
    chunks.push(value);
  }
  // ISO-8859-1 byte for byte (Buffer's latin1 is that, not windows-1252).
  if (encoding === "latin1") return Buffer.concat(chunks).toString("latin1");
  // As `response.text()`: UTF-8 with replacement characters, a BOM dropped.
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

export function createFetcher(log: Log, limiter: RateLimiter, userAgent?: string): Fetcher {
  return new RetryingFetcher(log, limiter, userAgent ?? DEFAULT_USER_AGENT);
}
