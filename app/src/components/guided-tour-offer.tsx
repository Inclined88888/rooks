'use client';

/**
 * Offers the guided tour once, after the setup: a card the user answers with
 * "Show me around" or "Not now". Answered either way, it is not shown
 * again on this account; the appearance menu keeps the tour one click away,
 * and "Not now" says so.
 */
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { useCapabilities } from '@/lib/capabilities';
import { autoTourArmed, declineTourOffer, disarmAutoTour, markTourOffered, readTourOffered, shouldAutoStartTour, shouldOfferTour, startOnboardingTour } from '@/lib/guided-tour';
import { t } from '@/lib/i18n';
import { islandWorkspaceReady } from '@/lib/island-bus';

const TOAST_ID = 'guided-tour-offer';
/** Past this, the tour starts anyway (in the chat page if no workspace showed up). */
const AUTO_TOUR_WAIT_MS = 10_000;

export function GuidedTourOffer(): null {
  const caps = useCapabilities();
  const pathname = usePathname() ?? '/';
  const offered = useRef<boolean | null>(null);
  const shown = useRef(false);

  // Read the account's answer once capabilities say the install is configured.
  const configured = caps !== null && caps.firstRun === false;
  useEffect(() => {
    if (!configured || offered.current !== null) return;
    let alive = true;
    void readTourOffered().then((value) => { if (alive) offered.current = value; });
    return () => { alive = false; };
  }, [configured]);

  useEffect(() => {
    if (shown.current || !caps) return;
    const since = Date.now();
    const timer = setInterval(() => {
      if (shown.current) { clearInterval(timer); return; }
      // Straight from the setup conversation: the tour starts, no card to answer.
      if (shouldAutoStartTour({
        pathname,
        firstRun: caps.firstRun,
        teamOnboarding: caps.teamOnboarding,
        mainAgentOnboarding: caps.mainAgentOnboarding,
        armed: autoTourArmed(),
      })) {
        // The popup needs the cockpit's island workspace: give it time to mount,
        // or the tour lands on the chat page instead of following the user.
        if (!islandWorkspaceReady() && Date.now() - since < AUTO_TOUR_WAIT_MS) return;
        shown.current = true;
        clearInterval(timer);
        disarmAutoTour();
        void markTourOffered();
        void startOnboardingTour(t('guidedTour.firstMessage')).then((out) => {
          if (!out.ok) toast.error(t('guidedTour.failed'));
        });
        return;
      }
      if (!shouldOfferTour({
        pathname,
        firstRun: caps.firstRun,
        teamOnboarding: caps.teamOnboarding,
        mainAgentOnboarding: caps.mainAgentOnboarding,
        restartOnboarding: caps.restartOnboarding,
        offered: offered.current,
      })) return;
      shown.current = true;
      clearInterval(timer);
      toast(t('guidedTour.offer.title'), {
        id: TOAST_ID,
        description: t('guidedTour.offer.body'),
        duration: Infinity,
        action: {
          label: t('guidedTour.offer.start'),
          onClick: () => {
            void markTourOffered();
            void startOnboardingTour(t('guidedTour.firstMessage')).then((out) => {
              if (!out.ok) toast.error(t('guidedTour.failed'));
            });
          },
        },
        cancel: { label: t('guidedTour.offer.later'), onClick: () => { declineTourOffer(toast, t('guidedTour.offer.laterHint')); } },
        onDismiss: () => { void markTourOffered(); },
      });
    }, 800);
    return () => clearInterval(timer);
  }, [caps, pathname]);

  return null;
}
