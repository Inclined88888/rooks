/**
 * The guided tour: a conversation with the main agent that runs the
 * `rooks-onboarding` skill, with the user's own consent to let it open pages.
 *
 * It starts from a click — the offer after the setup, or the item of the
 * appearance menu — never from an agent: the click creates the mission AND the
 * grant that lets that mission navigate (`navigate-proposals.ts`).
 */
import { resolveChatAgent } from './chat-entry';
import { loadLayout, saveLayout } from './ui-layout-store';
import { chatHref, chatIslandContent } from './chat-island-params';
import { openInIsland } from './island-bus';
import { requestNavigation, startGuidedTour } from './navigate-proposals';
import { machineSessionStorage } from '@/lib/machines/machine-storage';

/**
 * Switched off for the launch (the maintainer, 05/11/2026): the tours proposed menu
 * arrangements that hid most of the product, the TIMs included. While `false`,
 * nothing starts the tour — no offer card, no start after the setup welcome,
 * no item in the appearance menu — and the welcome no longer offers it
 * (`rooks-main-agent-setup` v12). The skills stay seeded for when it returns.
 */
export const GUIDED_TOUR_ENABLED = false;

/** Account row: has the tour been offered (answered) already. */
export const TOUR_OFFER_SCOPE = 'onboarding.tour';

export type TourOfferState = {
  pathname: string;
  /** Capabilities not loaded yet: `undefined`. */
  firstRun: boolean | undefined;
  teamOnboarding?: boolean;
  mainAgentOnboarding?: boolean;
  restartOnboarding?: boolean;
  /** The account's row answered: `null` while it is unknown. */
  offered: boolean | null;
};

/** Pages where a card would be noise: login, the setup, a page that is not the app. */
const QUIET = ['/login', '/onboarding', '/setup', '/invite', '/confirm-email'];

/** One decision, pure: a card is offered once, on a configured install, in the app. */
export function shouldOfferTour(s: TourOfferState, enabled = GUIDED_TOUR_ENABLED): boolean {
  if (!enabled) return false;
  if (s.offered !== false) return false;
  if (s.firstRun !== false) return false;
  if (s.teamOnboarding || s.mainAgentOnboarding || s.restartOnboarding) return false;
  const path = s.pathname.replace(/\/+$/, '') || '/';
  return !QUIET.some((q) => path === q || path.startsWith(`${q}/`));
}

/** Session flag set by the setup wizard: the tour follows the setup conversation, no offer card. */
const AUTO_TOUR_KEY = 'rooks.setup.autoTour';

export function armAutoTour(): void {
  try { machineSessionStorage()?.setItem(AUTO_TOUR_KEY, '1'); } catch { /* private mode: the offer card remains */ }
}

export function autoTourArmed(): boolean {
  try { return machineSessionStorage()?.getItem(AUTO_TOUR_KEY) === '1'; } catch { return false; }
}

export function disarmAutoTour(): void {
  try { machineSessionStorage()?.removeItem(AUTO_TOUR_KEY); } catch { /* nothing to clear */ }
}

/**
 * Right after the setup the tour starts on its own: the steps are answered and
 * the app is on screen. A pending restart does not hold it — the top bar's
 * banner offers it once the tour is done (decision of 16/10/2026).
 */
export function shouldAutoStartTour(s: Omit<TourOfferState, 'offered' | 'restartOnboarding'> & { armed: boolean }, enabled = GUIDED_TOUR_ENABLED): boolean {
  if (!enabled) return false;
  if (!s.armed || s.firstRun !== false) return false;
  if (s.teamOnboarding || s.mainAgentOnboarding) return false;
  const path = s.pathname.replace(/\/+$/, '') || '/';
  return !QUIET.some((q) => path === q || path.startsWith(`${q}/`));
}

export async function readTourOffered(): Promise<boolean | null> {
  const loaded = await loadLayout({ scope: TOUR_OFFER_SCOPE, storage: null });
  if (!loaded.ok) return null;
  const raw = loaded.raw as { offered?: unknown } | null;
  return raw !== null && typeof raw === 'object' && raw.offered === true;
}

export async function markTourOffered(): Promise<void> {
  await saveLayout({ offered: true, at: Date.now() }, { scope: TOUR_OFFER_SCOPE, storage: null });
}

/** One hint at a time, however often "Not now" is clicked. */
export const LATER_HINT_TOAST_ID = 'guided-tour-later';
export const LATER_HINT_MS = 8_000;

export type TourHintNotify = (message: string, opts: { id: string; duration: number }) => unknown;

/**
 * "Not now" closes the offer for good, so the user is told on the spot where
 * the tour stays (SUG-0073). Closing the card by its cross is not an answer to
 * explain: that path only marks the offer.
 */
export function declineTourOffer(
  notify: TourHintNotify,
  hint: string,
  mark: () => Promise<void> = markTourOffered,
): void {
  void mark();
  notify(hint, { id: LATER_HINT_TOAST_ID, duration: LATER_HINT_MS });
}

export type StartOutcome = { ok: true; missionId: string } | { ok: false; reason: 'no_agent' | 'failed' };

/**
 * Opens the conversation, then the grant for it, then the chat.
 * `firstMessage` starts with the skill's slash command, expanded by the daemon.
 */
export async function startOnboardingTour(
  firstMessage: string,
  opts: { agent?: string } = {},
): Promise<StartOutcome> {
  const agent = opts.agent ?? await resolveChatAgent(new URLSearchParams());
  if (!agent) return { ok: false, reason: 'no_agent' };
  let missionId: string | null = null;
  try {
    const res = await fetch('/api/ui/missions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_name: agent, mission: `/rooks-onboarding ${firstMessage}`.trim() }),
    });
    if (!res.ok) return { ok: false, reason: 'failed' };
    const body = await res.json() as { mission_id?: unknown };
    missionId = typeof body.mission_id === 'string' ? body.mission_id : null;
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (!missionId) return { ok: false, reason: 'failed' };
  // Without the grant the tour still works, through cards: not a reason to fail.
  await startGuidedTour(missionId);
  // The agent speaks in a popup that follows the user: a tour that moves the
  // page must not take the conversation away with it. No workspace to host it
  // (a page without one, a narrow screen) → the chat page, as before.
  const inPopup = openInIsland(chatIslandContent(agent, missionId), { edge: 'float', pinned: true });
  if (!inPopup) {
    requestNavigation(chatHref(agent, missionId));
  }
  return { ok: true, missionId };
}
