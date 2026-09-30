/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * When the writer lock counts as lost (src/kernel/persistence-pg.ts,
 * `checkLock`): only when that is certain. A lock check that fails or takes
 * long used to count as a lost lock, and taking it "again" ended the very
 * session that still held it — right after every start.
 */

import assert from "node:assert/strict";

import { checkLock } from "../../src/kernel/persistence-pg.js";
import type { LockProbe } from "../../src/kernel/persistence-pg.js";

interface Script {
  open?: boolean;
  probe: boolean;
  verify?: (boolean | null)[];
  /** The connection closes during the check (after the probe). */
  closesAfterProbe?: boolean;
}

function scripted(script: Script): { probe: LockProbe; calls: string[] } {
  const calls: string[] = [];
  let open = script.open ?? true;
  const answers = [...(script.verify ?? [])];
  return {
    calls,
    probe: {
      open: () => open,
      probe: () => {
        calls.push("probe");
        if (script.closesAfterProbe === true) open = false;
        return Promise.resolve(script.probe);
      },
      verify: () => {
        calls.push("verify");
        return Promise.resolve(answers.shift() ?? null);
      },
      pause: (ms) => {
        calls.push(`pause ${String(ms)}`);
        return Promise.resolve();
      },
    },
  };
}

export async function answeringProbeIsHeld(): Promise<void> {
  const { probe, calls } = scripted({ probe: true });
  assert.equal(await checkLock(probe), "held");
  assert.deepEqual(calls, ["probe"], "no second session when the probe answers");
}

/** The false trigger: a probe that did not answer in time, while the database still lists our session. */
export async function slowProbeWithOurSessionInPgLocksIsHeld(): Promise<void> {
  const { probe, calls } = scripted({ probe: false, verify: [true] });
  assert.equal(await checkLock(probe), "held");
  assert.deepEqual(calls, ["probe", "verify"]);
}

export async function pgLocksWithoutOurSessionIsLost(): Promise<void> {
  const { probe } = scripted({ probe: false, verify: [false] });
  assert.equal(await checkLock(probe), "lost");
}

export async function unanswerableCheckIsRetriedThenUnknown(): Promise<void> {
  const { probe, calls } = scripted({ probe: false, verify: [null, null, null] });
  assert.equal(await checkLock(probe, 3, 2000), "unknown", "neither held nor lost: the lock is kept");
  assert.deepEqual(calls, ["probe", "verify", "pause 2000", "verify", "pause 2000", "verify"]);
}

export async function secondAttemptAnswers(): Promise<void> {
  const { probe } = scripted({ probe: false, verify: [null, true] });
  assert.equal(await checkLock(probe), "held");
}

export async function closedConnectionIsLost(): Promise<void> {
  const closed = scripted({ open: false, probe: true });
  assert.equal(await checkLock(closed.probe), "lost");
  assert.deepEqual(closed.calls, [], "a closed connection needs no question");

  const closing = scripted({ probe: false, closesAfterProbe: true, verify: [true] });
  assert.equal(await checkLock(closing.probe), "lost", "the session went with its connection");
}
