'use client';

/**
 * The welcome (mockup screen `splash`): mascots pour in and pile up against
 * both edges, the title rises between the heaps, and the language roller
 * stands where a "Get started" button would — the first thing asked is the
 * language every next screen will speak. "Continue" flings the mascots out
 * and opens the account step.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { availableLocales, getLocale, t } from '@/lib/i18n';
import { selectableLocales } from '@/lib/locale-preference';
import { usePrefersReducedMotion } from '@/components/mascot/agent-mascot';
import { LanguageRoller } from '../language-roller';
import { MascotAvalanche, type MascotAvalancheHandle } from '../mascot-avalanche';
import { fetchMe } from '@/lib/auth';
import { useOnboarding } from '../onboarding-context';
import { afterSplash } from '../onboarding-flow';

/** Long enough to see the mascots fly off, short enough not to wait for them. */
const LEAVE_MS = 650;

export function SplashStep(): ReactElement {
  const { goTo, setLanguage } = useOnboarding();
  // An install whose account was made before this onboarding signs in after the welcome (`Upgrade welcome`).
  const returning = useRef(false);
  const avalanche = useRef<MascotAvalancheHandle>(null);
  const roller = useRef<HTMLDivElement>(null);
  const leaving = useRef<number | null>(null);
  const languages = useMemo(() => selectableLocales(availableLocales()), []);
  const [language] = useState(getLocale);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    let alive = true;
    void fetchMe().then((me) => { if (alive) returning.current = !me.user && me.welcome === 'returning'; });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    // Once the words have risen: the keyboard turns the roller straight away.
    const focus = window.setTimeout(() => roller.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus({ preventScroll: true }), 2000);
    return () => {
      window.clearTimeout(focus);
      if (leaving.current !== null) window.clearTimeout(leaving.current);
    };
  }, []);

  const next = (): void => goTo(afterSplash(returning.current));

  const start = (): void => {
    if (leaving.current !== null) return;
    // Reduced motion: no mascots flung across the screen, straight to the next step.
    if (reduced) { next(); return; }
    avalanche.current?.scatter();
    leaving.current = window.setTimeout(next, LEAVE_MS);
  };

  return (
    <section className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden">
      <MascotAvalanche ref={avalanche} className="absolute inset-0 h-full w-full" />
      {/* The column lets the pointer through to the mascots, except on what it holds. */}
      <div className="pointer-events-none relative z-[2] flex -translate-y-[6vh] flex-col items-center px-6 text-center [&>*]:pointer-events-auto">
        <h1
          className="timon-onboarding-rise whitespace-pre-line text-[clamp(40px,6.4vw,78px)] font-extrabold leading-[0.95] tracking-[-0.045em] [text-shadow:0_10px_60px_hsl(var(--background)/0.6)]"
          style={{ animationDelay: '1.1s' }}
        >
          {t('onboarding.splash.title')}
        </h1>
        <p className="timon-onboarding-rise mt-4 max-w-[460px] text-base text-muted-foreground" style={{ animationDelay: '1.5s' }}>
          {t('onboarding.splash.subtitle')}
        </p>
        <div ref={roller} className="timon-onboarding-rise relative mt-6 flex flex-col items-center" style={{ animationDelay: '1.9s' }}>
          <p className="text-[13.5px] text-muted-foreground">{t('onboarding.language.title')}</p>
          <LanguageRoller
            languages={languages}
            value={language}
            label={t('onboarding.language.title')}
            onChange={(tag) => { void setLanguage(tag); }}
            onConfirm={start}
            className="mb-3.5 mt-1.5 h-[170px] w-[300px]"
          />
          {/* Above the roller: a click on its top edge must not turn the languages. */}
          <Button size="lg" className="relative z-[3] gap-2" onClick={start}>
            {t('onboarding.continue')}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <p className="timon-onboarding-fade mt-4 text-xs text-muted-foreground" style={{ animationDelay: '3.2s' }}>
          {t('onboarding.splash.hint')}
        </p>
      </div>
    </section>
  );
}
