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
 * trigger is not a fault of the service.
 */

import { jsonResponse, textResponse } from "./http.js";
import type { Kernel } from "./context.js";
import { runtimeOf } from "./registry.js";
import type { RouteDefinition, RouteResponse } from "./types.js";

export const DEFAULT_ADMIN_PORT = 1881;
export const DEFAULT_ADMIN_HOST = "0.0.0.0";
export const DEFAULT_TRIGGER_COOLDOWN_SECONDS = 60;

export interface AdminOptions {
  readonly version: string;
  /** `Date.now()` at start, for the uptime. */
  readonly started: number;
  readonly cooldownMs: number;
}

/** `GET /healthz` — liveness plus what is actually scheduled. */
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
        }),
      );
    },
  };
}

/**
 * `POST /trigger/:id` — the replacement for `scripts/trigger-connector.sh`'s
 * detour over `nodePrefixes` and the Node-RED admin API. Answers immediately;
 * the run happens in the background, as posting to an inject node did.
 */
function triggerRoute(kernel: Kernel, options: AdminOptions): RouteDefinition {
  return {
    method: "POST",
    path: "/trigger/:id",
    handle(request): Promise<RouteResponse> {
      const id = request.params.id ?? "";
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
              : `connector "${id}" is not scheduled here (runtime: ${runtimeOf(known)}, active: ${String(known.active)})`;
          return Promise.resolve(textResponse(404, `${reason}\n`));
        }
      }
    },
  };
}

export function adminRoutes(kernel: Kernel, options: AdminOptions): readonly RouteDefinition[] {
  return [healthRoute(kernel, options), triggerRoute(kernel, options)];
}
