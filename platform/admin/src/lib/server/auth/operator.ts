/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { audit, CLI_ACTOR } from "../audit.ts";
import type { Db } from "../db/client.ts";
import { bool, nullableTimestamp, text } from "../db/rows.ts";
import { hashPassword } from "./password.ts";
import { parseRole, type Role } from "./permissions.ts";
import { generatePassword, normalizeUsername } from "./policy.ts";
import { revokeAllSessions } from "./sessions.ts";
import { clearAccountThrottle } from "./throttle.ts";

/**
 * Account management: only the operator CLI (src/cli) uses this module. The panel
 * has no way to create or change other accounts. Generated passwords are returned
 * once to be printed and are never stored; the user must replace them.
 *
 * Every change updates the user BEFORE it deletes the sessions, in one transaction:
 * see createSession in sessions.ts for why that closes the gap to a running login.
 */

export interface UserSummary {
  username: string;
  role: Role;
  active: boolean;
  lastLoginAt: Date | null;
}

export async function listUsers(db: Db): Promise<readonly UserSummary[]> {
  const rows = await db.query(
    "SELECT username, role, disabled_at IS NULL AS active, last_login_at FROM users ORDER BY username",
  );
  await audit(db, { actor: CLI_ACTOR, action: "user.listed" });
  return rows.map((row) => ({
    username: text(row, "username"),
    role: parseRole(text(row, "role")),
    active: bool(row, "active"),
    lastLoginAt: nullableTimestamp(row, "last_login_at"),
  }));
}

export type AddUserResult =
  | { kind: "ok"; username: string; password: string }
  | { kind: "invalid_username" }
  | { kind: "exists" };

export async function addUser(db: Db, input: string): Promise<AddUserResult> {
  const username = normalizeUsername(input);
  if (username === null) return { kind: "invalid_username" };
  const password = generatePassword(username);
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const [row] = await tx.query(
      `INSERT INTO users (username, role, password_hash, must_change_password)
       VALUES ($1, 'admin', $2, true) ON CONFLICT (username) DO NOTHING RETURNING id`,
      [username, passwordHash],
    );
    if (row === undefined) return { kind: "exists" };
    await audit(tx, { actor: CLI_ACTOR, action: "user.added", target: username });
    return { kind: "ok", username, password };
  });
}

export type ResetPasswordResult = { kind: "ok"; username: string; password: string } | { kind: "not_found" };

/** A disabled account stays disabled; it only gets a new password. */
export async function resetPassword(db: Db, input: string): Promise<ResetPasswordResult> {
  const username = input.trim().toLowerCase();
  const password = generatePassword(username);
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const [row] = await tx.query(
      "UPDATE users SET password_hash = $2, must_change_password = true WHERE username = $1 RETURNING id",
      [username, passwordHash],
    );
    if (row === undefined) return { kind: "not_found" };
    await revokeAllSessions(tx, text(row, "id"));
    await clearAccountThrottle(tx, username);
    await audit(tx, { actor: CLI_ACTOR, action: "user.password_reset", target: username });
    return { kind: "ok", username, password };
  });
}

export type StateChangeResult = { kind: "ok"; username: string } | { kind: "not_found" };

/**
 * Takes effect at once: the sessions are gone. There is deliberately no check for
 * the last active admin, the operator can always run `user enable`.
 */
export async function disableUser(db: Db, input: string): Promise<StateChangeResult> {
  const username = input.trim().toLowerCase();
  return db.transaction(async (tx) => {
    const [row] = await tx.query(
      "UPDATE users SET disabled_at = coalesce(disabled_at, now()) WHERE username = $1 RETURNING id",
      [username],
    );
    if (row === undefined) return { kind: "not_found" };
    await revokeAllSessions(tx, text(row, "id"));
    await audit(tx, { actor: CLI_ACTOR, action: "user.disabled", target: username });
    return { kind: "ok", username };
  });
}

export async function enableUser(db: Db, input: string): Promise<StateChangeResult> {
  const username = input.trim().toLowerCase();
  return db.transaction(async (tx) => {
    const [row] = await tx.query("UPDATE users SET disabled_at = NULL WHERE username = $1 RETURNING id", [username]);
    if (row === undefined) return { kind: "not_found" };
    await audit(tx, { actor: CLI_ACTOR, action: "user.enabled", target: username });
    return { kind: "ok", username };
  });
}

/**
 * Lifts every login and password-change block of a name, from every address. Works
 * for any name: blocks exist for names that match no account as well.
 */
export async function clearThrottleOf(db: Db, input: string): Promise<number> {
  const username = input.trim().toLowerCase();
  return db.transaction(async (tx) => {
    const removed = await clearAccountThrottle(tx, username);
    await audit(tx, { actor: CLI_ACTOR, action: "throttle.cleared", target: username });
    return removed;
  });
}
