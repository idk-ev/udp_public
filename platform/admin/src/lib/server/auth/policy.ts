/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { randomBytes } from "node:crypto";

/**
 * Password rules. There is no second factor (yet) and the login block is per
 * account and address, so a distributed guess is only stopped by the password
 * itself: at least 15 characters, as NIST SP 800-63B asks for single-factor
 * passwords, no composition rules, and not on a list of breached passwords.
 */
export const MIN_PASSWORD_LENGTH = 15;
export const MAX_PASSWORD_LENGTH = 256;

const MIN_DISTINCT_CHARACTERS = 5;
/** 24 random bytes: 192 bits, 32 characters in base64url. */
const GENERATED_PASSWORD_BYTES = 24;
/** A list this short means the bundled file is damaged: fail, do not wave through. */
const MIN_BREACHED_ENTRIES = 10_000;

/**
 * breached-passwords.txt: passwords of 15+ characters from public breach lists, in
 * lower case, one per line (scripts/generate-breached-passwords.py).
 */
function loadBreached(): ReadonlySet<string> {
  const [file] = Object.values(
    import.meta.glob("./breached-passwords.txt", { query: "?raw", import: "default", eager: true }),
  );
  if (typeof file !== "string") throw new TypeError("breached-passwords.txt is missing from the bundle");
  const entries = new Set(file.split("\n").filter((line) => line !== ""));
  if (entries.size < MIN_BREACHED_ENTRIES) throw new Error("breached-passwords.txt is too short");
  return entries;
}

let breached: ReadonlySet<string> | undefined;

function isBreached(lowerCased: string): boolean {
  breached ??= loadBreached();
  return breached.has(lowerCased);
}

/** The whole password is one unit repeated: "abcabcabcabcabc". */
const REPEATED_UNIT = /^(.+?)\1+$/su;

export type PolicyViolation = "too_short" | "too_long" | "too_simple" | "common" | "contains_username";

export function checkPassword(password: string, username: string): PolicyViolation | null {
  const characters = Array.from(password);
  if (characters.length < MIN_PASSWORD_LENGTH) return "too_short";
  if (characters.length > MAX_PASSWORD_LENGTH) return "too_long";
  const lower = password.toLowerCase();
  if (isBreached(lower)) return "common";
  if (new Set(characters).size < MIN_DISTINCT_CHARACTERS || REPEATED_UNIT.test(lower)) return "too_simple";
  if (lower.includes(username.toLowerCase())) return "contains_username";
  return null;
}

export const POLICY_MESSAGES: Readonly<Record<PolicyViolation, string>> = {
  too_short: `Das Passwort braucht mindestens ${String(MIN_PASSWORD_LENGTH)} Zeichen.`,
  too_long: `Das Passwort darf höchstens ${String(MAX_PASSWORD_LENGTH)} Zeichen haben.`,
  too_simple: "Das Passwort wiederholt sich zu stark.",
  common: "Dieses Passwort steht auf Listen veröffentlichter Passwörter. Bitte wähle ein anderes.",
  contains_username: "Das Passwort darf den Benutzernamen nicht enthalten.",
};

/** A password the operator hands over once; it always passes the policy. */
export function generatePassword(username: string): string {
  for (;;) {
    const password = randomBytes(GENERATED_PASSWORD_BYTES).toString("base64url");
    if (checkPassword(password, username) === null) return password;
  }
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/** Lower case, 3–64 characters; null when the name is not acceptable. */
export function normalizeUsername(input: string): string | null {
  const name = input.trim().toLowerCase();
  return USERNAME.test(name) ? name : null;
}
