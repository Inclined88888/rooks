/**
 * Who this browser acts as on the active machine (TODO #646, rest of #553).
 *
 * Two accounts meet when a remote machine is active. The SESSION is local:
 * `/api/auth/*` stays on this computer, so login, logout, profile, password
 * and the rail's avatar menu are the local account's. Everything else is
 * relayed with this computer's device token, and the remote daemon answers it
 * as the account that device was paired with — another id, maybe another
 * name, other permissions.
 *
 * What depends on the machine therefore has to be computed with THAT account:
 *  - the layout scopes. The daemon keys its rows by its own caller AND hashes
 *    the scope with an owner (`workspaceScope`); an agent of that machine
 *    (`widgets_get`, `islands_get`, `nav_get`) and that machine's own
 *    interface hash with the remote id. Hashed here with the local id, the
 *    rows were another set altogether: what an agent there read or proposed
 *    was never what this screen showed, and the seeds missed;
 *  - the permissions (`can`) that grey a control whose route is relayed;
 *  - "is this mine?" on objects of that machine (a mission's owner).
 *
 * Pure and client-safe: the server read lives in `acting-me.ts`.
 */
import type { ColorScheme, MePermission, PublicUser } from '../auth';

/** The account the device token stands for on the active remote machine. */
export type ActingUser = Pick<PublicUser, 'id' | 'email' | 'name' | 'is_superadmin' | 'avatar_url'>;

/**
 * What `/api/ui/auth/me` adds when a remote machine is active. `user` is
 * `null` when that machine could not say who the device is: nothing is then
 * computed under a guessed identity, and no layout row is written.
 */
export type ActingAccount = {
  machine: string;
  user: ActingUser | null;
  /** `null`: a daemon older than the field, as in `AuthMe.can`. */
  can: Partial<Record<MePermission, boolean>> | null;
  /** The light/dark mode that account chose there: each machine keeps its
   *  own, like its primary colour. Absent when that machine did not say. */
  scheme?: ColorScheme;
};

const PERMISSIONS: readonly MePermission[] = ['projects:manage', 'agents:manage', 'agents:privileged-config'];
const ID_MAX = 128;
const TEXT_MAX = 320;
const AVATAR_MAX = 2048;

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

/** `can` as a daemon sends it, unknown keys dropped. `null` when absent. */
export function parseCan(raw: unknown): Partial<Record<MePermission, boolean>> | null {
  if (!raw || typeof raw !== 'object') return null;
  const can: Partial<Record<MePermission, boolean>> = {};
  for (const permission of PERMISSIONS) {
    const value = (raw as Record<string, unknown>)[permission];
    if (typeof value === 'boolean') can[permission] = value;
  }
  return can;
}

/** `prefs.scheme` as a daemon sends it; `null` for anything else. */
export function parseScheme(raw: unknown): ColorScheme | null {
  return raw === 'light' || raw === 'dark' ? raw : null;
}

/** The `user` of a daemon's `/api/auth/me`, checked field by field: it comes
 *  from another machine. `null` for anything that is not an account. */
export function parseActingUser(raw: unknown): ActingUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const user = raw as Record<string, unknown>;
  const id = text(user.id, ID_MAX);
  if (!id) return null;
  const avatar = text(user.avatar_url, AVATAR_MAX);
  return {
    id,
    email: text(user.email, TEXT_MAX) ?? '',
    name: text(user.name, TEXT_MAX) ?? '',
    is_superadmin: user.is_superadmin === true,
    // A relative path only: it is fetched through this origin's relay. An
    // absolute URL from another machine would point the browser anywhere.
    avatar_url: avatar && avatar.startsWith('/') && !avatar.startsWith('//') ? avatar : null,
  };
}

/** The `acting` block of `/api/ui/auth/me`, or `null` (local machine, or
 *  anything malformed). */
export function parseActingAccount(raw: unknown): ActingAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const machine = text(body.machine, ID_MAX);
  if (!machine) return null;
  const user = parseActingUser(body.user);
  const scheme = user ? parseScheme(body.scheme) : null;
  return { machine, user, can: parseCan(body.can), ...(scheme ? { scheme } : {}) };
}

/**
 * The owner every layout scope is hashed with, from a `/api/ui/auth/me`
 * body: the local account on this computer, the acting one on a remote.
 * `null` when there is no session, or a remote that did not say: no scope,
 * no seed, no write — never the local id in its place, which would read and
 * write rows nobody else on that machine sees.
 */
export function workspaceOwnerOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { user, acting } = body as { user?: { id?: unknown } | null; acting?: unknown };
  if (typeof user?.id !== 'string' || !user.id) return null;
  if (acting === undefined || acting === null) return user.id;
  return parseActingAccount(acting)?.user?.id ?? null;
}

/**
 * The owner a remote's layout scopes were hashed with BEFORE they followed
 * the acting account (TIM-0137): the local session's id, when it is not the
 * owner they are hashed with now. Up to 0.1.6-rc.6 a window on a remote
 * hashed with the local id, and the remote daemon still holds those rows
 * under the device's account — the very caller that reads them now, so
 * reading them back crosses no account. `null` on this computer, and
 * wherever there is no owner to hand them over to.
 */
export function previousLayoutOwner(localOwner: string | null, owner: string | null): string | null {
  return localOwner && owner && localOwner !== owner ? localOwner : null;
}

/** `previousLayoutOwner` from a `/api/ui/auth/me` body. */
export function previousLayoutOwnerOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { user } = body as { user?: { id?: unknown } | null };
  const local = typeof user?.id === 'string' && user.id ? user.id : null;
  return previousLayoutOwner(local, workspaceOwnerOf(body));
}

/**
 * The light/dark mode of the page, from a `/api/ui/auth/me` body: the one the
 * acting account chose on the active machine, so two windows on two machines
 * keep two modes. Where that machine did not say (unreachable, an account it
 * could not name), the local choice stands in: it is what this computer shows
 * until the machine has one of its own. `null` when neither says.
 */
export function schemeOfMe(body: unknown): ColorScheme | null {
  if (!body || typeof body !== 'object') return null;
  const { prefs, acting } = body as { prefs?: { scheme?: unknown } | null; acting?: unknown };
  return parseActingAccount(acting)?.scheme ?? parseScheme(prefs?.scheme);
}
