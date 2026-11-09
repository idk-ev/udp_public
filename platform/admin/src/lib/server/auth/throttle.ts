/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { createHash } from "node:crypto";
import { isIP, isIPv4 } from "node:net";
import type { Queryable } from "../db/client.ts";

/**
 * Hard block for password checks, kept in PostgreSQL. A login is blocked per pair
 * of account and client address. There is deliberately no block per account: from
 * other addresses nobody could then lock a real user out. The price is that someone
 * with many addresses gets the free attempts on each of them, so guessing is
 * stopped by the password rules (policy.ts), not by this table.
 *
 * The address comes from the trusted end of X-Forwarded-For (ADDRESS_HEADER,
 * XFF_DEPTH); what a client adds in front of it does not change the pair.
 */
export interface ThrottleRule {
  /** Attempts before the first block. */
  free: number;
  maxDelaySeconds: number;
}

export const LOGIN_RULE: ThrottleRule = { free: 5, maxDelaySeconds: 900 };
export const PASSWORD_CHANGE_RULE: ThrottleRule = { free: 5, maxDelaySeconds: 900 };

/** A block doubles with each round: 2 s, 4 s, ... The exponent stops before overflow. */
const MAX_EXPONENT = 20;
const RESET_AFTER = "1 hour";

export interface ThrottleKey {
  hash: string;
  accountHash: string;
  rule: ThrottleRule;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function accountHash(username: string): string {
  return digest(`account:${username}`);
}

/** The first four groups of an IPv6 address, expanded. */
function ipv6Prefix64(address: string): string {
  const [head = "", tail] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  return groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().padStart(4, "0"))
    .join(":");
}

/**
 * What counts as one client. IPv6 by /64: one customer usually holds a whole /64
 * and could otherwise pick a fresh address per attempt.
 */
export function clientBucket(address: string): string {
  const plain = address.trim().replace(/%.*$/, "");
  if (isIPv4(plain)) return plain;
  if (isIP(plain) !== 6) return "unknown";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(plain);
  if (mapped?.[1] !== undefined) return mapped[1];
  return `${ipv6Prefix64(plain)}::/64`;
}

/** `username` may be text that matches no account; only its hash is stored. */
export function loginKey(username: string, address: string): ThrottleKey {
  return {
    hash: digest(`login:${username}:${clientBucket(address)}`),
    accountHash: accountHash(username),
    rule: LOGIN_RULE,
  };
}

/** Separate from logins: guessing with a stolen session does not block the user's login. */
export function passwordChangeKey(username: string): ThrottleKey {
  return { hash: digest(`change:${username}`), accountHash: accountHash(username), rule: PASSWORD_CHANGE_RULE };
}

/**
 * Counts this attempt, and returns 0 if it may go ahead or the seconds until the
 * key allows one again. One statement, so parallel requests cannot slip through
 * together: while a block is on, the upsert applies to nothing and returns no row
 * (and writes nothing). Counted before the password is checked; a success clears it.
 */
export async function registerAttempt(db: Queryable, key: ThrottleKey): Promise<number> {
  const counted = await db.query(
    `INSERT INTO login_throttle AS t (key_hash, account_hash, attempts, last_attempt)
     VALUES ($1::text, $2::text, 1, now())
     ON CONFLICT (key_hash) DO UPDATE SET
       attempts = CASE WHEN t.last_attempt < now() - interval '${RESET_AFTER}' THEN 1 ELSE t.attempts + 1 END,
       last_attempt = now(),
       blocked_until = CASE
         WHEN t.last_attempt < now() - interval '${RESET_AFTER}' OR t.attempts + 1 < $3::int THEN NULL
         ELSE now() + make_interval(secs => least(
           power(2, least(t.attempts + 2 - $3::int, ${String(MAX_EXPONENT)})),
           $4::double precision))
       END
     WHERE t.blocked_until IS NULL OR t.blocked_until <= now()
     RETURNING attempts`,
    [key.hash, key.accountHash, key.rule.free, key.rule.maxDelaySeconds],
  );
  if (counted.length > 0) return 0;
  const [blocked] = await db.query(
    "SELECT greatest(ceil(extract(epoch FROM blocked_until - now())), 1)::int AS wait " +
      "FROM login_throttle WHERE key_hash = $1",
    [key.hash],
  );
  const wait = blocked?.wait;
  return typeof wait === "number" ? wait : 1;
}

export async function clearThrottle(db: Queryable, key: ThrottleKey): Promise<void> {
  await db.query("DELETE FROM login_throttle WHERE key_hash = $1", [key.hash]);
}

/** Every block of an account, from every address. Returns how many were removed. */
export async function clearAccountThrottle(db: Queryable, username: string): Promise<number> {
  const rows = await db.query("DELETE FROM login_throttle WHERE account_hash = $1 RETURNING key_hash", [
    accountHash(username),
  ]);
  return rows.length;
}
