'use client';

import type { ReactElement } from 'react';
import { Monitor, Sun } from 'lucide-react';
import { useColorScheme } from '@/components/theme-provider';
import { t } from '@/lib/i18n';
import { appliedScheme, osScheme, readSchemeMode, storeSchemeMode, type SchemeMode } from '@/lib/scheme-mode';
import { cn } from '@/lib/utils';

const CHOICES: readonly { mode: SchemeMode; Icon: typeof Sun }[] = [
  { mode: 'light', Icon: Sun },
  { mode: 'system', Icon: Monitor },
];

/** Light, or the operating system's mode. Dark is only what System paints. */
export function SchemeSwitch({ className }: { className?: string }): ReactElement {
  const { chooseFirstRunScheme } = useColorScheme();
  const mode = readSchemeMode();
  const pick = (next: SchemeMode): void => {
    storeSchemeMode(next);
    chooseFirstRunScheme(next === 'system' ? osScheme() : 'light');
    window.dispatchEvent(new Event('rooks-scheme-mode'));
  };
  return (
    <div role="group" aria-label={t('onboarding.scheme.label')} className={cn('inline-flex rounded-full bg-muted p-1', className)}>
      {CHOICES.map(({ mode: choice, Icon }) => {
        const on = mode === choice;
        return (
          <button
            key={choice}
            type="button"
            data-scheme={choice}
            aria-pressed={on}
            aria-label={t(`onboarding.scheme.${choice}`)}
            onClick={() => pick(choice)}
            className={cn('inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium', on ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')}
          >
            <Icon className="size-3.5" aria-hidden />
            {t(`onboarding.scheme.${choice}`)}
          </button>
        );
      })}
    </div>
  );
}

export function currentAppliedScheme(): 'light' | 'dark' {
  return appliedScheme();
}
