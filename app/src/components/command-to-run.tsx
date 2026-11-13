'use client';

import { useState, type ReactElement } from 'react';
import { t } from '@/lib/i18n';

/**
 * A command the user runs THEMSELVES, shown so it can be pasted.
 *
 * Extracted from `setup/page.tsx` when the `WebUI` settings tab needed the
 * same block: the two screens carry the same `tailscale` commands, and a
 * second copy of the widget is a second place for the copy button to drift.
 */
export function CommandToRun({ command, label }: { command: string; label?: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 space-y-1">
      <p className="text-xs text-muted-foreground">{label ?? t('setupPage.runYourself')}</p>
      <div className="flex items-center gap-2">
        <code /* code-font: shell command */ className="flex-1 overflow-x-auto rounded-md border bg-muted p-2 font-mono text-xs">{command}</code>
        <button
          className="rounded-md border px-2 py-1 text-xs"
          onClick={() => {
            void navigator.clipboard?.writeText(command);
            setCopied(true);
          }}
          type="button"
        >
          {copied ? t('setupPage.copied') : t('setupPage.copy')}
        </button>
      </div>
    </div>
  );
}
