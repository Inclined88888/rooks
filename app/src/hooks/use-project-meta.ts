'use client';

import { useEffect, useState } from 'react';
import { sharedGet } from '@/lib/shared-read';

export type ProjectMeta = {
  color: string | null;
  icon: string | null;
  name: string | null;
};

/**
 * A project's real color + logo, indexed by slug. Shared: a single
 * `/api/ui/projects` fetch per component that mounts the hook (the Kanban
 * needs it for N cards — the table loads once, not per card).
 */
export function useProjectMeta(): Map<string, ProjectMeta> {
  const [map, setMap] = useState<Map<string, ProjectMeta>>(() => new Map());
  useEffect(() => {
    let off = false;
    sharedGet('/api/ui/projects')
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((j) => {
        if (off) return;
        const m = new Map<string, ProjectMeta>();
        const arr = (j.projects ?? []) as Array<{
          slug: string;
          color?: string | null;
          icon?: string | null;
          name?: string | null;
        }>;
        for (const p of arr) {
          m.set(p.slug, { color: p.color ?? null, icon: p.icon ?? null, name: p.name ?? null });
        }
        setMap(m);
      })
      .catch(() => {});
    return () => { off = true; };
  }, []);
  return map;
}
