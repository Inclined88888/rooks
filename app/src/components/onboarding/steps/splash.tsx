'use client';

/**
 * The welcome. Continue opens the account step. The language is the system
 * language (Settings is where it is chosen). No mascots and no slogan.
 */
import { useEffect, useRef, type ReactElement } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BRAND } from '@/lib/brand';
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

  const start = (): void => { goTo(afterSplash(returning.current)); };

  return (
    <section className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden">
      <div className="relative z-[2] flex -translate-y-[6vh] flex-col items-center px-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{BRAND.displayName}</h1>
        <Button size="lg" className="relative z-[3] mt-8 gap-2" onClick={start}>
          {t('onboarding.continue')}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </section>
  );
}
