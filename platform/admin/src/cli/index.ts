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
import type { Db } from "#lib/server/db/client.ts";
import { migrate } from "#lib/server/db/migrate.ts";

/*
 * Operator CLI for the accounts of the admin panel, run inside the container:
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

Generated passwords are printed once and must be changed at the first login.`;

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

async function main(args: readonly string[]): Promise<number> {
  const [group, command, name, ...rest] = args;
  if ((group !== "user" && group !== "throttle") || rest.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const { db } = getApp();
  try {
    // The CLI may run before the panel has ever started.
    await migrate(db);
    const code = await (group === "user" ? userCommand(db, command, name) : throttleCommand(db, command, name));
    if (code === null) console.error(USAGE);
    return code ?? 2;
  } finally {
    await db.close();
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
