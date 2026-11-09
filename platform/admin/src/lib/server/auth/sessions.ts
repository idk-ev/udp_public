/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import type { Queryable } from "../db/client.ts";
import { bool, text } from "../db/rows.ts";
import { parseRole, type Role } from "./permissions.ts";
import { hashToken, newToken } from "./tokens.ts";

export const SESSION_COOKIE = "__Host-udp_admin";
export const ABSOLUTE_LIFETIME_SECONDS = 8 * 60 * 60;
const IDLE_LIFETIME = "30 minutes";
/** At most one write per session and minute, not one per page view. */
const LAST_SEEN_RESOLUTION = "60 seconds";

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
}

/**
 * Starts a session only if the password that was checked is still the user's and
 * the account is open; otherwise null. Checking a password takes a while, and it
 * may be changed or the account disabled in that time.
 *
 * One statement, and FOR SHARE makes it safe: it waits for a running password
 * change and then sees the new hash, or it finishes first and the change (which
 * updates the user BEFORE deleting the sessions) waits and deletes this one too.
 */
export async function createSession(db: Queryable, userId: string, checkedHash: string): Promise<string | null> {
  const token = newToken();
  const rows = await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     SELECT $1::text, u.id, now() + make_interval(secs => $2::double precision)
       FROM users u
      WHERE u.id = $3::uuid AND u.password_hash = $4::text AND u.disabled_at IS NULL
        FOR SHARE
     RETURNING token_hash`,
    [hashToken(token), ABSOLUTE_LIFETIME_SECONDS, userId, checkedHash],
  );
  return rows.length === 0 ? null : token;
}

/** The user of a valid session. Disabled users, idle and old sessions get null. */
export async function resolveSession(db: Queryable, token: string): Promise<SessionUser | null> {
  const tokenHash = hashToken(token);
  const [row] = await db.query(
    `SELECT u.id, u.username, u.role, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()
        AND s.last_seen_at > now() - interval '${IDLE_LIFETIME}'
        AND u.disabled_at IS NULL`,
    [tokenHash],
  );
  if (row === undefined) return null;
  await db.query(
    `UPDATE sessions SET last_seen_at = now()
      WHERE token_hash = $1 AND last_seen_at < now() - interval '${LAST_SEEN_RESOLUTION}'`,
    [tokenHash],
  );
  return {
    id: text(row, "id"),
    username: text(row, "username"),
    role: parseRole(text(row, "role")),
    mustChangePassword: bool(row, "must_change_password"),
  };
}

export async function revokeSession(db: Queryable, token: string): Promise<void> {
  await db.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

/** In a transaction, after updating the user: see createSession. */
export async function revokeAllSessions(db: Queryable, userId: string): Promise<void> {
  await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}
