/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import { integer, single, text } from "../db/rows.ts";
import { purgeExpired } from "../maintenance.ts";
import { createTestDb } from "../testing/db.ts";
import { changePassword } from "./account.ts";
import { login, type LoginResult } from "./login.ts";
import { addUser, clearThrottleOf, disableUser, enableUser, listUsers, resetPassword } from "./operator.ts";
import { createSession, resolveSession, revokeSession, type SessionUser } from "./sessions.ts";
import { clientBucket, LOGIN_RULE, loginKey, PASSWORD_CHANGE_RULE, registerAttempt } from "./throttle.ts";

let db: Db;
const NEW_PASSWORD = "ein neues langes kennwort";
const WRONG = "falsch falsch falsch";
const ADDRESS = "203.0.113.7";

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("TRUNCATE users, sessions, login_throttle CASCADE");
});

async function add(name: string): Promise<string> {
  const result = await addUser(db, name);
  if (result.kind !== "ok") throw new Error(`could not add ${name}: ${result.kind}`);
  return result.password;
}

function attempt(username: string, password: string, previousToken?: string): Promise<LoginResult> {
  return login(db, { username, password, address: ADDRESS, previousToken });
}

async function loginToken(username: string, password: string): Promise<string> {
  const result = await attempt(username, password);
  if (result.kind !== "success") throw new Error(`login failed: ${result.kind}`);
  return result.sessionToken;
}

async function sessionUser(token: string): Promise<SessionUser> {
  const user = await resolveSession(db, token);
  if (user === null) throw new Error("no session");
  return user;
}

async function auditCount(action: string, actor: string): Promise<number> {
  const row = single(
    await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND actor = $2", [action, actor]),
  );
  return integer(row, "n");
}

describe("operator CLI functions", () => {
  it("adds an account with a generated password, stores only a hash, forces a change", async () => {
    const before = await auditCount("user.added", "cli");
    const password = await add("chef");
    const row = single(await db.query("SELECT password_hash, must_change_password FROM users"));
    expect(text(row, "password_hash").startsWith("$argon2id$")).toBe(true);
    expect(text(row, "password_hash")).not.toContain(password);
    expect(row.must_change_password).toBe(true);
    expect(await auditCount("user.added", "cli")).toBe(before + 1);
    const log = await db.query("SELECT details::text AS d, target FROM audit_log");
    expect(JSON.stringify(log)).not.toContain(password);
  });

  it("refuses a duplicate and an invalid name", async () => {
    await add("chef");
    expect((await addUser(db, "CHEF")).kind).toBe("exists");
    expect((await addUser(db, "x")).kind).toBe("invalid_username");
  });

  it("reset-password replaces the password, sets the flag and ends sessions", async () => {
    const first = await add("chef");
    const token = await loginToken("chef", first);
    const before = await auditCount("user.password_reset", "cli");
    const reset = await resetPassword(db, "chef");
    if (reset.kind !== "ok") throw new Error("reset failed");
    expect(reset.password).not.toBe(first);
    expect(await resolveSession(db, token)).toBeNull();
    expect((await attempt("chef", first)).kind).toBe("invalid");
    const fresh = await sessionUser(await loginToken("chef", reset.password));
    expect(fresh.mustChangePassword).toBe(true);
    expect(await auditCount("user.password_reset", "cli")).toBe(before + 1);
  });

  it("reset-password lifts the blocks of the account", async () => {
    const password = await add("chef");
    for (let i = 0; i < LOGIN_RULE.free; i += 1) await attempt("chef", WRONG);
    expect((await attempt("chef", password)).kind).toBe("throttled");
    const reset = await resetPassword(db, "chef");
    if (reset.kind !== "ok") throw new Error("reset failed");
    expect((await attempt("chef", reset.password)).kind).toBe("success");
  });

  it("throttle clear lifts the blocks of a name from every address, and is audited", async () => {
    const password = await add("chef");
    for (const address of ["203.0.113.8", "203.0.113.9"]) {
      for (let i = 0; i < LOGIN_RULE.free; i += 1) {
        await login(db, { username: "chef", password: WRONG, address, previousToken: undefined });
      }
    }
    const blocked = await login(db, { username: "chef", password, address: "203.0.113.8", previousToken: undefined });
    expect(blocked.kind).toBe("throttled");
    expect(await clearThrottleOf(db, " CHEF ")).toBe(2);
    const open = await login(db, { username: "chef", password, address: "203.0.113.8", previousToken: undefined });
    expect(open.kind).toBe("success");
    expect(await auditCount("throttle.cleared", "cli")).toBeGreaterThan(0);
  });

  it("disable ends the sessions at once and blocks login; enable reopens", async () => {
    const password = await add("chef");
    const token = await loginToken("chef", password);
    const disabledBefore = await auditCount("user.disabled", "cli");
    const enabledBefore = await auditCount("user.enabled", "cli");
    expect(await disableUser(db, "chef")).toEqual({ kind: "ok", username: "chef" });
    expect(await resolveSession(db, token)).toBeNull();
    expect((await attempt("chef", password)).kind).toBe("invalid");
    expect(await enableUser(db, "chef")).toEqual({ kind: "ok", username: "chef" });
    expect((await attempt("chef", password)).kind).toBe("success");
    expect(await auditCount("user.disabled", "cli")).toBe(disabledBefore + 1);
    expect(await auditCount("user.enabled", "cli")).toBe(enabledBefore + 1);
  });

  it("reports unknown accounts", async () => {
    expect((await disableUser(db, "niemand")).kind).toBe("not_found");
    expect((await enableUser(db, "niemand")).kind).toBe("not_found");
    expect((await resetPassword(db, "niemand")).kind).toBe("not_found");
  });

  it("lists accounts without hashes, and audits the listing", async () => {
    await add("chef");
    const before = await auditCount("user.listed", "cli");
    const users = await listUsers(db);
    expect(users).toEqual([{ username: "chef", role: "admin", active: true, lastLoginAt: null }]);
    expect(JSON.stringify(users)).not.toContain("argon2");
    expect(await auditCount("user.listed", "cli")).toBe(before + 1);
  });
});

describe("login", () => {
  it("answers alike for a wrong password, an unknown and a disabled user", async () => {
    const password = await add("chef");
    expect((await attempt("chef", WRONG)).kind).toBe("invalid");
    expect((await attempt("niemand", password)).kind).toBe("invalid");
    await disableUser(db, "chef");
    expect((await attempt("chef", password)).kind).toBe("invalid");
  });

  it("does not store what was typed as an unknown name", async () => {
    await attempt("mein-geheimes-kennwort", "egal egal egal egal");
    const log = await db.query("SELECT target, details::text AS details FROM audit_log");
    expect(JSON.stringify(log)).not.toContain("mein-geheimes-kennwort");
    const throttle = await db.query("SELECT key_hash, account_hash FROM login_throttle");
    expect(JSON.stringify(throttle)).not.toContain("mein-geheimes-kennwort");
  });

  it("replaces a session it was handed (rotation)", async () => {
    const password = await add("chef");
    const old = await loginToken("chef", password);
    const result = await attempt("chef", password, old);
    expect(result.kind).toBe("success");
    expect(await resolveSession(db, old)).toBeNull();
  });
});

describe("sessions", () => {
  async function user(): Promise<{ id: string; hash: string }> {
    await add("chef");
    const row = single(await db.query("SELECT id, password_hash FROM users"));
    return { id: text(row, "id"), hash: text(row, "password_hash") };
  }

  async function session(): Promise<string> {
    const { id, hash } = await user();
    const token = await createSession(db, id, hash);
    if (token === null) throw new Error("no session");
    return token;
  }

  it("stores only a hash of the token", async () => {
    const token = await session();
    const rows = await db.query("SELECT token_hash FROM sessions");
    expect(JSON.stringify(rows)).not.toContain(token);
    expect((await sessionUser(token)).username).toBe("chef");
  });

  it("is refused for a hash that is not the current one", async () => {
    const { id } = await user();
    expect(await createSession(db, id, "$argon2id$anders")).toBeNull();
    expect(await db.query("SELECT 1 FROM sessions")).toEqual([]);
  });

  it("ends after 30 minutes idle", async () => {
    const token = await session();
    await db.query("UPDATE sessions SET last_seen_at = now() - interval '31 minutes'");
    expect(await resolveSession(db, token)).toBeNull();
  });

  it("ends after 8 hours whatever the activity", async () => {
    const token = await session();
    const row = single(await db.query("SELECT extract(epoch FROM expires_at - now())::int AS s FROM sessions"));
    expect(integer(row, "s")).toBeLessThanOrEqual(8 * 3600);
    await db.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
    expect(await resolveSession(db, token)).toBeNull();
  });

  it("writes last-seen at most once a minute", async () => {
    const token = await session();
    await db.query("UPDATE sessions SET last_seen_at = now() - interval '10 seconds'");
    await resolveSession(db, token);
    const recent = single(await db.query("SELECT extract(epoch FROM now() - last_seen_at)::int AS s FROM sessions"));
    expect(integer(recent, "s")).toBeGreaterThanOrEqual(9);
    await db.query("UPDATE sessions SET last_seen_at = now() - interval '2 minutes'");
    await resolveSession(db, token);
    const updated = single(await db.query("SELECT extract(epoch FROM now() - last_seen_at)::int AS s FROM sessions"));
    expect(integer(updated, "s")).toBeLessThan(5);
  });

  it("logout ends this session only", async () => {
    const { id, hash } = await user();
    const one = await createSession(db, id, hash);
    const two = await createSession(db, id, hash);
    if (one === null || two === null) throw new Error("no session");
    await revokeSession(db, one);
    expect(await resolveSession(db, one)).toBeNull();
    expect(await resolveSession(db, two)).not.toBeNull();
  });
});

describe("changing the own password", () => {
  it("needs the current password, clears the flag and ends other sessions", async () => {
    const password = await add("chef");
    const token = await loginToken("chef", password);
    const other = await loginToken("chef", password);
    const user = await sessionUser(token);
    expect(user.mustChangePassword).toBe(true);

    expect((await changePassword(db, user, WRONG, NEW_PASSWORD)).kind).toBe("wrong_password");
    const before = await auditCount("user.password_changed", "chef");
    const result = await changePassword(db, user, password, NEW_PASSWORD);
    if (result.kind !== "ok") throw new Error(`change failed: ${result.kind}`);

    expect(await resolveSession(db, token)).toBeNull();
    expect(await resolveSession(db, other)).toBeNull();
    expect((await sessionUser(result.sessionToken)).mustChangePassword).toBe(false);
    expect((await attempt("chef", password)).kind).toBe("invalid");
    expect((await attempt("chef", NEW_PASSWORD)).kind).toBe("success");
    expect(await auditCount("user.password_changed", "chef")).toBe(before + 1);
  });

  it("applies the policy and refuses to keep the generated password", async () => {
    const password = await add("chef");
    const user = await sessionUser(await loginToken("chef", password));
    expect(await changePassword(db, user, password, "zu kurz")).toEqual({ kind: "policy", violation: "too_short" });
    expect(await changePassword(db, user, password, "password12345678")).toEqual({
      kind: "policy",
      violation: "common",
    });
    expect((await changePassword(db, user, password, password)).kind).toBe("same_password");
    expect((await sessionUser(await loginToken("chef", password))).mustChangePassword).toBe(true);
  });

  it("has its own throttle: guessing here does not block the login, and the reverse", async () => {
    const password = await add("chef");
    const user = await sessionUser(await loginToken("chef", password));
    for (let i = 0; i < PASSWORD_CHANGE_RULE.free; i += 1) {
      expect((await changePassword(db, user, WRONG, NEW_PASSWORD)).kind).toBe("wrong_password");
    }
    expect((await changePassword(db, user, password, NEW_PASSWORD)).kind).toBe("throttled");
    expect((await attempt("chef", password)).kind).toBe("success");
  });
});

describe("throttling", () => {
  it("blocks a pair after the free attempts, doubling up to the cap", async () => {
    const key = loginKey("chef", ADDRESS);
    for (let i = 0; i < LOGIN_RULE.free; i += 1) expect(await registerAttempt(db, key)).toBe(0);
    const first = await registerAttempt(db, key);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(2);

    await db.query("UPDATE login_throttle SET blocked_until = now() - interval '1 second'");
    expect(await registerAttempt(db, key)).toBe(0);
    const second = await registerAttempt(db, key);
    expect(second).toBeGreaterThan(2);
    expect(second).toBeLessThanOrEqual(4);

    await db.query("UPDATE login_throttle SET blocked_until = now() - interval '1 second', attempts = 5000");
    expect(await registerAttempt(db, key)).toBe(0);
    const capped = await registerAttempt(db, key);
    expect(capped).toBeGreaterThan(800);
    expect(capped).toBeLessThanOrEqual(LOGIN_RULE.maxDelaySeconds);
  });

  it("writes nothing while a block is on", async () => {
    const key = loginKey("chef", ADDRESS);
    for (let i = 0; i < LOGIN_RULE.free; i += 1) await registerAttempt(db, key);
    const before = await db.query("SELECT attempts, last_attempt, blocked_until FROM login_throttle");
    await registerAttempt(db, key);
    await registerAttempt(db, key);
    expect(await db.query("SELECT attempts, last_attempt, blocked_until FROM login_throttle")).toEqual(before);
  });

  it("starts over an hour after the last attempt", async () => {
    const key = loginKey("chef", ADDRESS);
    for (let i = 0; i < LOGIN_RULE.free; i += 1) await registerAttempt(db, key);
    await db.query(
      "UPDATE login_throttle SET blocked_until = now() - interval '1 second', last_attempt = now() - interval '2 hours'",
    );
    expect(await registerAttempt(db, key)).toBe(0);
    expect(integer(single(await db.query("SELECT attempts FROM login_throttle")), "attempts")).toBe(1);
  });

  it("does not block the account from other addresses", async () => {
    const password = await add("chef");
    for (let i = 0; i < LOGIN_RULE.free + 2; i += 1) await attempt("chef", WRONG);
    expect((await attempt("chef", password)).kind).toBe("throttled");
    const elsewhere = await login(db, {
      username: "chef",
      password,
      address: "198.51.100.1",
      previousToken: undefined,
    });
    expect(elsewhere.kind).toBe("success");
  });

  it("forgets the pair after a correct password", async () => {
    const password = await add("chef");
    for (let i = 0; i < LOGIN_RULE.free - 1; i += 1) await attempt("chef", WRONG);
    expect((await attempt("chef", password)).kind).toBe("success");
    expect(await db.query("SELECT 1 FROM login_throttle")).toEqual([]);
  });

  it("is keyed by client, with IPv6 in /64 blocks", () => {
    expect(clientBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(clientBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientBucket("2001:db8:1:2:3:4:5:6")).toBe("2001:0db8:0001:0002::/64");
    expect(clientBucket("2001:DB8:1:2::99")).toBe("2001:0db8:0001:0002::/64");
    expect(clientBucket("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(clientBucket("::1")).toBe("0000:0000:0000:0000::/64");
    expect(clientBucket("fe80::1%eth0")).toBe("fe80:0000:0000:0000::/64");
    expect(clientBucket("kein ip wert")).toBe("unknown");
    expect(clientBucket("")).toBe("unknown");
    expect(loginKey("chef", "2001:db8:1:2::1").hash).toBe(loginKey("chef", "2001:db8:1:2:ffff::2").hash);
    expect(loginKey("chef", "2001:db8:1:2::1").hash).not.toBe(loginKey("chef", "2001:db8:1:3::1").hash);
  });
});

describe("audit log", () => {
  it("is append-only: no UPDATE, no DELETE, no TRUNCATE through the application", async () => {
    await add("chef");
    await expect(db.query("DELETE FROM audit_log")).rejects.toThrow("append-only");
    await expect(db.query("UPDATE audit_log SET actor = 'jemand'")).rejects.toThrow("append-only");
    await expect(db.exec("TRUNCATE audit_log")).rejects.toThrow("append-only");
  });

  async function oldEntry(action: string, details = "{}"): Promise<void> {
    await db.query(
      "INSERT INTO audit_log (at, actor, action, details) VALUES (now() - interval '31 days', 'alt', $1, $2)",
      [action, details],
    );
  }

  async function oldEntries(action: string): Promise<number> {
    const row = single(
      await db.query("SELECT count(*)::int AS n FROM audit_log WHERE actor = 'alt' AND action = $1", [action]),
    );
    return integer(row, "n");
  }

  it("the maintenance job deletes old login events only", async () => {
    await oldEntry("login.failure", '{"address":"203.0.113.1"}');
    await oldEntry("login.success", '{"address":"203.0.113.1"}');
    await oldEntry("logout");
    await oldEntry("user.added");
    await db.query(
      "INSERT INTO audit_log (at, actor, action, details) VALUES (now() - interval '29 days', 'alt', 'login.failure', '{}')",
    );
    await purgeExpired(db);
    expect(await oldEntries("login.success")).toBe(0);
    expect(await oldEntries("logout")).toBe(0);
    expect(await oldEntries("user.added")).toBe(1);
    expect(await oldEntries("login.failure")).toBe(1);
  });

  it("refuses to delete a recent login event or an old account change", async () => {
    await oldEntry("user.disabled");
    await expect(db.query("DELETE FROM audit_log WHERE actor = 'alt'")).rejects.toThrow("append-only");
    await db.query("INSERT INTO audit_log (actor, action, details) VALUES ('neu', 'login.failure', '{}')");
    await expect(db.query("DELETE FROM audit_log WHERE actor = 'neu'")).rejects.toThrow("append-only");
  });

  it("keeps client addresses off everything but login events", async () => {
    await expect(
      db.query("INSERT INTO audit_log (actor, action, details) VALUES ('x', 'user.added', '{\"address\":\"203.0.113.1\"}')"),
    ).rejects.toThrow("audit_log_address_only_on_login");
    const password = await add("chef");
    const token = await loginToken("chef", password);
    await revokeSession(db, token);
    await disableUser(db, "chef");
    const withAddress = await db.query(
      "SELECT action FROM audit_log WHERE details ? 'address' AND action NOT IN ('login.success', 'login.failure')",
    );
    expect(withAddress).toEqual([]);
  });
});

describe("maintenance", () => {
  it("purges throttle rows that have run out, and keeps running blocks", async () => {
    const running = loginKey("laufend", ADDRESS);
    for (let i = 0; i < LOGIN_RULE.free; i += 1) await registerAttempt(db, running);
    await db.query(
      `INSERT INTO login_throttle (key_hash, account_hash, attempts, last_attempt)
       VALUES ('alt', 'alt', 1, now() - interval '2 hours')`,
    );
    await purgeExpired(db);
    const rows = await db.query("SELECT key_hash FROM login_throttle");
    expect(rows).toEqual([{ key_hash: running.hash }]);
  });
});
