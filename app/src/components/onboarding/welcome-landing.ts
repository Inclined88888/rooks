/**
 * Where a reader who just signed in goes: the mascot step of the upgrade
 * welcome when the daemon offers it (docs/ONBOARDING.md, `Upgrade welcome`),
 * else the login's own landing. Shared by `/login` and the onboarding's
 * sign-in, so either way of signing in leads to the same place.
 */
import type { AuthMe } from '@/lib/auth';
import { authLanding } from '@/lib/auth-landing';
import { forgetAllChatMissions } from '@/lib/chat-mission-cache';
import { stepHref } from './onboarding-flow';

export async function signedInTarget(me: Pick<AuthMe, 'welcome'>, landing: () => Promise<string> = authLanding): Promise<string> {
  return me.welcome === 'mascot' ? stepHref('mascot') : landing();
}

/**
 * A full navigation, as the login always did: the page was mounted
 * anonymously, and every viewer-scoped store and stream has to start again
 * under the new session.
 */
export async function landAfterSignin(me: Pick<AuthMe, 'welcome'>): Promise<void> {
  const target = await signedInTarget(me);
  forgetAllChatMissions();
  window.location.replace(target);
}
