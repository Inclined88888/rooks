'use client';

/**
 * The onboarding (docs/ONBOARDING.md): welcome, account, LLM, profile, agent,
 * "Discover Timon". Outside `(main)`, like `/setup`: no top bar, no navigation. Reachable
 * without a session — the welcome and the account come before any account
 * exists (`pageRequiresLogin`); every later step talks to routes that check
 * the session themselves.
 */
import { OnboardingShell } from '@/components/onboarding/onboarding-shell';

export default function OnboardingPage() {
  return <OnboardingShell />;
}
