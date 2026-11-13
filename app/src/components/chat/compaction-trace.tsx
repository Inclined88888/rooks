'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Minimize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { openChat } from '@/lib/chat-navigation';
import { chatHref } from '@/lib/chat-island-params';
import type { CompactionTraceView } from '@/lib/compaction-trace';
import { fmtContextLimit } from './context-ring';

function headline(trace: CompactionTraceView): string {
  if (trace.outcome === 'error') return t('compact.failed', { error: trace.error || t('compact.unknownError') });
  if (trace.outcome === null) return t('compact.traceRequested');
  if (trace.mode === 'fork') return t('compact.traceForked');
  if (trace.preTokens && trace.postTokens !== null) {
    return t('compact.traceNativeTokens', { from: fmtContextLimit(trace.preTokens), to: fmtContextLimit(trace.postTokens) });
  }
  return t('compact.doneNative');
}

/**
 * One compaction in the thread: a quiet line, the summary the agent continues
 * from folded under it, the new conversation one click away after a fork.
 */
export function CompactionTrace({
  trace,
  agentName,
  time,
}: {
  trace: CompactionTraceView;
  agentName: string;
  time?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const failed = trace.outcome === 'error';
  return (
    <div className="flex flex-col items-center gap-1.5 py-1 text-[11px]" data-compaction-trace="">
      <div className={cn(
        'flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center',
        failed ? 'text-destructive' : 'text-muted-foreground/80',
      )}>
        <Minimize2 className="size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 whitespace-pre-wrap tabular-nums [overflow-wrap:anywhere]">{headline(trace)}</span>
        {time && <span className="tabular-nums text-muted-foreground/60">{time}</span>}
        {trace.summary && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="rounded px-1 text-foreground/80 underline-offset-2 hover:underline"
          >
            {open ? t('compact.hideSummary') : t('compact.showSummary')}
          </button>
        )}
        {trace.targetMissionId && (
          <button
            type="button"
            onClick={() => openChat(chatHref(agentName, trace.targetMissionId), router)}
            className="rounded px-1 text-foreground/80 underline-offset-2 hover:underline"
          >
            {t('compact.openNewConversation')}
          </button>
        )}
      </div>
      {open && trace.summary && (
        <div className="max-h-72 w-full max-w-2xl overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-left text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {trace.summary}
        </div>
      )}
    </div>
  );
}
