/**
 * First-run wizard steps as the rest of the daemon hears them: a closed list
 * of step names and outcomes, published on the bus by the routes that answer
 * them. Product analytics (`@timon/telemetry`) counts where people stop; any
 * other listener gets the same two words and nothing the person typed.
 */
import { bus } from './bus.js';

export const ONBOARDING_STEPS = [
  'account',
  'configuration',
  'resume',
  'install_service',
  'install_binary',
  'main_agent',
  'agent_chat',
  'restart',
  'team',
] as const;
export type OnboardingStepName = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_STEP_ACTIONS = ['completed', 'skipped', 'failed'] as const;
export type OnboardingStepAction = (typeof ONBOARDING_STEP_ACTIONS)[number];

/** Never throws: a listener's failure must not turn a wizard answer into a 500. */
export function onboardingStep(step: OnboardingStepName, action: OnboardingStepAction): void {
  try {
    bus.publish({ kind: 'onboarding_step', step, action });
  } catch {
    /* the step itself succeeded; its announcement is best effort */
  }
}
