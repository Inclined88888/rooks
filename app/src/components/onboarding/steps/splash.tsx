'use client';

/**
 * Welcome splash: flat app-window stage. Small Rooks mark, calm copy, Continue.
 * No mascot heap, no language picker, no radial glow — OS locale (Settings later).
 */
import { useEffect, useRef, type ReactElement } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandLogo } from '@/components/brand-logo';
import { t } from '@/lib/i18n';
import { fetchMe } from '@/lib/auth';
import { useOnboarding } from '../onboarding-context';
import { afterSplash } from '../onboarding-flow';

export function SplashStep(): ReactElement {
  const { goTo } = useOnboarding();
  const returning = useRef(false);

  useEffect(() => {
    let alive = true;
    void fetchMe().then((me) => { if (alive) returning.current = !me.user && me.welcome === 'returning'; });
    return () => { alive = false; };
  }, []);

  const start = (): void => {
    goTo(afterSplash(returning.current));
  };

  return (
    <section
      data-onboarding-step="splash"
      className="relative isolate flex w-full flex-col px-8 py-8"
    >
      <div className="rooks-onboarding-rise mx-auto flex w-full max-w-[400px] flex-col items-start">
        <div className="flex items-center gap-2.5">
          <BrandLogo className="h-6 w-6" alt="" />
          <span className="text-[14px] font-medium tracking-[-0.02em] text-foreground">Rooks</span>
        </div>
        <h1
          className="rooks-onboarding-rise mt-5 max-w-[18ch] text-[22px] font-semibold leading-[1.25] tracking-[-0.025em] text-foreground"
          style={{ animationDelay: '40ms' }}
        >
          {t('onboarding.splash.title')}
        </h1>
        <p
          className="rooks-onboarding-rise mt-2 max-w-[38ch] text-[13.5px] leading-relaxed text-muted-foreground"
          style={{ animationDelay: '80ms' }}
        >
          {t('onboarding.splash.subtitle')}
        </p>
        <div className="rooks-onboarding-rise mt-6 flex items-center gap-3" style={{ animationDelay: '120ms' }}>
          <Button type="button" size="lg" className="h-9 gap-2 rounded-md px-4 text-[13px] font-medium" onClick={start} data-splash-continue>
            {t('onboarding.continue')}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <kbd className="hidden rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline">Enter</kbd>
        </div>
        <p className="rooks-onboarding-fade mt-4 text-[12px] text-muted-foreground/80" style={{ animationDelay: '160ms' }}>
          {t('onboarding.splash.hint')}
        </p>
      </div>
    </section>
  );
}
