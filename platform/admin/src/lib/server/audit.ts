/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import type { Queryable } from "./db/client.ts";

/** Login events carry the client address and are deleted after 30 days. */
export type LoginAuditAction = "login.success" | "login.failure";

/** Kept permanently, without a client address (the table's CHECK enforces that). */
export type AuditAction =
  | "logout"
  | "user.added"
  | "user.password_reset"
  | "user.disabled"
  | "user.enabled"
  | "user.listed"
  | "user.password_changed"
  | "throttle.cleared";

/** Who did it: a logged-in user, or a label such as "cli" or "anonym". */
export type AuditActor = { id: string; username: string } | { label: string };

export const CLI_ACTOR: AuditActor = { label: "cli" };

interface AuditRow {
  actor: AuditActor;
  action: AuditAction | LoginAuditAction;
  target: string | null;
  details: Readonly<Record<string, string>>;
}

async function insert(db: Queryable, row: AuditRow): Promise<void> {
  const { actor } = row;
  await db.query("INSERT INTO audit_log (actor_id, actor, action, target, details) VALUES ($1, $2, $3, $4, $5)", [
    "id" in actor ? actor.id : null,
    "id" in actor ? actor.username : actor.label,
    row.action,
    row.target,
    JSON.stringify(row.details),
  ]);
}

export function audit(
  db: Queryable,
  entry: { actor: AuditActor; action: AuditAction; target?: string },
): Promise<void> {
  return insert(db, { actor: entry.actor, action: entry.action, target: entry.target ?? null, details: {} });
}

/**
 * A login event. `target` is only ever the name of an existing account: what was
 * typed for an unknown one may be a password in the wrong field.
 */
export function auditLogin(
  db: Queryable,
  entry: { actor: AuditActor; action: LoginAuditAction; target?: string; address: string },
): Promise<void> {
  return insert(db, {
    actor: entry.actor,
    action: entry.action,
    target: entry.target ?? null,
    details: { address: entry.address },
  });
}
