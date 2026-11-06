/**
 * Provenance of a `user` chat event.
 *
 * Every text pushed into an agent's stdin is persisted as a `user` event —
 * whether the user typed it in the composer, an agent woke this one through the
 * inbox, or a mission return landed in its pilot. The chat used to draw all
 * of them as the human's own bubble. The origin below is added to the
 * persisted payload (`payload.origin`) so replayed history and live frames
 * carry the same information; absent = typed by the human, which keeps
 * events written before this field displaying exactly as before.
 */
import { messageOrigin, type MessageOrigin } from './message-origin.js';
import type { Source } from './db.js';
import type { PromptPresentation } from './prompt-presentation.js';

export type UserEventOriginKind = MessageOrigin | 'dispatcher' | 'fork' | 'system' | 'workflow';

export type UserEventOrigin = {
  kind: UserEventOriginKind;
  /** Runtime-authored display sections, persisted for live chat and history. */
  presentation?: PromptPresentation;
  /** Agent that produced the text — real agent name or daemon pseudo-sender. */
  from: string;
  /** Mission the text came out of, when there is exactly one. */
  mission_id?: string | null;
  /** Inbox ids supplied by the runtime, never inferred from the model's text. */
  message_ids?: string[];
  /** Timon's replay `n` of a turn the provider dropped (TODO #459): the same
   *  turn going on, not a new input. */
  turn_retry?: number;
};

/** Daemon pseudo-sender used when a digest mixes several senders. */
export const WAKE_SENDER = 'orchestrator-wake';
const DAEMON_SENDER = 'orchestrator';

function metaString(meta: unknown, key: string): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === 'string' && v ? v : null;
}

/**
 * Origin implied by the spawn source when the caller gives none. `null` for
 * the human chat (no source, or an `agent` channel with no parent — the UI
 * spawning an ephemeral agent) and for channels this module does not know.
 */
export function originFromSpawnSource(source: Source | undefined): UserEventOrigin | null {
  if (!source) return null;
  switch (source.channel) {
    case 'agent': {
      const from = metaString(source.meta, 'parent_agent');
      if (!from) return null;
      return { kind: 'agent', from, mission_id: metaString(source.meta, 'parent_mission_id') };
    }
    case 'wake':
      return { kind: 'wake', from: WAKE_SENDER };
    case 'dispatcher':
      return { kind: 'dispatcher', from: DAEMON_SENDER };
    case 'fork':
      return {
        kind: 'fork',
        from: metaString(source.meta, 'source_agent') ?? DAEMON_SENDER,
        mission_id: metaString(source.meta, 'from'),
      };
    case 'routine':
      return { kind: 'routine', from: DAEMON_SENDER };
    case 'librarian':
    case 'system':
    case 'recovery':
    case 'verification':
    case 'verification-loop':
    case 'pipeline':
    case 'doc':
      return { kind: 'system', from: DAEMON_SENDER };
    default:
      return null;
  }
}

export type DigestOriginMessage = {
  id?: string;
  from_agent: string;
  from_mission: string;
  payload: string;
};

/**
 * Origin of a wake prompt built from inbox messages. One sender → that
 * agent (the return payload's `agent` field wins, it is the mission's real
 * author). Several senders → the wake pseudo-sender, so the reader sees a
 * digest rather than a wrong name. The kind is the first message's: a
 * digest that opens with a mission return reads as one.
 */
export function originOfDigest(messages: DigestOriginMessage[]): UserEventOrigin {
  if (messages.length === 0) return { kind: 'wake', from: WAKE_SENDER };
  const senders = new Set<string>();
  const missions = new Set<string>();
  for (const m of messages) {
    senders.add(returnAgent(m.payload) ?? m.from_agent);
    missions.add(m.from_mission);
  }
  const first = messages[0]!;
  const ids = messages.flatMap((m) => m.id ? [m.id] : []);
  const receipt = ids.length ? { message_ids: ids } : {};
  const kind = messageOrigin({ from_agent: first.from_agent, payload: first.payload });
  if (senders.size !== 1) return { kind, from: WAKE_SENDER, ...receipt };
  return {
    kind,
    from: [...senders][0]!,
    mission_id: missions.size === 1 ? [...missions][0]! : null,
    ...receipt,
  };
}

function returnAgent(payload: string): string | null {
  if (!payload.startsWith('{')) return null;
  try {
    const p: unknown = JSON.parse(payload);
    if (!p || typeof p !== 'object') return null;
    const agent = (p as Record<string, unknown>).agent;
    return typeof agent === 'string' && agent ? agent : null;
  } catch {
    return null;
  }
}
