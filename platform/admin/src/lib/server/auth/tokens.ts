/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { createHash, randomBytes } from "node:crypto";

/** 256 random bits, safe in a cookie. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What the database holds instead of the token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
