/**
 * "Chain evaluated" barrier: an explicit signal, instead of a bet on
 * git's latency.
 *
 * ## The bet it replaces
 *
 * The wake-loop enqueues a task's return as soon as `task_done` (synchronous) but
 * only evaluates its urgency at the flush, 1 s later (`DEBOUNCE_MS`, wake.ts), through
 * `hasFollowUpTask`. Everything therefore rested on a delay assumption: "the
 * follow-up chain will have created its task by then". Yet the chain starts with
 * `handleCodeDone` → `diffSummary`, a `git diff --stat` in a subprocess with
 * a 5 s timeout. Cold worktree, loaded disk, big diff: beyond one
 * second, `hasFollowUpTask` answers `false`, the return is classified urgent and the
 * pilot is woken for a chain that was chaining along perfectly well on its own —
 * exactly the burst of wakes that `8c21292` had just removed.
 *
 * It was not a closed race but a bet: it fails intermittently,
 * so at the worst moment and without leaving a usable trace. Shortening the
 * `git diff` or lengthening the debounce would only have moved the bet.
 *
 * ## What the barrier does
 *
 * `openChainBarrier` is called SYNCHRONOUSLY by the `task_done` listener,
 * even before the `setImmediate` that launches the chain: from that instant,
 * any reader wondering about what follows this task knows a chain
 * is on its way and can wait for it. The wake-loop's flush waits
 * (`awaitChainBarriers`) for the barriers of its batch to be lifted before
 * deciding the urgency. No time window left in the equation.
 *
 * ## Why a separate module
 *
 * `task-chain.ts` already imports `wake.ts` (end-of-batch recap). Housing the
 * barrier here avoids an ESM import cycle between the two, and keeps this module
 * testable without a SQLite database or a bus (it imports NOTHING).
 */

/** Open barriers, by task id. One entry = at least one chain on its
 *  way whose follow-up is not known yet. `holders` counts the
 *  openings not lifted yet — see `openChainBarrier`. */
const open = new Map<string, { promise: Promise<void>; resolve: () => void; holders: number }>();

/**
 * Opens this task's barrier and returns the function that lifts IT. To call
 * BEFORE any event tick, otherwise the window we claim to close reopens.
 *
 * Counts the holders rather than sharing a single lift: a task can
 * receive a second `task_done` (re-closing after a merge-integrity send-back,
 * reconcile replay) while its first chain is still running. The second
 * call of `runTaskChain` returns right away (`inFlight` lock): with
 * a shared lift, that immediate return would reopen the window by lifting the
 * barrier of a chain still in flight. The barrier therefore only falls with the
 * last holder. Each lift is idempotent.
 */
export function openChainBarrier(taskId: string): () => void {
  let entry = open.get(taskId);
  if (!entry) {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => { resolve = r; });
    entry = { promise, resolve, holders: 0 };
    open.set(taskId, entry);
  }
  entry.holders += 1;
  const mine = entry;
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    mine.holders -= 1;
    if (mine.holders > 0) return;
    // Only delete ITS own entry: a barrier reopened in the meantime
    // for the same task belongs to another chain.
    if (open.get(taskId) === mine) open.delete(taskId);
    mine.resolve();
  };
}

/** True if a chain is on its way for this task. Exported for the tests and
 *  introspection; normal callers go through `awaitChainBarriers`. */
export function hasOpenChainBarrier(taskId: string): boolean {
  return open.has(taskId);
}

/**
 * Waits for the chains of these tasks to be evaluated. Ids without an open
 * barrier (chain already finished, or never launched) wait for nothing.
 *
 * Capped: the barrier must NEVER be able to freeze the wake-loop. Going
 * over simply falls back on the old behaviour (deciding with the
 * current state of the database) — degraded, never blocking.
 *
 * @returns true if everything was lifted in time, false if the cap kicked in.
 */
export async function awaitChainBarriers(taskIds: readonly string[], maxWaitMs: number): Promise<boolean> {
  const waits = [...new Set(taskIds)]
    .map((id) => open.get(id)?.promise)
    .filter((p): p is Promise<void> => p !== undefined);
  if (waits.length === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((r) => {
    timer = setTimeout(() => r('timeout'), maxWaitMs);
    timer.unref();
  });
  try {
    return (await Promise.race([Promise.all(waits).then(() => 'ok' as const), timeout])) === 'ok';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
