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
 *  * **Pacing.** One Open-Meteo call per 15 s, through the kernel's token bucket
 *    (`ctx.fetch` acquires it from `ctx.limiter` with {@link REQUEST_INTERVAL_MS}).
 *    Open-Meteo answered HTTP 429 on 21.07. after a series of restarts; the pace
 *    is what keeps a normal run far away from that. The bucket is keyed by host,
 *    so the two connectors now share one 15 s pace where each had its own delay
 *    node — strictly more polite, never less (see src/kernel/rate-limit.ts).
 *  * **Request timeout and retries.** The `http request` node waited 120 s
 *    (Node-RED's default `httpRequestTimeout`) and never retried. A retry here
 *    would be a second 140-location call against the provider that already sent
 *    a 429, so the port keeps 120 s and zero retries.
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
 *  * The join window is 375 s instead of 240 s ({@link joinTimingFor}): the
 *    shared 15 s bucket must not be able to turn a group that is only waiting
 *    its turn into a partial one.
 */

import { field, isArray, isTruthy, requireNumber } from "../kernel/parse.js";
import type { Ags, Ctx, MunicipalityRow } from "../kernel/types.js";
import { DEFAULT_URL as MUNICIPALITIES_URL, parse as parseMunicipalities } from "./stammdaten-bw.js";

/** `const N = 8` of both batch nodes. */
export const BATCH_COUNT = 8;

export const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

/** The delay node "1 Anfrage/15s" in front of the `http request` node. */
export const REQUEST_INTERVAL_MS = 15_000;

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
  /** Longest a request can take before it settles (no retry). */
  readonly requestTimeoutMs: number;
  /** Connectors sharing the bucket, each with at most {@link BATCH_COUNT} calls per run. */
  readonly sharers: number;
  readonly marginMs: number;
}

export const OPEN_METEO_PACE: BucketPace = {
  intervalMs: REQUEST_INTERVAL_MS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  sharers: SHARED_BUCKET_CONNECTORS,
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
 * first and may take the full request timeout: (7 + 8) × 15 s + 120 s = 345 s,
 * with margin 375 s. Anything shorter could cut a group that is merely waiting
 * its turn into a spurious partial result.
 */
export function joinWindowMs(batchCount: number, pace: BucketPace = OPEN_METEO_PACE): number {
  const startsAfterFirst = Math.max(0, batchCount - 1) + BATCH_COUNT * Math.max(0, pace.sharers - 1);
  return startsAfterFirst * pace.intervalMs + pace.requestTimeoutMs + pace.marginMs;
}

/** The join of one run: `count: 8` as the node, the window of {@link joinWindowMs}, never below 240 s. */
export function joinTimingFor(batchCount: number): JoinTiming {
  return { count: BATCH_COUNT, timeoutMs: Math.max(JOIN_TIMEOUT_MS, joinWindowMs(batchCount)) };
}

/** Upsert chunk size of both build nodes: `emitChunks(node, msg, entities, 100)`. */
export const UPSERT_CHUNK_SIZE = 100;

/**
 * `g.slice(i * size, (i + 1) * size)` for `i < 8` with `size = ceil(n / 8)`,
 * skipping empty slices (`if (!part.length) continue;`) — with fewer than 8
 * municipalities, or a count that leaves the tail empty, there are fewer
 * batches than 8.
 */
export function sliceBatches(rows: readonly MunicipalityRow[]): readonly (readonly MunicipalityRow[])[] {
  const size = Math.ceil(rows.length / BATCH_COUNT);
  const out: (readonly MunicipalityRow[])[] = [];
  for (let i = 0; i < BATCH_COUNT; i += 1) {
    const part = rows.slice(i * size, (i + 1) * size);
    if (part.length === 0) continue;
    out.push(part);
  }
  return out;
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

/** One batch as the wrap node saw it: the parsed body, or `null` for a failed call. */
export type BatchBody = { readonly ok: true; readonly body: unknown } | { readonly ok: false };

/**
 * One paced Open-Meteo call — delay node, `http request` node and the failure
 * branch of the wrap node. Never throws: a failed call is a (empty) part for the
 * join, exactly as in the flow.
 */
export async function fetchBatch(ctx: Ctx, url: string): Promise<BatchBody> {
  try {
    const response = await ctx.fetch.json(url, {
      minIntervalMs: REQUEST_INTERVAL_MS,
      timeoutMs: REQUEST_TIMEOUT_MS,
      retries: 0,
    });
    if (!response.ok || !isTruthy(response.body)) {
      // Wrap node: `if (msg.statusCode >= 400 || !msg.payload)`.
      ctx.log.warn(`Open-Meteo batch failed (HTTP ${String(response.status)})`);
      return { ok: false };
    }
    return { ok: true, body: response.body };
  } catch (error) {
    // The `http request` node reported a timeout or network error with
    // node.error and still passed the message on (`senderr: false`); the wrap
    // node then carried the error text as the only "location", which the build
    // node skipped. Same effect: an empty part.
    ctx.log.error("Open-Meteo batch failed", error);
    return { ok: false };
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
