'use client';

/**
 * Light or dark, at the top of every onboarding step. The onboarding follows
 * the OS until someone picks here; the pick applies at once, holds for the
 * whole flow, and becomes the account's scheme when the account step creates
 * it (`firstRunScheme`). Rendered by the shell, so it never depends on a step.
 */
import type { ReactElement } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useOptionalColorScheme } from '@/components/theme-provider';
import type { ColorScheme } from '@/lib/auth';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const CHOICES: readonly { scheme: ColorScheme; Icon: typeof Sun }[] = [
  { scheme: 'light', Icon: Sun },
  { scheme: 'dark', Icon: Moon },
];

export function SchemeSwitch({ className }: { className?: string }): ReactElement | null {
  const color = useOptionalColorScheme();
  if (!color) return null;
  const { applied, chooseFirstRunScheme } = color;
  return (
    <div role="group" aria-label={t('onboarding.scheme.label')} className={cn('flex gap-0.5 rounded-full bg-muted/70 p-0.5', className)}>
      {CHOICES.map(({ scheme, Icon }) => {
        const on = applied === scheme;
        return (
          <button
            key={scheme}
            type="button"
            data-scheme={scheme}
            aria-pressed={on}
            aria-label={t(`onboarding.scheme.${scheme}`)}
            title={t(`onboarding.scheme.${scheme}`)}
            onClick={() => chooseFirstRunScheme(scheme)}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              on ? 'bg-card text-foreground shadow-elev-1' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
