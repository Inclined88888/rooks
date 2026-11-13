'use client';

/**
 * Optional communication channels. Sync if the person connects one; Skip is
 * always available — never blocks first use.
 */
import { useState, type ReactElement } from 'react';
import { ArrowRight, MessageSquare, Send, Slack } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { settingsPath } from '@/lib/settings-path';
import { useOnboarding } from '../onboarding-context';

type ChannelId = 'whatsapp' | 'telegram' | 'slack' | 'discord';

const CHANNELS: readonly { id: ChannelId; icon: typeof Send; mark?: string }[] = [
  { id: 'whatsapp', icon: MessageSquare, mark: 'WA' },
  { id: 'telegram', icon: Send },
  { id: 'slack', icon: Slack },
  { id: 'discord', icon: MessageSquare },
];

export function ChannelsStep(): ReactElement {
  const { next } = useOnboarding();
  const [picked, setPicked] = useState<ChannelId | null>(null);

  return (
    <section data-onboarding-step="channels" className="flex w-full max-w-[520px] flex-col items-start px-8 py-8 text-left">
      <h1 className="rooks-onboarding-rise text-[22px] font-semibold leading-tight tracking-[-0.025em]">
        {t('onboarding.channels.title')}
      </h1>
      <p className="rooks-onboarding-rise mb-6 mt-2 text-[13.5px] leading-relaxed text-muted-foreground" style={{ animationDelay: '60ms' }}>
        {t('onboarding.channels.subtitle')}
      </p>
      <div className="rooks-onboarding-rise flex w-full flex-col gap-0.5 rounded-lg border border-border bg-background p-1 text-left" style={{ animationDelay: '100ms' }}>
        {CHANNELS.map((ch, i) => {
          const Icon = ch.icon;
          return (
            <button
              key={ch.id}
              type="button"
              data-channel={ch.id}
              onClick={() => setPicked(ch.id)}
              style={{ animationDelay: `${120 + i * 40}ms` }}
              className={cn(
                'rooks-onboarding-rise group flex w-full items-center gap-3.5 rounded-md p-3 text-left transition-colors duration-150',
                'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                picked === ch.id && 'bg-muted',
              )}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-semibold text-foreground">
                {ch.mark ?? <Icon className="size-4" aria-hidden />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14.5px] font-semibold">{t(`onboarding.channels.${ch.id}.title`)}</span>
                <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{t(`onboarding.channels.${ch.id}.detail`)}</span>
              </span>
            </button>
          );
        })}
      </div>
      {picked && (
        <p className="mt-3 text-[12.5px] text-muted-foreground">
          {t('onboarding.channels.connectHint', {
            settingsPath: picked === 'whatsapp'
              ? settingsPath('network', 'channels')
              : settingsPath('plugins'),
          })}
        </p>
      )}
      <div className="mt-6 flex flex-col items-center gap-2">
        <Button type="button" className="gap-2" onClick={next} data-channels-continue>
          {t('onboarding.continue')}
          <ArrowRight className="size-4" aria-hidden />
        </Button>
        <button type="button" data-channels-skip className="text-[13px] text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline" onClick={next}>
          {t('onboarding.channels.skip')}
        </button>
      </div>
    </section>
  );
}
