/**
 * Server-sent events, as a Hermes gateway writes them on
 * `GET /v1/runs/{id}/events`: `id:` (from 0.21.6 on) and `data:` lines, a
 * blank line between frames, and `: keepalive` comments. No `event:` line —
 * the type lives in `data.event`.
 */

export type SseFrame =
  /** A comment line (`: open`, `: keepalive`, `: stream closed`). */
  | { readonly kind: 'comment'; readonly text: string }
  /** A dispatched frame. `id` is null when the frame carried no `id:` line. */
  | { readonly kind: 'data'; readonly id: string | null; readonly data: string };

/** Splits the bytes of a stream into frames, in order. Never throws on a
 *  malformed line: an unknown field is ignored, as the SSE spec says. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let pending = '';
  let id: string | null = null;
  let data: string[] = [];
  let sawField = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = pending.search(/\r\n|\r|\n/);
      // A `\r` closing the chunk may be the first half of a `\r\n`.
      while (newline !== -1 && (done || newline < pending.length - 1 || pending[newline] !== '\r')) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + (pending.startsWith('\r\n', newline) ? 2 : 1));
        if (line === '') {
          if (sawField && data.length > 0) yield { kind: 'data', id, data: data.join('\n') };
          id = null;
          data = [];
          sawField = false;
        } else if (line.startsWith(':')) {
          yield { kind: 'comment', text: line.slice(1).trim() };
        } else {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'data') { data.push(value); sawField = true; }
          else if (field === 'id') { id = value; sawField = true; }
        }
        newline = pending.search(/\r\n|\r|\n/);
      }
      // A frame the stream cut before its blank line is dropped, as the SSE
      // spec says: the run status or a replay brings it back.
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
