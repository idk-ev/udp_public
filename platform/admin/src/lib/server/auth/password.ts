/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
import { Limiter } from "./limiter.ts";

/** OWASP minimum for Argon2id. Raised values apply to a user at the next login. */
export const CURRENT_PARAMS = { memory: 19_456, passes: 2, parallelism: 1 } as const;

const TAG_LENGTH = 32;
const SALT_LENGTH = 16;
/** Sanity bound for what a stored hash may ask for (1 GiB). */
const MAX_MEMORY_KIB = 1_048_576;

interface Argon2Params {
  memory: number;
  passes: number;
  parallelism: number;
}

/**
 * Two at a time, which bounds the memory. The queue may be long, as a waiting
 * request costs next to nothing: during a flood a real user waits their turn, while
 * with a short queue they could only hit the rare moment it has a free place.
 */
export const PASSWORD_SLOTS = 2;
export const PASSWORD_QUEUE = 64;

const slots = new Limiter(PASSWORD_SLOTS, PASSWORD_QUEUE);

/**
 * Runs a whole password operation of the panel in one of few slots. The slot comes
 * first: a request refused as busy (BusyError) has not touched the database, and
 * each Argon2 run inside takes its full memory cost. The operator CLI is its own
 * process and does not need a slot.
 */
export function withPasswordSlot<T>(work: () => Promise<T>): Promise<T> {
  return slots.run(work);
}

function derive(password: string, salt: Buffer, params: Argon2Params, length: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    argon2("argon2id", { message: password, nonce: salt, tagLength: length, ...params }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function b64(data: Buffer): string {
  return data.toString("base64").replace(/=+$/, "");
}

/** PHC string: the parameters travel with the hash, so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, CURRENT_PARAMS, TAG_LENGTH);
  const { memory, passes, parallelism } = CURRENT_PARAMS;
  return `$argon2id$v=19$m=${String(memory)},t=${String(passes)},p=${String(parallelism)}$${b64(salt)}$${b64(key)}`;
}

interface ParsedHash extends Argon2Params {
  salt: Buffer;
  key: Buffer;
}

function parseHash(encoded: string): ParsedHash {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(encoded);
  const [, m, t, p, salt, key] = match ?? [];
  if (m === undefined || t === undefined || p === undefined || salt === undefined || key === undefined) {
    throw new Error("stored password hash has an unknown format");
  }
  const memory = Number(m);
  if (memory > MAX_MEMORY_KIB) throw new Error("stored password hash asks for too much memory");
  return {
    memory,
    passes: Number(t),
    parallelism: Number(p),
    salt: Buffer.from(salt, "base64"),
    key: Buffer.from(key, "base64"),
  };
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const { salt, key, ...params } = parseHash(encoded);
  const candidate = await derive(password, salt, params, key.length);
  return timingSafeEqual(candidate, key);
}

export function needsRehash(encoded: string): boolean {
  const { memory, passes, parallelism } = parseHash(encoded);
  return memory < CURRENT_PARAMS.memory || passes < CURRENT_PARAMS.passes || parallelism < CURRENT_PARAMS.parallelism;
}

let dummyHash: string | undefined;

/**
 * Computed at server start, and only a finished value is ever kept: a failure can
 * never stay cached and turn every unknown name into an error.
 */
export async function prepareDummyHash(): Promise<string> {
  dummyHash ??= await hashPassword(randomBytes(32).toString("base64"));
  return dummyHash;
}

/** Spends the time of a real check, so an unknown name answers no faster. */
export async function verifyAgainstNothing(password: string): Promise<void> {
  await verifyPassword(password, await prepareDummyHash());
}
