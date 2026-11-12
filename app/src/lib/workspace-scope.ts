import { LEFTOVER_NAV_SUFFIX, SHARED_PRESETS_SUFFIX } from './layout-presets';
import { ARRANGEMENTS_SUFFIX } from './island-arrangements';

/** The owner is also in the key to isolate in-flight client writes at login. */
export async function workspaceScope(owner: string, view: string, project: string | null): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([owner, view, project]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `v2.${Array.from(new Uint8Array(digest)).slice(0, 20).map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Where the named arrangements of a view are listed, projects confounded.
 *
 * A preset is applied to the CURRENT view, so it is stored away from the
 * project the user happened to be in when saving it: hashing with
 * `project = null` makes one chat's list the same list as every other chat's,
 * while the pathname keeps a cockpit's arrangements out of a chat's menu.
 *
 * The suffix is its own, and not `presets`: on a view that has no project,
 * `workspaceScope(owner, view, null)` IS the view's key, so reusing `presets`
 * would make the shared row collide with that view's own one. 43 + 15 = 58
 * characters, under the daemon's 64.
 */
export async function sharedPresetsScope(owner: string, view: string): Promise<string> {
  return `${await workspaceScope(owner, view, null)}.${SHARED_PRESETS_SUFFIX}`;
}

/** The keys of one workspace: its own, and those its rows had before. */
export type WorkspaceKeys = {
  key: string;
  sharedKey: string;
  /** `key` and `sharedKey` hashed with `previousOwner`, `null` without one. */
  previousKey: string | null;
  previousSharedKey: string | null;
};

/**
 * Every key a workspace's rows are read under, derived in ONE place for the
 * server render and the browser. `previousOwner` is the id a remote machine's
 * rows were hashed with before they followed the acting account
 * (`previousLayoutOwner`, TIM-0137): the rows the hook hands over from
 * (`lib/layout-handover.ts`), and the presets list the menu folds in.
 */
export async function workspaceKeys(owner: string, previousOwner: string | null, view: string, project: string | null): Promise<WorkspaceKeys> {
  const [key, sharedKey, previousKey, previousSharedKey] = await Promise.all([
    workspaceScope(owner, view, project),
    sharedPresetsScope(owner, view),
    previousOwner ? workspaceScope(previousOwner, view, project) : null,
    previousOwner ? sharedPresetsScope(previousOwner, view) : null,
  ]);
  return { key, sharedKey, previousKey, previousSharedKey };
}

/** Suffix the rail already wrote under each view key. Reused so leftovers stay readable. */
const NAV_SUFFIX = LEFTOVER_NAV_SUFFIX;

/**
 * Where the rail's pinned state lives, views and projects confounded.
 *
 * Pinning is a habit of the account, not of the page. Hashing with an empty
 * view and no project — the same drop `sharedPresetsScope` uses for the
 * project — makes `/` and `/chat` share one row. The empty view is not a
 * pathname, so the row never collides with a leftover written under a real
 * view's key.
 */
export async function sharedNavScope(owner: string): Promise<string> {
  const scope = `${await workspaceScope(owner, '', null)}.${NAV_SUFFIX}`;
  resolvedNavScopes.set(owner, scope);
  return scope;
}

/**
 * Rail scopes already derived in this document, by owner.
 *
 * The hash is async, and the rail is mounted again by every page: without this
 * its first paint after a navigation has no scope, so no pinned state, and
 * the rail shows collapsed until the hash and the read have answered (TIM-0105).
 */
const resolvedNavScopes = new Map<string, string>();

/** `sharedNavScope(owner)` when this document already derived it, else `null`. */
export function resolvedNavScope(owner: string | null): string | null {
  return owner ? resolvedNavScopes.get(owner) ?? null : null;
}

/** Whether a stored rail row says pinned. */
export function navPinnedOf(row: unknown): boolean {
  return !!row && typeof row === 'object' && (row as { pinned?: unknown }).pinned === true;
}

/** The per-view row VerticalNav used to write. Legacy handover only. */
export function leftoverNavScope(workspaceKey: string | null): string | undefined {
  return workspaceKey ? `${workspaceKey}.${NAV_SUFFIX}` : undefined;
}

/** Suffix of the row holding the top bar's pinned agent tabs. */
const STRIP_SUFFIX = 'strip';

/**
 * Where the agent strip's pinned tabs live, views and projects confounded.
 *
 * Which agents one keeps at hand is a habit of the account, like the rail's
 * pinned state: same derivation as `sharedNavScope`, its own suffix.
 */
export async function sharedStripScope(owner: string): Promise<string> {
  return `${await workspaceScope(owner, '', null)}.${STRIP_SUFFIX}`;
}

/** Suffix of the row holding the popups kept on every view. 43 + 7 = 50 characters. */
const PINNED_ISLANDS_SUFFIX = 'pinned';

/**
 * Where the popups a user keeps everywhere live (`docs/ISLAND-WORKSPACE.md`
 * §12): a habit of the account, like the rail's pinned state, so views and
 * projects are confounded and every view reads the same row.
 */
export async function sharedPinnedIslandsScope(owner: string): Promise<string> {
  return `${await workspaceScope(owner, '', null)}.${PINNED_ISLANDS_SUFFIX}`;
}

/**
 * Where the named island arrangements live (`lib/island-arrangements.ts`):
 * one list for the account, whatever the view, since an arrangement is laid
 * on any view and is a page of its own. 43 + 13 = 56 characters.
 */
export async function sharedArrangementsScope(owner: string): Promise<string> {
  return `${await workspaceScope(owner, '', null)}.${ARRANGEMENTS_SUFFIX}`;
}
