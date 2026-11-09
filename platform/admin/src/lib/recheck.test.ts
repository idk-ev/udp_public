/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRecheck } from "./recheck.ts";

describe("recheck timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps checking while the answer stays the same: not just once", () => {
    const check = vi.fn();
    const stop = startRecheck(check, 15_000);
    expect(check).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(check).toHaveBeenCalledTimes(4);
    stop();
  });

  it("does nothing more once stopped, which is what leaving the page does", () => {
    const check = vi.fn();
    const stop = startRecheck(check, 15_000);
    vi.advanceTimersByTime(15_000);
    stop();
    vi.advanceTimersByTime(600_000);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
