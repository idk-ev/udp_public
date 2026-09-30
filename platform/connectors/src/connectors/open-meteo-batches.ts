/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The Open-Meteo eight-batch fan-out shared by `wetter-bw` and `vorhersage-bw`.
 *
 * Both connectors were the same node chain in the old flows, differing only in
 * the query and in the build node:
 *
 *     inject -> bw-gemeinden.json -> batch node (8 URLs, ~140 coordinates each)
 *       -> delay "1 Anfrage/15s" -> http request -> "bündeln" (wrap)
 *       -> join 8 (timeout 240 s) -> build node -> delay "1 Anfrage/s" -> upsert
 *
 * What is behaviour here and therefore ported, not smoothed over:
 *
 *  * **Pacing.** One Open-Meteo call per 20 s (the flow: 15 s), through the
 *    kernel's token bucket for the host, shared by both connectors (see
 *    src/kernel/rate-limit.ts). See "Quota" below for why 20.
 *  * **Request timeout.** The `http request` node waited 120 s (Node-RED's
 *    default `httpRequestTimeout`); so does the port. No transport retry: a
 *    retry is a second call of ~140 coordinates. The one exception is HTTP 429,
 *    below.
 *  * **Join semantics.** The join node (custom mode, `count: 8`, `timeout: 240`)
 *    emits a group as soon as 8 wrapped batches arrived — in ARRIVAL order, not
 *    batch order — or 240 s after the first one arrived, with whatever it has by
 *    then: a PARTIAL array. A batch arriving after that opens a new group, which
 *    is emitted in turn (Node-RED's `inflight` group is deleted on send). So the
 *    municipalities of a late batch were not lost, only written in a second
 *    upsert. {@link joinGroups} reproduces exactly that and counts it.
 *  * **Failed batches still count.** The wrap node turned a non-2xx answer into
 *    `{ agsList, data: [] }` with a warning, and the `http request` node passed a
 *    network error on as a message too (`senderr: false`); either way the join
 *    received a part and the build node skipped its municipalities.
 *
 * Two deliberate deviations in timing only:
 *
 *  * A group that cannot grow any more (every batch has settled) is emitted at
 *    once instead of after the rest of the 240 s. The old join waited them out
 *    when fewer than 8 batches existed (fewer than 8 municipalities) or after
 *    a timeout, and then emitted the same array.
 *  * The join window is longer than 240 s ({@link joinTimingFor}): the
 *    shared bucket and one retry after a 429 must not be able to turn a group
 *    that is only waiting its turn into a partial one.
 *
 * ## Quota
 *
 * Open-Meteo's free tier allows 600 calls a minute, 5,000 an hour and 10,000 a
 * day, and counts every COORDINATE of a multi-location call as one call —
 * weighted up for more than 10 variables or more than 14 days
 * ({@link callWeight}). One run is ~1,100 calls; both connectors every 6 h are
 * 8 runs, ~8,800 a day. What keeps that inside the limits:
 *
 *  * **Minute.** A batch has at most {@link MAX_BATCH_COORDINATES} = 150
 *    coordinates and batch starts are 20 s apart (burst 1, shared bucket):
 *    any closed 60 s window holds at most 4 starts, 4 × 150 = 600. With 15 s
 *    it held 5 — 690 for 138-coordinate batches.
 *  * **Day.** A per-host daily counter (`ctx.quota`, persisted, UTC day) with
 *    a soft cap ({@link DEFAULT_DAILY_CAP}, `UDP_OPEN_METEO_DAILY_CAP`): a
 *    batch that would pass it is not sent, nor is the rest of its run.
 *    **Current weather has priority**: the forecast stops early enough that
 *    the weather runs still due today (UTC) fit ({@link weatherReserve}). A
 *    current value is wrong after a few hours; a four-day forecast from the
 *    previous run is still mostly right — the one that ages faster gets the
 *    budget.
 *  * **Hour.** An in-memory sliding hour, capped at {@link HOURLY_CAP}: only
 *    manual triggers could get near it, since the connectors run 3 h apart.
 *  * **HTTP 429.** `Retry-After` (seconds or HTTP date, else 60 s) pauses the
 *    shared bucket for everyone; the batch is retried ONCE after the pause.
 *    A second 429 in the run, or a pause longer than
 *    {@link MAX_RETRY_WAIT_MS}, ends the run: the remaining batches are not
 *    sent, and later runs skip while the pause lasts instead of queueing.
 *
 * A batch that is not fetched keeps its municipalities' previous values in
 * the broker (no entity is written for them) and is reported with its index.
 */

import { field, isArray, isTruthy, requireNumber } from "../kernel/parse.js";
import { RateLimitAbortedError } from "../kernel/rate-limit.js";
import { slotBounds } from "../kernel/scheduler.js";
import type {
  Ags,
  Ctx,
  HttpResponse,
  MunicipalityRow,
  RateLimiter,
  RateLimitRelease,
} from "../kernel/types.js";
import { DEFAULT_URL as MUNICIPALITIES_URL, parse as parseMunicipalities } from "./stammdaten-bw.js";

/** `const N = 8` of both batch nodes — the minimum; more if a batch would exceed {@link MAX_BATCH_COORDINATES}. */
export const BATCH_COUNT = 8;

export const OPEN_METEO_HOST = "api.open-meteo.com";
export const OPEN_METEO_FORECAST_URL = `https://${OPEN_METEO_HOST}/v1/forecast`;

/** Open-Meteo's free tier, calls (= coordinates) per minute. */
export const MINUTE_LIMIT = 600;

/** Starts in any closed 60 s window at {@link REQUEST_INTERVAL_MS}: t, t+20, t+40, t+60. */
export const STARTS_PER_MINUTE = 4;

/** Coordinates per batch so that {@link STARTS_PER_MINUTE} batches stay within {@link MINUTE_LIMIT}. */
export const MAX_BATCH_COORDINATES = MINUTE_LIMIT / STARTS_PER_MINUTE;

/** Spacing of Open-Meteo calls (the flow: 15 s, which allowed 5 starts in a closed minute). */
export const REQUEST_INTERVAL_MS = 20_000;

/** Soft daily cap in calls, below the free tier's 10,000; `UDP_OPEN_METEO_DAILY_CAP`. */
export const DEFAULT_DAILY_CAP = 9_000;
export const DAILY_CAP_ENV = "UDP_OPEN_METEO_DAILY_CAP";

/** Soft cap per rolling hour, below the free tier's 5,000. In memory only. */
export const HOURLY_CAP = 4_500;

/** Pause after a 429 without a usable `Retry-After`. */
export const DEFAULT_429_PAUSE_MS = 60_000;

/** A 429 asking for a longer pause ends the run instead of waiting for the retry. */
export const MAX_RETRY_WAIT_MS = 300_000;

/** Upper bound for a pause asked for by `Retry-After` — one run interval. */
export const MAX_PAUSE_MS = 6 * 3_600_000;

/** Node-RED's default `httpRequestTimeout`; the flows did not override it. */
export const REQUEST_TIMEOUT_MS = 120_000;

/** `timeout: "240"` of both join nodes — the floor of {@link joinTimingFor}. */
export const JOIN_TIMEOUT_MS = 240_000;

/**
 * Connectors whose calls wait in the ONE token bucket of `api.open-meteo.com`:
 * `wetter-bw` and `vorhersage-bw`.
 */
export const SHARED_BUCKET_CONNECTORS = 2;

/** Slack on top of the computed worst case (answer jitter, timer drift). */
export const JOIN_MARGIN_MS = 30_000;

/** The pacing a join window has to cover; {@link OPEN_METEO_PACE} in production. */
export interface BucketPace {
  /** Spacing of request starts in the shared bucket. */
  readonly intervalMs: number;
  /** Longest a request can take before it settles. */
  readonly requestTimeoutMs: number;
  /** Connectors sharing the bucket, each with at most {@link BATCH_COUNT} calls per run. */
  readonly sharers: number;
  /** Longest wait for the one retry after a 429 ({@link MAX_RETRY_WAIT_MS}). */
  readonly retryWaitMs: number;
  readonly marginMs: number;
}

export const OPEN_METEO_PACE: BucketPace = {
  intervalMs: REQUEST_INTERVAL_MS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  sharers: SHARED_BUCKET_CONNECTORS,
  retryWaitMs: MAX_RETRY_WAIT_MS,
  marginMs: JOIN_MARGIN_MS,
};

/**
 * Longest possible gap between the first and the last ARRIVAL of one run's
 * `batchCount` batches, plus margin — the join timer starts at the first
 * arrival (see {@link joinGroups}).
 *
 * Each old connector had its own delay node, so its eight calls started 15 s
 * apart and the last arrived at most 7 × 15 s + 120 s = 225 s after the
 * first: the join's 240 s fitted. The bucket is now shared by
 * {@link SHARED_BUCKET_CONNECTORS} connectors (kept on purpose: it is the more
 * polite pace, and Open-Meteo answered 429 on 21.07.). The bucket is FIFO and
 * a run enqueues all its calls in one tick, so today they stay contiguous
 * and the spread is unchanged — but the window must not depend on that: if
 * the other connector's calls ever land between ours, the last of ours starts
 * up to `(batchCount − 1 + BATCH_COUNT × (sharers − 1)) × interval` after the
 * first and may take the full request timeout. On top comes the one retry
 * after a 429: the pause (at most {@link MAX_RETRY_WAIT_MS}), a token and the
 * request timeout once more. (7 + 8) × 20 s + 120 s + 300 s + 20 s + 120 s,
 * with margin 890 s. Anything shorter could cut a group that is merely
 * waiting its turn into a spurious partial result; the join still closes as
 * soon as every batch has settled.
 */
export function joinWindowMs(batchCount: number, pace: BucketPace = OPEN_METEO_PACE): number {
  const startsAfterFirst = Math.max(0, batchCount - 1) + BATCH_COUNT * Math.max(0, pace.sharers - 1);
  const retry = pace.retryWaitMs + pace.intervalMs + pace.requestTimeoutMs;
  return startsAfterFirst * pace.intervalMs + pace.requestTimeoutMs + retry + pace.marginMs;
}

/** The join of one run: `count: 8` as the node (more batches, more), the window of {@link joinWindowMs}. */
export function joinTimingFor(batchCount: number): JoinTiming {
  return {
    count: Math.max(BATCH_COUNT, batchCount),
    timeoutMs: Math.max(JOIN_TIMEOUT_MS, joinWindowMs(batchCount)),
  };
}

/** Upsert chunk size of both build nodes: `emitChunks(node, msg, entities, 100)`. */
export const UPSERT_CHUNK_SIZE = 100;

/**
 * `g.slice(i * size, (i + 1) * size)` for `i < 8` with `size = ceil(n / 8)`,
 * skipping empty slices (`if (!part.length) continue;`) — with fewer than 8
 * municipalities, or a count that leaves the tail empty, there are fewer
 * batches than 8. Above 8 × {@link MAX_BATCH_COORDINATES} municipalities
 * there are more (the flow had none): the per-minute bound rests on the
 * batch size.
 */
export function sliceBatches(rows: readonly MunicipalityRow[]): readonly (readonly MunicipalityRow[])[] {
  const count = Math.max(BATCH_COUNT, Math.ceil(rows.length / MAX_BATCH_COORDINATES));
  const size = Math.ceil(rows.length / count);
  const out: (readonly MunicipalityRow[])[] = [];
  for (let i = 0; i < count; i += 1) {
    const part = rows.slice(i * size, (i + 1) * size);
    if (part.length === 0) continue;
    out.push(part);
  }
  return out;
}

/** Comma-separated names of one query parameter (`current=a,b`), none if absent. */
function listParam(query: URLSearchParams, name: string): readonly string[] {
  const value = query.get(name);
  return value === null || value === "" ? [] : value.split(",");
}

/** Weather variables of a call: `current`, `hourly`, `daily`, `minutely_15` together. */
export function variableCount(url: string): number {
  const query = new URL(url).searchParams;
  return ["current", "hourly", "daily", "minutely_15"].reduce(
    (sum, name) => sum + listParam(query, name).length,
    0,
  );
}

/** Days of a call: `forecast_days` (Open-Meteo's default 7) plus `past_days`. */
export function forecastDays(url: string): number {
  const query = new URL(url).searchParams;
  const days = Number(query.get("forecast_days") ?? "7");
  const past = Number(query.get("past_days") ?? "0");
  return (Number.isFinite(days) ? days : 7) + (Number.isFinite(past) ? past : 0);
}

/**
 * What one coordinate of `url` costs: 1 up to 10 variables and 14 days, more
 * beyond ("15 variables over 2 weeks = 1.5 calls, 4 weeks = 3.0" in
 * Open-Meteo's pricing).
 */
export function callWeight(url: string): number {
  return Math.max(1, variableCount(url) / 10) * Math.max(1, forecastDays(url) / 14);
}

/**
 * `'?latitude=' + lat + '&longitude=' + lon` of the batch nodes. Numbers are
 * joined with JavaScript's default number formatting, as `Array.join` did.
 */
export function coordinateQuery(rows: readonly MunicipalityRow[]): string {
  const lat = rows.map((row) => String(row[2])).join(",");
  const lon = rows.map((row) => String(row[3])).join(",");
  return `?latitude=${lat}&longitude=${lon}`;
}

/** `agsList: part.map(r => r[0])`. */
export function agsListOf(rows: readonly MunicipalityRow[]): readonly Ags[] {
  return rows.map((row) => row[0]);
}

/**
 * The body of a successful Open-Meteo call as the wrap node stored it:
 * `Array.isArray(msg.payload) ? msg.payload : [msg.payload]`. A call with ONE
 * coordinate returns a bare object instead of a one-element array.
 */
export function locationsOf(body: unknown): readonly unknown[] {
  return Array.isArray(body) ? body : [body];
}

/**
 * A value as Open-Meteo reports it: a number, or `null` where the model has
 * none (the old nodes passed both through untouched). A missing key or any
 * other type is malformed.
 */
export function measurement(value: unknown, at: string): number | null {
  return value === null ? null : requireNumber(value, at);
}

/** Slots of an interval on the wall clock (src/kernel/scheduler.ts) still ahead today, UTC. */
export function slotsLeftToday(nowMs: number, intervalSeconds: number, offsetSeconds: number): number {
  const intervalMs = intervalSeconds * 1000;
  if (!(intervalMs > 0)) return 0;
  const dayEnd = (Math.floor(nowMs / 86_400_000) + 1) * 86_400_000;
  let count = 0;
  for (let at = slotBounds(nowMs, intervalMs, offsetSeconds * 1000).next; at < dayEnd; at += intervalMs) {
    count += 1;
  }
  return count;
}

/**
 * What the forecast keeps free below the daily cap for the weather: its
 * slots still ahead today × one run (the same municipalities, weight 1).
 * The weather's slots lie half an interval before the forecast's — the
 * registry keeps them so, a test checks it. Without slots (a fork without
 * `intervalOffsetSeconds`): one run.
 */
export function weatherReserve(
  nowMs: number,
  forecast: { readonly intervalSeconds: number | null; readonly intervalOffsetSeconds: number | null },
  runCost: number,
): number {
  const interval = forecast.intervalSeconds;
  const offset = forecast.intervalOffsetSeconds;
  if (interval === null || offset === null || interval <= 0) return runCost;
  const weatherOffset = (offset + interval / 2) % interval;
  return slotsLeftToday(nowMs, interval, weatherOffset) * runCost;
}

/* ------------------------------------------------------------------ I/O */

/**
 * `bw-gemeinden.json`, fetched by both connectors themselves (their own
 * `http request` node; they never read the geo context). `null` after the
 * batch node's warning: `if (msg.statusCode >= 400 || !msg.payload ||
 * !Array.isArray(msg.payload.gemeinden))`. The rows are then narrowed strictly
 * by `stammdaten-bw`'s parser — the file is this project's own build artefact.
 */
export async function loadMunicipalities(
  ctx: Ctx,
  label: string,
): Promise<readonly MunicipalityRow[] | null> {
  const response = await ctx.fetch.json(ctx.env.get("UDP_MUNICIPALITIES_URL") ?? MUNICIPALITIES_URL);
  if (!response.ok || !isArray(field(response.body, "gemeinden"))) {
    ctx.log.warn(`${label}: bw-gemeinden.json not loadable (HTTP ${String(response.status)})`);
    return null;
  }
  return parseMunicipalities(response.body).gemeinden;
}

/** One batch as the wrap node saw it: the parsed body, or a failed (or unsent) call. */
export type BatchBody = { readonly ok: true; readonly body: unknown } | { readonly ok: false };

/** One Open-Meteo call of a run. */
export interface BatchCall {
  /** 0-based position in the run. */
  readonly index: number;
  readonly url: string;
  /** Coordinates of the call — one per municipality. */
  readonly municipalities: number;
}

/**
 * What every run towards the host shares beyond the token bucket — per
 * kernel, i.e. per rate limiter.
 */
interface HostLedger {
  /** Nothing is sent before this (ms since epoch): the pause of the last 429. */
  pausedUntil: number;
  /** Calls of the last hour: `[sent at, units]`. */
  recent: (readonly [number, number])[];
}

const ledgers = new WeakMap<RateLimiter, HostLedger>();

function ledgerOf(limiter: RateLimiter): HostLedger {
  let ledger = ledgers.get(limiter);
  if (ledger === undefined) {
    ledger = { pausedUntil: 0, recent: [] };
    ledgers.set(limiter, ledger);
  }
  return ledger;
}

/** IMF-fixdate, the HTTP date format (RFC 9110): `Wed, 30 Sep 2026 12:00:00 GMT`. */
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * `Retry-After` in milliseconds — delta-seconds (`120`) or an HTTP date
 * (a past one is 0). `null` if absent or unreadable; the caller then pauses
 * {@link DEFAULT_429_PAUSE_MS}.
 */
export function retryAfterMs(value: string | undefined, nowMs: number): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  if (!HTTP_DATE.test(text)) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

function headerOf(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}

export interface OpenMeteoRunOptions {
  /** Prefix of the log lines (`BW weather`). */
  readonly label: string;
  /** Batches in the run, for "batch 3/8". */
  readonly batchCount: number;
  /**
   * Calls kept free below the daily cap for the connector with priority:
   * the forecast keeps one weather run, the weather keeps nothing (module
   * comment, "Quota").
   */
  readonly reserve: number;
  /** Clock of the pause and the hourly budget; `Date.now` unless a test simulates time. */
  readonly nowMs?: (() => number) | undefined;
}

interface Unfetched {
  readonly index: number;
  readonly municipalities: number;
}

/**
 * The Open-Meteo calls of one run: pacing, daily/hourly budget, 429 and the
 * report of what was not fetched (module comment, "Quota"). `fetch` never
 * throws: a failed or unsent call is an empty part for the join, as in the flow.
 */
export class OpenMeteoRun {
  readonly #ctx: Ctx;
  readonly #options: OpenMeteoRunOptions;
  readonly #ledger: HostLedger;
  readonly #dailyCap: number;
  readonly #nowMs: () => number;
  /** The run's one retry after a 429 is used. */
  #retried = false;
  /** Why the rest of the run is not sent; `null` while it is. */
  #stopped: string | null = null;
  /** Ends the waits for a token once the run stops, and on shutdown. */
  readonly #abort = new AbortController();
  readonly #signal: AbortSignal;
  readonly #skipped: Unfetched[] = [];
  readonly #failed: Unfetched[] = [];

  constructor(ctx: Ctx, options: OpenMeteoRunOptions) {
    this.#ctx = ctx;
    this.#options = options;
    this.#ledger = ledgerOf(ctx.limiter);
    const cap = ctx.env.number(DAILY_CAP_ENV, DEFAULT_DAILY_CAP);
    if (!(cap > 0)) {
      ctx.log.warn(
        `${DAILY_CAP_ENV}=${String(cap)} is not a positive number, using ${String(DEFAULT_DAILY_CAP)}`,
      );
    }
    this.#dailyCap = cap > 0 ? cap : DEFAULT_DAILY_CAP;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#signal = AbortSignal.any([this.#abort.signal, ctx.signal]);
  }

  async fetch(call: BatchCall): Promise<BatchBody> {
    const cost = call.municipalities * callWeight(call.url);
    let retry = false;
    for (;;) {
      if (this.#refused(cost)) return this.#skip(call);
      let release: RateLimitRelease;
      try {
        release = await this.#ctx.limiter.acquire(OPEN_METEO_HOST, {
          minIntervalMs: REQUEST_INTERVAL_MS,
          signal: this.#signal,
        });
      } catch (error) {
        // Stopped while waiting (a 429, the budget, shutdown): not sent.
        if (error instanceof RateLimitAbortedError) {
          if (this.#ctx.signal.aborted) this.#stop("shutdown");
          return this.#skip(call);
        }
        this.#ctx.log.error(`${this.#name(call)} not queued — previous values kept`, error);
        return this.#fail(call);
      }
      let response: HttpResponse;
      try {
        // Again with the token: a 429 or the other connector may have come first.
        if (this.#refused(cost)) return this.#skip(call);
        // Charged when sent, whatever the answer: a 429 and its retry, or a
        // timeout, count twice rather than not at all — the safe direction.
        this.#charge(cost);
        // Paced above; the token is held until the answer is in.
        response = await this.#ctx.fetch.text(call.url, {
          bucket: null,
          timeoutMs: REQUEST_TIMEOUT_MS,
          retries: 0,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        // The `http request` node reported a timeout or network error and
        // still passed the message on (`senderr: false`); the build node
        // skipped it. Same effect: an empty part.
        this.#ctx.log.error(`${this.#name(call)} failed — previous values kept`, error);
        return this.#fail(call);
      } finally {
        release();
      }

      if (response.status === 429) {
        const pauseMs = this.#pause(response);
        const seconds = String(Math.round(pauseMs / 1000));
        if (!retry && !this.#retried && pauseMs <= MAX_RETRY_WAIT_MS) {
          this.#retried = true;
          retry = true;
          this.#ctx.log.warn(
            `${this.#name(call)}: HTTP 429, Open-Meteo asks for a pause of ${seconds} s — ` +
              "all Open-Meteo calls wait, then this batch is retried once",
          );
          continue;
        }
        const reason = `HTTP 429${retry ? " again on the retry" : ""}, Open-Meteo asks for a pause of ${seconds} s`;
        this.#stop(reason);
        this.#ctx.log.warn(`${this.#name(call)}: ${reason} — the rest of the run is not sent`);
        return this.#fail(call);
      }
      let body: unknown = null;
      if (response.ok) {
        try {
          body = JSON.parse(response.body);
        } catch {
          body = null;
        }
      }
      if (!isTruthy(body)) {
        // Wrap node: `if (msg.statusCode >= 400 || !msg.payload)`.
        this.#ctx.log.warn(
          `${this.#name(call)} failed (HTTP ${String(response.status)}${response.ok ? ", no usable body" : ""}) — ` +
            "previous values kept",
        );
        return this.#fail(call);
      }
      if (retry) this.#ctx.log.info(`${this.#name(call)}: retry after HTTP 429 succeeded`);
      return { ok: true, body };
    }
  }

  /** One warning at the end of the run for the batches that were not sent. */
  report(): void {
    if (this.#skipped.length === 0) return;
    const indices = [...this.#skipped].sort((a, b) => a.index - b.index).map((s) => String(s.index + 1));
    const municipalities = this.#skipped.reduce((sum, s) => sum + s.municipalities, 0);
    this.#ctx.log.warn(
      `${this.#options.label}: batch${indices.length === 1 ? "" : "es"} ${indices.join(", ")} of ` +
        `${String(this.#options.batchCount)} skipped, ${String(municipalities)} municipalities keep their ` +
        `previous values — ${this.#stopped ?? "stopped"}`,
    );
  }

  /** Batches failed or not sent, for the tests and the run's own summary. */
  get unfetched(): { readonly failed: number; readonly skipped: number } {
    return { failed: this.#failed.length, skipped: this.#skipped.length };
  }

  #name(call: BatchCall): string {
    return (
      `${this.#options.label}: batch ${String(call.index + 1)}/${String(this.#options.batchCount)} ` +
      `(${String(call.municipalities)} municipalities)`
    );
  }

  #skip(call: BatchCall): BatchBody {
    this.#skipped.push({ index: call.index, municipalities: call.municipalities });
    return { ok: false };
  }

  #fail(call: BatchCall): BatchBody {
    this.#failed.push({ index: call.index, municipalities: call.municipalities });
    return { ok: false };
  }

  /** The rest of the run is not sent; waiting batches leave the queue. */
  #stop(reason: string): void {
    this.#stopped ??= reason;
    this.#abort.abort();
  }

  /** Whether `cost` must not be sent; the first reason stops the rest of the run. */
  #refused(cost: number): boolean {
    if (this.#stopped !== null) return true;
    const now = this.#nowMs();
    if (this.#ctx.signal.aborted) {
      this.#stop("shutdown");
      return true;
    }
    if (this.#ledger.pausedUntil - now > MAX_RETRY_WAIT_MS) {
      this.#stop(`Open-Meteo asked for a pause until ${new Date(this.#ledger.pausedUntil).toISOString()}`);
      return true;
    }
    const reserve = this.#options.reserve;
    const cap = this.#dailyCap - reserve;
    const used = this.#ctx.quota.used(OPEN_METEO_HOST);
    if (used + cost > cap) {
      this.#stop(
        `daily Open-Meteo budget: ${String(used)} calls today (UTC), ${String(cost)} more would pass ` +
          String(cap) +
          (reserve > 0
            ? ` (cap ${String(this.#dailyCap)} less ${String(reserve)} kept for the weather runs due today)`
            : ""),
      );
      return true;
    }
    this.#ledger.recent = this.#ledger.recent.filter(([at]) => now - at < 3_600_000);
    const hour = this.#ledger.recent.reduce((sum, [, units]) => sum + units, 0);
    if (hour + cost > HOURLY_CAP) {
      this.#stop(
        `hourly Open-Meteo budget: ${String(hour)} calls in the last hour, cap ${String(HOURLY_CAP)}`,
      );
      return true;
    }
    return false;
  }

  #charge(cost: number): void {
    this.#ctx.quota.charge(OPEN_METEO_HOST, cost);
    this.#ledger.recent.push([this.#nowMs(), cost]);
  }

  /** Pauses the shared bucket as the 429 asks (60 s without a usable header); returns the pause. */
  #pause(response: HttpResponse): number {
    const now = this.#nowMs();
    const asked = retryAfterMs(headerOf(response.headers, "retry-after"), now) ?? DEFAULT_429_PAUSE_MS;
    const pauseMs = Math.min(asked, MAX_PAUSE_MS);
    this.#ledger.pausedUntil = Math.max(this.#ledger.pausedUntil, now + pauseMs);
    this.#ctx.limiter.pause(OPEN_METEO_HOST, pauseMs);
    return pauseMs;
  }
}

/* ------------------------------------------------------------------ join */

export interface JoinTiming {
  /** Parts per group: `count: "8"`. */
  readonly count: number;
  /** Milliseconds from a group's first part until it is emitted regardless. */
  readonly timeoutMs: number;
}

/** Why a group was emitted. */
export type JoinClose =
  /** `count` parts arrived — the normal case. */
  | "complete"
  /** The timeout fired first: a PARTIAL group, as the old join emitted it. */
  | "timeout"
  /** Nothing more can arrive (see the deviation in the module comment). */
  | "drained";

export interface JoinGroup<P> {
  /** In arrival order, as the join node built its array. */
  readonly parts: readonly P[];
  readonly closedBy: JoinClose;
  /** 0 for the first group of a run; a later one carries late arrivals. */
  readonly sequence: number;
}

export interface JoinSummary {
  readonly groups: number;
  /** Groups emitted by the timeout, i.e. partial ones. */
  readonly timedOut: number;
  /** Parts dropped because the run was aborted (shutdown) before emitting them. */
  readonly abandoned: number;
}

/**
 * The join node over a set of in-flight batch requests.
 *
 * `tasks` must not reject — a failed request is a part too (see the module
 * comment); a rejection is nevertheless treated as a part that never arrives,
 * and the run's error is reported once every group has been handled.
 * `onGroup` runs once per emitted group, one after the other, while later
 * batches may still be in flight — as the build node ran on the first group
 * while the join collected the next.
 *
 * On `signal` abort the open group is dropped, as Node-RED's join drops its
 * in-flight groups on close, and the promise settles once the groups already
 * emitted are handled.
 */
export async function joinGroups<P>(
  tasks: readonly Promise<P>[],
  timing: JoinTiming,
  signal: AbortSignal,
  onGroup: (group: JoinGroup<P>) => Promise<void>,
): Promise<JoinSummary> {
  let outstanding = tasks.length;
  let open: P[] | null = null;
  let timer: NodeJS.Timeout | undefined;
  let groups = 0;
  let timedOut = 0;
  let abandoned = 0;
  let finished = false;
  const errors: unknown[] = [];
  let handled: Promise<void> = Promise.resolve();

  let settle: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const emit = (closedBy: JoinClose): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const parts = open;
    open = null;
    if (parts === null) return;
    if (closedBy === "timeout") timedOut += 1;
    const group: JoinGroup<P> = { parts, closedBy, sequence: groups };
    groups += 1;
    // `handled` never rejects (the catch below), so one failed group cannot keep
    // the next from being written — they were separate messages in the flow.
    handled = handled
      .then(() => onGroup(group))
      .catch((error: unknown) => {
        errors.push(error);
      });
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    signal.removeEventListener("abort", onAbort);
    settle();
  };

  function onAbort(): void {
    abandoned += open === null ? 0 : open.length;
    open = null;
    finish();
  }

  const arrive = (part: P | undefined): void => {
    if (finished) {
      // Aborted: the run is over, a straggler goes nowhere.
      if (part !== undefined) abandoned += 1;
      return;
    }
    outstanding -= 1;
    if (part !== undefined) {
      if (open === null) {
        open = [];
        // Not unref'd: while a group is open, the run is waiting for it.
        timer = setTimeout(() => {
          emit("timeout");
        }, timing.timeoutMs);
      }
      open.push(part);
      if (open.length >= timing.count) emit("complete");
    }
    if (outstanding === 0) {
      emit("drained");
      finish();
    }
  };

  if (signal.aborted || tasks.length === 0) {
    finish();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
    for (const task of tasks) {
      task.then(
        (part) => {
          arrive(part);
        },
        (error: unknown) => {
          errors.push(error);
          arrive(undefined);
        },
      );
    }
  }

  await done;
  await handled;
  if (errors.length > 0) {
    const first: unknown = errors[0];
    throw first instanceof Error ? first : new Error(String(first));
  }
  return { groups, timedOut, abandoned };
}
