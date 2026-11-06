/**
 * The stream-json wire format (Anthropic's), shared by every CLI that speaks it:
 * the line that carries a user turn to stdin, and the partial text of a streamed
 * answer. A leaf of the backends module, moved verbatim out of the former Claude dialect.
 */

import { ASSISTANT_DELTA, type AssistantDeltaPayload, type ImageAttachment, type NormalizedEvent } from '../types.js';

/**
 * Wrap a user turn for claude's stream-json stdin. With no images the
 * content is a plain string (matches the old behaviour exactly); with
 * images it switches to the content-blocks array form that the
 * Anthropic Messages API expects — claude code accepts the same shape
 * over stream-json so multimodal turns work as user→agent.
 */
export function streamJsonUser(text: string, images?: ImageAttachment[]): string {
  let content: unknown = text;
  if (images && images.length) {
    const blocks: unknown[] = [];
    if (text) blocks.push({ type: 'text', text });
    for (const img of images) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data },
      });
    }
    content = blocks;
  }
  return (
    JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
  );
}

/**
 * Extracts the text of a `stream_event` line, or nothing.
 *
 * Shape checked against CLI 2.1.228:
 *   {"type":"stream_event","event":{"type":"content_block_delta","index":0,
 *    "delta":{"type":"text_delta","text":"…"}}}
 * The fragments are INCREMENTAL ("B" then "onjour ! …") → append mode.
 *
 * Reused by the grok dialect, whose CLI emits the SAME Anthropic wire format
 * on `--output-format streaming-messages-json`.
 *
 * v1 deliberately limited to the text of the answer: `thinking_delta` (we do not
 * stream the reasoning) and `input_json_delta` (arguments of a tool_use
 * being built, unreadable half-written) are ignored.
 */
export function partialTextDelta(obj: Record<string, unknown>): NormalizedEvent[] {
  const event = obj.event;
  if (event === null || typeof event !== 'object') return [];
  const e = event as { type?: unknown; delta?: unknown };
  if (e.type !== 'content_block_delta') return [];
  if (e.delta === null || typeof e.delta !== 'object') return [];
  const delta = e.delta as { type?: unknown; text?: unknown };
  if (delta.type !== 'text_delta' || typeof delta.text !== 'string') return [];
  if (delta.text.length === 0) return [];
  const payload: AssistantDeltaPayload = { text: delta.text, mode: 'append' };
  return [{ type: ASSISTANT_DELTA, payload }];
}
