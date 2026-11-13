'use client';

/**
 * Colour mode on onboarding: Light (default) or System. No manual Dark —
 * dark only when System follows an OS dark appearance.
 */
import type { ReactElement } from 'react';
import { Monitor, Sun } from 'lucide-react';
import { useOptionalColorScheme } from '@/components/theme-provider';
import { osScheme, SCHEME_MODE_CHOICES, storeSchemeMode } from '@/lib/scheme-mode';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const ICONS: Record<'light' | 'system', typeof Sun> = { light: Sun, system: Monitor };

export function SchemeSwitch({ className }: { className?: string }): ReactElement | null {
  const color = useOptionalColorScheme();
  if (!color) return null;
  const { chooseFirstRunScheme, schemeMode, setSchemeMode } = color;
  return (
    <div role="group" aria-label={t('onboarding.scheme.label')} className={cn('flex gap-0.5 border border-border bg-muted/40 p-0.5', className)}>
      {SCHEME_MODE_CHOICES.map((mode) => {
        const Icon = ICONS[mode];
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
              else chooseFirstRunScheme('light');
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
