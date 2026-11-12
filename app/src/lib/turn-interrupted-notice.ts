/**
 * The sentence rendered in the thread for a persisted `turn_interrupted`
 * event: a turn the user stopped, or one a daemon restart cut short.
 *
 * A pure module, like `spawn-failure-notice.ts`: it is all the user reads of
 * why the answer stopped, so a test locks it.
 */
import { t as i18n } from './i18n';

/** Payload of the `turn_interrupted` event (orchestrator/src/agent.ts). */
export type TurnInterruptedPayload = { resumable?: boolean; turn_active?: boolean; reason?: unknown };

export function turnInterruptedNotice(p: TurnInterruptedPayload): string {
  // The user redirected the turn (TODO #488): it goes on with their words.
  if (p.reason === 'steered') return i18n('chatPage.turnSteered');
  // Written by the boot sweep: nobody pressed stop, so say who cut the turn
  // (TIM-0119) — "turn interrupted" alone reads like the user's own gesture.
  const what = p.reason === 'daemon_restarted'
    ? i18n('chatPage.turnCutByRestart')
    : p.turn_active === false
    ? i18n('chatPage.processStoppedNoTurn')
    : i18n('chatPage.turnInterrupted');
  const next = p.resumable
    ? i18n('chatPage.conversationResumable')
    : i18n('chatPage.hardStop');
  return `${what} — ${next}`;
}
