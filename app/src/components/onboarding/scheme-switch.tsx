'use client';

/**
 * Colour mode switch on onboarding: light, dark, or system.
 * Square segments — not rounded-full pills.
 */
import type { ReactElement } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useOptionalColorScheme } from '@/components/theme-provider';
import { osScheme, storeSchemeMode, type SchemeMode } from '@/lib/scheme-mode';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const CHOICES: readonly { mode: SchemeMode; Icon: typeof Sun }[] = [
  { mode: 'light', Icon: Sun },
  { mode: 'dark', Icon: Moon },
  { mode: 'system', Icon: Monitor },
];

export function SchemeSwitch({ className }: { className?: string }): ReactElement | null {
  const color = useOptionalColorScheme();
  if (!color) return null;
  const { chooseFirstRunScheme, schemeMode, setSchemeMode } = color;
  return (
    <div role="group" aria-label={t('onboarding.scheme.label')} className={cn('flex gap-0.5 border border-border bg-muted/40 p-0.5', className)}>
      {CHOICES.map(({ mode, Icon }) => {
        const pressed = schemeMode === mode;
        return (
          <button
            key={mode}
            type="button"
            data-scheme={mode}
            aria-pressed={pressed}
            aria-label={t(`onboarding.scheme.${mode}`)}
            title={t(`onboarding.scheme.${mode}`)}
            onClick={() => {
              setSchemeMode(mode);
              storeSchemeMode(mode);
              if (mode === 'system') chooseFirstRunScheme(osScheme());
              else chooseFirstRunScheme(mode);
            }}
            className={cn(
              'flex h-7 w-7 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              pressed ? 'bg-card text-foreground shadow-elev-1' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
