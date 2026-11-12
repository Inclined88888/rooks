'use client';

import type { ReactElement } from 'react';
import { Mic } from 'lucide-react';

import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * "Where your voice goes", for a dictation plugin, wherever the gallery
 * shows one: its card, its detail sheet, its install sheet (TODO #484 C3).
 * The lines come from `declarationLines` (`lib/dictation/destination.ts`),
 * i.e. from the manifest the daemon read.
 */
export function VoiceDestinationLines({ lines, compact = false }: { lines: readonly string[]; compact?: boolean }): ReactElement | null {
  if (lines.length === 0) return null;
  return (
    <div
      className={cn('flex items-start gap-2 rounded-md bg-primary/5 text-foreground', compact ? 'px-2 py-1 text-[11px]' : 'px-3 py-2 text-[12px]')}
      data-testid="voice-destination"
    >
      <Mic className={cn('mt-0.5 shrink-0 text-primary', compact ? 'size-3' : 'size-3.5')} aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <p className="m-0 font-medium leading-snug">{t('dictation.destination.title')}</p>
        {lines.map((line) => <p key={line} className="m-0 break-words leading-snug text-muted-foreground">{line}</p>)}
      </div>
    </div>
  );
}
