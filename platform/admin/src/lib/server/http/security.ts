/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/** Answers without a page of Kit get this policy (a page carries its own, with a nonce). */
const FALLBACK_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

/**
 * Set on every answer that passes the hook. Hashed static assets (immutable, no
 * secrets) are served by the adapter before the hook.
 */
export function applySecurityHeaders(response: Response): Response {
  const { headers } = response;
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Cache-Control", "no-store");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  // Not no-referrer: with it, browsers send "Origin: null" on a plain form POST,
  // and the origin checks would refuse every form that works without JavaScript.
  // same-origin sends nothing to other sites, and no address here holds a secret.
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", FALLBACK_CSP);
  return response;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * In addition to Kit's own origin check, and for every method and content type.
 * If the panel is a subdomain of the public site, the two are same-site: SameSite
 * cookies would travel on a POST from a public page. Fails closed: a browser that
 * sends neither header cannot change anything here.
 */
export function isForbiddenWrite(request: Request, publicOrigin: string): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  return request.headers.get("origin") !== publicOrigin || request.headers.get("sec-fetch-site") !== "same-origin";
}
