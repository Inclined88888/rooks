'use client';

/**
 * The keys a phone keyboard does not have, for a shell: Esc, Tab, Ctrl
 * (latched for the next key, like a sticky modifier), arrows, and the few
 * symbols buried on a second keyboard page. Copy shows up first while text is
 * selected. Scrolls sideways on a narrow screen rather than wrapping onto two
 * rows.
 */

import type { ReactElement } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Copy } from 'lucide-react';
import { t } from '@/lib/i18n';
import { KEY_SEQUENCES } from '@/lib/terminal-web';
import { cn } from '@/lib/utils';

const SYMBOLS = ['|', '/', '-', '~', '>', '&', '*'] as const;

export function TerminalKeyBar({ ctrlArmed, canCopy = false, onCtrl, onKey, onCopy }: {
  ctrlArmed: boolean;
  /** Text is selected in the terminal. */
  canCopy?: boolean;
  onCtrl: () => void;
  onKey: (sequence: string) => void;
  onCopy?: () => void;
}): ReactElement {
  // `pointerdown` + preventDefault keeps the focus (and the keyboard) on the
  // terminal: a plain click would blur it and fold the keyboard away.
  const key = (label: ReactElement | string, sequence: string, aria?: string) => (
    <button
      key={aria ?? String(label)}
      type="button"
      aria-label={aria}
      onPointerDown={(e) => { e.preventDefault(); onKey(sequence); }}
      className="min-w-9 shrink-0 rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium tabular-nums text-foreground active:bg-primary/30"
    >
      {label}
    </button>
  );

  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto bg-muted/40 px-2 py-1.5" role="toolbar" aria-label={t('terminal.keys.toolbar')}>
      {canCopy && onCopy && (
        // Copied on click, not on pointerdown: a touch only grants the
        // clipboard access once the finger is lifted.
        <button
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={onCopy}
          className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground active:bg-primary/80"
        >
          <Copy className="size-3.5" />
          {t('terminal.keys.copy')}
        </button>
      )}
      {key('Esc', KEY_SEQUENCES.esc)}
      <button
        type="button"
        aria-pressed={ctrlArmed}
        onPointerDown={(e) => { e.preventDefault(); onCtrl(); }}
        className={cn(
          'min-w-9 shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium',
          ctrlArmed ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
        )}
      >
        Ctrl
      </button>
      {key('Tab', KEY_SEQUENCES.tab)}
      {key(<ArrowUp className="size-3.5" />, KEY_SEQUENCES.up, t('terminal.keys.up'))}
      {key(<ArrowDown className="size-3.5" />, KEY_SEQUENCES.down, t('terminal.keys.down'))}
      {key(<ArrowLeft className="size-3.5" />, KEY_SEQUENCES.left, t('terminal.keys.left'))}
      {key(<ArrowRight className="size-3.5" />, KEY_SEQUENCES.right, t('terminal.keys.right'))}
      {SYMBOLS.map((symbol) => key(symbol, symbol))}
    </div>
  );
}
