'use client';

/**
 * Sends an unconfigured install to `/setup`, from wherever it landed
 * (step 5.9.2).
 *
 * Mounted on the ROOT layout, beside `ClientPluginHost`: every page goes
 * through it, `(main)` pages and full-canvas ones alike. Kept as its own
 * component rather than folded into that host, because mounting plugins is not
 * routing — and because a host that suddenly needed a router would break every
 * test that renders it alone.
 *
 * Why this exists at all: step 5.7.4 shipped a blocking `/setup` screen and no
 * route to it. On the first real launch of the package the user created their account,
 * landed on the home page, and stopped there — daemon still `firstRun: true`,
 * no `timon.config.json`, no service installed, nothing on screen saying so.
 *
 * The decision is in `@/lib/first-run-gate`, where the flow is tested.
 */
import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { isPageSurfaceAllowed, useCapabilities } from '@/lib/capabilities';
import { firstRunTarget, SETUP_PATH } from '@/lib/first-run-gate';
import { SETUP_LANDING, setupLanding } from '@/app/setup/agent/setup-landing';

export function FirstRunGate(): null {
  const caps = useCapabilities();
  const pathname = usePathname();
  const router = useRouter();
  const canConfigure = caps === null ? undefined : isPageSurfaceAllowed(caps, SETUP_PATH);
  const welcomeAvailable = caps === null ? undefined : setupLanding(caps) === SETUP_LANDING;

  useEffect(() => {
    const target = firstRunTarget({
      pathname: pathname ?? '/',
      firstRun: caps?.firstRun,
      teamOnboarding: caps?.teamOnboarding,
      mainAgentOnboarding: caps?.mainAgentOnboarding,
      restartOnboarding: caps?.restartOnboarding,
      // The same predicate `ModulePageGate` will apply on arrival.
      canConfigure,
      welcomeAvailable,
    });
    // `replace`, not `push`: the unconfigured home page is not a step anyone
    // should be able to walk back to.
    if (target) router.replace(target);
  }, [caps?.firstRun, caps?.teamOnboarding, caps?.mainAgentOnboarding, caps?.restartOnboarding, canConfigure, welcomeAvailable, pathname, router]);

  return null;
}
