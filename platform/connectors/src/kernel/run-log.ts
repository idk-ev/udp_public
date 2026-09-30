/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The last completed run of a connector, persisted — what lets a restart
 * leave out the start run of a connector that ran shortly before
 * (`refireOnRestart: false`, src/kernel/scheduler.ts).
 *
 * Recorded by `runConnector` (src/kernel/context.ts) once `run` returned
 * without throwing, as the START time of that run. A run that only warned
 * (a source down, a budget used up) counts: it asked the source, and asking
 * again right after a restart is what this prevents. Best effort
 * (src/kernel/state.ts): an unreachable database only costs the start run
 * that would have been left out.
 */

import { stateKey } from "./state.js";
import type { ConnectorState, StateCodec } from "./types.js";

const codec: StateCodec<number | null> = {
  encode: (value) => (value !== null && Number.isFinite(value) ? value : null),
  decode: (raw) => (raw === null ? null : typeof raw === "number" && Number.isFinite(raw) ? raw : undefined),
};

const LAST_RUN = stateKey<number | null>("kernel.lastRunMs", () => null, codec, { bestEffort: true });

export function recordRun(state: ConnectorState, startedMs: number): void {
  state.slot(LAST_RUN).set(startedMs);
}

/** Start of the last completed run in ms since the epoch, `null` if none is known. */
export function lastRunOf(state: ConnectorState): number | null {
  return state.slot(LAST_RUN).get();
}
