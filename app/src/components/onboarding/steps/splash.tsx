'use client';

/**
 * Welcome splash: premium moodboard stage (cream light / near-black dark),
 * language first, living mascot heap settling into the corners — not a cheap
 * dark card.
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
import { MascotAvalanche, type MascotAvalancheHandle } from '../mascot-avalanche';

export function SplashStep(): ReactElement {
  const { goTo, setLanguage } = useOnboarding();
  const returning = useRef(false);
  const roller = useRef<HTMLDivElement>(null);
  const heap = useRef<MascotAvalancheHandle>(null);
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

  const start = (): void => {
    heap.current?.scatter();
    window.setTimeout(() => goTo(afterSplash(returning.current)), 280);
  };

  return (
    <section className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden px-6">
      {/* Soft stage atmosphere — not a card */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 70% 55% at 50% 18%, hsl(var(--primary) / 0.10), transparent 58%), linear-gradient(180deg, hsl(var(--background)) 0%, hsl(var(--surface-1)) 100%)',
        }}
      />
      <MascotAvalanche ref={heap} className="pointer-events-none absolute inset-0 z-[1]" />
      <div className="relative z-[2] flex w-full max-w-lg -translate-y-[3vh] flex-col items-center text-center">
        <BrandWordmark className="rooks-onboarding-rise mb-7" markClassName="h-11" />
        <h1
          className="rooks-onboarding-rise whitespace-pre-line font-[family-name:var(--font-display)] text-[clamp(2rem,5vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.045em]"
          style={{ animationDelay: '70ms' }}
        >
          {t('onboarding.splash.title')}
        </h1>
        <p className="rooks-onboarding-rise mt-4 max-w-[42ch] text-[15px] leading-relaxed text-muted-foreground" style={{ animationDelay: '120ms' }}>
          {t('onboarding.splash.subtitle')}
        </p>
        <div ref={roller} className="rooks-onboarding-rise relative mt-8 flex w-full flex-col items-center" style={{ animationDelay: '160ms' }}>
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{t('onboarding.language.title')}</p>
          <LanguageRoller
            languages={languages}
            value={language}
            label={t('onboarding.language.title')}
            onChange={(tag) => { void setLanguage(tag); }}
            onConfirm={start}
            className="mb-4 mt-2 h-[150px] w-[280px]"
          />
          <Button size="lg" className="relative z-[3] h-10 gap-2 px-6 transition-transform duration-150 hover:scale-[1.02] active:scale-[0.98]" onClick={start}>
            {t('onboarding.continue')}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <p className="rooks-onboarding-fade mt-6 text-[12px] text-muted-foreground" style={{ animationDelay: '240ms' }}>
          {t('onboarding.splash.hint')}
        </p>
      </div>
    </section>
  );
}
