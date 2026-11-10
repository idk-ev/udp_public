/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { error, type RequestEvent } from "@sveltejs/kit";
import { ABSOLUTE_LIFETIME_SECONDS, SESSION_COOKIE, type SessionUser } from "../auth/sessions.ts";

/** A text field of a submitted form; "" when it is missing or not text. */
export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** The user the hook established; a route listed as protected always has one. */
export function requireUser(locals: App.Locals): SessionUser {
  if (locals.user === null) error(401, "Nicht angemeldet");
  return locals.user;
}

export function setSessionCookie(event: Pick<RequestEvent, "cookies">, token: string): void {
  event.cookies.set(SESSION_COOKIE, token, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    maxAge: ABSOLUTE_LIFETIME_SECONDS,
  });
}

export function clearSessionCookie(event: Pick<RequestEvent, "cookies">): void {
  event.cookies.delete(SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "strict" });
}

/** The client address for throttling; adapter-node throws on a malformed header. */
export function clientAddress(event: Pick<RequestEvent, "getClientAddress">): string {
  try {
    return event.getClientAddress();
  } catch {
    return "unknown";
  }
}
