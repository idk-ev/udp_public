/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The admin port: `GET /healthz` and `POST /trigger/:id`, and nothing else.
 *
 * ## Why a port of its own
 *
 * The public port (UDP_CONNECTORS_PORT, 1880) is what the cockpit's nginx
 * proxies to for `/abfahrten` and `/warnungen.ics` — it faces the internet.
 * `/trigger/:id` makes the service fetch a source and write to Orion; exposed
 * there, anyone could make it hammer a provider or burn the TRoE budget. So
 * the trigger lives on a separate port that no proxy knows about: a request to
 * `/trigger` on the public port is a plain 404.
 *
 * UDP_CONNECTORS_ADMIN_PORT (default 1881) and UDP_CONNECTORS_ADMIN_HOST
 * (default 0.0.0.0, so container health probes and `kubectl exec` reach it).
 * This port must NEVER be mapped by nginx, APISIX or an ingress. In Compose it
 * must not be published on the host except on 127.0.0.1 (phase 5), and
 * `scripts/trigger-connector.sh` has to target it when it is rewired.
 *
 * ## Cooldown
 *
 * A trigger is an operator's "run it now". A second one within the cooldown
 * (UDP_TRIGGER_COOLDOWN_SECONDS, default 60) or while a run is still active
 * answers 429 with the reason and a `Retry-After`, instead of starting another
 * run against the same source. That is logged at info level — a refused
 * trigger is not a fault of the service. The cooldown cannot be switched off:
 * below {@link MIN_TRIGGER_COOLDOWN_SECONDS} it is raised to it, and 0, a
 * negative value or NaN fall back to the default ({@link triggerCooldownMs}).
 *
 * ## Loopback only (decided with the security review)
 *
 * The port listens on all interfaces so that probes reach `/healthz`. The
 * trigger answers only a TCP peer on loopback (`127.0.0.1`, `::1`,
 * `::ffff:127.0.0.1`) — the peer address of the socket, never a forwarded
 * header — and everything else with 403, logged at info level: a refused
 * stranger is not a fault of the service either. `scripts/trigger-connector.sh`
 * runs it inside the container (`docker exec` / `kubectl exec`, phase 5).
 * The route reads no request body; one that is sent anyway stays unread.
 */

import { jsonResponse, textResponse } from "./http.js";
import type { Kernel } from "./context.js";
import { geoHealth } from "./geo-bootstrap.js";
import type { Env, RouteDefinition, RouteResponse } from "./types.js";

export const DEFAULT_ADMIN_PORT = 1881;
export const DEFAULT_ADMIN_HOST = "0.0.0.0";
export const DEFAULT_TRIGGER_COOLDOWN_SECONDS = 60;

/** The cooldown cannot be set below this. */
export const MIN_TRIGGER_COOLDOWN_SECONDS = 60;

/**
 * `UDP_TRIGGER_COOLDOWN_SECONDS` in milliseconds: at least
 * {@link MIN_TRIGGER_COOLDOWN_SECONDS}; 0, negative or not a number is the
 * default.
 */
export function triggerCooldownMs(env: Env): number {
  const seconds = env.number("UDP_TRIGGER_COOLDOWN_SECONDS", DEFAULT_TRIGGER_COOLDOWN_SECONDS);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TRIGGER_COOLDOWN_SECONDS * 1000;
  return Math.max(MIN_TRIGGER_COOLDOWN_SECONDS, seconds) * 1000;
}

/** Peer addresses the trigger answers: loopback, in the three spellings Node reports. */
const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Whether a TCP peer address is loopback. `undefined` (unknown) is not. */
export function isLoopback(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK.has(address);
}

export interface AdminOptions {
  readonly version: string;
  /** `Date.now()` at start, for the uptime. */
  readonly started: number;
  readonly cooldownMs: number;
}

/**
 * `GET /healthz` — liveness plus what is actually scheduled, the state
 * store (`stateStore.healthy`: writer lock held, no load or write failing,
 * every connector loaded or queued in the running reload; `reason` when not;
 * `blockedPrunes`: prunes their share cap skipped, with the consecutive
 * skips) and the geo context (`geo`: municipality rows, polygons,
 * degraded, and per file the geo bootstrap's last load and error). Neither
 * turns the answer into an error: restarting the process would not fix the
 * database or the cockpit, only repeat the load.
 */
function healthRoute(kernel: Kernel, options: AdminOptions): RouteDefinition {
  return {
    method: "GET",
    path: "/healthz",
    handle(): Promise<RouteResponse> {
      return Promise.resolve(
        jsonResponse(200, {
          status: "ok",
          version: options.version,
          uptimeSeconds: Math.round((kernel.nowMs() - options.started) / 1000),
          connectors: kernel.scheduler.jobs().map((job) => ({
            id: job.id,
            kind: job.schedule.kind,
            intervalSeconds: job.schedule.intervalSeconds,
            cron: job.schedule.cron,
            startupDelaySeconds: job.schedule.startupDelaySeconds,
          })),
          stateStore: kernel.persistence?.health() ?? null,
          geo: geoHealth(kernel.geo, kernel.geoBootstrap),
        }),
      );
    },
  };
}

/**
 * `POST /trigger/:id` — what `scripts/trigger-connector.sh` calls. Answers
 * immediately; the run happens in the background.
 */
function triggerRoute(kernel: Kernel, options: AdminOptions): RouteDefinition {
  return {
    method: "POST",
    path: "/trigger/:id",
    handle(request): Promise<RouteResponse> {
      const id = request.params.id ?? "";
      if (!isLoopback(request.remoteAddress)) {
        // info, not warn: whoever can reach the port can produce this line.
        kernel.log.info(`${id}: trigger refused, peer ${request.remoteAddress ?? "unknown"} is not loopback`);
        return Promise.resolve(
          textResponse(403, "trigger only from loopback (docker exec / kubectl exec)\n"),
        );
      }
      const result = kernel.scheduler.trigger(id, options.cooldownMs);
      switch (result.outcome) {
        case "started":
          kernel.log.info(`${id}: triggered via POST /trigger/${id}`);
          return Promise.resolve(jsonResponse(202, { id, triggered: true }));
        case "running":
          kernel.log.info(`${id}: trigger refused, a run is still active`);
          return Promise.resolve({
            ...jsonResponse(429, { id, triggered: false, reason: "a run of this connector is still active" }),
            headers: { "Retry-After": String(Math.ceil(options.cooldownMs / 1000)) },
          });
        case "cooldown":
          kernel.log.info(`${id}: trigger refused, cooldown (${String(result.retryAfterSeconds)} s left)`);
          return Promise.resolve({
            ...jsonResponse(429, {
              id,
              triggered: false,
              reason: `triggered less than ${String(Math.round(options.cooldownMs / 1000))} s ago`,
              retryAfterSeconds: result.retryAfterSeconds,
            }),
            headers: { "Retry-After": String(result.retryAfterSeconds) },
          });
        case "unknown": {
          const known = kernel.registry.byId(id);
          const reason =
            known === undefined
              ? `unknown connector "${id}"`
              : `connector "${id}" is not scheduled here (${known.active ? "no module implemented" : "inactive in the registry"})`;
          return Promise.resolve(textResponse(404, `${reason}\n`));
        }
      }
    },
  };
}

export function adminRoutes(kernel: Kernel, options: AdminOptions): readonly RouteDefinition[] {
  return [healthRoute(kernel, options), triggerRoute(kernel, options)];
}
