/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Access to the process environment — the replacement for Node-RED's
 * `env.get('HYSTREET_API_TOKEN')` / `env.get('TROE_DB_PASSWORD')`.
 *
 * `require` throws instead of ingesting against a half-configured target. In the
 * flows a missing secret produced an empty string and the connector then ran
 * into an authentication error at the source, which reads like a provider
 * outage in the log. The registry field `requiresSecret` names the variable, so
 * the miss can be reported with the connector's name attached.
 */

import type { Env } from "./types.js";

/**
 * Base URL of the cockpit, which serves the project's own static data files
 * (`bw-gemeinden.json`, `bw-grenzen.json`, `oepnv-halte.json`, …) to six
 * connectors. Port 8080, as `COCKPIT` in the generator: the cockpit's nginx is
 * unprivileged and listens there only; Compose has no port mapping between
 * containers, and the Helm Service exposes 8080 as well. The flows' former
 * `http://cockpit/` reached nothing in Compose.
 */
export const COCKPIT_URL = "http://cockpit:8080";

class ProcessEnv implements Env {
  get(name: string): string | undefined {
    const value = process.env[name];
    // An empty variable is the same as an unset one here: docker-compose passes
    // `HYSTREET_API_TOKEN: ${HYSTREET_API_TOKEN:-}` through as "" when the .env
    // does not set it, and the flow's guard treated that as "not configured".
    return value === undefined || value === "" ? undefined : value;
  }

  require(name: string): string {
    const value = this.get(name);
    if (value === undefined) throw new Error(`environment variable ${name} is not set`);
    return value;
  }

  number(name: string, fallback: number): number {
    const raw = this.get(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  flag(name: string, fallback: boolean): boolean {
    const raw = this.get(name);
    if (raw === undefined) return fallback;
    const value = raw.trim().toLowerCase();
    if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
    if (value === "0" || value === "false" || value === "no" || value === "off") return false;
    return fallback;
  }
}

export function createEnv(): Env {
  return new ProcessEnv();
}
