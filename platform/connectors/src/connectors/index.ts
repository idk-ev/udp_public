/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The ported connectors, by registry id.
 *
 * Phase 1 brings the two that fill the geo context. The remaining 27 arrive in
 * phase 3 and are added here — one line each; nothing else in the service needs
 * to know about them, because scheduling, triggering and cadence all come from
 * platform/config/connectors.json.
 *
 * A connector listed here does not run yet on that account. It runs when its
 * registry entry says `"runtime": "app"`, which is the cutover in phase 4.
 */

import { connector as grenzenBw } from "./grenzen-bw.js";
import { connector as stammdatenBw } from "./stammdaten-bw.js";
import type { ConnectorId, ConnectorRunner } from "../kernel/types.js";

const MODULES: readonly ConnectorRunner[] = [stammdatenBw, grenzenBw];

export const CONNECTORS: ReadonlyMap<ConnectorId, ConnectorRunner> = new Map(
  MODULES.map((module) => [module.id, module]),
);
