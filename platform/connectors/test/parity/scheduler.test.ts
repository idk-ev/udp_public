/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Startup order of the scheduler. A connector that serves a public endpoint
 * starts right away: in the stagger, abfahrten-on-demand came last and
 * /abfahrten answered 503 for five minutes after every restart (seen live).
 * refireOnRestart: false still wins — it protects rate-limited sources.
 */

import assert from "node:assert/strict";

import { connector as abfahrtenOnDemand } from "../../src/connectors/abfahrten-on-demand.js";
import { connector as warnungenBw } from "../../src/connectors/warnungen-bw.js";
import { connector as pegelBw } from "../../src/connectors/pegel-bw.js";
import {
  DEFAULT_STARTUP_DELAY_SECONDS,
  DEFAULT_STARTUP_STEP_SECONDS,
  MAX_STARTUP_DELAY_SECONDS,
  RESTART_DELAY_SECONDS,
  ROUTE_STARTUP_DELAY_SECONDS,
  scheduleOf,
} from "../../src/kernel/scheduler.js";
import { registryEntry } from "../harness/g-transport.js";

function routeConnectorsStartFirst(): void {
  // The real modules decide, not a flag in the test: both endpoint connectors
  // expose routes, a plain ingestion connector does not.
  assert.notEqual(abfahrtenOnDemand.routes, undefined);
  assert.notEqual(warnungenBw.routes, undefined);
  assert.equal(pegelBw.routes, undefined);

  const late = 20;
  const endpoint = scheduleOf(registryEntry("abfahrten-on-demand"), late, true);
  assert.equal(endpoint.startupDelaySeconds, ROUTE_STARTUP_DELAY_SECONDS);

  const plain = scheduleOf(registryEntry("pegel-bw"), late, false);
  assert.equal(
    plain.startupDelaySeconds,
    Math.min(DEFAULT_STARTUP_DELAY_SECONDS + late * DEFAULT_STARTUP_STEP_SECONDS, MAX_STARTUP_DELAY_SECONDS),
  );
}

function refireOnRestartFalseStillWins(): void {
  const guarded = scheduleOf(registryEntry("pegel-bw", { refireOnRestart: false }), 0, true);
  assert.equal(guarded.startupDelaySeconds, RESTART_DELAY_SECONDS);
}

export {
  routeConnectorsStartFirst as "scheduler: connectors serving public endpoints start right away, not in the stagger",
  refireOnRestartFalseStillWins as "scheduler: refireOnRestart false keeps its 600 s delay even for an endpoint connector",
};
