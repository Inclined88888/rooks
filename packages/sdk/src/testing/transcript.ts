/**
 * Recorded sessions: a CLI's stdout for one turn, replayed through the engine
 * the daemon uses. A replay is the cheapest honest test of a provider — no CLI,
 * no account, no network — and the only one that catches the bugs that live in
 * how bytes arrive (a line cut in two chunks, a multi-byte character split
 * across them, CRLF from a Windows CLI).
 */

import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Backend, BuildSpawnOpts, NormalizedEvent, SessionDriver } from '../provider.js';
import { providerRuntime } from './runtime.js';

const { fromLegacy, openProcessSession } = providerRuntime.engine;

/** The lines of a transcript given as JSONL text or as lines; blanks dropped. */
export function transcriptLines(source: string | readonly string[]): string[] {
  const raw = typeof source === 'string' ? source.split(/\r?\n/) : [...source];
  return raw.filter((line) => line.trim().length > 0);
}

/** A transcript file (`.jsonl`) read from disk. */
export function loadTranscript(path: string): string[] {
  return transcriptLines(readFileSync(path, 'utf8'));
}

/** How the bytes reach the reader. Each is a different way for a codec to break. */
export const CHUNKINGS = ['lines', 'whole', 'bytes', 'crlf'] as const;
export type Chunking = (typeof CHUNKINGS)[number];

export type ReplayResult = {
  /** What the engine emitted, in order. */
  readonly events: NormalizedEvent[];
  /** The session id the engine learned from the stream ('' when none). */
  readonly sessionId: string;
  readonly driver: SessionDriver;
};

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function payloadOf(lines: readonly string[], chunking: Chunking): Array<string | Buffer> {
  switch (chunking) {
    case 'whole': return [lines.map((l) => `${l}\n`).join('')];
    case 'crlf': return lines.map((l) => `${l}\r\n`);
    case 'bytes': return [...Buffer.from(lines.map((l) => `${l}\n`).join(''), 'utf8')].map((b) => Buffer.from([b]));
    case 'lines': return lines.map((l) => `${l}\n`);
  }
}

/**
 * Feeds `lines` to the engine as the daemon would for this provider (a lines
 * session over pipes) and returns what it emitted. Only for a line-oriented
 * provider: one that speaks a session protocol has no lines to replay.
 */
export async function replayTranscript(
  provider: Backend,
  lines: readonly string[],
  spawn: BuildSpawnOpts,
  chunking: Chunking = 'lines',
): Promise<ReplayResult> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = { stdin } as unknown as ChildProcessWithoutNullStreams;
  const events: NormalizedEvent[] = [];
  const driver = openProcessSession(fromLegacy(provider, { proc }), {
    io: { stdin, stdout },
    spawn,
    host: {
      emit: (ev) => { events.push(ev); },
      requestPermission: async () => ({ allow: false }),
    },
    initialStdin: null,
  });
  for (const chunk of payloadOf(lines, chunking)) stdout.write(chunk);
  await settle();
  return { events, sessionId: driver.info?.sessionId ?? '', driver };
}
