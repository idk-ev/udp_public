/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import type { Queryable } from "./db/client.ts";
import { bool, integer, nullableTimestamp, text, type Row } from "./db/rows.ts";

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
  | "throttle.cleared"
  | "city.blocked"
  | "city.unblocked"
  | "city.publication_accepted"
  | "city.blocks_restored";

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
  entry: { actor: AuditActor; action: AuditAction; target?: string; details?: Readonly<Record<string, string>> },
): Promise<void> {
  return insert(db, {
    actor: entry.actor,
    action: entry.action,
    target: entry.target ?? null,
    details: entry.details ?? {},
  });
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

/** What the log view shows. Client addresses stay out: nothing here needs them. */
export interface AuditEntry {
  id: number;
  at: Date;
  actor: string;
  /** No account behind it: the CLI, the system, or a failed login. A user can be named "cli". */
  system: boolean;
  action: string;
  target: string | null;
  reason: string | null;
  /** The pages of an event about several. */
  pages: string | null;
}

export type AuditView = "changes" | "logins";

const VIEW_FILTER: Readonly<Record<AuditView, string>> = {
  changes: "action NOT IN ('login.success', 'login.failure', 'logout')",
  logins: "action IN ('login.success', 'login.failure', 'logout')",
};

function optionalText(row: Row, column: string): string | null {
  const value = row[column];
  return typeof value === "string" ? value : null;
}

/** Newest first; `before` is the id of the last entry of the previous page. */
export async function listAudit(
  db: Queryable,
  options: { view: AuditView; before: number | null; limit: number },
): Promise<{ entries: readonly AuditEntry[]; nextBefore: number | null }> {
  const rows = await db.query(
    `SELECT id::float8 AS id, at, actor, actor_id IS NULL AS system, action, target,
       details->>'reason' AS reason, details->>'pages' AS pages FROM audit_log
     WHERE ${VIEW_FILTER[options.view]} AND ($1::bigint IS NULL OR id < $1::bigint)
     ORDER BY id DESC LIMIT $2`,
    [options.before, options.limit + 1],
  );
  const entries = rows.slice(0, options.limit).map((row): AuditEntry => {
    const at = nullableTimestamp(row, "at");
    if (at === null) throw new TypeError("column at: expected timestamp");
    return {
      id: integer(row, "id"),
      at,
      actor: text(row, "actor"),
      system: bool(row, "system"),
      action: text(row, "action"),
      target: optionalText(row, "target"),
      reason: optionalText(row, "reason"),
      pages: optionalText(row, "pages"),
    };
  });
  return { entries, nextBefore: rows.length > options.limit ? (entries.at(-1)?.id ?? null) : null };
}
