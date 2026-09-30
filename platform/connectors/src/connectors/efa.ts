/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The EFA-BW departure monitor (`XML_DM_REQUEST`, rapidJSON) — what
 * `efa-abfahrten` and `abfahrten-on-demand` share: the endpoint, the request
 * profile towards the provider, and the narrowing of its answer.
 *
 * ## Request profile towards EFA-BW
 *
 * Old flows, measured from their node settings:
 *
 *  * `efa-abfahrten`: 23 inject nodes, all `once: true, onceDelay: 15,
 *    repeat: 300`, each wired straight into its own `http request` node — no
 *    delay node, no retry. All 23 fire in the same tick, so every five minutes
 *    EFA-BW saw a burst of **23 simultaneous requests** (average 23 / 300 s ≈
 *    0.08 requests per second).
 *  * `abfahrten-on-demand`: one unpaced request per cache miss of the cockpit
 *    nginx (`location = /abfahrten`, 60 s for 200, 30 s for 404/502/503,
 *    `proxy_cache_lock on`), i.e. bounded by distinct municipalities viewed.
 *
 * New: every EFA request goes through `ctx.fetch` and therefore through the
 * SHARED token bucket of the host `www.efa-bw.de` ({@link EFA_MIN_INTERVAL_MS}:
 * at most one request start per 500 ms, burst 1), and `efa-abfahrten` keeps at
 * most {@link EFA_CONCURRENCY} requests in flight. A run of 23 stops thus
 * takes at least ~11 s instead of arriving as one burst; the average rate is
 * unchanged, the peak drops from 23 at once to 2 per second. No retries on
 * either path (`retries: 0`), as the http request nodes had none.
 *
 * The cap is deliberately small for a second reason: the on-demand endpoint
 * queues in the same bucket. With at most two waiters from the periodic run, a
 * dashboard request waits about a second behind it, not the ~11 s a fully
 * queued run would cost. The reverse holds as well: the endpoint keeps its own
 * small queue in front of the bucket and never holds more than two places in
 * it, so public traffic cannot fill the bucket's queue and starve the
 * periodic run (see abfahrten-on-demand.ts).
 */

import { field, isArray, isRecord, isString, isTruthy, ParseError, path } from "../kernel/parse.js";
import { scalar } from "./http-payload.js";
import type { Scalar } from "./http-payload.js";

/** Departure monitor endpoint of the EFA-BW journey planner (NVBW). */
export const EFA_DM_URL = "https://www.efa-bw.de/nvbw/XML_DM_REQUEST";

/** An EFA time (ISO, UTC) as the wall-clock time in Berlin, `HH:MM`. */
export function berlinClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("de-DE", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Minimum spacing of request starts towards `www.efa-bw.de`, shared by both
 * connectors through the kernel's per-host token bucket. 500 ms rather than the
 * kernel default of 1000 ms: the on-demand endpoint answers a person waiting
 * for a dashboard, and the old profile allowed far more (see above).
 */
export const EFA_MIN_INTERVAL_MS = 500;

/** Requests of one `efa-abfahrten` run in flight at once (the old flows: 23). */
export const EFA_CONCURRENCY = 2;

/**
 * One stop event, reduced to what the two old function nodes read. Values are
 * kept close to the source (truthiness is decided at the point of use, as the
 * old `a || b` chains did).
 */
export interface StopEvent {
  /** `ev.isCancelled`, by truthiness. Read by `efa-abfahrten` only. */
  readonly cancelled: boolean;
  /** `departureTimePlanned`, ISO text. */
  readonly planned: string | undefined;
  /** `departureTimeEstimated`, ISO text; only present with real-time data. */
  readonly estimated: string | undefined;
  /** `isRealtimeControlled === true`. */
  readonly realtimeControlled: boolean;
  /** `transportation.number`. */
  readonly lineNumber: Scalar | undefined;
  /** `transportation.name`. */
  readonly lineName: Scalar | undefined;
  /** `transportation.destination.name`. */
  readonly destination: Scalar | undefined;
  /** `location.properties.platform`. */
  readonly platform: Scalar | undefined;
}

export interface DepartureMonitor {
  readonly stopEvents: readonly StopEvent[];
}

/**
 * Deviation for malformed data only: a time that is not a string counts as
 * absent (the old nodes would have handed a number to `new Date()` or crashed
 * on `.slice`), and a stop event that is not an object is skipped (the old
 * nodes threw a TypeError on it and, in the endpoint, never answered).
 */
function parseEvent(raw: unknown): StopEvent | null {
  if (!isRecord(raw)) return null;
  const transportation = raw.transportation;
  return {
    cancelled: isTruthy(raw.isCancelled),
    planned: isString(raw.departureTimePlanned) ? raw.departureTimePlanned : undefined,
    estimated: isString(raw.departureTimeEstimated) ? raw.departureTimeEstimated : undefined,
    realtimeControlled: raw.isRealtimeControlled === true,
    lineNumber: scalar(field(transportation, "number")),
    lineName: scalar(field(transportation, "name")),
    destination: scalar(path(transportation, "destination", "name")),
    platform: scalar(path(raw, "location", "properties", "platform")),
  };
}

/**
 * `!msg.payload || !Array.isArray(msg.payload.stopEvents)` of both old nodes,
 * as a narrowing that gets loud: a {@link ParseError} is the "no departures"
 * warning resp. the 502 of the endpoint.
 */
export function parseDepartureMonitor(payload: unknown): DepartureMonitor {
  const events = field(payload, "stopEvents");
  if (!isArray(events)) throw new ParseError("payload.stopEvents", "array", events);
  const stopEvents: StopEvent[] = [];
  for (const event of events) {
    const parsed = parseEvent(event);
    if (parsed !== null) stopEvents.push(parsed);
  }
  return { stopEvents };
}

/** EFA-BW's system message code for "no serving lines found". */
export const NO_DEPARTURES_CODE = -4050;

/**
 * Whether `payload` is a valid departure monitor answer for `stopId` that
 * lists no departure (late at night, a stop served only on weekdays). As
 * recorded from EFA-BW, such an answer has no `stopEvents`, at most the error
 * message {@link NO_DEPARTURES_CODE}, and the requested stop itself under
 * `locations` (`type: "stop"`, `isBest: true`, its id, or a platform of it).
 *
 * Not "no departures", stays a 502: an unknown or removed stop (EFA answers
 * with fuzzy candidates, `isBest: false`, other ids), any other error message
 * (e.g. "invalid date" with the stop resolved), anything without `version`.
 */
export function isEmptyDepartureMonitor(payload: unknown, stopId: string): boolean {
  if (!isRecord(payload) || !isString(payload.version) || payload.stopEvents !== undefined) return false;
  const messages = payload.systemMessages ?? [];
  if (!isArray(messages)) return false;
  const otherError = messages.some(
    (message) => isRecord(message) && message.type === "error" && message.code !== NO_DEPARTURES_CODE,
  );
  if (otherError) return false;
  const locations = payload.locations;
  return (
    isArray(locations) &&
    locations.some(
      (location) =>
        isRecord(location) &&
        location.type === "stop" &&
        location.isBest === true &&
        isString(location.id) &&
        (location.id === stopId || location.id.startsWith(`${stopId}:`)),
    )
  );
}

/**
 * Runs `task` over `items` with at most `limit` tasks in flight; results in
 * the order of `items`. Once `signal` is aborted no further task starts, and
 * the items not started yield `null`.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<(R | null)[]> {
  const results: (R | null)[] = items.map(() => null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && signal?.aborted !== true) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await task(item);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
