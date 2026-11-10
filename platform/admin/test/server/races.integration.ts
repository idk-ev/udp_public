/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changePassword } from "#lib/server/auth/account.ts";
import { login, type LoginResult } from "#lib/server/auth/login.ts";
import { addUser, disableUser, resetPassword } from "#lib/server/auth/operator.ts";
import { hashPassword } from "#lib/server/auth/password.ts";
import { createSession, resolveSession } from "#lib/server/auth/sessions.ts";
import { LOGIN_RULE, loginKey, registerAttempt } from "#lib/server/auth/throttle.ts";
import type { Db } from "#lib/server/db/client.ts";
import { single, text } from "#lib/server/db/rows.ts";
import { freshDb } from "./support.ts";

let db: Db;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db.close();
});

let counter = 0;

async function freshUser(): Promise<{ username: string; id: string; password: string; hash: string }> {
  counter += 1;
  const added = await addUser(db, `race-${String(counter)}`);
  if (added.kind !== "ok") throw new Error(added.kind);
  const row = single(await db.query("SELECT id, password_hash FROM users WHERE username = $1", [added.username]));
  return { username: added.username, id: text(row, "id"), password: added.password, hash: text(row, "password_hash") };
}

function attempt(username: string, password: string, address: string): Promise<LoginResult> {
  return login(db, { username, password, address, previousToken: undefined });
}

async function liveSessions(tokens: readonly string[]): Promise<number> {
  const users = await Promise.all(tokens.map((token) => resolveSession(db, token)));
  return users.filter((user) => user !== null).length;
}

/** Logins with the old password that started before the change and end after it. */
async function loginsAcross(username: string, password: string, round: number, change: () => Promise<unknown>): Promise<readonly string[]> {
  const logins = Array.from({ length: 2 }, (_, i) => attempt(username, password, `198.51.${String(round)}.${String(i + 1)}`));
  const changed = change();
  const results = await Promise.all(logins);
  await changed;
  return results.flatMap((result) => (result.kind === "success" ? [result.sessionToken] : []));
}

describe("M1: no session survives a change made during its login", () => {
  it("refuses a session for a hash that is no longer the user's, or a disabled account", async () => {
    const user = await freshUser();
    expect(await createSession(db, user.id, user.hash)).not.toBeNull();
    expect(await createSession(db, user.id, await hashPassword("ein ganz anderes passwort"))).toBeNull();
    await disableUser(db, user.username);
    expect(await createSession(db, user.id, user.hash)).toBeNull();
  });

  it("waits for a running password change and then refuses", async () => {
    const user = await freshUser();
    const stronger = await hashPassword("ein ganz anderes passwort");
    let session: Promise<string | null> | undefined;
    await db.transaction(async (tx) => {
      await tx.query("UPDATE users SET password_hash = $2 WHERE id = $1", [user.id, stronger]);
      // Blocked on the row lock until this transaction commits.
      session = createSession(db, user.id, user.hash);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
    });
    expect(await session).toBeNull();
  });

  it("a session made first is deleted by the change that follows", async () => {
    const user = await freshUser();
    const token = await createSession(db, user.id, user.hash);
    if (token === null) throw new Error("no session");
    const reset = await resetPassword(db, user.username);
    expect(reset.kind).toBe("ok");
    expect(await resolveSession(db, token)).toBeNull();
  });

  it("changePassword: nothing survives, across many rounds", async () => {
    const user = await freshUser();
    const owner = await attempt(user.username, user.password, "198.51.100.1");
    if (owner.kind !== "success") throw new Error(owner.kind);
    const sessionUser = await resolveSession(db, owner.sessionToken);
    if (sessionUser === null) throw new Error("no session");
    let current = user.password;
    for (let round = 0; round < 12; round += 1) {
      const next = `ein neues langes kennwort nummer ${String(round)}`;
      const from = current;
      let fresh = "";
      const tokens = await loginsAcross(user.username, from, round, async () => {
        const result = await changePassword(db, sessionUser, from, next);
        if (result.kind !== "ok") throw new Error(result.kind);
        fresh = result.sessionToken;
      });
      current = next;
      expect(await liveSessions(tokens), `round ${String(round)}`).toBe(0);
      expect(await resolveSession(db, fresh)).not.toBeNull();
    }
  });

  it("reset-password: nothing survives", async () => {
    const user = await freshUser();
    let current = user.password;
    for (let round = 20; round < 30; round += 1) {
      let reset = "";
      const tokens = await loginsAcross(user.username, current, round, async () => {
        const result = await resetPassword(db, user.username);
        if (result.kind !== "ok") throw new Error(result.kind);
        reset = result.password;
      });
      current = reset;
      expect(await liveSessions(tokens), `round ${String(round)}`).toBe(0);
    }
  });

  it("disable: nothing survives", async () => {
    for (let round = 40; round < 50; round += 1) {
      const user = await freshUser();
      const tokens = await loginsAcross(user.username, user.password, round, () => disableUser(db, user.username));
      expect(await liveSessions(tokens), `round ${String(round)}`).toBe(0);
    }
  });

  it("a rehash at login cannot overwrite a password changed meanwhile", async () => {
    const user = await freshUser();
    const weak = user.hash.replace("m=19456,t=2,p=1", "m=19456,t=1,p=1");
    // A weaker hash of the same password, so that the login wants to rehash.
    const { argon2 } = await import("node:crypto");
    const [, , , , saltB64] = weak.split("$");
    if (saltB64 === undefined) throw new Error("no salt");
    const key = await new Promise<Buffer>((resolve, reject) => {
      argon2(
        "argon2id",
        { message: user.password, nonce: Buffer.from(saltB64, "base64"), tagLength: 32, memory: 19_456, passes: 1, parallelism: 1 },
        (error, derived) => {
          if (error) reject(error);
          else resolve(derived);
        },
      );
    });
    const stored = `$argon2id$v=19$m=19456,t=1,p=1$${saltB64}$${key.toString("base64").replace(/=+$/, "")}`;
    await db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [user.id, stored]);

    const result = await attempt(user.username, user.password, "198.51.77.1");
    expect(result.kind).toBe("success");
    const after = single(await db.query("SELECT password_hash FROM users WHERE id = $1", [user.id]));
    expect(text(after, "password_hash")).toContain("m=19456,t=2,p=1");
  });
});

describe("M3: the throttle holds under real parallelism", () => {
  it("lets exactly the free attempts through, however many arrive at once", async () => {
    const key = loginKey("parallel-direct", "203.0.113.1");
    const answers = await Promise.all(Array.from({ length: 40 }, () => registerAttempt(db, key)));
    expect(answers.filter((wait) => wait === 0).length).toBe(LOGIN_RULE.free);
    expect(answers.filter((wait) => wait > 0).length).toBe(40 - LOGIN_RULE.free);
  });

  it("18 parallel wrong passwords run about the free number of checks", async () => {
    const user = await freshUser();
    const results = await Promise.all(
      Array.from({ length: 18 }, () =>
        attempt(user.username, "falsch falsch falsch", "203.0.113.2").catch((error: unknown) => {
          if (error instanceof Error && error.name === "BusyError") return null;
          throw error;
        }),
      ),
    );
    expect(results.filter((result) => result?.kind === "invalid").length).toBeLessThanOrEqual(LOGIN_RULE.free);
    const row = single(
      await db.query("SELECT count(*)::text AS n FROM audit_log WHERE action = 'login.failure' AND target = $1", [
        user.username,
      ]),
    );
    expect(Number(text(row, "n"))).toBeLessThanOrEqual(LOGIN_RULE.free);
  });

  it("gives every pair its own budget, so a flood from elsewhere does not block the victim", async () => {
    const user = await freshUser();
    for (let i = 0; i < 12; i += 1) {
      await attempt(user.username, "falsch falsch falsch", `198.18.0.${String(i + 1)}`);
    }
    expect((await attempt(user.username, user.password, "198.18.1.1")).kind).toBe("success");
  });
});
