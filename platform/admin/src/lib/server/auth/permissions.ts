/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/**
 * Roles and what they may do: the one place to extend for a new feature. A route
 * is only reachable when it is listed in http/routes.ts with a permission.
 */
export const PERMISSIONS = ["overview:view", "account:manage-own"] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ["admin"] as const;

export type Role = (typeof ROLES)[number];

const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  admin: PERMISSIONS,
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function parseRole(value: string): Role {
  const role = ROLES.find((candidate) => candidate === value);
  if (role === undefined) throw new TypeError(`unknown role in the database: ${value}`);
  return role;
}
