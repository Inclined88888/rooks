/**
 * Where the app opens once onboarding is over: `/bots`, the main bot's chat
 * beside the rail of bots — the view that reads at a glance. Back on the
 * cockpit (`/`) when this viewer cannot reach it: its module switched off, or
 * a surface their role does not grant.
 */
import { isModuleOn, isPageSurfaceAllowed, type Capabilities } from '@/lib/capabilities';

export const SETUP_LANDING = '/bots';
const SETUP_LANDING_MODULE = '@timon/bots';

/** `null` capabilities (read failed): the cockpit, which every install has. */
export function setupLanding(caps: Capabilities | null): string {
  if (!caps) return '/';
  return isModuleOn(caps, SETUP_LANDING_MODULE) && isPageSurfaceAllowed(caps, SETUP_LANDING) ? SETUP_LANDING : '/';
}

/**
 * Where the onboarding hands over once the main agent is made: its welcome, on
 * the TIMs page — or the repair screen, which hosts the same conversation, when
 * this viewer cannot reach that page. `null` capabilities: the TIMs page, whose
 * gate (`firstRunTarget`) corrects the address once they are read.
 */
export function welcomeLanding(caps: Capabilities | null): string {
  if (!caps) return SETUP_LANDING;
  return setupLanding(caps) === SETUP_LANDING ? SETUP_LANDING : '/setup/agent';
}
