'use client';

/**
 * "What brings you here?" (right after the language model): three rows. A
 * click records the profile on the daemon (`PUT /api/onboarding/profile`) and
 * opens the agent step, whose creation view follows that answer
 * (`agentViewFor`). The guided tour reads the same row and never asks again.
 */
import { useState, type ReactElement } from 'react';
import { ChevronRight } from 'lucide-react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useOnboarding } from '../onboarding-context';
import { useOnboardingProfile, type OnboardingProfile } from '../onboarding-profile';

const ROWS: readonly OnboardingProfile[] = ['developer', 'automation', 'beginner'];

export function ProfileStep(): ReactElement {
  const { next } = useOnboarding();
  const { profile: recorded, save } = useOnboardingProfile();
  const [picked, setPicked] = useState<OnboardingProfile | null>(null);
  const [failed, setFailed] = useState(false);

  const choose = async (profile: OnboardingProfile): Promise<void> => {
    if (picked !== null) return;
    setPicked(profile);
    setFailed(false);
    try {
      await save(profile);
    } catch {
      setPicked(null);
      setFailed(true);
      return;
    }
    next();
  };

  return (
    <section data-onboarding-step="profile" className="flex w-full max-w-[560px] flex-col items-center text-center">
      <h1 className="text-[30px] font-bold leading-tight tracking-[-0.02em]">{t('onboarding.profile.title')}</h1>
      <p className="mb-[26px] mt-2.5 text-[15px] leading-normal text-muted-foreground">{t('onboarding.profile.subtitle')}</p>
      <div
        role="group"
        aria-label={t('onboarding.profile.title')}
        aria-busy={picked !== null}
        className="flex w-full flex-col gap-0.5 rounded-2xl bg-card p-1.5 text-left shadow-elev-3 ring-1 ring-border"
      >
        {ROWS.map((profile, i) => (
          <button
            key={profile}
            type="button"
            data-profile={profile}
            aria-current={recorded === profile ? 'true' : undefined}
            disabled={picked !== null}
            onClick={() => { void choose(profile); }}
            style={{ animationDelay: `${0.08 * i}s` }}
            className={cn(
              'timon-onboarding-rise group flex w-full items-center gap-3.5 rounded-xl p-3.5 text-left transition-colors',
              'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
              (recorded === profile || picked === profile) && 'bg-muted',
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[14.5px] font-semibold">{t(`onboarding.profile.${profile}.title`)}</span>
              <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{t(`onboarding.profile.${profile}.description`)}</span>
            </span>
            <ChevronRight
              aria-hidden
              className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-[3px] group-hover:text-foreground"
            />
          </button>
        ))}
      </div>
      {failed && (
        <p role="alert" className="mt-3 text-sm text-destructive">{t('onboarding.profile.failed')}</p>
      )}
    </section>
  );
}
