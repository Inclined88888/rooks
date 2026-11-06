'use client';

import { useEffect, useState } from 'react';

/**
 * An account-wide scope (the rail, the strip, the pinned popups) as it was
 * hashed with `previousOwner`: the row a remote machine's window wrote before
 * its scopes followed the acting account (TIM-0137), handed over once by
 * `useStoredLayout` (`lib/layout-handover.ts`).
 *
 * `undefined` while the hash is under way: the consumer holds its read until
 * then, since a first read made without the source marks the scope as read and
 * the handover would never happen. `null` when there is no previous owner —
 * at once, so that nothing waits on this computer.
 *
 * `derive` must be a stable function (a module export).
 */
export function usePreviousScope(
  previousOwner: string | null | undefined,
  derive: (owner: string) => Promise<string>,
): string | null | undefined {
  const [state, setState] = useState<{ owner: string; scope: string } | null>(null);
  useEffect(() => {
    if (!previousOwner) return;
    let alive = true;
    void derive(previousOwner).then((scope) => { if (alive) setState({ owner: previousOwner, scope }); });
    return () => { alive = false; };
  }, [previousOwner, derive]);
  if (!previousOwner) return null;
  return state?.owner === previousOwner ? state.scope : undefined;
}
