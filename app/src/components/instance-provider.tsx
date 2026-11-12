'use client';

/**
 * Client half of the instance identity (`src/lib/instance.ts`).
 *
 * The variant is a server-side reading of `process.env`, deliberately absent
 * from the client bundle: the root layout resolves it and seeds it here, so no
 * build ever bakes "DEV" into artefacts that ship to a user. Components read
 * the identity instead of importing BRAND directly whenever what they paint is
 * allowed to differ between the maintainer's development copy and the product.
 *
 * The context default is the RELEASE identity. Anything rendered outside the
 * provider — a plugin mounting the logotype on its own, a test — therefore
 * shows the product, never a stray DEV badge.
 */

import { createContext, useContext } from 'react';
import { cn } from '@/lib/utils';
import { RELEASE_INSTANCE, type InstanceIdentity } from '@/lib/instance';
import { useDevProductLogo } from '@/lib/dev-logo';

const InstanceContext = createContext<InstanceIdentity>(RELEASE_INSTANCE);

export function InstanceProvider({
  value,
  children,
}: {
  value: InstanceIdentity;
  children: React.ReactNode;
}) {
  return <InstanceContext.Provider value={value}>{children}</InstanceContext.Provider>;
}

export function useInstance(): InstanceIdentity {
  return useContext(InstanceContext);
}

/**
 * The pill next to the logotype. Renders nothing in the product — its whole
 * job is to make a development window impossible to mistake for the real one
 * at a glance, so it is amber rather than muted, and it is NOT translated:
 * "DEV" is an instance marker, the same string in every locale.
 */
export function InstanceBadge({ className }: { className?: string }) {
  const { badge, variant } = useInstance();
  // The logo's "product logo" switch hides the pill too: a screenshot shows neither.
  const [productLogo] = useDevProductLogo();
  if (!badge || (variant === 'dev' && productLogo)) return null;
  return (
    <span
      className={cn(
        'shrink-0 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400',
        className,
      )}
    >
      {badge}
    </span>
  );
}
