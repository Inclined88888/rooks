'use client';

/**
 * Onboarding frame. Layout/stage follows Timon (full viewport, step owns its
 * width) — the calm 520px card cage crushed the agent step on real Mac sizes.
 * Rooks chrome only: hairline top bar, no radial glow.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchCapabilities } from '@/lib/capabilities';
import { getLocale, t } from '@/lib/i18n';
import { welcomeLanding } from '@/app/setup/agent/setup-landing';
import { cn } from '@/lib/utils';
import { usePrefersReducedMotion } from '@/components/mascot/agent-mascot';
import { applyLanguage } from './language';
import { SchemeSwitch } from './scheme-switch';
import { OnboardingProvider, type OnboardingNav } from './onboarding-context';
import {
  asksFormerChatStep, canGoBack, DOTTED_STEPS, isLastStep, nextStep, previousStep, progressDots, stepFromSearch, stepHref, type OnboardingStepId,
} from './onboarding-flow';
import { ONBOARDING_COMPANIONS, ONBOARDING_GATE, ONBOARDING_STEPS, type OnboardingCompanion, type OnboardingStepEntry } from './steps/registry';
import type { OnboardingGate } from './service-gate';
import { BrandLogo } from '@/components/brand-logo';

function transition(swap: () => void, reduced: boolean): void {
  if (reduced || typeof document.startViewTransition !== 'function') {
    swap();
    return;
  }
  const root = document.documentElement;
  root.dataset.rooksVt = 'onboarding';
  const vt = document.startViewTransition(() => { flushSync(swap); });
  void vt.finished.finally(() => { delete root.dataset.rooksVt; });
}

type Position = { step: OnboardingStepId; direction: 1 | -1 };

export async function afterLastStep(): Promise<void> {
  window.location.assign(welcomeLanding(await fetchCapabilities(true).catch(() => null)));
}

export type OnboardingShellProps = {
  steps?: readonly OnboardingStepEntry[];
  companions?: readonly OnboardingCompanion[];
  gate?: OnboardingGate;
  finish?: () => void;
};

export function OnboardingShell({
  steps = ONBOARDING_STEPS, companions = ONBOARDING_COMPANIONS, gate: Gate = ONBOARDING_GATE, finish,
}: OnboardingShellProps): ReactElement | null {
  const [at, setAt] = useState<Position | null>(null);
  const [, setLanguageShown] = useState(getLocale);
  const reduced = usePrefersReducedMotion();
  const backHandler = useRef<(() => boolean) | null>(null);
  const current = useRef<OnboardingStepId>('splash');
  const motion = useRef(reduced);
  motion.current = reduced;
  const finishRef = useRef(finish ?? (() => { void afterLastStep(); }));
  finishRef.current = finish ?? finishRef.current;

  useEffect(() => {
    if (asksFormerChatStep(window.location.search)) { finishRef.current(); return; }
    const step = stepFromSearch(window.location.search);
    current.current = step;
    setAt({ step, direction: 1 });
  }, []);

  const goTo = useCallback((step: OnboardingStepId, direction: 1 | -1 = 1): void => {
    if (step === current.current) return;
    current.current = step;
    window.history.replaceState(window.history.state, '', stepHref(step));
    transition(() => {
      backHandler.current = null;
      setAt({ step, direction });
    }, motion.current);
  }, []);

  const next = useCallback((): void => {
    const step = nextStep(current.current);
    if (step) goTo(step, 1);
    else if (isLastStep(current.current)) finishRef.current();
  }, [goTo]);

  const back = useCallback((): void => {
    const step = previousStep(current.current);
    if (step) goTo(step, -1);
  }, [goTo]);

  const setLanguage = useCallback(async (tag: string): Promise<string> => {
    const active = await applyLanguage(tag, document);
    setLanguageShown(active);
    return active;
  }, []);

  const setBackHandler = useCallback((handler: (() => boolean) | null): void => {
    backHandler.current = handler;
  }, []);

  const nav = useMemo<OnboardingNav | null>(() => (at
    ? { step: at.step, direction: at.direction, next, back, goTo: (id) => goTo(id, 1), setLanguage, setBackHandler }
    : null), [at, next, back, goTo, setLanguage, setBackHandler]);

  if (!at || !nav) return null;

  const entry = steps.find((candidate) => candidate.id === at.step);
  const Step = entry?.Component;
  const stays = entry?.leavesPage !== true;
  const dots = progressDots(at.step);
  const onBack = (): void => {
    if (backHandler.current?.()) return;
    back();
  };
  const stepIndex = DOTTED_STEPS.indexOf(at.step);

  return (
    <OnboardingProvider value={nav}>
      <div className="fixed inset-0 overflow-hidden bg-background text-foreground">
        <header className="absolute inset-x-0 top-0 z-20 flex h-12 items-center justify-between border-b border-border px-3 sm:px-4">
          <div className="flex min-w-0 shrink-0 items-center gap-2 sm:min-w-[120px]">
            {canGoBack(at.step) ? (
              <Button variant="ghost" size="sm" className="h-8 gap-1 rounded-lg px-2 text-[13px]" onClick={onBack}>
                <ChevronLeft className="h-4 w-4" aria-hidden />
                {t('onboarding.back')}
              </Button>
            ) : (
              <span className="inline-flex items-center gap-2 text-[13px] font-medium tracking-[-0.02em]">
                <BrandLogo className="h-5 w-5" alt="" />
                Rooks
              </span>
            )}
          </div>
          {dots ? (
            <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2">
              <span className="sr-only">
                {t('onboarding.progress', { current: stepIndex + 1, total: DOTTED_STEPS.length })}
              </span>
              {dots.map((state, k) => (
                <i
                  key={k}
                  aria-hidden
                  data-dot={state}
                  className={cn(
                    'rooks-onboarding-dot block h-1.5 rounded-full',
                    state === 'current' ? 'w-5 bg-foreground' : 'w-1.5',
                    state === 'done' && 'bg-muted-foreground/70',
                    state === 'todo' && 'bg-border',
                  )}
                />
              ))}
            </div>
          ) : <span className="h-1.5 w-5 flex-1" aria-hidden />}
          <div className="flex min-w-0 shrink-0 justify-end sm:min-w-[120px]">
            <SchemeSwitch className="rounded-lg border border-border bg-card p-0.5" />
          </div>
        </header>
        {/* Timon stage: step owns its width — no outer max-w cage. */}
        <main className="absolute inset-0 top-12 flex flex-col items-center justify-center overflow-auto p-4 sm:p-6 md:p-8">
          {Step && <Gate step={at.step}><Step key={at.step} /></Gate>}
        </main>
        {companions.map((Companion, i) => <Companion key={i} step={at.step} stays={stays} />)}
      </div>
    </OnboardingProvider>
  );
}
