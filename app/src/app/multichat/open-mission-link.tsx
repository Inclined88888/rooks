'use client';

import { ChatLink } from '@/components/chat/chat-link';
import { ExternalLink } from 'lucide-react';
import { chatHref } from '@/lib/chat-island-params';
import { t } from '@/lib/i18n';

/**
 * A cell's way out to the full chat on its mission (SUG-0055): what a cell
 * cannot host (the terminal a command card opens, the widget columns) is
 * there. A plain link, so Ctrl/Cmd+click and the middle button open a browser
 * tab; a right-click reaches the header's "Open in a split" menu.
 */
export function OpenMissionLink({ agent, missionId }: { agent: string; missionId: string | null | undefined }) {
  if (!missionId) return null;
  return (
    <ChatLink
      href={chatHref(agent, missionId)}
      title={t('multichat.slot.openMission')}
      aria-label={t('multichat.slot.openMission')}
      className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <ExternalLink className="size-2.5" />
    </ChatLink>
  );
}
