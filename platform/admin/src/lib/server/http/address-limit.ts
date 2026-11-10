/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * A small limit per client address, in memory and per process, in front of anything
 * that writes to the database. It keeps one address from filling the throttle table
 * and the audit log with attempts under ever new names. Fixed window; the oldest
 * entries make way when the table is full, so its memory stays bounded.
 */
export class AddressLimit {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, maxEntries: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  allow(address: string): boolean {
    const now = this.now();
    const current = this.windows.get(address);
    if (current !== undefined && now - current.startedAt < this.windowMs) {
      current.count += 1;
      return current.count <= this.limit;
    }
    // Re-inserted, so that the Map's order stays oldest first.
    this.windows.delete(address);
    if (this.windows.size >= this.maxEntries) {
      const [oldest] = this.windows.keys();
      if (oldest !== undefined) this.windows.delete(oldest);
    }
    this.windows.set(address, { startedAt: now, count: 1 });
    return true;
  }
}

/** Generous for a person, also for several behind one office address. */
export const LOGIN_ADDRESS_LIMIT = new AddressLimit(20, 60_000, 10_000);
