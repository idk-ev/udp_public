/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import type { Cookies, RequestEvent } from "@sveltejs/kit";
import type { Handle } from "@sveltejs/kit/hooks";
import { can } from "../auth/permissions.ts";
import { SESSION_COOKIE, type SessionUser } from "../auth/sessions.ts";
import {
  ALLOWED_DURING_PASSWORD_CHANGE,
  HEALTH_ROUTES,
  PASSWORD_CHANGE_PATH,
  permissionFor,
  PUBLIC_ROUTES,
} from "./routes.ts";
import { applySecurityHeaders, isForbiddenWrite } from "./security.ts";

export interface HandleDeps {
  publicOrigin: string;
  resolveSession(token: string): Promise<SessionUser | null>;
}

/** What the guard reads of a request. */
export interface GuardEvent extends Pick<RequestEvent, "url" | "request" | "isDataRequest" | "locals"> {
  route: { id: string | null };
  cookies: Pick<Cookies, "get">;
}

const LOGIN_PATH = "/login";

function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/** A form sent by Kit's client (use:enhance) asks for its result as JSON. */
function isEnhancedForm(request: Request): boolean {
  return request.method === "POST" && (request.headers.get("accept") ?? "").startsWith("application/json");
}

/**
 * A redirect that passes through this hook, unlike a thrown one: Kit would answer
 * that itself, without the security headers. Kit's client gets its JSON form of a
 * redirect (the same for data requests and enhanced forms; test/server checks it
 * against the built server, so a change in Kit is noticed).
 */
function sendTo(event: GuardEvent, location: string): Response {
  if (event.isDataRequest || isEnhancedForm(event.request)) {
    return new Response(JSON.stringify({ type: "redirect", status: 303, location }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(null, { status: 303, headers: { Location: location } });
}

async function guard(event: GuardEvent, proceed: () => Promise<Response>, deps: HandleDeps): Promise<Response> {
  const routeId = event.route.id;
  if (routeId !== null && HEALTH_ROUTES.has(routeId)) return proceed();

  if (event.url.origin !== deps.publicOrigin) return plain(400, "Bad Request");
  if (isForbiddenWrite(event.request, deps.publicOrigin)) return plain(403, "Forbidden");

  const token = event.cookies.get(SESSION_COOKIE);
  const user = token === undefined ? null : await deps.resolveSession(token);
  event.locals.user = user;

  if (routeId !== null && PUBLIC_ROUTES.has(routeId)) return proceed();
  if (user === null) return sendTo(event, LOGIN_PATH);

  // The operator knows a generated password: nothing else opens until it is
  // replaced, not even the 404 page of an unknown address.
  if (user.mustChangePassword && (routeId === null || !ALLOWED_DURING_PASSWORD_CHANGE.has(routeId))) {
    return sendTo(event, PASSWORD_CHANGE_PATH);
  }

  // Unknown address: Kit's 404 page, for logged-in users only.
  if (routeId === null) return proceed();

  const permission = permissionFor(routeId);
  if (permission === undefined) return plain(404, "Not Found");
  if (!can(user.role, permission)) return plain(403, "Forbidden");
  return proceed();
}

/** Default deny, CSRF check and security headers, in one place. */
export async function guardRequest(
  event: GuardEvent,
  proceed: () => Promise<Response>,
  deps: HandleDeps,
): Promise<Response> {
  return applySecurityHeaders(await guard(event, proceed, deps));
}

export function createHandle(deps: HandleDeps): Handle {
  return ({ event, resolve }) => guardRequest(event, () => resolve(event), deps);
}
