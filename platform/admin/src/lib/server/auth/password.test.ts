/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { describe, expect, it } from "vitest";
import { BusyError, Limiter } from "./limiter.ts";
import {
  CURRENT_PARAMS,
  hashPassword,
  needsRehash,
  PASSWORD_QUEUE,
  PASSWORD_SLOTS,
  prepareDummyHash,
  verifyAgainstNothing,
  verifyPassword,
  withPasswordSlot,
} from "./password.ts";
import { checkPassword, generatePassword, normalizeUsername } from "./policy.ts";

describe("password hashing", () => {
  it("verifies the right password only and salts every hash", async () => {
    const first = await hashPassword("ein langes testkennwort");
    const second = await hashPassword("ein langes testkennwort");
    expect(first).not.toBe(second);
    expect(await verifyPassword("ein langes testkennwort", first)).toBe(true);
    expect(await verifyPassword("ein anderes testkennwort", first)).toBe(false);
  });

  it("stores Argon2id with at least the OWASP minimum, parameters in the hash", async () => {
    const encoded = await hashPassword("ein langes testkennwort");
    expect(encoded.startsWith("$argon2id$v=19$m=19456,t=2,p=1$")).toBe(true);
    expect(CURRENT_PARAMS.memory).toBeGreaterThanOrEqual(19_456);
    expect(CURRENT_PARAMS.passes).toBeGreaterThanOrEqual(2);
    expect(needsRehash(encoded)).toBe(false);
  });

  it("asks for a rehash of weaker parameters and rejects unknown formats", async () => {
    const encoded = await hashPassword("ein langes testkennwort");
    expect(needsRehash(encoded.replace("m=19456,t=2", "m=19456,t=1"))).toBe(true);
    expect(() => needsRehash("$2b$10$notargon")).toThrow("unknown format");
  });

  it("spends time on an unknown user without failing", async () => {
    await expect(verifyAgainstNothing("irgendetwas")).resolves.toBeUndefined();
  });

  it("keeps the dummy hash working while every slot is taken and the queue is full", async () => {
    let release = (): void => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = Array.from({ length: PASSWORD_SLOTS + PASSWORD_QUEUE }, () => withPasswordSlot(() => blocker));
    await expect(withPasswordSlot(() => Promise.resolve())).rejects.toBeInstanceOf(BusyError);
    // Outside the slots: a busy service cannot make this fail, let alone cache that.
    await expect(prepareDummyHash()).resolves.toContain("$argon2id$");
    release();
    await Promise.all(held);
    await expect(verifyAgainstNothing("irgendetwas")).resolves.toBeUndefined();
  });
});

describe("limiter", () => {
  it("bounds concurrency and fails fast beyond the queue", async () => {
    const limiter = new Limiter(1, 1);
    let release = (): void => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = limiter.run(() => blocker);
    const queued = limiter.run(() => Promise.resolve("queued"));
    await expect(limiter.run(() => Promise.resolve("too many"))).rejects.toBeInstanceOf(BusyError);
    release();
    await running;
    await expect(queued).resolves.toBe("queued");
    await expect(limiter.run(() => Promise.resolve("free again"))).resolves.toBe("free again");
  });
});

describe("password policy", () => {
  it("wants 15 characters, counted as characters", () => {
    expect(checkPassword("q7!mZ2#vL9@xT4k", "chef")).toBeNull();
    expect(checkPassword("q7!mZ2#vL9@xT4", "chef")).toBe("too_short");
    // Eight emoji are 16 UTF-16 units but only 8 characters.
    expect(checkPassword("😀😁😂🤣😃😄😅😆", "chef")).toBe("too_short");
  });

  it("has no composition rules", () => {
    expect(checkPassword("nur kleine woerter hier", "chef")).toBeNull();
  });

  it("refuses breached passwords, in any case", () => {
    expect(checkPassword("password12345678", "chef")).toBe("common");
    expect(checkPassword("PASSWORD12345678", "chef")).toBe("common");
    expect(checkPassword("PassWord12345678", "chef")).toBe("common");
    expect(checkPassword("passwordpassword", "chef")).toBe("common");
    expect(checkPassword("123456789012345", "chef")).toBe("common");
  });

  it("refuses trivial repetition and too few characters", () => {
    expect(checkPassword("qxqxqxqxqxqxqxqxqx1", "chef")).toBe("too_simple");
    expect(checkPassword("xqzv1xqzv1xqzv1xqzv1", "chef")).toBe("too_simple");
    expect(checkPassword("Xqzv1xqZv1xqzv1XQZV1", "chef")).toBe("too_simple");
    expect(checkPassword("abababababababab1", "chef")).toBe("too_simple");
    // A unit that does not fill the whole password is fine.
    expect(checkPassword("xqzv1xqzv1xqzv1-und-mehr", "chef")).toBeNull();
  });

  it("refuses the username and the extremes", () => {
    expect(checkPassword("xyz-Chef-xyz-q7!mZ2", "chef")).toBe("contains_username");
    expect(checkPassword(`${"x".repeat(200)}${"y".repeat(57)}`, "chef")).toBe("too_long");
  });

  it("generates passwords that pass the policy and differ", () => {
    const first = generatePassword("chef");
    expect(checkPassword(first, "chef")).toBeNull();
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(generatePassword("chef")).not.toBe(first);
  });

  it("normalizes usernames", () => {
    expect(normalizeUsername("  Max.Muster ")).toBe("max.muster");
    expect(normalizeUsername("ab")).toBeNull();
    expect(normalizeUsername("-abc")).toBeNull();
    expect(normalizeUsername("a b c")).toBeNull();
  });
});
