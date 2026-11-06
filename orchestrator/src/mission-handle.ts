/**
 * What the runner holds for a live mission, whatever serves it.
 *
 * The runner used to hold a `ChildProcess` and nothing else: the reaper probed
 * its pid, every stop was a `proc.kill`, and the end of a mission was the
 * process's `exit`. A backend reached over the network has no process to kill
 * or to watch, yet its mission must stop, end and be reaped exactly like the
 * others. Everything the runner does to the thing behind a mission therefore
 * goes through this handle; a child process is one implementation of it.
 *
 * The process's pipes are not part of it: they belong to the dialect that
 * speaks over them (stream parser, `writeUserInput`, a session driver's stdio).
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export type MissionHandle = {
  /** OS pid, for logs and the liveness probe. Absent when nothing runs here. */
  readonly pid: number | undefined;
  /** Ask it to stop (`SIGTERM`), or insist (`SIGKILL`). The end is announced
   *  through `onExit`, always on a later tick, never by this call. */
  kill(signal: NodeJS.Signals): void;
  /** True once its end was observed. */
  ended(): boolean;
  /** True when it is gone, whether its end was observed or not (a process that
   *  vanished without Node noticing). What the reaper uses to spot a registry
   *  entry that outlived what it held. */
  gone(): boolean;
  /** Its end, once, with an exit code (null when it was killed by a signal). */
  onExit(listener: (code: number | null) => void): void;
  /** A later listener for the same end, for a caller that waits on it. */
  onceExit(listener: () => void): void;
  /** It could not even start (missing binary, EACCES…). */
  onError(listener: (err: Error) => void): void;
  /** What it says about itself on the side: a CLI's stderr. */
  onStderr(listener: (text: string) => void): void;
};

/** Does the process still exist? `kill(pid, 0)` signals nothing, it just
 *  tests. Without a pid (aborted spawn), we answer no: nothing to wait
 *  for from this entry. */
function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The handle of a spawned backend CLI. */
export function processHandle(proc: ChildProcessWithoutNullStreams): MissionHandle {
  const ended = (): boolean => proc.exitCode !== null || proc.signalCode !== null;
  return {
    get pid() { return proc.pid; },
    kill: (signal) => { proc.kill(signal); },
    ended,
    // Non-null `exitCode`/`signalCode` = Node saw the child die; the
    // `kill(pid, 0)` probe covers the inverse (process gone without Node
    // noticing). An unreaped zombie would answer "alive" to the second
    // test, hence both.
    gone: () => ended() || !isProcessAlive(proc.pid),
    onExit: (listener) => { proc.on('exit', listener); },
    onceExit: (listener) => { proc.once('exit', () => listener()); },
    onError: (listener) => { proc.on('error', listener); },
    onStderr: (listener) => { proc.stderr.on('data', (chunk) => listener(chunk.toString())); },
  };
}

/** The handle of a session with no process behind it (`RemoteDialect`). */
export type RemoteMissionHandle = MissionHandle & {
  /** The session ended on its own: its end, read as the matching exit code
   *  (0 = a clean end, null = a deliberate stop). Once; ignored after a stop. */
  settle(code: number | null): void;
  /** Its end is already on its way (a stop was asked, or it settled): what the
   *  session says from now on comes too late to change anything. */
  closing(): boolean;
};

export function remoteHandle(): RemoteMissionHandle {
  let exited = false;
  let ending = false;
  const exitListeners: Array<(code: number | null) => void> = [];
  const onceListeners: Array<() => void> = [];
  const end = (code: number | null): void => {
    if (ending) return;
    ending = true;
    // A process's exit always arrives on a later tick, and the callers rely on
    // it: they set the intent, ask for the stop, then dispose or forget the
    // entry before the exit handler runs.
    setImmediate(() => {
      exited = true;
      for (const listener of exitListeners) listener(code);
      for (const listener of onceListeners.splice(0)) listener();
    });
  };
  return {
    pid: undefined,
    // Killed by a signal, as the runner reads it: no exit code.
    kill: () => end(null),
    ended: () => exited,
    gone: () => exited,
    onExit: (listener) => { exitListeners.push(listener); },
    onceExit: (listener) => { onceListeners.push(listener); },
    // Nothing is launched, so nothing can fail to launch; nothing writes aside.
    onError: () => undefined,
    onStderr: () => undefined,
    settle: end,
    closing: () => ending,
  };
}
