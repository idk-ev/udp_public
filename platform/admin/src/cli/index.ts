/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { getApp } from "#lib/server/app.ts";
import {
  addUser,
  clearThrottleOf,
  disableUser,
  enableUser,
  listUsers,
  resetPassword,
} from "#lib/server/auth/operator.ts";
import { CLI_ACTOR } from "#lib/server/audit.ts";
import { acceptDatabase, blockCity, listBlocks, publishStatus, unblockCity } from "#lib/server/cities/blocks.ts";
import { publishBlocks, type CityDeps, type PublishOutcome } from "#lib/server/cities/publish.ts";
import type { Db } from "#lib/server/db/client.ts";
import { migrate } from "#lib/server/db/migrate.ts";

/*
 * Operator CLI of the admin panel, run inside the container:
 *   kubectl -n <namespace> exec deploy/admin -- node build-cli/index.js user list
 * It never takes a password as an argument: arguments end up in shell histories
 * and process lists. Output goes to the operator's terminal, not the pod's log.
 */

const USAGE = `Usage: node build-cli/index.js <command>

  user add <name>             Create an admin account with a generated password
  user reset-password <name>  Generate a new password, end the account's sessions, lift its blocks
  user disable <name>         Close the account and end its sessions
  user enable <name>          Reopen a disabled account
  user list                   Show names, role, state and last login
  throttle clear <name>       Lift the login blocks of a name, from every address

  city block <city> --reason <text>    Take a public page offline
  city unblock <city> --reason <text>  Bring a public page back, also a held one
  city list                            Show the blocks and the publishing state
  city publish                         Publish now
  city publish --accept-database       Publish now and let the database win, see below

<city> is a slug, a municipality key (AGS) or a district key, or for a block the
catalogue no longer knows, the key from "city list". Keep personal data out of the
reason: it stays in the audit log for good.

Generated passwords are printed once and must be changed at the first login.

If the database is behind the published state (restored, emptied), blocks it no longer
has stay enforced and "city list" names them as held. "city unblock" lifts one of them,
--accept-database lifts them all.`;

const INVALID_NAME = "Invalid username: 3–64 characters, a-z 0-9 . _ -, starting with a letter or digit.";

function printPassword(username: string, password: string): void {
  console.log(`Account:  ${username}`);
  console.log(`Password: ${password}`);
  console.log("Shown only this once. It must be changed at the first login.");
}

async function listCommand(db: Db): Promise<number> {
  const users = await listUsers(db);
  if (users.length === 0) {
    console.log("No accounts yet. Create the first one with: user add <name>");
    return 0;
  }
  console.table(
    users.map((user) => ({
      name: user.username,
      role: user.role,
      active: user.active ? "yes" : "no",
      "last login": user.lastLoginAt?.toISOString() ?? "never",
    })),
  );
  return 0;
}

async function addCommand(db: Db, name: string): Promise<number> {
  const result = await addUser(db, name);
  switch (result.kind) {
    case "invalid_username":
      console.error(INVALID_NAME);
      return 1;
    case "exists":
      console.error(`Account already exists: ${name}. Use reset-password for a new password.`);
      return 1;
    case "ok":
      printPassword(result.username, result.password);
      return 0;
  }
}

async function resetCommand(db: Db, name: string): Promise<number> {
  const result = await resetPassword(db, name);
  if (result.kind === "not_found") {
    console.error(`No such account: ${name}`);
    return 1;
  }
  printPassword(result.username, result.password);
  return 0;
}

async function stateCommand(db: Db, name: string, enable: boolean): Promise<number> {
  const result = enable ? await enableUser(db, name) : await disableUser(db, name);
  if (result.kind === "not_found") {
    console.error(`No such account: ${name}`);
    return 1;
  }
  console.log(enable ? `Enabled: ${result.username}` : `Disabled, sessions ended: ${result.username}`);
  return 0;
}

async function userCommand(db: Db, command: string | undefined, name: string | undefined): Promise<number | null> {
  if (command === "list") return name === undefined ? listCommand(db) : null;
  if (name === undefined) return null;
  switch (command) {
    case "add":
      return addCommand(db, name);
    case "reset-password":
      return resetCommand(db, name);
    case "disable":
      return stateCommand(db, name, false);
    case "enable":
      return stateCommand(db, name, true);
    default:
      return null;
  }
}

async function throttleCommand(db: Db, command: string | undefined, name: string | undefined): Promise<number | null> {
  if (command !== "clear" || name === undefined) return null;
  const removed = await clearThrottleOf(db, name);
  console.log(`Blocks lifted for ${name}: ${String(removed)}`);
  return 0;
}

function reportPublish(outcome: PublishOutcome): number {
  switch (outcome.kind) {
    case "published":
      console.log("Published. It reaches the public site within about two minutes.");
      return 0;
    case "held":
      console.error(
        `The database is behind the published state. Still offline, not in the database: ${outcome.orphans
          .map((block) => block.slug)
          .join(", ")}. Lift one with city unblock, all of them with city publish --accept-database`,
      );
      return 1;
    case "failed":
      console.error(`Saved, but not published: ${outcome.message}. The panel retries every minute.`);
      return 1;
  }
}

async function cityListCommand(deps: CityDeps): Promise<number> {
  const [blocks, status] = await Promise.all([listBlocks(deps.db), publishStatus(deps.db)]);
  if (blocks.length === 0) console.log("No blocks.");
  else {
    console.table(
      blocks.map((block) => ({
        page: block.slug,
        name: block.name,
        key: block.key,
        since: block.blockedAt.toISOString(),
        by: block.blockedBy,
        reason: block.reason,
      })),
    );
  }
  console.log(`Last published: ${status.lastPublishedAt?.toISOString() ?? "never"}`);
  if (status.lastError !== null) console.log(`Last attempt failed: ${status.lastError}`);
  if (status.lastWarning !== null) console.log(`Warning: ${status.lastWarning}`);
  if (status.reimposed.length > 0) {
    console.log(`Brought back by a restored database: ${status.reimposed.map((block) => block.slug).join(", ")}`);
  }
  if (status.held.length > 0) {
    const held = status.held.map((block) => `${block.slug} (${block.key})`).join(", ");
    console.log(`Held (offline, not in the database): ${held}`);
  }
  return status.lastError === null && status.held.length === 0 ? 0 : 1;
}

function reasonFrom(rest: readonly string[]): string | null {
  const [flag, value, ...more] = rest;
  return flag === "--reason" && value !== undefined && more.length === 0 ? value : null;
}

async function cityChangeCommand(
  deps: CityDeps,
  command: "block" | "unblock",
  city: string,
  reason: string,
): Promise<number> {
  const change = { city, reason, actor: CLI_ACTOR };
  const result = command === "block" ? await blockCity(deps, change) : await unblockCity(deps, change);
  switch (result.kind) {
    case "unknown_city":
      console.error(`No such page: ${city}`);
      return 1;
    case "invalid_reason":
      console.error("The reason must be one line of 1–500 characters.");
      return 1;
    case "wrong_confirmation":
      console.error(`The name does not match: ${result.city.name}`);
      return 1;
    case "already_blocked":
      console.log(`Already blocked: ${result.city.slug}`);
      return reportPublish(await publishBlocks(deps));
    case "publish_failed":
      console.error(`The published state could not be read: ${result.message}`);
      return 1;
    case "not_blocked":
      console.log(`Not blocked: ${result.city.slug}`);
      return reportPublish(await publishBlocks(deps));
    case "ok":
      console.log(`${command === "block" ? "Blocked" : "Unblocked"}: ${result.city.slug} (${result.city.name})`);
      return reportPublish(result.publish);
  }
}

async function cityCommand(deps: CityDeps, args: readonly string[]): Promise<number | null> {
  const [command, first, ...rest] = args;
  if (command === "list") return first === undefined ? cityListCommand(deps) : null;
  if (command === "publish") {
    if (first === undefined) return reportPublish(await publishBlocks(deps));
    return first === "--accept-database" && rest.length === 0
      ? reportPublish(await acceptDatabase(deps, CLI_ACTOR))
      : null;
  }
  if ((command !== "block" && command !== "unblock") || first === undefined) return null;
  const reason = reasonFrom(rest);
  return reason === null ? null : cityChangeCommand(deps, command, first, reason);
}

async function dispatch(deps: CityDeps, args: readonly string[]): Promise<number | null> {
  const [group, command, name, ...rest] = args;
  if (group === "city") return cityCommand(deps, args.slice(1));
  if (rest.length > 0) return null;
  if (group === "user") return userCommand(deps.db, command, name);
  if (group === "throttle") return throttleCommand(deps.db, command, name);
  return null;
}

async function main(args: readonly string[]): Promise<number> {
  const app = getApp();
  try {
    // The CLI may run before the panel has ever started.
    await migrate(app.db);
    const code = await dispatch(app, args);
    if (code === null) console.error(USAGE);
    return code ?? 2;
  } finally {
    await app.db.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
