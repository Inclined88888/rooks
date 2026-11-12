/**
 * What the root layout needs to know of the active machine before it renders
 * anything (TODO #329, P3d).
 *
 * The cockpit of a remote machine is only worth mounting when that machine
 * answers and speaks a contract this app drives. Otherwise every widget,
 * stream and plugin would fire refusals at a screen nobody can use — the same
 * reason the licence lock is decided on the server. So, for a remote target:
 *
 *   - one probe of its `/api/capabilities` through the relay (reachable?
 *     which `apiLevel`?), alongside
 *   - one read of the LOCAL fleet (`/api/machines`, anchored): the machine's
 *     name, the account this computer acts as there, its last recorded level.
 *
 * A machine that cannot be used is `blocked`, with the reason the screen
 * explains and a way back to this computer — unless the local session itself
 * is gone (`signed_out`): then the login page is what must show. A 403 from the probe is not a
 * block: it is what a licence-locked daemon answers, and the lock screen —
 * which offers the same way back — takes over.
 */
import type { ColorScheme } from '../auth';
import type { ActingAccount } from './acting-account';
import { readActingAccount, type ActingRead } from './acting-me';
import { apiLevelVerdict, type ApiLevelVerdict } from './api-level';
import type { CredentialFailure } from './credential';
import { localTarget, type Target } from './target';

export type BlockReason = CredentialFailure | 'unreachable' | 'unauthorized' | 'incompatible';

export type RemoteAccount = { email: string | null; name: string | null; isSuperadmin: boolean };

export type ActiveMachine =
  | { kind: 'local' }
  | {
    kind: 'remote';
    id: string;
    name: string | null;
    account: RemoteAccount | null;
    /** Who the device acts as there, read from that machine itself (its
     *  id is not in the fleet): the owner of the page's layout scopes. */
    acting: ActingAccount;
    apiLevel: number | null;
    verdict: ApiLevelVerdict;
  }
  | { kind: 'blocked'; id: string; name: string | null; reason: BlockReason; apiLevel: number | null }
  /** A remote machine is named, but there is no valid local session to reach
   *  it with (expired, signed out elsewhere). Not a block: the login page must
   *  render, and every relay answers 401 until the person signs in again. */
  | { kind: 'signed_out'; id: string };

/** One server-side read; the layout passes `fetchForRender`. */
export type RenderRead = (path: string, target: Target) => Promise<globalThis.Response>;

type FleetRow = {
  id?: unknown;
  name?: unknown;
  api_level?: unknown;
  remote_user?: { email?: unknown; name?: unknown; is_superadmin?: unknown } | null;
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function level(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

async function fleetRow(read: RenderRead, id: string): Promise<FleetRow | null> {
  try {
    const res = await read('/api/machines', localTarget());
    if (!res.ok) return null;
    const body = await res.json() as { machines?: FleetRow[] };
    return body.machines?.find((row) => row.id === id) ?? null;
  } catch {
    return null;
  }
}

type Probe = { kind: 'ok'; apiLevel: number | null } | { kind: 'locked' } | { kind: 'unauthorized' } | { kind: 'unreachable' };

async function probe(read: RenderRead, target: Target): Promise<Probe> {
  try {
    const res = await read('/api/capabilities', target);
    if (res.ok) {
      const body = await res.json().catch(() => ({})) as { apiLevel?: unknown };
      return { kind: 'ok', apiLevel: level(body.apiLevel) };
    }
    void res.body?.cancel().catch(() => {});
    // The device token was revoked or expired on that machine.
    if (res.status === 401) return { kind: 'unauthorized' };
    if (res.status === 403) return { kind: 'locked' };
    return { kind: 'unreachable' };
  } catch {
    // Timed out or refused at the socket.
    return { kind: 'unreachable' };
  }
}

export async function describeActiveMachine(
  target: Target,
  read: RenderRead,
  readAccount: ActingRead = readActingAccount,
): Promise<ActiveMachine> {
  if (target.kind === 'local') return { kind: 'local' };
  if (target.kind === 'unavailable') {
    if (target.failure === 'session_required') return { kind: 'signed_out', id: target.id };
    const row = await fleetRow(read, target.id);
    return { kind: 'blocked', id: target.id, name: text(row?.name), reason: target.failure, apiLevel: null };
  }
  const [seen, row, acting] = await Promise.all([probe(read, target), fleetRow(read, target.id), readAccount(target)]);
  const name = text(row?.name);
  const recorded = level(row?.api_level);
  if (seen.kind === 'unreachable' || seen.kind === 'unauthorized') {
    return { kind: 'blocked', id: target.id, name, reason: seen.kind, apiLevel: recorded };
  }
  // A locked daemon says nothing of itself: its last recorded level stands in.
  const apiLevel = seen.kind === 'ok' ? seen.apiLevel : recorded;
  const verdict = apiLevelVerdict(apiLevel);
  if (verdict === 'too_old') return { kind: 'blocked', id: target.id, name, reason: 'incompatible', apiLevel };
  const user = row?.remote_user;
  const account: RemoteAccount | null = user
    ? { email: text(user.email), name: text(user.name), isSuperadmin: user.is_superadmin === true }
    : null;
  return { kind: 'remote', id: target.id, name, account, acting, apiLevel, verdict };
}

/**
 * The owner the server render hashes layout scopes with
 * (`acting-account.ts`): the local session's account here, the acting one on
 * a remote — and nobody without a local session, or on a remote that did not
 * say who the device is there.
 */
export function workspaceOwner(localOwner: string | null, machine: ActiveMachine): string | null {
  if (!localOwner) return null;
  if (machine.kind === 'local') return localOwner;
  if (machine.kind === 'remote') return machine.acting.user?.id ?? null;
  return null;
}

/**
 * The light/dark mode the server render paints: the active machine's, chosen
 * by the account this computer acts as there, so a window on another machine
 * is not painted with this one's mode then flipped (`schemeOfMe`, client
 * side). The local choice where that machine did not say — and on a blocked
 * one, whose screen belongs to this computer.
 */
export function activeScheme(localScheme: ColorScheme, machine: ActiveMachine): ColorScheme {
  return machine.kind === 'remote' ? machine.acting.scheme ?? localScheme : localScheme;
}
