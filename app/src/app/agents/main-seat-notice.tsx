'use client';

import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { designateMainAgent } from '@/lib/chat-entry';
import { announceAgentsChanged } from '@/lib/agents-changed';

/**
 * Said when nobody holds the main orchestrator seat (TIM-0143). The page draws
 * no main node then, so the warning is what tells the user why unmanaged
 * agents stand at the root, and lets them seat one of the eligible agents —
 * the same call as the chat card's "Set as main orchestrator".
 */
export function MainSeatNotice({ candidates, className }: { candidates: readonly string[]; className?: string }) {
  const [busy, setBusy] = useState(false);
  const seat = async (name: string) => {
    setBusy(true);
    const failure = await designateMainAgent(name);
    setBusy(false);
    if (failure) {
      toast.error(t('agentChat.menu.makeMainFailed', { name, error: failure }));
      return;
    }
    toast.success(t('agentChat.menu.makeMainDone', { name }));
    announceAgentsChanged();
  };
  return (
    <div role="status" className={cn('rounded-lg bg-card/90 px-3 py-2 text-[11.5px] shadow-lg backdrop-blur', className)}>
      <div className="flex items-center gap-1.5 font-semibold text-foreground">
        <TriangleAlert className="size-3.5 shrink-0 text-warning" />
        {t('agentsPage.mainSeatEmpty')}
      </div>
      <p className="mt-1 text-muted-foreground">
        {candidates.length ? t('agentsPage.mainSeatEmptyHint') : t('agentsPage.mainSeatNoCandidate')}
      </p>
      {candidates.length > 0 && (
        <ul className="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto">
          {candidates.map((name) => (
            <li key={name}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void seat(name)}
                className="w-full truncate rounded px-1.5 py-0.5 text-left text-primary hover:bg-muted disabled:opacity-50"
              >
                {t('agentsPage.mainSeatSet', { name })}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
