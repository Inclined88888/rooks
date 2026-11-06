'use client';

/**
 * Why a subscription account cannot be picked right now (TODO #52): to sign
 * in again, or out of quota. Shared by every LLM selector so the same account
 * reads the same everywhere. Renders nothing for a pickable entry, hence for
 * every plain backend.
 */

import { accountStateHint, accountStateLabel, type CatalogBackend } from '@/lib/backends';
import { cn } from '@/lib/utils';

export function AccountStateBadge({ backend, className }: {
  backend: CatalogBackend | null | undefined;
  className?: string;
}): React.ReactElement | null {
  const label = accountStateLabel(backend);
  if (!label) return null;
  return (
    <span
      title={accountStateHint(backend) ?? undefined}
      className={cn(
        'shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:text-amber-300',
        className,
      )}
    >
      {label}
    </span>
  );
}
