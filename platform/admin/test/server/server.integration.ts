/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUser, clearThrottleOf } from "#lib/server/auth/operator.ts";
import type { Db } from "#lib/server/db/client.ts";
import { call, freshDb, SECURITY_HEADERS, sessionCookie, startServer, type Answer } from "./support.ts";

let db: Db;
let server: ChildProcess;
let forcedCookie: string;
let fullCookie: string;
let nextAddress = 10;

/** The in-memory limit per address must not get in the way between tests. */
function address(): string {
  nextAddress += 1;
  return `192.0.2.${String(nextAddress)}`;
}

async function logIn(username: string, password: string): Promise<string> {
  const answer = await call("/login", { form: { username, password }, xff: address() });
  const cookie = sessionCookie(answer);
  if (cookie === null) throw new Error(`login failed: ${String(answer.status)} ${answer.body.slice(0, 200)}`);
  return cookie;
}

function expectSecurityHeaders(answer: Answer, label: string): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(answer.headers[name], `${label}: ${name}`).toBe(value);
  }
  expect(answer.headers["content-security-policy"], label).toContain("frame-ancestors 'none'");
  expect(answer.headers["strict-transport-security"], label).toBeUndefined();
}

beforeAll(async () => {
  db = await freshDb();
  const forced = await addUser(db, "forced-user");
  const full = await addUser(db, "full-user");
  if (forced.kind !== "ok" || full.kind !== "ok") throw new Error("could not add users");
  server = await startServer();
  forcedCookie = await logIn("forced-user", forced.password);
  const first = await logIn("full-user", full.password);
  const changed = await call("/konto", {
    cookie: first,
    xff: address(),
    form: { current: full.password, next: "ein eigenes langes kennwort", confirm: "ein eigenes langes kennwort" },
  });
  const cookie = sessionCookie(changed);
  if (cookie === null) throw new Error(`password change failed: ${String(changed.status)}`);
  fullCookie = cookie;
});

afterAll(async () => {
  server.kill();
  await db.close();
});

/** Everything that must not open without a session, however it is spelled. */
const PROTECTED_PATHS = [
  "/",
  "/konto",
  "/konto/",
  "/konto//",
  "//konto",
  "/./konto",
  "/x/../konto",
  "/%6Bonto",
  "/%6b%6f%6e%74%6f",
  "/konto%2F",
  "/konto%00",
  "/KONTO",
  "/konto?x=1",
  "/konto/__data.json",
  "/__data.json",
  "/%6Bonto/__data.json",
  "/konto/__data.json?x-sveltekit-invalidated=01",
  "/staedte",
  "/staedte/",
  "/staedte?q=reutlingen",
  "/staedte/__data.json",
  "/%73taedte",
  "/staedte/reutlingen",
  "/staedte/reutlingen/__data.json",
  "/staedte/%72eutlingen",
  "/staedte/reutlingen/",
  "/staedte/gibt-es-nicht",
  "/staedte/..%2Fkonto",
  "/protokoll",
  "/protokoll/__data.json",
  "/protokoll?ansicht=anmeldungen",
  "/%70rotokoll",
  "/(app)/konto",
  "/(app)",
  "/%28app%29/konto",
  "/nicht-da",
  "/nicht-da/__data.json",
  "/logout",
  "/benutzer",
  "/robots.txt",
];

describe("anonymous matrix against the built server", () => {
  it.each(PROTECTED_PATHS)("%s does not show a page", async (path) => {
    const answer = await call(path);
    expect(answer.body, path).not.toContain("Passwort ändern");
    expect(answer.body, path).not.toContain("Gesperrte Seiten");
    expect(answer.body, path).not.toContain("Protokoll</h1>");
    expect(answer.body, path).not.toContain("Seite sperren");
    // A 200 is only ever the JSON redirect for Kit's client, never a page.
    if (answer.status === 200) expect(JSON.parse(answer.body), path).toMatchObject({ type: "redirect", location: "/login" });
    else expect([303, 308, 400, 404, 405], path).toContain(answer.status);
  });

  it("opens the login page and the probes", async () => {
    expect((await call("/login")).status).toBe(200);
    expect((await call("/login/__data.json")).status).toBe(200);
    expect((await call("/healthz")).body).toBe("ok");
    expect((await call("/readyz")).body).toBe("ok");
  });

  it("answers data requests in the JSON form Kit's client understands", async () => {
    const answer = await call("/konto/__data.json");
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(answer.body)).toEqual({ type: "redirect", status: 303, location: "/login" });
  });

  it("answers an enhanced form in the JSON form too", async () => {
    const answer = await call("/konto", {
      accept: "application/json",
      form: { current: "a", next: "b", confirm: "b" },
    });
    expect(JSON.parse(answer.body)).toEqual({ type: "redirect", status: 303, location: "/login" });
  });

  it("does not run an action without a session", async () => {
    const answer = await call("/konto", { form: { current: "a", next: "b", confirm: "b" } });
    expect(answer.status).toBe(303);
    expect(answer.headers.location).toBe("/login");
  });

  it("refuses GET on logout", async () => {
    const answer = await call("/logout", { cookie: fullCookie });
    expect(answer.status).toBe(405);
  });
});

describe("forced-change matrix against the built server", () => {
  const CLOSED = [
    "/",
    "/?x=1",
    "/__data.json",
    "/%5F%5Fdata.json",
    "/nicht-da",
    "/nicht-da/__data.json",
    "/(app)",
    "/%28app%29",
    "/robots.txt",
    "/staedte",
    "/staedte?q=reutlingen",
    "/staedte/__data.json",
    "/staedte/reutlingen",
    "/staedte/reutlingen/__data.json",
    "/%73taedte/reutlingen",
    "/protokoll",
    "/protokoll/__data.json",
  ];

  it.each(CLOSED)("%s leads to the account page", async (path) => {
    const answer = await call(path, { cookie: forcedCookie });
    expect(answer.body, path).not.toContain("Gesperrte Seiten");
    expect(answer.body, path).not.toContain("Seite sperren");
    if (answer.status === 200) {
      expect(JSON.parse(answer.body)).toEqual({ type: "redirect", status: 303, location: "/konto" });
    } else {
      expect(answer.status, path).toBe(303);
      expect(answer.headers.location, path).toBe("/konto");
    }
  });

  it.each(["/konto", "/konto/__data.json", "/%6Bonto"])("%s stays open", async (path) => {
    expect((await call(path, { cookie: forcedCookie })).status, path).toBe(200);
  });

  it("normalizes the trailing slash without showing anything", async () => {
    // Kit answers this before the hook, so it carries no security headers. It is an
    // empty redirect to the same page, and the guard applies at its target.
    const answer = await call("/konto/", { cookie: forcedCookie });
    expect(answer.status).toBe(308);
    expect(answer.body).toBe("");
    // Relative to /konto/, so it leads to /konto.
    expect(new URL(answer.headers.location ?? "", "https://admin.test/konto/").pathname).toBe("/konto");
  });

  it("the normal user reaches the overview, and unknown paths are a real 404", async () => {
    const page = await call("/", { cookie: fullCookie });
    expect(page.status).toBe(200);
    expect(page.body).toContain("Gesperrte Seiten");
    expect((await call("/nicht-da", { cookie: fullCookie })).status).toBe(404);
  });
});

describe("security headers on everything that passes the hook", () => {
  const CASES: readonly [string, () => Promise<Answer>][] = [
    ["login page", () => call("/login")],
    ["redirect to login", () => call("/")],
    ["JSON redirect, data request", () => call("/konto/__data.json")],
    [
      "JSON redirect, enhanced form",
      () => call("/konto", { accept: "application/json", form: { current: "a", next: "b", confirm: "b" } }),
    ],
    ["redirect to the account page", () => call("/", { cookie: forcedCookie })],
    ["404 page", () => call("/nicht-da", { cookie: fullCookie })],
    ["probe", () => call("/healthz")],
    ["foreign host", () => call("/login", { host: "evil.example" })],
    ["405", () => call("/logout", { cookie: fullCookie })],
    ["failed login", () => call("/login", { xff: address(), form: { username: "niemand-hier", password: "x" } })],
  ];

  it.each(CASES)("%s", async (label, request) => {
    expectSecurityHeaders(await request(), label);
  });

  it("thrown redirects of a load and an action as well", async () => {
    expectSecurityHeaders(await call("/login", { cookie: fullCookie }), "load");
    const credentials = { username: "full-user", password: "ein eigenes langes kennwort" };
    const plain = await call("/login", { xff: address(), accept: "text/html", form: credentials });
    expect(plain.status).toBe(303);
    expect(plain.headers.location).toBe("/");
    expectSecurityHeaders(plain, "action, plain form");
    const enhanced = await call("/login", { xff: address(), accept: "application/json", form: credentials });
    expect(JSON.parse(enhanced.body)).toMatchObject({ type: "redirect", location: "/" });
    expectSecurityHeaders(enhanced, "action, enhanced form");
  });
});

describe("the client address as the adapter parses it", () => {
  const wrong = { username: "full-user", password: "falsch falsch falsch" };

  async function exhaust(xff: string): Promise<void> {
    for (let i = 0; i < 5; i += 1) expect((await call("/login", { xff, form: wrong })).status).toBe(400);
  }

  it("uses the trusted end of X-Forwarded-For: rotating what the client sends does not help", async () => {
    await exhaust("203.0.113.10");
    const spoofed = await call("/login", { xff: "198.18.5.5, 203.0.113.10", form: wrong });
    expect(spoofed.status).toBe(429);
    const other = await call("/login", { xff: "203.0.113.10, 203.0.113.11", form: wrong });
    expect(other.status).toBe(400);
  });

  it("groups IPv6 by /64", async () => {
    await exhaust("2001:db8:1:2::a");
    expect((await call("/login", { xff: "2001:db8:1:2:ffff::1", form: wrong })).status).toBe(429);
    expect((await call("/login", { xff: "2001:db8:1:3::a", form: wrong })).status).toBe(400);
  });

  it("the in-memory limit stops one address before anything is written", async () => {
    const xff = "203.0.113.20";
    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const answer = await call("/login", { xff, form: { username: `flood-${String(i)}`, password: "falsch falsch" } });
      statuses.push(answer.status);
    }
    expect(statuses.filter((status) => status === 429).length).toBe(5);
    const before = await db.query("SELECT count(*)::int AS n FROM audit_log");
    await call("/login", { xff, form: { username: "flood-more", password: "falsch falsch" } });
    expect(await db.query("SELECT count(*)::int AS n FROM audit_log")).toEqual(before);
  });

  it("an unusable or missing address falls back to one shared bucket instead of failing", async () => {
    const answer = await call("/login", { xff: "kein-ip-wert", form: { username: "niemand-a", password: "x" } });
    expect(answer.status).toBe(400);
  });

  it("throttle clear lifts a block on the running server", async () => {
    const xff = "203.0.113.30";
    await exhaust(xff);
    expect((await call("/login", { xff, form: wrong })).status).toBe(429);
    expect(await clearThrottleOf(db, "full-user")).toBeGreaterThan(0);
    expect((await call("/login", { xff, form: wrong })).status).toBe(400);
  });
});
