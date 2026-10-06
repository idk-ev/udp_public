/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * The GBFS system list of MobiData BW, shared by `sharing-bw` (free floating)
 * and `carsharing-bw` (station based). Not a connector itself.
 *
 * One list, about 110 systems — sharing providers of Baden-Württemberg plus a
 * good number from Switzerland, Alsace and Bavaria. Which of their vehicles
 * count is decided per vehicle or station by the strict municipality lookup,
 * never by the system.
 *
 * ## Excluded systems (licence)
 *
 * Some providers' terms do not allow what the platform does with the feed
 * (storing it, building a dataset): Lime's GBFS terms forbid both, Bird's
 * terms are not cleared. Such systems are listed in the registry entry of
 * each GBFS connector (`excludeSystems`, pattern plus reason) and dropped
 * from the list before anything is fetched ({@link withoutExcluded}).
 *
 * ## Feed URLs are foreign data (security review)
 *
 * The feed URLs come out of the list as the providers registered them, and
 * the old nodes fetched them as given — so the list could aim the service at
 * anything it can reach: Orion, the admin port, the cloud metadata address.
 * A feed is fetched only if {@link allowedFeedUrl} accepts it: `https:`, no IP
 * literal in a private, loopback, link-local or otherwise special range, and
 * no single-label or cluster-internal host name. Redirects are followed
 * (third-party hosts move their feeds) under the same rule for every hop
 * ({@link FEED_FETCH}). A refused feed is skipped and counted; the connectors
 * report the count as ONE `[warn]` per run ({@link SkippedFeeds}). A host
 * name that RESOLVES to a private address is not caught here — that needs a
 * check at connect time (network policy / egress proxy).
 */

import { FetchUrlRefusedError } from "../kernel/fetcher.js";
import { isEntityId, isFiniteNumber, isRecord, isString, isTruthy } from "../kernel/parse.js";
import type { Ctx, EntityId, FetchOptions, Log, SystemExclusion } from "../kernel/types.js";

/** The `http request` node "GBFS-Systeme" of both flows. */
export const SYSTEMS_URL = "https://api.mobidata-bw.de/sharing/gbfs";

export interface GbfsSystem {
  /** `s.id` as the source spells it. */
  readonly id: string;
  /** `s.url`, the system's `gbfs` discovery URL. */
  readonly url: string;
}

/**
 * `msg.payload.systems`, or `null` when the answer is not a system list (the
 * old nodes' `!Array.isArray(msg.payload.systems)`). Entries without a string
 * URL or a scalar id are left out; the old nodes would have thrown on
 * `s.url.replace` and lost the whole run, and the list has never carried one.
 */
export function parseSystems(raw: unknown): readonly GbfsSystem[] | null {
  const systems = isRecord(raw) ? raw.systems : undefined;
  if (!Array.isArray(systems)) return null;
  const out: GbfsSystem[] = [];
  for (const entry of systems) {
    if (!isRecord(entry)) continue;
    const { id, url } = entry;
    if (!isString(url)) continue;
    if (isString(id)) out.push({ id, url });
    else if (isFiniteNumber(id)) out.push({ id: String(id), url });
  }
  return out;
}

/**
 * The prevailing `form_factor` of a `vehicle_types` list, on the raw strings:
 * the most frequent one, ties to the first sighting; a missing or non-string
 * form factor counts as `unbekannt`; `null` without any type. Shared by
 * `carsharing-bw` (FleetStatus.vehicleType) and `sharing-bw` (which docked
 * vehicles the station side counts), so the two always agree.
 */
export function prevailingFormFactor(types: unknown): string | null {
  const counts = new Map<string, number>();
  for (const type of Array.isArray(types) ? types : []) {
    if (!isRecord(type)) continue;
    const form = isTruthy(type.form_factor) && isString(type.form_factor) ? type.form_factor : "unbekannt";
    counts.set(form, (counts.get(form) ?? 0) + 1);
  }
  // Stable sort by count, descending: ties keep the order of first sighting.
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  return top === undefined ? null : top[0];
}

/* ------------------------------------------------------------------ exclusions */

/** `pattern` of an exclusion rule as an anchored regex: `*` matches any run of characters. */
function exclusionRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** The first rule of the registry's `excludeSystems` that matches a system id, or `null`. */
export function exclusionOf(id: string, rules: readonly SystemExclusion[]): SystemExclusion | null {
  return rules.find((rule) => exclusionRegex(rule.pattern).test(id)) ?? null;
}

/**
 * Splits the system list by the registry's `excludeSystems`. An excluded
 * system is neither fetched nor written — not even its `vehicle_types` —
 * because the reason is the provider's licence terms (storing the data or
 * building a dataset from it is not allowed or not cleared). What it wrote
 * before is deleted deliberately ({@link removeExcluded}), not left to the
 * age-based prune: there it would count as a loss against the share cap.
 */
export function withoutExcluded(
  systems: readonly GbfsSystem[],
  rules: readonly SystemExclusion[],
): { readonly kept: readonly GbfsSystem[]; readonly excluded: readonly GbfsSystem[] } {
  if (rules.length === 0) return { kept: systems, excluded: [] };
  const kept: GbfsSystem[] = [];
  const excluded: GbfsSystem[] = [];
  for (const system of systems) (exclusionOf(system.id, rules) === null ? kept : excluded).push(system);
  return { kept, excluded };
}

/** `value` as a literal part of a regular expression. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One kind of entity an excluded system may have written. */
export interface ExcludedScheme {
  readonly type: string;
  /** The anchored id scheme of ONE system's entities of this type. */
  readonly pattern: (system: string) => string;
  /** Attributes {@link accept} reads. */
  readonly attrs: readonly string[];
  /** Further ownership check of a listed entity (normalized form). */
  readonly accept?: (system: string, entity: Readonly<Record<string, unknown>>) => boolean;
  /** Gate tables keyed by entity id whose entries of deleted ids go. */
  readonly signatureKeys?: readonly string[];
}

/**
 * Deletes what the excluded systems of this run's list wrote before their
 * exclusion: per system and scheme, the listed ids its anchored pattern
 * matches (checked again locally, plus `accept`), through
 * `ctx.prune.remove` (master data plausible, signatures out of the store
 * first). Deliberately not left to the age-based prune — a whole provider
 * at once would count as a loss against its share cap and block it. A
 * system whose key is also a kept system's is not touched. Returns the
 * number of deleted entities; an empty listing costs one read per system
 * and scheme.
 */
export async function removeExcluded(
  ctx: Ctx,
  label: string,
  split: { readonly kept: readonly GbfsSystem[]; readonly excluded: readonly GbfsSystem[] },
  schemes: readonly ExcludedScheme[],
): Promise<number> {
  const kept = new Set(split.kept.map((system) => systemKey(system.id)));
  const systems = new Set(
    split.excluded.map((system) => systemKey(system.id)).filter((key) => !kept.has(key)),
  );
  let deleted = 0;
  for (const system of systems) {
    for (const scheme of schemes) {
      const pattern = scheme.pattern(system);
      const own = new RegExp(pattern);
      const listing = await ctx.orion.list(
        { type: scheme.type, idPattern: pattern, attrs: scheme.attrs },
        { maxPages: 100 },
      );
      if (!listing.ok) {
        ctx.log.warn(
          `${label} ${system}: ${scheme.type} of the excluded system not listed (${listing.reason})`,
        );
        continue;
      }
      const ids: EntityId[] = [];
      for (const entity of listing.entities) {
        if (!isRecord(entity) || !isEntityId(entity.id) || !own.test(entity.id)) continue;
        if (scheme.accept !== undefined && !scheme.accept(system, entity)) continue;
        ids.push(entity.id);
      }
      const result = await ctx.prune.remove({
        label: `${label} ${system}: ${scheme.type} of an excluded system`,
        pattern,
        ids,
        signatureKeys: scheme.signatureKeys,
      });
      deleted += result.deleted.size;
    }
  }
  return deleted;
}

/** `s.url.replace(/\/gbfs$/, '/<feed>')`. */
export function feedUrl(system: GbfsSystem, feed: string): string {
  return system.url.replace(/\/gbfs$/, `/${feed}`);
}

/* ------------------------------------------------------------------ URL policy */

/** IPv4 ranges a feed must not point into: base address and prefix length. */
const BLOCKED_V4: readonly (readonly [base: readonly number[], bits: number])[] = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, cloud metadata
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[224, 0, 0, 0], 3], // multicast, reserved, broadcast
];

/** Host name suffixes that only resolve inside a cluster or host. */
const INTERNAL_SUFFIXES: readonly string[] = [".localhost", ".local", ".svc", ".internal"];

function v4Octets(host: string): readonly number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function blockedV4(octets: readonly number[]): boolean {
  const value = octets.reduce((sum, octet) => sum * 256 + octet, 0);
  return BLOCKED_V4.some(([base, bits]) => {
    const start = base.reduce((sum, octet) => sum * 256 + octet, 0);
    const size = 2 ** (32 - bits);
    return value >= start && value < start + size;
  });
}

/**
 * Whether a GBFS feed URL may be fetched. The WHATWG parser has already
 * normalised the host: lowercase, IPv4 in dotted form (`2130706433` and
 * `0x7f.1` arrive as `127.0.0.1`), IPv6 in brackets.
 */
export function allowedFeedUrl(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  const host = url.hostname.replace(/\.$/, "");
  if (host.startsWith("[")) {
    // IPv6 literal: only global unicast (2000::/3). Loopback, link-local,
    // unique-local, multicast and IPv4-mapped addresses all lie outside it.
    const first = Number.parseInt(host.slice(1).split(":")[0] ?? "", 16);
    return Number.isFinite(first) && first >= 0x2000 && first <= 0x3fff;
  }
  const v4 = v4Octets(host);
  if (v4 !== null) return !blockedV4(v4);
  if (!host.includes(".")) return false; // `localhost`, Compose service names
  return !INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Whether a feed URL string may be fetched; an unparseable one may not. */
export function feedAllowed(url: string): boolean {
  try {
    return allowedFeedUrl(new URL(url));
  } catch {
    return false;
  }
}

/** Options of every feed request: redirects followed, every hop under the URL policy. */
export const FEED_FETCH: FetchOptions = { redirect: "follow", allowUrl: allowedFeedUrl };

/** Feeds a run skipped under the URL policy, reported once at the end of the run. */
export class SkippedFeeds {
  #count = 0;
  #first = "";

  note(url: string): void {
    if (this.#count === 0) this.#first = url;
    this.#count += 1;
  }

  /** Records `error` if it is a refusal by the URL policy (a redirect hop); says whether it was. */
  noteRefusal(error: unknown): boolean {
    if (!(error instanceof FetchUrlRefusedError)) return false;
    this.note(error.target);
    return true;
  }

  get count(): number {
    return this.#count;
  }

  /** One `[warn]` for the whole run, if anything was skipped. */
  report(log: Log, label: string): void {
    if (this.#count === 0) return;
    log.warn(
      `${label}: ${String(this.#count)} feed URLs refused by the URL policy and skipped (first: ${this.#first})`,
    );
  }
}

/**
 * `String(msg.system).replace(/[^A-Za-z0-9_-]+/g, '-')` — the system as it
 * appears in entity ids and table keys. Not a slug of free text: the GBFS
 * system id is the provider's own stable key.
 */
export function systemKey(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, "-");
}
