/**
 * Which bubble of a conversation shows the agent's live mascot, and in which
 * state (TODO #902). Pure: the chat passes its messages and its own activity.
 *
 * Every agent bubble used to mount a live mascot fed by the page's store,
 * which knows the agent, not the conversation: a card waiting for an answer
 * made every bubble of that agent hop, in this chat and in every other chat
 * of the same agent. Now one bubble is live — the card that waits, otherwise
 * the bubble being written, otherwise the agent's last one — and it shows
 * what THIS conversation does. The others keep the agent's look, still.
 */
import { RESTING } from '@/components/mascot/agent-live-state';
import type { MascotState } from '@/components/mascot/mascot-states';

/** The bubble being written (streamed text, or the "thinking" bubble), which has no message id yet. */
export const STREAM_BUBBLE_ID = '__stream__';

export type BubbleMsg = {
  id: string;
  role: string;
  perm?: { state?: string } | null;
  cmd?: { status?: string } | null;
  proposal?: { status?: string } | null;
  avatarRequest?: { state?: string } | null;
  secretRequest?: { status?: string } | null;
};

/** The roles drawn on the agent's side, with its avatar. */
const AGENT_SIDE: ReadonlySet<string> = new Set(['agent', 'permission', 'command', 'proposal', 'avatar', 'ui', 'secret']);

/** A card that waits for the person's answer — what `awaitingUser` counts. */
export function isPendingCard(m: BubbleMsg): boolean {
  return m.perm?.state === 'pending' || m.cmd?.status === 'pending' || m.proposal?.status === 'pending'
    || m.avatarRequest?.state === 'pending' || m.secretRequest?.status === 'pending';
}

/** The id of the one live bubble, or `null` when the agent has none on screen. */
export function liveBubbleOf(messages: readonly BubbleMsg[], streaming: boolean): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (isPendingCard(m)) return m.id;
  }
  if (streaming) return STREAM_BUBBLE_ID;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (AGENT_SIDE.has(m.role)) return m.id;
  }
  return null;
}

/**
 * The live bubble's state: this conversation's activity (`activityState`)
 * first. Without one, only what the store says of the agent that is not
 * about another conversation — a short reaction, or asleep; anything else
 * (waiting, working elsewhere) shows as idle here.
 */
export function bubbleState(local: MascotState | null, stored: MascotState | null): MascotState {
  if (local) return local;
  if (stored === 'happy' || stored === 'celebrate' || stored === RESTING) return stored;
  return 'idle';
}
