/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { auditLogin } from "../audit.ts";
import type { Queryable } from "../db/client.ts";
import { bool, text } from "../db/rows.ts";
import { hashPassword, needsRehash, verifyAgainstNothing, verifyPassword, withPasswordSlot } from "./password.ts";
import { normalizeUsername } from "./policy.ts";
import { createSession, revokeSession } from "./sessions.ts";
import { clearThrottle, loginKey, registerAttempt } from "./throttle.ts";

export type LoginResult =
  | { kind: "success"; sessionToken: string }
  | { kind: "invalid" }
  | { kind: "throttled"; retryAfterSeconds: number };

export interface LoginInput {
  username: string;
  password: string;
  address: string;
  /** The session cookie that came with the request; a login replaces it. */
  previousToken: string | undefined;
}

async function attempt(db: Queryable, input: LoginInput): Promise<LoginResult> {
  // An unusable name is throttled and timed like an unknown one, under the text
  // that was typed (hashed, the throttle table holds no names).
  const username = normalizeUsername(input.username);
  const key = loginKey(username ?? input.username.trim().toLowerCase(), input.address);

  const retryAfterSeconds = await registerAttempt(db, key);
  if (retryAfterSeconds > 0) return { kind: "throttled", retryAfterSeconds };

  const [row] =
    username === null
      ? []
      : await db.query("SELECT id, password_hash, disabled_at IS NOT NULL AS disabled FROM users WHERE username = $1", [
          username,
        ]);

  if (row === undefined || username === null) {
    await verifyAgainstNothing(input.password);
    await auditLogin(db, { actor: { label: "anonym" }, action: "login.failure", address: input.address });
    return { kind: "invalid" };
  }

  const refuse = async (): Promise<LoginResult> => {
    await auditLogin(db, {
      actor: { label: "anonym" },
      action: "login.failure",
      target: username,
      address: input.address,
    });
    return { kind: "invalid" };
  };

  const userId = text(row, "id");
  let passwordHash = text(row, "password_hash");
  if (!(await verifyPassword(input.password, passwordHash)) || bool(row, "disabled")) return refuse();

  if (needsRehash(passwordHash)) {
    const stronger = await hashPassword(input.password);
    // Only over the hash that was checked, never over one changed meanwhile.
    const updated = await db.query(
      "UPDATE users SET password_hash = $3 WHERE id = $1 AND password_hash = $2 RETURNING id",
      [userId, passwordHash, stronger],
    );
    if (updated.length === 0) return refuse();
    passwordHash = stronger;
  }

  const sessionToken = await createSession(db, userId, passwordHash);
  if (sessionToken === null) return refuse();

  await clearThrottle(db, key);
  if (input.previousToken !== undefined) await revokeSession(db, input.previousToken);
  await db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
  await auditLogin(db, { actor: { id: userId, username }, action: "login.success", address: input.address });
  return { kind: "success", sessionToken };
}

/**
 * Password check and session start. A second factor would fit between the two: on
 * a correct password return a new result kind instead of a session, and start the
 * session after the second step. Throws BusyError, having written nothing, when
 * too many checks are running or waiting.
 */
export function login(db: Queryable, input: LoginInput): Promise<LoginResult> {
  return withPasswordSlot(() => attempt(db, input));
}
