/**
 * Where an account's rights come from (seam C of the multi-user extraction).
 *
 * The core keeps the evaluator (`permissions.ts`) and the question
 * `dbApi.listPermissionsForUser(userId)`, asked on every request. The answer may
 * come from a plugin that holds the account directory in its own database
 * (`ctx.permissionSource`): one source at a time, synchronous like the auth path,
 * cached until the plugin says a role or a group changed. A source that throws
 * grants nothing: a broken directory never widens anyone's rights.
 *
 * With no source registered, an account other than a superadmin holds no right
 * at all: the core keeps no roles or groups of its own.
 */
export type PermissionSourceFn = (userId: string) => readonly string[];

type Held = { pluginId: string; fn: PermissionSourceFn; cache: Map<string, string[]> };

let held: Held | null = null;

export class PermissionSourceHeldError extends Error {}

/** The plugin that provides rights, `null` when none does (and nobody but a superadmin holds any). */
export function permissionSourceHolder(): string | null {
  return held?.pluginId ?? null;
}

export function registerPermissionSource(pluginId: string, fn: PermissionSourceFn): {
  invalidate(userId?: string): void;
  release(): void;
} {
  if (held && held.pluginId !== pluginId) {
    throw new PermissionSourceHeldError(`the permission source is held by plugin \`${held.pluginId}\``);
  }
  const mine: Held = { pluginId, fn, cache: new Map() };
  held = mine;
  return {
    invalidate(userId?: string) {
      if (held !== mine) return;
      if (userId === undefined) mine.cache.clear();
      else mine.cache.delete(userId);
    },
    release() {
      if (held === mine) held = null;
    },
  };
}

/**
 * The rights a registered source gives `userId`, or `undefined` when no source is
 * registered (the caller then reads the core's tables).
 */
export function permissionsFromSource(userId: string): string[] | undefined {
  const current = held;
  if (!current) return undefined;
  const cached = current.cache.get(userId);
  if (cached) return [...cached];
  let rights: string[];
  try {
    const answer = current.fn(userId);
    rights = Array.isArray(answer) ? [...new Set(answer.filter((p): p is string => typeof p === 'string' && p.length > 0))].sort() : [];
  } catch (err) {
    console.warn(`[permissions] source of plugin \`${current.pluginId}\` failed, no rights granted: ${(err as Error).message}`);
    return [];
  }
  current.cache.set(userId, rights);
  return [...rights];
}
