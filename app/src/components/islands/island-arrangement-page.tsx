'use client';

/**
 * The page a named arrangement becomes (`/islands/<id>`).
 *
 * A view like any other (`docs/ISLAND-WORKSPACE.md` §4): its own key, its
 * own `.islands` row. What makes it the arrangement's page is that an empty
 * row is filled with the arrangement when the page is shown — so the first
 * visit opens it, and what the user then changes stays on this page without
 * touching the arrangement. This component is the route's own tab: the
 * island that, on any other view, holds the page the URL names.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { useStoredLayout } from '@/hooks/use-stored-layout';
import { t } from '@/lib/i18n';
import { arrangementIdOf } from '@/lib/island-arrangements';
import { useArrangements } from '@/lib/island-arrangements-store';
import { islandsScope, recallArrangement } from '@/lib/island-arrangements-io';
import { useIslandContentTypes } from './island-content';

export function IslandArrangementPage() {
  const pathname = usePathname();
  const id = arrangementIdOf(pathname);
  const { key, owner, view } = useWorkspaceLayout();
  // The provider follows the route one render late: until it names this
  // page, its key is the previous view's, and seeding it would lay the
  // arrangement on a page the user just left.
  const here = key && view === pathname ? key : null;
  const { arrangements, ready } = useArrangements(owner);
  const arrangement = useMemo(() => arrangements.find((a) => a.id === id) ?? null, [arrangements, id]);
  const registered = useIslandContentTypes();
  const types = useMemo(() => new Map([...registered].map(([typeId, type]) => [typeId, type.options])), [registered]);
  const row = useStoredLayout(here ? islandsScope(here) : null);
  const [busy, setBusy] = useState(false);

  // Once per scope and per visit: the row comes back empty when the user
  // brings the page down to itself, and that gesture must hold until they
  // leave — the next visit shows the arrangement again.
  const seeded = useRef(new Set<string>());
  useEffect(() => {
    if (!here || !arrangement || !row.ready || row.raw !== null) return;
    const scope = islandsScope(here);
    if (seeded.current.has(scope)) return;
    seeded.current.add(scope);
    void recallArrangement(here, arrangement, types);
  }, [here, arrangement, row.ready, row.raw, types]);

  const restore = async () => {
    if (!here || !arrangement) return;
    setBusy(true);
    try {
      if (await recallArrangement(here, arrangement, types) === 'failed') toast.error(t('islands.arrangementPage.restoreFailed'));
    } finally { setBusy(false); }
  };

  return (
    <main className="flex h-full flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      {!ready ? (
        <p className="text-sm text-muted-foreground">{t('islands.arrangementPage.loading')}</p>
      ) : !arrangement ? (
        <p className="text-sm text-muted-foreground">{t('islands.arrangementPage.missing')}</p>
      ) : (
        <>
          <h1 className="text-base font-semibold">{arrangement.name}</h1>
          <p className="max-w-sm text-sm leading-snug text-muted-foreground">{t('islands.arrangementPage.hint')}</p>
          <Button size="sm" variant="secondary" disabled={busy || !here} onClick={() => void restore()}>
            {t('islands.arrangementPage.restore')}
          </Button>
        </>
      )}
    </main>
  );
}
