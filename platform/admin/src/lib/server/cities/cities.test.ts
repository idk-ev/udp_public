/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listAudit } from "../audit.ts";
import type { Db } from "../db/client.ts";
import { createTestDb } from "../testing/db.ts";
import { acceptDatabase, blockCity, listBlocks, publishStatus, unblockCity, type BlockChange } from "./blocks.ts";
import {
  confirmationText,
  describeCity,
  loadCatalog,
  pageParam,
  parseCatalog,
  publicSlug,
  resolveCity,
  type BlockTarget,
} from "./catalog.ts";
import {
  buildFiles,
  isPublishedFile,
  parsePublication,
  PUBLICATION_FILE,
  PUBLIC_FILE,
  sitemap,
  SITEMAP_FILE,
  type Publication,
} from "./files.ts";
import { createKubernetesPublisher, type KubernetesAnswer } from "./kubernetes.ts";
import { checkPage } from "./live-check.ts";
import { publishBlocks, type CityDeps } from "./publish.ts";
import { createDirectoryPublisher, type Publisher } from "./publisher.ts";
import { searchCities } from "./search.ts";

const REPO_PUBLIC = join(import.meta.dirname, "..", "..", "..", "..", "..", "..", "gui", "public");
const catalog = loadCatalog(join(REPO_PUBLIC, "bw-gemeinden.json"));
const ACTOR = { label: "cli" };

function change(city: string, reason = "Anruf der Stadt"): BlockChange {
  return { city, reason, actor: ACTOR };
}

function memoryPublisher(): Publisher & { files: Map<string, string>; failing: boolean } {
  const state = {
    files: new Map<string, string>(),
    failing: false,
    read() {
      if (state.failing) return Promise.reject(new Error("publisher down"));
      return Promise.resolve(new Map(state.files));
    },
    write(next: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>) {
      if (state.failing) return Promise.reject(new Error("publisher down"));
      const same = next.size === current.size && [...next].every(([name, value]) => current.get(name) === value);
      state.files = new Map(next);
      return Promise.resolve(!same);
    },
  };
  return state;
}

describe("catalogue", () => {
  it("has the real list", () => {
    expect(catalog.gemeinden.length).toBe(1103);
    expect(catalog.kreise.filter((kreis) => kreis.type === "LK").length).toBe(35);
  });

  it("refuses malformed rows instead of publishing nonsense", () => {
    const row = ["08415061", "Reutlingen", 48, 9, "08415", "S", 1, null, "Reut/lingen"];
    expect(() => parseCatalog({ gemeinden: [row], kreise: [] })).toThrow("slug");
    expect(() => parseCatalog({ gemeinden: "x", kreise: [] })).toThrow("gemeinden");
    expect(() => parseCatalog({ gemeinden: [], kreise: [] })).toThrow("no municipalities");
    expect(() => parseCatalog(null)).toThrow("not an object");
  });

  it("resolves slugs and keys, and guesses nothing", () => {
    expect(resolveCity(catalog, "reutlingen")).toEqual({
      kind: "gemeinde",
      key: "08415061",
      slug: "reutlingen",
      name: "Reutlingen",
    });
    expect(resolveCity(catalog, " Reutlingen ")?.key).toBe("08415061");
    expect(resolveCity(catalog, "08415061")?.slug).toBe("reutlingen");
    expect(resolveCity(catalog, "kreis-reutlingen")).toMatchObject({ kind: "kreis", key: "08415" });
    expect(resolveCity(catalog, "08415")).toMatchObject({ kind: "kreis", slug: "kreis-reutlingen" });
    for (const unknown of ["gibt-es-nicht", "", "reutling", "0841506", "../reutlingen", "remseck-am-neckar"]) {
      expect(resolveCity(catalog, unknown), unknown).toBeNull();
    }
  });

  it("leads every name of a Stadtkreis to its town, which has the only page", () => {
    for (const input of ["stuttgart", "kreis-stuttgart", "08111", "08111000"]) {
      expect(resolveCity(catalog, input), input).toMatchObject({ kind: "gemeinde", slug: "stuttgart" });
    }
  });

  it("keeps a Landkreis apart from the Stadtkreis of the same name", () => {
    expect(resolveCity(catalog, "heilbronn")).toMatchObject({ kind: "gemeinde", slug: "heilbronn" });
    expect(resolveCity(catalog, "kreis-heilbronn")).toMatchObject({ kind: "kreis", slug: "kreis-heilbronn" });
  });
});

describe("published files", () => {
  const reutlingen: BlockTarget = { kind: "gemeinde", key: "08415061", slug: "reutlingen", name: "Reutlingen" };
  const kreis: BlockTarget = { kind: "kreis", key: "08415", slug: "kreis-reutlingen", name: "Landkreis Reutlingen" };
  const publication = (blocks: readonly BlockTarget[]): Publication => ({ generation: 1, change: "c", blocks });

  it("regenerates the image's sitemap exactly when nothing is blocked", () => {
    expect(sitemap(catalog, [])).toBe(readFileSync(join(REPO_PUBLIC, "sitemap.xml"), "utf8").replaceAll("\r\n", "\n"));
  });

  it("leaves blocked pages out of the sitemap", () => {
    const xml = sitemap(catalog, [reutlingen, kreis]);
    expect(xml).not.toContain("/reutlingen<");
    expect(xml).not.toContain("/kreis-reutlingen<");
    expect(xml).toContain("__PUBLIC_ORIGIN__/tuebingen<");
    expect(xml).toContain("__PUBLIC_ORIGIN__/<");
  });

  it("writes markers and no sitemap when nothing is blocked", () => {
    expect([...buildFiles(catalog, publication([])).keys()].sort()).toEqual([PUBLIC_FILE, PUBLICATION_FILE].sort());
    const files = buildFiles(catalog, publication([reutlingen, kreis]));
    expect(files.has("slug-reutlingen")).toBe(true);
    expect(files.has("ags-08415061")).toBe(true);
    expect(files.has("slug-kreis-reutlingen")).toBe(true);
    expect(files.has(SITEMAP_FILE)).toBe(true);
  });

  it("gives browsers the way out, and nothing about reason or author", () => {
    const text = buildFiles(catalog, publication([reutlingen])).get(PUBLIC_FILE) ?? "";
    expect(JSON.parse(text)).toEqual({
      version: 1,
      blocked: [{ slug: "reutlingen", ags: "08415061", kreisSlug: "kreis-reutlingen", kreisName: "Landkreis Reutlingen" }],
    });
    const both = buildFiles(catalog, publication([reutlingen, kreis])).get(PUBLIC_FILE) ?? "";
    expect(both).not.toContain("kreisSlug");
    const stuttgart: BlockTarget = { kind: "gemeinde", key: "08111000", slug: "stuttgart", name: "Stuttgart" };
    expect(buildFiles(catalog, publication([stuttgart])).get(PUBLIC_FILE)).not.toContain("kreisSlug");
  });

  it("stays well under the ConfigMap limit of 1 MiB, even with every page blocked", () => {
    const everything: BlockTarget[] = [
      ...catalog.gemeinden.map((g): BlockTarget => ({ kind: "gemeinde", key: g.ags, slug: g.slug, name: g.name })),
      ...catalog.kreise.flatMap((k): BlockTarget[] =>
        k.type === "LK" ? [{ kind: "kreis", key: k.key, slug: k.slug, name: k.name }] : [],
      ),
    ];
    const sizes = [[], everything.slice(0, 1), everything.slice(0, 550), everything].map((blocks) => {
      let bytes = 0;
      for (const [name, value] of buildFiles(catalog, publication(blocks))) {
        bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
      }
      return bytes;
    });
    expect(Math.max(...sizes)).toBeLessThan(512 * 1024);
  });

  it("only accepts file names a ConfigMap accepts", () => {
    for (const name of buildFiles(catalog, publication([reutlingen, kreis])).keys()) {
      expect(name).toMatch(/^[-._a-zA-Z0-9]+$/);
    }
  });

  it("reads a marker back, and treats anything else as none", () => {
    const marker = buildFiles(catalog, publication([reutlingen])).get(PUBLICATION_FILE);
    expect(parsePublication(marker)).toEqual({ publication: publication([reutlingen]), dropped: 0 });
    for (const text of [undefined, "kein json", "null", '{"generation":"1","change":"c","blocks":[]}']) {
      expect(parsePublication(text).publication, text).toBeNull();
    }
    expect(parsePublication('{"generation":1.5,"change":"c","blocks":[]}').publication).toBeNull();
  });

  it("drops invalid entries of a marker and counts them", () => {
    const bad = [
      { kind: "x", key: "08415061", slug: "reutlingen", name: "a" },
      { kind: "gemeinde", key: "08415061", slug: "../evil", name: "a" },
      { kind: "gemeinde", key: "8415", slug: "a", name: "a" },
      { kind: "kreis", key: "08415061", slug: "a", name: "a" },
      { kind: "gemeinde", key: "08415061", slug: "", name: "a" },
      { kind: "gemeinde", key: "08415061", slug: "UP", name: "a" },
      "text",
      null,
    ];
    const { publication: parsed, dropped } = parsePublication(
      JSON.stringify({ generation: 1, change: "c", blocks: [reutlingen, ...bad] }),
    );
    expect(parsed?.blocks).toEqual([reutlingen]);
    expect(dropped).toBe(bad.length);
  });

  it("publishes only the real file shapes", () => {
    for (const name of ["city-blocks.json", "publication.json", "sitemap.xml", "slug-a-b1", "ags-08415061"]) {
      expect(isPublishedFile(name), name).toBe(true);
    }
    for (const name of ["slug-", "ags-", "slug-A", "slug-a/b", "slug-../x", "slug--a", "ags-1", "x.json", ".slug-a", "ags-084150611"]) {
      expect(isPublishedFile(name), name).toBe(false);
    }
  });

  it("refuses to build files from a block that could not have been written", () => {
    expect(() => buildFiles(catalog, publication([{ ...reutlingen, slug: "../evil" }]))).toThrow("invalid block");
  });

  it("does not touch a page whose slug passed to it from a block's former page", () => {
    // The key left the catalogue, and "tuebingen" belongs to somebody else by now.
    const gone: BlockTarget = { kind: "gemeinde", key: "08999999", slug: "tuebingen", name: "Früher" };
    expect(publicSlug(catalog, gone)).toBeNull();
    const files = buildFiles(catalog, publication([gone]));
    expect(files.has("slug-tuebingen")).toBe(false);
    expect(files.has("ags-08999999")).toBe(false);
    expect(files.get(SITEMAP_FILE)).toContain("/tuebingen<");
    expect(files.get(PUBLIC_FILE)).not.toContain("tuebingen");
    // It still has an address of its own if nobody took the old one.
    expect(publicSlug(catalog, { ...gone, slug: "gibt-es-nicht-mehr" })).toBe("gibt-es-nicht-mehr");
    expect(pageParam(catalog, gone)).toBe("08999999");
    expect(pageParam(catalog, reutlingen)).toBe("reutlingen");
  });
});

describe("blocking", () => {
  let db: Db;

  async function resetDatabase(): Promise<void> {
    await db.exec(`TRUNCATE city_blocks, city_block_changes;
      INSERT INTO city_block_changes (generation) VALUES (0);
      UPDATE city_block_state SET generation = 0, held = '[]', reimposed = '[]', reimposed_at = NULL,
        reported_marker = NULL, last_error = NULL, last_warning = NULL`);
  }

  /** What a backup taken at this generation would hold. */
  async function restoreTo(generation: number, keepSlugs: readonly string[]): Promise<void> {
    await db.query("DELETE FROM city_blocks WHERE NOT (slug = ANY($1::text[]))", [keepSlugs]);
    await db.query("DELETE FROM city_block_changes WHERE generation > $1", [generation]);
    await db.query("UPDATE city_block_state SET generation = $1", [generation]);
  }

  const heldSlugs = async (): Promise<readonly string[]> => (await publishStatus(db)).held.map((block) => block.slug);
  let publisher: ReturnType<typeof memoryPublisher>;
  let deps: CityDeps;

  beforeAll(async () => {
    db = await createTestDb();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    publisher = memoryPublisher();
    deps = { db, catalog, publisher };
  });

  it("publishes a block and takes it back", async () => {
    const blocked = await blockCity(deps, change("reutlingen"));
    expect(blocked).toMatchObject({ kind: "ok", publish: { kind: "published", changed: true } });
    expect(publisher.files.has("slug-reutlingen")).toBe(true);
    expect(publisher.files.has("ags-08415061")).toBe(true);
    expect(await listBlocks(db)).toMatchObject([
      { slug: "reutlingen", reason: "Anruf der Stadt", blockedBy: "Betrieb (Kommandozeile)" },
    ]);

    const unblocked = await unblockCity(deps, change("reutlingen", "Stadt hat es sich anders überlegt"));
    expect(unblocked).toMatchObject({ kind: "ok", publish: { kind: "published", changed: true } });
    expect(publisher.files.has("slug-reutlingen")).toBe(false);
    expect(publisher.files.has(SITEMAP_FILE)).toBe(false);
    expect(await listBlocks(db)).toEqual([]);
  });

  it("refuses an unknown city, a missing reason, and writes nothing", async () => {
    expect(await blockCity(deps, change("gibt-es-nicht"))).toEqual({ kind: "unknown_city" });
    for (const reason of ["", "   ", "a".repeat(501), "zwei\nZeilen"]) {
      expect(await blockCity(deps, change("reutlingen", reason)), reason).toEqual({ kind: "invalid_reason" });
    }
    expect(await unblockCity(deps, change("gibt-es-nicht"))).toEqual({ kind: "unknown_city" });
    expect(await unblockCity(deps, change("reutlingen", ""))).toEqual({ kind: "invalid_reason" });
    expect(await listBlocks(db)).toEqual([]);
    expect(publisher.files.size).toBe(0);
  });

  it("wants the district confirmed as well for a name that occurs twice", async () => {
    const plain = await blockCity(deps, { ...change("altdorf-08115"), confirmation: "Altdorf" });
    expect(plain.kind).toBe("wrong_confirmation");
    const wrong = await blockCity(deps, { ...change("altdorf-08115"), confirmation: "Altdorf (Landkreis Esslingen)" });
    expect(wrong.kind).toBe("wrong_confirmation");
    const right = await blockCity(deps, { ...change("altdorf-08115"), confirmation: "altdorf  (landkreis böblingen)" });
    expect(right.kind).toBe("ok");
  });

  it("wants the name confirmed where a person confirms, and forgives case and spaces", async () => {
    const wrong = await blockCity(deps, { ...change("reutlingen"), confirmation: "Tübingen" });
    expect(wrong.kind).toBe("wrong_confirmation");
    expect((await blockCity(deps, { ...change("reutlingen"), confirmation: "" })).kind).toBe("wrong_confirmation");
    expect(await listBlocks(db)).toEqual([]);
    expect((await blockCity(deps, { ...change("reutlingen"), confirmation: "  reutlingen " })).kind).toBe("ok");
  });

  it("does not count a repeated change", async () => {
    await blockCity(deps, change("reutlingen"));
    const { generation } = await publishStatus(db);
    expect((await blockCity(deps, change("reutlingen"))).kind).toBe("already_blocked");
    expect((await unblockCity(deps, change("tuebingen"))).kind).toBe("not_blocked");
    expect((await publishStatus(db)).generation).toBe(generation);
  });

  it("writes block and unblock to the audit log, with the reason and no address", async () => {
    await blockCity(deps, change("kreis-reutlingen", "Schreiben des Landratsamts"));
    await unblockCity(deps, change("kreis-reutlingen", "Rücknahme"));
    const { entries } = await listAudit(db, { view: "changes", before: null, limit: 2 });
    expect(entries).toMatchObject([
      { action: "city.unblocked", target: "kreis-reutlingen", reason: "Rücknahme", actor: "cli" },
      { action: "city.blocked", target: "kreis-reutlingen", reason: "Schreiben des Landratsamts" },
    ]);
    const rows = await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'city.%' AND details ? 'address'");
    expect(rows).toEqual([{ n: 0 }]);
  });

  it("pages the log newest first, and keeps logins apart", async () => {
    for (const city of ["tuebingen", "boellen", "ulm"]) await blockCity(deps, change(city));
    await db.query(
      "INSERT INTO audit_log (actor, action, details) VALUES ('anonym', 'login.failure', '{\"address\":\"192.0.2.1\"}')",
    );
    const first = await listAudit(db, { view: "changes", before: null, limit: 2 });
    expect(first.entries.map((entry) => entry.target)).toEqual(["ulm", "boellen"]);
    expect(first.nextBefore).not.toBeNull();
    const second = await listAudit(db, { view: "changes", before: first.nextBefore, limit: 2 });
    expect(second.entries[0]?.target).toBe("tuebingen");
    const logins = await listAudit(db, { view: "logins", before: null, limit: 1 });
    expect(logins.entries[0]?.action).toBe("login.failure");
    expect(JSON.stringify(logins.entries)).not.toContain("192.0.2.1");
  });

  it("keeps a block when publishing fails, reports it, and repairs itself", async () => {
    publisher.failing = true;
    const result = await blockCity(deps, change("reutlingen"));
    expect(result).toMatchObject({ kind: "ok", publish: { kind: "failed", message: "publisher down" } });
    expect(await listBlocks(db)).toHaveLength(1);
    expect((await publishStatus(db)).lastError).toBe("publisher down");

    publisher.failing = false;
    expect(await publishBlocks(deps)).toMatchObject({ kind: "published", changed: true });
    expect(publisher.files.has("slug-reutlingen")).toBe(true);
    const status = await publishStatus(db);
    expect(status.lastError).toBeNull();
    expect(status.lastPublishedAt).not.toBeNull();
  });

  it("is idempotent", async () => {
    await blockCity(deps, change("reutlingen"));
    expect(await publishBlocks(deps)).toMatchObject({ kind: "published", changed: false });
  });

  describe("guard: a database that is behind lifts nothing", () => {
    it("keeps the pages of an emptied database offline, also the very last one", async () => {
      await blockCity(deps, change("reutlingen"));
      await resetDatabase();

      expect(await publishBlocks(deps)).toMatchObject({ kind: "held", orphans: [{ slug: "reutlingen" }] });
      expect(publisher.files.has("slug-reutlingen")).toBe(true);
      expect(await heldSlugs()).toEqual(["reutlingen"]);
      // And again on the next run: the marker has not moved.
      expect((await publishBlocks(deps)).kind).toBe("held");
      expect(publisher.files.has("slug-reutlingen")).toBe(true);
    });

    it("keeps them after a restore to an older state", async () => {
      await blockCity(deps, change("reutlingen"));
      await blockCity(deps, change("tuebingen"));
      await restoreTo(1, ["reutlingen"]);
      expect(await publishBlocks(deps)).toMatchObject({ kind: "held", orphans: [{ slug: "tuebingen" }] });
      expect(publisher.files.has("slug-tuebingen")).toBe(true);
    });

    it("stays held when the restored database catches up with the old generation (F1)", async () => {
      for (const city of ["reutlingen", "tuebingen", "boellen"]) await blockCity(deps, change(city));
      await restoreTo(1, ["reutlingen"]);
      expect((await publishBlocks(deps)).kind).toBe("held");
      await blockCity(deps, change("ulm"));
      await unblockCity(deps, change("ulm"));
      // Generation 3 again, and further on.
      expect((await publishStatus(db)).generation).toBe(3);
      await blockCity(deps, change("aalen"));
      await unblockCity(deps, change("aalen"));
      expect((await publishBlocks(deps)).kind).toBe("held");
      expect(publisher.files.has("slug-tuebingen")).toBe(true);
      expect(publisher.files.has("slug-boellen")).toBe(true);
      expect(publisher.files.has("slug-reutlingen")).toBe(true);
      expect(publisher.files.has("slug-ulm")).toBe(false);
      expect([...(await heldSlugs())].sort()).toEqual(["boellen", "tuebingen"]);
    });

    it("is not fooled by changes made before the first publish after a restore (F1)", async () => {
      for (const city of ["reutlingen", "tuebingen", "boellen"]) await blockCity(deps, change(city));
      await restoreTo(1, ["reutlingen"]);
      // Directly, without a publish in between: the very gap a plain counter has.
      await db.exec(`UPDATE city_block_state SET generation = 3;
        INSERT INTO city_block_changes (generation) VALUES (2), (3)`);
      expect(await publishBlocks(deps)).toMatchObject({ kind: "held" });
      expect(publisher.files.has("slug-tuebingen")).toBe(true);
    });

    it("still publishes new blocks meanwhile", async () => {
      await blockCity(deps, change("reutlingen"));
      await resetDatabase();
      const result = await blockCity(deps, change("tuebingen"));
      expect(result).toMatchObject({ kind: "ok", publish: { kind: "held" } });
      expect(publisher.files.has("slug-tuebingen")).toBe(true);
      expect(publisher.files.has("slug-reutlingen")).toBe(true);
    });

    it("lets an explicit unblock lift the one held page, and only it (F2)", async () => {
      for (const city of ["reutlingen", "tuebingen", "boellen"]) await blockCity(deps, change(city));
      await resetDatabase();
      await publishBlocks(deps);
      const result = await unblockCity(deps, change("tuebingen", "Sperre war falsch"));
      expect(result).toMatchObject({ kind: "ok", publish: { kind: "held", released: true } });
      expect(publisher.files.has("slug-tuebingen")).toBe(false);
      expect(publisher.files.has("ags-08416041")).toBe(false);
      expect(publisher.files.has("slug-reutlingen")).toBe(true);
      expect(publisher.files.has("slug-boellen")).toBe(true);
      expect([...(await heldSlugs())].sort()).toEqual(["boellen", "reutlingen"]);
      expect((await publishBlocks(deps)).kind).toBe("held");
      expect(publisher.files.has("slug-tuebingen")).toBe(false);
      const { entries } = await listAudit(db, { view: "changes", before: null, limit: 1 });
      expect(entries[0]).toMatchObject({ action: "city.unblocked", target: "tuebingen", reason: "Sperre war falsch" });
    });

    it("an unblock of a block in the database also holds while others are held (F2)", async () => {
      await blockCity(deps, change("reutlingen"));
      await resetDatabase();
      await blockCity(deps, change("tuebingen"));
      expect((await unblockCity(deps, change("tuebingen"))).kind).toBe("ok");
      expect(publisher.files.has("slug-tuebingen")).toBe(false);
      expect(publisher.files.has("slug-reutlingen")).toBe(true);
      expect(await heldSlugs()).toEqual(["reutlingen"]);
    });

    it("lifting the last held page ends the hold", async () => {
      await blockCity(deps, change("reutlingen"));
      await resetDatabase();
      await publishBlocks(deps);
      expect(await unblockCity(deps, change("reutlingen"))).toMatchObject({ publish: { kind: "published" } });
      expect(await heldSlugs()).toEqual([]);
      expect((await publishBlocks(deps)).kind).toBe("published");
    });

    it("says not blocked for a page that is neither in the database nor held", async () => {
      await blockCity(deps, change("reutlingen"));
      await resetDatabase();
      await publishBlocks(deps);
      expect((await unblockCity(deps, change("tuebingen"))).kind).toBe("not_blocked");
      expect(await heldSlugs()).toEqual(["reutlingen"]);
    });

    it("says so if it cannot look at the published state", async () => {
      publisher.failing = true;
      expect((await unblockCity(deps, change("tuebingen"))).kind).toBe("publish_failed");
    });

    it("lets the database win only on the explicit command, and for good", async () => {
      await blockCity(deps, change("reutlingen"));
      await resetDatabase();
      await publishBlocks(deps);
      expect((await acceptDatabase(deps, ACTOR)).kind).toBe("published");
      expect(publisher.files.has("slug-reutlingen")).toBe(false);
      expect(await heldSlugs()).toEqual([]);
      expect((await publishBlocks(deps)).kind).toBe("published");
      await blockCity(deps, change("tuebingen"));
      expect((await unblockCity(deps, change("tuebingen"))).kind).toBe("ok");
      expect(publisher.files.has("slug-tuebingen")).toBe(false);
      const { entries } = await listAudit(db, { view: "changes", before: null, limit: 3 });
      expect(entries.map((entry) => entry.action)).toContain("city.publication_accepted");
    });

    it("normal unblocks are not affected", async () => {
      await blockCity(deps, change("reutlingen"));
      expect((await unblockCity(deps, change("reutlingen"))).kind).toBe("ok");
      expect(publisher.files.has("slug-reutlingen")).toBe(false);
      expect(await heldSlugs()).toEqual([]);
    });

    it("adopts a state with nothing to lose, such as a first start", async () => {
      await publishBlocks(deps);
      await resetDatabase();
      expect((await publishBlocks(deps)).kind).toBe("published");
    });

    it("does not forget what is held when an attempt fails", async () => {
      await blockCity(deps, change("reutlingen"));
      await resetDatabase();
      await publishBlocks(deps);
      publisher.failing = true;
      expect((await publishBlocks(deps)).kind).toBe("failed");
      expect(await heldSlugs()).toEqual(["reutlingen"]);
    });

    it("reports blocks a restored database brought back, once, and they take effect (F9)", async () => {
      const reports = async (): Promise<number> =>
        (await db.query("SELECT 1 FROM audit_log WHERE action = 'city.blocks_restored'")).length;
      const before = await reports();
      await blockCity(deps, change("reutlingen"));
      await blockCity(deps, change("tuebingen"));
      await unblockCity(deps, change("tuebingen"));
      await db.exec(`DELETE FROM city_block_changes WHERE generation > 2;
        UPDATE city_block_state SET generation = 2;
        INSERT INTO city_blocks (kind, key, slug, name, reason, blocked_by)
          VALUES ('gemeinde', '08416041', 'tuebingen', 'Tübingen', 'alt', 'x')`);
      expect((await publishBlocks(deps)).kind).toBe("published");
      expect(publisher.files.has("slug-tuebingen")).toBe(true);
      expect((await publishStatus(db)).reimposed.map((block) => block.slug)).toEqual(["tuebingen"]);
      await publishBlocks(deps);
      expect(await reports()).toBe(before + 1);
      // The report ends after two weeks, or with --accept-database.
      await db.exec("UPDATE city_block_state SET reimposed_at = now() - interval '15 days'");
      expect((await publishStatus(db)).reimposed).toEqual([]);
    });
  });

  describe("damaged published state (F5)", () => {
    const seed = (entries: readonly (readonly [string, string])[]): void => {
      publisher.files = new Map(entries);
    };

    const MARKERS: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
      ["unreadable", [["publication.json", "kein json"]]],
      ["missing", []],
      ["of another shape", [["publication.json", '{"lineage":"x","generation":3,"blocks":[]}']]],
    ];

    it.each(MARKERS)("holds marker files when the marker is %s, rather than adopting the database", async (_, extra) => {
      seed([["slug-reutlingen", "1\n"], ["ags-08415061", "1\n"], ...extra]);
      expect(await publishBlocks(deps)).toMatchObject({ kind: "held", orphans: [{ slug: "reutlingen" }] });
      expect(publisher.files.has("slug-reutlingen")).toBe(true);
      expect(publisher.files.has("ags-08415061")).toBe(true);
      // Stays that way although the marker is readable now.
      expect((await publishBlocks(deps)).kind).toBe("held");
      expect(publisher.files.has("slug-reutlingen")).toBe(true);
      expect((await publishStatus(db)).lastWarning).toBeNull();
      expect((await acceptDatabase(deps, ACTOR)).kind).toBe("published");
      expect(publisher.files.has("slug-reutlingen")).toBe(false);
    });

    it("reports a lost marker on the run that finds it", async () => {
      seed([["slug-reutlingen", "1\n"]]);
      await publishBlocks(deps);
      seed([["slug-reutlingen", "1\n"], ["publication.json", "kein json"]]);
      await publishBlocks(deps);
      expect((await publishStatus(db)).held.map((block) => block.slug)).toEqual(["reutlingen"]);
    });

    it("drops invalid entries, reports them and keeps publishing", async () => {
      seed([["publication.json", JSON.stringify({
        generation: 0, change: "x",
        blocks: [{ kind: "gemeinde", key: "08415061", slug: "../evil", name: "x" }],
      })]]);
      const result = await blockCity(deps, change("tuebingen"));
      expect(result).toMatchObject({ kind: "ok" });
      expect([...publisher.files.keys()].every(isPublishedFile)).toBe(true);
      expect(publisher.files.has("slug-tuebingen")).toBe(true);
      expect((await publishStatus(db)).lastWarning).toContain("1 invalid entries");
    });

    it("drops a marker file that names no page, and reports it", async () => {
      seed([["slug-gibt-es-nicht", "1\n"], ["publication.json", "kein json"]]);
      expect((await publishBlocks(deps)).kind).toBe("published");
      expect(publisher.files.has("slug-gibt-es-nicht")).toBe(false);
      expect((await publishStatus(db)).lastWarning).toContain("slug-gibt-es-nicht");
    });

    it("treats a marker file by hand like a lost entry: held, not silently removed", async () => {
      await publishBlocks(deps);
      publisher.files.set("slug-reutlingen", "1\n");
      expect(await publishBlocks(deps)).toMatchObject({ kind: "held", orphans: [{ slug: "reutlingen" }] });
      expect(publisher.files.has("slug-reutlingen")).toBe(true);
    });
  });

  describe("a block whose key left the catalogue (F8)", () => {
    const smaller = parseCatalog({
      gemeinden: [["08415061", "Reutlingen", 48, 9, "08415", "S", 1, null, "reutlingen"]],
      kreise: [["08415", "Reutlingen", 48, 9, "LK", 1, 1, "kreis-reutlingen"]],
    });

    it("can be lifted by its key, and by its slug if nobody else has it", async () => {
      await blockCity(deps, change("tuebingen"));
      const later = { ...deps, catalog: smaller };
      expect((await publishBlocks(later)).kind).toBe("published");
      expect(publisher.files.has("slug-tuebingen")).toBe(true);
      expect(await unblockCity(later, change("08416041"))).toMatchObject({ kind: "ok", city: { slug: "tuebingen" } });
      expect(await listBlocks(db)).toEqual([]);
      expect(publisher.files.has("slug-tuebingen")).toBe(false);
    });

    it("does not take a reassigned slug with it", async () => {
      await blockCity(deps, change("tuebingen"));
      await db.exec("UPDATE city_blocks SET key = '08999999'");
      expect((await publishBlocks(deps)).kind).toBe("published");
      expect(publisher.files.has("slug-tuebingen")).toBe(false);
      expect(await listBlocks(db)).toHaveLength(1);
      // The slug means the living page, which is not blocked.
      expect((await unblockCity(deps, change("tuebingen"))).kind).toBe("not_blocked");
      expect((await unblockCity(deps, change("08999999"))).kind).toBe("ok");
      expect(await listBlocks(db)).toEqual([]);
    });
  });
});

describe("names that occur twice (F11)", () => {
  const altdorf = resolveCity(catalog, "altdorf-08115");
  const other = resolveCity(catalog, "altdorf-08116");

  it("shows the district where the name alone does not say which page", () => {
    if (altdorf === null || other === null) throw new Error("catalogue changed");
    expect(describeCity(catalog, altdorf).label).toBe("Altdorf (Landkreis Böblingen)");
    expect(describeCity(catalog, other).label).toBe("Altdorf (Landkreis Esslingen)");
    expect(confirmationText(catalog, altdorf)).not.toBe(confirmationText(catalog, other));
  });

  it("keeps the plain name for all others", () => {
    const reutlingen = resolveCity(catalog, "reutlingen");
    if (reutlingen === null) throw new Error("catalogue changed");
    expect(describeCity(catalog, reutlingen)).toEqual({
      category: "Stadt",
      context: "Landkreis Reutlingen",
      label: "Reutlingen",
    });
  });
});

describe("directory publisher", () => {
  it("writes atomically readable files, removes stale ones, and reports no change", async () => {
    const directory = mkdtempSync(join(tmpdir(), "udp-publish-"));
    const publisher = createDirectoryPublisher(directory);
    const first = new Map([
      ["city-blocks.json", "1"],
      ["slug-x", "1\n"],
    ]);
    expect(await publisher.write(first, await publisher.read())).toBe(true);
    expect(readdirSync(directory).sort()).toEqual(["city-blocks.json", "slug-x"]);
    expect(await publisher.read()).toEqual(first);
    expect(statSync(join(directory, "city-blocks.json")).isFile()).toBe(true);
    expect(await publisher.write(first, await publisher.read())).toBe(false);
    expect(await publisher.write(new Map([["city-blocks.json", "2"]]), await publisher.read())).toBe(true);
    expect(readdirSync(directory)).toEqual(["city-blocks.json"]);
    await expect(publisher.write(new Map([["../x", "1"]]), new Map())).rejects.toThrow("invalid file name");
    await expect(publisher.write(new Map([["slug-", "1"]]), new Map())).rejects.toThrow("invalid file name");
  });
});

describe("Kubernetes publisher", () => {
  function setup(answers: readonly KubernetesAnswer[]) {
    const calls: { method: string; path: string; body: string | undefined }[] = [];
    let index = 0;
    const publisher = createKubernetesPublisher(
      "udp-city-blocks",
      (method, path, body) => {
        calls.push({ method, path, body });
        const answer = answers[index] ?? { status: 500, body: "" };
        index += 1;
        return Promise.resolve(answer);
      },
      () => Promise.resolve("udp"),
    );
    return { publisher, calls };
  }

  const PATH = "/api/v1/namespaces/udp/configmaps/udp-city-blocks";

  it("reads the data, also of an empty ConfigMap", async () => {
    const { publisher, calls } = setup([
      { status: 200, body: '{"metadata":{}}' },
      { status: 200, body: '{"data":{"a":"1"}}' },
    ]);
    expect((await publisher.read()).size).toBe(0);
    expect(await publisher.read()).toEqual(new Map([["a", "1"]]));
    expect(calls[0]).toEqual({ method: "GET", path: PATH, body: undefined });
  });

  it("patches only what changed, with null for what went away", async () => {
    const { publisher, calls } = setup([{ status: 200, body: "{}" }]);
    const changed = await publisher.write(
      new Map([
        ["slug-same", "1"],
        ["slug-new", "2"],
      ]),
      new Map([
        ["slug-same", "1"],
        ["slug-old", "3"],
      ]),
    );
    expect(changed).toBe(true);
    expect(calls[0]?.method).toBe("PATCH");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ data: { "slug-new": "2", "slug-old": null } });
  });

  it("makes no call when nothing changed", async () => {
    const { publisher, calls } = setup([]);
    expect(await publisher.write(new Map([["slug-a", "1"]]), new Map([["slug-a", "1"]]))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("reports status and API message, and fails on a refusal", async () => {
    const forbidden = { status: 403, body: '{"message":"configmaps is forbidden"}' };
    await expect(setup([forbidden]).publisher.read()).rejects.toThrow("HTTP 403: configmaps is forbidden");
    await expect(setup([forbidden]).publisher.write(new Map([["slug-a", "1"]]), new Map())).rejects.toThrow("HTTP 403");
    await expect(setup([{ status: 404, body: "kaputt" }]).publisher.read()).rejects.toThrow("HTTP 404");
  });
});

describe("search", () => {
  const slugs = (query: string): readonly string[] => searchCities(catalog, query).map((hit) => hit.slug);

  it("finds municipalities and Landkreise by name, with and without umlauts", () => {
    expect(slugs("Tübingen")).toEqual(expect.arrayContaining(["tuebingen", "kreis-tuebingen"]));
    expect(slugs("tuebingen")).toContain("tuebingen");
    expect(slugs("tubingen")).toContain("tuebingen");
    expect(slugs("KREIS-REUTLINGEN")).toEqual(["kreis-reutlingen"]);
  });

  it("puts names that start with the text first", () => {
    const hits = searchCities(catalog, "reutlingen");
    expect(hits[0]?.slug).toBe("reutlingen");
    expect(hits.map((hit) => hit.kind)).toContain("kreis");
  });

  it("names the category and the district", () => {
    expect(searchCities(catalog, "reutlingen")[0]).toMatchObject({ category: "Stadt", context: "Landkreis Reutlingen" });
    expect(searchCities(catalog, "kreis-reutlingen")[0]).toMatchObject({ category: "Landkreis", context: null });
  });

  it("has no page for a Stadtkreis of its own", () => {
    expect(slugs("stuttgart")).toEqual(["stuttgart"]);
  });

  it("returns nothing for empty or endless text, and at most 30 hits", () => {
    expect(slugs("")).toEqual([]);
    expect(slugs("   ")).toEqual([]);
    expect(slugs("a".repeat(101))).toEqual([]);
    expect(slugs("e").length).toBe(30);
    expect(slugs("gibt es nicht")).toEqual([]);
  });
});

describe("live check", () => {
  const answer = (status: number) => () => Promise.resolve(new Response(null, { status }));

  it("confirms the status that fits the state", async () => {
    expect(await checkPage("http://cockpit:8080", "reutlingen", true, 3, answer(410))).toBe("confirmed");
    expect(await checkPage("http://cockpit:8080", "reutlingen", false, 3, answer(200))).toBe("confirmed");
  });

  it("calls anything else pending, and never throws", async () => {
    expect(await checkPage("http://cockpit:8080", "reutlingen", true, 3, answer(200))).toBe("pending");
    expect(await checkPage("http://cockpit:8080", "reutlingen", false, 3, answer(410))).toBe("pending");
    expect(await checkPage("http://cockpit:8080", "reutlingen", true, 3, answer(502))).toBe("pending");
    const refused = (): Promise<Response> => Promise.reject(new Error("connection refused"));
    expect(await checkPage("http://cockpit:8080", "reutlingen", true, 3, refused)).toBe("pending");
  });

  it("confirms only if every sample agrees: one replica behind is pending (F10)", async () => {
    const statuses = [410, 410, 200, 410, 410];
    let index = 0;
    const replicas = (): Promise<Response> => {
      index += 1;
      return Promise.resolve(new Response(null, { status: statuses[index - 1] ?? 410 }));
    };
    expect(await checkPage("http://cockpit:8080", "reutlingen", true, 5, replicas)).toBe("pending");
    expect(index).toBe(3);
  });

  it("asks only the fixed address with a slug, without following redirects", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const record = (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return Promise.resolve(new Response(null, { status: 410 }));
    };
    await checkPage("http://cockpit:8080", "kreis-reutlingen", true, 1, record);
    expect(calls[0]?.url).toBe("http://cockpit:8080/kreis-reutlingen");
    expect(calls[0]?.init).toMatchObject({ method: "HEAD", redirect: "manual", headers: { Connection: "close" } });
    for (const slug of ["../x", "//evil.example", "@evil.example", "a/b", "a?b", "A", ""]) {
      expect(await checkPage("http://cockpit:8080", slug, true, 1, record), slug).toBe("pending");
    }
    expect(calls).toHaveLength(1);
  });
});
