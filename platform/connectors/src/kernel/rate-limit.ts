/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Token bucket per host — the replacement for the 25 `delay` nodes.
 *
 * Those nodes are rate limiters in Node-RED's sense: 20 of them pace one request
 * per second (mostly the chunked upserts towards Orion-LD), one paces one per
 * three seconds, two one per fifteen and two one per ninety — the Overpass
 * connectors, whose provider limits are the strictest in the set.
 *
 * All 25 run with `drop: false`, which means an UNBOUNDED queue. A source
 * answering more slowly than it is polled grows that queue in memory without a
 * word until the container dies. The migration decided against carrying that
 * over (docs/migration-konnektoren.md, risk "Taktung"): the bucket has a cap and
 * reports the overflow.
 *
 * Deviation, deliberate: a delay node paces its own wire, so two connectors
 * writing to Orion-LD concurrently used to send 2/s in total. The bucket here is
 * keyed by HOST and therefore shared across connectors — strictly more polite
 * towards every provider, never less. The alternative (a bucket per connector
 * and host) would reproduce the old numbers and lose the property that makes
 * this worth having: one place that knows how hard a host is being hit.
 *
 * ## Concurrency cap
 *
 * A delay node spaces the STARTS of requests; a request slower than the
 * interval overlapped the next one. `maxConcurrent` closes that gap where it
 * matters (Overpass: a few slots per IP, 504 on overload): a waiter gets its
 * token only while fewer than that many acquisitions of the bucket are
 * unreleased. Waiters stay first-in, first-out; a release wakes the queue.
 */

import type { Log, RateLimiter, RateLimitOptions, RateLimitRelease } from "./types.js";

/** "1 Anfrage/s" — the setting of 20 of the 25 delay nodes. */
export const DEFAULT_MIN_INTERVAL_MS = 1000;

export const DEFAULT_BURST = 1;

/**
 * Waiters per host before `acquire` rejects. Sized so that the largest known
 * fan-out still fits: `parken-bw` upserts ~32,000 parking sites in chunks of
 * 100, and the boundary check must not turn a legitimate large run into an
 * error. Anything beyond this is a queue that will not drain.
 */
export const DEFAULT_MAX_QUEUE = 500;

export class RateLimitOverflowError extends Error {
  readonly host: string;

  constructor(host: string, queued: number) {
    super(`rate limit queue for ${host} is full (${String(queued)} waiting)`);
    this.name = "RateLimitOverflowError";
    this.host = host;
  }
}

/** A usable concurrency cap: a whole number of at least 1. */
function validCap(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 1;
}

interface Bucket {
  readonly host: string;
  minIntervalMs: number;
  burst: number;
  maxQueue: number;
  /** `Infinity` = no cap. */
  maxConcurrent: number;
  /** Acquisitions handed out and not yet released. */
  inFlight: number;
  /** Fractional tokens, refilled by elapsed time. */
  tokens: number;
  lastRefill: number;
  readonly waiting: (() => void)[];
  timer: NodeJS.Timeout | null;
  /** So the overflow is reported once per burst of overflows, not per waiter. */
  overflowsReported: boolean;
}

class HostRateLimiter implements RateLimiter {
  readonly #log: Log;
  readonly #buckets = new Map<string, Bucket>();

  constructor(log: Log) {
    this.#log = log;
  }

  async acquire(host: string, options?: RateLimitOptions): Promise<RateLimitRelease> {
    const bucket = this.#bucket(host, options);
    this.#refill(bucket);
    if (bucket.waiting.length === 0 && bucket.tokens >= 1 && bucket.inFlight < bucket.maxConcurrent) {
      bucket.tokens -= 1;
      bucket.inFlight += 1;
      return this.#releaser(bucket);
    }
    if (bucket.waiting.length >= bucket.maxQueue) {
      if (!bucket.overflowsReported) {
        bucket.overflowsReported = true;
        this.#log.warn(
          `rate limit for ${host}: queue cap of ${String(bucket.maxQueue)} reached — ` +
            `requests are being rejected instead of queued (the old delay nodes grew silently)`,
        );
      }
      throw new RateLimitOverflowError(host, bucket.waiting.length);
    }
    // #drain counts the waiter as in flight when it resolves it.
    await new Promise<void>((resolve) => {
      bucket.waiting.push(resolve);
      this.#schedule(bucket);
    });
    return this.#releaser(bucket);
  }

  async run<T>(host: string, task: () => Promise<T>, options?: RateLimitOptions): Promise<T> {
    const release = await this.acquire(host, options);
    try {
      return await task();
    } finally {
      release();
    }
  }

  #releaser(bucket: Bucket): RateLimitRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      bucket.inFlight -= 1;
      if (bucket.waiting.length > 0) this.#drain(bucket);
    };
  }

  #bucket(host: string, options?: RateLimitOptions): Bucket {
    const existing = this.#buckets.get(host);
    if (existing !== undefined) {
      // A caller may tighten the pace for a host (Overpass: one per 90 s), but
      // never loosen it: the strictest requirement seen for a host wins, so a
      // connector that forgets its own limit cannot undo another one's.
      if (options?.minIntervalMs !== undefined && options.minIntervalMs > existing.minIntervalMs) {
        existing.minIntervalMs = options.minIntervalMs;
      }
      if (options?.maxQueue !== undefined && options.maxQueue > existing.maxQueue) {
        existing.maxQueue = options.maxQueue;
      }
      // The same for the concurrency cap: the lowest cap seen wins.
      const cap = options?.maxConcurrent;
      if (validCap(cap) && cap < existing.maxConcurrent) existing.maxConcurrent = cap;
      return existing;
    }
    const burst = options?.burst ?? DEFAULT_BURST;
    const cap = options?.maxConcurrent;
    const bucket: Bucket = {
      host,
      minIntervalMs: options?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      burst,
      maxQueue: options?.maxQueue ?? DEFAULT_MAX_QUEUE,
      maxConcurrent: validCap(cap) ? cap : Number.POSITIVE_INFINITY,
      inFlight: 0,
      tokens: burst,
      lastRefill: Date.now(),
      waiting: [],
      timer: null,
      overflowsReported: false,
    };
    this.#buckets.set(host, bucket);
    return bucket;
  }

  #refill(bucket: Bucket): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    if (elapsed <= 0) return;
    bucket.lastRefill = now;
    bucket.tokens = Math.min(bucket.burst, bucket.tokens + elapsed / bucket.minIntervalMs);
  }

  #schedule(bucket: Bucket): void {
    if (bucket.timer !== null) return;
    // At the cap no token helps; the next release drains the queue.
    if (bucket.inFlight >= bucket.maxConcurrent) return;
    const wait = Math.max(1, Math.ceil((1 - bucket.tokens) * bucket.minIntervalMs));
    const timer = setTimeout(() => {
      bucket.timer = null;
      this.#drain(bucket);
    }, wait);
    timer.unref();
    bucket.timer = timer;
  }

  #drain(bucket: Bucket): void {
    this.#refill(bucket);
    while (bucket.tokens >= 1 && bucket.inFlight < bucket.maxConcurrent && bucket.waiting.length > 0) {
      bucket.tokens -= 1;
      bucket.inFlight += 1;
      const next = bucket.waiting.shift();
      if (next !== undefined) next();
    }
    if (bucket.waiting.length > 0) this.#schedule(bucket);
    else bucket.overflowsReported = false;
  }
}

export function createRateLimiter(log: Log): RateLimiter {
  return new HostRateLimiter(log);
}
