/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import type { DbConfig } from "./db/client.ts";

export interface AdminEnv {
  /** scheme://host[:port] of the panel, as browsers see it. */
  publicOrigin: string;
  db: DbConfig;
}

const LOOPBACK: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  const bare = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "";
  return secure && bare ? url.origin : null;
}

/**
 * The environment, checked at startup. A message names variables, never values:
 * it ends up in the logs and one of them is a password.
 */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): AdminEnv {
  const problems: string[] = [];
  const required = (name: string): string => {
    const value = source[name]?.trim();
    if (value === undefined || value === "") {
      problems.push(`${name} is missing`);
      return "";
    }
    return value;
  };

  const originValue = required("ADMIN_PUBLIC_ORIGIN");
  const publicOrigin = parseOrigin(originValue);
  if (originValue !== "" && publicOrigin === null) {
    problems.push("ADMIN_PUBLIC_ORIGIN must be https://host[:port] (http only for localhost), without a path");
  }

  const portValue = source.ADMIN_DB_PORT?.trim() ?? "5432";
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) problems.push("ADMIN_DB_PORT must be a port number");

  const db: DbConfig = {
    host: required("ADMIN_DB_HOST"),
    port,
    database: required("ADMIN_DB_NAME"),
    user: required("ADMIN_DB_USER"),
    password: required("ADMIN_DB_PASSWORD"),
  };

  if (publicOrigin === null || problems.length > 0) {
    throw new Error(`invalid environment: ${problems.join("; ")}`);
  }
  return { publicOrigin, db };
}
