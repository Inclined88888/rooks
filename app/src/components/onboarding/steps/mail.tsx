'use client';

/**
 * Optional mail connect. Sync if provided; Skip always available.
 */
import { useState, type ReactElement } from 'react';
import { ArrowRight, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { settingsPath } from '@/lib/settings-path';
import { useOnboarding } from '../onboarding-context';

type MailId = 'gmail' | 'microsoft' | 'imap';

const OPTIONS: readonly { id: MailId; mark: string; tone: string }[] = [
  { id: 'gmail', mark: 'G', tone: '#ea4335' },
  { id: 'microsoft', mark: 'M', tone: '#0078d4' },
  { id: 'imap', mark: '@', tone: 'hsl(var(--muted-foreground))' },
];

export function MailStep(): ReactElement {
  const { next } = useOnboarding();
  const [picked, setPicked] = useState<MailId | null>(null);

  return (
    <section data-onboarding-step="mail" className="flex w-full max-w-[520px] flex-col items-center text-center">
      <h1 className="rooks-onboarding-rise font-[family-name:var(--font-display)] text-[28px] font-semibold leading-tight tracking-[-0.03em]">
        {t('onboarding.mail.title')}
      </h1>
      <p className="rooks-onboarding-rise mb-6 mt-2.5 text-[15px] leading-normal text-muted-foreground" style={{ animationDelay: '60ms' }}>
        {t('onboarding.mail.subtitle')}
      </p>
      <div className="rooks-onboarding-rise flex w-full flex-col gap-0.5 rounded-2xl bg-card/80 p-1.5 text-left shadow-elev-2 ring-1 ring-border" style={{ animationDelay: '100ms' }}>
        {OPTIONS.map((opt, i) => (
          <button
            key={opt.id}
            type="button"
            data-mail={opt.id}
            onClick={() => setPicked(opt.id)}
            style={{ animationDelay: `${120 + i * 40}ms` }}
            className={cn(
              'rooks-onboarding-rise group flex w-full items-center gap-3.5 rounded-xl p-3.5 text-left transition-colors duration-150',
              'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              picked === opt.id && 'bg-muted',
            )}
          >
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-[13px] font-bold transition-transform duration-150 group-hover:scale-105"
              style={{ color: opt.tone }}
              aria-hidden
            >
              {opt.id === 'imap' ? <Mail className="size-4" /> : opt.mark}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14.5px] font-semibold">{t(`onboarding.mail.${opt.id}.title`)}</span>
              <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{t(`onboarding.mail.${opt.id}.detail`)}</span>
            </span>
          </button>
        ))}
      </div>
      {picked && (
        <p className="mt-3 text-[12.5px] text-muted-foreground">
          {t('onboarding.mail.connectHint', { settingsPath: settingsPath('plugins') })}
        </p>
      )}
      <div className="mt-6 flex flex-col items-center gap-2">
        <Button type="button" className="gap-2 transition-transform duration-150 hover:scale-[1.02] active:scale-[0.98]" onClick={next} data-mail-continue>
          {t('onboarding.continue')}
          <ArrowRight className="size-4" aria-hidden />
        </Button>
        <button type="button" data-mail-skip className="text-[13px] text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline" onClick={next}>
          {t('onboarding.mail.skip')}
        </button>
      </div>
    </section>
  );
}
