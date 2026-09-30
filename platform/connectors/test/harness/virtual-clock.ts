/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Simulated time for the rate limiter and the scheduler ({@link LimiterClock}):
 * timers fire in order of their due time once everything else has settled,
 * so a test of hours runs in milliseconds. `earlyMs` makes every timer of a
 * minute or more fire that much before its due time, as a long timer can
 * against the wall clock (a short one is on time).
 */

import type { ClockTimer, LimiterClock } from "../../src/kernel/rate-limit.js";

interface Pending {
  readonly at: number;
  readonly earlyMs: number;
  readonly seq: number;
  readonly task: () => void;
  cancelled: boolean;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

export class VirtualClock implements LimiterClock {
  time: number;
  readonly #earlyMs: number;
  #pending: Pending[] = [];
  #seq = 0;

  constructor(start: number, earlyMs = 0) {
    this.time = start;
    this.#earlyMs = earlyMs;
  }

  now(): number {
    return this.time;
  }

  setTimeout(task: () => void, ms: number): ClockTimer {
    const pending: Pending = {
      at: this.time + Math.max(0, ms),
      earlyMs: ms >= 60_000 ? this.#earlyMs : 0,
      seq: this.#seq,
      task,
      cancelled: false,
    };
    this.#seq += 1;
    this.#pending.push(pending);
    return {
      unref: () => undefined,
      cancel: () => {
        pending.cancelled = true;
      },
    };
  }

  #next(until: number): Pending | undefined {
    this.#pending = this.#pending.filter((timer) => !timer.cancelled);
    this.#pending.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = this.#pending[0];
    if (next === undefined || next.at > until) return undefined;
    this.#pending.shift();
    return next;
  }

  #fire(next: Pending): void {
    this.time = Math.max(this.time, next.at - next.earlyMs);
    next.task();
  }

  /** Runs `work` to its end, jumping from one timer to the next. */
  async run(work: Promise<unknown>): Promise<void> {
    const outcome: { done: boolean; failed: boolean; error: unknown } = {
      done: false,
      failed: false,
      error: null,
    };
    void work.then(
      () => {
        outcome.done = true;
      },
      (error: unknown) => {
        outcome.done = true;
        outcome.failed = true;
        outcome.error = error;
      },
    );
    for (;;) {
      await settle();
      if (outcome.done) break;
      const next = this.#next(Number.POSITIVE_INFINITY);
      if (next === undefined) throw new Error("simulation stalled: the work waits for nothing");
      this.#fire(next);
    }
    if (outcome.failed) throw outcome.error;
  }

  /** Fires every timer due until `until`, then sets the time to it. */
  async advanceTo(until: number): Promise<void> {
    for (;;) {
      await settle();
      const next = this.#next(until);
      if (next === undefined) break;
      this.#fire(next);
    }
    this.time = Math.max(this.time, until);
    await settle();
  }
}
