'use client';

/**
 * The guard of the steps that need the daemon service (`SERVICE_STEPS` in
 * `@/lib/setup-plan`, which says which and why): the agent step.
 *
 * Until the service is ready the step is not mounted — a waiting screen, or the
 * refusal with what to do. Once it is, the guard writes `rooks.config.json`
 * (the first run ends here, after the service, as `/api/onboarding` requires)
 * and, on the desktop, hands the embedded daemon over to the service before
 * the step opens on it. Every other step goes straight through.
 */
import { useEffect, type ReactElement, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { stepNeedsService } from '@/lib/setup-plan';
import { stepHref, type OnboardingStepId } from './onboarding-flow';
import { preparation, usePreparation } from './preparation';
import { PreparationFailureHelp, REPAIR_HREF } from './preparation-card';

export type OnboardingGate = (props: { step: OnboardingStepId; children: ReactNode }) => ReactElement;

function Waiting({ title, body }: { title: string; body?: string }): ReactElement {
  return (
    <div role="status" className="flex max-w-md flex-col items-center gap-3 text-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
      <h1 className="text-xl font-semibold">{title}</h1>
      {body && <p className="text-sm text-muted-foreground">{body}</p>}
    </div>
  );
}

function GuardedStep({ step, children }: { step: OnboardingStepId; children: ReactNode }): ReactElement {
  const view = usePreparation();

  // A reload straight onto `?step=agent` starts the preparation here: the card is hidden on this step.
  useEffect(() => {
    void preparation().start().then(() => preparation().nudge());
  }, []);

  useEffect(() => {
    if (view.gate === 'configure' && !view.configuring && view.configureError === null) {
      void preparation().configure(stepHref(step));
    }
  }, [view.gate, view.configuring, view.configureError, step]);

  if (view.gate === 'open') return <>{children}</>;

  if (view.gate === 'blocked') {
    return (
      <div role="alert" className="flex w-full max-w-lg flex-col gap-3">
        <h1 className="text-xl font-semibold">{t('onboarding.preparation.gate.blockedTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('onboarding.preparation.gate.blockedBody')}</p>
        <div className="rounded-xl bg-card p-4 shadow-elev-1">
          <PreparationFailureHelp view={view} />
        </div>
      </div>
    );
  }

  if (view.configureError !== null) {
    return (
      <div role="alert" className="flex w-full max-w-lg flex-col gap-3">
        <h1 className="text-xl font-semibold">{t('onboarding.preparation.gate.configureFailed')}</h1>
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{view.configureError}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void preparation().configure(stepHref(step))}>
            {t('onboarding.preparation.retry')}
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <a href={REPAIR_HREF}>{t('onboarding.preparation.repair')}</a>
          </Button>
        </div>
      </div>
    );
  }

  if (view.gate === 'configure') return <Waiting title={t('onboarding.preparation.gate.configuring')} />;

  return (
    <Waiting
      title={t('onboarding.preparation.gate.waitTitle')}
      body={view.phase === 'account' ? t('onboarding.preparation.gate.waitAccount') : t('onboarding.preparation.gate.waitBody')}
    />
  );
}

/**
 * The shell's guard: the service steps wait for the service, the others pass.
 * A stand-in service step is held like a real one: it only mounts, and so
 * only leaves the page, once the configuration is written (`SERVICE_STEPS`).
 */
export function ServiceGate({ step, children }: { step: OnboardingStepId; children: ReactNode }): ReactElement {
  if (!stepNeedsService(step)) return <>{children}</>;
  return <GuardedStep step={step}>{children}</GuardedStep>;
}
