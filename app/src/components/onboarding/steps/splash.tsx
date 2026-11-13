'use client';

/**
 * The welcome. The language roller is the first question. Continue opens the
 * account step. No mascots and no slogan.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BRAND } from '@/lib/brand';
import { availableLocales, getLocale, t } from '@/lib/i18n';
import { selectableLocales } from '@/lib/locale-preference';
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
    const focus = window.setTimeout(() => roller.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus({ preventScroll: true }), 400);
    return () => window.clearTimeout(focus);
  }, []);

  const start = (): void => { goTo(afterSplash(returning.current)); };

  return (
    <section className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden">
      <div className="relative z-[2] flex -translate-y-[6vh] flex-col items-center px-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{BRAND.displayName}</h1>
        <div ref={roller} className="relative mt-6 flex flex-col items-center">
          <p className="text-[13.5px] text-muted-foreground">{t('onboarding.language.title')}</p>
          <LanguageRoller
            languages={languages}
            value={language}
            label={t('onboarding.language.title')}
            onChange={(tag) => { void setLanguage(tag); }}
            onConfirm={start}
            className="mb-3.5 mt-1.5 h-[170px] w-[300px]"
          />
          <Button size="lg" className="relative z-[3] gap-2" onClick={start}>
            {t('onboarding.continue')}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
    </section>
  );
}
