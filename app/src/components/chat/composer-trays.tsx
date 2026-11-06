'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The strips that announce what is running (the tool in flight, the delegated
 * missions), stacked above the composer.
 *
 * Built on the composer's header tab (`ComposerHeader`): the chat's gutter,
 * the card's width, then one inset more than the tab — a strip is narrower
 * than the tab it sits on. The last strip docks onto the tab: no rounded corners and
 * no outline on the edge that touches it (`.composer-trays-docked` in
 * globals.css). The dense composer of a multichat cell has no tab: its strips
 * stay plain rounded cards.
 */
export function ComposerTrays({ compact, wide, children }: { compact: boolean; wide: boolean; children: ReactNode }) {
  return (
    <div className={cn('relative z-10 shrink-0', compact ? 'px-2' : 'px-[var(--chat-pad,0.375rem)]')}>
      <div className={cn(!compact && !wide && 'mx-auto max-w-[calc(var(--chat-col,780px)+48px)]')}>
        {/* One step in from the tab (`mx-3`), as the tab is from the card:
            card, tab and strip read as a stack. */}
        <div className={cn('flex min-w-0 flex-col', !compact && 'composer-trays-docked mx-6')}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** The classes of one strip inside `ComposerTrays`. */
export function composerTrayClass(compact: boolean): string {
  return cn('composer-tray rounded-xl border', compact ? 'mt-1.5' : 'mt-2');
}
