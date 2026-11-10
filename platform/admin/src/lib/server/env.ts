/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import type { DbConfig } from "./db/client.ts";

/** Where city blocks are published for the cockpit (lib/server/cities). */
export type CityPublishConfig = { kind: "kubernetes"; configMap: string } | { kind: "directory"; directory: string };

export interface AdminEnv {
  /** scheme://host[:port] of the panel, as browsers see it. */
  publicOrigin: string;
  db: DbConfig;
  /** Path of bw-gemeinden.json. */
  cityCatalog: string;
  cityPublish: CityPublishConfig;
  /** scheme://host[:port] of the cockpit inside the platform, for the live check. */
  cockpitUrl: string;
}

const LOOPBACK: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An address fixed by the deployment: no path, no credentials. */
function parseInternalOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const http = url.protocol === "http:" || url.protocol === "https:";
  const bare = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
  return http && bare ? url.origin : null;
}

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

  const cityCatalog = required("ADMIN_CITY_CATALOG");
  let cityPublish: CityPublishConfig = { kind: "directory", directory: "" };
  const publisher = required("ADMIN_CITY_PUBLISHER");
  if (publisher === "kubernetes") {
    cityPublish = { kind: "kubernetes", configMap: required("ADMIN_CITY_CONFIGMAP") };
  } else if (publisher === "directory") {
    cityPublish = { kind: "directory", directory: required("ADMIN_CITY_PUBLISH_DIR") };
  } else if (publisher !== "") {
    problems.push("ADMIN_CITY_PUBLISHER must be kubernetes or directory");
  }

  const cockpitValue = required("ADMIN_COCKPIT_URL");
  const cockpitUrl = parseInternalOrigin(cockpitValue);
  if (cockpitValue !== "" && cockpitUrl === null) {
    problems.push("ADMIN_COCKPIT_URL must be http(s)://host[:port], without a path");
  }

  if (publicOrigin === null || cockpitUrl === null || problems.length > 0) {
    throw new Error(`invalid environment: ${problems.join("; ")}`);
  }
  return { publicOrigin, db, cityCatalog, cityPublish, cockpitUrl };
}
