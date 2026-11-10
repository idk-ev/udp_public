/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { randomBytes } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPublishedFile } from "./files.ts";

/**
 * Where the files of files.ts end up, so that the cockpit's nginx can read them.
 * Each file changes atomically, which is all nginx needs: it looks at one file per
 * request.
 */
export interface Publisher {
  /** What is published right now, by file name. Throws when it cannot be read. */
  read(): Promise<ReadonlyMap<string, string>>;
  /** Makes the published files equal to `next`; returns false if they already were. */
  write(next: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): Promise<boolean>;
}

export function assertFileNames(files: ReadonlyMap<string, string>): void {
  for (const name of files.keys()) {
    if (!isPublishedFile(name)) throw new Error(`invalid file name for publishing: ${name}`);
  }
}

export function changes(
  next: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): { changed: readonly string[]; removed: readonly string[] } {
  return {
    changed: [...next.keys()].filter((name) => next.get(name) !== current.get(name)),
    removed: [...current.keys()].filter((name) => !next.has(name)),
  };
}

/** A shared volume (Compose). Temporary names start with a dot and are never read. */
export function createDirectoryPublisher(directory: string): Publisher {
  return {
    async read() {
      const names = await readdir(directory);
      const visible = names.filter(isPublishedFile);
      const contents = await Promise.all(visible.map((name) => readFile(join(directory, name), "utf8")));
      return new Map(visible.map((name, index) => [name, contents[index] ?? ""]));
    },
    async write(next, current) {
      assertFileNames(next);
      const { changed, removed } = changes(next, current);
      if (changed.length === 0 && removed.length === 0) return false;
      for (const name of changed) {
        const temporary = join(directory, `.${name}.${randomBytes(6).toString("hex")}`);
        // Readable by the cockpit's user, which is a different one.
        await writeFile(temporary, next.get(name) ?? "", { mode: 0o644 });
        await rename(temporary, join(directory, name));
      }
      // New blocks take effect before old ones end.
      await Promise.all(removed.map((name) => rm(join(directory, name), { force: true })));
      return true;
    },
  };
}
