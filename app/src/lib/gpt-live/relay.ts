import { spokenAnswer } from './bridge';

/** The part of a chat message the relay reads. */
export type RelayMessage = { id: string; role: string; voice?: unknown; content: string };

/** The agent's written bubbles that appeared since `before`, joined. Voice
 *  bubbles are GPT-Live's own words: saying them back would echo. */
export function answerSince(messages: readonly RelayMessage[], before: ReadonlySet<string>): string {
  return messages
    .filter((message) => message.role === 'agent' && !message.voice && message.content && !before.has(message.id))
    .map((message) => message.content)
    .join('\n');
}

/** An agent turn GPT-Live did not ask for, watched since it started. */
export type UndelegatedWatch = { before: ReadonlySet<string> } | null;

export type RelayInput = {
  live: boolean;
  thinking: boolean;
  /** A delegation is queued or running: its answer goes back through it. */
  delegationPending: boolean;
  messages: readonly RelayMessage[];
};

/**
 * Follows the agent turns that start without a voice delegation (a typed
 * message, an ask_user answer, a mission waking up) and yields their written
 * answer once the turn ends, for GPT-Live to hear. A delegation in flight
 * covers whatever turn runs meanwhile, so the watch is dropped rather than
 * relaying the same answer twice.
 */
export function relayStep(
  watch: UndelegatedWatch,
  input: RelayInput,
  plain: (html: string) => string,
): { watch: UndelegatedWatch; relay: string | null } {
  if (!input.live || input.delegationPending) return { watch: null, relay: null };
  if (input.thinking) {
    return { watch: watch ?? { before: new Set(input.messages.map((message) => message.id)) }, relay: null };
  }
  if (!watch) return { watch: null, relay: null };
  // Nobody asked GPT-Live for this turn: a turn with nothing written stays silent.
  const text = spokenAnswer(answerSince(input.messages, watch.before), plain);
  return { watch: null, relay: text || null };
}
