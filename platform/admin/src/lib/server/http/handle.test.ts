/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { describe, expect, it } from "vitest";
import type { SessionUser } from "../auth/sessions.ts";
import { AddressLimit } from "./address-limit.ts";
import { guardRequest, type GuardEvent } from "./handle.ts";
import { HEALTH_ROUTES, permissionFor, PROTECTED_ROUTES, PUBLIC_ROUTES } from "./routes.ts";
import { isForbiddenWrite } from "./security.ts";

const ORIGIN = "https://admin.example.org";
const USER: SessionUser = { id: "1", username: "chef", role: "admin", mustChangePassword: false };

interface Call {
  routeId: string | null;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  cookie?: string;
  host?: string;
  dataRequest?: boolean;
}

function fakeEvent(call: Call): GuardEvent {
  const url = new URL(call.path ?? "/", call.host ?? ORIGIN);
  return {
    url,
    route: { id: call.routeId },
    request: new Request(url, { method: call.method ?? "GET", headers: call.headers ?? {} }),
    isDataRequest: call.dataRequest ?? false,
    locals: { user: null },
    cookies: { get: () => call.cookie },
  };
}

async function run(call: Call, user: SessionUser | null = null): Promise<{ response: Response; resolved: boolean }> {
  let resolved = false;
  const response = await guardRequest(
    fakeEvent(call),
    () => {
      resolved = true;
      return Promise.resolve(new Response("page"));
    },
    { publicOrigin: ORIGIN, resolveSession: () => Promise.resolve(user) },
  );
  return { response, resolved };
}

const WRITE = { "sec-fetch-site": "same-origin", origin: ORIGIN };

describe("default deny", () => {
  it("sends anonymous visitors of every protected route to the login", async () => {
    for (const routeId of Object.keys(PROTECTED_ROUTES)) {
      const { response, resolved } = await run({ routeId });
      expect(resolved, routeId).toBe(false);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
    }
  });

  it("does not reveal which addresses exist to anonymous visitors", async () => {
    const { response, resolved } = await run({ routeId: null, path: "/gibt-es-nicht" });
    expect(resolved).toBe(false);
    expect(response.status).toBe(303);
  });

  it("opens the listed public routes", async () => {
    for (const routeId of PUBLIC_ROUTES) expect((await run({ routeId })).resolved).toBe(true);
  });

  it("answers 404 for a route nobody listed, even when logged in", async () => {
    const { response, resolved } = await run({ routeId: "/(app)/neu-und-vergessen", cookie: "t" }, USER);
    expect(resolved).toBe(false);
    expect(response.status).toBe(404);
    expect(permissionFor("constructor")).toBeUndefined();
  });

  it("opens protected routes with a session", async () => {
    expect((await run({ routeId: "/(app)", cookie: "t" }, USER)).resolved).toBe(true);
  });

  it("answers Kit's client in JSON, with the security headers", async () => {
    const data = await run({ routeId: "/(app)", dataRequest: true });
    expect(await data.response.json()).toEqual({ type: "redirect", status: 303, location: "/login" });
    expect(data.response.headers.get("x-frame-options")).toBe("DENY");

    const form = await run({
      routeId: "/(app)/konto",
      method: "POST",
      headers: { ...WRITE, accept: "application/json" },
    });
    expect(await form.response.json()).toEqual({ type: "redirect", status: 303, location: "/login" });
    expect(form.response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("lists every route in src/routes", () => {
    const files = Object.keys(import.meta.glob(["/src/routes/**/+page.svelte", "/src/routes/**/+server.ts"]));
    const ids = files.map((file) => file.replace("/src/routes", "").replace(/\/\+(page\.svelte|server\.ts)$/, ""));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const listed = PUBLIC_ROUTES.has(id) || HEALTH_ROUTES.has(id) || permissionFor(id) !== undefined;
      expect(listed, `${id} is not listed in http/routes.ts`).toBe(true);
    }
  });
});

describe("forced password change", () => {
  const FORCED: SessionUser = { ...USER, mustChangePassword: true };

  it("opens only the account page and logout", async () => {
    expect((await run({ routeId: "/(app)/konto", cookie: "t" }, FORCED)).resolved).toBe(true);
    expect((await run({ routeId: "/logout", method: "POST", headers: WRITE, cookie: "t" }, FORCED)).resolved).toBe(true);
  });

  it("sends everything else to the account page", async () => {
    for (const routeId of ["/(app)", null, "/(app)/spaeter-dazugekommen"]) {
      const { response, resolved } = await run({ routeId, cookie: "t" }, FORCED);
      expect(resolved).toBe(false);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/konto");
    }
  });

  it("blocks writes elsewhere too", async () => {
    const { resolved } = await run({ routeId: "/(app)", method: "POST", headers: WRITE, cookie: "t" }, FORCED);
    expect(resolved).toBe(false);
  });
});

describe("cross-site writes", () => {
  function post(headers: Record<string, string>): Request {
    return new Request(`${ORIGIN}/login`, { method: "POST", headers });
  }

  it("needs the right origin and a same-origin fetch", () => {
    expect(isForbiddenWrite(post(WRITE), ORIGIN)).toBe(false);
    expect(isForbiddenWrite(post({ ...WRITE, origin: "https://udp.example.org" }), ORIGIN)).toBe(true);
    expect(isForbiddenWrite(post({ ...WRITE, "sec-fetch-site": "same-site" }), ORIGIN)).toBe(true);
  });

  it("fails closed when a header is missing", () => {
    expect(isForbiddenWrite(post({ origin: ORIGIN }), ORIGIN)).toBe(true);
    expect(isForbiddenWrite(post({ "sec-fetch-site": "same-origin" }), ORIGIN)).toBe(true);
    expect(isForbiddenWrite(post({}), ORIGIN)).toBe(true);
  });

  it("leaves reads alone", () => {
    expect(isForbiddenWrite(new Request(`${ORIGIN}/login`), ORIGIN)).toBe(false);
  });

  it("is enforced by the hook, even on public routes", async () => {
    const { response, resolved } = await run({
      routeId: "/(public)/login",
      method: "POST",
      headers: { origin: "https://udp.example.org", "sec-fetch-site": "same-site" },
    });
    expect(resolved).toBe(false);
    expect(response.status).toBe(403);
  });
});

describe("the hook in general", () => {
  it("refuses a foreign Host", async () => {
    const { response, resolved } = await run({ routeId: "/(public)/login", host: "https://evil.example" });
    expect(resolved).toBe(false);
    expect(response.status).toBe(400);
  });

  it("lets probes through without a session or a matching Host", async () => {
    expect((await run({ routeId: "/healthz", host: "http://10.0.0.5:3000" })).resolved).toBe(true);
  });

  it("sets the security headers on every answer", async () => {
    const answers = [
      await run({ routeId: "/(public)/login" }),
      await run({ routeId: "/(app)" }),
      await run({ routeId: "/healthz" }),
      await run({ routeId: "/(public)/login", method: "POST" }),
      await run({ routeId: "/(public)/login", host: "https://evil.example" }),
    ];
    for (const { response } of answers) {
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      // no-referrer would turn the Origin of plain form POSTs into "null".
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.has("strict-transport-security")).toBe(false);
    }
  });
});

describe("the in-memory limit per address", () => {
  it("allows the limit per window, per address, and opens again", () => {
    let now = 0;
    const limit = new AddressLimit(2, 1000, 100, () => now);
    expect(limit.allow("a")).toBe(true);
    expect(limit.allow("a")).toBe(true);
    expect(limit.allow("a")).toBe(false);
    expect(limit.allow("b")).toBe(true);
    now = 1000;
    expect(limit.allow("a")).toBe(true);
  });

  it("stays bounded: the oldest entry makes way", () => {
    let now = 0;
    const limit = new AddressLimit(1, 1000, 2, () => now);
    limit.allow("a");
    now = 1;
    limit.allow("b");
    now = 2;
    limit.allow("c");
    // "a" was dropped, so it counts as new; "c" is still known and over its limit.
    expect(limit.allow("a")).toBe(true);
    expect(limit.allow("a")).toBe(false);
  });
});
