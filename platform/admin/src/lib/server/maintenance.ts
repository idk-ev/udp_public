/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import type { Queryable } from "./db/client.ts";

/**
 * Removes what no longer has a use: expired sessions, throttle counters that have
 * run out, and login events (with their client addresses) after 30 days. The audit
 * log's trigger allows exactly this delete and refuses any other.
 */
export async function purgeExpired(db: Queryable): Promise<void> {
  await db.query("DELETE FROM sessions WHERE expires_at < now()");
  await db.query(
    "DELETE FROM login_throttle " +
      "WHERE last_attempt < now() - interval '1 hour' AND (blocked_until IS NULL OR blocked_until < now())",
  );
  await db.query(
    "DELETE FROM audit_log " +
      "WHERE action IN ('login.success', 'login.failure', 'logout') AND at < now() - interval '30 days'",
  );
}
