/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addUser } from "#lib/server/auth/operator.ts";
import type { Db } from "#lib/server/db/client.ts";
import { call, COCKPIT_PORT, freshDb, PUBLISH_DIR, sessionCookie, startServer } from "./support.ts";

let db: Db;
let server: ChildProcess;
let cockpit: Server;
let cookie: string;
let forcedCookie: string;
/** Status the stand-in for the cockpit answers, and the paths it was asked for. */
let cockpitStatus = 200;
const cockpitCalls: string[] = [];
let nextAddress = 10;

function address(): string {
  nextAddress += 1;
  return `198.51.100.${String(nextAddress)}`;
}

async function logIn(username: string, password: string): Promise<string> {
  const answer = await call("/login", { form: { username, password }, xff: address() });
  const found = sessionCookie(answer);
  if (found === null) throw new Error(`login failed: ${String(answer.status)}`);
  return found;
}

const published = (name: string): boolean => existsSync(join(PUBLISH_DIR, name));

beforeAll(async () => {
  db = await freshDb();
  cockpit = createServer((request, response) => {
    cockpitCalls.push(`${request.method ?? ""} ${request.url ?? ""}`);
    response.writeHead(cockpitStatus);
    response.end();
  });
  await new Promise<void>((resolve) => {
    cockpit.listen(COCKPIT_PORT, "127.0.0.1", resolve);
  });
  const forced = await addUser(db, "forced-city-user");
  const full = await addUser(db, "city-user");
  if (forced.kind !== "ok" || full.kind !== "ok") throw new Error("could not add users");
  server = await startServer();
  forcedCookie = await logIn("forced-city-user", forced.password);
  const first = await logIn("city-user", full.password);
  const next = "ein eigenes langes kennwort";
  const changed = await call("/konto", {
    cookie: first,
    xff: address(),
    form: { current: full.password, next, confirm: next },
  });
  const found = sessionCookie(changed);
  if (found === null) throw new Error("password change failed");
  cookie = found;
});

afterAll(async () => {
  server.kill();
  cockpit.close();
  await db.close();
});

beforeEach(async () => {
  cockpitStatus = 200;
  cockpitCalls.length = 0;
  await db.exec(`TRUNCATE city_blocks, city_block_changes;
    INSERT INTO city_block_changes (generation) VALUES (0);
    UPDATE city_block_state SET generation = 0, held = '[]', reimposed = '[]', reported_marker = NULL,
      last_error = NULL, last_warning = NULL`);
  for (const name of readdirSync(PUBLISH_DIR)) rmSync(join(PUBLISH_DIR, name));
});

const BLOCK = "/staedte/reutlingen?/sperren";
const UNBLOCK = "/staedte/reutlingen?/freigeben";
const VALID = { reason: "Anruf der Stadt", confirmation: "Reutlingen" };

async function rows(): Promise<readonly unknown[]> {
  return db.query("SELECT key FROM city_blocks");
}

describe("block and unblock through the panel", () => {
  it("blocks, publishes and leads to the page with its result", async () => {
    const answer = await call(BLOCK, { cookie, form: VALID, accept: "text/html" });
    expect(answer.status).toBe(303);
    expect(answer.headers.location).toBe("/staedte/reutlingen?erledigt=gesperrt");
    expect(await rows()).toEqual([{ key: "08415061" }]);
    expect(published("slug-reutlingen")).toBe(true);
    expect(published("ags-08415061")).toBe(true);
  });

  it("names the author: the logged-in user, in the table and the audit log", async () => {
    await call(BLOCK, { cookie, form: VALID, accept: "text/html" });
    expect(await db.query("SELECT blocked_by FROM city_blocks")).toEqual([{ blocked_by: "city-user" }]);
    const [row] = await db.query(
      "SELECT actor, target, details->>'reason' AS reason FROM audit_log WHERE action = 'city.blocked' ORDER BY id DESC LIMIT 1",
    );
    expect(row).toEqual({ actor: "city-user", target: "reutlingen", reason: "Anruf der Stadt" });
  });

  it("reports a live check that confirms", async () => {
    await call(BLOCK, { cookie, form: VALID, accept: "text/html" });
    cockpitStatus = 410;
    const page = await call("/staedte/reutlingen?erledigt=gesperrt", { cookie });
    expect(page.body).toContain("Stichproben auf der öffentlichen Seite bestätigen das");
    expect(page.body).not.toContain('http-equiv="refresh"');
    expect(cockpitCalls).toContain("HEAD /reutlingen");
  });

  it("treats a failed live check as not confirmed yet, not as an error", async () => {
    await call(BLOCK, { cookie, form: VALID, accept: "text/html" });
    cockpitStatus = 200;
    const page = await call("/staedte/reutlingen?erledigt=gesperrt", { cookie });
    expect(page.status).toBe(200);
    expect(page.body).toContain("noch nicht bestätigt");
    // Only for browsers without JavaScript. A bare tag keeps its timer across a
    // client-side navigation and reloads the earlier page over what is being typed.
    expect(page.body).toMatch(/<noscript[^>]*><meta http-equiv="refresh" content="15"[^>]*><\/noscript>/);
    expect(page.body.replaceAll(/<noscript[\s\S]*?<\/noscript>/g, "")).not.toContain('http-equiv="refresh"');
    expect(page.body).not.toContain("Seite freigeben</button>");
  });

  it("refuses a wrong confirmation and keeps the reason", async () => {
    const answer = await call(BLOCK, { cookie, form: { ...VALID, confirmation: "Tübingen" }, accept: "text/html" });
    expect(answer.status).toBe(400);
    expect(answer.body).toContain("Zur Bestätigung bitte genau");
    expect(answer.body).toContain("Anruf der Stadt");
    expect(await rows()).toEqual([]);
    expect(published("slug-reutlingen")).toBe(false);
  });

  it("refuses a missing confirmation", async () => {
    const answer = await call(BLOCK, { cookie, form: { reason: "Anruf" }, accept: "text/html" });
    expect(answer.status).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it.each(["", "   "])("refuses the reason %j when blocking", async (reason) => {
    const answer = await call(BLOCK, { cookie, form: { ...VALID, reason }, accept: "text/html" });
    expect(answer.status).toBe(400);
    expect(answer.body).toContain("Bitte einen Grund");
    expect(await rows()).toEqual([]);
  });

  it("refuses a missing reason when unblocking", async () => {
    await call(BLOCK, { cookie, form: VALID, accept: "text/html" });
    const answer = await call(UNBLOCK, { cookie, form: { reason: "" }, accept: "text/html" });
    expect(answer.status).toBe(400);
    expect(await rows()).toEqual([{ key: "08415061" }]);
  });

  it("unblocks without a confirmation", async () => {
    await call(BLOCK, { cookie, form: VALID, accept: "text/html" });
    const answer = await call(UNBLOCK, { cookie, form: { reason: "Rücknahme" }, accept: "text/html" });
    expect(answer.status).toBe(303);
    expect(answer.headers.location).toBe("/staedte/reutlingen?erledigt=freigegeben");
    expect(await rows()).toEqual([]);
    expect(published("slug-reutlingen")).toBe(false);
  });

  it("answers 404 for an unknown city, on the page and for both actions", async () => {
    expect((await call("/staedte/gibt-es-nicht", { cookie })).status).toBe(404);
    const form = { reason: "Grund", confirmation: "x" };
    expect((await call("/staedte/gibt-es-nicht?/sperren", { cookie, form, accept: "text/html" })).status).toBe(404);
    expect((await call("/staedte/gibt-es-nicht?/freigeben", { cookie, form, accept: "text/html" })).status).toBe(404);
    expect(await rows()).toEqual([]);
  });

  it("has one page per city: no second address through its key", async () => {
    expect((await call("/staedte/08415061", { cookie })).status).toBe(404);
  });

  it("does nothing without a session, also with a valid form", async () => {
    const answer = await call(BLOCK, { form: VALID, accept: "text/html" });
    expect(answer.status).toBe(303);
    expect(answer.headers.location).toBe("/login");
    const unblock = await call(UNBLOCK, { form: { reason: "x" }, accept: "text/html" });
    expect(unblock.headers.location).toBe("/login");
    expect(await rows()).toEqual([]);
  });

  it("does nothing while the password still has to be changed", async () => {
    const answer = await call(BLOCK, { cookie: forcedCookie, form: VALID, accept: "text/html" });
    expect(answer.status).toBe(303);
    expect(answer.headers.location).toBe("/konto");
    expect(await rows()).toEqual([]);
  });

  it("refuses a write from another origin", async () => {
    const answer = await call(BLOCK, { cookie, form: VALID, accept: "text/html", origin: "https://udp.test" });
    expect(answer.status).toBe(403);
    expect(await rows()).toEqual([]);
  });
});

describe("the other screens", () => {
  it("searches on the server, with plain GET and the state of each hit", async () => {
    await call(BLOCK, { cookie, form: VALID, accept: "text/html" });
    const page = await call("/staedte?q=reutlingen", { cookie });
    expect(page.status).toBe(200);
    expect(page.body).toContain('staedte/reutlingen"');
    expect(page.body).toContain('staedte/kreis-reutlingen"');
    expect(page.body).toContain("Gesperrt");
    expect(page.body).toContain("Öffentlich");
  });

  it("sends only the hits, never the whole list of municipalities", async () => {
    const page = await call("/staedte", { cookie });
    expect(page.status).toBe(200);
    expect(page.body).not.toContain("Reutlingen");
    expect(page.body.length).toBeLessThan(20_000);
  });

  it("shows what is blocked on the overview, with its reason and state", async () => {
    await call(BLOCK, { cookie, form: VALID, accept: "text/html" });
    cockpitStatus = 410;
    const confirmed = await call("/", { cookie });
    expect(confirmed.body).toContain("Reutlingen");
    expect(confirmed.body).toContain("Anruf der Stadt");
    expect(confirmed.body).toContain("Wirksam");
    expect(confirmed.body).toContain("Stichproben");
    expect(confirmed.body).not.toContain("HTTP 403");
    cockpitStatus = 200;
    expect((await call("/", { cookie })).body).toContain("Noch nicht bestätigt");
  });

  it("warns when the database is behind", async () => {
    await call(BLOCK, { cookie, form: VALID, accept: "text/html" });
    await db.exec("DELETE FROM city_blocks");
    await db.query(
      `UPDATE city_block_state SET held = '[{"kind":"gemeinde","key":"08415061","slug":"reutlingen","name":"Reutlingen"}]'`,
    );
    const page = await call("/", { cookie });
    expect(page.body).toContain("Die Datenbank ist älter");
    expect(page.body).toContain("Reutlingen");
    expect(page.body).toContain("Gesperrt (gehalten)");
    expect(page.body).not.toContain("Wirksam:");
    const detail = await call("/staedte/reutlingen", { cookie });
    expect(detail.body).toContain("Gesperrt (gehalten)");
    expect(detail.body).toContain("Seite freigeben");
    expect(detail.body).not.toContain("Öffentlich");
    const hits = await call("/staedte?q=reutlingen", { cookie });
    expect(hits.body).toContain("Gesperrt (gehalten)");
  });

  it("warns when publishing failed, without the technical message in the page", async () => {
    await db.query("UPDATE city_block_state SET last_error = 'HTTP 403: secret detail'");
    const page = await call("/", { cookie });
    expect(page.body).toContain("fehlgeschlagen");
    expect(page.body).not.toContain("secret detail");
    await db.query("UPDATE city_block_state SET last_error = NULL");
  });

  it("does not claim all is confirmed while blocks are unchecked", async () => {
    await db.exec(`INSERT INTO city_blocks (kind, key, slug, name, reason, blocked_by)
      SELECT 'gemeinde', lpad(n::text, 8, '0'), 'seite-' || n, 'Seite ' || n, 'Test', 'x' FROM generate_series(1, 26) n`);
    cockpitStatus = 410;
    const page = await call("/", { cookie });
    expect(page.body).toContain("wurden nicht geprüft");
    expect(page.body).not.toContain("Wirksam: Stichproben");
    expect(page.body).toContain("Nicht geprüft");
  });

  it("names the district and wants it confirmed for a name that occurs twice", async () => {
    const page = await call("/staedte/altdorf-08115", { cookie });
    expect(page.body).toContain("Landkreis Böblingen");
    expect(page.body).toContain("Zur Bestätigung eintippen: Altdorf (Landkreis Böblingen)");
    const hits = await call("/staedte?q=altdorf", { cookie });
    expect(hits.body).toContain("Landkreis Böblingen");
    expect(hits.body).toContain("Landkreis Esslingen");
    const plain = { reason: "Grund", confirmation: "Altdorf" };
    const refused = await call("/staedte/altdorf-08115?/sperren", { cookie, form: plain, accept: "text/html" });
    expect(refused.status).toBe(400);
    expect(refused.body).toContain("Altdorf (Landkreis Böblingen)");
  });

  it("shows a block whose key left the catalogue, under its key, and lifts it", async () => {
    await db.exec(`INSERT INTO city_blocks (kind, key, slug, name, reason, blocked_by)
      VALUES ('gemeinde', '08999999', 'tuebingen', 'Früher', 'Alt', 'x')`);
    const overview = await call("/", { cookie });
    expect(overview.body).toContain('staedte/08999999"');
    const page = await call("/staedte/08999999", { cookie });
    expect(page.status).toBe(200);
    expect(page.body).toContain("im aktuellen Verzeichnis nicht mehr");
    expect(page.body).toContain("gehört inzwischen einer anderen Seite");
    expect(page.body).not.toContain("Seite sperren");
    const lifted = await call("/staedte/08999999?/freigeben", { cookie, form: { reason: "Weg" }, accept: "text/html" });
    expect(lifted.status).toBe(303);
    expect(await rows()).toEqual([]);
  });

  it("releases a held page through the panel, and only it", async () => {
    await call(BLOCK, { cookie, form: VALID, accept: "text/html" });
    await call("/staedte/tuebingen?/sperren", {
      cookie,
      form: { reason: "x", confirmation: "Tübingen" },
      accept: "text/html",
    });
    await db.exec(`TRUNCATE city_blocks, city_block_changes;
      INSERT INTO city_block_changes (generation) VALUES (0); UPDATE city_block_state SET generation = 0`);
    await call("/staedte/reutlingen", { cookie });
    const held = await call("/staedte/reutlingen?/freigeben", { cookie, form: { reason: "Falsch" }, accept: "text/html" });
    expect(held.status).toBe(303);
    expect(published("slug-reutlingen")).toBe(false);
    expect(published("slug-tuebingen")).toBe(true);
  });

  it("does not translate a real user named cli in the log", async () => {
    await db.query("INSERT INTO audit_log (actor_id, actor, action) VALUES (gen_random_uuid(), 'cli', 'user.enabled')");
    await db.query("INSERT INTO audit_log (actor, action) VALUES ('cli', 'user.disabled')");
    const page = await call("/protokoll", { cookie });
    expect(page.body).toMatch(/· cli<\/p>/);
    expect(page.body).toContain("Betrieb (Kommandozeile)");
  });

  it("shows the log newest first, with block and account events and no address", async () => {
    await call(BLOCK, { cookie, form: VALID, accept: "text/html" });
    const page = await call("/protokoll", { cookie });
    expect(page.status).toBe(200);
    expect(page.body).toContain("Seite gesperrt: reutlingen");
    expect(page.body).toContain("Eigenes Passwort geändert");
    expect(page.body).not.toContain("198.51.100");
    const logins = await call("/protokoll?ansicht=anmeldungen", { cookie });
    expect(logins.body).toContain("Anmeldung");
    expect(logins.body).not.toContain("198.51.100");
    expect(logins.body).not.toContain("Seite gesperrt");
  });

  it("pages the log, and ignores a page value that is no number", async () => {
    for (let i = 0; i < 60; i += 1) {
      await db.query("INSERT INTO audit_log (actor, action, target) VALUES ('cli', 'user.enabled', $1)", [`nutzer-${String(i)}`]);
    }
    const first = await call("/protokoll", { cookie });
    expect(first.body).toContain("nutzer-59");
    expect(first.body).not.toContain("nutzer-5<");
    const match = /vor=(\d+)/.exec(first.body);
    expect(match).not.toBeNull();
    const second = await call(`/protokoll?vor=${match?.[1] ?? ""}`, { cookie });
    expect(second.body).not.toContain("nutzer-59");
    expect(second.body).toContain("Neueste Einträge");
    for (const value of ["abc", "-1", "1;DROP", "99999999999999999999"]) {
      expect((await call(`/protokoll?vor=${encodeURIComponent(value)}`, { cookie })).status, value).toBe(200);
    }
  });
});
