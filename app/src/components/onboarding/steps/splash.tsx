'use client';

/**
 * Welcome splash: flat moodboard stage, restrained Rooks mark, denser mascot
 * heap settling into the corners. No language step — OS locale (Settings later).
 */
import { useEffect, useRef, type ReactElement } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandLogo } from '@/components/brand-logo';
import { t } from '@/lib/i18n';
import { fetchMe } from '@/lib/auth';
import { useOnboarding } from '../onboarding-context';
import { afterSplash } from '../onboarding-flow';
import { MascotAvalanche, type MascotAvalancheHandle } from '../mascot-avalanche';

export function SplashStep(): ReactElement {
  const { goTo } = useOnboarding();
  const returning = useRef(false);
  const heap = useRef<MascotAvalancheHandle>(null);

  useEffect(() => {
    let alive = true;
    void fetchMe().then((me) => { if (alive) returning.current = !me.user && me.welcome === 'returning'; });
    return () => { alive = false; };
  }, []);

  const start = (): void => {
    heap.current?.scatter();
    window.setTimeout(() => goTo(afterSplash(returning.current)), 320);
  };

  return (
    <section data-onboarding-step="splash" className="relative isolate flex min-h-[min(640px,calc(100vh-8rem))] w-full flex-1 flex-col">
      <MascotAvalanche
        ref={heap}
        className="pointer-events-auto absolute inset-0 z-[1] h-full w-full"
        density={56}
      />
      {/* Quiet centre panel — no heavy card/blob; heap owns the corners. */}
      <div className="pointer-events-none relative z-[2] mx-auto flex min-h-[min(640px,calc(100vh-8rem))] w-full max-w-[560px] flex-col justify-center px-10 py-12">
        <div className="pointer-events-auto rooks-onboarding-rise flex items-center gap-2.5">
          <BrandLogo className="h-7 w-7" alt="" />
          <span className="text-[15px] font-medium tracking-[-0.02em] text-foreground">Rooks</span>
        </div>
        <h1
          className="rooks-onboarding-rise mt-8 max-w-[16ch] text-[28px] font-semibold leading-[1.15] tracking-[-0.03em] text-foreground"
          style={{ animationDelay: '50ms' }}
        >
          {t('onboarding.splash.title')}
        </h1>
        <p
          className="rooks-onboarding-rise mt-3 max-w-[36ch] text-[13.5px] leading-relaxed text-muted-foreground"
          style={{ animationDelay: '90ms' }}
        >
          {t('onboarding.splash.subtitle')}
        </p>
        <div className="pointer-events-auto rooks-onboarding-rise mt-8 flex items-center gap-3" style={{ animationDelay: '130ms' }}>
          <Button type="button" size="lg" className="h-10 gap-2 rounded-lg px-5 text-[13.5px] font-medium" onClick={start} data-splash-continue>
            {t('onboarding.continue')}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
          <kbd className="hidden rounded-md border border-border/80 bg-background/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline">Enter</kbd>
        </div>
        <p className="rooks-onboarding-fade mt-6 text-[12px] text-muted-foreground/80" style={{ animationDelay: '180ms' }}>
          {t('onboarding.splash.hint')}
        </p>
      </div>
    </section>
  );
}
