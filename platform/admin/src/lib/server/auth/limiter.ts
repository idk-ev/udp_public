/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/** Too many password operations are running or waiting. */
export class BusyError extends Error {
  constructor() {
    super("password hashing is busy");
    this.name = "BusyError";
  }
}

/**
 * Bounds concurrent work and the queue in front of it. Each Argon2 run takes its
 * full memory cost, so without this a flood of login attempts would exhaust the
 * container's memory limit. Beyond the queue a request fails fast.
 */
export class Limiter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly concurrency: number;
  private readonly maxWaiting: number;

  constructor(concurrency: number, maxWaiting: number) {
    this.concurrency = concurrency;
    this.maxWaiting = maxWaiting;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      if (this.waiting.length >= this.maxWaiting) throw new BusyError();
      // The finishing task hands its slot over, so "running" stays as it is.
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    } else {
      this.running += 1;
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.running -= 1;
      else next();
    }
  }
}
