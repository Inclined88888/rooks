'use client';

/**
 * Trace tab of a mission (PRD §8.4): the spans of one mission, same paged
 * timeline as the chat card.
 */
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { t } from '@/lib/i18n';
import { MissionSpansTimeline } from './mission-spans-timeline';

export function MissionTrace({ missionId, traceId }: { missionId: string; traceId?: string | null }) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-1 flex justify-end">
        <Link href={`/trace/${encodeURIComponent(traceId ?? missionId)}`} className="inline-flex items-center gap-1 text-[10.5px] text-primary hover:underline"><ExternalLink className="size-3" />{t('workflows.openTrace')}</Link>
      </div>
      <MissionSpansTimeline missionId={missionId} live={false} filterable />
    </div>
  );
}
