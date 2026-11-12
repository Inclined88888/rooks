'use client';

import { useEffect, useState } from 'react';
import { fetchMe, meCan, type AuthMe, type MePermission } from '@/lib/auth';
import { permissionAccess, type PermissionAccess } from '@/lib/permission-refusal';

/**
 * The signed-in account, shared between the surfaces that show it.
 *
 * A plain per-component effect was enough while `/api/auth/me` only fed one
 * chip in the header. It no longer is: the profile page edits the very thing
 * the sidebar avatar paints, and two independent copies would leave the old
 * initials in the rail until the next full reload. Hence one module-level
 * value plus subscribers, and `refreshMe()` after a save.
 */

let cached: AuthMe | null = null;
let inFlight: Promise<AuthMe> | null = null;
const listeners = new Set<(me: AuthMe) => void>();

function publish(me: AuthMe): void {
  cached = me;
  for (const listener of listeners) listener(me);
}

/** Re-reads `/api/auth/me` and notifies every mounted consumer. */
export async function refreshMe(): Promise<AuthMe> {
  const request = fetchMe().then((me) => { publish(me); return me; });
  inFlight = request;
  try {
    return await request;
  } finally {
    if (inFlight === request) inFlight = null;
  }
}

/** `null` until the first answer comes back — callers must fail closed on it. */
export function useMe(): AuthMe | null {
  const [me, setMe] = useState<AuthMe | null>(cached);
  useEffect(() => {
    listeners.add(setMe);
    // One request for the whole page: a second consumer mounting mid-flight
    // waits on the same promise instead of opening its own.
    // An unreachable daemon leaves `null`: every `useCan` stays closed, and no
    // rejection escapes a component that only wanted to know a permission.
    if (cached === null && inFlight === null) void refreshMe().catch(() => undefined);
    else if (cached === null && inFlight !== null) void inFlight.then(setMe, () => undefined);
    return () => { listeners.delete(setMe); };
  }, []);
  return me;
}

/** Whether the signed-in account holds `permission`; `null` until known. */
export function useCan(permission: MePermission): boolean | null {
  return meCan(useMe(), permission);
}

/** `useCan` for a control: whether to enable it, and why it is not. */
export function useAccess(permission: MePermission): PermissionAccess {
  return permissionAccess(useCan(permission), permission);
}
