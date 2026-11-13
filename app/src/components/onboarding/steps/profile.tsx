'use client';

/**
 * "What brings you here?" — three calm rows (Timon flow), no mascots.
 * Writes `PUT /api/onboarding/profile` then opens the agent step.
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
      // save() keeps the choice locally when the daemon refuses auth — still continue.
      setFailed(true);
    }
    next();
  };

  return (
    <section data-onboarding-step="profile" className="flex w-full max-w-[560px] flex-col items-center px-4 text-center sm:px-0">
      <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.025em]">{t('onboarding.profile.title')}</h1>
      <p className="mb-6 mt-2 text-[13.5px] leading-relaxed text-muted-foreground">{t('onboarding.profile.subtitle')}</p>
      <div
        role="group"
        aria-label={t('onboarding.profile.title')}
        aria-busy={picked !== null}
        className="flex w-full flex-col gap-0.5 rounded-lg border border-border bg-background p-1 text-left"
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
              'rooks-onboarding-rise group flex w-full items-center gap-3.5 rounded-md p-3 text-left transition-colors',
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
        <p role="status" className="mt-3 text-sm text-muted-foreground">{t('onboarding.profile.savedLocally')}</p>
      )}
      <button
        type="button"
        data-profile-skip
        className="mt-4 text-[13px] text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline"
        onClick={next}
      >
        {t('onboarding.profile.skip')}
      </button>
    </section>
  );
}
