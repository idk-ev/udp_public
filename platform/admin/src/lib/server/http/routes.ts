/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import type { Permission } from "../auth/permissions.ts";

/**
 * Default deny: a route is reachable only if it is listed here. A new route that
 * is missing answers 404, even for a logged-in user (a test checks that every
 * route in src/routes is listed, so that is noticed at once).
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set(["/(public)/login"]);

/** Probes: no session, no host check, nothing in the answer but the state. */
export const HEALTH_ROUTES: ReadonlySet<string> = new Set(["/healthz", "/readyz"]);

export const PROTECTED_ROUTES: Readonly<Record<string, Permission>> = {
  "/(app)": "overview:view",
  "/(app)/konto": "account:manage-own",
  "/(app)/staedte": "cities:manage",
  "/(app)/staedte/[slug]": "cities:manage",
  "/(app)/protokoll": "audit:read",
  "/logout": "account:manage-own",
};

/** All that is open while the operator-generated password is still in use. */
export const PASSWORD_CHANGE_PATH = "/konto";
export const ALLOWED_DURING_PASSWORD_CHANGE: ReadonlySet<string> = new Set(["/(app)/konto", "/logout"]);

export function permissionFor(routeId: string): Permission | undefined {
  return Object.hasOwn(PROTECTED_ROUTES, routeId) ? PROTECTED_ROUTES[routeId] : undefined;
}
