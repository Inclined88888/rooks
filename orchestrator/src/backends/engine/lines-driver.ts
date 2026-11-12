/**
 * The `SessionDriver` of a line-oriented CLI: it reads the process's stdout
 * line by line through the provider's codec, and turns a prompt into bytes on
 * its stdin. It is what makes claude, codex, grok and copilot sessions like
 * ACP ones from the runner's side: one `start`, one `prompt` per turn, events
 * through `host.emit`.
 *
 * What it deliberately does NOT do — the process is the daemon's, and so is
 * everything that follows from its life:
 *   - it never starts, stops or waits for the process; a `process-per-turn`
 *     provider gets one driver per launch, and the next turn is a new launch
 *     (resume, the retry without resume, the pause on a rate limit and the
 *     sterile-exit breaker all hang off the process's exit);
 *   - `prompt` resolves once the message is WRITTEN, not once the turn ended.
 *     A persistent CLI queues what it receives while it works (a message sent
 *     mid-turn is taken after the current tool call), and the turn's end is
 *     the `result` event the runner already follows. Waiting for it here would
 *     serialize the mission's messages and change that behaviour;
 *   - a stream that ends is not a failure of the session: the exit handler of
 *     the runner classifies it. Nothing here rejects on EOF, because a
 *     rejection reads as a session failure (synthetic `result`, SIGTERM) and
 *     would count the same death twice;
 *   - `close` keeps reading. `exit` precedes the end of stdout, and the last
 *     lines (the `result`) arrive after it.
 */

import { createLineSplitter } from './line-splitter.js';
import { LINE_SESSION_DRIVER } from './driver-brand.js';
import type { LinesCodec } from './definition.js';
import {
  NO_SESSION_CAPABILITIES,
  type ImageAttachment, type NormalizedEvent, type SessionDriver, type SessionHost, type SessionInfo, type SessionStdio, type TurnOutcome,
} from '../types.js';

export type LineSessionOptions = {
  readonly io: SessionStdio;
  readonly host: Pick<SessionHost, 'emit'>;
  readonly codec: LinesCodec;
  readonly transport: 'stdio-persistent' | 'process-per-turn';
  /** What the launch put on stdin ahead of any prompt (`SpawnResult.initialStdin`):
   *  the first message travels in the launch, not through `prompt`. */
  readonly initialStdin: string | null;
  /** Any line the process printed, parsed or dropped: it is still the agent at
   *  work, and the runner's reaper reads that to tell a hung turn from a long one. */
  onActivity?(): void;
  /** A line past the ceiling was dropped whole. */
  onOverflow?(): void;
  /** The provider's codec threw on a line. The line is dropped and the stream
   *  goes on: a provider is third-party code reading a third-party program's
   *  output, and one malformed line must not take the daemon down with it.
   *  Default: a single warning per driver. */
  onCodecError?(error: unknown, line: string): void;
};

export class LineSessionDriver implements SessionDriver {
  readonly [LINE_SESSION_DRIVER] = true;
  private current: SessionInfo = { sessionId: '', capabilities: NO_SESSION_CAPABILITIES, resumed: false };
  private closed = false;
  private launchTurnSpent = false;

  /** Opening IS launching: the reader is attached and the launch's own stdin
   *  payload written before the constructor returns, as the runner always did
   *  right after the spawn. Nothing the process prints in between can be lost,
   *  and a one-shot CLI is never left waiting for an EOF that comes later. */
  constructor(private readonly opts: LineSessionOptions) {
    this.attach();
    const { io, initialStdin, transport } = opts;
    if (initialStdin != null) io.stdin.write(initialStdin);
    // The CLI reads its prompt until EOF: without it a one-shot process waits forever.
    if (transport === 'process-per-turn') io.stdin.end();
  }

  get info(): SessionInfo | null {
    return this.current;
  }

  async start(): Promise<SessionInfo> {
    return this.current;
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<TurnOutcome> {
    if (this.closed) return { stopReason: 'closed' };
    // The first message travelled with the launch (`initialStdin`); the runner
    // still announces it as a prompt, and it must not be sent twice.
    if (!this.launchTurnSpent) {
      this.launchTurnSpent = true;
      return { stopReason: 'launch' };
    }
    const { io, codec, transport } = this.opts;
    if (transport === 'process-per-turn') {
      throw new Error('a process-per-turn provider takes its next turn from a new launch');
    }
    codec.writeUserInput(io, text, images);
    return { stopReason: 'submitted' };
  }

  /** A line-oriented turn is stopped by stopping its process, which the daemon
   *  owns. The runner knows it (`MissionSession.speaksProtocol`) and never asks. */
  async cancel(): Promise<void> {}

  close(): void {
    this.closed = true;
  }

  private attach(): void {
    const { io, codec, host } = this.opts;
    io.stdout.setEncoding('utf8');
    io.stdout.on('data', createLineSplitter((line) => {
      // Before parsing: a line the codec drops is still the agent at work.
      this.opts.onActivity?.();
      let events: NormalizedEvent[];
      try {
        events = codec.parseLine(line);
      } catch (error) {
        this.codecFailed(error, line);
        return;
      }
      for (const ev of events) {
        this.learnSession(ev, line);
        host.emit(ev);
      }
    }, this.opts.onOverflow ? { onOverflow: this.opts.onOverflow } : {}));
  }

  private warned = false;

  private codecFailed(error: unknown, line: string): void {
    if (this.opts.onCodecError) { this.opts.onCodecError(error, line); return; }
    if (this.warned) return;
    this.warned = true;
    // The message only: a line may carry what must not reach a log.
    console.warn(`[engine] the provider's codec threw on a line and it was dropped: ${error instanceof Error ? error.message : String(error)}`);
  }

  private learnSession(ev: Parameters<LinesCodec['extractSessionId']>[0], line: string): void {
    try {
      const sessionId = this.opts.codec.extractSessionId(ev);
      if (sessionId) this.current = { ...this.current, sessionId };
    } catch (error) {
      this.codecFailed(error, line);
    }
  }
}

export { LINE_SESSION_DRIVER, isLineSessionDriver } from './driver-brand.js';
