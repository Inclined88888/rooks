'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { hydrateCustomRoles } from '@/lib/roles';

/**
 * Hydrates user-defined custom roles into the (sync) module cache of
 * `@/lib/roles` once on mount, then bumps a version so subscribed components
 * (RoleBadge via useRolesVersion) re-render to pick them up. Built-in roles
 * resolve synchronously without this; only custom roles depend on it.
 */
const RolesVersionContext = createContext(0);

export function useRolesVersion(): number {
  return useContext(RolesVersionContext);
}

export function RolesProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/ui/agent-roles', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { roles: [] }))
      .then((j) => {
        if (cancelled) return;
        const custom = (j.roles || []).filter(
          (r: { builtin?: boolean; iconSvg?: string }) => r.builtin === false && r.iconSvg,
        );
        if (custom.length) {
          hydrateCustomRoles(custom);
          setVersion((v) => v + 1);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <RolesVersionContext.Provider value={version}>{children}</RolesVersionContext.Provider>
  );
}
