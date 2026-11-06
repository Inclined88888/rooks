/**
 * A chat message that answers an earlier one of the same conversation.
 *
 * The composer sends `reply_to: { event_id }` — the `events` row the earlier
 * bubble was drawn from. The daemon resolves it inside the mission (never
 * across missions), then:
 *   - heads the agent's prompt with a short `<reply-to>` block: an excerpt, so
 *     the model finds the passage in its own context, and the event id, so it
 *     can read the whole text again (`GET …/messages/:eventId`, tool
 *     `mission_message_get`) once a compaction or a backend switch took it out;
 *   - stores a `reply` attachment on the user event: the thread draws a quote
 *     from it, never from the block the agent read.
 */
import { z } from 'zod';
import { dbApi } from './db.js';
import type { PromptPart, ReplyAttachment } from './prompt-presentation.js';

/** What the composer sends. */
export const ReplyToSchema = z.object({
  event_id: z.number().int().positive(),
}).strict();

/** Characters of the earlier message the agent reads in the header. Enough to
 *  find the passage, never the message itself. */
export const REPLY_EXCERPT_CHARS = 160;

/** Event types a reply may point at: the bubbles of the two speakers. */
const REPLYABLE = ['assistant', 'user'] as const;

/** The `label` of the prompt part carrying the header: the thread hides that
 *  part and draws the attachment instead. */
export const REPLY_PART_LABEL = 'replyTo';

const HEADER = /^\s*<reply-to\b[^>]*>[\s\S]*?<\/reply-to>\s*/;

type Block = { type?: unknown; text?: unknown };

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n\n');
}

/**
 * The text a bubble shows for a stored event: the agent's text blocks, or what
 * the human wrote. A user turn with a presentation keeps its `text` parts only:
 * the instructions around them (a skill, a reply header) are not their words.
 */
export function messageTextOf(type: string, payloadJson: string): string {
  let payload: { message?: { content?: unknown }; origin?: { presentation?: { parts?: unknown } } };
  try {
    payload = JSON.parse(payloadJson) as typeof payload;
  } catch {
    return '';
  }
  if (type === 'user') {
    const parts = payload.origin?.presentation?.parts;
    if (Array.isArray(parts)) {
      const shown = (parts as Array<{ kind?: unknown; text?: unknown }>)
        .filter((part) => part?.kind === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('');
      if (shown.trim()) return shown.trim();
    }
  }
  return textOfContent(payload.message?.content).replace(HEADER, '').trim();
}

/** The first `max` characters on one line, cut at a word when one is near. */
export function excerptOf(text: string, max = REPLY_EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export type ReplyTarget = {
  event_id: number;
  role: 'agent' | 'user';
  timestamp: number;
  text: string;
};

/**
 * The message `eventId` of `missionId`, or null when that mission has no such
 * bubble (another mission's row, a tool result, a notice). Archived rows count.
 */
export function findReplyTarget(missionId: string, eventId: number): ReplyTarget | null {
  const rows = dbApi.scanMissionEvents(missionId, {
    where: `id = ? AND type IN (${REPLYABLE.map(() => '?').join(', ')})`,
    params: [eventId, ...REPLYABLE],
    order: 'ASC',
    limit: 1,
  }) as Array<{ id: number; type: string; timestamp: number; payload: string }>;
  const row = rows[0];
  if (!row) return null;
  const text = messageTextOf(row.type, row.payload);
  if (!text) return null;
  return { event_id: row.id, role: row.type === 'assistant' ? 'agent' : 'user', timestamp: row.timestamp, text };
}

/** The attachment the thread draws as a quote. */
export function replyAttachment(target: ReplyTarget): ReplyAttachment {
  return { type: 'reply', event_id: target.event_id, role: target.role, excerpt: excerptOf(target.text) };
}

/** The header the agent reads before the human's message. */
export function replyPart(target: ReplyTarget): PromptPart {
  const who = target.role === 'agent' ? 'your earlier message' : 'their own earlier message';
  return {
    kind: 'instruction',
    label: REPLY_PART_LABEL,
    text: `<reply-to event="${target.event_id}">\n${excerptOf(target.text)}\n</reply-to>\n`
      + `The user is replying to ${who} in this conversation, which starts as quoted above (event ${target.event_id}). `
      + `If it is no longer in your context, read it whole with the mission_message_get tool.\n\n`,
  };
}

export type ReplyResolution =
  | { ok: true; target: ReplyTarget | null }
  // 422, never 404: to the composer a 404 on a send means the mission is gone,
  // and it falls back to a fresh spawn.
  | { ok: false; status: 400 | 422; code: string; error: string };

/** Validates and resolves the `reply_to` of a request body. Absent = no reply. */
export function resolveReplyTo(missionId: string, raw: unknown): ReplyResolution {
  if (raw === undefined || raw === null) return { ok: true, target: null };
  const parsed = ReplyToSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, status: 400, code: 'invalid_reply_to', error: 'reply_to must be { event_id: positive integer }' };
  }
  const target = findReplyTarget(missionId, parsed.data.event_id);
  if (!target) {
    return { ok: false, status: 422, code: 'reply_target_not_found', error: 'the message replied to is not part of this conversation' };
  }
  return { ok: true, target };
}
