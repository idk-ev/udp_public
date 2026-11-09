/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { createPgDb, type Db, type DbConfig } from "#lib/server/db/client.ts";
import { migrate } from "#lib/server/db/migrate.ts";

const password = process.env.ADMIN_TEST_DB_PASSWORD;
if (password === undefined || password === "") {
  throw new Error("ADMIN_TEST_DB_PASSWORD is not set; see vitest.integration.config.ts");
}

export const DB_CONFIG: DbConfig = {
  host: process.env.ADMIN_TEST_DB_HOST ?? "127.0.0.1",
  port: Number(process.env.ADMIN_TEST_DB_PORT ?? "55432"),
  database: process.env.ADMIN_TEST_DB_NAME ?? "udp_admin",
  user: process.env.ADMIN_TEST_DB_USER ?? "udp_admin",
  password,
};

/** An empty, migrated database. Each test file starts from here. */
export async function freshDb(): Promise<Db> {
  const db = createPgDb(DB_CONFIG, () => undefined);
  await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  return db;
}

export const ORIGIN = "https://admin.test";
const PORT = 38471;

export interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface Call {
  method?: string;
  cookie?: string;
  xff?: string;
  accept?: string;
  form?: Readonly<Record<string, string>>;
  host?: string;
}

/** Raw HTTP, so that the path reaches the server exactly as written here. */
export function call(path: string, options: Call = {}): Promise<Answer> {
  const method = options.method ?? (options.form === undefined ? "GET" : "POST");
  const body = options.form === undefined ? undefined : new URLSearchParams({ ...options.form }).toString();
  const headers: Record<string, string> = {
    Host: options.host ?? "admin.test",
    "X-Forwarded-For": options.xff ?? "192.0.2.1",
    ...(options.accept === undefined ? {} : { Accept: options.accept }),
    ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
    ...(method === "POST" ? { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" } : {}),
    ...(body === undefined
      ? {}
      : { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(body)) }),
  };
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: PORT, method, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
        });
      });
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

export function sessionCookie(answer: Answer): string | null {
  const cookie = (answer.headers["set-cookie"] ?? []).find((line) => line.startsWith("__Host-udp_admin=") && !line.startsWith("__Host-udp_admin=;"));
  return cookie === undefined ? null : (cookie.split(";")[0] ?? null);
}

/** Starts the built server against the test database. */
export async function startServer(): Promise<ChildProcess> {
  if (!existsSync("build/index.js")) throw new Error("build/index.js is missing: run npm run build first");
  const server = spawn(process.execPath, ["build/index.js"], {
    env: {
      PATH: process.env.PATH,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      ADMIN_PUBLIC_ORIGIN: ORIGIN,
      ADMIN_DB_HOST: DB_CONFIG.host,
      ADMIN_DB_PORT: String(DB_CONFIG.port),
      ADMIN_DB_NAME: DB_CONFIG.database,
      ADMIN_DB_USER: DB_CONFIG.user,
      ADMIN_DB_PASSWORD: DB_CONFIG.password,
      ADDRESS_HEADER: "x-forwarded-for",
      XFF_DEPTH: "1",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const healthy = await call("/readyz").then(
      (answer) => answer.status === 200,
      () => false,
    );
    if (healthy) return server;
    await sleep(200);
  }
  server.kill();
  throw new Error("the built server did not become ready");
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-robots-tag": "noindex, nofollow, noarchive",
  "cache-control": "no-store",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
