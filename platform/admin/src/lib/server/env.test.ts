/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.ts";

const VALID = {
  ADMIN_PUBLIC_ORIGIN: "https://admin.example.org",
  ADMIN_DB_HOST: "timescale",
  ADMIN_DB_NAME: "udp_admin",
  ADMIN_DB_USER: "udp_admin",
  ADMIN_DB_PASSWORD: "geheim-geheim",
  ADMIN_CITY_CATALOG: "data/bw-gemeinden.json",
  ADMIN_CITY_PUBLISHER: "kubernetes",
  ADMIN_CITY_CONFIGMAP: "udp-city-blocks",
  ADMIN_COCKPIT_URL: "http://cockpit.udp.svc.cluster.local:8080",
};

describe("environment", () => {
  it("accepts a complete environment and normalizes the origin", () => {
    const env = parseEnv({ ...VALID, ADMIN_PUBLIC_ORIGIN: "https://Admin.Example.org/" });
    expect(env.publicOrigin).toBe("https://admin.example.org");
    expect(env.db.port).toBe(5432);
  });

  it("names what is missing, never a value", () => {
    expect(() => parseEnv({ ...VALID, ADMIN_DB_HOST: "" })).toThrow("ADMIN_DB_HOST is missing");
    let message = "";
    try {
      parseEnv({ ...VALID, ADMIN_DB_HOST: "" });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain("geheim");
  });

  it("wants https, http only on loopback, and no path", () => {
    expect(() => parseEnv({ ...VALID, ADMIN_PUBLIC_ORIGIN: "http://admin.example.org" })).toThrow("ADMIN_PUBLIC_ORIGIN");
    expect(() => parseEnv({ ...VALID, ADMIN_PUBLIC_ORIGIN: "https://admin.example.org/x" })).toThrow(
      "ADMIN_PUBLIC_ORIGIN",
    );
    expect(parseEnv({ ...VALID, ADMIN_PUBLIC_ORIGIN: "http://localhost:8088" }).publicOrigin).toBe(
      "http://localhost:8088",
    );
  });

  it("wants a known publisher with its setting", () => {
    expect(parseEnv(VALID).cityPublish).toEqual({ kind: "kubernetes", configMap: "udp-city-blocks" });
    expect(
      parseEnv({ ...VALID, ADMIN_CITY_PUBLISHER: "directory", ADMIN_CITY_PUBLISH_DIR: "/data" }).cityPublish,
    ).toEqual({ kind: "directory", directory: "/data" });
    expect(() => parseEnv({ ...VALID, ADMIN_CITY_PUBLISHER: "ftp" })).toThrow("ADMIN_CITY_PUBLISHER");
    expect(() => parseEnv({ ...VALID, ADMIN_CITY_PUBLISHER: "directory" })).toThrow("ADMIN_CITY_PUBLISH_DIR");
    expect(() => parseEnv({ ...VALID, ADMIN_CITY_PUBLISHER: "" })).toThrow("ADMIN_CITY_PUBLISHER");
  });

  it("wants the cockpit address without a path or credentials", () => {
    expect(parseEnv(VALID).cockpitUrl).toBe("http://cockpit.udp.svc.cluster.local:8080");
    for (const value of ["cockpit:8080", "http://cockpit/x", "http://a:b@cockpit", "ftp://cockpit", ""]) {
      expect(() => parseEnv({ ...VALID, ADMIN_COCKPIT_URL: value }), value).toThrow("ADMIN_COCKPIT_URL");
    }
  });

  it("rejects a bad port", () => {
    expect(() => parseEnv({ ...VALID, ADMIN_DB_PORT: "abc" })).toThrow("ADMIN_DB_PORT");
  });
});
