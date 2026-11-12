'use client';

/**
 * Welcome splash: brand-forward, atmospheric, no mascot avalanche.
 * Language first, then continue — desktop-app first-run, not a website hero card.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { availableLocales, getLocale, t } from '@/lib/i18n';
import { selectableLocales } from '@/lib/locale-preference';
import { BrandWordmark } from '@/components/brand-wordmark';
import { LanguageRoller } from '../language-roller';
import { fetchMe } from '@/lib/auth';
import { useOnboarding } from '../onboarding-context';
import { afterSplash } from '../onboarding-flow';

export function SplashStep(): ReactElement {
  const { goTo, setLanguage } = useOnboarding();
  const returning = useRef(false);
  const roller = useRef<HTMLDivElement>(null);
  const languages = useMemo(() => selectableLocales(availableLocales()), []);
  const [language] = useState(getLocale);

  useEffect(() => {
    let alive = true;
    void fetchMe().then((me) => { if (alive) returning.current = !me.user && me.welcome === 'returning'; });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const focus = window.setTimeout(() => roller.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus({ preventScroll: true }), 600);
    return () => window.clearTimeout(focus);
  }, []);

  const start = (): void => goTo(afterSplash(returning.current));

  return (
    <section className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden px-6">
      <div aria-hidden className="rooks-stage-grid pointer-events-none absolute inset-0 opacity-80" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 55% 45% at 50% 0%, hsl(var(--primary) / 0.14), transparent 62%)',
        }}
      />
      <div className="relative z-[2] flex w-full max-w-lg -translate-y-[4vh] flex-col items-center text-center">
        <BrandWordmark className="rooks-onboarding-rise mb-8" markClassName="h-11" />
        <h1
          className="rooks-onboarding-rise whitespace-pre-line font-[family-name:var(--font-display)] text-[clamp(2rem,5vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.045em]"
          style={{ animationDelay: '80ms' }}
        >
          {t('onboarding.splash.title')}
        </h1>
        <p className="rooks-onboarding-rise mt-4 max-w-[42ch] text-[15px] leading-relaxed text-muted-foreground" style={{ animationDelay: '140ms' }}>
          {t('onboarding.splash.subtitle')}
        </p>
        <div ref={roller} className="rooks-onboarding-rise relative mt-8 flex w-full flex-col items-center" style={{ animationDelay: '200ms' }}>
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{t('onboarding.language.title')}</p>
          <LanguageRoller
            languages={languages}
            value={language}
            label={t('onboarding.language.title')}
            onChange={(tag) => { void setLanguage(tag); }}
            onConfirm={start}
            className="mb-4 mt-2 h-[150px] w-[280px]"
          />
          <Button size="lg" className="relative z-[3] h-10 gap-2 px-6" onClick={start}>
            {t('onboarding.continue')}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <p className="rooks-onboarding-fade mt-6 text-[12px] text-muted-foreground" style={{ animationDelay: '320ms' }}>
          {t('onboarding.splash.hint')}
        </p>
      </div>
    </section>
  );
}
