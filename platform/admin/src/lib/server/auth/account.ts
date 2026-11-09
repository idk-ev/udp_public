/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { audit } from "../audit.ts";
import type { Db } from "../db/client.ts";
import { single, text } from "../db/rows.ts";
import { hashPassword, verifyPassword, withPasswordSlot } from "./password.ts";
import { checkPassword, type PolicyViolation } from "./policy.ts";
import { createSession, revokeAllSessions, type SessionUser } from "./sessions.ts";
import { clearThrottle, passwordChangeKey, registerAttempt } from "./throttle.ts";

export type ChangePasswordResult =
  | { kind: "ok"; sessionToken: string }
  | { kind: "wrong_password" }
  | { kind: "same_password" }
  | { kind: "throttled"; retryAfterSeconds: number }
  | { kind: "policy"; violation: PolicyViolation };

async function change(db: Db, user: SessionUser, current: string, next: string): Promise<ChangePasswordResult> {
  const key = passwordChangeKey(user.username);
  const retryAfterSeconds = await registerAttempt(db, key);
  if (retryAfterSeconds > 0) return { kind: "throttled", retryAfterSeconds };

  const row = single(await db.query("SELECT password_hash FROM users WHERE id = $1", [user.id]));
  const checkedHash = text(row, "password_hash");
  if (!(await verifyPassword(current, checkedHash))) return { kind: "wrong_password" };
  await clearThrottle(db, key);

  if (next === current) return { kind: "same_password" };
  const violation = checkPassword(next, user.username);
  if (violation !== null) return { kind: "policy", violation };

  const passwordHash = await hashPassword(next);
  return db.transaction(async (tx) => {
    // Over the checked hash only: a reset or a disable meanwhile wins. The user is
    // updated before the sessions go, see createSession.
    const updated = await tx.query(
      `UPDATE users SET password_hash = $3, must_change_password = false
        WHERE id = $1 AND password_hash = $2 AND disabled_at IS NULL RETURNING id`,
      [user.id, checkedHash, passwordHash],
    );
    if (updated.length === 0) return { kind: "wrong_password" };
    await revokeAllSessions(tx, user.id);
    await audit(tx, {
      actor: { id: user.id, username: user.username },
      action: "user.password_changed",
      target: user.username,
    });
    const sessionToken = await createSession(tx, user.id, passwordHash);
    if (sessionToken === null) throw new Error("the account changed inside its own transaction");
    return { kind: "ok", sessionToken };
  });
}

/**
 * A user changing their own password. Ends every session of the user, and the
 * caller gets a fresh one. The current password must be known and may not be kept:
 * after `user add` or `user reset-password` the operator has seen it. Throws
 * BusyError, having written nothing, when too many checks are running or waiting.
 */
export function changePassword(
  db: Db,
  user: SessionUser,
  current: string,
  next: string,
): Promise<ChangePasswordResult> {
  return withPasswordSlot(() => change(db, user, current, next));
}
