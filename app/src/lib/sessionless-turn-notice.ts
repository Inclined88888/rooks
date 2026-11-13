/**
 * The sentence rendered in the thread when a backend keeps no session
 * (persisted `sessionless_turn` event, orchestrator/src/agent.ts): the agent got
 * this message alone and nothing else says it forgot the turn before.
 */
import { t } from './i18n';

/** Payload of the `sessionless_turn` event. */
export type SessionlessTurnPayload = { backend?: unknown };

export function sessionlessTurnNotice(payload: SessionlessTurnPayload): string {
  const backend = typeof payload.backend === 'string' ? payload.backend.trim() : '';
  return t('chatPage.sessionlessTurn', { backend: backend || '?' });
}
