'use client';

/**
 * "Trace" card of the chat's right rail (PRD §8.4): the spans of the mission
 * currently open, paged and refreshed incrementally as its events stream in
 * (`mission-spans.ts`).
 */
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { useChatRail } from '@/components/chat/chat-rails';
import { t } from '@/lib/i18n';
import { MissionSpansTimeline } from './mission-spans-timeline';

export function ChatTraceWidget() {
  const chat = useChatRail();
  const missionId = chat?.currentMissionId ?? null;
  if (!chat) return null;
  if (!missionId) return <p className="px-3 py-4 text-[11px] text-muted-foreground">{t('workflows.noMission')}</p>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex justify-end px-3 pt-2">
        <Link prefetch={false} href={`/trace/${encodeURIComponent(missionId)}`} className="inline-flex items-center gap-1 text-[10.5px] text-primary hover:underline"><ExternalLink className="size-3" />{t('workflows.openTrace')}</Link>
      </div>
      <MissionSpansTimeline missionId={missionId} live filterable={false} emptyLabel={t('workflows.noSpans')} followTail />
    </div>
  );
}
