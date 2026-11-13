'use client';

/**
 * The agent's permission mode, as a segmented choice.
 *
 * A backend that arbitrates its own tool uses (`selfManagedPermissions`, today
 * opencode) never reads this mode: leaving the choice clickable let a user pick
 * `plan` and believe the agent was read-only (TIM-0126). The choice is then
 * frozen and says where the rules really live. The saved value is kept as is,
 * so switching the agent back to another backend restores it.
 */
import React from 'react';
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

export const PERMISSION_MODES = ['auto', 'acceptEdits', 'plan', 'bypassPermissions'] as const;

export function PermissionModeField({
  value,
  onChange,
  ignored,
}: {
  value: string;
  onChange: (mode: string) => void;
  /** The backend applies its own permission configuration. */
  ignored: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-label={t('editPage.permissionModeLabel')}
        aria-disabled={ignored || undefined}
        className={cn(
          'inline-flex w-fit flex-wrap gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5',
          ignored && 'opacity-50',
        )}
      >
        {PERMISSION_MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={value === m}
            disabled={ignored}
            onClick={() => onChange(m)}
            className={cn(
              'rounded-md px-3 py-1.5 text-[11.5px] transition-colors disabled:cursor-not-allowed',
              value === m
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground enabled:hover:text-foreground',
            )}
          >
            {m}
          </button>
        ))}
      </div>
      {ignored && (
        <p
          role="note"
          data-permission-mode-ignored
          className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-2 text-[12px] text-amber-900 dark:text-amber-200"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{t('editPage.permissionModeIgnored')}</span>
        </p>
      )}
    </div>
  );
}
