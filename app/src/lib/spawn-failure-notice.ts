/**
 * The sentence rendered in the thread when a backend CLI never started
 * (persisted `spawn_failed` event).
 *
 * A pure module, like `stream-delta.ts`: this is the ONLY thing the user will
 * read of that mission — it has no reply, no `result`, nothing else. A string
 * built in the middle of a 4000-line component is only ever checked by eye;
 * here a test locks it.
 */
import { t } from './i18n';

/** Payload of the `spawn_failed` event (orchestrator/src/agent.ts). */
export type SpawnFailedPayload = {
  backend?: unknown;
  binary?: unknown;
  cause?: unknown;
};

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/**
 * Text of the notice. The cause decides the repair gesture: a missing binary
 * gets installed, a non-executable one gets fixed — confusing the two sends
 * the tester reinstalling what they already have.
 */
export function spawnFailureNotice(payload: SpawnFailedPayload): string {
  const vars = {
    backend: text(payload.backend, '?'),
    binary: text(payload.binary, '?'),
  };
  if (payload.cause === 'missing') return t('chatPage.spawnFailedMissing', vars);
  if (payload.cause === 'not_executable') return t('chatPage.spawnFailedNotExecutable', vars);
  return t('chatPage.spawnFailedUnknown', vars);
}
