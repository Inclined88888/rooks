'use client';

/**
 * The timeline of one mission, paged: the chat card, the mission drawer and the
 * trace page's mission view all read it through the same window (#215).
 */
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { useMissionSpans } from './mission-spans';
import { TraceTimeline, type TracePaging } from './trace-panel';

export function MissionSpansTimeline({ missionId, live, filterable, emptyLabel, followTail = false }: {
  missionId: string;
  /** Refresh as the mission's events stream in. */
  live: boolean;
  filterable: boolean;
  emptyLabel?: string;
  followTail?: boolean;
}) {
  const { spans, total, hasOlder, pruned, loadingOlder, loadOlder, rebuild } = useMissionSpans(missionId, live);
  const [rebuilding, setRebuilding] = useState(false);
  // Stable between refreshes that change nothing: the timeline memoises on it.
  const groups = useMemo(() => [{ key: missionId, title: missionId, spans: spans ?? [] }], [missionId, spans]);
  const paging = useMemo<TracePaging>(
    () => ({ hasOlder, loading: loadingOlder, remaining: Math.max(0, total - (spans?.length ?? 0)), onLoadOlder: () => { void loadOlder(); } }),
    [hasOlder, loadingOlder, total, spans, loadOlder],
  );
  if (spans === null) return <p className="px-3 py-4 text-[12px] text-muted-foreground">{t('common.loading')}</p>;
  if (spans.length === 0 && pruned > 0) {
    const start = async () => {
      setRebuilding(true);
      const ok = await rebuild();
      setRebuilding(false);
      if (!ok) toast.error(t('workflows.rebuildFailed'));
    };
    return (
      <div className="space-y-2 px-3 py-4 text-[12px] text-muted-foreground" data-testid="trace-pruned">
        <p>{t('workflows.spansPruned', { count: pruned })}</p>
        <Button type="button" size="sm" variant="outline" className="h-7 text-[12px]" disabled={rebuilding} onClick={() => void start()}>
          {rebuilding ? t('common.loading') : t('workflows.rebuildSpans')}
        </Button>
      </div>
    );
  }
  return <TraceTimeline groups={groups} filterable={filterable} emptyLabel={emptyLabel} paging={paging} followTail={followTail} />;
}
