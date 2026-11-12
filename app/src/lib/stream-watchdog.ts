/**
 * Safety net for the chat's live stream.
 *
 * The thread only leaves "thinking" when a `result` (or `mission_complete`)
 * reaches the EventSource. When that one event is lost — a stream left
 * half-open behind the proxy after a pause, a turn that ends in under a second
 * (an unknown model slug answers in ~800 ms) — the bubble spins forever while
 * the reply sits in the database, visible only after a reload. The daemon
 * already replays the whole mission on every connection, so reopening the
 * stream is enough to catch up; this decides when.
 */

/** Silence on the stream before we ask the daemon whether the turn is over.
 *  Long tool calls are legitimately quiet: the question is cheap
 *  (`view=status`), the reopen only happens on a definite answer. */
export const STREAM_QUIET_MS = 15_000;

export type WatchdogInput = {
  thinking: boolean;
  quietMs: number;
  /** `EventSource.readyState === CLOSED`, or no stream at all. */
  streamClosed: boolean;
  /** Daemon's answer; `undefined` while it has not been asked. */
  turnActive?: boolean;
  /** Daemon's answer: a launch or a summary is on its way with no turn open yet,
   *  so `turnActive: false` does not mean over, and no event was lost. */
  turnPreparing?: boolean;
  /** The stream was already reopened on the daemon's word that the turn is
   *  over, and the daemon says no turn is on its way: no lost event is left to
   *  wait for. A daemon that does not say leaves this false: a message can be
   *  waiting on a spawn with no turn open. */
  caughtUp?: boolean;
  /** Daemon's answer: this mission no longer exists for this viewer (404).
   *  `undefined` while it has not been asked. */
  missionGone?: boolean;
};

export type WatchdogAction = 'idle' | 'probe' | 'reopen' | 'settle' | 'abandon';

export function watchdogAction(input: WatchdogInput): WatchdogAction {
  if (!input.thinking) return 'idle';
  if (input.missionGone) return 'abandon';
  // A dead stream cannot deliver the end of the turn, whatever the daemon says
  // about it. Only whether there is still a mission to reopen it on matters: the
  // browser closes a stream for good on a refusal, and a 404 stays a 404.
  if (input.streamClosed) return input.missionGone === undefined ? 'probe' : 'reopen';
  if (input.quietMs < STREAM_QUIET_MS) return 'idle';
  if (input.turnActive === undefined) return 'probe';
  if (input.turnActive || input.turnPreparing) return 'idle';
  return input.caughtUp ? 'settle' : 'reopen';
}

/** A stream that must be (re)opened before sending: absent, or closed for
 *  good by the browser. A CONNECTING one is left to its own retry. */
export function streamIsClosed(stream: { readyState: number } | null): boolean {
  return !stream || stream.readyState === 2;
}
