/**
 * Pure half of the GPT-Live bridge: the spoken exchange grouped into turns,
 * which of those turns become a delegated request, and how the agent's answer
 * is cut down to what GPT-Live accepts.
 *
 * GPT-Live streams two transcripts — the user's words and what it actually
 * says — as bare fragments with no turn boundary (OpenAI, "Transcript
 * deltas"). A turn closes here when the other speaker takes the floor, or
 * after a silence: `TURN_GAP_MS` for the user, `VOICE_GAP_MS` for GPT-Live.
 *
 * In client delegation, `session.delegation.created` carries no task text,
 * only an id: the request is rebuilt from the user's turns heard since the
 * previous delegation. Those turns are therefore HELD, not journaled, until we
 * know their fate — a delegated turn becomes the mission's user message, and
 * journaling it too would show it twice. A held turn is journaled once
 * GPT-Live has answered it itself (its own turn closes without a delegation).
 */

/** GPT-Live accepts at most 500 tokens per append. ~3 characters a token in
 *  French keeps a margin; the full answer stays in the chat anyway. */
export const MAX_SPOKEN_CHARS = 1400;

/** Silence after which a user turn is over. */
export const TURN_GAP_MS = 1200;

/** Silence after which GPT-Live's own turn is over. Its transcript arrives at
 *  the pace of the audio, and the synthesis pauses well past `TURN_GAP_MS` on
 *  an identifier read out character by character: one answer then split into
 *  two bubbles. The user speaking still closes it at once. */
export const VOICE_GAP_MS = 6000;

function gap(speaker: VoiceSpeaker): number {
  return speaker === 'voice' ? VOICE_GAP_MS : TURN_GAP_MS;
}

/** GPT-Live is audibly talking: its turn is open AND a fragment came recently.
 *  An open voice turn alone is not enough, it outlives the speech by
 *  `VOICE_GAP_MS`. */
export function isSpeaking(state: VoiceTranscript, now: number): boolean {
  const turn = state.open.voice;
  return !!turn && now - turn.lastAt <= TURN_GAP_MS;
}

/** Spoken turns handed to the agent with a delegated request, at most. */
export const MAX_CONTEXT_TURNS = 12;
export const MAX_CONTEXT_CHARS = 4000;

/** `voice` is GPT-Live itself: its output transcript, what the user heard. */
export type VoiceSpeaker = 'user' | 'voice';

export type VoiceTurn = {
  id: string;
  speaker: VoiceSpeaker;
  /** Fragments concatenated exactly as received. */
  text: string;
  startMs: number | null;
  endMs: number | null;
  /** Local clock of the last fragment, for the silence rule. */
  lastAt: number;
  /** GPT-Live reading out an answer the agent already wrote in the thread:
   *  the chat shows the written one only. */
  relay?: boolean;
};

export type VoiceTranscript = {
  open: { user: VoiceTurn | null; voice: VoiceTurn | null };
  /** Closed user turns whose fate is not known yet. */
  held: VoiceTurn[];
  /** Journaled turns since the last delegation: the agent never heard them. */
  recent: VoiceTurn[];
  /** Request of the previous delegation, reused when GPT-Live delegates
   *  twice on one utterance (a correction, a follow-up). */
  lastRequest: string;
  /** An agent answer was handed to GPT-Live and the user has not spoken
   *  since: whatever it says now is that answer read aloud. */
  relaying: boolean;
};

export type Fragment = { delta: string; startMs?: number | null; endMs?: number | null };

/** What a transition produced: turns to write into the mission, in order. */
export type Step = { state: VoiceTranscript; journal: VoiceTurn[] };

export function emptyTranscript(): VoiceTranscript {
  return { open: { user: null, voice: null }, held: [], recent: [], lastRequest: '', relaying: false };
}

export function turnText(turn: VoiceTurn): string {
  return turn.text.replace(/\s+/g, ' ').trim();
}

function other(speaker: VoiceSpeaker): VoiceSpeaker {
  return speaker === 'user' ? 'voice' : 'user';
}

function remember(recent: VoiceTurn[], turns: VoiceTurn[]): VoiceTurn[] {
  return [...recent, ...turns].slice(-MAX_CONTEXT_TURNS);
}

/** A user turn waits for its fate; a voice turn settles every held one. */
function close(state: VoiceTranscript, speaker: VoiceSpeaker): Step {
  const turn = state.open[speaker];
  if (!turn) return { state, journal: [] };
  const open = { ...state.open, [speaker]: null };
  if (!turnText(turn)) return { state: { ...state, open }, journal: [] };
  if (speaker === 'user') return { state: { ...state, open, held: [...state.held, turn] }, journal: [] };
  const journal = [...state.held, turn];
  return { state: { ...state, open, held: [], recent: remember(state.recent, journal) }, journal };
}

function chain(first: Step, next: (state: VoiceTranscript) => Step): Step {
  const second = next(first.state);
  return { state: second.state, journal: [...first.journal, ...second.journal] };
}

/** One transcript fragment. `newId` names the turn it opens, if it opens one. */
export function appendFragment(
  state: VoiceTranscript,
  speaker: VoiceSpeaker,
  fragment: Fragment,
  now: number,
  newId: () => string,
): Step {
  let step = close(state, other(speaker));
  const current = step.state.open[speaker];
  if (current && now - current.lastAt > gap(speaker)) step = chain(step, (s) => close(s, speaker));
  // The user taking the floor ends the reading: GPT-Live's next words answer them.
  if (speaker === 'user' && step.state.relaying) step = { ...step, state: { ...step.state, relaying: false } };
  const open = step.state.open[speaker];
  const turn: VoiceTurn = open
    ? {
        ...open,
        text: open.text + fragment.delta,
        endMs: fragment.endMs ?? open.endMs,
        lastAt: now,
      }
    : {
        id: newId(),
        speaker,
        text: fragment.delta,
        startMs: fragment.startMs ?? null,
        endMs: fragment.endMs ?? null,
        lastAt: now,
        ...(speaker === 'voice' && step.state.relaying ? { relay: true } : {}),
      };
  return { state: { ...step.state, open: { ...step.state.open, [speaker]: turn } }, journal: step.journal };
}

/** An agent answer was just handed to GPT-Live. What it was saying before
 *  closes now, so the reading starts a turn of its own. */
export function startRelay(state: VoiceTranscript): Step {
  const step = close(state, 'voice');
  return { state: { ...step.state, relaying: true }, journal: step.journal };
}

/** Clock tick: closes the turns that went silent. */
export function closeIdle(state: VoiceTranscript, now: number): Step {
  let step: Step = { state, journal: [] };
  for (const speaker of ['user', 'voice'] as const) {
    const turn = step.state.open[speaker];
    if (turn && now - turn.lastAt > gap(speaker)) step = chain(step, (s) => close(s, speaker));
  }
  return step;
}

/** End of session: everything still pending is part of the conversation. */
export function flushAll(state: VoiceTranscript): Step {
  const pending = [
    ...state.held,
    ...[state.open.user, state.open.voice].filter((t): t is VoiceTurn => !!t && !!turnText(t)),
  ].sort((a, b) => (a.startMs ?? a.lastAt) - (b.startMs ?? b.lastAt));
  return { state: emptyTranscript(), journal: pending };
}

/** Plain-text recap of the turns the agent never heard, newest kept first. */
export function voiceContext(turns: readonly VoiceTurn[]): string {
  const lines: string[] = [];
  let budget = MAX_CONTEXT_CHARS;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    const line = `${turn.speaker === 'user' ? 'User' : 'Voice assistant'}: ${turnText(turn)}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.unshift(line);
  }
  return lines.join('\n');
}

export type Delegation = {
  state: VoiceTranscript;
  /** The user's words that make up the request; empty if nothing was heard. */
  request: string;
  /** Earlier spoken exchanges, for the agent to know what "it" refers to. */
  context: string;
  /** Turns folded into the request: their live bubbles give way to the
   *  mission's user message. */
  consumed: VoiceTurn[];
};

export function takeDelegation(state: VoiceTranscript): Delegation {
  const closed = close(state, 'user').state;
  const consumed = closed.held;
  const heard = consumed.map(turnText).join(' ').trim();
  const request = heard || state.lastRequest;
  return {
    state: { ...closed, held: [], recent: [], lastRequest: request },
    request,
    context: voiceContext(closed.recent),
    consumed,
  };
}

/** Agent bubbles are HTML; GPT-Live wants plain prose, without code blocks it
 *  would read aloud character by character. */
export function spokenAnswer(html: string, plain: (html: string) => string): string {
  const withoutCode = html.replace(/<pre[\s\S]*?<\/pre>/gi, ' (code shown in the chat) ');
  const text = plain(withoutCode).replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_SPOKEN_CHARS) return text;
  const cut = text.slice(0, MAX_SPOKEN_CHARS);
  const sentence = cut.lastIndexOf('. ');
  return `${sentence > MAX_SPOKEN_CHARS / 2 ? cut.slice(0, sentence + 1) : cut}… (the rest is in the chat)`;
}
