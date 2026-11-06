import { Worker } from 'node:worker_threads';

/** What `verifyRelease` returns once the signed inventory matches the files. */
export type ReleaseManifest = { version: number; files: Record<string, string> };

/**
 * Below this, the check ends before a window could even paint: showing one
 * would only flash. A managed Windows PC takes 36 to 54 s (TODO #439).
 */
export const CHECK_WINDOW_DELAY_MS = 1000;

const WORKER_URL = new URL('../scripts/release-integrity-worker.mjs', import.meta.url);

/**
 * `verifyRelease` in a worker thread: the same function, the same files, the
 * same verdict, but the main thread stays free to paint a window. A failure
 * keeps the message `verifyRelease` threw, so the startup dialog is unchanged.
 */
export function verifyReleaseInWorker(root: string, publicKey: string, script: URL = WORKER_URL): Promise<ReleaseManifest> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(script, { workerData: { root, publicKey } });
    worker.once('message', (manifest: ReleaseManifest) => { settled = true; resolve(manifest); });
    worker.once('error', (error) => { settled = true; reject(error); });
    // An exit with neither verdict (killed, out of memory) must not pass for a verified release.
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`The release check stopped before its verdict (exit code ${code}).`));
    });
  });
}

export type CheckDeps<T> = {
  verify: () => Promise<T>;
  /** Opens the waiting window; returns what closes it. */
  show: () => () => void;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/** Runs the check, with a window only if it outlasts the delay; the window is gone once it settles, either way. */
export async function checkWithWindow<T>(deps: CheckDeps<T>): Promise<T> {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const shown: { close: (() => void) | null } = { close: null };
  const timer = setTimer(() => { shown.close = deps.show(); }, deps.delayMs ?? CHECK_WINDOW_DELAY_MS);
  try {
    return await deps.verify();
  } finally {
    clearTimer(timer);
    shown.close?.();
  }
}
