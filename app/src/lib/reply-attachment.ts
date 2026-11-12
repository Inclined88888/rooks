/**
 * The `reply` attachment of a user turn (`orchestrator/src/reply-to.ts`): the
 * earlier message of the same conversation the turn answers. The thread draws
 * a quote from it, and hides the header the agent read instead.
 */

export type ReplyAttachment = {
  eventId: number;
  role: 'agent' | 'user';
  excerpt: string;
};

/** The label of the prompt part carrying the agent's `<reply-to>` header. */
export const REPLY_PART_LABEL = 'replyTo';

/** Longest excerpt the thread accepts: the daemon writes 160 characters. */
const EXCERPT_MAX = 400;

/** The reply of a user event's origin, or null — a malformed one is ignored,
 *  never a reason to hide the bubble. */
export function readReplyAttachment(origin: unknown): ReplyAttachment | null {
  if (!origin || typeof origin !== 'object') return null;
  const presentation = (origin as { presentation?: unknown }).presentation;
  if (!presentation || typeof presentation !== 'object') return null;
  const attachments = (presentation as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) return null;
  for (const raw of attachments) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    if (a.type !== 'reply') continue;
    if (!Number.isInteger(a.event_id) || (a.event_id as number) <= 0) return null;
    if (a.role !== 'agent' && a.role !== 'user') return null;
    if (typeof a.excerpt !== 'string' || a.excerpt.length > EXCERPT_MAX) return null;
    return { eventId: a.event_id as number, role: a.role, excerpt: a.excerpt };
  }
  return null;
}
